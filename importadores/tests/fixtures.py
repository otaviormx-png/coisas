"""Dados exclusivamente fictícios para testes em bancos vazios de homologação."""
import datetime as dt
from common import insert

CPF='52998224725'  # número de exemplo amplamente usado em testes de validação
UNIT='001273400'
PRO='0000000001'
MED='700000000000005'
NAME='PACIENTE FICTICIO DE TESTE'

def record(mode='bpa', **changes):
    r=dict(patientName=NAME,professional='Profissional de teste',cpf=CPF,cns='',birthDate='10/01/1980',
           attendanceDate='10/09/2026',sex='F',procedure='0302050027',cid='M545',postalCode='24000000',
           residenceMunicipalityCode='330330',neighborhood='CENTRO',streetType='081',street='RUA DE TESTE',
           number='1',complement='',raceColorCode='03',nationalityCode='010',streetSituation='N')
    if mode=='gil':r.update(professional='Raul Pimentel Kastrup',procedure='0301010072',cid='Z000',natureza='3',selected=True)
    r.update(changes);return r

def payload(mode='bpa', records=None):
    data={'records':records if records is not None else [record(mode)]}
    if mode=='bpa':data['exportType']='PEC_BPA_FILA_PARA_PREENCHIMENTO'
    else:data.update(destination='GIL_RAUL',schemaVersion=1,unit=UNIT,matricula='52573220')
    return data

def options(mode='bpa'):
    if mode=='gil':return dict(unit=UNIT,matricula='52573220',specialty='225170',allow_coringa=False)
    return dict(competence='202609',cnes='0012734',bindings={'PROFISSIONAL DE TESTE':
        dict(cns=MED,cbo='223605',cnes='0012734',service='135',classification='003',cid_required=True)})

def seed(db,mode):
    def add(t,**v):db.execute(insert(t,v))
    if mode=='bpa':
        add('S_CTR',CTR_MVM='202609')
        add('CADMED',CADMED_CNS=MED,CADMED_NOME='PROFISSIONAL DE TESTE')
        add('CADMED_CBO_CNES',MED_CNS=MED,MED_CBO='223605',MED_CNES='0012734')
        add('S_PA',PA_ID='030205002',PA_DV='7',PA_CMP='202609',PA_SEXO='A',PA_DC='PROCEDIMENTO DE TESTE')
        add('S_PACBO',PACBO_PA='030205002',PACBO_CBO='223605',PACBO_CMP='202609')
        add('S_PASRV',PASRV_PA='030205002',PASRV_CMP='202609',PASRV_SRV='135',PASRV_CSF='003')
        add('S_CID',CD_COD='M545',CMP_INI='200001',CMP_FIM='999912')
        add('S_PACID',PACID_PA='030205002',PACID_CID='M545',PACID_CMP='202609')
        add('S_CEP',CO_CEP='24000000',CO_MUNICIPIO='330330')
        add('S_CDN',CDN_TB='61',CDN_IT='081',CDN_DSCR='RUA')
    else:
        add('PROGRAMA',CODIGO='00',DESCRICAO='TESTE')
        add('TURNO',CODIGO='4',DESCRICAO='TESTE')
        add('PRESTAD',COD_PREST='1')
        add('UN_SAUDE',CODUNASS=UNIT,CODUS='0012734',NOMEUS='UNIDADE FICTICIA',TIPO_CID='1',NIVEL_HIER='1',
            TP_USSUS='1',TP_PRESTAD='1',TIPO_UNID='1',PRONT_INIC='1',QTDE_ODONT=0,LOTE_ABERTO_FAT='0',LOTE_ABERTO_REL='0')
        add('PROFISS',COD_SEQ_PROF=PRO,NOME='RAUL KASTRUP')
        add('VL_EASPROF',CODUNASS=UNIT,COD_SEQ_PROF=PRO,MATRICULA='52573220')
        add('CTRLNSUP',ULT_LOTE=0)
        add('CID',CODCID='Z000')
        add('PROCEDIM',CODPROC='0301010072')
        add('BAIRRO',CODIGO='000',NOME='TESTE')
        add('PLSAUDE',CODIGO='0000')
        add('USUARIO',COD_SEQ_USU='0000000001',NM_ATU=NAME,DT_NASC=dt.date(1980,1,10),SEXO='F',CPF=CPF)
        add('VL_EASUSU',CODUNASS=UNIT,COD_SEQ_USU='0000000001',NR_REG_USU='123')
