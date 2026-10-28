"""Integração opcional: usa somente bancos *_test.fdb locais, com estrutura vazia e fixtures.

TEST_BPA_DSN / TEST_GIL_DSN, TEST_BPA_USER / TEST_GIL_USER,
TEST_BPA_PASSWORD / TEST_GIL_PASSWORD, TEST_DATA_DIR, FBCLIENT, TEST_GBAK.
Nunca aponte estes testes para uma instalação de produção.
"""
import copy
import datetime as dt
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'.runtime'/'python'))
from common import Database,ReviewError,Statement,age,cpf_valid,cns_valid,date,insert,transact
import bpa,gil
from fixtures import CPF,NAME,record,payload,options


class ValidationTests(unittest.TestCase):
    def test_cpf_checksum(self):
        self.assertTrue(cpf_valid(CPF));self.assertFalse(cpf_valid('11111111111'));self.assertFalse(cpf_valid('52998224724'))
    def test_cns_and_dates(self):
        self.assertFalse(cns_valid('111111111111111'))
        with self.assertRaises(ReviewError):date('31/02/2026')
        with self.assertRaises(ReviewError):age('10/01/2030','10/01/2026')
        self.assertEqual(age('11/09/1980','10/09/2026'),45)


class IntegrationBase:
    mode=''
    @classmethod
    def setUpClass(cls):
        mode=cls.mode.upper();dsn=os.environ.get('TEST_'+mode+'_DSN','')
        if not dsn:raise unittest.SkipTest('Banco de teste não configurado: '+mode)
        directory=Path(os.environ['TEST_DATA_DIR']).resolve()
        if not dsn.startswith('localhost:'):raise RuntimeError('Testes aceitam somente localhost.')
        file=Path(dsn[len('localhost:'):]).resolve()
        if file.parent!=directory or not file.name.lower().endswith('_test.fdb'):
            raise RuntimeError('O banco deve terminar em _test.fdb dentro de TEST_DATA_DIR.')
        cls.cfg=dict(dsn=dsn,user=os.environ['TEST_'+mode+'_USER'],client=os.environ['FBCLIENT'],
                     gbak=os.environ['TEST_GBAK'],backup_dir=str(directory/(cls.mode+'_backups')))
        cls.pw=os.environ['TEST_'+mode+'_PASSWORD']

    def setUp(self):
        with Database(self.cfg,self.pw,write=True) as db:
            tables=['S_PRD'] if self.mode=='bpa' else ['CONSNSUP','LOTENSUP']
            for table in tables:
                cur=db.con.cursor();cur.execute('DELETE FROM '+table);cur.close()
            if self.mode=='gil':
                cur=db.con.cursor();cur.execute('UPDATE CTRLNSUP SET ULT_LOTE=0');cur.close()
            db.con.commit()
        self.data=payload(self.mode);self.opts=options(self.mode)

    def plan(self):
        with Database(self.cfg,self.pw) as db:
            return (bpa.plan if self.mode=='bpa' else gil.plan)(db,self.data,self.opts)

    def count(self):
        with Database(self.cfg,self.pw) as db:
            return db.query('SELECT COUNT(*) AS N FROM '+('S_PRD' if self.mode=='bpa' else 'CONSNSUP'))[0]['N']

    def test_simulation_rolls_back(self):
        p=self.plan();self.assertEqual(p.errors,[]);self.assertEqual(p.new_count,1)
        result=transact(self.mode,self.data,self.opts,self.cfg,self.pw,p)
        self.assertFalse(result['committed']);self.assertEqual(self.count(),0)

    def test_commit_backup_idempotence_and_stale_preview(self):
        p=self.plan();result=transact(self.mode,self.data,self.opts,self.cfg,self.pw,p,commit=True)
        self.assertTrue(result['committed']);self.assertTrue(Path(result['backup']).is_file())
        self.assertEqual(self.count(),1)
        again=self.plan();self.assertEqual(again.new_count,0);self.assertEqual(again.rows[0]['status'],'EXISTENTE')
        with self.assertRaises(ReviewError):transact(self.mode,self.data,self.opts,self.cfg,self.pw,p)

    def test_mid_transaction_error_rolls_back(self):
        p=self.plan();p.writes.append(Statement('INSERT INTO TABELA_INEXISTENTE (CAMPO) VALUES (?)',('TESTE',)))
        module=bpa if self.mode=='bpa' else gil
        with patch.object(module,'plan',return_value=p):
            with self.assertRaises(Exception):transact(self.mode,self.data,self.opts,self.cfg,self.pw,p)
        self.assertEqual(self.count(),0)

    def test_backup_failure_prevents_writes(self):
        p=self.plan()
        def fail(*args):raise ReviewError('Backup indisponível')
        with self.assertRaises(ReviewError):transact(self.mode,self.data,self.opts,self.cfg,self.pw,p,commit=True,backup_fn=fail)
        self.assertEqual(self.count(),0)


class BpaTests(IntegrationBase,unittest.TestCase):
    mode='bpa'

    def test_required_fields_and_competence(self):
        self.data['records'][0]['cid']=''
        self.assertEqual(len(self.plan().errors),1)
        self.data=payload();self.opts['competence']='202610'
        with self.assertRaises(ReviewError):self.plan()

    def test_sheet_limit_99(self):
        def cpf_for(n):
            s=f'{n:09}'
            for size in (9,10):
                k=sum(int(s[i])*(size+1-i) for i in range(size))*10%11
                s+=str(0 if k==10 else k)
            return s
        self.data['records']=[record(patientName=f'PACIENTE FICTICIO {i}',cpf=cpf_for(i+100)) for i in range(100)]
        p=self.plan();self.assertEqual(p.errors,[]);self.assertEqual(p.new_count,100)
        self.assertEqual(sum(r['location'].startswith('001/') for r in p.rows),99)
        self.assertEqual(p.rows[-1]['location'],'002/01')

    def test_unique_person_per_sheet(self):
        self.opts['bindings']['PROFISSIONAL DE TESTE']['unique_person']=True
        self.data['records'].append(record(attendanceDate='11/09/2026'))
        self.assertEqual([r['location'] for r in self.plan().rows],['001/01','002/01'])

    def test_input_duplicate_and_document_priority(self):
        self.data['records'].append(copy.deepcopy(self.data['records'][0]))
        self.assertEqual(len(self.plan().errors),1)
        self.data=payload();p=self.plan();transact('bpa',self.data,self.opts,self.cfg,self.pw,p,commit=True)
        with Database(self.cfg,self.pw) as db:
            row=db.query('SELECT PRD_CPF_PCNTE,PRD_SEM_CPF,PRD_SITUACAO_RUA FROM S_PRD')[0]
            self.assertEqual(row,dict(PRD_CPF_PCNTE=CPF,PRD_SEM_CPF='N',PRD_SITUACAO_RUA='N'))


class GilTests(IntegrationBase,unittest.TestCase):
    mode='gil'

    def test_coringa_preserves_sex_and_does_not_create_user(self):
        self.data['records']=[record('gil',patientName='PACIENTE FICTICIA SEM CADASTRO',cpf='',birthDate='11/02/1990',sex='F')]
        self.assertEqual(len(self.plan().errors),1)
        self.opts['allow_coringa']=True
        p=self.plan();self.assertEqual(p.errors,[])
        transact('gil',self.data,self.opts,self.cfg,self.pw,p,commit=True)
        with Database(self.cfg,self.pw) as db:
            row=db.query('SELECT NR_REG_USU,SEXO,COD_SEQ_USU FROM CONSNSUP')[0]
            self.assertEqual(row,dict(NR_REG_USU='9',SEXO='2',COD_SEQ_USU=None))
            self.assertEqual(db.query('SELECT COUNT(*) AS N FROM USUARIO')[0]['N'],1)

    def test_demographic_mismatch_blocks(self):
        self.data['records'][0]['sex']='M'
        self.assertEqual(len(self.plan().errors),1)

    def test_more_than_one_day_creates_separate_lots(self):
        self.data['records'].append(record('gil',attendanceDate='11/09/2026'))
        p=self.plan();self.assertEqual(p.errors,[]);self.assertEqual([r['location'] for r in p.rows],['0000001/001','0000002/001'])
        transact('gil',self.data,self.opts,self.cfg,self.pw,p,commit=True)
        with Database(self.cfg,self.pw) as db:
            self.assertEqual(db.query('SELECT ULT_LOTE FROM CTRLNSUP')[0]['ULT_LOTE'],2)

    def test_reuses_open_lot_and_keeps_existing(self):
        p=self.plan();transact('gil',self.data,self.opts,self.cfg,self.pw,p,commit=True)
        self.opts['allow_coringa']=True
        self.data['records'].append(record('gil',patientName='OUTRO PACIENTE FICTICIO',cpf='',birthDate='12/02/1991'))
        p=self.plan();self.assertEqual(p.new_count,1);self.assertEqual(p.errors,[])
        self.assertEqual([r['location'] for r in p.rows],['0000001/001','0000001/002'])
        transact('gil',self.data,self.opts,self.cfg,self.pw,p,commit=True)
        with Database(self.cfg,self.pw) as db:
            row=db.query('SELECT NR_ULT_CON,QTD_LANC FROM LOTENSUP')[0]
            self.assertEqual(row,dict(NR_ULT_CON=2,QTD_LANC=2))


if __name__=='__main__':unittest.main()
