# Documentação do Cialai

Estado em 13/09/2026: documentos 01 a 12 revistos como documentação viva. Em 15/09/2026, para a prévia 0.2.0, a conectividade automática substituiu o Headscale no fluxo do produto; a validação em aparelhos reais continua pendente. Desktop macOS, interface, protocolo e túnel têm implementação e verificação local. Aplicativos móveis, updater, CI, distribuição e materiais de loja estão preparados em diferentes níveis, mas aparelhos, sistemas remotos, assinatura, publicação e revisão permanecem pendentes. As Fases 5, 6 e 7 já estão integradas na main, com Linux verificado em contêiner e Windows apenas em compilação cruzada.

Cialai é o estúdio de terminais do Ordinum Control transformado em produto open source: desktop para macOS, Linux e Windows, apps para iOS e Android que acompanham e controlam os terminais do computador, pareamento por QR code e conexão automática entre os aparelhos, direta sempre que a rede permite e pelo Tor embutido como ponto de encontro e reserva, sem servidor da pessoa, da Ordinum ou do projeto.

## Estrutura

Os números dos documentos são identificadores estáveis, como os das tarefas: continuam os mesmos quando um documento muda de pasta. A ordem de leitura segue os números.

| Pasta | Conteúdo |
| --- | --- |
| `produto/` | Visão, protótipo de origem, marca, roadmap e decisões |
| `arquitetura/` | Desenho do sistema, desktop, mobile, rede, protocolo e diferenças entre sistemas |
| `engenharia/` | Monorepo, CI e distribuição, progresso, credenciais e release da versão 1 |
| `testes/` | Roteiros de validação em aparelhos, redes e máquinas reais |
| `releases/` | Uma página por versão publicada, com ficha, mudanças e como atualizar |
| `stores/` | Textos e metadados das lojas |
| `review/` | Material para a revisão das lojas |
| `legal/` | Política de privacidade e termos de uso |
| `evidence/` | Capturas e registros que comprovam cada entrega |

## Produto

| Nº | Documento | Responde |
| --- | --- | --- |
| 01 | [Visão e escopo](./produto/01-visao-e-escopo.md) | O que o produto é, para quem, o que entra e o que fica de fora, decisões confirmadas |
| 02 | [Análise do protótipo](./produto/02-analise-do-prototipo.md) | O que existe no Ordinum Control, onde vive, como se comporta, o que precisa ser preservado |
| 08 | [Design e marca](./produto/08-design-e-marca.md) | Identidade Cialai aplicada, tokens mantidos, paleta das sessões e tema do terminal |
| 11 | [Roadmap de execução](./produto/11-roadmap-de-execucao.md) | Fases, tarefas numeradas, critérios de aceite, dependências e riscos |
| 12 | [Decisões](./produto/12-decisoes.md) | Registro das decisões, com contexto, alternativas e consequências |

## Arquitetura

| Nº | Documento | Responde |
| --- | --- | --- |
| 03 | [Arquitetura](./arquitetura/03-arquitetura.md) | O desenho alvo, os componentes, as portas, os fluxos e as alternativas descartadas |
| 04 | [Desktop](./arquitetura/04-desktop.md) | O app desktop: reaproveitamento arquivo a arquivo, matriz por sistema, janela, atalhos, onboarding |
| 05 | [Mobile](./arquitetura/05-mobile.md) | Os apps iOS e Android: casca Expo preservada, módulo nativo do túnel, leitor de QR, lojas |
| 06 | [Rede e pareamento](./arquitetura/06-rede-e-pareamento.md) | Conectividade automática, núcleo do túnel, borda, proxy, pareamento, ameaças e testes; as seções do Headscale são históricas até CON-070 |
| 07 | [Protocolo da ponte](./arquitetura/07-protocolo-da-ponte.md) | A ponte WebSocket entre a página do celular e o desktop, preservada e estendida |
| 14 | [Diferenças por plataforma](./arquitetura/14-diferencas-por-plataforma.md) | Como preparar e validar o desktop e quais comportamentos mudam entre macOS, Linux e Windows |
| 15 | [Barra de IA](./arquitetura/15-barra-de-ia.md) | O painel com um anel por conta de Claude Code e Codex: de onde vem o uso do plano e a atividade das sessões, o contrato com a interface e o que muda por sistema |
| 16 | [Grafo da documentação](./arquitetura/16-grafo-da-documentacao.md) | A aba que mostra os Markdown do projeto num grafo de forças: varredura, poda, layout, interação, atualização e limites |

## Engenharia

| Nº | Documento | Responde |
| --- | --- | --- |
| 09 | [Monorepo e ferramentas](./engenharia/09-monorepo-e-ferramentas.md) | Estrutura de pastas, toolchains, scripts, testes por pacote e convenções |
| 10 | [CI/CD e distribuição](./engenharia/10-ci-cd-e-distribuicao.md) | GitHub Actions, Codemagic, identificadores, credenciais por referência, lojas e releases |
| v1 | [Procedimento da versão 1](./engenharia/release-v1.md) | Portões e passos para publicar a primeira versão estável |

Fora da numeração, [Releases publicadas](./releases/README.md) traz uma página por versão, com a ficha da entrega, o que mudou, quais arquivos foram publicados e como atualizar.

Cada documento de 01 a 12 começa com um quadro datado. Os estados usados são `Implementado`, `Preparado` e `Pendente`. O roteiro não considera workflow escrito como workflow executado, binding gerado como aplicativo nativo compilado, nem material de loja como submissão.

## Convenções destes documentos

| Convenção | Valor |
| --- | --- |
| `$CONTROL` | Ordinum Control, o protótipo interno de onde o estúdio foi extraído; não é publicado |
| `$CIALAI` | Raiz deste repositório |
| `$ADVORIS` | App interno da Ordinum usado como referência de publicação nas lojas; não é publicado |
| `$MARCA` | Pasta `brand` deste repositório, com a identidade visual |
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
| Borda | O servidor HTTP do sidecar Go que atende os fluxos dos transportes direto e Tor, serve a página do celular e encaminha a ponte |
| Proxy | O listener em loopback dentro do app do celular, que o WebView usa para chegar à borda |
| Sidecar | O binário Go `cialai-tunnel`, empacotado com o desktop, que sobe a identidade, o ouvinte direto, o `tor` empacotado, o anúncio DNS-SD e a borda |
| Núcleo do túnel | O pacote Go `packages/tunnel-core`, compilado como sidecar no desktop e como biblioteca nos celulares |
| Conexão direta | Sessão QUIC sobre UDP com TLS 1.3 mútuo entre celular e computador, pela rede local, por IPv6, por porta mapeada ou por endereço refletido por STUN; badge Direta |
| Reserva | A mesma sessão com TLS 1.3 mútuo levada pela rede Tor até o serviço onion de salto único do computador; badge Reserva |
| Candidato | Endereço direto do computador levado no QR e no cartão de alcance |
| Furo de NAT | Abertura do caminho direto coordenada pelo canal de controle quando nenhum lado aceita entrada |
| Tailnet | Histórico: a rede privada dos nós registrados no mesmo Headscale, usada até as prévias 0.1.x |
| Headscale | Histórico: servidor de coordenação compatível com os clientes Tailscale, usado até as prévias 0.1.x; o código do modo segue inerte até CON-070 |
| DERP | Histórico: relé cifrado do Headscale, substituído pela reserva pelo Tor |
| tsnet | Histórico: pacote Go que embutia um nó Tailscale; substituído pelo transporte próprio |
| gomobile | Ferramenta que compila um pacote Go como `.xcframework` para iOS e `.aar` para Android |
| Pareamento | O processo em que o desktop mostra um QR `CIALAI2.`, o celular registra sua chave Ed25519 e recebe um token de dispositivo `cdt1` |
| Perfil | Histórico: no celular das prévias 0.1.x, um par de URL do Headscale e usuário; a conectividade automática guarda os computadores pareados |
| Jornal | Os arquivos `<tag>.log` e `<tag>.json` que guardam o histórico bruto e o plano de retomada de cada sessão |
| Retomada | A reabertura de uma conversa de Claude Code ou Codex depois que o app fechou |
| Concessão de largura | O mecanismo que dá a um dispositivo o controle temporário das dimensões do PTY |
