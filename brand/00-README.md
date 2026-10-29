# CIALAI Brand

Documentação da identidade visual do sistema CIALAI. Use como referência para
qualquer peça, tela, ícone ou geração de imagem que carregue a marca.

O CIALAI tem como símbolo um animal, na tradição dos mascotes de banco de
dados como o golfinho do MySQL e o elefante do PostgreSQL. O animal é o
louva-a-deus orquídea, `Hymenopus coronatus`, desenhado em vetor flat com o
rosa que o próprio inseto tem na natureza. O nome é grafado `Cialai`, com C
maiúsculo e o resto em minúsculas.

## Estrutura

| Arquivo | Tema |
|---------|------|
| `01-paleta-cores.md` | Tokens de cor, proporção de uso e variáveis CSS |
| `02-simbolo.md` | Símbolo, assinatura, anatomia da cabeça, lettering, aplicação e o que não fazer |
| `03-prompt-kit.md` | Prompts oficiais, blocos reutilizáveis e fluxo de geração pela API |
| `04-estilo-visual.md` | Gramática de formas, cor em interface, iconografia, ilustração, movimento e tom |

## Assets

| Arquivo | O que é | Tamanho |
|---------|---------|---------|
| `logo/cialai-mantis-v4-1-head-4k.png` | Símbolo em cores. Cabeça do louva-a-deus com a pétala de topo atrás | 4096 x 4096 |
| `logo/cialai-mantis-v4-1-head-4k-white.png` | Símbolo monocromático branco, para fundos escuros e fundos rosa | 4096 x 4096 |
| `logo/cialai-mantis-v4-1-head-4k-black.png` | Símbolo monocromático preto, para impressão de uma cor e fundos claros neutros | 4096 x 4096 |
| `logo/cialai-lockup-1-4k.png` | Assinatura horizontal. Símbolo à esquerda e nome Cialai à direita | 5504 x 3072 |
| `logo/broto-icon.jpg` | Arte aprovada do Broto, gerada com Nano Banana Pro e ajustada pelo usuário. Fonte para as derivações do produto | 2048 x 2048 |

Derivadas para a interface do desktop, geradas por `tools/brand/build-ui-lockup.mjs` a partir da assinatura horizontal, sem redesenhar forma: `packages/ui/src/assets/cialai-lockup.png`, a assinatura recortada justo, e `packages/ui/src/assets/cialai-lockup-dark.png`, a mesma peça com só as letras em branco e a cabeça nas cores, para fundo escuro. O alfa de cada pixel é o do original, então os recortes entre os traços continuam os do lettering. O mesmo script grava `cialai-wordmark.png` e `cialai-wordmark-dark.png`, só o lettering recortado justo, sem a cabeça, nas cores e em branco: é a marca discreta da toolbar quando a lateral do desktop fecha, por decisão do usuário em 18/10/2026. O mesmo script copia as duas assinaturas para o app do celular e grava `apps/mobile/src/assets/cialai-head.png`, a cabeça sozinha num quadrado de 192 px. As assinaturas têm 480 px de largura, o bastante para a abertura de 220 px em telas 2x, e todas as peças passam pelo `pngquant` com parâmetros fixos: a diferença média fica abaixo de um nível em 255 e o peso cai a menos da metade. A interface carrega só a peça do tema atual.

Todos os PNGs têm fundo transparente e margem interna generosa. Não existe
SVG ainda.

A arte do Broto foi aprovada em 28/10/2026 e tem fundo branco. O arquivo
`logo/broto-icon.jpg` preserva exatamente a versão ajustada pelo usuário,
sem regeração ou retoque adicional. É a referência própria do Broto e não
substitui o símbolo do Cialai.

As derivações do Broto saem de `tools/brand/build-broto-icons.mjs`, que tira
o fundo branco do JPG sem redesenhar forma. O ícone do aplicativo usa a mesma
placa arredondada de `logo/cialai-icon.png`, com a curva do designer, na grade
de 824 em 1024 do desktop, e a arte ocupa 66% da largura da placa para os
cantos não cortarem as folhas, por decisão do usuário em 28/10/2026. A janela
do Broto usa `packages/ui/src/assets/broto-mark.png`, só a arte, sem placa,
como a marca da interface do Cialai.

## Regras-mãe

1. O rosa domina a peça. Branco separa e dá respiro. Ameixa só em antenas e boca.
2. Flat puro. Nenhum gradiente, sombra, textura, contorno ou plano escurecido.
3. A cabeça é fiel ao inseto real: olhos cônicos curtos, coroa entre eles, face estreita e clara.
4. O lettering do nome nasce das mesmas curvas de pétala da cabeça. Nunca trocar por fonte pronta.
5. Símbolo sozinho para tamanhos pequenos. Assinatura horizontal para todo o resto.
6. Toda nova peça parte dos PNGs aprovados como referência anexada, nunca de descrição solta.

## Pendências

| Item | Estado |
|------|--------|
| SVG vetorizado | Pendente. Símbolo e letras precisam ser redesenhados como formas, com as cores ajustadas aos tokens |
| Assinatura para fundo escuro | Parcial. Em 18/10/2026 a interface do desktop passou a usar uma derivação para tela, com as letras em branco e a cabeça nas cores; a versão em vetor continua pendente |
| Ícone de app | Aprovado em 13/09/2026: `logo/cialai-icon.png`, placa branca arredondada de 2048 px, fonte dos ícones de desktop, iOS e Android |
| Assinatura empilhada | Pendente. Só existe a horizontal |
| Tipografia de interface | Não definida. O lettering do nome é desenho, não fonte, e não serve para texto corrido |
| Fonte vetorial | As versões branca e preta foram feitas em vetor fora do repositório. O arquivo de origem não está versionado aqui |
| Propostas do estilo visual | Raios, neutros, modo escuro, ícones, movimento e cores funcionais estão marcados como proposta em `04-estilo-visual.md` e precisam de validação em tela |
