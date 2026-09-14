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

Todos os PNGs têm fundo transparente e margem interna generosa. Não existe
SVG ainda.

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
| Assinatura para fundo escuro | Pendente. Só o símbolo tem versão branca; a assinatura existe apenas em cores |
| Ícone de app | Aprovado em 13/09/2026: `logo/cialai-icon.png`, placa branca arredondada de 2048 px, fonte dos ícones de desktop, iOS e Android |
| Assinatura empilhada | Pendente. Só existe a horizontal |
| Tipografia de interface | Não definida. O lettering do nome é desenho, não fonte, e não serve para texto corrido |
| Fonte vetorial | As versões branca e preta foram feitas em vetor fora do repositório. O arquivo de origem não está versionado aqui |
| Propostas do estilo visual | Raios, neutros, modo escuro, ícones, movimento e cores funcionais estão marcados como proposta em `04-estilo-visual.md` e precisam de validação em tela |
