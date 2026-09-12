# 02 · Símbolo e assinatura

## Conceito

O louva-a-deus orquídea é um predador que se parece com uma flor. Fica
imóvel, balança como pétala ao vento e atrai o que caça pela própria
aparência. É o único animal conhecido cujo corpo funciona como isca floral
sozinho, sem depender de uma flor de verdade.

Para o CIALAI a leitura é direta: precisão, paciência, camuflagem elegante e
um sistema que parece simples por fora e é preciso por dentro. O rosa não é
escolha decorativa, é a cor real do animal.

## Peças oficiais

| Peça | Arquivo | Quando usar |
|------|---------|-------------|
| Símbolo em cores | `logo/cialai-mantis-v4-1-head-4k.png` | Favicon, avatar, ícone de app, menu recolhido, carimbo em canto de peça, qualquer aplicação abaixo de 48 px de altura |
| Símbolo branco | `logo/cialai-mantis-v4-1-head-4k-white.png` | Fundos escuros, fundos rosa quente ou magenta, modo escuro da interface |
| Símbolo preto | `logo/cialai-mantis-v4-1-head-4k-black.png` | Impressão de uma cor, carimbo, gravação, documentos em preto e branco |
| Assinatura horizontal | `logo/cialai-lockup-1-4k.png` | Header, login, rodapé, assinatura de e-mail, capa de documento, impressão, qualquer aplicação acima de 48 px de altura |

### Símbolo

Só a cabeça do louva-a-deus, ampliada, com a pétala de topo atrás como única
referência à flor. Sem braços, sem peito, sem outras pétalas.

Existe em três versões, todas com fundo transparente e a mesma geometria:

| Versão | Construção |
|--------|------------|
| Cores | Paleta completa, ver tabela de componentes abaixo |
| Branca | Todas as formas em branco `#FFFFFF`, separadas por linhas finas transparentes. Feita à mão em vetor a partir da versão em cores |
| Preta | Todas as formas em preto `#000000`, separadas por linhas finas brancas, brilho dos olhos em branco. Feita à mão em vetor a partir da versão em cores |

As versões monocromáticas não são geradas por IA. Qualquer ajuste nelas é
feito no vetor de origem, nunca regerando.

| Componente | Cor | Descrição |
|------------|-----|-----------|
| Pétala de topo | Rosa quente | Pétala vertical atrás da cabeça, arredondada, mais larga que a face |
| Face | Rosa claro | Triângulo estreito apontando para baixo |
| Olhos | Magenta com brilho rosa claro | Dois cones curtos saindo para cima e para os lados |
| Coroa | Rosa claro | Protuberância pequena e pontuda entre os olhos |
| Antenas | Ameixa | Duas linhas finas e retas saindo de entre os olhos |
| Boca | Ameixa | Ponto pequeno na ponta inferior da face |

### Assinatura horizontal

Símbolo à esquerda e o nome `Cialai` à direita, na mesma linha.

| Regra | Valor |
|-------|-------|
| Altura do símbolo | Da linha de base ao topo do C, com as antenas subindo acima |
| Espaço entre símbolo e nome | Largura da letra i |
| Cor das letras | Rosa quente `#FF7AB2` |
| Cor dos pingos dos dois i | Magenta orquídea `#E23B84` |
| Largura do conjunto | Cerca de 80% da largura do quadro 16:9 |

## Anatomia da cabeça

A cabeça é o elemento que identifica o animal. É obrigatória em qualquer peça
nova e segue o inseto real, não uma caricatura.

| Elemento | Regra |
|----------|-------|
| Face | Triângulo estreito apontando para baixo, rosa claro |
| Olhos | Dois cones curtos saindo para cima e para os lados, como chifres pequenos, em magenta, com um ponto de brilho rosa claro. Nunca mais longos que a altura da face |
| Coroa | Protuberância pequena e pontuda entre os dois olhos, rosa claro |
| Antenas | Duas linhas finas e retas em ameixa, saindo de entre os olhos |
| Boca | Ponto pequeno em ameixa na ponta inferior da face |

Proibido: olhos redondos de cartoon, olhos desenhados como ovais chapadas
sobre a face, cabeça hexagonal larga, expressão facial, sorriso.

## Lettering do nome

O nome não usa fonte. É desenho, feito com a mesma mão do símbolo.

| Regra | Valor |
|-------|-------|
| Grafia | `Cialai`, C maiúsculo, resto minúsculo, seis letras |
| Traço | Peso uniforme, curvas de pétala nos bojos do C e dos dois a |
| Terminais | Afinados como ponta de pétala |
| Recortes | Gap branco fino onde um traço encontra outro, mesma construção do símbolo |
| Espaçamento | Generoso e regular, linha de base perfeitamente horizontal |
| Caixa | Nunca em caixa alta, nunca em itálico, nunca com serifa |

## Construção

- Flat vetorial. Cada forma tem uma única cor sólida.
- Sem contorno. As formas se separam por gaps brancos de espessura uniforme.
- Sem gradiente, sombra, textura, plano escurecido ou dobra falsa.
- Símbolo com simetria bilateral perfeita no eixo vertical.
- Arquivos com fundo transparente e margem igual nos quatro lados. Aplicação padrão sobre branco.
- Bordas nítidas. Qualquer suavização vem só do antialiasing do render.

## Aplicação

| Regra | Valor |
|-------|-------|
| Tamanho mínimo do símbolo | 16 px de largura em tela, 5 mm em impresso |
| Tamanho mínimo da assinatura | 120 px de largura em tela, 30 mm em impresso |
| Área de proteção | Margem livre igual à largura da cabeça ao redor da peça |
| Fundo padrão | Branco `#FFFFFF`, símbolo em cores |
| Fundo alternativo | Rosa claro `#FFD6E6` em interfaces, símbolo em cores |
| Fundo escuro ou rosa saturado | Símbolo branco |
| Uma cor só | Símbolo preto |
| Rotação | Nunca. Símbolo e assinatura são sempre horizontais |
| Escala | Sempre proporcional. Nunca esticar ou achatar |

### Posicionamento em peças

| Peça | Marca | Posição |
|------|-------|---------|
| Header do sistema | Assinatura horizontal, ou símbolo se o header for baixo | Canto superior esquerdo |
| Tela de login | Assinatura horizontal | Centralizada acima do formulário |
| Favicon e aba do navegador | Símbolo | Padrão do navegador |
| Avatar e ícone de app | Símbolo | Centralizado no tile |
| Apresentação | Assinatura horizontal | Capa centralizada, símbolo discreto no rodapé dos slides |
| Documento | Assinatura horizontal | Capa centralizada, símbolo no rodapé de cada página |

## O que não fazer

- Não redesenhar símbolo ou nome dentro de uma peça gerada por IA. Eles entram em pós-produção a partir dos PNGs.
- Não escrever o nome com fonte pronta ao lado do símbolo. A assinatura é uma peça só.
- Não separar as letras da assinatura para reordenar ou empilhar por conta própria.
- Não mudar a cabeça para uma versão fofa ou de mascote infantil.
- Não aplicar contorno, sombra, brilho, relevo ou efeito de papel.
- Não usar sobre foto ou fundo saturado.
- Não combinar com outros animais, folhas, galhos ou flores extras.
- Não separar a cabeça da pétala de topo.

## Direções já descartadas

Registradas para ninguém regerar por engano:

- Mascote de corpo inteiro de perfil.
- Glifo minimalista de cor única.
- Brasão frontal com olhos redondos de cartoon e suas variações.
- Louva-a-deus de corpo inteiro visto de cima formando flor.
- Busto frontal sobre orquídea de cinco pétalas. Foi a peça de onde o símbolo saiu e depois foi aposentada; o prompt segue no `03-prompt-kit.md` só como linhagem.
- Silhueta branca de perfil dentro de flor rosa.
- Versão monoline, versão papercut, tile de ícone de app e versão minimal reduzida.
- Assinaturas com fonte geométrica genérica, assinatura empilhada, cabeça no pingo do i e cabeça aninhada no C.
