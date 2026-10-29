# 08 · Roteiro e checklist

## Estado em 28/10/2026

Desenvolvimento local autorizado em 28/10/2026. Decisões 058 a 063 registradas no documento 12. BRO-001 a BRO-013 têm implementação local. As suítes e seus limites estão em `../evidence/broto-local/README.md`, incluindo VMs Windows e Linux, monitores nativos macOS e Windows, serviços reais nos três sistemas e Claude Code comandando o Broto Windows. Provas entre computadores físicos, console antigo do runner Windows, assinatura de distribuição e publicação continuam pendentes.

O andamento do Broto se acompanha pelo checklist abaixo. Ele vai sendo marcado conforme o trabalho anda, na ordem das fases, e cada marca leva a sua evidência ao lado.

## Como marcar

| Regra | Como aplicar |
| --- | --- |
| Marca só com evidência | `[x]` exige a execução correspondente, como pede o AGENTS.md; código escrito sem a suíte rodada continua `[ ]` |
| Evidência ao lado | Ao marcar, escreva na mesma linha a data e a prova: o commit, o comando da suíte que passou ou a pasta em `docs/evidence/bro-NNN/` |
| Prova real é separada | A marca de prova real só vale com dois computadores reais, ou com o runner indicado; suíte local não substitui |
| Estado dos documentos | Com código e suíte marcados e a prova real pendente, a peça vira `Preparado` no quadro do documento que a descreve; com tudo marcado, `Implementado` |
| Documentação junto | Cada tarefa só fecha com a marca de documentação, que atualiza o documento desta pasta com o que foi feito de verdade |

Exemplo de linha marcada:

```
- [x] Testes na suíte de packages/tunnel-core. DD/MM/AAAA, go test ./internal/identity/... verde no commit <hash>
```

## Fase 0, desenho e decisões

- [x] Desenho escrito em `docs/broto/`, do README ao documento 08. Feito em 27/10/2026; regra de texto conferida em 28/10/2026
- [x] Fluxo fechado com o usuário: código aleatório em Conectar novo Broto, lista Brotos ligando, monitor com Pausar e Desconectar, um hospedeiro por Broto e vários Brotos por hospedeiro. Feito em 28/10/2026
- [x] Comportamento de Pausar e Desconectar confirmado pelo usuário: Pausar é temporário e mantém o vínculo; Desconectar desfaz o vínculo e exige código novo. 28/10/2026, pedido de execução local deste plano e decisão 063
- [x] Desenvolvimento do Broto aprovado pelo usuário. 28/10/2026, pedido de execução local deste plano e decisão 063
- [x] Frente `BRO` aberta na tabela de estado do documento 11, com uma linha que aponta para este checklist; as tarefas continuam aqui, para não duplicar. 28/10/2026, pedido de execução local deste plano e decisão 063

Pelo critério da decisão 053, a frente só entra no documento 11 depois da aprovação do desenvolvimento.

### Decisões a registrar no documento 12

As decisões do Broto ocupam as entradas 058 a 063 do documento 12. Cada decisão do Broto entra no formato de lá: título, Data, Contexto, Decisão, Alternativa rejeitada e Consequência, mais uma linha na tabela de estado do topo. Marque quando a entrada estiver escrita no documento 12.

- [x] 058 Cialai Broto como terceira persona. Um programa separado, gratuito e aberto, que aponta para um hospedeiro só e executa ordens dele; um hospedeiro tem quantos Brotos quiser; não é o Multi-Device Sessions do Pro. 28/10/2026, entrada correspondente no documento 12
- [x] 059 Papel de identidade `broto` no núcleo do túnel. Um terceiro papel ao lado de `desktop` e `phone`, com prefixo de id próprio e payload de pareamento próprio, `CIALAIB2.`, que separa as rotas no hospedeiro. 28/10/2026, entrada correspondente no documento 12
- [x] 060 O hospedeiro não recebe ordem de um Broto. O token de Broto entra só na rota de RPC reversa, nunca na rota que comanda o hospedeiro. 28/10/2026, entrada correspondente no documento 12
- [x] 061 Windows do Broto sem Authenticode, com reforço de cadeia. Sai sem assinatura Authenticode como o desktop, compensado com somas assinadas, atestado e SBOM. 28/10/2026, entrada correspondente no documento 12
- [x] 062 Todo celular pareado comanda os Brotos. Um celular vinculado ao hospedeiro enxerga e comanda os Brotos com as mesmas regras de uma pessoa no hospedeiro. 28/10/2026, entrada correspondente no documento 12
- [x] 063 Pareamento pela lista Brotos ligando e janela só de acompanhar. Conectar novo Broto gera um código aleatório de uso único; o Broto liga, espera na lista e só entra com aprovação; depois, a janela do Broto é só o monitor, com Pausar e Desconectar. 28/10/2026, entrada correspondente no documento 12

As decisões de produto do usuário são a base das entradas 058, 061, 062 e 063. Em 27/10/2026: o nome Cialai Broto, o modelo gratuito e aberto, o Windows sem assinatura e o celular comandando todos os Brotos. Em 28/10/2026: o código aleatório gerado em Conectar novo Broto, a lista Brotos ligando com Aprovar e Recusar, a janela do Broto só com o monitor, Pausar e Desconectar, e a regra de um hospedeiro por Broto e vários Brotos por hospedeiro.

## Fase 1, identidade e rotas

É o risco central do documento 04, então vem primeiro: tudo se apoia nesta separação.

### BRO-001 Papel `broto` em `internal/identity` e campo `kind` no registro

Tamanho M. Depende da frente CON. Descrito no documento 02.

- [x] Código do papel `broto`, do prefixo `bro_` e do campo `kind`, com registros antigos lidos como `phone`. 28/10/2026, suíte Go e testes de migração e rotação em `internal/pairing/broto_test.go`
- [x] Testes na suíte de `packages/tunnel-core`. 28/10/2026, `go test ./...` verde
- [x] Documento 02 atualizado. 28/10/2026, estado preparado e limite da rota registrados

### BRO-002 Separação de rotas por papel na borda

Tamanho M. Depende de BRO-001. Descrito nos documentos 02 e 04.

- [x] Código da conferência de papel por rota em `internal/edge/edge.go`. 28/10/2026, `go test ./internal/edge` verde
- [x] Testes na suíte: token de Broto recusado na rota `/pty` e token de celular recusado na rota do Broto. 28/10/2026, `TestBrotoCannotReachHostRoutes` e `TestPhoneCannotReachBrotoRoute` verdes
- [x] Documentos 02 e 04 atualizados. 28/10/2026, estado preparado registrado

### Aceite da fase 1

- [x] Um token de Broto é recusado na rota do hospedeiro e um token de celular na rota do Broto, provado em suíte. 28/10/2026, `go test ./...` verde em `packages/tunnel-core`

## Fase 2, pareamento e discagem

### BRO-003 Código aleatório de uso único e pedido guardado na lista Brotos ligando

Tamanho M. Depende de BRO-001. Descrito no documento 02.

- [x] Código do código de uso único de 10 minutos, preso ao primeiro aparelho, e do pedido guardado até Aprovar ou Recusar. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte: código vencido, já usado ou apresentado por um segundo aparelho é recusado; sem Aprovar, nada entra. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real entre dois computadores, com evidência em `docs/evidence/bro-003/`
- [x] Documento 02 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### BRO-004 Binário `cmd/cialai-broto` que disca e sobe a conexão

Tamanho G. Depende de BRO-003. Descrito nos documentos 02 e 07.

- [x] Código do binário com o gerenciador de caminho e o Tor próprio. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte, no molde de `integration/netlab/phone.go`. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real pela rede local, pela direta e pela reserva do Tor, com evidência em `docs/evidence/bro-004/`
- [x] Documentos 02 e 07 atualizados. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### Aceite da fase 2

- [ ] Nenhum Broto entra sem Aprovar na lista Brotos ligando, provado em suíte e entre dois computadores reais
- [ ] O Broto pareia e sobe a conexão entre dois computadores reais, pela rede local, pela direta e pela reserva do Tor

## Fase 3, RPC reversa e execução

O menor caminho até rodar um comando na outra máquina.

### BRO-005 Stream de RPC reversa entre hospedeiro e Broto

Tamanho G. Depende de BRO-004. Descrito no documento 03.

- [x] Código do stream longo aberto pelo Broto, no QUIC direto e na reserva pelo Tor. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte nos dois transportes. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real nos dois transportes, com evidência em `docs/evidence/bro-005/`
- [x] Documento 03 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### BRO-006 Verbo `exec` com stdout, stderr e código de saída

Tamanho M. Depende de BRO-005. Descrito no documento 03.

- [x] Código do verbo `exec`. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte com stdout, stderr, código de saída e prazo vencido. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real: comando rodado num computador e resposta lida no outro, com evidência em `docs/evidence/bro-006/`
- [x] Documento 03 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### Aceite da fase 3

- [ ] Um `exec` roda num computador e devolve a saída e o código de saída noutro

## Fase 4, terminal

### BRO-007 Camada de PTY em Go, com a correção do ConPTY no Windows

Tamanho G. Depende de BRO-005. Descrito no documento 03.

- [x] Código da camada de PTY no macOS, no Linux e no Windows. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte, com a resposta ao `ESC[6n` e a drenagem até o fim no Windows. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova no runner `windows-2022`, que tem o console antigo, com evidência em `docs/evidence/bro-007/`
- [x] Documento 03 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### BRO-008 Sessões do Broto no `pty_list` do hospedeiro, com id local e origem

Tamanho M. Depende de BRO-007. Descrito nos documentos 03 e 05.

- [x] Código do id local, da origem e do roteamento por id no hospedeiro. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte, com dois Brotos sem colisão de id. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real: sessão do Broto vista e digitada no desktop e no celular, com evidência em `docs/evidence/bro-008/`
- [x] Documentos 03 e 05 atualizados. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### Aceite da fase 4

- [ ] Uma sessão de PTY do Broto aparece no desktop e no celular e aceita digitação, com a correção do ConPTY provada no runner `windows-2022`

## Fase 5, permissão, interface, janela e IA

Para a pessoa e a IA usarem com segurança.

### BRO-009 Três camadas de permissão e registro de auditoria

Tamanho M. Depende de BRO-002. Descrito no documento 04.

- [x] Código dos três níveis no hospedeiro, do teto local no Broto e do registro nos dois lados. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte: só leitura recusa, pedir confirmação espera, teto local vence o hospedeiro. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real: pedir confirmação segurando um comando até o sim no hospedeiro, com evidência em `docs/evidence/bro-009/`
- [x] Documento 04 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### BRO-010 Seção Brotos em Dispositivos, Conectar novo Broto e lista Brotos ligando

Tamanho M. Depende de BRO-003. Descrito no documento 05.

- [x] Código em `Devices.jsx` e no fluxo de Conectar novo Broto. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte e `npm run check:text` verde, com as chaves `desktop.brotos.*` nos três idiomas. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Conferido no app, com captura em `docs/evidence/bro-010/`
- [x] Documento 05 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### BRO-013 Janela do Broto com Conectar, espera da aprovação e monitor

Tamanho M. Depende de BRO-003 e BRO-009. Descrito nos documentos 05 e 07.

- [x] Código da janela, com Conectar, Aguardando e o monitor com Pausar e Desconectar. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte e `npm run check:text` verde, com as chaves `broto.*` nos três idiomas. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Prova real: pausar e desconectar na máquina do Broto e ver a mudança no hospedeiro, com evidência em `docs/evidence/bro-013/`
- [x] Documentos 05 e 07 atualizados. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### BRO-011 Adaptador MCP local com as ferramentas do Broto

Tamanho M. Depende de BRO-006 e BRO-008. Descrito no documento 06.

- [x] Código do adaptador MCP e das ferramentas. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes na suíte: Broto em só leitura recusa `rodar`, e Broto pausado recusa tudo que muda algo. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Prova real com o Claude Code rodando um comando num Broto. 28/10/2026, Claude Code 2.1.312, MCP stdio real e Broto em VM Windows; escopo e limites em `../evidence/broto-local/README.md`
- [x] Documento 06 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### Aceite da fase 5

- [ ] Um `exec` respeita o nível do Broto: só leitura recusa, pedir confirmação espera o sim e livre roda
- [ ] A pessoa na máquina do Broto conecta pela janela, acompanha a atividade, pausa e desconecta, e o hospedeiro mostra cada mudança
- [x] O Claude Code roda um comando num Broto pelo MCP, e um Broto em pedir confirmação faz o comando esperar o sim no hospedeiro. 28/10/2026, comando executado na VM Windows com aprovação observada no hub real do hospedeiro macOS; evidência em `../evidence/broto-local/README.md`

## Fase 6, distribuição

### BRO-012 Empacotamento, serviço, release e download no site

Tamanho G. Depende de BRO-006. Descrito no documento 07.

- [x] Código do serviço do sistema nos três sistemas e do workflow `release-broto.yml`. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [x] Testes do instalador, com a conferência da soma assinada e do `codesign`. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`
- [ ] Release executada pela tag `broto-v*`, com a marca de latest desligada, soma assinada, atestado e SBOM, com evidência em `docs/evidence/bro-012/`
- [ ] Atualizador do desktop conferido depois da release do Broto, sem regressão
- [ ] Seção Broto publicada na página de downloads nos três idiomas
- [x] Documento 07 atualizado. 28/10/2026, implementação local e testes descritos em `../evidence/broto-local/README.md`

### Antes de publicar, os textos que ainda não falam do Broto

- [x] Política de privacidade em `docs/legal/privacy-policy-pt-BR.md`, `docs/legal/privacy-policy-en.md` e nas páginas do site nos três idiomas. 28/10/2026, texto preparado localmente; publicação pendente
- [x] Termos de uso na página do site nos três idiomas. 28/10/2026, texto preparado localmente; publicação pendente
- [x] `SECURITY.md` com o modelo de ameaças do Broto. 28/10/2026, texto preparado localmente; publicação pendente
- [x] `NOTICE` com o Tor empacotado no Broto. 28/10/2026, texto preparado localmente; publicação pendente
- [x] `llms.txt` do site nos três idiomas. 28/10/2026, texto preparado localmente; publicação pendente
- [x] `docs/produto/01-visao-e-escopo.md` citando a terceira persona. 28/10/2026, texto preparado localmente; publicação pendente


### Aceite da fase 6

- [ ] O binário sai por tag própria sem quebrar o atualizador do desktop, com soma assinada, atestado e SBOM, e aparece na página de downloads nos três idiomas

## Fase 7, a IA do hospedeiro no comando

Desenho e checklist em [09 · A IA do hospedeiro no comando dos Brotos](./09-ia-no-comando.md), tarefas BRO-014 a BRO-022. As marcas dessa fase ficam lá, para não duplicar.

## Continuação com a IA do hospedeiro

- [ ] BRO-014 a BRO-022 em [A IA no comando](./09-ia-no-comando.md). CLI, fluxo, aprovação global, arquivos e skill em implementação local; aceite com dois Brotos exige as provas próprias daquela fase.
