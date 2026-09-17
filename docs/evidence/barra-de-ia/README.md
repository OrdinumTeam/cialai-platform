# Evidência visual da Barra de IA

Data: 17/09/2026. Branch `plano/16-09-2026`.

Capturas geradas com Playwright e Chromium headless sobre o servidor de desenvolvimento do Vite de `apps/desktop`, sem o Tauri. A barra recebe os dados fixos de `packages/ui/src/notch/fixtures.js`, pelo mesmo mecanismo de demonstração do estúdio: a consulta da URL escolhe o cenário. O estúdio abre em `index.html?terminais=demo&motion=0&platform=macos&tunnel=demo&notch=demo:<cenário>#terminais`. O tema segue `prefers-color-scheme`.

Nome dos arquivos: `<tela>-<tema>-<largura>.png`. As dimensões lógicas são 1380 por 880, gravadas em escala Retina, por isso os PNGs têm 2760 por 1760 pixels. A captura recolhida usa 1380 por 500.

| Captura | Cenário | O que mostra |
| --- | --- | --- |
| [barra-light-1380](./barra-light-1380.png) | `demo:basic`, claro | Oito anéis, um por perfil, à direita do conteúdo; o popover do primeiro perfil com a sessão atual, a semana e a sessão do estúdio |
| [barra-dark-1380](./barra-dark-1380.png) | `demo:basic`, escuro | A mesma tela com os tokens escuros e o acento rosa |
| [estados-dark-1380](./estados-dark-1380.png) | `demo:states`, escuro | Um estado por célula: faixas de uso, leitura envelhecida, sem credencial, erro HTTP e leitura derivada |
| [recolhida-dark-1380](./recolhida-dark-1380.png) | `demo:collapsed`, escuro | A tira de 22 pontos com um ponto por perfil |

## Verificações

Medidas lidas na página durante a captura:

| Medida | Valor |
| --- | --- |
| Largura da barra aberta | 84 pontos |
| Largura da barra recolhida | 22 pontos |
| Borda direita do conteúdo | igual à borda esquerda da barra, sem sobreposição |
| Acento no tema claro | `#E23B84` |
| Acento no tema escuro | `#FF7AB2` |
| Células no cenário básico | 8 |
| Pontos na tira recolhida | 8 |

Nenhum erro de console ou de página nas quatro capturas. Os glifos do canvas do xterm não aparecem fora do Tauri, como nas demais evidências deste repositório.

Comando reproduzível, com o Vite e o Playwright de `tools/browser`: o roteiro sobe o servidor numa porta livre, abre cada cenário e grava a captura. Ele vive fora do repositório porque as capturas são revisadas à mão.
