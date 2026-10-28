import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bpa


class ReferenceDb:
    def __init__(self,pairs,links=None,history=(),reference='202610'):
        self.pairs=pairs;self.history=history;self.reference=reference
        self.links=links or [dict(NAME='CAMILLA ASSUMPCAO DE CARVALHO',CNS='700000000000005',CBO='223605',CNES='0012734')]
    def query(self,sql,params=()):
        if 'FROM CADMED C' in sql:return self.links
        if 'MAX(PASRV_CMP)' in sql:return [{'CMP':self.reference}]
        if 'FROM S_PASRV' in sql:return [dict(PASRV_SRV=s,PASRV_CSF=c) for s,c in self.pairs]
        if 'FROM S_PRD' in sql:return [dict(PRD_SERVICO=s,PRD_CLASSIFICACAO=c) for s,c in self.history]
        raise AssertionError(sql)


class ServiceSetupTests(unittest.TestCase):
    def setup_for(self,db,bindings=None):
        payload={'records':[{'professional':'Camilla Assumpção de Carvalho','procedure':'0302050027'}]}
        return bpa.professional_setup(db,payload,{'competence':'202610','bindings':bindings or {}})
    def test_physiotherapy_rule_is_chosen_only_when_present(self):
        result=self.setup_for(ReferenceDb([('113','001'),('135','003'),('135','011')]))
        binding=result['suggestions']['CAMILLA ASSUMPCAO DE CARVALHO']['binding']
        self.assertEqual((binding['service'],binding['classification']),('135','003'))
        self.assertTrue(binding['cid_required'])
    def test_does_not_invent_a_pair_missing_from_catalog(self):
        result=self.setup_for(ReferenceDb([('113','001'),('135','011')]))
        binding=result['suggestions']['CAMILLA ASSUMPCAO DE CARVALHO']['binding']
        self.assertEqual((binding['service'],binding['classification']),('',''))
    def test_ambiguous_professional_is_not_chosen(self):
        links=[dict(NAME='CAMILLA ASSUMPCAO DE CARVALHO',CNS=c,CBO='223605',CNES='0012734') for c in ['700000000000005','800000000000001']]
        result=self.setup_for(ReferenceDb([('135','003')],links=links))
        suggestion=result['suggestions']['CAMILLA ASSUMPCAO DE CARVALHO']
        self.assertIsNone(suggestion['binding']);self.assertTrue(suggestion['ambiguous'])
        self.assertTrue(all(c['service']=='135' for c in suggestion['candidates']))
    def test_previous_reference_month_is_disclosed(self):
        result=self.setup_for(ReferenceDb([('135','003')],reference='202609'))
        self.assertEqual(result['serviceReference'],'202609');self.assertEqual(result['warning'],'')
    def test_manual_confirmed_valid_binding_is_preserved(self):
        saved={'CAMILLA ASSUMPCAO DE CARVALHO':dict(cns='700000000000005',cbo='223605',cnes='0012734',service='135',classification='011')}
        result=self.setup_for(ReferenceDb([('135','003'),('135','011')]),saved)
        self.assertEqual(result['suggestions']['CAMILLA ASSUMPCAO DE CARVALHO']['binding']['classification'],'011')

if __name__=='__main__':unittest.main()
