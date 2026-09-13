# Documentação do Cialai

Estado em 13/09/2026: documentos 01 a 12 revistos como documentação viva. Desktop macOS, interface, protocolo e túnel têm implementação e verificação local. Aplicativos móveis, updater, CI, distribuição e materiais de loja estão preparados em diferentes níveis, mas aparelhos, sistemas remotos, assinatura, publicação e revisão permanecem pendentes. A Fase 5 não está integrada nesta linha. Para retomar o trabalho, leia primeiro [13-progresso-e-handoff.md](./13-progresso-e-handoff.md); ele diferencia entregas locais de evidências externas.

Cialai é o estúdio de terminais do Ordinum Control transformado em produto open source: desktop para macOS, Linux e Windows, apps para iOS e Android que acompanham e controlam os terminais do computador, pareamento por QR code e conexão segura por Headscale.

## Ordem de leitura

| Ordem | Documento | Responde |
| --- | --- | --- |
| 1 | [01-visao-e-escopo.md](./01-visao-e-escopo.md) | O que o produto é, para quem, o que entra e o que fica de fora, decisões confirmadas |
| 2 | [02-analise-do-prototipo.md](./02-analise-do-prototipo.md) | O que existe no Ordinum Control, onde vive, como se comporta, o que precisa ser preservado |
| 3 | [03-arquitetura.md](./03-arquitetura.md) | O desenho alvo, os componentes, as portas, os fluxos e as alternativas descartadas |
| 4 | [04-desktop.md](./04-desktop.md) | O app desktop: reaproveitamento arquivo a arquivo, matriz por sistema, janela, atalhos, onboarding |
| 5 | [05-mobile.md](./05-mobile.md) | Os apps iOS e Android: casca Expo preservada, módulo nativo do túnel, leitor de QR, lojas |
| 6 | [06-rede-headscale-e-pareamento.md](./06-rede-headscale-e-pareamento.md) | Headscale, núcleo do túnel, borda, proxy, pareamento, ameaças, testes e spikes |
| 7 | [07-protocolo-da-ponte.md](./07-protocolo-da-ponte.md) | A ponte WebSocket entre a página do celular e o desktop, preservada e estendida |
| 8 | [08-design-e-marca.md](./08-design-e-marca.md) | Identidade Cialai aplicada, tokens mantidos, paleta das sessões e tema do terminal |
| 9 | [09-monorepo-e-ferramentas.md](./09-monorepo-e-ferramentas.md) | Estrutura de pastas, toolchains, scripts, testes por pacote e convenções |
| 10 | [10-ci-cd-e-distribuicao.md](./10-ci-cd-e-distribuicao.md) | GitHub Actions, Codemagic, identificadores, credenciais por referência, lojas e releases |
| 11 | [11-roadmap-de-execucao.md](./11-roadmap-de-execucao.md) | Fases, tarefas numeradas, critérios de aceite, dependências e riscos |
| 12 | [12-decisoes.md](./12-decisoes.md) | Registro das decisões, com contexto, alternativas e consequências |
| Continuidade | [13-progresso-e-handoff.md](./13-progresso-e-handoff.md) | O que foi executado, evidências, pendências e próxima ação |

Cada documento de 01 a 12 começa com um quadro datado. Os estados usados são `Implementado`, `Preparado` e `Pendente`. O roteiro não considera workflow escrito como workflow executado, binding gerado como aplicativo nativo compilado, nem material de loja como submissão.

## Convenções destes documentos

| Convenção | Valor |
| --- | --- |
| `$CONTROL` | `/Users/focoamorim/Github Projects/OrdinumTeam/ordinum-control`, o protótipo, somente leitura |
| `$CIALAI` | `/Users/focoamorim/Github Projects/OrdinumTeam/cialai-platform`, este repositório |
| `$ADVORIS` | `/Users/focoamorim/Github Projects/OrdinumTeam/advoris-mobile`, referência de publicação nas lojas |
| `$MARCA` | `/Users/focoamorim/Github Projects/OrdinumTeam/ordinum-marketing/projects/CIALAI`, identidade visual |
| Citações de código | Caminho relativo a `$CONTROL` e, quando útil, número de linha, como `macos/src-tauri/src/workspace/terminal.rs:883` |
| Estado do protótipo | Working tree de 12/09/2026, branch `main`, com oito arquivos modificados sem commit listados no documento 02. A extração parte do working tree, não do último commit |
| Idioma | Documentação de planejamento em português. README público, CONTRIBUTING, textos das lojas e mensagens de erro voltadas ao público internacional em inglês na fase de lançamento |
| Texto | Sem parênteses para informação secundária e sem hífen, meia-risca ou travessão como separador. Relações são mostradas por tabela, lista, rótulo e valor ou subtítulo. Código e nomes de arquivo mantêm a grafia original |
| Segredos | Nenhum valor de credencial aparece aqui. Identificadores públicos como Team ID da Apple e bundle id aparecem |

## Glossário

| Termo | Significado neste projeto |
| --- | --- |
| Control | O Ordinum Control, protótipo de onde o Cialai é extraído |
| Estúdio | A seção Terminais do Control: sessões, terminal, editor, explorador, Dev Browser e prévias |
| Sessão | Um shell aberto numa pasta, com card, histórico, métricas e arquivos próprios |
| Ponte | O servidor WebSocket em Rust, em loopback, que expõe os comandos de terminal à página do celular |
| Borda | O listener do sidecar Go na tailnet, que serve a página do celular e encaminha a ponte |
| Proxy | O listener em loopback dentro do app do celular, que o WebView usa para chegar à borda |
| Sidecar | O binário Go `cialai-tunnel`, empacotado com o desktop, que embute o nó Tailscale e fala com o Headscale |
| Núcleo do túnel | O pacote Go `packages/tunnel-core`, compilado como sidecar no desktop e como biblioteca nos celulares |
| Tailnet | A rede privada formada pelos nós registrados no mesmo Headscale |
| Headscale | Servidor de coordenação open source compatível com os clientes Tailscale |
| DERP | Relé cifrado usado quando dois nós não conseguem conexão direta |
| tsnet | Pacote Go que embute um nó Tailscale num programa, em espaço de usuário, sem daemon |
| gomobile | Ferramenta que compila um pacote Go como `.xcframework` para iOS e `.aar` para Android |
| Pareamento | O processo em que o desktop mostra um QR e o celular ganha identidade na tailnet e um token de dispositivo |
| Perfil | No celular, um par de URL do Headscale e usuário, com um nó próprio e seus desktops |
| Jornal | Os arquivos `<tag>.log` e `<tag>.json` que guardam o histórico bruto e o plano de retomada de cada sessão |
| Retomada | A reabertura de uma conversa de Claude Code ou Codex depois que o app fechou |
| Concessão de largura | O mecanismo que dá a um dispositivo o controle temporário das dimensões do PTY |
