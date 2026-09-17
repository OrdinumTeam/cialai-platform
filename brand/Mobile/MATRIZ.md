# Matriz — Screenshots de loja do Cialai, aparelho mais tela real

Método herdado de `costumers/OC-0027_COWSNYCH/MATRIZ.md` e, antes dele, de
`projects/ADVORIS/Mobile/MATRIZ.md`, já validado e aprovado nos dois, aqui traduzido
para a marca Cialai. É o padrão das peças de loja do app de celular.

## A receita

- **Fundo blush `#FBF3F7` chapado em todos os slides.** Sem gradiente, sem forma, sem
  ruído. O que varia é a disposição do aparelho.
- **Headline e subtítulo na Outfit**, a fonte do site do Cialai, escritos em PIL a partir
  do arquivo variável, nunca desenhados pela IA.
  | Papel | Fonte | Cor |
  |---|---|---|
  | Headline | Outfit 600 | Ameixa `#3A1B33` |
  | Subtítulo | Outfit 400 | Texto secundário `#6B4F63` |
  | Headline da capa | Outfit 500 | Ameixa `#3A1B33` |
  O guia da marca não define tipografia de interface; a Outfit é a escolha do site
  público, OFL, e fica como fonte de display até o guia dizer outra coisa. Rosa e
  magenta nunca entram em texto sobre o fundo claro, pela regra de contraste da marca.
- **iPhone frontal**, com Dynamic Island, sombra suave. O mesmo render serve ao Google
  Play e à App Store.
- A tela é a **captura real colada pixel a pixel**, com o app começando abaixo do notch e
  uma faixa de status limpa no topo, na própria cor de fundo daquela tela.
- **Sem travessão, sem hífen solto e sem parênteses** em qualquer texto visível. O
  `compose_device.py` recusa headline ou subtítulo que tenha um deles.

## Por que compositing e não deixar a IA montar tudo

No zoom o Nano Banana Pro redesenha a interface e alucina o texto. A solução é dividir o
trabalho: a IA entrega só o aparelho com a tela **chroma magenta** `#FF00FF`, e a
captura real entra por cima em PIL. Fidelidade total, zero alucinação.

O recorte do chroma é por **máscara suave**, não por limiar. O peso de cada pixel sai de
`min(R,B) menos G`, então a borda antisserrilhada da tela mistura em vez de virar degrau.

Um detalhe novo aqui: a limpeza de reflexo magenta na moldura, herdada do CowSynch, só
roda **fora** da tela colada. O rosa `#FF7AB2` do Cialai cai no mesmo critério de cor e
virava pêssego quando a limpeza passava por dentro do app.

## Telas provisórias desenhadas pela IA

Parear, Computadores e Ajustes são telas nativas do Expo, sem captura real hoje. Nesta
rodada elas saem **desenhadas pelo Nano Banana Pro**, em 4K 9:16, a partir da estrutura
e das strings pt-BR reais do código do app, com a lista escura anonimizada como
referência de tipografia e acento. São **provisórias**: a regra do plano de loja do
produto diz que uma captura só está pronta quando a build real reproduz a tela. Elas
entram pela mesma cola do chroma, e a parte da tela abaixo do 9:16 recebe a cor de fundo
do app.

O que foi verificado nas três, contra o código: cada string, a ordem dos elementos, as
cores dos estados e dos chips, o botão primário em pílula rosa com texto ameixa. O que
não é fiel: métrica exata de espaçamento e o corpo das fontes, que o modelo aproxima.

Parear não precisou de retoque: o bruto é o próprio `ia/parear.png`. Os retoques
determinísticos das outras duas ficam em `docs/retoca_ia.py`, sempre a partir do bruto
`ia/<tela>-bruto.png`:

- Computadores e Ajustes vieram com uma faixa preta vazia no topo, porque o prompt
  pediu 60 px de margem e o modelo entendeu 60 pt na escala dele. O topo é aparado até
  sobrar a margem que o app real deixa acima do primeiro elemento.
- Ajustes saiu ainda com a palavra UPPERCASE escrita como rótulo e com o título
  encostado em Computadores. Uma segunda geração corrigiu o título e piorou o resto,
  então a primeira fica como bruto: a faixa do rótulo é removida e o título é reescrito
  em San Francisco Bold, centrado, no mesmo corpo e baseline. As gerações descartadas
  ficam em `_work/`.

Regras dos prompts das telas: fundo preto `#000000`, sem status bar, sem header de nome
de computador, sem QR legível, sem endereço onion, sem token, sem caminho pessoal.
Valores dinâmicos são fictícios: `MacBook de Ana`, `Mac de demonstração`, `Mac mini do
estúdio`, impressão digital `7f3a 9c1e 42b8 d05e`, código `7305`.

## Pipeline

| Passo | Comando | Saída |
|---|---|---|
| 1. Preparar as telas | `docs/prep_screens.py` | `real/*.png` |
| 2. Aparelho chroma, uma vez só | `docs/nb.py _work/phone-chroma.png 4K 3:4 prompts/phone-chroma.prompt.txt` | `_work/phone-chroma.png` |
| 3. Telas provisórias, uma vez cada | `docs/nb.py ia/<tela>-bruto.png 4K 9:16 prompts/tela-<tela>.prompt.txt real/lista-escuro.png` | `ia/*-bruto.png` |
| 3b. Retoque das telas provisórias | `docs/retoca_ia.py` | `ia/computadores.png`, `ia/ajustes.png` |
| 4. Masters 9:16 | `docs/compose_device.py` | `slides/*.png` |
| 5. Medidas de loja | `docs/export_lojas.py` | `slides/play`, `slides/iOS` |
| 6. Capa do Google Play | `docs/capa.py` | `slides/capa-1024x500.png` |

Python: a venv compartilhada em
`projects/DONATUS/social/instagram/carrossel-posicionamento/.venv/bin/python`, com
`google-genai`, `Pillow` e `numpy`. `GEMINI_API_KEY` vem do ambiente.

### Passo 1, a preparação

Tudo determinístico em PIL e numpy. As capturas são páginas do celular gravadas por
Playwright em 2x, 786 por 1704, e não prints de aparelho; ver `brutas/README.md`.

- **Status bar**: corte de 94 pixels no topo. O header de 44 pt fica; o compositor faz
  a faixa de status sob a Dynamic Island.
- **Nome do computador**: `Mac de Foco` é real e vira `MacBook de Ana`. A caixa do nome
  e do chip `Direta` é apagada na cor de fundo, o nome é reescrito em San Francisco
  Semibold, a fonte que a página usa, no mesmo baseline e no corpo cuja caixa alta bate
  com a medida original, e o chip original é colado de novo logo depois do nome.
- **Arquivos**: a captura vem de um build anterior, com outro header e sem status bar.
  O header atual, já anonimizado, é transplantado por cima do antigo.
- **Slide do agente**: a lista escura entra cortada em `CORTE_TOPO`, na borda superior
  do primeiro card, para o card do agente cair na dobra visível da disposição `bottom`.

### Disposições

| Disp | Layout |
|---|---|
| `full` | Texto em cima, aparelho inteiro centralizado embaixo |
| `bottom` | Texto em cima, aparelho grande com um quarto saindo pela base |

Alternar as duas dá ritmo ao carrossel. O corte do `bottom` é proporcional, então o
enquadramento sobrevive a qualquer proporção de tela.

### Medidas de loja

| Destino | Pixels | Pasta |
|---|---|---|
| Master 9:16 | 2160x3840 | `slides/` |
| Google Play, telefone | 1080x1920 | `slides/play/` |
| App Store, iPhone 6,9 polegadas | 1320x2868 | `slides/iOS/` |
| Google Play, feature graphic | 1024x500 | `slides/capa-1024x500.png` |

Cada destino é composto na própria proporção, em dobro, e só então reduzido. No retrato
da Apple o aparelho cresce para `phone_frac` 0,78 em vez de sobrar fundo. Sem iPad: o
app declara `supportsTablet: false`.

### A assinatura da capa

O lockup horizontal oficial, `brand/logos/cialai-lockup-1-4k.png`, recortado pelo canal
alfa e colado como imagem. O nome Cialai é lettering desenhado à mão e não existe como
fonte, então nunca é reescrito nem desenhado pela IA. Símbolo, headline e subtítulo
começam na mesma margem, e o lockup guarda trinta por cento da própria altura de respiro
antes da headline.

## Status

Rodada de 16/09/2026, pt-BR.

| # | Tela | Origem | Disp | Master | Play | iOS |
|---|---|---|---|---|---|---|
| 1 | Lista de sessões, escuro | real | full | ok | ok | ok |
| 2 | Terminal | real | bottom | ok | ok | ok |
| 3 | Parear, confirmação | IA provisória | full | ok | ok | ok |
| 4 | Computadores | IA provisória, topo aparado | bottom | ok | ok | ok |
| 5 | Arquivos | real, header transplantado | full | ok | ok | ok |
| 6 | Lista, card do agente | real | bottom | ok | ok | ok |
| 7 | Ajustes | IA provisória, retocada | full | ok | ok | ok |
| 8 | Lista de sessões, claro | real | bottom | ok | ok | ok |
| — | Capa | real | — | ok | ok | — |

## Pendências

- **Capturas reais de Parear, Computadores, Ajustes e Reconectando** na build de
  aparelho, para substituir as telas provisórias. Quando chegarem, entram em `brutas/`,
  passam pelo `prep_screens.py` e trocam o `screen` em `compose_device.py`.
- **Reconectando** como nono slide, com o texto já pronto no `roteiro.md`.
- **Rodada em inglês**, com capturas em `en` e o roteiro traduzido.
- **Tablets do Google Play**, 7 e 10 polegadas, pendentes de verificação de layout no
  produto.
- **Captura em 3x** no lugar das de 2x, para ganhar nitidez no retrato da Apple. Hoje a
  tela sobe de 786 para cerca de 900 pixels de largura no iOS.
- **Registro de captura** exigido pelo plano de loja do produto: versão, build,
  aparelho, sistema, locale e commit por imagem, só faz sentido com a build real.
