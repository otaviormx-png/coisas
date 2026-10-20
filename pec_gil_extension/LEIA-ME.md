# PEC para GIL — Raul

Extensão separada da PEC para BPA-I; armazenamento e mensagens independentes.
Nenhum atendimento é alterado no PEC ou gravado no GIL por esta extensão.

## Instalação

No Chrome, abra `chrome://extensions`, habilite o modo do desenvolvedor,
clique em “Carregar sem compactação” e selecione esta pasta `pec_gil_extension`.
Mantenha a extensão BPA instalada para os demais profissionais.

## Uso

1. Filtre a Lista de atendimentos do PEC pelo Raul e pelo período desejado.
2. Na extensão “PEC para GIL — Raul”, clique em “Coletar do PEC”.
3. Ela percorre as páginas, busca Agenda/cadastros e abre a revisão ao concluir.
4. Selecione os realizados, individualmente ou pela caixa do dia.
5. Excluídos/não compareceu/não realizado ficam cinza e podem ser reincluídos.
6. Exporte os selecionados para um JSON e importe no programa local “Revisão Raul — PEC para GIL”.

Para períodos longos, consulta as agendas dos dias encontrados na lista,
sem varrer dias vazios do mês. Para um único dia, pode usar os filtros.
Para dias que não aparecem na lista, abra a Agenda do Raul naquele dia e colete por ela.
Demanda espontânea depende da Lista de atendimentos; não aparece na Agenda.

Todos começam desmarcados. Z000, 0301010072 e natureza 3 são fixos neste fluxo.
Não exige endereço para exportar a identificação. Exige nascimento exato e sexo.
Cadastros ambíguos ficam pendentes. O GIL será conferido no programa local,
preferindo CPF; prontuário 9 não cria um cadastro permanente.

Esta extensão entrega coleta e seleção. No programa local, após importar e conferir,
use “Lançar selecionados no GIL”. Ele simula, faz backup e pede confirmação antes de gravar.
