# Evidência visual da página do celular no padrão do Ordinum Control

Data: 15/09/2026. Página do celular servida pelo computador, em `apps/desktop/src-tauri/resources/mobile`, aberta em `mobile.html?terminais=demo&motion=0` num Chromium headless de 393 por 852 pelo Playwright 1.63.0, com `window.__CIALAI_SHELL__` definido como o aplicativo faz. A barra nativa no topo de cada captura é um desenho em HTML com as mesmas cores e medidas da casca Expo, porque o WebView mostra só a página. A faixa de conexão da página foi ocultada porque o modo de demonstração não tem ponte. As capturas `antes` usam o build de `6152ef2`; as `depois`, o build desta correção. O tema segue `prefers-color-scheme`.

Nome dos arquivos: `<etapa>-<tela>-<tema>-<largura>.png`.

## O que o aparelho mostrava

As fotos do pacote de defeitos, com fonte serifada, botões soltos e fileira de teclas cortada, vêm do aplicativo desktop 0.2.1 instalado em Aplicativos, que ainda serve a página anterior à correção `6152ef2`: o `mobile.html` empacotado nele não traz `data-platform="macos"`. A página só muda no celular quando o computador roda um build que inclua esta pasta de recursos. As capturas `antes` deste pacote já partem da página corrigida e mostram só a diferença de apresentação em relação ao telefone do Control.

## Referência

O telefone do Ordinum Control, protótipo interno de onde esta página saiu, é a referência. As medidas seguem as capturas do iPhone dele: barra de título de 52 px com ferramentas planas, título de 20 px, busca de 46 px com texto de 17 px, cards com raio de 12 px e nome de 17 px, terminal a 13 px, fileira única de teclas de 44 px com texto de 16 px. O acento continua sendo o rosa do Cialai.

| Tela | Tema | Antes | Depois |
| --- | --- | --- | --- |
| Lista de sessões | Escuro | [abrir](./antes-lista-dark-393.png) | [abrir](./depois-lista-dark-393.png) |
| Lista de sessões | Claro | [abrir](./antes-lista-light-393.png) | [abrir](./depois-lista-light-393.png) |
| Terminal | Escuro | [abrir](./antes-terminal-dark-393.png) | [abrir](./depois-terminal-dark-393.png) |
| Terminal | Claro | [abrir](./antes-terminal-light-393.png) | [abrir](./depois-terminal-light-393.png) |

## O que muda nas capturas `depois`

- Barra de título: Voltar, Arquivos e Encerrar viram ícones planos em cinza, sem fundo nem rótulo, e Nova vira o sinal de mais, como no Control.
- Fileira de teclas: uma linha só, que rola de lado, com teclas de 44 px sem borda, e Enter logo depois de Esc. Antes eram duas linhas com borda interna.
- Cards: raio de 12 px, nome de 17 px e o tom da sessão visível também no celular. Antes o fundo cinza do card cobria a cor escolhida para a sessão.
- Terminal a 13 px, o tamanho que o telefone do Control mostra.
- Título sem anel de foco na abertura da lista, e a busca com o anel no campo arredondado inteiro.

Medidas lidas na página durante as capturas: fonte calculada do corpo `system-ui, -apple-system` nos dois temas, `data-platform` igual a `macos`, largura do documento igual à da janela nas quatro telas e a fileira com Esc, Enter, Tab, Shift Tab, Ctrl C, setas, Ctrl D, Ctrl L e Colar.

## O que não aparece em captura

- A casca Expo ganhou a barra do Control: 44 px, ponto do transporte, nome do computador, transporte como chip discreto e Computadores em texto no acento, sem pílula. Os neutros do app passaram aos do iOS e da página, com fundo preto nas telas nativas escuras e superfície `#1C1C1E`, e a lista de computadores usa a tipografia da tela Conectar do Control.
- O modo de demonstração não tem arquivos, então a tela Arquivos não foi capturada.

## Limites

- O motor foi o Chromium headless. WKWebView e o WebView do Android não foram usados; o aceite no aparelho continua pendente.
- A barra nativa das capturas é um desenho. A casca real só aparece no aparelho, com o build do aplicativo.
