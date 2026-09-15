# Evidência visual do pacote de defeitos do celular

Data: 15/09/2026. Página do celular servida pelo computador, em `apps/desktop/src-tauri/resources/mobile`, aberta em `mobile.html?terminais=demo&motion=0` num WebView de 393 por 852. As capturas `antes` usam o build de `404d050`; as `depois`, o build desta correção. O tema segue `prefers-color-scheme`.

Nome dos arquivos: `<etapa>-<tela>-<tema>-<largura>.png`.

## Camada visual ausente

A casca em `shell.css` só ativa sob `html[data-shell="desktop"]` ou `html[data-platform="macos"]`. A fixture dos checks marca o segundo atributo; a página real não marcava nenhum. No aparelho a página ficava sem os tokens de fonte, cor e superfície: o WebView caía na serifa padrão, os botões viravam texto solto, a fileira de teclas era cortada e o tema claro ou escuro não se aplicava. Isso é o que as fotos do pacote de defeitos mostram.

| Medida | Antes | Depois |
| --- | --- | --- |
| `document.documentElement.dataset.platform` | vazio | `macos` |
| Fonte calculada do corpo | `-webkit-standard`, a serifa do sistema | `system-ui, -apple-system, BlinkMacSystemFont, SF Pro Text, Roboto` |
| Fonte do título da sessão | `-webkit-standard` | a mesma família do sistema |

| Tela | Tema | Antes | Depois |
| --- | --- | --- | --- |
| Lista de sessões | Claro | [abrir](./antes-lista-light-393.png) | [abrir](./depois-lista-light-393.png) |
| Lista de sessões | Escuro | [abrir](./antes-lista-dark-393.png) | [abrir](./depois-lista-dark-393.png) |
| Terminal | Claro | [abrir](./antes-terminal-light-393.png) | [abrir](./depois-terminal-light-393.png) |
| Terminal | Escuro | [abrir](./antes-terminal-dark-393.png) | [abrir](./depois-terminal-dark-393.png) |

O que muda nas capturas `depois`:

- Fonte do sistema em toda a página e tema claro e escuro completos, com o mesmo acento rosa do desktop.
- Cabeçalho da página sem o nome do computador quando ela roda dentro do aplicativo, que já mostra o computador, o transporte e o botão Computadores na barra nativa. Fora do aplicativo o cabeçalho completo continua, como nestas capturas.
- Botões com fundo e rótulo: Nova na lista, Arquivos e Encerrar no terminal.
- Fileira de teclas em duas linhas, com Esc, Tab, Shift Tab, Ctrl C, setas, Enter em destaque, Ctrl D, Ctrl L e Colar sempre visíveis. Com o teclado do aparelho aberto a fileira vira uma linha que rola, com esmaecido na ponta.
- Card da sessão com modelo, esforço de raciocínio, contexto usado e custo estimado quando o hook da linha de estado do Claude Code publica esses dados.

## O que não aparece em captura

- O terminal do celular deixa de usar o WebGL, a página não recarrega mais por puxar para atualizar e a perda da posse do terminal escurece a tela em vez de apagá-la. No computador a posse remota vale 45 s sem renovação em vez de 15 s.
- O app só reconecta depois de duas sondagens seguidas sem resposta e de confirmar com o núcleo, com uma sondagem mais longa, que o caminho caiu de verdade.
- A tela de pareamento mostra o tempo decorrido na reserva, explica a demora e permite cancelar.
- Os ajustes do app ganharam a aparência Sistema, Claro ou Escuro, repassada à página.
- No computador, o diálogo Vincular celular mantém uma janela só de dez minutos por pareamento e avisa quando ela expira; o atalho repetido na toolbar de Dispositivos saiu.
