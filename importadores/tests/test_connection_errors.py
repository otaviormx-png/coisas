import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock,patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from common import Database,ReviewError

class ConnectionErrors(unittest.TestCase):
    def test_firebird_authentication_is_explained_without_password(self):
        class DriverError(Exception):pass
        module=types.SimpleNamespace(DatabaseError=DriverError,connect=Mock(side_effect=DriverError('Your user name and password are not defined',-902,335544472)))
        with patch.dict(sys.modules,{'fdb':module}):
            with self.assertRaises(ReviewError) as caught:Database({'dsn':'localhost:fixture_test.fdb','user':'MESTRE'},'SENHA_FICTICIA')
        self.assertIn('Firebird',str(caught.exception));self.assertIn('MESTRE',str(caught.exception))
        self.assertNotIn('SENHA_FICTICIA',str(caught.exception))

    def test_other_database_errors_are_not_mislabeled_as_authentication(self):
        class DriverError(Exception):pass
        module=types.SimpleNamespace(DatabaseError=DriverError,connect=Mock(side_effect=DriverError('unavailable database',-904)))
        with patch.dict(sys.modules,{'fdb':module}):
            with self.assertRaises(DriverError):Database({'dsn':'localhost:fixture_test.fdb','user':'EXEMPLO'},'')

if __name__=='__main__':unittest.main()
