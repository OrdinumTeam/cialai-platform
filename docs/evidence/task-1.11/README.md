# Evidência visual da tarefa 1.11

Data: 12/09/2026.

## Escopo

As capturas comparam o estúdio de Terminais do Cialai com o Ordinum Control no commit `c26d98bb9b6851b438918a5e10278799f4442cd7`. O Control foi usado somente como fonte de leitura. Seus módulos de negócio aparecem apenas na sidebar da referência e não pertencem ao escopo do Cialai.

As diferenças aceitas são:

- nome, símbolo e conteúdo fictício de cada produto;
- gradiente, acento e controles azuis do Control substituídos pela identidade rosa, magenta e ameixa do Cialai;
- ausência dos produtos removidos do fork;
- textos que dizem computador em vez de Mac quando a interface é multiplataforma.

Estrutura, dimensões, densidade, estados das sessões, painéis do terminal, explorador, Dev Browser e navegação móvel foram mantidos.

## Desktop

As dimensões lógicas são 1380 × 880. O `wksnap` do Control grava em escala Retina, por isso os PNGs têm 2760 × 1760 pixels.

| Estado | Ordinum Control | Cialai |
| --- | --- | --- |
| Claro | [Abrir captura](./control-desktop-light.png) | [Abrir captura](./cialai-desktop-light.png) |
| Escuro | [Abrir captura](./control-desktop-dark.png) | [Abrir captura](./cialai-desktop-dark.png) |
| Dev Browser claro | [Abrir captura](./control-dev-browser-light.png) | [Abrir captura](./cialai-dev-browser-light.png) |

As capturas fora do Tauri não desenham os glifos do canvas do xterm. A resposta do PTY e a integração do terminal foram comprovadas no binário real pelo autoteste da tarefa 1.10.

## Celular

Lista, terminal e arquivos usam 393 × 852. A prévia usa 852 × 393 para conferir a quebra de linha em paisagem. Cada fixture usa dados fictícios e uma fronteira de arquivos inerte.

| Estado | Ordinum Control | Cialai |
| --- | --- | --- |
| Lista com cinco sessões | [Abrir captura](./control-mobile-list.png) | [Abrir captura](./cialai-mobile-list.png) |
| Terminal | [Abrir captura](./control-mobile-terminal.png) | [Abrir captura](./cialai-mobile-terminal.png) |
| Arquivos | [Abrir captura](./control-mobile-files.png) | [Abrir captura](./cialai-mobile-files.png) |
| Prévia em paisagem | [Abrir captura](./control-mobile-preview-landscape.png) | [Abrir captura](./cialai-mobile-preview-landscape.png) |

## Verificações

Os roteiros do Control e do Cialai passaram nos estados lista, terminal, arquivos, prévia e retorno. Nos dois, a largura do documento coincidiu com a viewport; somente a tela de terminal montou um host xterm; a prévia quebrou o texto sem overflow. O Cialai confirmou ainda `--mac-accent: #FF7AB2` no modo escuro.

Comando reproduzível do Cialai:

```sh
npm run test:visual:phone --workspace @cialai/ui
```
