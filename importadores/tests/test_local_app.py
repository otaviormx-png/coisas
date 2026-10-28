import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import local_app
from common import Plan,ReviewError
from fixtures import payload


class LocalHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session=local_app.Session('bpa')
        cls.server=local_app.ThreadingHTTPServer(('127.0.0.1',0),local_app.make_handler(cls.session))
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def request(self,path='/',method='GET',headers=None,data=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        conn.request(method,path,body=json.dumps(data or {}) if method=='POST' else None,headers=headers or {})
        res=conn.getresponse();body=res.read();status=res.status;response_headers=dict(res.getheaders());conn.close()
        return status,body,response_headers
    def test_root_has_no_store_and_csp(self):
        status,body,headers=self.request()
        self.assertEqual(status,200);self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        self.assertIn(self.session.token.encode(),body)
    def test_post_without_token_or_foreign_origin_blocked(self):
        self.assertEqual(self.request('/api/state','POST')[0],403)
        self.assertEqual(self.request('/api/state','POST',{'Origin':'https://example.invalid','X-Session-Token':self.session.token})[0],403)
    def test_session_request_and_host_validation(self):
        headers={'Origin':f'http://127.0.0.1:{self.server.server_port}','X-Session-Token':self.session.token,'Content-Type':'application/json'}
        self.assertEqual(self.request('/api/state','POST',headers)[0],200)
        self.assertEqual(self.request('/',headers={'Host':'evil.invalid'})[0],403)
        self.assertEqual(self.request('/../../common.py')[0],404)


class CleanupTests(unittest.TestCase):
    def test_cleanup_only_after_verified_commit(self):
        with tempfile.TemporaryDirectory(prefix='importadores_test_') as folder:
            root=Path(folder)
            with patch.object(local_app,'ROOT',root):
                session=local_app.Session('bpa');source=root/'entrada.json';source.write_text(json.dumps(payload()),encoding='utf-8')
                session.action('open',{'path':str(source)})
                session.plan=Plan('bpa');session.simulated=session.signature()
                with patch.object(local_app,'transact',side_effect=ReviewError('Falha simulada')):
                    with self.assertRaises(ReviewError):session.action('commit',{'confirm':True,'deleteSource':True})
                self.assertTrue(source.exists())
                session.simulated=session.signature()
                with patch.object(local_app,'transact',return_value={'committed':True,'verified':True,'new':1}):
                    result=session.action('commit',{'confirm':True,'deleteSource':True})
                self.assertFalse(source.exists());self.assertTrue(result['result']['sourceDeleted'])

if __name__=='__main__':unittest.main()
