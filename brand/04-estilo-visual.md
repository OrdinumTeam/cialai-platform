# 04 · Estilo visual

Como o CIALAI se parece além da marca: telas, ícones de interface, ilustração
de apoio, peças de comunicação e movimento. Tudo deriva do símbolo e da
assinatura aprovados.

Cada regra abaixo está marcada como **aprovada**, quando vem direto das peças
que o usuário aprovou, ou como **proposta**, quando é uma extensão lógica que
ainda não foi validada em tela. Propostas podem ser mudadas; regras aprovadas
não.

## Princípio

O louva-a-deus orquídea parece uma flor e funciona como predador. O sistema
segue a mesma lógica: superfície calma, clara e bonita; por dentro, precisão.
Toda decisão visual deve passar por essa pergunta: isso deixa a tela mais
calma e mais precisa, ou só mais decorada?

## Gramática de formas

Regras aprovadas, extraídas do símbolo e do lettering:

| Elemento | Regra |
|----------|-------|
| Curvas | Curvas de pétala: arcos amplos, contínuos, sem ondulação |
| Pontas | Afinadas, como ponta de pétala ou de antena. Nunca ponta serrilhada |
| Separação | Formas vizinhas se separam por um gap fino da cor do fundo, nunca por contorno |
| Preenchimento | Sempre chapado, uma cor por forma |
| Simetria | Peças centrais são simétricas no eixo vertical |
| Volume | Não existe. Nada de sombra, relevo, gradiente ou brilho |

Propostas para interface:

| Elemento | Proposta |
|----------|----------|
| Raio de canto | Escala de 8, 12, 20 e 32 px. Botões em 12, cards em 20, modais em 32. O raio grande ecoa a pétala |
| Bordas | Evitar linha de borda. Separar blocos por diferença de superfície, branco sobre rosa claro, ou por espaço |
| Divisores | Quando inevitáveis, 1 px em `#E9D9E2`, nunca preto ou cinza puro |
| Espaçamento | Base de 8 px. Respiro generoso, a marca é feita de gaps |

## Cor em interface

Regra aprovada: rosa domina, branco separa, ameixa detalha. Em tela isso vira:

| Camada | Cor | Proporção |
|--------|-----|-----------|
| Fundo de página | Branco `#FFFFFF` | Maior parte da tela |
| Superfície secundária | Rosa claro `#FFD6E6` ou superfície neutra `#FBF3F7` | Blocos, sidebars, cards de destaque |
| Ação principal | Rosa quente `#FF7AB2` | Botão primário, links, elementos ativos |
| Destaque forte | Magenta orquídea `#E23B84` | Hover do primário, badges, contadores, um por tela |
| Texto | Ameixa `#3A1B33` | Todo texto corrido e títulos |

Regras de contraste, medidas com a fórmula WCAG, ver `01-paleta-cores.md`:

- Texto é sempre ameixa. Rosa quente e magenta não servem para texto corrido.
- Botão rosa quente leva texto ameixa, não branco.
- Botão magenta pode levar texto branco só em tamanho grande, acima de 18 px ou 14 px em negrito.
- Estados de erro, sucesso e aviso são cores funcionais, fora da identidade. Proposta: erro `#C8102E`, sucesso `#2E7D5B`, aviso `#B8860B`, usados só em ícone e texto de estado, nunca em superfície grande.

## Iconografia de interface

Proposta, ainda sem conjunto desenhado:

| Regra | Valor |
|-------|-------|
| Estilo | Monoline, traço de 1,75 px em grade de 24 px, terminais e junções arredondados |
| Cor | Ameixa em repouso, rosa quente em estado ativo |
| Curvas | Mesmas curvas de pétala da marca, nada de cantos vivos |
| Fonte | Qualquer biblioteca monoline arredondada serve como base, desde que ajustada às regras acima |
| Proibido | Ícones preenchidos misturados com ícones de linha na mesma tela |

## Ilustração de apoio

Regra aprovada: mesma linguagem do símbolo. Flat, sem contorno, gaps entre
formas, paleta de `01-paleta-cores.md` e nada fora dela.

| Regra | Valor |
|-------|-------|
| Temas | O inseto, orquídeas, pétalas, folhas em silhueta, geometria de pétala |
| Personagem | O louva-a-deus só aparece pela cabeça aprovada ou por partes fiéis ao inseto real. Nunca como mascote fofo, nunca com expressão |
| Fundo | Branco ou rosa claro. Sem cenário, sem céu, sem chão |
| Geração por IA | Só com o prompt kit, recorte apertado do símbolo como referência e os blocos HEAD RULE e STYLE RULE |
| Proibido | Clichês de tecnologia: cérebro, engrenagem, foguete, lâmpada, cadeado, nuvem, circuito, código na tela, robô |

## Fotografia

Proposta: o CIALAI não usa fotografia junto da marca. Se uma peça exigir
foto, ela fica em bloco separado, sem sobreposição de símbolo ou assinatura,
e sem filtro rosa por cima.

## Movimento

Proposta, inspirada no balanço lateral que o inseto faz para parecer pétala
ao vento:

| Regra | Valor |
|-------|-------|
| Curva | Ease in out suave, nunca elástico, nunca bounce |
| Duração | 240 ms para micro interações, 400 ms para transições de tela |
| Assinatura | Elementos entram com leve deslocamento lateral, 4 px, e voltam ao centro. Nunca escala que "pula" |
| Loading | Balanço lento do símbolo, 2 s por ciclo, amplitude de 3 graus |
| Proibido | Rotação completa, piscar, glow pulsante |

## Tom

Proposta: texto de interface direto, calmo e preciso. Frases curtas, sem
exclamação, sem gíria, sem humor forçado. O sistema não se anuncia; ele
funciona.

## O que não fazer

- Gradientes, glassmorphism, neon, glow, sombras longas, relevo.
- Rosa quente como fundo de tela inteira com texto por cima.
- Cinza puro ou preto puro em texto, borda ou ícone. Tudo neutro é tingido de ameixa.
- Mais de um acento magenta por tela.
- Ícones preenchidos e ícones de linha misturados.
- Mascote animado, mascote com braços, mascote falando.
- Qualquer elemento visual que não sobreviva à pergunta do princípio.
