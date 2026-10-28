"""Interface local no navegador: servidor somente em loopback, sem acesso externo."""
import copy
import hashlib
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import webbrowser

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'.runtime'/'python'))
from common import Database,ReviewError,checksum,load_payload,transact
import bpa,gil


class Session:
    def __init__(self,mode):
        self.mode=mode;self.token=secrets.token_urlsafe(32);self.lock=threading.Lock()
        self.payload=None;self.source=None;self.source_hash=None;self.plan=None;self.simulated=None
        self.config=dict(dsn=r'localhost:C:\Trabalho\BPA\BPAMAG.GDB' if mode=='bpa' else '',
            user='SYSDBA' if mode=='bpa' else 'SYSGIL',client=str(ROOT/'.runtime'/'firebird'/'bin'/'fbclient.dll'),
            gbak=r'C:\Program Files (x86)\Firebird\Firebird_1_5\bin\gbak.exe',backup_dir=str(ROOT/'localdata'/'backups'))
        if mode=='gil':
            for base in [os.environ.get('ProgramFiles',''),os.environ.get('ProgramFiles(x86)','')]:
                ini=Path(base)/'datasus'/'gil'/'Gil.ini'
                if ini.is_file():
                    for line in ini.read_text(encoding='cp1252').splitlines():
                        if line.startswith('Diretorio='):self.config['dsn']=line.split('=',1)[1].rstrip('\\')+'\\BDGIL.FDB'
        self.options=dict(competence='',cnes='0012734',unit='001273400',matricula='52573220',specialty='225170',
                          bindings={},allow_coringa=False,strict_text=False)
        saved=ROOT/'localdata'/(mode+'_web_config.json')
        if saved.is_file():
            obj=json.loads(saved.read_text(encoding='utf-8'));self.config.update({k:v for k,v in obj.get('config',{}).items() if k in self.config})
            self.options.update({k:v for k,v in obj.get('options',{}).items() if k in self.options})

    def signature(self):return checksum([self.payload,self.config,self.options,self.plan.digest if self.plan else None])

    def update(self,data):
        config={k:str(v) for k,v in data.get('config',{}).items() if k in self.config}
        opts={k:v for k,v in data.get('options',{}).items() if k in self.options}
        before=checksum([self.config,self.options,self.payload])
        self.config.update(config);self.options.update(opts)
        if data.get('records') is not None:
            if not self.payload:raise ReviewError('Abra um JSON primeiro.')
            self.payload['records']=data['records']
        if before!=checksum([self.config,self.options,self.payload]):self.plan=self.simulated=None
        if not self.config.get('dsn') or not self.config.get('user'):raise ReviewError('Informe o banco e o usuário.')
        folder=ROOT/'localdata';folder.mkdir(exist_ok=True)
        (folder/(self.mode+'_web_config.json')).write_text(json.dumps({'config':self.config,'options':self.options},ensure_ascii=False,indent=2),encoding='utf-8')

    def state(self):
        return dict(mode=self.mode,config=self.config,options=self.options,records=self.payload['records'] if self.payload else [],
            rows=self.plan.rows if self.plan else [],pending=len(self.plan.errors) if self.plan else 0,
            new=self.plan.new_count if self.plan else 0,simulated=bool(self.simulated and self.simulated==self.signature()),
            hasSource=bool(self.source))

    def action(self,name,data):
        if name=='state':return self.state()
        if name=='open':
            if data.get('path'):
                path=Path(data['path'].strip().strip('"')).resolve()
                self.payload=load_payload(path,self.mode);self.source=path
                self.source_hash=hashlib.sha256(path.read_bytes()).hexdigest()
            else:
                obj=data.get('payload')
                if not isinstance(obj,dict) or not isinstance(obj.get('records'),list) or not obj['records']:raise ReviewError('JSON sem registros.')
                if self.mode=='bpa' and obj.get('exportType')!='PEC_BPA_FILA_PARA_PREENCHIMENTO':raise ReviewError('Arquivo não é uma fila BPA.')
                if self.mode=='gil' and (obj.get('destination')!='GIL_RAUL' or obj.get('schemaVersion')!=1):raise ReviewError('Arquivo não é uma seleção GIL — Raul.')
                self.payload=obj;self.source=None;self.source_hash=None
            self.plan=self.simulated=None
            if self.mode=='bpa':
                from common import date
                periods={date(r.get('attendanceDate')).strftime('%Y%m') for r in self.payload['records']}
                if len(periods)==1:self.options['competence']=periods.pop()
            return self.state()
        if name=='draft':return self.payload
        self.update(data)
        pw=data.get('password','')
        if name=='links':
            with Database(self.config,pw) as db:return bpa.professionals(db)
        if not self.payload:raise ReviewError('Abra o JSON primeiro.')
        if name=='preview':
            self.simulated=None
            with Database(self.config,pw) as db:self.plan=(bpa.plan if self.mode=='bpa' else gil.plan)(db,self.payload,self.options)
            return self.state()
        if name in ('simulate','commit'):
            if not self.plan:raise ReviewError('Gere a prévia primeiro.')
            sig=self.signature()
            if name=='commit' and (self.simulated!=sig or data.get('confirm') is not True):raise ReviewError('Simule este lote e confirme antes de gravar.')
            result=transact(self.mode,self.payload,self.options,self.config,pw,self.plan,commit=name=='commit')
            if name=='simulate':self.simulated=sig
            else:
                self.plan=self.simulated=None
                if data.get('deleteSource') and self.source:
                    try:
                        if self.source.is_file() and hashlib.sha256(self.source.read_bytes()).hexdigest()==self.source_hash:
                            self.source.unlink();result['sourceDeleted']=True;self.source=None
                        else:result['cleanupWarning']='Arquivo original mudou; foi preservado.'
                    except OSError:result['cleanupWarning']='Não foi possível apagar o arquivo original. Apague-o manualmente após conferir.'
            return {'result':result,'state':self.state()}
        raise ReviewError('Ação desconhecida.')


def make_handler(session):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass  # Sem dados de pacientes em logs HTTP.
        def valid_host(self):return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
        def reply(self,body,status=200,kind='application/json; charset=utf-8'):
            if not isinstance(body,bytes):body=json.dumps(body,ensure_ascii=False,default=str).encode('utf-8')
            self.send_response(status);self.send_header('Content-Type',kind)
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            if not self.valid_host():return self.reply({'error':'Origem inválida.'},403)
            if self.path=='/':
                html=(ROOT/'web'/'index.html').read_text(encoding='utf-8').replace('__TOKEN__',session.token)
                return self.reply(html.encode('utf-8'),kind='text/html; charset=utf-8')
            names={'/app.js':('app.js','text/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8')}
            if self.path in names:
                name,kind=names[self.path];return self.reply((ROOT/'web'/name).read_bytes(),kind=kind)
            self.reply({'error':'Não encontrado.'},404)
        def do_POST(self):
            origin=f'http://127.0.0.1:{self.server.server_port}'
            if not self.valid_host() or self.headers.get('Origin')!=origin or not secrets.compare_digest(self.headers.get('X-Session-Token',''),session.token):
                return self.reply({'error':'Requisição não autorizada.'},403)
            if not self.path.startswith('/api/'):return self.reply({'error':'Não encontrado.'},404)
            try:
                size=int(self.headers.get('Content-Length','0'))
                if size<0 or size>30*1024*1024:raise ReviewError('Tamanho de requisição inválido.')
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict):raise ReviewError('Formato inválido.')
                action=self.path.removeprefix('/api/')
                with session.lock:
                    if action=='close':
                        session.payload=session.plan=session.simulated=None
                        self.reply({'closed':True});threading.Thread(target=self.server.shutdown,daemon=True).start();return
                    result=session.action(action,data)
                self.reply(result)
            except Exception as exc:
                # Credenciais nunca são incluídas nos erros do driver.
                session.simulated=None
                self.reply({'error':str(exc)},400)
    return Handler


def main():
    mode=sys.argv[1] if len(sys.argv)>1 else 'bpa'
    if mode not in ('bpa','gil'):raise SystemExit('Use local_app.py bpa ou local_app.py gil')
    session=Session(mode)
    server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(session))
    url=f'http://127.0.0.1:{server.server_port}/'
    print('Importador local:',url,'\nUse Encerrar no aplicativo quando terminar.',flush=True)
    webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()

if __name__=='__main__':main()
