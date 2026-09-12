# 01 · Paleta de cores

A paleta nasce do próprio louva-a-deus orquídea: rosa quente nos lobos,
rosa pálido no corpo, magenta nas bordas e um tom escuro só nos detalhes
finos. Não existe cor de apoio fora do rosa. Verde, azul ou amarelo não
entram na marca.

## Tokens

| Nome | Hex | Papel | Onde aparece na marca |
|------|-----|-------|------------------------|
| Magenta orquídea | `#E23B84` | Acento forte | Cones dos olhos, pingos dos dois i na assinatura |
| Rosa quente | `#FF7AB2` | Cor principal | Pétala de topo do símbolo, letras do nome na assinatura |
| Rosa claro | `#FFD6E6` | Base clara | Face, coroa, brilho dos olhos |
| Branco | `#FFFFFF` | Separador | Gaps entre todas as formas, fundo padrão |
| Ameixa | `#3A1B33` | Detalhe | Antenas e ponto de boca, nada além disso |

## Valores renderizados

Os PNGs aprovados foram gerados por IA a partir dos tokens acima e saem com
pequenas variações. Medições nos arquivos:

| Token | Renderizado nos PNGs atuais |
|-------|------------------------------|
| Magenta orquídea | `#D62985` |
| Rosa quente | `#FC7AB8` |
| Rosa claro | `#FBE3F0` |

Regra: ao vetorizar ou reproduzir a marca em código, use os tokens, não os
valores renderizados. Os PNGs são a referência de forma, os tokens são a
referência de cor.

## Proporção de uso

| Cor | Proporção aproximada na assinatura horizontal |
|-----|-----------------------------------------------|
| Rosa quente | 60% |
| Rosa claro | 20% |
| Magenta orquídea | 15% |
| Branco | Só os gaps, sempre presente |
| Ameixa | Menos de 2% |

Uma peça em que o magenta ou o ameixa dominam saiu da identidade.

## Combinações permitidas

| Fundo | Marca |
|-------|-------|
| Branco `#FFFFFF` | Símbolo e assinatura em cores. Uso padrão |
| Rosa claro `#FFD6E6` | Símbolo e assinatura. Os gaps ficam rosa claro em vez de branco, aceitável em interface |
| Fundo escuro, ameixa `#3A1B33` ou preto | Símbolo na versão branca `cialai-mantis-v4-1-head-4k-white.png`. Assinatura ainda sem versão para fundo escuro |
| Fundo rosa quente `#FF7AB2` ou magenta `#E23B84` | Símbolo na versão branca |
| Impressão de uma cor, carimbo, gravação | Símbolo na versão preta `cialai-mantis-v4-1-head-4k-black.png` |

## Acessibilidade

Contraste medido com a fórmula WCAG 2. Texto normal exige 4,5, texto grande
e componentes de interface exigem 3,0.

| Combinação | Contraste | Veredito |
|------------|-----------|----------|
| Ameixa sobre branco | 15,17 | Texto de qualquer tamanho |
| Ameixa sobre rosa claro | 11,57 | Texto de qualquer tamanho |
| Branco sobre ameixa | 15,17 | Texto de qualquer tamanho |
| Rosa claro sobre ameixa | 11,57 | Texto de qualquer tamanho |
| Rosa quente sobre ameixa | 6,27 | Texto de qualquer tamanho |
| Magenta sobre branco | 4,04 | Só texto grande e componentes |
| Branco sobre magenta | 4,04 | Só texto grande e componentes |
| Magenta sobre ameixa | 3,75 | Só texto grande e componentes |
| Magenta sobre rosa claro | 3,08 | Só componentes, nunca texto |
| Rosa quente sobre branco | 2,42 | Nunca texto. Só superfície e marca |
| Rosa quente sobre rosa claro | 1,85 | Nunca texto. Só superfície e marca |

Consequência prática: todo texto é ameixa sobre claro ou claro sobre ameixa.
Rosa quente e magenta são cores de superfície, marca e componente, não de
leitura.

## Neutros de interface

Proposta, ainda não validada em tela. Todos tingidos de ameixa para não
esfriar o rosa:

| Nome | Hex | Uso |
|------|-----|-----|
| Texto | `#3A1B33` | O próprio ameixa |
| Texto secundário | `#6B4F63` | Legendas, metadados, placeholders |
| Divisor | `#E9D9E2` | Linhas de 1 px quando inevitáveis |
| Superfície | `#FBF3F7` | Blocos e cards neutros |
| Fundo | `#FFFFFF` | Página |

## Modo escuro

Proposta, ainda não validada em tela:

| Papel | Hex |
|-------|-----|
| Fundo | `#1E0F1A` |
| Superfície | `#2A1524` |
| Texto | `#FFD6E6` |
| Texto secundário | `#C9A6BA` |
| Ação principal | `#FF7AB2` |
| Destaque | `#E23B84` |
| Símbolo | Versão branca |

## Variáveis CSS

```css
:root {
  --cialai-magenta: #E23B84;
  --cialai-rosa: #FF7AB2;
  --cialai-rosa-claro: #FFD6E6;
  --cialai-branco: #FFFFFF;
  --cialai-ameixa: #3A1B33;

  /* neutros, proposta */
  --cialai-texto-2: #6B4F63;
  --cialai-divisor: #E9D9E2;
  --cialai-superficie: #FBF3F7;
}
```

## O que não fazer

- Não criar gradiente entre os rosas. Cada forma tem uma cor só.
- Não escurecer bordas para simular volume.
- Não trocar o ameixa por preto. O preto pesa demais contra o rosa.
- Não introduzir cor de apoio fora da paleta, mesmo em ilustração de apoio.
- Não usar o magenta como fundo de página inteira com a marca colorida por cima.
