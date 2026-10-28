# PEC para BPA-I

Extensão local para coletar os atendimentos realizados do PEC, completar os dados cadastrais e preparar uma lista de revisão para o BPA-I.

## Instalação de teste

Você também pode abrir `ABRIR_INSTALACAO.cmd`; ele abre a página de extensões e esta pasta lado a lado.

1. No Chrome, abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Escolha esta pasta `pec_bpa_extension`.
5. Se a Lista de atendimentos já estava aberta, atualize a página uma vez.

## Uso

### Pela Lista de atendimentos

1. Abra **Lista de atendimentos** e filtre o período e um ou vários profissionais.
2. Abra a extensão e clique em **Coletar atendimentos da lista**.
3. A extensão percorre todas as páginas da lista, lê o período e os profissionais exibidos no filtro, abre as Agendas correspondentes e acrescenta os pacientes que não apareceram na Lista. Depois separa os pacientes por profissional e data e usa uma única aba visível do PEC para consultar cada cadastro completo.
   - Atendimentos com aviso **Não finalizado** também são lidos. A extensão espera os pacientes de cada página carregarem e compara a coleta com o total de resultados do PEC; se faltar uma página ou alguma linha não puder ser interpretada, avisa em vez de entregar uma lista incompleta.
   - Filtro de um único dia: consulta a Agenda diretamente pelo profissional e pela data do filtro.
   - Período longo: usa as datas que realmente apareceram na Lista e consulta somente essas Agendas, evitando percorrer o mês inteiro.
4. A extensão mantém a aba do PEC aberta durante a coleta e abre automaticamente a aba de revisão quando terminar. Se houver pendências ou falha parcial, a revisão também será aberta para você conferir o motivo.
5. **Não compareceu** e **Atendimento não realizado** ficam marcados em cinza e excluídos da exportação, mas permanecem visíveis para conferência. Use **Reincluir selecionados** quando decidir que um deles deve entrar. **Presente na unidade**, **Aguardando atendimento**, **Em atendimento** e **Escuta inicial** continuam na revisão, pois podem representar uma falha ou atraso no lançamento do PEC. Se a Lista não trouxer nenhum paciente, a extensão ainda usa o período e o profissional do filtro para consultar a Agenda.
6. Quando o paciente estiver marcado como **DEMANDA ESPONTÂNEA** ou não for encontrado na Agenda, a extensão pesquisa o cadastro individual pelo nome, CPF ou CNS e abre o resultado único encontrado.
7. Se a busca pelo nome trouxer vários cadastros, a extensão usa também a idade do atendimento para filtrar. Só abre automaticamente quando sobra um único resultado compatível; se ainda houver mais de um ou nenhum, o registro fica pendente para confirmação manual.
8. Confira CPF, CNS, residência, procedimento, CID e duplicidades antes de exportar. A tela tem sanfona por dia, filtros por situação/origem e resumo por profissional e dia.
   - Para um profissional novo, use **Adicionar/configurar profissional novo** depois da coleta. O nome já vem do navegador; informe o procedimento padrão e marque CID obrigatório quando necessário.
   - Se a exportação encontrar pendências, a revisão mostra quem falta e filtra automaticamente esses registros. O lote já preenchido permanece salvo; não é necessário coletar tudo outra vez.
9. Se algum cadastro ficar pendente, use **Buscar cadastro** na linha ou **Tentar cadastros pendentes**. A extensão tenta novamente pela tela de Cadastro individual.
   - Se a aba temporária do PEC for fechada durante a coleta, a extensão abre outra e repete o cadastro afetado. Pendências de uma coleta anterior podem ser reprocessadas pelo mesmo botão.
10. O preenchimento de procedimento e CID é salvo automaticamente enquanto você digita. Quando o paciente tiver CPF e CNS, o CPF terá sempre prioridade na exportação; o CNS só será usado como identificação principal se não houver CPF válido.
11. Clique em **Prévia das folhas BPA** para conferir a separação por profissional, data e procedimento antes da exportação. A prévia sinaliza pendências e mostra quais atendimentos não entrarão no arquivo.
12. Antes de enviar ao BPA, use **Excluir selecionados** para retirar atendimentos sem apagar o registro. Para recuperar um atendimento, filtre por **Excluídos**, selecione-o e clique em **Reincluir selecionados**. Se precisar apagar definitivamente um registro duplicado ou indevido, use **Remover da lista**. Para dois procedimentos no mesmo atendimento, use **Duplicar atendimento** e altere o procedimento da cópia.

### Pela Agenda, com cadastro completo

1. Abra a **Agenda** na data e no profissional desejados.
2. Abra a extensão e clique em **Coletar Agenda e cadastros completos**.
3. A extensão percorre os atendimentos realizados e abre temporariamente cada cadastro na mesma aba visível do PEC.
4. Confira CPF, CNS, residência, procedimento, CID e duplicidades na tela de revisão.
5. Antes de exportar, use **Excluir selecionados** para retirar atendimentos que não devem ir para o BPA. Eles ficam no lote e podem ser recuperados pelo filtro **Excluídos** e pelo botão **Reincluir selecionados**.
6. Quando a mesma pessoa tiver mais de um procedimento, selecione o atendimento e use **Duplicar atendimento**. Edite o procedimento/CID da cópia; o profissional, a data e o cadastro são preservados.
7. Salve o rascunho ou exporte JSON/CSV.

## Enviar a revisão para o BPA-I

Depois de revisar tudo, clique em **Exportar fila para o BPA**. O JSON contém os dados cadastrais, a regra CPF/CNS, a origem do cadastro e uma prévia das `bpaSheets`: folhas por profissional, com até 99 pacientes. Datas e procedimentos diferentes podem ficar na mesma folha. Para Bruna, uma nova folha é criada quando a mesma pessoa já aparece na folha atual. O importador faz o planejamento definitivo depois de conferir o que já existe no BPA da PRLB.

A **Prévia das folhas BPA** usa a mesma organização da exportação. Ela não grava nada no BPA; serve para conferir folhas, pacientes, procedimentos, CID e pendências antes do envio.

Na pasta `importadores` há o programa `Abrir_BPA_Revisao_Importador.cmd`. Consulte `../importadores/README.md` para preparar as dependências e conferir a conexão. Ele abre uma tela para:

1. escolher o JSON exportado;
2. informar/confirmar a competência;
3. escolher a matrícula/cadastro profissional já existente no BPA; o programa lê `CADMED` e o vínculo CNS + CBO + CNES do próprio banco;
4. preencher serviço e classificação quando eles não estiverem nas regras do lote;
5. validar os campos obrigatórios e gerar uma prévia SQL;
6. somente depois, com o BPA fechado, criar backup e gravar no banco Firebird.
7. após a gravação ou antes de exportar a remessa, usar **Conferir lote no BPA** para comparar a revisão com o banco e identificar pacientes ausentes ou repetidos. A conferência apenas lê o BPA.

O importador não grava uma revisão incompleta. O botão de gravação só fica disponível quando todos os pacientes têm CPF ou CNS válido, data de nascimento, sexo, CEP, bairro, logradouro, procedimento e CID quando a regra exigir. A regra usada é: CPF com 11 dígitos = `PRD_SEM_CPF = N`; somente CNS com 15 dígitos = `PRD_SEM_CPF = S`.

O destino é sempre o BPA da PRLB. Antes de liberar a gravação, o importador confere a competência SIGTAP instalada, preserva as configurações dos profissionais, aproveita as folhas existentes até 99 registros e mostra quantos registros já existem e quantos serão acrescentados. Quando o PEC não informa a situação de rua, o padrão utilizado é `N`; um `S` encontrado no cadastro é preservado.

O programa reaproveita `bpa_automatizador_config.json`. CNS e CBO dos profissionais já configurados são preenchidos automaticamente. Serviço e classificação são mantidos por profissional: Monica está com `135/003`; Daniella e Samir, com `121/002`; Bruna, com `112/008`. As configurações já salvas são preservadas mesmo quando o profissional não aparece no lote atual.

O automatizador antigo de correções continua separado: ele corrige marcação CPF/CNS e bairro de registros que já estão no BPA. O novo importador é a etapa que leva a revisão PEC para novas linhas do BPA.

## Regras iniciais

- Daniella Murteira Salles: `0205010032` — ecocardiografia transtorácica, CID dispensado.
- Cristiane de Oliveira Nascimento: fisioterapia `0302050027`, CID obrigatório; CBO `223605`, serviço/classificação `135/003`.
- Samir: procedimento manual, CID dispensado. A observação da Agenda fica disponível apenas para conferência; ela não define o código automaticamente.
- Bruna Medina: começa com o padrão `0301010366` quando aplicável, CID dispensado. Casos de Implanon ou DIU devem ser ajustados manualmente na revisão:
  - Inserção de Implanon → `0301040176`;
  - Retirada de Implanon → `0301040184`;
  - Retirada de DIU → `0301040150`;
  - Inserção de DIU → `0301040141`.
- A observação registrada no PEC é apenas informativa e aparece na revisão/CSV; não é usada para escolher procedimento.
- Monica Pedrosa e demais fisioterapeutas: sempre `0302050027`, CID obrigatório e manual.
- Vínculos profissionais já configurados no importador: fisioterapia/Monica CBO `223605`; Bruna Medina CBO `225250`; Samir Abreu CBO `225320`; Daniella CBO `225120`.
- Somente fisioterapia exige CID; para os demais profissionais o CID é opcional.
- Daniella pode ser duplicada para registrar atendimento normal e ecografia, alterando o procedimento da cópia.
- Samir pode ser duplicado quando a mesma pessoa tiver mais de um procedimento; cada cópia mantém o profissional Samir.
- Bruna usa `0301010366`; a mesma pessoa não fica duas vezes na mesma folha. A repetição em outra data é enviada para outra folha automaticamente. A capacidade normal de cada folha é de 99 pacientes.
- Duplicado: mesma pessoa, data, profissional e procedimento. O registro duplicado não é enviado na exportação, mas fica visível para conferência.
- Lotes com vários profissionais são agrupados automaticamente na exportação.
- A mesma pessoa em outra data é preservada para ser colocada em outra folha quando necessário.

## Profissional novo

Qualquer profissional selecionado no navegador e encontrado na Lista de atendimentos ou na Agenda aparece automaticamente na revisão. Em **Adicionar/configurar profissional novo**, é possível salvar o procedimento padrão e informar se o CID é obrigatório. O vínculo CNS/CBO/serviço/classificação é associado no importador do BPA pelo botão **Adicionar profissional** e fica salvo para os próximos lotes.

