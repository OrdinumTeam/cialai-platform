# Grafo da documentação

## Objetivo

Mostrar a documentação do projeto aberto numa sessão do estúdio de Terminais
como um grafo navegável. Cada arquivo Markdown do diretório é um nó, e só
aparecem as pastas necessárias para chegar até eles. Um projeto com mil pastas e
documentação em dez áreas mostra dez áreas e os caminhos até elas, nada mais.

É um recurso do estúdio de terminais: abre numa aba da área
central, lê o disco pelo mesmo Rust do explorador, abre os documentos pelo
mesmo editor e se atualiza pelos mesmos observadores de arquivos. Não importa
pasta, não cadastra repositório e não usa nenhum serviço externo.

Veio do Ordinum Control, o protótipo interno de onde o estúdio foi extraído, com a mesma experiência. A referência de conceito foi o [MapMyRepo](https://github.com/vasu-devs/MapMyRepo),
lido no commit `21c3f3c` pelos autores do protótipo. O README dele declara MIT, mas o repositório não tem
arquivo `LICENSE` e a API do GitHub devolve licença nula, então nenhum código
veio de lá. O que ficou foi a ideia: árvore montada a partir de caminhos,
simulação de forças com a raiz fixa, expansão progressiva e foco animado.

## Onde vive

| Parte | Caminho |
| --- | --- |
| Varredura de Markdown, exclusões, links, limites e cancelamento | `apps/desktop/src-tauri/src/workspace/docgraph.rs` |
| Comandos `docgraph_scan` e `docgraph_cancel` | `apps/desktop/src-tauri/src/commands.rs` |
| Hierarquia podada, contagens, diferença, expansão, cena e grupos de cor | `packages/ui/src/terminals/docgraph/model.js` |
| Busca por nome e caminho | `packages/ui/src/terminals/docgraph/search.js` |
| Token por pedido, fila única e descarte de resposta atrasada | `packages/ui/src/terminals/docgraph/indexer.js` |
| Estado salvo por raiz | `packages/ui/src/terminals/docgraph/persist.js` |
| Disco de girassol, semente radial e simulação | `packages/ui/src/terminals/docgraph/layout.js` |
| Desenho no canvas e acerto do ponteiro | `packages/ui/src/terminals/docgraph/renderer.js` |
| Ponteiro, roda, pinça e teclado | `packages/ui/src/terminals/docgraph/interaction.js` |
| Controlador por sessão, observadores e rede de segurança | `packages/ui/src/terminals/docgraph/controller.js` |
| Aba virtual e pontos de entrada | `packages/ui/src/terminals/docgraph/tab.js` |
| Textos visíveis | `packages/ui/src/terminals/docgraph/copy.js` |
| Contadores e medidas | `packages/ui/src/terminals/docgraph/stats.js` |
| Cenários de demonstração | `packages/ui/src/terminals/docgraph/fixture.js` |
| Painel da aba e o que fica por cima do canvas | `packages/ui/src/terminals/ui/DocGraphPane.jsx` e `DocGraphOverlays.jsx` |
| Câmera 2D, vinda do mapa do Ordinum Control | `packages/ui/src/terminals/docgraph/camera.js` |
| Estilos, só com tokens da casca | `packages/ui/src/views/Terminais.css`, seção do grafo |

## Como usar

| Ação | Como |
| --- | --- |
| Abrir o grafo | Botão de rede no cabeçalho da área de trabalho, ao lado do globo do Dev Browser, ⇧⌘D, ou Abrir o grafo da documentação na paleta ⌘K |
| Abrir já focado num item | Menu de contexto do explorador, em pastas e arquivos `.md`: Mostrar no grafo da documentação |
| Expandir ou recolher pasta | Clique na pasta. A pasta recolhida é um disco cheio com o total de documentos abaixo dela |
| Ver detalhes | Clique no nó. O cartão mostra nome, caminho e contagens. Passar o ponteiro mostra nome e caminho |
| Abrir um documento | Duplo clique, Enter ou Abrir no editor no cartão. ⌥Enter ou Visualizar abre já na visualização |
| Revelar no explorador | Botão do cartão ou menu de contexto do nó |
| Buscar | Campo da barra, `/` ou ⌘F com o grafo em foco. Escolher um resultado expande as pastas do caminho, seleciona e centraliza |
| Navegar | Arrastar o fundo desloca, a roda e a pinça dão zoom, arrastar uma marca move o agrupamento. Na barra: mais e menos zoom, Ajustar à área, Centralizar na seleção, expandir e recolher tudo, Reagrupar cores e Atualizar |

Teclado, com o grafo em foco:

| Tecla | Ação |
| --- | --- |
| ↑ e ↓ | Nó anterior e próximo, na ordem em que aparecem |
| ← | Recolhe a pasta ou sobe para a pasta mãe |
| → | Expande a pasta ou desce para o primeiro filho |
| Home e End | Primeiro e último nó |
| Enter | Abre o documento ou alterna a pasta |
| ⌥Enter | Abre o documento na visualização |
| Espaço | Alterna a pasta |
| `+` e `-` | Zoom |
| `0` | Ajustar à área |
| `C` | Centralizar na seleção |
| `/` ou ⌘F | Foca a busca |
| ⇧F10 | Menu do nó |
| Esc | Limpa a busca e, depois, a seleção |

## Decisões

### Regra de poda

Os nós são a união dos Markdown elegíveis com seus ancestrais até a raiz. A
varredura percorre o projeto inteiro e a poda acontece depois, no webview, por
função pura: uma pasta só vira nó quando algum documento a cita como ancestral.
Recolher uma pasta muda o que está à vista, nunca o índice nem as contagens. A
soma dos documentos visíveis com os totais das pastas recolhidas dá sempre o
total do projeto.

### Raiz e identidade

A raiz é `session.explorer.root`, a mesma do explorador e do ⌘P. O id de um nó é
o caminho relativo com `/`, com a caixa e a forma Unicode do disco, e `.` para a
raiz. O caminho absoluto sai sempre da raiz como está no explorador, nunca da
raiz canonizada: o editor acha a aba já aberta comparando a string exata, e
`/private/tmp` no lugar de `/tmp` abriria uma segunda aba para o mesmo arquivo.

### O que entra e o que fica de fora

Só arquivos com extensão `.md`, em qualquer caixa. A varredura pula as pastas
pesadas e geradas da busca por nome do explorador, como `.git`, `node_modules`,
`target`, `dist`, `build` e os caches, mais as ocultas geradas por ferramenta,
as que começam por `.venv`, `worktrees` dentro de pasta oculta e toda pasta
marcada com `CACHEDIR.TAG`. As demais ocultas são percorridas: `.github`,
`.claude` e parecidas guardam documentação de verdade.

`.gitignore` não é aplicado. Os projetos da casa guardam documentação legítima
fora do Git, como `_INTERNO_ORDINUM/` e `AGENTS.md`, e ela precisa aparecer.

Pasta simbólica nunca é percorrida, o que também elimina ciclos. Arquivo
simbólico `.md` entra só quando o alvo é um arquivo regular dentro da raiz. Alvo
fora da raiz, link quebrado e laço de links ficam de fora por regra, contados à
parte, e não tornam a leitura parcial.

### Leitura parcial

Pasta sem permissão, erro de leitura, profundidade acima de 64, teto de 400 mil
entradas e prazo de 10 s marcam o resultado como parcial. A barra mostra o
aviso com a lista de ocorrências, e o nó ancestral mais próximo ganha um ponto
âmbar. Um projeto vazio com leitura incompleta nunca aparece como projeto sem
Markdown. Um índice completo não é trocado por um que parou no teto ou no
prazo: ele fica, marcado como desatualizado.

Raízes amplas, como `/`, `/Users`, `/Volumes` e a pasta do usuário, só são
varridas depois de Indexar mesmo assim. Acompanhar o diretório do terminal pode
levar a raiz para `~` com um `cd`.

### Atualização

Os eventos são dica de latência, a releitura periódica é a garantia.

| Gatilho | Comportamento |
| --- | --- |
| Evento `fs://change` dentro da raiz | Nova varredura depois de 350 ms sem eventos, com espera máxima de 2 s |
| Pastas observadas pelo próprio grafo | A raiz e as pastas à vista, das mais rasas para as mais fundas, até 32. Cada pasta custa um descritor, e o limite do app empacotado é 256 |
| Rede de segurança | A cada 15 s, ou 25 vezes o tempo da última varredura quando isso for maior, só com a aba à vista |
| Foco da janela e volta da visibilidade | Releitura imediata |
| Botão Atualizar | Releitura imediata |

Uma releitura da mesma raiz nunca cancela a que está em andamento: fica uma
única na fila, para uma rajada de eventos não impedir que alguma termine. Só
troca de raiz, saída do painel e fim da sessão cancelam. Cada pedido leva um
token, e só a resposta do token corrente chega ao grafo. O resultado novo é
comparado com o anterior pela impressão digital do Rust: sem mudança, nada é
refeito nem redesenhado.

Recuperação quando os eventos falham: o kqueue só vê mudanças diretas nas pastas
observadas, então o primeiro Markdown de um ramo ainda sem documentação chega
pela rede de segurança, em até 15 s, ou na hora pelo botão Atualizar.

### Layout e desenho

A simulação de forças do `d3-force` move só a raiz e as pastas. Os documentos
diretos de cada pasta ficam num disco em espiral de girassol em volta dela, e o
raio do disco entra na colisão e na distância das ligações. Uma pasta com 271
documentos vira uma constelação compacta, e criar ou remover um documento só
mexe no disco da própria pasta. As posições iniciais são determinísticas, por
setores proporcionais à quantidade de documentos. A simulação esfria e para: com
a aba escondida não há laço, varredura, temporizador nem observador.

O desenho é em canvas 2D. A forma diz o tipo: anel duplo para a raiz, círculo
para pasta, quadrado arredondado para documento. O preenchimento diz o estado:
disco cheio com o total para pasta recolhida, anel vazado para expandida. Os
rótulos têm tamanho de tela constante e aparecem conforme o zoom.

### Cor

A cor marca o agrupamento e nunca carrega a identidade sozinha: há rótulo direto
na pasta de cada grupo, legenda sempre presente e o cartão de detalhes.

Os tons saíram do validador de paleta da skill `dataviz` sobre os 18 tons de
`lib/organization-colors.js`. Em todos os pares, que é o critério certo para um
diagrama de nós, a paleta inteira falha. Sem o azul de acento, reservado a
seleção e foco, e sem os tons que coincidem com estado, o maior conjunto que
passa em daltonismo e em visão normal nos dois temas tem quatro tons: ciano,
rosa, índigo e lima. O restante usa o neutro, na legenda como Outras pastas.

Os grupos começam nas pastas de primeiro nível. Enquanto o maior grupo passar da
metade dos documentos e puder ser dividido, ele é trocado pelas subpastas. A cor
segue a entidade e fica salva por raiz: um grupo nunca é repintado, e só vaga
livre é reocupada. Reagrupar cores refaz a escolha.

### Estado

Por raiz canonizada, em `localStorage`, chave `cialai_terminals_docgraph`: o que o
usuário expandiu e recolheu, a visão da câmera, a seleção e os tons. Uma raiz só
é gravada depois de o usuário interagir com ela, e ficam as 24 mais recentes. A
aba aberta volta com a sessão. Posições dos nós ficam em memória, no controlador
da sessão, e sobrevivem à troca de aba e de seção.

### Só no Mac

Os comandos ficam fora da lista da ponte do iPhone, como o editor e o Dev
Browser.

## Comandos e eventos

| Comando | Argumentos | Devolve |
| --- | --- | --- |
| `docgraph_scan` | `key`, `token`, `root` | `DocScan` com `root` como foi pedido, `canonicalRoot`, `docs` de `relative`, `size`, `modifiedMs`, `symlink` e `target`, `dirs`, `visited`, `elapsedMs`, `partial`, `stopped`, `issues` de `relative` e `code`, `issuesTotal`, `excluded` e `fingerprint` |
| `docgraph_cancel` | `key`, `token` opcional | Verdadeiro quando cancelou |

`key` é a sessão e `token` identifica o pedido. Um pedido novo da mesma chave
cancela o anterior no Rust. Erros chegam como `{ code, message }`: `invalid`,
`not_found`, `denied`, `io` e `cancelled`. Códigos de ocorrência: `denied`,
`io` e `depth`. `stopped` vale `limit` ou `timeout`.

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

`npm test` já inclui as duas suítes do grafo: `npm run test:desktop` roda os 24
testes do Rust e `npm run test:ui` roda as 29 verificações de
`check-docgraph.mjs`.

| Suíte | O que cobre |
| --- | --- |
| `workspace::docgraph` no Rust | O exemplo de `programas/azul`, `verde` e `vermelho`, extensões, pastas ocultas, `CACHEDIR.TAG`, links simbólicos, permissões, tetos de entradas, prazo e profundidade, cancelamento com token e uma árvore de mil pastas com dez áreas documentadas |
| `packages/ui/scripts/check-docgraph.mjs` | Poda, invariante das contagens ao recolher, diferença entre índices, renomeação, adoção de resposta, leitura parcial, busca, cores, observadores, raízes amplas, persistência, indexador e a regra de texto visível |
| `npm run check:i18n --workspace @cialai/ui` | As chaves `terminal.docgraph.*` existem nos três idiomas, com os mesmos valores substituíveis, e todas são usadas |
| `npm run check:text` | Nenhum texto do grafo usa parênteses como aposto nem hífen, meia-risca ou travessão como separador |

Conferência visual fora do app, com o Vite da raiz no ar por `npm run
dev:desktop`. O modo de demonstração desenha índices fixos, sem tocar no disco:

```
http://127.0.0.1:1420/?terminais=demo&docgraph=open&docgraph_case=real&editor=max&motion=0#terminais
```

`docgraph_case` aceita `real`, `small`, `empty`, `partial`, `error` e
`indexing`. `docgraph_sel` seleciona um nó e `docgraph_q` preenche a busca. A
mesma URL desenha sempre o mesmo grafo: nada é sorteado.

O medidor do painel fica em `packages/ui/src/terminals/docgraph/stats.js` e a
demonstração em `fixture.js`. As medidas de referência abaixo são do protótipo
de origem, no mesmo código, e servem de ordem de grandeza até existir medição
neste repositório. Apple M4, macOS 27.0, build de desenvolvimento, janela de
1920 por 1080, num projeto com 979 documentos e 213 pastas, tudo expandido:

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

## Limitações reais

- **Eventos não cobrem tudo.** O kqueue vê mudanças diretas nas pastas
  observadas. Um documento criado num ramo ainda sem documentação aparece em até
  15 s ou com Atualizar.
- **Quatro tons.** Com mais de quatro agrupamentos grandes, os demais ficam no
  neutro. É o que a paleta do produto sustenta sem confundir daltônicos.
- **Tema escuro.** Os tons escuros da paleta ficam acima da banda de claridade
  que a skill `dataviz` sugere. Foram mantidos por serem os acentos já adotados.
- **Só `.md`.** `.markdown` e `.mdx` ficam de fora.
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
  grande é omitido, sem procurar outra posição. Passar o ponteiro, selecionar ou
  aproximar mostra o nome.
- **Primeira pintura.** Ficou entre 160 e 261 ms no projeto de referência,
  contando o carregamento do motor. A meta inicial era 120 ms.
- **Só no computador.** A página do celular não abre o grafo: `docgraph_scan` e
  `docgraph_cancel` não entram na lista de comandos liberados da ponte.

## Roadmap

- Relações por links entre Markdown, por cima da hierarquia física.
- Observador recursivo por FSEvents, para o primeiro Markdown de um ramo novo
  chegar na hora.
- Varredura por subárvore em projetos muito grandes.
- Extensões `.markdown` e `.mdx`.
- Compactação de cadeias de pasta com filho único.
- Grafo somente leitura no celular, hoje fora do escopo por ser recurso do computador, como o editor e o Dev Browser.
