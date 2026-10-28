"""PEC para GIL — Raul. Não cria nem modifica cadastros permanentes."""
from collections import defaultdict
import datetime as dt
from common import Plan, Statement, ReviewError, age, cpf_valid, cns_valid, date, digits, exact_check, insert, norm, sex, text

PROCEDURE, CID, NATURE = '0301010072', 'Z000', '3'


def resolve_patient(db, r, unit, allow_coringa):
    cpf, cns = digits(r.get('cpf')), digits(r.get('cns'))
    if cpf and not cpf_valid(cpf): raise ReviewError('CPF inválido; confira no PEC.')
    if cns and not cns_valid(cns): cns = ''
    select = ('SELECT U.*,V.NR_REG_USU,V.CODUNASS FROM USUARIO U LEFT JOIN VL_EASUSU V '
              'ON V.COD_SEQ_USU=U.COD_SEQ_USU AND V.CODUNASS=? WHERE ')
    found = []
    if cpf:
        found = db.query(select+'U.CPF=?', (unit,cpf))
    if not found and cns:
        found = db.query(select+'U.CARTAO_SUS=?', (unit,cns))
    if not found:
        candidates = db.query(select+'U.DT_NASC>=? AND U.DT_NASC<?',
                              (unit,date(r['birthDate']),date(r['birthDate'])+dt.timedelta(days=1)))
        found = [u for u in candidates if norm(u.get('NM_ATU'))==norm(r['patientName'])]
    if len(found)>1:
        raise ReviewError('Mais de um cadastro compatível no GIL; precisa de conferência manual.')
    if found:
        u = found[0]
        if date(u.get('DT_NASC')) != date(r['birthDate']) or sex(u.get('SEXO'),True) != sex(r['sex'],True):
            raise ReviewError('Documento encontrado, mas nascimento/sexo divergem no GIL.')
        if cpf and u.get('CPF') and u['CPF'] != cpf:
            raise ReviewError('Cadastro por nome/CNS possui outro CPF no GIL.')
        if norm(u.get('NM_ATU')) != norm(r['patientName']):
            raise ReviewError('Documento encontrado com nome divergente; confirme a identificação.')
        if not u.get('CODUNASS') or not u.get('NR_REG_USU') or u['NR_REG_USU']=='9':
            raise ReviewError('Cadastro encontrado sem prontuário válido nesta unidade.')
        return u
    if not allow_coringa:
        raise ReviewError('Sem cadastro no GIL. Confira e autorize prontuário 9, se aplicável.')
    return {'NR_REG_USU':'9', 'COD_SEQ_USU':None, 'NM_ATU':r['patientName'],
            'DT_NASC':date(r['birthDate']), 'SEXO':sex(r['sex'])}


def plan(db, payload, opts):
    p = Plan('gil')
    unit, matricula = str(opts.get('unit','')), str(opts.get('matricula',''))
    if unit != str(payload.get('unit')) or matricula != str(payload.get('matricula')):
        raise ReviewError('Unidade e matrícula devem corresponder ao arquivo da extensão.')
    pro = db.query('SELECT V.COD_SEQ_PROF,P.NOME FROM VL_EASPROF V JOIN PROFISS P '
                   'ON P.COD_SEQ_PROF=V.COD_SEQ_PROF WHERE V.CODUNASS=? AND V.MATRICULA=? AND V.DATA_DESAT IS NULL', (unit,matricula))
    if len(pro)!=1 or norm(pro[0]['NOME']) not in ('RAUL KASTRUP','RAUL PIMENTEL KASTRUP'):
        raise ReviewError('A matrícula não identifica um vínculo ativo e único do Raul no GIL.')
    if not db.query('SELECT CODCID FROM CID WHERE CODCID=?',(CID,)) or not db.query('SELECT CODPROC FROM PROCEDIM WHERE CODPROC=?',(PROCEDURE,)):
        raise ReviewError('CID Z000 ou procedimento 0301010072 ausente no GIL.')
    if not db.query('SELECT CODIGO FROM TURNO WHERE CODIGO=?',('4',)):
        raise ReviewError('Turno 4 não encontrado no GIL.')
    control = db.query('SELECT ULT_LOTE FROM CTRLNSUP')
    if len(control)!=1: raise ReviewError('O controle CTRLNSUP precisa ter exatamente uma linha.')
    maxlot = db.query('SELECT MAX(CAST(NR_LOTE AS INTEGER)) AS N FROM LOTENSUP')[0]['N'] or 0
    counter = max(int(control[0]['ULT_LOTE'] or 0),int(maxlot))
    p.context = {'input':payload, 'options':opts, 'professional':pro, 'control':control, 'maxlot':maxlot}
    byday = defaultdict(list)
    seen = set()
    for r in payload['records']:
        try:
            if norm(r.get('professional')) not in ('RAUL KASTRUP','RAUL PIMENTEL KASTRUP'):
                raise ReviewError('Este importador é exclusivo do Raul.')
            if r.get('selected') is not True or r.get('gilExcluded'):
                raise ReviewError('O registro não foi confirmado como selecionado na extensão.')
            if str(r.get('procedure'))!=PROCEDURE or norm(r.get('cid'))!=CID or str(r.get('natureza'))!=NATURE:
                raise ReviewError('O fluxo exige 0301010072, Z000 e natureza 3.')
            born, attended = date(r.get('birthDate')),date(r.get('attendanceDate'))
            if age(born,attended)>130: raise ReviewError('Confira a data de nascimento.')
            sex(r.get('sex'),True)
            text(r.get('patientName'),70,'Nome')
            if not norm(r.get('patientName')): raise ReviewError('Nome ausente.')
            u = resolve_patient(db,r,unit,bool(opts.get('allow_coringa')))
            if u['NR_REG_USU']=='9': text(r['patientName'],40,'Nome para prontuário 9')
            key = (u.get('COD_SEQ_USU') or (norm(r['patientName']),born),attended)
            if key in seen: raise ReviewError('Mesmo paciente/data repetidos no arquivo.')
            seen.add(key)
            existing = db.query('SELECT C.NR_LOTE,C.NR_CONS,C.NR_REG_USU,C.COD_SEQ_USU,C.NM_ATU,C.DT_NASC '
                                'FROM CONSNSUP C JOIN LOTENSUP L ON L.CODUNASS=C.CODUNASS AND L.NR_LOTE=C.NR_LOTE '
                                'WHERE L.CODUNASS=? AND L.MATRICULA=? AND L.DT_CONS>=? AND L.DT_CONS<? '
                                'AND (C.PROCED1=? OR C.PROCED2=? OR C.PROCED3=? OR C.PROCED4=? OR C.PROCED5=? OR C.PROCED6=? OR C.PROCED7=?)',
                                (unit,matricula,attended,attended+dt.timedelta(days=1),*((PROCEDURE,)*7)))
            def same(c):
                if u.get('COD_SEQ_USU') and c.get('COD_SEQ_USU')==u['COD_SEQ_USU']: return True
                if c.get('NR_REG_USU')!='9' and c.get('NR_REG_USU')==u['NR_REG_USU']: return True
                return bool(c.get('NM_ATU') and c.get('DT_NASC') and norm(c['NM_ATU'])==norm(r['patientName']) and date(c['DT_NASC'])==born)
            existing = [c for c in existing if same(c)]
            if len(existing)>1: raise ReviewError('Já há atendimentos repetidos no GIL; confira manualmente.')
            if existing:
                c=existing[0]; p.add(r,'EXISTENTE','Já consta no GIL; será preservado.',c['NR_LOTE']+'/'+c['NR_CONS'])
            else:
                byday[attended].append((r,u))
        except (ReviewError,ValueError) as e:
            p.add(r,'PENDENTE',str(e))
    for day, items in sorted(byday.items()):
        lots = db.query("SELECT * FROM LOTENSUP WHERE CODUNASS=? AND MATRICULA=? AND DT_CONS>=? AND DT_CONS<? AND STATUS='0' AND TURNO='4' ORDER BY NR_LOTE",
                        (unit,matricula,day,day+dt.timedelta(days=1)))
        slots=[]
        for lot in lots:
            if str(lot.get('LOCK') or '0') not in ('0',''): continue
            entries = db.query('SELECT NR_CONS FROM CONSNSUP WHERE CODUNASS=? AND NR_LOTE=?',(unit,lot['NR_LOTE']))
            used = {int(c['NR_CONS']) for c in entries}
            if len(used)!=len(entries) or any(i<1 or i>999 for i in used):
                raise ReviewError('Sequências irregulares em lote aberto do GIL.')
            available = [i for i in range(1,1000) if i not in used]
            if available: slots.append((lot,used,available))
        while items:
            if slots:
                lot,used,available=slots.pop(0)
                chunk,items=items[:len(available)],items[len(available):]
                seqs=available[:len(chunk)]
                n=len(used)+len(chunk); last=max(used|set(seqs))
                # Conserva a capacidade existente quando maior que a quantidade lançada.
                p.writes.append(Statement('UPDATE LOTENSUP SET NR_CONS=?,NR_ULT_CON=?,QTD_LANC=? WHERE CODUNASS=? AND NR_LOTE=? AND STATUS=\'0\'',
                                          (max(n,int(lot.get('NR_CONS') or 0)),last,n,unit,lot['NR_LOTE'])))
                lotno=lot['NR_LOTE']
            else:
                chunk,items=items[:999],items[999:]
                counter+=1
                if counter>9999999: raise ReviewError('Limite de número de lotes atingido.')
                lotno=f'{counter:07}'; seqs=list(range(1,len(chunk)+1))
                p.writes.append(insert('LOTENSUP',dict(CODUNASS=unit,NR_LOTE=lotno,COD_SEQ_PROF=pro[0]['COD_SEQ_PROF'],
                    MATRICULA=matricula,DT_CONS=day,NR_CONS=len(chunk),TURNO='4',HORAS_TRAB='12:00',STATUS='0',
                    NR_ULT_CON=len(chunk),QTD_LANC=len(chunk),VERI_USU='1',LOCK='0',STATUSOLD=None,
                    COD_ESPEC=str(opts.get('specialty','225170')),COD_AREA='',COMPET_FAT=None)))
            for (r,u), seq in zip(chunk,seqs):
                v=dict(CODUNASS=unit,NR_LOTE=lotno,NR_CONS=f'{seq:03}',NR_REG_USU=u['NR_REG_USU'],
                       COD_GRP_AT='00',TEMP=0,PESO=0,ALTURA=0,SEXO=sex(r['sex'],True),TIPO_ATEND=NATURE,
                       GR_ATEND='00',TIPO_HA='0',TIPO_DIAB='0',EST_NUTR='',GRAU_INCAP='0',
                       TIPO_SAI1='0',DIAS_RET1=0,PERI_CEFAL=0,DT_NASC=date(r['birthDate']),
                       HORA=dt.time(12),SISVAN='N',CARATD='00')
                for i in range(1,8): v['CID'+str(i)]=CID if i==1 else ''; v['PROCED'+str(i)]=PROCEDURE if i==1 else ''
                if u.get('COD_SEQ_USU'):
                    v['COD_SEQ_USU']=u['COD_SEQ_USU']
                    for col,limit in [('R_ENDERECO',40),('R_COD_LOGR',4),('R_NUMERO',5),('R_COMPL',10),('R_COD_BAIR',3),
                                      ('R_PT_REF',30),('R_TELEFONE',15),('R_CEP',8),('R_ESTADO',2),('R_CIDADE',7)]:
                        v[col]=str(u.get(col) or '')[:limit]
                else:
                    v['NM_ATU']=text(r['patientName'],40,'Nome')
                p.writes.append(insert('CONSNSUP',v))
                p.checks.append(exact_check('CONSNSUP',v))
                p.add(r,'NOVO','Prontuário '+u['NR_REG_USU']+(' — ficha temporária, sem criar cadastro.' if u['NR_REG_USU']=='9' else ' — cadastro conferido.'),lotno+f'/{seq:03}')
    if p.new_count and counter!=int(control[0]['ULT_LOTE'] or 0):
        p.writes.insert(0,Statement('UPDATE CTRLNSUP SET ULT_LOTE=?',(counter,)))
    return p
