import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import native_session as native
from common import Plan,ReviewError
from fixtures import payload


class NativeSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='pec_native_test_')
        self.root=Path(self.temp.name)
        self.patcher=patch.object(native,'ROOT',self.root);self.patcher.start()
        self.session=native.Session('bpa')
        self.source=self.root/'revisão fictícia.json'
        self.source.write_text(json.dumps(payload(),ensure_ascii=False),encoding='utf-8')
        self.session.action('open',{'path':str(self.source)})
        self.session.plan=Plan('bpa',rows=[dict(status='NOVO')])
    def tearDown(self):self.patcher.stop();self.temp.cleanup()

    def test_commit_requires_simulation_and_confirmation(self):
        with patch.object(native,'transact') as tx:
            with self.assertRaises(ReviewError):self.session.action('commit',{'confirm':True})
            self.session.simulated=self.session.signature()
            with self.assertRaises(ReviewError):self.session.action('commit',{})
            tx.assert_not_called()

    def test_changed_records_invalidate_simulation(self):
        self.session.simulated=self.session.signature()
        records=copy.deepcopy(self.session.payload['records']);records[0]['cid']='M544'
        with patch.object(native,'transact') as tx:
            with self.assertRaises(ReviewError):self.session.action('commit',{'confirm':True,'records':records})
            tx.assert_not_called()
        self.assertIsNone(self.session.simulated)

    def test_cleanup_requires_successful_final_verification(self):
        self.session.simulated=self.session.signature()
        with patch.object(native,'transact',return_value={'committed':True,'verified':False}):
            with self.assertRaises(ReviewError):self.session.action('commit',{'confirm':True,'deleteSource':True})
        self.assertTrue(self.source.exists())
        self.session.simulated=self.session.signature()
        with patch.object(native,'transact',return_value={'committed':True,'verified':True,'new':1}):
            result=self.session.action('commit',{'confirm':True,'deleteSource':True})
        self.assertTrue(result['result']['sourceDeleted']);self.assertFalse(self.source.exists())

    def test_failed_write_preserves_source(self):
        self.session.simulated=self.session.signature()
        with patch.object(native,'transact',side_effect=ReviewError('Falha simulada')):
            with self.assertRaises(ReviewError):self.session.action('commit',{'confirm':True,'deleteSource':True})
        self.assertTrue(self.source.exists())

    def test_changed_disk_file_is_preserved(self):
        self.source.write_text(json.dumps(payload(),indent=4),encoding='utf-8')
        self.session.simulated=self.session.signature()
        with patch.object(native,'transact',return_value={'committed':True,'verified':True,'new':1}):
            result=self.session.action('commit',{'confirm':True,'deleteSource':True})
        self.assertTrue(self.source.exists());self.assertIn('cleanupWarning',result['result'])

    def test_password_not_written_to_configuration(self):
        self.session.update({'password':'SENHA_FICTICIA_APENAS_TESTE'})
        config=(self.root/'localdata'/'bpa_native_config.json').read_text(encoding='utf-8')
        self.assertNotIn('SENHA_FICTICIA_APENAS_TESTE',config);self.assertNotIn('password',config)

    def test_gil_has_no_automatic_remote_destination(self):
        session=native.Session('gil');self.assertEqual(session.config['dsn'],'')

    def test_migrates_bpa_bindings_without_loading_password(self):
        folder=self.root/'localdata';folder.mkdir(exist_ok=True)
        config={'config':{'dsn':'localhost:C:\\PastaFicticia\\bpa_test.fdb','password':'SEGREDO_FICTICIO'},'options':{'bindings':{'TESTE':{'cbo':'223605'}}}}
        (folder/'bpa_web_config.json').write_text(json.dumps(config),encoding='utf-8')
        migrated=native.Session('bpa')
        self.assertEqual(migrated.options['bindings']['TESTE']['cbo'],'223605')
        self.assertNotIn('password',migrated.config)

    def test_draft_preserves_edits_without_connection(self):
        self.session.config['dsn']=''
        records=copy.deepcopy(self.session.payload['records']);records[0]['patientName']='PACIENTE FICTÍCIO COM ACENTO'
        target=self.root/'rascunho.json'
        self.session.action('saveDraft',{'path':str(target),'records':records})
        self.assertEqual(json.loads(target.read_text(encoding='utf-8'))['records'][0]['patientName'],records[0]['patientName'])


class NativeProtocolTests(unittest.TestCase):
    def test_stdio_open_draft_and_shutdown_utf8(self):
        with tempfile.TemporaryDirectory(prefix='pec_stdio_test_') as folder:
            source=Path(folder)/'revisão.json';source.write_text(json.dumps(payload(),ensure_ascii=False),encoding='utf-8')
            saved=Path(folder)/'cópia.json'
            requests=[{'id':1,'action':'state','data':{}},{'id':2,'action':'open','data':{'path':str(source)}},
                      {'id':3,'action':'saveDraft','data':{'path':str(saved)}},{'id':4,'action':'close','data':{}}]
            content='\n'.join(json.dumps(r,ensure_ascii=False) for r in requests)+'\n'
            result=subprocess.run([sys.executable,str(ROOT/'native_worker.py'),'--mode','bpa'],input=content.encode('utf-8'),capture_output=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr.decode('utf-8',errors='replace'))
            replies=[json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
            self.assertEqual([r['id'] for r in replies],[1,2,3,4]);self.assertTrue(all(r['ok'] for r in replies))
            self.assertEqual(json.loads(saved.read_text(encoding='utf-8'))['records'],payload()['records'])
            self.assertTrue(replies[-1]['data']['closed'])

    def test_invalid_action_does_not_break_protocol(self):
        content='{"id":1,"action":"inexistente","data":{}}\n{"id":2,"action":"state","data":{}}\n{"id":3,"action":"close","data":{}}\n'
        result=subprocess.run([sys.executable,str(ROOT/'native_worker.py')],input=content.encode(),capture_output=True,timeout=20)
        replies=[json.loads(s) for s in result.stdout.decode('utf-8').splitlines()]
        self.assertFalse(replies[0]['ok']);self.assertTrue(replies[1]['ok']);self.assertTrue(replies[2]['ok'])


if __name__=='__main__':unittest.main()
