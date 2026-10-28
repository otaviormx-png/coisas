"""Sessão do aplicativo nativo. Comunicação com a janela por stdin/stdout, sem HTTP."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'.runtime'/'python'))
from common import Database,ReviewError,checksum,load_payload,transact
import bpa,gil


class Session:
    def __init__(self,mode):
        self.mode=mode
        self.payload=None;self.source=None;self.source_hash=None;self.plan=None;self.simulated=None
        self.setup_warning=''
        self.config=dict(dsn=r'localhost:C:\Trabalho\BPA\BPAMAG.GDB' if mode=='bpa' else '',
            user='SYSDBA' if mode=='bpa' else 'SYSGIL',client=str(ROOT/'.runtime'/'firebird'/'bin'/'fbclient.dll'),
            gbak=r'C:\Program Files (x86)\Firebird\Firebird_1_5\bin\gbak.exe',backup_dir=str(ROOT/'localdata'/'backups'))
        self.options=dict(competence='',cnes='0012734',unit='001273400',matricula='52573220',specialty='225170',
                          bindings={},allow_coringa=False,strict_text=False,remember_login=True)
        saved=ROOT/'localdata'/(mode+'_native_config.json')
        if not saved.is_file() and mode=='bpa':
            saved=ROOT/'localdata'/'bpa_web_config.json'
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
        (folder/(self.mode+'_native_config.json')).write_text(json.dumps({'config':self.config,'options':self.options},ensure_ascii=False,indent=2),encoding='utf-8')

    def state(self):
        return dict(mode=self.mode,config=self.config,options=self.options,records=self.payload['records'] if self.payload else [],
            rows=self.plan.rows if self.plan else [],pending=len(self.plan.errors) if self.plan else 0,
            new=self.plan.new_count if self.plan else 0,simulated=bool(self.simulated and self.simulated==self.signature()),
            hasSource=bool(self.source),setupWarning=self.setup_warning)

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
        if name=='saveDraft':
            if not self.payload:raise ReviewError('Abra um JSON primeiro.')
            draft=copy.deepcopy(self.payload)
            if isinstance(data.get('records'),list):draft['records']=data['records']
            Path(data['path']).write_text(json.dumps(draft,ensure_ascii=False,indent=2),encoding='utf-8')
            return {'saved':True}
        if name=='close':
            self.payload=self.plan=self.simulated=None
            return {'closed':True}
        self.update(data)
        if name=='settings':return self.state()
        pw=data.get('password','')
        if name=='links':
            # Contrato original: janelas anteriores esperam diretamente uma lista.
            with Database(self.config,pw) as db:return bpa.professionals(db)
        if name=='setup':
            if not self.payload:raise ReviewError('Abra o JSON primeiro.')
            with Database(self.config,pw) as db:return bpa.professional_setup(db,self.payload,self.options)
        if not self.payload:raise ReviewError('Abra o JSON primeiro.')
        if name=='preview':
            self.simulated=None
            with Database(self.config,pw) as db:
                if self.mode=='bpa':
                    setup=bpa.professional_setup(db,self.payload,self.options)
                    for key,item in setup['suggestions'].items():
                        if item.get('binding'):
                            current=self.options['bindings'].get(key,{})
                            proposed=item['binding']
                            if not current.get('cns') or all(current.get(k)==proposed.get(k) for k in ('cns','cbo','cnes')):
                                self.options['bindings'][key]={**current,**proposed}
                    self.setup_warning=setup.get('warning','')
                self.plan=(bpa.plan if self.mode=='bpa' else gil.plan)(db,self.payload,self.options)
            self.update({})
            return self.state()
        if name in ('simulate','commit'):
            if not self.plan:raise ReviewError('Gere a prévia primeiro.')
            sig=self.signature()
            if name=='commit' and (self.simulated!=sig or data.get('confirm') is not True):raise ReviewError('Simule este lote e confirme antes de gravar.')
            self.simulated=None
            result=transact(self.mode,self.payload,self.options,self.config,pw,self.plan,commit=name=='commit')
            if name=='commit' and not (result.get('committed') and result.get('verified')):
                raise ReviewError('A gravação não foi confirmada pela conferência final. Preserve o JSON e confira o banco.')
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

