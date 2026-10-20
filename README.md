# Extensões PEC

Código-fonte das extensões locais para coletar e revisar atendimentos no PEC.

- [`pec_bpa_extension`](pec_bpa_extension/README.md): PEC para BPA-I, versão 0.10.19.
- [`pec_gil_extension`](pec_gil_extension/LEIA-ME.md): PEC para GIL — Raul, versão 0.1.0; fluxo separado do BPA.

## Instalação manual

Baixe o repositório e extraia-o. No Chrome, abra `chrome://extensions`, ative o modo do desenvolvedor, escolha **Carregar sem compactação** e selecione a pasta da extensão desejada. Consulte o documento de cada projeto para o uso.

As permissões de acesso ao site estão limitadas ao endereço do PEC configurado nos manifests. A utilização depende de autorização e de uma sessão válida do usuário nesse PEC.

## Escopo e privacidade

Este repositório contém somente o código das extensões, documentação e testes com dados fictícios. Não contém dados de pacientes, JSONs de produção, relatórios, bancos, backups, credenciais nem os programas locais que gravam no BPA/GIL. As extensões exportam arquivos para revisão; elas não substituem esses importadores.

As configurações clínicas existentes são específicas do fluxo original. Antes de usar em outra unidade ou competência, confira procedimentos, obrigatoriedade de CID, vínculos e regras oficiais. Não considere os padrões do código como validação SIGTAP universal.

Não envie dados pessoais, arquivos exportados, segredos ou bancos a este repositório público.

## Testes

Com Node.js instalado, execute os arquivos `*.test.js` nas pastas `tests` das duas extensões, usando `node --test`.

Nenhum instalador ou pacote é gerado automaticamente.
