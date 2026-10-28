# Revisão PEC → BPA-I / GIL — Raul

Dois programas locais para receber os JSONs exportados pelas extensões deste repositório, completar a conferência e gravar os atendimentos. A aplicação não consulta o PEC: CPF, CNS e os demais dados chegam no arquivo revisado da extensão, a partir da sessão autorizada no PEC.

## Começar

1. Use Python 3.11 ou posterior, de **64 bits**, no Windows.
2. Execute `Preparar_Importadores.cmd` uma vez. Ele baixa o cliente oficial Firebird 2.5.9, verifica seu SHA-256 e instala FDB 2.0.4 somente na pasta `.runtime`. Não instala nem altera o servidor Firebird.
3. Abra `Abrir_BPA_Revisao_Importador.cmd` ou `Abrir_GIL_Revisao_Raul.cmd`.
4. A interface abre no navegador em um endereço `http://127.0.0.1:porta/`. Esse é o próprio computador. Nenhum dado de pacientes é enviado a um site externo pela aplicação.
5. Abra o JSON da extensão. Você pode colar seu caminho completo ou usar **Escolher arquivo**.
6. Expanda **Conexão e configurações do lote**, confira o destino e informe a senha. O GIL tenta ler seu destino do `Gil.ini` instalado nas pastas padrão do Datasus. Confira esse destino antes de usar.
7. Faça a associação dos profissionais no BPA, gere a prévia, corrija todas as pendências, simule e confira os resultados. Feche o BPA/GIL antes de confirmar **Gravar lote**.
8. Ao terminar, use **Encerrar** para desligar a sessão local.

Se o pacote fornecido já contém `.runtime`, a preparação pode ser dispensada. Ele ainda precisa de Python de 64 bits. O código do GitHub não inclui as dependências binárias.

## Conexão

O campo Banco usa `servidor:caminho`, por exemplo `localhost:C:\PastaDeTeste\bpa_test.fdb`. Para um banco remoto, o caminho é o caminho no servidor, não no computador do usuário.

- `fbclient.dll`: cliente Firebird de 64 bits; o pacote usa a biblioteca oficial 2.5.9, cuja conexão e transações foram verificadas com os bancos Firebird 1.5 usados na reconstrução.
- `gbak.exe`: use o utilitário compatível com a versão do **servidor**. Não substitua automaticamente o GBAK 1.5 instalado pelo GBAK 2.5 do download.
- A senha fica somente na sessão de uso; não é salva nas configurações, no código ou nos recibos. O nome do usuário e o destino podem ser salvos em `localdata`.
- A conta precisa conseguir ler os cadastros e tabelas de referência e, na gravação, alterar as tabelas do destino. Credenciais devem ser fornecidas pelo responsável pelo banco.

O diretório `localdata` e todas as dependências ficam fora do Git. Para usar em outro computador, copie o código e prepare as dependências nesse computador; não publique configurações operacionais.

## BPA-I

O arquivo deve ter `exportType: PEC_BPA_FILA_PARA_PREENCHIMENTO` e a lista `records` da extensão.

- Selecione **Ler vínculos do banco** e associe cada nome do PEC ao CNS + CBO + CNES cadastrado em `CADMED` / `CADMED_CBO_CNES`. O destino inicial é o CNES `0012734` da PRLB; a interface permite conferir ou alterar esse campo.
- Informe serviço e classificação, ambos com três dígitos, e CID obrigatório quando aplicável. Fisioterapia `0302050027` sempre exige CID.
- O programa confere competência do BPA, existência da tabela SIGTAP para o período, procedimento, relações de CBO/CID/serviço disponíveis, documento, nascimento, sexo, CEP/município e tipo de logradouro.
- CPF válido tem prioridade. Sem CPF, é necessário CNS válido; a marcação `PRD_SEM_CPF` é derivada dessa identificação. Um CPF presente e inválido precisa ser corrigido.
- As folhas são organizadas por CNES, competência, CNS profissional e CBO, com até 99 sequências. Datas e procedimentos podem compartilhar uma folha. Para Bruna Medina, a mesma pessoa fica em outra folha quando já aparece na atual.
- Reimportar o mesmo paciente, data, profissional e procedimento preserva o atendimento existente. Duplicidades no arquivo ou já presentes no destino ficam pendentes.
- Nome, logradouro, bairro e outros textos respeitam os tamanhos do BPA. Por padrão, o programa limita os textos e sinaliza isso na prévia. A opção de bloqueio exige correção manual em vez da abreviação.

As validações implementadas não substituem toda a crítica do BPA/SIGTAP: exigências como habilitação, financiamento e limites específicos de produção precisam ser conferidas no próprio sistema. A natureza/procedimento/CID permanecem sob revisão do usuário.

## GIL — Raul

O arquivo deve ter `destination: GIL_RAUL`, `schemaVersion: 1` e os registros selecionados da extensão. Unidade e matrícula devem coincidir com o arquivo e identificar um vínculo ativo e único do Raul.

- Fluxo fixo: procedimento `0301010072`, CID `Z000`, natureza `3`, turno `4` e horário de referência `12:00`. Confira a especialidade, inicialmente `225170`.
- A identificação procura CPF, depois CNS e, quando necessário, nome exato e nascimento. Um cadastro encontrado precisa conferir nome, nascimento, sexo e prontuário da unidade. Ambiguidade ou divergência bloqueia o lote.
- Sem cadastro compatível, o registro fica pendente. Somente a opção explícita **Permitir prontuário 9** libera a ficha temporária, preservando nascimento e sexo; nenhum cadastro é criado em `USUARIO` ou `VL_EASUSU`.
- Atendimentos já existentes do profissional, data, paciente e procedimento são preservados, inclusive quando estiverem em lote fechado.
- Lotes abertos do turno 4 podem ser aproveitados, com até 999 sequências; datas distintas usam lotes distintos. A aplicação mantém capa, quantidade, última sequência e `CTRLNSUP` na mesma transação.

## Simulação, gravação e conferência

A prévia consulta o banco em uma transação de leitura. A simulação usa uma transação de escrita com reserva das tabelas relevantes, executa os comandos, confere os campos de todas as linhas novas e executa **rollback**.

A gravação exige simulação válida e confirmação. Primeiro gera um backup lógico pelo GBAK. Depois reserva as tabelas, refaz o plano e compara sua assinatura à prévia: se os dados ou o destino mudarem, solicita nova revisão. As operações e a conferência interna ficam na mesma transação. Qualquer erro antes do commit desfaz o lote inteiro.

Depois do commit, há nova leitura para conferir os registros. O recibo guarda quantidade, assinatura do plano, horário e caminho do backup, sem nomes, CPFs ou dados clínicos. Se houver falha após o commit, a mensagem deixa explícito que a gravação já ocorreu: use **Conferir no banco** antes de repetir. O JSON é preservado nessa situação.

Backups contêm os dados do banco. Guarde-os em pasta com acesso e retenção definidos pela instituição. A aplicação não restaura backups automaticamente.

## Limpeza dos arquivos

Quando o JSON é aberto por seu caminho completo e a opção de exclusão está marcada, ele só é apagado após gravação **e conferência final bem-sucedidas**. Se o arquivo tiver mudado no disco desde a abertura, ele é preservado. Simulação, erro ou pendência nunca apagam a entrada.

Ao usar **Escolher arquivo**, o navegador não informa ao programa seu caminho original; nesse caso, exclua o arquivo manualmente após conferir. Rascunhos baixados anteriormente, CSVs e o lote salvo no armazenamento da extensão do Chrome precisam de limpeza separada. Excluir o JSON baixado não elimina o rascunho da extensão.

## Segurança da interface local

A interface escuta somente em `127.0.0.1`, usa porta aleatória, valida `Host` e `Origin` e exige um token de sessão para as APIs. A página não carrega scripts externos; respostas usam `no-store` e política de conteúdo restrita. Não há API pública nem conexão com IA em tempo de execução.

O uso em uma instituição depende das permissões do usuário e das regras de TI para consulta ao PEC, exportação e escrita nos destinos. Publicar o código não publica nem autoriza acesso aos bancos.

## Testes

```text
python -m unittest discover -s importadores/tests -v
```

Sem variáveis de ambiente, os testes de validação e da interface HTTP são executados e os testes com banco são pulados.

Para a integração, prepare bancos **vazios** com a estrutura de cada sistema, em `localhost`, com nomes terminando em `_test.fdb`. Eles precisam estar dentro de uma pasta dedicada indicada em `TEST_DATA_DIR`. As fixtures de `tests/fixtures.py` contêm somente dados fictícios; aplique `seed(db, modo)` uma vez nesses bancos antes de executar os testes.

Configure `TEST_BPA_DSN`, `TEST_BPA_USER`, `TEST_BPA_PASSWORD`, `TEST_GIL_DSN`, `TEST_GIL_USER`, `TEST_GIL_PASSWORD`, `TEST_DATA_DIR`, `FBCLIENT` e `TEST_GBAK`. Os testes de integração apagam os atendimentos desses bancos de teste entre os casos; a validação dos caminhos bloqueia destinos fora da pasta dedicada e servidores diferentes de localhost.

Na reconstrução, 22 testes Python passaram, incluindo gravação real de fixtures em cópias de estrutura Firebird 1.5, backup, rollback, falha no meio da transação, idempotência, atualização de lotes, campos obrigatórios, limite de folhas, proteção HTTP e limpeza condicional do JSON. As telas BPA e GIL também foram verificadas com prévia e simulação de dados fictícios.

## Dependências

- [FDB, projeto oficial](https://github.com/FirebirdSQL/fdb), versão 2.0.4.
- [Cliente oficial Firebird 2.5.9](https://firebirdsql.org/en/firebird-2-5/), distribuição x64. As licenças do fornecedor acompanham o download. Apenas a biblioteca cliente é utilizada; o servidor instalado permanece o mesmo.

Os atalhos usam a interface local no navegador; não é necessário instalar Tcl/Tk ou extensões adicionais para usar o importador.
