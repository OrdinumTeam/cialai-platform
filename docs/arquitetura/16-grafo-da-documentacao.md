# Grafo da documentação

## Objetivo

Mostrar o projeto aberto numa sessão do estúdio de Terminais como um grafo
navegável. No escopo Documentação, o padrão, cada arquivo Markdown do diretório
é um nó, e só aparecem as pastas necessárias para chegar até eles. Um projeto
com mil pastas e documentação em dez áreas mostra dez áreas e os caminhos até
elas, nada mais. No escopo Projeto inteiro entram todos os arquivos que passam
pelas mesmas exclusões, até 20 mil. Por cima da hierarquia ficam as ligações
entre os arquivos: links do Markdown e imports do código.

Seis vistas mostram o mesmo índice de jeitos diferentes, trocadas na hora por
um seletor na barra: Mapa, Árvore, Radial, Blocos, Vizinhos e 3D. A cor pode
dizer o grupo, a pasta, o tipo de arquivo, o tamanho, a data de alteração ou
regras escolhidas pela pessoa, em quatro paletas.

É um recurso do estúdio de terminais: abre numa aba da área
central, lê o disco pelo mesmo Rust do explorador, abre os documentos pelo
mesmo editor e se atualiza pelos mesmos observadores de arquivos. Não importa
pasta, não cadastra repositório e não usa nenhum serviço externo.

Veio do Ordinum Control, o protótipo interno de onde o estúdio foi extraído, com a mesma experiência. A referência de conceito foi o [MapMyRepo](https://github.com/vasu-devs/MapMyRepo),
lido no commit `21c3f3c` pelos autores do protótipo. O README dele declara MIT, mas o repositório não tem
arquivo `LICENSE` e a API do GitHub devolve licença nula, então nenhum código
veio de lá. O que ficou foi a ideia: árvore montada a partir de caminhos,
simulação de forças com a raiz fixa, expansão progressiva e foco animado. As
vistas, as ligações e as cores vieram depois, na decisão 076.

## Onde vive

| Parte | Caminho |
| --- | --- |
| Varredura por escopo, exclusões, leitura das ligações, cache, limites e cancelamento | `apps/desktop/src-tauri/src/workspace/docgraph.rs` |
| Comandos `docgraph_scan` e `docgraph_cancel` | `apps/desktop/src-tauri/src/commands.rs` |
| Hierarquia podada, contagens, diferença, expansão, cena, ligações por id e grupos de cor | `packages/ui/src/terminals/docgraph/model.js` |
| Árvore, Radial, Blocos, escolha dos Vizinhos e ligações na cena visível | `packages/ui/src/terminals/docgraph/views.js` |
| Simulação e projeção do 3D | `packages/ui/src/terminals/docgraph/space.js` |
| Modos de cor, paletas, faixas de tamanho e de data e regras | `packages/ui/src/terminals/docgraph/colors.js` |
| Valores aceitos de vista, escopo e profundidade, sem dependência | `packages/ui/src/terminals/docgraph/options.js` |
| Busca por nome e caminho | `packages/ui/src/terminals/docgraph/search.js` |
| Token por pedido, fila única e descarte de resposta atrasada | `packages/ui/src/terminals/docgraph/indexer.js` |
| Estado salvo por raiz | `packages/ui/src/terminals/docgraph/persist.js` |
| Disco de girassol, semente radial e simulações do Mapa e dos Vizinhos | `packages/ui/src/terminals/docgraph/layout.js` |
| Desenho de cada vista no canvas e acerto do ponteiro | `packages/ui/src/terminals/docgraph/renderer.js` |
| Ponteiro, roda, pinça, giro do 3D e teclado | `packages/ui/src/terminals/docgraph/interaction.js` |
| Controlador por sessão, observadores e rede de segurança | `packages/ui/src/terminals/docgraph/controller.js` |
| Aba virtual e pontos de entrada | `packages/ui/src/terminals/docgraph/tab.js` |
| Textos visíveis | `packages/ui/src/terminals/docgraph/copy.js` |
| Contadores e medidas | `packages/ui/src/terminals/docgraph/stats.js` |
| Cenários de demonstração | `packages/ui/src/terminals/docgraph/fixture.js` |
| Painel da aba, opções, legenda e o que fica por cima do canvas | `packages/ui/src/terminals/ui/DocGraphPane.jsx` e `DocGraphOverlays.jsx` |
| Câmera 2D, vinda do mapa do Ordinum Control | `packages/ui/src/terminals/docgraph/camera.js` |
| Estilos, só com tokens da casca | `packages/ui/src/views/Terminais.css`, seção do grafo |

## Como usar

| Ação | Como |
| --- | --- |
| Abrir o grafo | Botão de rede no cabeçalho da área de trabalho, ao lado do globo do Dev Browser, ⇧⌘D, ou Abrir o grafo da documentação na paleta ⌘K |
| Abrir já focado num item | Menu de contexto do explorador, em pastas e arquivos Markdown: Mostrar no grafo da documentação |
| Trocar de vista | Seletor de vista na barra, com o ícone e o nome da vista atual |
| Escolher o que entra e as cores | Botão Opções do grafo na barra: Arquivos lidos, Colorir por, Paleta, Links entre arquivos e, nos Vizinhos, os Passos a partir do foco |
| Expandir ou recolher pasta | Clique na pasta. A pasta recolhida é um disco cheio com o total de arquivos abaixo dela |
| Ver detalhes | Clique no nó. O cartão mostra nome, caminho, contagens e os links de saída e de entrada. Passar o ponteiro mostra nome e caminho |
| Abrir um documento para editar | Duplo clique, Enter ou Abrir no editor no cartão. O arquivo entra numa aba própria do editor |
| Ler um documento ao lado do grafo | ⌥Enter ou Visualizar no cartão. A prévia renderizada abre num painel ao lado do mapa, na mesma aba |
| Levar a prévia para uma janela separada | Botão de janela no cabeçalho da prévia. A divisão interna fecha, e Visualizar de novo a traz de volta |
| Revelar no explorador | Botão do cartão ou menu de contexto do nó |
| Buscar | Campo da barra, `/` ou ⌘F com o grafo em foco. Escolher um resultado expande as pastas do caminho, seleciona e centraliza |
| Ver o grafo local de um arquivo | Vista Vizinhos. O clique num arquivo o põe no centro |
| Girar o 3D | Arrastar gira a cena. Com Shift, arrastar desloca a câmera |
| Navegar | Arrastar o fundo desloca, a roda e a pinça dão zoom. No Mapa e nos Vizinhos, arrastar uma marca move o agrupamento; na Árvore, no Radial e nos Blocos, desloca a câmera. Na barra: mais e menos zoom, Ajustar à área, Centralizar na seleção, expandir e recolher tudo, Opções do grafo e Atualizar |

Teclado, com o grafo em foco:

| Tecla | Ação |
| --- | --- |
| ↑ e ↓ | Nó anterior e próximo, na ordem em que aparecem |
| ← | Recolhe a pasta ou sobe para a pasta mãe. Nos Vizinhos, nó anterior |
| → | Expande a pasta ou desce para o primeiro filho. Nos Vizinhos, próximo nó |
| Home e End | Primeiro e último nó |
| Enter | Abre o documento ou alterna a pasta |
| ⌥Enter | Abre a prévia do documento ao lado do grafo |
| Espaço | Alterna a pasta. Nos Vizinhos, põe no centro o arquivo selecionado |
| `+` e `-` | Zoom |
| `0` | Ajustar à área |
| `C` | Centralizar na seleção |
| `/` ou ⌘F | Foca a busca |
| ⇧F10 | Menu do nó |
| Esc | Limpa a busca e, depois, a seleção |

Nos Vizinhos as setas andam pela vizinhança sem mudar o foco, para a pessoa
escolher com calma; o clique e o Espaço mudam o foco.

## Vistas

Todas partem do mesmo índice e da mesma expansão: a pasta recolhida numa vista
está recolhida em todas. A vista fica salva por raiz, e trocar de vista enquadra
a câmera na geometria nova.

| Vista | O que mostra | Como é montada |
| --- | --- | --- |
| Mapa | A hierarquia por forças, com os arquivos de cada pasta num disco em volta dela | `d3-force` só nas pastas, arquivos em girassol |
| Árvore | Camadas da esquerda para a direita, com o nome da pasta à esquerda e o do arquivo à direita | `tree` do `d3-hierarchy`, linhas de 18 px e colunas de 210 px |
| Radial | A mesma hierarquia em anéis a partir da raiz, começando no topo e no sentido do relógio | `tree` do `d3-hierarchy` em ângulo e raio. O raio cresce com o número de folhas e com a profundidade |
| Blocos | Área proporcional aos bytes, para ver onde o projeto pesa. A pasta recolhida é um bloco só, com o total dela | `treemap` quadrado do `d3-hierarchy`, com piso de 256 bytes por arquivo e uma faixa de 16 px com o nome da pasta aberta que tem espaço para ele |
| Vizinhos | O arquivo em foco e os que ele cita ou que o citam, de um a três passos, com setas no sentido do link | Simulação de forças própria, até 300 arquivos. Num mesmo passo entram primeiro os mais ligados |
| 3D | A cena do Mapa em três eixos, com perspectiva, névoa pela profundidade e o mais perto desenhado por cima | `d3-force-3d`, projetado no próprio canvas 2D |

Árvore, Radial e Blocos não têm simulação: a posição sai inteira do layout, e
por isso o arraste sobre uma marca desloca a câmera em vez de mover a marca. Os
Blocos nascem do tamanho da área livre quando a vista abre, descontada a
legenda, para o nome de cada pasta caber em tamanho de texto. Mudar o tamanho
do painel depois só reenquadra.

O foco dos Vizinhos é o arquivo selecionado. Com uma pasta selecionada, é o
arquivo mais ligado dela; sem seleção, o mais ligado do projeto. Três avisos
cobrem os casos vazios: nenhum link entre os arquivos lidos, nenhum arquivo
ligado na pasta selecionada e um arquivo sem links de entrada nem de saída.
Quando o teto corta a vizinhança, o aviso diz quantos ficaram.

O 3D gira pela guinada e pela inclinação, que para em 1,45 rad para a cena não
virar de cabeça para baixo. A dica Arraste para girar fica na tela até o
primeiro toque. Não há WebGL: o 3D é desenhado no mesmo canvas 2D das outras
vistas, para não disputar contexto com os terminais.

Nenhuma vista sorteia posição. A mesma árvore desenha sempre o mesmo grafo.

## Decisões

### Regra de poda

No escopo Documentação, os nós são a união dos Markdown elegíveis com seus
ancestrais até a raiz. No Projeto inteiro a regra é a mesma, com todo arquivo
elegível. A varredura percorre o projeto inteiro e a poda acontece depois, no
webview, por função pura: uma pasta só vira nó quando algum arquivo a cita como
ancestral. Recolher uma pasta muda o que está à vista, nunca o índice nem as
contagens. A soma dos arquivos visíveis com os totais das pastas recolhidas dá
sempre o total do projeto.

### Raiz e identidade

A raiz é `session.explorer.root`, a mesma do explorador e do ⌘P. O id de um nó é
o caminho relativo com `/`, com a caixa e a forma Unicode do disco, e `.` para a
raiz. O caminho absoluto sai sempre da raiz como está no explorador, nunca da
raiz canonizada: o editor acha a aba já aberta comparando a string exata, e
`/private/tmp` no lugar de `/tmp` abriria uma segunda aba para o mesmo arquivo.

### O que entra e o que fica de fora

No escopo Documentação, só arquivos Markdown, com extensão `.md`, `.markdown`
ou `.mdx` em qualquer caixa, as mesmas que o editor abre como Markdown em
`kinds.js`. No Projeto inteiro, qualquer arquivo. Os dois escopos pulam as
pastas pesadas e geradas da busca por nome do explorador, como `.git`,
`node_modules`, `target`, `dist`, `build` e os caches, mais as ocultas geradas
por ferramenta, as que começam por `.venv`, `worktrees` dentro de pasta oculta
e toda pasta marcada com `CACHEDIR.TAG`. As demais ocultas são percorridas:
`.github`, `.claude` e parecidas guardam documentação de verdade.

O Projeto inteiro para em 20 mil arquivos. O corte é determinístico: a
varredura é em largura, com as subpastas de cada pasta em ordem, e uma pasta
cortada no meio fica com os primeiros nomes. A mesma árvore corta sempre no
mesmo lugar.

`.gitignore` não é aplicado. Os projetos da casa guardam documentação legítima
fora do Git, como `_INTERNO_ORDINUM/` e `AGENTS.md`, e ela precisa aparecer.

Pasta simbólica nunca é percorrida, o que também elimina ciclos. Arquivo
simbólico entra só quando o alvo é um arquivo regular dentro da raiz e, na
Documentação, só quando o nome é de Markdown. Alvo fora da raiz, link quebrado e
laço de links ficam de fora por regra, contados à parte, e não tornam a leitura
parcial.

### Leitura parcial

Pasta sem permissão, erro de leitura, profundidade acima de 64, teto de 400 mil
entradas, teto de 20 mil arquivos e prazo de 10 s marcam o resultado como
parcial. A barra mostra o aviso com a lista de ocorrências, e o nó ancestral
mais próximo ganha um ponto âmbar. Um projeto vazio com leitura incompleta
nunca aparece como projeto sem arquivos. Um índice completo não é trocado por
um que parou no teto ou no prazo: ele fica, marcado como desatualizado.

Raízes amplas, como `/`, `/Users`, `/Volumes` e a pasta do usuário, só são
varridas depois de Indexar mesmo assim. Acompanhar o diretório do terminal pode
levar a raiz para `~` com um `cd`.

### Ligações entre arquivos

Depois da varredura, o Rust lê o começo de cada arquivo de texto conhecido e
extrai o que ele referencia. Uma referência só vira ligação quando o alvo está
na lista de arquivos devolvida, então na Documentação só aparecem os links entre
Markdown.

| Arquivo | O que vira ligação |
| --- | --- |
| Markdown | Links e imagens em linha, definições de referência, wikilinks `[[nota]]` e `<img src>` e `<a href>` dentro do texto. Bloco cercado, código recuado, trecho de código e comentário HTML ficam de fora. `[x](docs/)` aponta para o `README.md` ou o `index.md` da pasta |
| MDX | O mesmo do Markdown e os `import` de componentes, resolvidos como JS |
| JS, TS, JSX, TSX, MJS, CJS, Vue e Svelte | `import`, `export from`, `require()` e `import()` com caminho relativo ou a partir da raiz. Pacote do `node_modules` não liga. A extensão e o `index` são procurados como o bundler faz |
| CSS, Sass, SCSS e Less | `@import`, `@use`, `@forward` e `url()`, com os parciais do Sass |
| HTML | `src` e `href`, fora de comentários |
| Python | `import` e `from import`, relativos ou a partir da raiz, da pasta `src`, da pasta do próprio arquivo ou da pasta do `pyproject.toml`, `setup.py` ou `setup.cfg` mais próximo |
| Rust | `mod` e `use crate`, `self` e `super`, seguindo os módulos em linha. `src/bin`, `examples`, `tests` e `benches` contam como raízes de crate |
| Go | `import` resolvido pelo `module` do `go.mod` mais longo que casa com o caminho |

Endereço com esquema, como `https:`, e o que aponta para fora da raiz não
ligam. `?` e `#` saem do caminho, e o resto é decodificado antes de resolver.

Tetos da leitura: 512 KiB do começo de cada arquivo, prazo de 3 s, 20 mil
arquivos lidos, 100 mil ligações e 256 MiB de referências na varredura. Por
arquivo, valem até 4.096 referências ou 64 KiB, somando o texto delas e 32
bytes por referência, e caminho acima de 1 KiB é descartado. Um `use` de Rust
com mais de 4.096 tokens é ignorado, a expansão dos grupos dele para em 64
segmentos ou 256 KiB copiados, e nada dentro de módulo em linha com mais de
64 níveis gera referência. Quando a leitura gasta o prazo todo, a resolução ainda tem até 1 s
para transformar em ligação o que foi lido. Uma leitura
interrompida por qualquer teto sai em `linksPartial`, aparece na barra como
Links incompletos e nunca marca a varredura como parcial: a lista de arquivos
continua completa. O grafo mantém as ligações da leitura anterior entre os
arquivos que continuam no índice, para as arestas não piscarem. Como o que foi
lido antes do prazo já está no cache, a leitura seguinte vai mais longe: ela
vem em 400 ms enquanto avança, até 30 rodadas, e depois volta à rede de
segurança.

O que cada arquivo referencia fica num cache em memória do registro de
varreduras, por raiz canonizada e caminho, validado por tamanho e data. A
próxima varredura relê só o que mudou, e duas sessões no mesmo projeto leem
cada arquivo uma vez. O cache tem 64 MiB para todas as raízes, contados como
os tetos por arquivo. Para caber o que chega, sai inteira a raiz usada há mais
tempo. Com a lista de arquivos completa, o cache esquece os que saíram dela.
Arquivo mudado há menos de 3 s vale na varredura, mas só entra no cache depois,
porque alguns discos guardam a data só em segundos. Uma varredura cancelada
grava no cache o que já tinha lido.

Arquivo simbólico não é lido e liga ao próprio alvo. A abertura também recusa
link posto no lugar do arquivo depois da listagem e não espera por FIFO nem
dispositivo. Arquivo que só existe na
nuvem entra na lista sem ser lido, porque a leitura o baixaria: os do OneDrive
sob demanda no Windows e os do iCloud ainda não baixados no macOS.

Na tela, cada ponta de uma ligação vai para o nó mais próximo que está à
vista: o próprio arquivo ou a pasta recolhida que o contém. Pares que caem no
mesmo nó somem, e pares repetidos viram um só, mais forte. Acima de 4 mil ficam
os mais fortes. As ligações que tocam a seleção ganham a cor de acento. O
botão Links entre arquivos, nas opções, liga e desliga o desenho delas.

### Layout e desenho

No Mapa, a simulação de forças do `d3-force` move só a raiz e as pastas. Os
arquivos diretos de cada pasta ficam num disco em espiral de girassol em volta
dela, e o raio do disco entra na colisão e na distância das ligações. Uma pasta
com 271 documentos vira uma constelação compacta, e criar ou remover um
documento só mexe no disco da própria pasta. As posições iniciais são
determinísticas, por setores proporcionais à quantidade de arquivos. A
simulação esfria e para: com a aba escondida não há laço, varredura,
temporizador nem observador. As outras vistas estão na seção Vistas.

O desenho é em canvas 2D. A forma diz o tipo: anel duplo para a raiz, círculo
para pasta, quadrado arredondado para arquivo. O preenchimento diz o estado:
disco cheio para pasta recolhida, anel vazado para expandida. O tamanho da
pasta recolhida cresce com o total dela. Os rótulos têm tamanho de tela
constante e aparecem conforme o zoom. Na Árvore e no Radial eles saem para os
lados; nas outras vistas, embaixo da marca. Nos Vizinhos e no 3D, um rótulo sem
lugar embaixo tenta a direita, a esquerda e em cima antes de ser omitido.

### Cor

A cor faz um trabalho de cada vez e nunca carrega a identidade sozinha: há
rótulo direto, legenda sempre presente, cartão de detalhes e busca.

| Colorir por | O que a cor diz | Como |
| --- | --- | --- |
| Grupo | O ramo que concentra os arquivos | Os grupos começam nas pastas de primeiro nível. Enquanto o maior grupo passar da metade dos arquivos e puder ser dividido, ele é trocado pelas subpastas |
| Pasta | A pasta de primeiro nível | O corte fica fixo no primeiro nível |
| Tipo de arquivo | A extensão | As quatro extensões mais comuns. Arquivo como `.gitignore` é o próprio nome |
| Tamanho | Até 1 KB, 10 KB, 100 KB, 1 MB e acima | Rampa de cinco degraus de um tom só |
| Data de alteração | Último dia, semana, mês, ano e mais antigo | A mesma rampa, com o mais recente no degrau mais forte |
| Regras próprias | O que a pessoa escolheu | Até oito buscas por caminho, de até 120 caracteres, cada uma com uma das 18 cores da organização. A primeira que combina dá a cor, e todas as palavras precisam aparecer, em qualquer ordem |

Grupo, Pasta e Tipo usam quatro vagas fixas: ciano, rosa, índigo e lima. O
restante usa o neutro, na legenda como Outras pastas ou Outros tipos. A cor
segue a entidade e fica salva por raiz e por modo: um grupo nunca é repintado,
e só vaga livre é reocupada. Reagrupar cores, nas opções, refaz a escolha.

A paleta decide o tom de cada vaga e da rampa, nunca a cor de uma regra:

| Paleta | Vagas | Validação com todos os pares, claro e escuro |
| --- | --- | --- |
| Segura, a padrão | Ciano, rosa, índigo e lima | Daltonismo com delta E de 10,3 e 8,5, visão normal de 19,5 e 19,8 |
| Neon | Ciano, rosa, roxo e laranja | Daltonismo com 10,3 e 8,5, visão normal de 15,4 e 15,9 |
| Pastel | Ciano, rosa, índigo e laranja clareados em 15% | Daltonismo com 8,2 no claro e 7,2 no escuro, visão normal de 16,1 e 16,7 |
| Monocromática | Todas no neutro | Sem identidade por cor. A legenda das categorias some, e a de tamanho, de data e de regras fica |

Os números saíram do validador de paleta da skill `dataviz`, sobre os 18 tons
de `lib/organization-colors.js`, contra as superfícies #ffffff e #1c1c1e. Num
diagrama de nós quaisquer duas marcas podem ficar lado a lado, então o
critério certo é todos os pares, e nele nenhum conjunto de cinco ou mais cores
passa. Sem o azul de acento, reservado a seleção e foco, e sem os tons que
coincidem com estado, só oito conjuntos de quatro passam nos dois temas, todos
com ciano e rosa. As rampas passam na checagem ordinal nos dois temas: um tom
só, degraus de pelo menos 0,06 em claridade e o degrau mais perto da
superfície com 2:1 contra ela.

### Estado

Por raiz canonizada, em `localStorage`, chave `cialai_terminals_docgraph`: o que o
usuário expandiu e recolheu, a visão da câmera, a seleção, a vista, o escopo, o
modo de cor, a paleta, a profundidade dos Vizinhos, as ligações ligadas ou
desligadas, as regras e as vagas de cada modo. Uma raiz só é gravada depois de
o usuário interagir com ela, e ficam as 24 mais recentes. Uma raiz nova herda
da última gravada a vista, o escopo, o modo de cor, a paleta, a profundidade e
as ligações; regras e vagas apontam para caminhos e ficam na raiz em que
nasceram. A aba aberta volta com a sessão. Posições dos nós e o giro do 3D
ficam em memória, no controlador da sessão, e sobrevivem à troca de aba e de
seção.

### Só no computador

Os comandos ficam fora da lista da ponte do celular, como o editor e o Dev
Browser.

### Prévia ao lado do mapa, não em outra aba

`Visualizar` abre a prévia renderizada num painel ao lado do grafo, dentro da
mesma aba, com a divisão em metades e um divisor arrastável. A proporção fica
em `docgraphRatio`, no mesmo armazenamento de layout das outras colunas, com
mínimo de 0,25 e máximo de 0,8.

A alternativa era abrir a aba do editor em modo de visualização, que é o que
`Abrir no editor` já faz. Ler um documento assim tira o mapa da tela, e o mapa
é justamente o que dá contexto a ele. As duas ações passam a ter significados
distintos e estáveis: editar abre o arquivo, ler abre a prévia.

O documento aberto mora na sessão, em `session.docgraph.preview`, e não no
painel, que desmonta a cada troca de aba. Por isso a prévia sobrevive a ir e
voltar, e por isso escolher outro documento troca o conteúdo do mesmo painel
em vez de empilhar painéis. Fechar devolve a área inteira ao grafo. Nada disso
mexe na seleção, no zoom nem na posição da câmera.

A janela separada é uma janela só, reaproveitada, criada pelo Rust em
`doc_preview_window` com a mesma página e `?docpreview=1`. O caminho não vai na
URL: fica no estado `DocPreviewState` e chega por `doc_preview_path` e pelo
evento `docpreview://path`. A janela tem capacidade própria em
`capabilities/doc-preview.json`, com o mínimo para ler um arquivo e abrir link
fora.

## Comandos e eventos

| Comando | Argumentos | Devolve |
| --- | --- | --- |
| `docgraph_scan` | `key`, `token`, `root` e `scope` opcional, `docs` ou `project` | `DocScan` com `root` como foi pedido, `canonicalRoot`, `scope`, `docs` de `relative`, `size`, `modifiedMs`, `symlink` e `target`, `dirs`, `visited`, `elapsedMs`, `partial`, `stopped`, `issues` de `relative` e `code`, `issuesTotal`, `excluded`, `links`, `linksPartial`, `linksRead` e `fingerprint` |
| `docgraph_cancel` | `key`, `token` opcional | Verdadeiro quando cancelou |
| `doc_preview_window` | `path` | Nada. Abre a janela da prévia ou traz a existente para a frente com o documento novo |
| `doc_preview_path` | Nenhum | Caminho que a janela da prévia deve mostrar, ou nada |

`key` é a sessão e `token` identifica o pedido. Um pedido novo da mesma chave
cancela o anterior no Rust. `scope` ausente ou desconhecido vale `docs`.
`links` são pares `[origem, alvo]` de posições na lista `docs`, ordenados, sem
repetição e sem arquivo ligado a si mesmo. `linksRead` conta os arquivos lidos
do disco nesta varredura, sem os que vieram do cache. A impressão digital
inclui o escopo e as ligações, para uma ligação nova redesenhar o grafo.

Erros chegam como `{ code, message }`: `invalid`, `not_found`, `denied`, `io` e
`cancelled`. Códigos de ocorrência: `denied`, `io` e `depth`. `stopped` vale
`limit` ou `timeout`.

O grafo não tem evento próprio no Rust. Ele ouve `fs://change`, o mesmo do
explorador e do editor. No webview, o runtime do estúdio emite o evento
`docgraph` com o identificador da sessão.

## Verificação

```bash
source /Volumes/ORDINUM-SSD/Build/cialai/env.sh
npm test
node --test packages/ui/scripts/check-docgraph.mjs
npx vite build --config apps/desktop/vite.config.js
```

`npm test` já inclui as duas suítes do grafo: `npm run test:desktop` roda,
entre os testes do Rust, os 59 do grafo que não são medida, e `npm run test:ui`
roda as 49 verificações de `check-docgraph.mjs`.

| Suíte | O que cobre |
| --- | --- |
| `workspace::docgraph` no Rust | O exemplo de `programas/azul`, `verde` e `vermelho`, os dois escopos, extensões, pastas ocultas, `CACHEDIR.TAG`, links simbólicos, permissões, tetos de entradas e de arquivos, prazo e profundidade, cancelamento com token, uma árvore de mil pastas com dez áreas documentadas, a extração e a resolução de cada linguagem, código recuado e comentários, os tetos da leitura, do `use` e dos módulos em linha, a leitura que recusa FIFO e link, o cancelamento que guarda o que leu e o orçamento do cache |
| `packages/ui/scripts/check-docgraph.mjs` | Poda, invariante das contagens ao recolher, diferença entre índices, renomeação, adoção de resposta, leitura parcial, busca, ligações por posição, cada vista, a projeção do 3D, os modos de cor, as paletas e as rampas, observadores, raízes amplas, persistência das opções, indexador, a demonstração e a regra de texto visível |
| `npm run check:i18n --workspace @cialai/ui` | As 191 chaves `terminal.docgraph.*` existem nos três idiomas, com os mesmos valores substituíveis, e todas são usadas |
| `npm run check:text` | Nenhum texto do grafo usa parênteses como aposto nem hífen, meia-risca ou travessão como separador |

A medida de tempo do Rust fica fora do `npm test` e lê um projeto de verdade:

```bash
cd apps/desktop/src-tauri
CIALAI_DOCGRAPH_BENCH_ROOT=/caminho/do/projeto cargo test -j 2 --lib docgraph_bench -- --ignored --nocapture
```

Conferência visual fora do app, com o Vite da raiz no ar por `npm run
dev:desktop`. O modo de demonstração desenha índices fixos, sem tocar no disco:

```
http://127.0.0.1:1420/?terminais=demo&docgraph=open&docgraph_case=real&editor=max&motion=0#terminais
```

`docgraph_case` aceita `real`, `small`, `empty`, `partial`, `error` e
`indexing`. `docgraph_sel` seleciona um nó e `docgraph_q` preenche a busca.
`docgraph_view`, `docgraph_scope`, `docgraph_color`, `docgraph_palette` e
`docgraph_depth` escolhem as opções, e `docgraph_refs=0` desliga as ligações. No
Projeto inteiro a demonstração acrescenta código e imports. A mesma URL desenha
sempre o mesmo grafo: nada é sorteado.

O medidor do painel fica em `packages/ui/src/terminals/docgraph/stats.js` e a
demonstração em `fixture.js`. As medidas de referência abaixo são do protótipo
de origem, antes das vistas e das ligações, e servem de ordem de grandeza para
o Mapa. Apple M4, macOS 27.0, build de desenvolvimento, janela de 1920 por
1080, num projeto com 979 documentos e 213 pastas, tudo expandido:

| Medida | Valor |
| --- | --- |
| Varredura no Rust | 19 a 60 ms, 4.657 entradas visitadas |
| Varredura com ida e volta pelo IPC | 27 a 63 ms |
| Montagem da árvore | 2 a 3 ms |
| Montagem da cena | 33 ms em média, 66 ms no máximo |
| Do clique à primeira pintura | 160 a 261 ms |
| Desenho | 1,1 ms em média, 2 ms no percentil 95, 4 ms no máximo |
| Rótulos por quadro | 32 em média, 91 no máximo |
| Passo da simulação | 0,9 ms em média, 2 ms no máximo |
| Acerto do ponteiro | 0,05 ms em média |
| Documento criado numa pasta à vista até o grafo | 141 a 493 ms |
| Ramo novo pela rede de segurança | 15 s com a janela à vista |
| Pedaço `engine` do pacote | 57,8 kB, 21,4 kB comprimido, carregado só ao abrir a aba |

Medidas desta versão, no mesmo Apple M4. A leitura vem da medida de tempo do
Rust no próprio repositório do Cialai, 3.287 entradas visitadas, com o cache de
cada escopo. O pacote vem do build de produção e de `npm run
check:performance`:

| Medida | Valor |
| --- | --- |
| Documentação, primeira varredura | 185 arquivos, 149 ligações, 185 lidos, 126 ms |
| Documentação, com o cache | nenhum lido, 12 ms |
| Projeto inteiro, primeira varredura | 2.741 arquivos, 2.143 ligações, 1.296 lidos, 499 ms |
| Projeto inteiro, com o cache | nenhum lido, 45 ms |
| Pedaço `engine` do pacote | 114,7 kB, 39,8 kB comprimido, carregado só ao abrir a aba |
| Pedaço do painel `DocGraphPane` | 41,4 kB, 12,9 kB comprimido, também só ao abrir a aba |
| Pacote de abertura do app | 759 KB comprimido, quando o teto era 760 KB |
| Tempo até ficar interativo | 999 ms, contra 947 ms do build anterior medido em seguida |

## Limitações reais

- **Eventos não cobrem tudo.** O kqueue vê mudanças diretas nas pastas
  observadas. Um arquivo criado num ramo ainda sem arquivos à vista aparece em
  até 15 s ou com Atualizar.
- **Quatro vagas de identidade.** Com mais de quatro grupos, pastas ou tipos,
  os demais ficam no neutro. É o que a paleta do produto sustenta sem
  confundir daltônicos. As regras usam qualquer uma das 18 cores, escolhidas
  pela pessoa, e por isso não passam pelo validador.
- **Pastel.** Fica no piso de daltonismo no tema escuro, e as marcas ficam
  abaixo de 3:1 de contraste no claro. Vale porque a legenda, os rótulos e a
  busca dizem o mesmo que a cor.
- **Tema escuro.** Os tons escuros das paletas ficam acima da banda de
  claridade que a skill `dataviz` sugere. Foram mantidos por serem os acentos
  já adotados, lidos também como texto.
- **Ligações por leitura de linha.** O extrator não compila nada. Alias de
  import, como os `paths` do `tsconfig.json` e os do bundler, caminho montado
  em tempo de execução e `include!` de Rust não ligam. Só os primeiros 512 KiB
  de cada arquivo são lidos.
- **Ligações só dentro da lista.** Na Documentação, um Markdown que cita um
  arquivo de código não desenha a ligação, porque o código não está no grafo.
- **Árvore grande.** Com perto de mil arquivos à vista, a Árvore enquadrada
  inteira fica perto de 4% de zoom. Os nomes dos grupos aparecem, e o resto
  pede zoom ou Recolher tudo.
- **Pasta trocada por link durante a leitura.** A abertura recusa link no
  último nome do caminho. Uma pasta do meio trocada por link entre a listagem
  e a leitura ainda é seguida.
- **Nomes fora do UTF-8** são pulados e contados.
- **Limite de descritores.** O teto de 32 pastas observadas existe porque o app
  empacotado abre no máximo 256 descritores. O `tauri dev` herda o limite do
  shell e não reproduz o problema.
- **Janela escondida.** Com a janela do app oculta o WebKit suspende os
  temporizadores, então o grafo não se atualiza nesse intervalo. Ao voltar, a
  releitura é imediata.
- **Verificação em navegador e no app.** As cinco passadas de navegador e a
  auto-verificação dentro do app existem no protótipo de origem e dependem de
  ferramentas dele. Aqui a cobertura automática é a do Rust e a de
  `check-docgraph.mjs`; a conferência visual é manual, pelo modo de
  demonstração.
- **Rótulos.** Um rótulo que cairia sobre outro, sobre a raiz ou sobre uma marca
  grande é omitido. Só os Vizinhos e o 3D procuram outra posição. Passar o
  ponteiro, selecionar ou aproximar mostra o nome.
- **Primeira pintura.** Ficou entre 160 e 261 ms no projeto de referência,
  contando o carregamento do motor. A meta inicial era 120 ms.
- **Só no computador.** A página do celular não abre o grafo: `docgraph_scan` e
  `docgraph_cancel` não entram na lista de comandos liberados da ponte.

## Roadmap

- Alias de import do `tsconfig.json` e dos bundlers mais comuns.
- Observador recursivo por FSEvents, para o primeiro arquivo de um ramo novo
  chegar na hora.
- Varredura por subárvore em projetos muito grandes.
- Compactação de cadeias de pasta com filho único.
- Grafo somente leitura no celular, hoje fora do escopo por ser recurso do computador, como o editor e o Dev Browser.
