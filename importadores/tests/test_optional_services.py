"""Regressão do lote que mistura consulta e procedimentos contraceptivos."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bpa
from fixtures import MED,record,payload


class CatalogDb:
    def __init__(self,reference='202610'):
        self.reference=reference

    def query(self,sql,params=()):
        if 'FROM S_CTR' in sql:return [{'CTR_MVM':'202610'}]
        if 'FROM CADMED C' in sql:
            return [dict(NAME='BRUNA MEDINA VALLADARES',CNS=MED,CBO='225250',CNES='0012734')]
        if 'FROM S_PRD' in sql:return []
        if 'MAX(PASRV_CMP)' in sql:return [{'CMP':self.reference}]
        if 'FROM S_PA ' in sql:
            return [dict(PA_ID=params[0],PA_DV=params[1],PA_CMP='202610',PA_DC='PROCEDIMENTO FICTÍCIO',PA_SEXO='F')] if len(params)>1 else [{'PA_CMP':'202610'}]
        if 'FROM S_PACBO' in sql:return [{'PACBO_CBO':'225250'}]
        if 'FROM S_PASRV' in sql:
            return [dict(PASRV_SRV='112',PASRV_CSF='008')] if params[0]=='030101036' else []
        if 'FROM S_PACID' in sql:return []
        if 'FROM S_CEP' in sql:return [{'CO_MUNICIPIO':'330330'}]
        if 'FROM S_CDN' in sql:return [{'CDN_IT':'081'}]
        raise AssertionError(sql)


class OptionalServicePlanTests(unittest.TestCase):
    def plan_for(self,procedures,service='112',classification='008',reference='202610'):
        rows=[record(professional='Bruna Medina Valladares',attendanceDate='10/10/2026',procedure=p,cid='') for p in procedures]
        opts=dict(competence='202610',cnes='0012734',bindings={'BRUNA MEDINA VALLADARES':
            dict(cns=MED,cbo='225250',cnes='0012734',service=service,classification=classification,cid_required=False)})
        return bpa.plan(CatalogDb(reference),payload(records=rows),opts)

    @staticmethod
    def written_values(plan):
        return [dict(zip(stmt.sql.split('(',1)[1].split(')',1)[0].split(','),stmt.params)) for stmt in plan.writes]

    def test_all_four_contraceptive_procedures_allow_blank_services(self):
        procedures=['0301040141','0301040150','0301040176','0301040184']
        plan=self.plan_for(procedures,service='',classification='')
        self.assertEqual(plan.new_count,4);self.assertFalse(plan.errors)
        self.assertTrue(all(v['PRD_SERVICO']==v['PRD_CLASSIFICACAO']=='' for v in self.written_values(plan)))

    def test_consultation_service_does_not_leak_to_implant_in_same_batch(self):
        plan=self.plan_for(['0301010366','0301040176'])
        self.assertFalse(plan.errors);self.assertEqual(plan.new_count,2)
        consultation,implant=self.written_values(plan)
        self.assertEqual((consultation['PRD_SERVICO'],consultation['PRD_CLASSIFICACAO']),('112','008'))
        self.assertEqual((implant['PRD_SERVICO'],implant['PRD_CLASSIFICACAO']),('',''))

    def test_required_service_still_blocks_blank_or_incompatible_pair(self):
        for pair in [('',''),('121','002')]:
            with self.subTest(pair=pair):
                plan=self.plan_for(['0301010366'],*pair)
                self.assertEqual(len(plan.errors),1);self.assertEqual(plan.new_count,0)

    def test_missing_catalog_is_not_interpreted_as_optional_service(self):
        plan=self.plan_for(['0301040176'],reference=None)
        self.assertEqual(len(plan.errors),1);self.assertEqual(plan.new_count,0)
        self.assertIn('Referência de serviços',plan.errors[0]['detail'])


if __name__=='__main__':unittest.main()
