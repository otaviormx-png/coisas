"""Planejamento BPA-I para o esquema S_PRD/CADMED, validado em Firebird 1.5."""
from collections import defaultdict
import re
from common import Plan, Statement, ReviewError, age, cpf_valid, cns_valid, date, digits, exact_check, insert, norm, sex


def professionals(db):
    return db.query('SELECT C.CADMED_NOME AS NAME, V.MED_CNS AS CNS, V.MED_CBO AS CBO, V.MED_CNES AS CNES '
                    'FROM CADMED C JOIN CADMED_CBO_CNES V ON V.MED_CNS=C.CADMED_CNS ORDER BY C.CADMED_NOME, V.MED_CBO')


def service_reference(db, cmp):
    rows=db.query('SELECT MAX(PASRV_CMP) AS CMP FROM S_PASRV WHERE PASRV_CMP<=?',(cmp,))
    return rows[0]['CMP'] if rows else None


def professional_setup(db, payload, opts):
    """Sugestões verificadas na SIGTAP instalada; nunca escolhe vínculo ambíguo."""
    links = professionals(db)
    cmp = str(opts.get('competence',''))
    if not re.fullmatch(r'\d{4}(0[1-9]|1[0-2])',cmp):
        raise ReviewError('Confira a competência antes de ler os vínculos.')
    reference=service_reference(db,cmp)
    suggestions = {}
    for name in sorted({str(r.get('professional','')) for r in payload['records']}):
        key=norm(name)
        procedures={digits(r.get('procedure')) for r in payload['records'] if norm(r.get('professional'))==key}
        matching=[v for v in links if norm(v['NAME'])==key or (len(norm(v['NAME']))>=15 and key.startswith(norm(v['NAME'])))]
        previous=opts.get('bindings',{}).get(key,{})
        candidates=[]
        for link in matching:
            allowed=None
            for procedure in procedures:
                if len(procedure)!=10:continue
                rows=db.query('SELECT PASRV_SRV,PASRV_CSF FROM S_PASRV WHERE PASRV_PA=? AND PASRV_CMP=?',(procedure[:9],reference)) if reference else []
                pairs={(r['PASRV_SRV'],r['PASRV_CSF']) for r in rows}
                if pairs:allowed=pairs if allowed is None else allowed & pairs
            service=classification='';source='Confira a regra do profissional.'
            saved=(str(previous.get('service','')),str(previous.get('classification','')))
            history=db.query("SELECT DISTINCT PRD_SERVICO,PRD_CLASSIFICACAO FROM S_PRD WHERE PRD_CNSMED=? AND PRD_CBO=? AND PRD_UID=? AND PRD_ORG='BPI' AND PRD_CMP<=?",(link['CNS'],link['CBO'],link['CNES'],cmp))
            historical={(r['PRD_SERVICO'],r['PRD_CLASSIFICACAO']) for r in history if r['PRD_SERVICO'] and r['PRD_CLASSIFICACAO']}
            if allowed is not None:historical &= allowed
            pick=None
            if all(re.fullmatch(r'\d{3}',v) for v in saved) and (allowed is None or saved in allowed):
                pick=saved;source='Configuração já confirmada para o profissional.'
            elif allowed is not None and len(allowed)==1:
                pick=next(iter(allowed));source='Combinação única na tabela de serviços do BPA.'
            elif len(historical)==1:
                pick=next(iter(historical));source='Combinação já usada no BPA e compatível com a tabela.'
            elif procedures=={'0302050027'} and link['CBO']=='223605' and allowed and ('135','003') in allowed:
                pick=('135','003');source='Regra de fisioterapia 135/003 conferida no catálogo do BPA.'
            if pick:service,classification=pick
            candidates.append(dict(cns=link['CNS'],cbo=link['CBO'],cnes=link['CNES'],service=service,
                                   classification=classification,cid_required=procedures=={'0302050027'},source=source))
        chosen=[c for c in candidates if all(c[k]==previous.get(k) for k in ('cns','cbo','cnes'))]
        if not chosen and len(candidates)==1:chosen=candidates
        suggestions[key]={'candidates':candidates,'binding':chosen[0] if len(chosen)==1 else None,
                          'ambiguous':len(candidates)>1 and not chosen}
    return {'links':links,'suggestions':suggestions,'serviceReference':reference,
            'warning':'' if reference else 'Não foi encontrada referência de serviços para este período. Confira a configuração do profissional.'}


def identity(row):
    return (row.get('PRD_CPF_PCNTE') or row.get('PRD_CNSPAC') or
            (norm(row.get('PRD_NMPAC')), row.get('PRD_DTNASC')))


def matches(old, new):
    # CPF principal; CNS complementar também reconhece lotes antigos sem CPF.
    for key in ('PRD_CPF_PCNTE', 'PRD_CNSPAC'):
        if old.get(key) and new.get(key) and old[key] == new[key]:
            return True
    return (not old.get('PRD_CPF_PCNTE') and not old.get('PRD_CNSPAC') and
            norm(old.get('PRD_NMPAC')) == norm(new.get('PRD_NMPAC')) and
            old.get('PRD_DTNASC') == new.get('PRD_DTNASC'))


def plan(db, payload, opts):
    p = Plan('bpa')
    cmp = str(opts.get('competence', ''))
    if not re.fullmatch(r'\d{4}(0[1-9]|1[0-2])', cmp):
        raise ReviewError('Competência inválida; use AAAAMM.')
    installed = {r['CTR_MVM'] for r in db.query('SELECT DISTINCT CTR_MVM FROM S_CTR')}
    if installed != {cmp}:
        raise ReviewError('A competência da configuração do BPA difere do lote. Confira o BPA antes de continuar.')
    if not db.query('SELECT FIRST 1 PA_CMP FROM S_PA WHERE PA_CMP=?', (cmp,)):
        raise ReviewError('A tabela SIGTAP da competência não está instalada neste banco.')
    links = professionals(db)
    old = db.query("SELECT * FROM S_PRD WHERE PRD_CMP=? AND PRD_ORG='BPI'", (cmp,))
    p.context = {'competence': cmp, 'bindings': opts.get('bindings', {}), 'old': old,
                 'input': payload, 'strict_text': opts.get('strict_text', False)}
    sheets = defaultdict(lambda: defaultdict(list))
    for row in old:
        group = (row['PRD_UID'], row['PRD_CNSMED'], row['PRD_CBO'])
        flh, seq = row.get('PRD_FLH', ''), row.get('PRD_SEQ', '')
        if not str(flh).isdigit() or not str(seq).isdigit() or not 1 <= int(flh) <= 999 or not 1 <= int(seq) <= 99:
            raise ReviewError('Há folha/sequência irregular no BPA. Corrija antes da importação.')
        sheets[group][int(flh)].append(row)
    seen = []
    cache = {}
    service_cmp=service_reference(db,cmp)
    for r in payload['records']:
        try:
            if r.get('excluded') or r.get('reviewStatus') == 'duplicate':
                raise ReviewError('Registro excluído ou duplicado no arquivo. Exporte novamente a revisão.')
            if not norm(r.get('patientName')):
                raise ReviewError('Nome do paciente ausente.')
            binding = opts.get('bindings', {}).get(norm(r.get('professional')))
            if not binding:
                raise ReviewError('Associe o profissional a um vínculo cadastrado no BPA.')
            cns, cbo, cnes = (binding.get(k, '') for k in ('cns', 'cbo', 'cnes'))
            if not any(v['CNS'] == cns and v['CBO'] == cbo and v['CNES'] == cnes for v in links):
                raise ReviewError('Vínculo CNS/CBO/CNES não encontrado no próprio BPA.')
            if cnes != str(opts.get('cnes', '0012734')):
                raise ReviewError('O vínculo não pertence à unidade selecionada.')
            born, attended = date(r.get('birthDate')), date(r.get('attendanceDate'))
            if attended.strftime('%Y%m') != cmp:
                raise ReviewError('Data de atendimento fora da competência.')
            years = age(born, attended)
            if years > 130:
                raise ReviewError('Idade superior a 130 anos; confira o nascimento.')
            cpf, patient_cns = digits(r.get('cpf')), digits(r.get('cns'))
            if cpf and not cpf_valid(cpf):
                raise ReviewError('CPF inválido. Confira o cadastro no PEC.')
            if not cpf and not cns_valid(patient_cns):
                raise ReviewError('Falta CPF válido ou CNS válido.')
            if patient_cns and not cns_valid(patient_cns):
                patient_cns = ''  # CPF válido permanece como documento principal.
            procedure = digits(r.get('procedure'))
            if len(procedure) != 10:
                raise ReviewError('Procedimento precisa ter 10 dígitos.')
            if procedure not in cache:
                pa = db.query('SELECT PA_ID,PA_DV,PA_CMP,PA_DC,PA_SEXO FROM S_PA WHERE PA_ID=? AND PA_DV=? AND PA_CMP=?',
                              (procedure[:9], procedure[9:], cmp))
                cbos = db.query('SELECT PACBO_CBO FROM S_PACBO WHERE PACBO_PA=? AND PACBO_CMP=?', (procedure[:9], cmp))
                srvs = db.query('SELECT PASRV_SRV,PASRV_CSF FROM S_PASRV WHERE PASRV_PA=? AND PASRV_CMP=?', (procedure[:9], service_cmp)) if service_cmp else []
                cids = db.query('SELECT PACID_CID FROM S_PACID WHERE PACID_PA=? AND PACID_CMP=?', (procedure[:9], cmp))
                cache[procedure] = (pa, cbos, srvs, cids)
            pa, cbos, srvs, cids = cache[procedure]
            if len(pa) != 1:
                raise ReviewError('Procedimento ausente ou ambíguo na SIGTAP instalada.')
            sx = sex(r.get('sex'))
            if pa[0]['PA_SEXO'] in ('M','F') and pa[0]['PA_SEXO'] != sx:
                raise ReviewError('Sexo incompatível com o procedimento na tabela instalada.')
            if cbos and cbo not in {v['PACBO_CBO'] for v in cbos}:
                raise ReviewError('CBO incompatível com o procedimento na SIGTAP instalada.')
            service, classification = str(binding.get('service', '')), str(binding.get('classification', ''))
            if not re.fullmatch(r'\d{3}', service) or not re.fullmatch(r'\d{3}', classification):
                raise ReviewError('Configure serviço e classificação com três dígitos cada.')
            if srvs and (service, classification) not in {(v['PASRV_SRV'],v['PASRV_CSF']) for v in srvs}:
                raise ReviewError('Serviço/classificação incompatível com o procedimento.')
            cid = norm(r.get('cid')).replace('.', '')
            if (binding.get('cid_required') or procedure == '0302050027') and not cid:
                raise ReviewError('CID obrigatório para este profissional/procedimento.')
            if cid:
                if not re.fullmatch('[A-Z][0-9]{2}[0-9A-Z]?', cid):
                    raise ReviewError('CID inválido.')
                valid = db.query('SELECT FIRST 1 CD_COD FROM S_CID WHERE CD_COD=? AND (CMP_INI IS NULL OR CMP_INI<=?) AND (CMP_FIM IS NULL OR CMP_FIM=\'\' OR CMP_FIM>=?)', (cid,cmp,cmp))
                if not valid:
                    raise ReviewError('CID '+cid+' não encontrado ou fora do período na tabela do BPA.')
                if cids and cid not in {v['PACID_CID'] for v in cids}:
                    raise ReviewError('CID '+cid+' incompatível com o procedimento '+procedure+' na tabela do BPA.')
            cep, ibge = digits(r.get('postalCode')), digits(r.get('residenceMunicipalityCode'))
            if len(cep) != 8 or len(ibge) != 6:
                raise ReviewError('Confira CEP e código IBGE de residência.')
            ceps = db.query('SELECT CO_MUNICIPIO FROM S_CEP WHERE CO_CEP=?', (cep,))
            if len(ceps) != 1 or ceps[0]['CO_MUNICIPIO'] != ibge:
                raise ReviewError('CEP e município não conferem com a tabela do BPA.')
            street_type = digits(r.get('streetType'))
            if not street_type:
                types = db.query("SELECT CDN_IT,CDN_DSCR FROM S_CDN WHERE CDN_TB='61'")
                types = [v for v in types if norm(v['CDN_DSCR']) == norm(r.get('streetType'))]
                if len(types) == 1: street_type = types[0]['CDN_IT']
            street_type = street_type.zfill(3)
            if not db.query("SELECT CDN_IT FROM S_CDN WHERE CDN_TB='61' AND CDN_IT=?", (street_type,)):
                raise ReviewError('Tipo de logradouro ausente ou inválido.')
            clipped = []
            def clip(value, n, label, required=False):
                v = norm(value)
                if required and not v: raise ReviewError(f'{label} ausente.')
                if len(v) > n:
                    if opts.get('strict_text'): raise ReviewError(f'{label} excede {n} caracteres.')
                    clipped.append(label)
                return v[:n]
            race, nationality = str(r.get('raceColorCode', '')), str(r.get('nationalityCode', ''))
            if race not in ('01','02','03','04','05','99') or not re.fullmatch(r'\d{3}', nationality):
                raise ReviewError('Confira raça/cor e nacionalidade na revisão.')
            v = dict(PRD_UID=cnes, PRD_CMP=cmp, PRD_CNSMED=cns, PRD_CBO=cbo,
                     PRD_PA=procedure, PRD_CNSPAC=patient_cns, PRD_CPF_PCNTE=cpf,
                     PRD_NMPAC=clip(r.get('patientName'),30,'Nome',True), PRD_DTNASC=born.strftime('%Y%m%d'),
                     PRD_SEXO=sx, PRD_IBGE=ibge, PRD_DTATEN=attended.strftime('%Y%m%d'), PRD_CID=cid,
                     PRD_IDADE=f'{years:03}', PRD_QT_P=1, PRD_CATEN='01', PRD_NAUT='', PRD_ORG='BPI',
                     PRD_MVM=cmp, PRD_RACA=race, PRD_SERVICO=service, PRD_CLASSIFICACAO=classification,
                     PRD_EQUIPE='', PRD_ETNIA=str(r.get('ethnicityCode','')), PRD_NAC=nationality, PRD_ADVQT='0',
                     PRD_CNPJ='', PRD_INE='', PRD_SEM_CPF='N' if cpf else 'S',
                     PRD_SITUACAO_RUA='S' if r.get('streetSituation') == 'S' else 'N',
                     PRD_LOGRAD_PCNTE=street_type, PRD_CEP_PCNTE=cep,
                     PRD_END_PCNTE=clip(r.get('street'),30,'Logradouro',True),
                     PRD_BAIRRO_PCNTE=clip(r.get('neighborhood'),30,'Bairro',True),
                     PRD_NUM_PCNTE=clip(r.get('number'),5,'Número'), PRD_COMPL_PCNTE=clip(r.get('complement'),10,'Complemento'))
            for flag in ('FLPA','FLCBO','FLCA','FLIDA','FLQT','FLER','FLMUN','FLCID'): v['PRD_'+flag] = '0'
            if race == '05' and len(v['PRD_ETNIA']) != 4:
                raise ReviewError('Etnia obrigatória para raça/cor indígena.')
            same_visit = lambda a: all(a.get(k)==v.get(k) for k in ('PRD_UID','PRD_CNSMED','PRD_CBO','PRD_DTATEN','PRD_PA')) and matches(a,v)
            if any(same_visit(a) for a in seen):
                raise ReviewError('Mesmo paciente, data, profissional e procedimento repetidos no arquivo.')
            seen.append(v)
            exists = [a for a in old if same_visit(a)]
            if len(exists)>1: raise ReviewError('Já existem atendimentos repetidos no BPA. Confira antes de importar.')
            if exists:
                a = exists[0]
                p.add(r,'EXISTENTE','Já consta no BPA; será preservado.',a['PRD_FLH']+'/'+a['PRD_SEQ'])
                continue
            group = (cnes,cns,cbo)
            unique = bool(binding.get('unique_person')) or norm(r.get('professional')).startswith('BRUNA MEDINA')
            chosen = None
            for sheet in sorted(sheets[group]):
                rows = sheets[group][sheet]
                used = {int(a['PRD_SEQ']) for a in rows}
                if len(used) != len(rows): raise ReviewError('Há sequências repetidas em uma folha existente.')
                if len(used)<99 and (not unique or not any(matches(a,v) for a in rows)):
                    chosen = sheet; break
            if chosen is None:
                chosen = max(sheets[group], default=0)+1
            if chosen > 999: raise ReviewError('Limite de 999 folhas atingido.')
            used = {int(a['PRD_SEQ']) for a in sheets[group][chosen]}
            seq = next(i for i in range(1,100) if i not in used)
            v.update(PRD_FLH=f'{chosen:03}', PRD_SEQ=f'{seq:02}')
            # Validação de codificação antes de criar qualquer comando de gravação.
            for val in v.values():
                if isinstance(val,str): val.encode('cp1252')
            sheets[group][chosen].append(v)
            p.writes.append(insert('S_PRD',v))
            p.checks.append(exact_check('S_PRD',v))
            p.add(r,'NOVO','Pronto.'+(' Textos limitados ao BPA: '+', '.join(clipped) if clipped else ''), f'{chosen:03}/{seq:02}')
        except (ReviewError, ValueError, UnicodeEncodeError) as e:
            p.add(r,'PENDENTE',str(e))
    return p
