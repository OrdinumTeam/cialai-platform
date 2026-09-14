# Evidência visual da tarefa 1.11

Data: 12/09/2026.

## Escopo

As capturas mostram o estúdio de Terminais do Cialai com dados fictícios. A comparação lado a lado com o protótipo interno de onde o estúdio foi extraído foi feita fora deste repositório, e as capturas desse protótipo não são publicadas.

As diferenças aceitas em relação ao protótipo são:

- nome, símbolo e conteúdo fictício do produto;
- identidade rosa, magenta e ameixa do Cialai no lugar do gradiente, do acento e dos controles azuis;
- ausência dos módulos que não pertencem ao estúdio;
- textos que dizem computador em vez de Mac quando a interface é multiplataforma.

Estrutura, dimensões, densidade, estados das sessões, painéis do terminal, explorador, Dev Browser e navegação móvel foram mantidos.

## Desktop

As dimensões lógicas são 1380 × 880. As capturas foram gravadas em escala Retina, por isso os PNGs têm 2760 × 1760 pixels.

| Estado | Captura |
| --- | --- |
| Claro | [Abrir captura](./cialai-desktop-light.png) |
| Escuro | [Abrir captura](./cialai-desktop-dark.png) |
| Dev Browser claro | [Abrir captura](./cialai-dev-browser-light.png) |

As capturas fora do Tauri não desenham os glifos do canvas do xterm. A resposta do PTY e a integração do terminal foram comprovadas no binário real pelo autoteste da tarefa 1.10.

## Celular

Lista, terminal e arquivos usam 393 × 852. A prévia usa 852 × 393 para conferir a quebra de linha em paisagem. Cada fixture usa dados fictícios e uma fronteira de arquivos inerte.

| Estado | Captura |
| --- | --- |
| Lista com cinco sessões | [Abrir captura](./cialai-mobile-list.png) |
| Terminal | [Abrir captura](./cialai-mobile-terminal.png) |
| Arquivos | [Abrir captura](./cialai-mobile-files.png) |
| Prévia em paisagem | [Abrir captura](./cialai-mobile-preview-landscape.png) |

## Verificações

O roteiro passou nos estados lista, terminal, arquivos, prévia e retorno. A largura do documento coincidiu com a viewport; somente a tela de terminal montou um host xterm; a prévia quebrou o texto sem overflow. O modo escuro confirmou `--mac-accent: #FF7AB2`.

Comando reproduzível:

```sh
npm run test:visual:phone --workspace @cialai/ui
```
