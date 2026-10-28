"""Validação, planos e transações dos importadores locais. Sem rede externa."""
from __future__ import annotations
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata
from dataclasses import dataclass, field


class ReviewError(Exception):
    pass


def norm(value):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFD', str(value or ''))
                           if not unicodedata.combining(c)).upper().split())


def digits(value):
    return re.sub(r'\D', '', str(value or ''))


def date(value):
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    for fmt in ('%d/%m/%Y', '%Y-%m-%d', '%Y%m%d'):
        try:
            return dt.datetime.strptime(str(value), fmt).date()
        except ValueError:
            pass
    raise ReviewError('Data inválida; use DD/MM/AAAA.')


def age(born, attended):
    b, a = date(born), date(attended)
    if b > a:
        raise ReviewError('Nascimento posterior ao atendimento.')
    return a.year - b.year - ((a.month, a.day) < (b.month, b.day))


def sex(value, gil=False):
    v = norm(value)
    if v not in ('M', 'F', '1', '2'):
        raise ReviewError('Sexo ausente ou inválido.')
    return ('1' if v in ('M', '1') else '2') if gil else ('M' if v in ('M', '1') else 'F')


def cpf_valid(v):
    v = digits(v)
    if len(v) != 11 or len(set(v)) == 1:
        return False
    for n in (9, 10):
        k = (sum(int(v[i]) * (n + 1 - i) for i in range(n)) * 10) % 11
        if int(v[n]) != (0 if k == 10 else k):
            return False
    return True


def cns_valid(v):
    v = digits(v)
    return len(v) == 15 and v[0] in '12789' and len(set(v)) > 1 and sum(int(c)*(15-i) for i,c in enumerate(v)) % 11 == 0


def text(value, size, label):
    value = ' '.join(str(value or '').split())
    if len(value) > size:
        raise ReviewError(f'{label}: máximo de {size} caracteres. Ajuste o campo antes de planejar.')
    try:
        value.encode('cp1252')
    except UnicodeEncodeError:
        raise ReviewError(f'{label}: contém caractere incompatível com o banco.')
    return value


def load_payload(path, mode):
    p = Path(path)
    if p.stat().st_size > 30 * 1024 * 1024:
        raise ReviewError('Arquivo excede 30 MB.')
    obj = json.loads(p.read_text(encoding='utf-8-sig'))
    if not isinstance(obj, dict) or not isinstance(obj.get('records'), list) or not obj['records']:
        raise ReviewError('O JSON precisa conter uma lista records não vazia.')
    if mode == 'bpa' and obj.get('exportType') != 'PEC_BPA_FILA_PARA_PREENCHIMENTO':
        raise ReviewError('Use o arquivo “Exportar fila para o BPA” da extensão.')
    if mode == 'gil' and (obj.get('destination') != 'GIL_RAUL' or obj.get('schemaVersion') != 1):
        raise ReviewError('Use o JSON da extensão PEC para GIL — Raul, versão de formato 1.')
    return obj


def checksum(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


@dataclass
class Statement:
    sql: str
    params: tuple = ()


@dataclass
class Plan:
    mode: str
    rows: list = field(default_factory=list)
    writes: list[Statement] = field(default_factory=list)
    checks: list[Statement] = field(default_factory=list)
    context: dict = field(default_factory=dict)

    @property
    def errors(self):
        return [r for r in self.rows if r['status'] == 'PENDENTE']

    @property
    def new_count(self):
        return sum(r['status'] == 'NOVO' for r in self.rows)

    @property
    def digest(self):
        return checksum({'mode': self.mode, 'rows': self.rows, 'context': self.context,
                         'writes': [(s.sql, s.params) for s in self.writes]})

    def add(self, r, status, detail, location=''):
        self.rows.append({'name': str(r.get('patientName', '')), 'date': str(r.get('attendanceDate', '')),
                          'professional': str(r.get('professional', '')), 'status': status,
                          'detail': detail, 'location': location})


def insert(table, values):
    return Statement(f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))


def exact_check(table, values):
    clauses, params = [], []
    for key, value in values.items():
        clauses.append(key+' IS NULL' if value is None else key+'=?')
        if value is not None: params.append(value)
    return Statement('SELECT COUNT(*) AS N FROM '+table+' WHERE '+' AND '.join(clauses), tuple(params))


class Database:
    def __init__(self, config, password, write=False, tables=()):
        import fdb
        lib = config.get('client') or os.environ.get('FBCLIENT')
        if lib:
            fdb.load_api(str(Path(lib).resolve()))
        self.con = fdb.connect(dsn=config['dsn'], user=config['user'], password=password, charset='WIN1252')
        tpb = fdb.TPB()
        tpb.access_mode = fdb.isc_tpb_write if write else fdb.isc_tpb_read
        tpb.isolation_level = fdb.isc_tpb_concurrency
        tpb.lock_resolution = fdb.isc_tpb_nowait
        for table in sorted(tables):
            tpb.table_reservation[table] = (fdb.isc_tpb_protected, fdb.isc_tpb_lock_write)
        self.con.begin(tpb=tpb.render())

    def query(self, sql, params=()):
        cur = self.con.cursor()
        try:
            cur.execute(sql, params)
            names = [c[0].strip().upper() for c in cur.description]
            return [{n: (v.rstrip() if isinstance(v, str) else v) for n,v in zip(names,row)} for row in cur.fetchall()]
        finally:
            cur.close()

    def execute(self, statement):
        cur = self.con.cursor()
        try:
            cur.execute(statement.sql, statement.params)
            if cur.rowcount != 1:
                raise ReviewError('A operação não afetou exatamente uma linha. Transação cancelada.')
        finally:
            cur.close()

    def close(self):
        self.con.rollback()
        self.con.close()

    def __enter__(self): return self
    def __exit__(self, *args): self.close()


def verify(db, plan):
    for check in plan.checks:
        rows = db.query(check.sql, check.params)
        if len(rows) != 1 or rows[0]['N'] != 1:
            raise ReviewError('Conferência do lote falhou. Nenhuma gravação será confirmada.')


def backup(config, password, folder):
    """GBAK lógico; o arquivo de saída é local, inclusive para banco remoto."""
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / ('antes_importacao_' + dt.datetime.now().strftime('%Y%m%d_%H%M%S_%f') + '.fbk')
    env = dict(os.environ, ISC_USER=config['user'], ISC_PASSWORD=password)
    exe = Path(config['gbak'])
    if not exe.is_file():
        raise ReviewError('Configure o gbak.exe da versão do servidor antes de gravar.')
    result = subprocess.run([str(exe), '-b', '-g', config['dsn'], str(target)], env=env,
                            capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=900)
    if result.returncode or not target.is_file() or not target.stat().st_size:
        raise ReviewError('Backup falhou. Nenhum registro foi gravado. Confira caminho, espaço e permissões.')
    return target


def transact(mode, payload, options, config, password, reviewed, commit=False, backup_fn=backup):
    from bpa import plan as bpa_plan
    from gil import plan as gil_plan
    planner = bpa_plan if mode == 'bpa' else gil_plan
    if reviewed.errors or not reviewed.new_count:
        raise ReviewError('Não há lote válido com registros novos para executar.')
    # Cópias impedem que alterações da interface mudem o lote em andamento.
    payload, options = copy.deepcopy(payload), copy.deepcopy(options)
    backup_path = backup_fn(config, password, config['backup_dir']) if commit else None
    tables = ('S_PRD',) if mode == 'bpa' else ('CONSNSUP', 'LOTENSUP', 'CTRLNSUP')
    with Database(config, password, write=True, tables=tables) as db:
        fresh = planner(db, payload, options)
        if fresh.digest != reviewed.digest:
            raise ReviewError('O banco, os dados ou as configurações mudaram. Gere e simule uma nova prévia.')
        for statement in fresh.writes:
            db.execute(statement)
        verify(db, fresh)
        if commit:
            db.con.commit()
        # Ao sair sem commit, close sempre executa rollback.
    result = {'mode': mode, 'committed': commit, 'new': fresh.new_count, 'plan_hash': fresh.digest,
              'when': dt.datetime.now().astimezone().isoformat(), 'backup': str(backup_path or '')}
    if commit:
        try:
            folder = Path(config['backup_dir'])
            receipt = folder / ('recibo_' + dt.datetime.now().strftime('%Y%m%d_%H%M%S_%f') + '.json')
            result['verified'] = False
            receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            with Database(config, password) as db:
                verify(db, fresh)
            result['verified'] = True
            receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        except Exception as exc:
            raise ReviewError('A GRAVAÇÃO JÁ FOI CONFIRMADA, mas a conferência final ou o recibo falhou. '
                              'Não repita a gravação. Use Conferir no banco e preserve o JSON. Backup: '+str(backup_path)) from exc
    return result
