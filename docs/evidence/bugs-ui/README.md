# Evidência visual dos defeitos de interface

Data: 15/09/2026. Branch `bugs/ui-bugs`.

Capturas geradas com Playwright e Chromium headless sobre o build de produção de `apps/desktop`, servido como arquivos estáticos: `dist` para o estúdio e `src-tauri/resources/mobile` para a página do celular. As capturas `antes` usam o build de `973d64e`; as `depois`, o build desta branch. O estúdio abre em `index.html?terminais=demo&motion=0&platform=macos&tunnel=demo#terminais`. A página do celular abre em `mobile.html` com os mesmos parâmetros e toca na sessão `cialai-platform`. O tema segue `prefers-color-scheme`.

Nome dos arquivos: `<etapa>-<tela>-<tema>-<largura>.png`.

| Eixo | Valores |
| --- | --- |
| Etapa | `antes`, `depois` |
| Tela | `estudio`, `celular`, `busca-cmd-f` |
| Tema | `light`, `dark` |
| Largura | `desktop` com 1380 por 880; `400` com 400 por 860 |

## Lupa e copiar do cabeçalho da sessão

Os dois botões ficavam ao lado do botão do Dev Browser, no cabeçalho da sessão, e nenhum chamava comando nativo.

| Botão | Efeito antes da remoção |
| --- | --- |
| Buscar na saída | Abria a barra de busca, mas cada busca lançava `css.toColor: Unsupported css format` e nada era marcado |
| Copiar seleção | Repetia o Cmd C sobre a seleção do xterm; sem seleção só avisava Nada selecionado |

| Captura | Botões do cabeçalho |
| --- | --- |
| [antes-estudio-light-desktop](./antes-estudio-light-desktop.png) | Dev Browser, Buscar na saída, Copiar seleção, Diminuir fonte, Aumentar fonte, Modo foco |
| [depois-estudio-light-desktop](./depois-estudio-light-desktop.png) | Dev Browser, Diminuir fonte, Aumentar fonte, Modo foco |

A busca continua pelo Cmd F. Antes ela abria sem marcar o resultado e com dois erros de página; depois marca `claude` sem erro.

| Tema | Antes | Depois |
| --- | --- | --- |
| Claro | [antes-busca-cmd-f-light-desktop](./antes-busca-cmd-f-light-desktop.png) | [depois-busca-cmd-f-light-desktop](./depois-busca-cmd-f-light-desktop.png) |
| Escuro | [antes-busca-cmd-f-dark-desktop](./antes-busca-cmd-f-dark-desktop.png) | [depois-busca-cmd-f-dark-desktop](./depois-busca-cmd-f-dark-desktop.png) |

## Moldura preta do terminal

O CSS do xterm pinta `.xterm .xterm-viewport` de `#000`. O viewport cobre o respiro do terminal e a sobra abaixo da última linha, então aparecia como moldura grossa com uma faixa embaixo.

| Onde | Causa |
| --- | --- |
| Desktop | A regra que trocava o fundo tinha a mesma especificidade da do xterm, e no build o CSS do xterm chega num chunk carregado depois; o preto vencia |
| Celular | A regra só cobria `.terminais-terminal__host`, e o terminal do celular fica em `.phone-terminal__host` |

Fundo calculado do viewport em cada captura:

| Tela | Tema | Antes | Depois |
| --- | --- | --- | --- |
| Estúdio | Claro | `rgb(0, 0, 0)` | `rgb(245, 246, 248)` |
| Estúdio | Escuro | `rgb(0, 0, 0)` | `rgb(38, 38, 42)` |
| Celular | Claro | `rgb(0, 0, 0)` | `rgb(245, 246, 248)` |
| Celular | Escuro | `rgb(0, 0, 0)` | `rgb(38, 38, 42)` |

Depois da correção o viewport tem o mesmo fundo que o tema do xterm pinta nas linhas, nas duas larguras.

| Tela | Tema | Largura | Antes | Depois |
| --- | --- | --- | --- | --- |
| Estúdio | Claro | desktop | [abrir](./antes-estudio-light-desktop.png) | [abrir](./depois-estudio-light-desktop.png) |
| Estúdio | Claro | 400 | [abrir](./antes-estudio-light-400.png) | [abrir](./depois-estudio-light-400.png) |
| Estúdio | Escuro | desktop | [abrir](./antes-estudio-dark-desktop.png) | [abrir](./depois-estudio-dark-desktop.png) |
| Estúdio | Escuro | 400 | [abrir](./antes-estudio-dark-400.png) | [abrir](./depois-estudio-dark-400.png) |
| Celular | Claro | desktop | [abrir](./antes-celular-light-desktop.png) | [abrir](./depois-celular-light-desktop.png) |
| Celular | Claro | 400 | [abrir](./antes-celular-light-400.png) | [abrir](./depois-celular-light-400.png) |
| Celular | Escuro | desktop | [abrir](./antes-celular-dark-desktop.png) | [abrir](./depois-celular-dark-desktop.png) |
| Celular | Escuro | 400 | [abrir](./antes-celular-dark-400.png) | [abrir](./depois-celular-dark-400.png) |

Cada captura foi conferida visualmente. O texto visível das capturas do estúdio e do celular foi varrido por parênteses, hífen isolado, meia-risca e travessão, sem ocorrências.

## Limites

- O motor foi o Chromium headless. WKWebView, WebView2 e o WebView do Android não foram usados; a correção não foi repetida no emulador da captura `smoke-020`.
- Fora do aplicativo, a página do celular usa a fonte serifada padrão do Chromium e não ativa os tokens da casca. O fundo do terminal vem das reservas `#f5f6f8` e `#26262a`, as mesmas de `theme.js`.
- Em 400 px o texto do terminal do celular passa da borda direita, igual antes e depois. Não faz parte desta correção.
- A largura de 400 px do estúdio mostra a casca desktop com a sidebar aberta, que não é um layout alvo.
