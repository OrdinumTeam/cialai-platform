# Design e marca

O Cialai mantém o sistema visual do estúdio do Control, com seus tokens, primitivas, movimento e dimensões, e troca a marca Ordinum pela identidade Cialai da louva-a-deus orquídea. A paleta das sessões e o tema ANSI do terminal não mudam.

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| Marca, acento e gradiente | Implementado | `brand.css`, splash e superfícies Cialai passam no check de marca |
| Tema ANSI e paleta das sessões | Implementado | Azul semântico e dezoito ids foram preservados e testados |
| Ícones desktop e móvel | Implementado | `tools/brand/build-app-icons.mjs` gera as três fontes a partir da marca branca: a opaca do iOS, a do desktop e o primeiro plano adaptativo do Android; lançadores reais não foram conferidos |
| Tipografia, movimento e dimensões | Implementado | Valores foram preservados na interface compartilhada e nas capturas macOS |
| Regras de texto da interface | Implementado | Checks de interface e revisão dos materiais cobrem os textos atuais |
| Interface em três idiomas | Implementado | Português do Brasil, inglês e espanhol neutro têm dicionários com paridade |
| Capturas de paridade no macOS | Implementado | Comparações claro, escuro, Dev Browser e quatro estados móveis estão em `docs/evidence/task-1.11` |
| Tokens e componentes do celular | Preparado | Tokens semânticos, componentes e barra inferior de cinco abas no aplicativo nativo; tokens `--phone-*` e primitivas na página do celular; testes de unidade passam, conferência em aparelho pendente de novo build nativo |
| Início do celular | Preparado | Saudação, uso dos agentes, carrossel de computadores, projetos com favoritos e ações rápidas sobre a fundação, pela decisão 046; testes passam, conferência em aparelho pendente |
| Computadores e Terminais do celular | Preparado | Computadores nativo com filtros, busca, card ativo e folha de ações; seletor de computador na barra da página; lista de Terminais com busca, filtros, cards compactos por fase, esqueletos, Nova sessão no rodapé e menu agrupado com confirmação ao encerrar e reiniciar; testes passam e a lista foi conferida em captura Playwright de 393 por 852, conferência em aparelho pendente |
| Demais telas do celular no visual das referências | Pendente | Nova sessão, Agentes, Ajustes e terminal serão refeitos nas próximas etapas |
| Capturas Linux, Windows e lojas | Pendente | Dependem das implementações integradas, builds nativos e tamanhos exigidos pelas lojas |
| Desktop na linguagem do celular | Preparado | Em 18/10/2026: superfícies sólidas, Outfit, raios de 8 a 24, assinatura oficial na lateral e na abertura, tom e ícone por sessão e anel semanal na barra de IA. Testes de unidade e checks de navegador passam e as telas foram conferidas em capturas do servidor de desenvolvimento; app nativo, build e checks de produção pendentes |

## Fontes da marca

| Item | Valor |
| --- | --- |
| Pasta | `$MARCA/brand/logo` |
| Marca em iteração | `cialai-mantis-v4-1.png` é a versão mais recente em 12/09/2026, busto da louva-a-deus sobre uma orquídea de cinco pétalas; os prompts `prompt-v2a*.txt`, `prompt-v3-*.txt` e `prompt-v4-*.txt` registram a evolução. A execução usa o arquivo mais novo aprovado na pasta e não fixa este nome |
| Linguagem | Vetor plano, só preenchimentos sólidos, sem gradiente, sombra, textura ou contorno, formas separadas por vãos brancos, simetria bilateral, legível a 32 px |
| Paleta, contrato fixo em todas as iterações | Magenta profundo `#E23B84`; rosa quente `#FF7AB2`; rosa pálido `#FFD6E6`; ameixa `#3A1B33` só para antenas e boca; branco puro para vãos e fundo |
| Assinatura | O nome tem lettering próprio, desenhado com a mesma mão do símbolo, e só aparece pela assinatura oficial, `brand/logo/cialai-lockup-1-4k.png`; nunca escrito numa fonte ao lado do símbolo |

## Aplicação da marca na interface

| Lugar | Control | Cialai |
| --- | --- | --- |
| Acento | `--mac-accent #1a4fa0` claro e `#4a8ae6` escuro | `--mac-accent #E23B84` claro e `#FF7AB2` escuro; `--mac-accent-hover #c9317a` claro e `#ff8fc0` escuro; `--mac-accent-soft-hover rgba(226,59,132,.14)` claro e `rgba(255,122,178,.24)` escuro |
| Sidebar | Gradiente da marca Ordinum em azuis | Rosa sólido, `#FCEBF3` no claro e o ameixa `#31182C` no escuro, com texto e ícones em ameixa no claro e em rosa claro no escuro; item ativo e cards do rodapé em placa branca no claro e `#4A2443` no escuro, com ícone e texto no rosa; assinatura oficial no topo, com 120 px, nas cores no claro e com as letras em branco no escuro. Com a lateral fechada, só o lettering da assinatura, sem a cabeça, passa para a toolbar, ao lado do botão que a reabre, com 15 px de altura e 60 por cento de opacidade, separado do título por um fio |
| Bloco de destaque, número principal | Azul Ordinum | Magenta |
| Ícone do app | Marca Ordinum em fundo navy | Cabeça do louva-a-deus em cores sobre placa branca arredondada, com a arte a 87,6 por cento da altura da placa. No iPhone e no Android a placa ocupa o quadro inteiro, porque quem recorta é o sistema, e no iOS o arquivo é opaco, sem alfa. No macOS, Windows e Linux a placa recua para a grade do sistema, 824 de 1024 px, com margem transparente. No Android o primeiro plano é só a arte, na zona segura, sobre fundo `#FFFFFF` |
| Splash | Marca Ordinum | Assinatura oficial centralizada com 220 px, nas cores no claro e com as letras em branco no escuro, e barra de progresso rosa sólida; a tela estática de `apps/desktop/index.html` mostra a mesma peça escura sobre o ameixa antes do bundle |
| Diálogo Vincular celular | Não existe | QR em preto sobre branco, sem tingir, com a marca pequena acima e o nome do computador; nunca colorir o QR |
| Ponto de estado do túnel | Não existe | Verde conectado, âmbar reconectando, cinza sem rede, vermelho falha, com os tokens `--mac-ok`, `--mac-warn` e `--mac-bad` |
| Cabeçalho do celular | "Ordinum Control" | Nome do desktop e ponto do túnel |
| Textos | Ordinum Control, Mac, Finder | Cialai, computador, e o nome do gerenciador de arquivos da plataforma |

Tokens novos declarados em `packages/ui/src/desktop/brand.css`: `--cialai-magenta`, `--cialai-pink`, `--cialai-blush`, `--cialai-plum`, `--cialai-white`. Os tokens `--mac-*` continuam sendo os que os componentes consomem; `brand.css` só redefine acento, gradiente e cores de marca.

## Superfícies sólidas do desktop

Desde 18/10/2026 o desktop segue a linguagem do aplicativo do celular, a mesma de `apps/mobile/src/ui/tokens.ts`: fundos e superfícies sólidos, formas arredondadas e componentes encorpados, sem gradiente, brilho ou vidro com desfoque. A camada é `packages/ui/src/desktop/solid.css`, importada depois de `brand.css` e antes do estúdio, toda sob `html[data-shell="desktop"]`. A página web do celular carrega a casca e a marca, mas nunca marca a casca desktop, então não muda.

| Token | Claro | Escuro |
| --- | --- | --- |
| Fundo, `--mac-bg` | `#F8FAFF` | `#0E0E10` |
| Lateral, `--mac-sidebar-bg` | `#FCEBF3` | `#31182C` |
| Superfície, `--mac-surface` | `#FFFFFF` | `#1C1C1E` |
| Superfície suave, `--mac-surface-2`, também o fundo do terminal | `#F2F4F9` | `#26262A` |
| Fio, `--mac-separator` | `#E7EAF2` | `rgba(84,84,88,.45)` |
| Texto, `--mac-label` e `--mac-label-2` | `#20232C` e `#666D7C` | `#F5F5F7` e `#AEAEB2` |
| Texto de destaque, `--mac-accent-text` | `#C73474`, o magenta escurecido até 4,5:1 | `#FF7AB2` |
| Texto sobre o acento cheio, `--mac-on-accent` | `#FFFFFF` | `#3A1B33` |

Raios de 8 nos chips, 10 nos controles densos, 12 em botões e campos, 16 nos cards da lista, 20 em painéis e popovers, 24 nos modais e 999 nas pílulas. A única sombra é a do card no claro, `0 4px 14px rgba(27,35,64,.05)`; popovers e modais levam um fio e a sombra de flutuação. Os tokens de gradiente da casca viram cor sólida no desktop, para o que ainda os usar ficar chapado. O fundo é sólido também no macOS: a janela continua transparente no Tauri e a página pinta por cima do vibrancy.

Botão primário em acento sólido, secundário em superfície suave, campos preenchidos sem borda com anel de foco rosa, segmentado com o escolhido em rosa sólido, Ajustes em grupos de raio 20 com a aparência em três blocos, como no celular. O estado vazio do estúdio mostra os projetos recentes em cards com a capa colorida da lista de projetos do celular. A densidade continua a do computador: controles de 28 a 36 px, colunas e atalhos preservados, e o terminal com a monoespaçada de cada sistema.

## Regra do azul no terminal

Em `terminals/theme.js` do Control o `blue` e o `brightBlue` do xterm saem de `--mac-accent`. Com o acento magenta, o ANSI azul seria pintado de rosa. No Cialai o tema define `blue: '#1a4fa0'` no claro e `'#4a8ae6'` no escuro, os valores do tom `azul` da paleta das sessões, e `brightBlue` com os mesmos valores; a seleção continua em `--mac-accent-soft-hover` e o cursor continua na cor do texto. Vermelho, verde e amarelo continuam em `--mac-bad`, `--mac-ok` e `--mac-warn`.

## Tokens mantidos

Valores de `frontend/src/desktop/macos.css` no Control, que `shell.css` preserva.

| Token | Claro | Escuro |
| --- | --- | --- |
| `--mac-label` | `#1d1d1f` | `#f5f5f7` |
| `--mac-bg`, `--mac-surface` | `#ffffff` | `#1c1c1e` |
| `--mac-surface-2` | `#f5f6f8` | `#26262a` |
| `--mac-separator` | `rgba(0,0,0,.07)` | `rgba(255,255,255,.08)` |
| `--mac-separator-strong` | `rgba(0,0,0,.12)` | `rgba(255,255,255,.15)` |
| `--mac-ok` | `#1f9d5b` | `#3ccf76` |
| `--mac-warn` | `#c27a00` | `#f0a629` |
| `--mac-bad` | `#d83a3a` | `#ff5c5c` |
| `--mac-neutral-bg` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.08)` |
| `--mac-ease` | `cubic-bezier(.2,.7,.2,1)` | igual |
| `--mac-font-mono` | `"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace` no macOS; por sistema no documento 04 | igual |

Escala tipográfica, espaçamentos de 4, 8, 12, 16, 20, 24, 32 e 40 conforme `docs/application/design-system.md` do Control. Os raios do desktop seguem o celular desde 18/10/2026, na seção Superfícies sólidas do desktop; os valores acima de superfícies e neutros são os da página do celular e da base herdada.

Tokens do estúdio em `views/Terminais.css:13-39`, mantidos: `--terminais-editor-line`, `--terminais-editor-match`, `--terminais-editor-search` e os `--terminais-syn-*` de keyword, string, number, comment, function, type, property, tag e regexp, nos dois modos. O `--terminais-editor-line` e o `--terminais-editor-match` derivam do acento e passam a usar o magenta com as mesmas opacidades.

## Tema do terminal

| Chave | Claro | Escuro |
| --- | --- | --- |
| Fundo, `cursorAccent` | `--mac-surface-2` | `--mac-surface-2` |
| Texto, cursor | `--mac-label` | `--mac-label` |
| Seleção | `--mac-accent-soft-hover` | `--mac-accent-soft-hover` |
| Seleção inativa | `--mac-neutral-bg` | `--mac-neutral-bg` |
| `black`, `brightBlack` | `#1d1d1f`, `#6e6e73` | `#2f2f34`, `#8e8e93` |
| `red`, `brightRed` | `--mac-bad` | `--mac-bad` |
| `green`, `brightGreen` | `--mac-ok` | `--mac-ok` |
| `yellow`, `brightYellow` | `--mac-warn` | `--mac-warn` |
| `blue`, `brightBlue` | `#1a4fa0`, `#4a8ae6` | `#4a8ae6`, `#5f9aeb` |
| `magenta`, `brightMagenta` | `#8a3fb2`, `#a55ad0` | `#c67de8`, `#d9a0f2` |
| `cyan`, `brightCyan` | `#0f7f8c`, `#1a9aa8` | `#3fc1cf`, `#66d3de` |
| `white`, `brightWhite` | `#d2d2d7`, `#f5f6f8` | `#d8d8dc`, `#f5f5f7` |

Opções do xterm: 120 por 32 iniciais, altura de linha 1,15, pesos 400 e 600, 8000 linhas, sensibilidade 2 com aceleração de 2 a 8, cursor piscando, tamanho 12 no celular e de 10 a 20 no desktop. Padding do host `8px 2px 6px 10px`. Objeto de tema novo a cada chamada e observação de `data-theme`, como em `theme.js`.

O terminal não tem moldura. O viewport do xterm, que aparece no respiro e abaixo da última linha, e a caixa de composição do IME usam o mesmo fundo do tema no desktop e no celular, em vez do preto do CSS da biblioteca. A regra vence por especificidade, porque o CSS do xterm chega depois no build. Onde os tokens da casca não existem, como na página do celular, as reservas são `#f5f6f8` no claro e `#26262a` no escuro, as mesmas de `theme.js`. As decorações da busca na saída recebem cores opacas em hex compostas sobre esse fundo, porque o xterm não aceita `var()` nem transparência nelas.

## Paleta das sessões

Dezoito tons de `lib/organization-colors.js`, cada um com versão clara e escura, ids intocados para sessões gravadas manterem a cor. Sessão nova começa sem cor.

| Id | Rótulo | Claro | Escuro |
| --- | --- | --- | --- |
| `azul` | Azul | `#1a4fa0` | `#4a8ae6` |
| `verde` | Verde | `#1f9d5b` | `#3ccf76` |
| `ciano` | Ciano | `#0891b2` | `#22d3ee` |
| `roxo` | Roxo | `#7c3aed` | `#a78bfa` |
| `rosa` | Rosa | `#db2777` | `#f472b6` |
| `laranja` | Laranja | `#ea580c` | `#fb923c` |
| `amarelo` | Amarelo | `#b7791f` | `#facc15` |
| `vermelho` | Vermelho | `#dc2626` | `#f87171` |
| `cinza` | Cinza | `#6b7280` | `#9ca3af` |
| `indigo` | Índigo | `#4338ca` | `#818cf8` |
| `marinho` | Marinho | `#1e3a8a` | `#8da2fb` |
| `turquesa` | Turquesa | `#0f766e` | `#2dd4bf` |
| `menta` | Menta | `#059669` | `#6ee7b7` |
| `lima` | Lima | `#4d7c0f` | `#a3e635` |
| `ambar` | Âmbar | `#b45309` | `#fbbf24` |
| `coral` | Coral | `#e11d48` | `#fb7185` |
| `magenta` | Magenta | `#a21caf` | `#e879f9` |
| `lavanda` | Lavanda | `#7c6fcd` | `#c7bfff` |

### Tom da sessão

A cor escolhida para um card substitui o rosa em tudo que pertence àquela sessão: o card, o cabeçalho da área de trabalho, o explorador e o menu aberto a partir dela. Isso inclui botões e ícones de ação, o nome do agente, o percentual de uso do plano, o fio de seleção, o foco, os fundos suaves e o hover. Fora do card, o tom aparece também no fio de 1,5 px do terminal quando ele tem o teclado, no cursor e na seleção do terminal, no ícone e na linha ativa da sessão na paleta de busca, nos avisos que uma sessão manda, com o ícone dela e uma faixa de 4 px, e na Barra de IA, que segue a sessão selecionada. Sem cor, o tom é o rosa do Cialai.

A resolução fica em `packages/ui/src/terminals/session-accent.js`. Para cada tema ele devolve a base da paleta, o texto, que é a base escurecida no claro ou clareada no escuro até 4,5:1 contra a superfície e a superfície suave, o texto sobre a base cheia, branco ou ameixa, e as variantes suave, hover, anel e fio. As variáveis `--session-*` vão inline em cada elemento com a classe `session-scope`, e dentro dele os tokens de acento da casca apontam para o tom da sessão. Duas sessões com cores diferentes nunca dividem o mesmo tom. Aviso, erro e sucesso continuam nos tokens semânticos. No terminal só o cursor e a seleção seguem o tom; texto, fundo e cores ANSI são os mesmos para todas as sessões, então a saída das CLIs e o realce de sintaxe não mudam de cor.

Card da lista: superfície sólida de raio 16, com o ícone da sessão solto antes do nome, sem placa nem fundo, e o indicador de atividade na linha do estado escrito. Todo card tem uma barra de 4 px na borda esquerda, sempre à vista, na cor da sessão ou no rosa quando ela não tem cor. Selecionado, fundo com 9 por cento do tom e fio no tom. Barras de atividade de 2 px no tom, animação `terminaisBars` de 1,1 s escalonada em 0,18 e 0,36 s, desligada com menos movimento.

### Ícone da sessão

Cada sessão pode receber um ícone de linha, da mesma biblioteca do resto da interface, entre os 30 de `packages/ui/src/terminals/session-icons.js`. Sem escolha, o ícone padrão é o glifo do Claude ou do Codex quando um deles roda na sessão, ou o terminal. O ícone aparece antes do nome no card e no cabeçalho, sem placa, sempre no tom da sessão, e nunca substitui a marca do provedor nos indicadores de conta e de consumo. A escolha fica no menu "Cor e ícone" da sessão e na faixa Personalizar do seletor de pasta da sessão nova; no celular, na mesma folha da cor e na etapa de configuração da sessão nova. O campo `icon` é gravado com a sessão no armazenamento local e viaja ao Rust na apresentação do card, então sobrevive à reabertura e chega ao celular.

### Quando o indicador de atividade anima

As três barras significam processamento acontecendo agora. Fora disso o indicador é um ponto parado. A decisão é de `packages/ui/src/terminals/activity-state.js`, função `deriveActivity`, e vale igual no card da lista, no cabeçalho do computador e no cabeçalho do celular, que usam o mesmo componente `ActivityIndicator`.

| Situação | Código | Indicador |
| --- | --- | --- |
| Agente com turno em andamento | `agent-busy` | Barras animadas |
| Agente parou para perguntar | `agent-waiting` | Ponto, tom de atenção |
| Agente terminou o turno | `agent-done` | Ponto |
| Agente aberto sem turno | `agent-idle` | Ponto |
| Processo sem sinal próprio, com saída recente ou CPU acima do piso | `active` | Barras animadas |
| Processo sem sinal próprio, quieto | `open` | Ponto apagado |
| Processo parado por sinal | `stopped` | Ponto, tom de atenção |
| Shell no prompt | `idle` | Ponto |

Três regras fecham o comportamento. Um agente reconhecido decide sozinho, e nem saída nem CPU o contradizem. Silêncio nunca vira concluído: um `sleep 300` aparece como processo aberto, não como terminado. E sem amostra nova de `pty_metrics` desde a conexão atual nada anima, o que impede uma sessão de continuar respirando depois que a ponte cai.

### Painel recolhido

Uma coluna recolhida sai da tela por `display: none`, então o único vestígio dela é a faixa da lateral. A faixa tem 28 px de largura mínima, é inteira clicável e leva o ícone do par correspondente com 16 px no topo, `PanelLeftOpen` à esquerda e `PanelRightOpen` à direita, mais um resumo do que está escondido: nas sessões o total e o selo de avisos pendentes, nos arquivos o total de alterações do Git. A dica traz o nome do painel e o atalho, e o alvo declara `aria-expanded` e `aria-controls`.

A largura não anima, pela regra de movimento acima: recolher e reabrir é troca de layout, não transição. Além da faixa, o cabeçalho da área de trabalho tem dois alternadores sempre visíveis, sessões à esquerda e arquivos à direita, com `aria-pressed`, para o caminho de volta estar sempre no mesmo lugar. Na primeira vez que cada coluna é recolhida, um aviso diz onde reabri la; a marca fica no mesmo registro de layout e o aviso não volta. No modo foco a faixa fica discreta e o resumo some, mas o alvo continua alcançável por teclado.

## Anéis da barra de IA

Cada conta tem um anel de 40 px com o glifo do provedor no centro. O anel externo, com traço de 3, é o da janela de sessão, a de 5 horas no Claude e a janela curta no Codex. Desde 18/10/2026 um anel interno, com o mesmo traço de 3, a mesma trilha e 2 px de folga, mostra o uso semanal: no Claude a janela "Todos os modelos", `weekly_all`; no Codex a janela longa, só quando ela tem a duração de uma semana informada pela integração. Os dois seguem a mesma convenção: arco a partir das 12 horas, no sentido horário, com a cor da banda de uso, e um ponto em 0%.

A decisão está em `weeklyState`, de `packages/ui/src/notch/model.js`, e vem só dos dados que chegaram, nunca do nome ou do preço do plano.

| Estado | Quando | Desenho |
| --- | --- | --- |
| `available` | Há janela semanal com fração, inclusive 0 | Trilha mais apagada que a externa e arco |
| `none` | Há leitura e ela não traz janela semanal, ou a janela longa não é de uma semana, como a mensal | Só o anel da sessão |
| `unknown` | Ainda sem leitura, erro, login pendente ou janela longa sem duração | Trilha tracejada, sem arco |

A barra inteira fica no tom da sessão selecionada no estúdio: anéis, pontos da barra recolhida e barras do popover, em todas as contas, rode ou não um agente naquela sessão. Sessão sem cor deixa a barra no rosa. As bandas de atenção e de limite continuam no âmbar, a partir de 60 por cento, e no vermelho, a partir de 80, por padrão.

A célula descreve os dois anéis para o leitor de tela, com o nome de cada janela, o percentual usado e a renovação, e o popover marca qual linha é o anel externo e qual é o interno. O popover abre também pelo foco do teclado. Os alertas de proximidade continuam valendo só para a janela do anel externo.

## Tipografia por sistema

Desde 18/10/2026 a interface do desktop usa a Outfit do site e do celular, empacotada em `packages/ui/src/fonts`, em todos os sistemas, com a fonte de cada sistema abaixo como reserva. O terminal continua com a monoespaçada de cada sistema.

| Sistema | Interface, reserva | Mono |
| --- | --- | --- |
| macOS | `-apple-system`, sistema | `"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace` |
| Windows | `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` | `"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace` |
| Linux | `system-ui, "Inter", Cantarell, Ubuntu, "Noto Sans", sans-serif` | `ui-monospace, "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", "Noto Sans Mono", monospace` |

JetBrains Mono, licença OFL, empacotada em `packages/ui/src/fonts` como último recurso do terminal no Linux e no Windows, para cobertura de caracteres de caixa.

## Movimento e dimensões

Tudo que aparece surge em 140 a 240 ms, só com opacidade e deslocamento, no `--mac-ease`. No desktop, todo elemento clicável muda de cor, fundo, borda, foco e opacidade em 140 ms, por uma regra base de peso zero em `solid.css` que só vale onde o componente não declara a própria transição; o que pinta com o tom da sessão ou com a banda de uso troca de cor em 220 ms. Largura e altura nunca animam. Cards e linhas novas da árvore entram escalonados; acima de 60 linhas novas nada anima. Tudo desliga com a preferência de menos movimento do sistema e com `data-motion="none"`. Colunas de 240 e 260 px iniciais, limites de 200 a 360 e 220 a 440, recolhimento automático abaixo de 980 e 720 px de conteúdo. Janela inicial de 440 por 320 crescendo até 1380 por 880 em 520 ms com quadros de 16 ms, mínimo de 1040 por 680 aplicado depois do crescimento. Superfícies brancas sem borda, separadores em fio de cabelo, modo claro e escuro acompanhando o sistema.

## Ícones

| Plataforma | Geração | Verificação |
| --- | --- | --- |
| Desktop | `tauri icon apps/desktop/design/desktop-icon-1024.png`, placa de 824 px em tela transparente de 1024 px | `tools/check/desktop-icon.mjs`, que lê a grade do próprio gerador e exige a placa centrada no tamanho exato, mais conferência visual em claro e escuro no Dock, na barra de tarefas e no lançador |
| iOS | PNG opaco de 1024 px em `apps/desktop/design/app-icon-1024.png`, usado como `icon` do Expo | `tools/release/check-app-icon.swift` no Codemagic: 1024 por 1024, sem alfa, sem pixel transparente, com a placa branca, o rosa e a ameixa da arte |
| Android | Ícone adaptativo com `foregroundImage` em `apps/desktop/design/android-foreground-1024.png` e `backgroundColor #FFFFFF` no `app.config.ts`, que faz o papel da placa que o iPhone já traz desenhada | Arte dentro da zona segura de 66 dp, conferida pelo portão; pré-visualização nas máscaras circular, arredondada e quadrada |
| Favicon e site | `tools/brand/build-site-brand.mjs`, que grava cada arquivo do site no tamanho exato do que ele substitui | Legibilidade a 32 px |

## Celular: tokens e componentes

As referências visuais ficam em `docs/design-references`: `cialai-telas-principais.png` traz Início, Computadores, Terminais, Nova sessão, Agentes e Ajustes, e `cialai-terminal.png` traz o terminal, o teclado especial, os comandos rápidos e a folha de mais opções.

| Token | Claro | Uso |
| --- | --- | --- |
| `primary` | `#E23B84` | Acento da marca, o mesmo do desktop; o `#E53280` sugerido na reformulação ficou fora para manter o contrato da marca |
| `primarySoft` | `#FCE7F1` | Superfícies selecionadas e botões secundários |
| `background` | `#F8FAFF` | Fundo levemente azulado das telas |
| `surface` | `#FFFFFF` | Cartões e barras |
| `border` | `#E7EAF2` | Bordas discretas e separadores |
| `text` e `textSecondary` | `#20232C` e `#747B8B` | Texto principal e secundário |
| `success`, `warning` e `danger` | `#18A66A`, `#D38B17` e `#E5484D` | Estados de conexão, sessão e ações destrutivas |
| `terminal` | `#202127` | Fundo do terminal escuro das referências |

No aplicativo nativo os valores ficam em `apps/mobile/src/ui/tokens.ts`, com espaçamentos, raios, tipografia e sombra de cartão. Desde a decisão 050 os raios seguem o site cialai.com.br, 12 nos controles e 20 nos cards, e a tipografia usa a Outfit do site, embutida pelo `expo-font`; na página do celular a mesma Outfit vem em `packages/ui/src/fonts`. O escuro deriva dos valores anteriores. Na página do celular os mesmos valores são as variáveis `--phone-*` de `packages/ui/src/mobile/mobile.css`, que no claro também alimentam os neutros `--mac-*` do telefone; o acento continua vindo de `brand.css`.

Os componentes nativos ficam em `apps/mobile/src/ui`: `AppHeader`, `BottomNavigation`, `PrimaryButton`, `SecondaryButton`, `IconButton`, `StatusBadge`, `SegmentedControl`, `SearchInput`, `ComputerCard`, `ProjectCard`, `AgentUsageCard`, `SessionCard`, `SectionHeader`, `ProgressIndicator`, `BottomSheet`, `EmptyState` e `SkeletonLoader`. Os ícones são do lucide, a mesma família da página, por `react-native-svg`, com um import por ícone em `icons.tsx`. Na página, `mobile/ui.jsx` traz `SegmentedControl`, `SearchInput`, `StatusBadge` e `ProgressIndicator`; carregamento e vazio usam `DataState` e a folha inferior usa `Sheet`.

A barra inferior tem Início, Terminais, Projetos, Agentes e Ajustes e aparece só nas telas nativas de topo. Terminais leva ao último computador ou à lista. Na página do computador vale o cabeçalho próprio com voltar, e a barra sai também quando o teclado abre.

Na página do computador, a barra nativa é o seletor: laptop, ponto de estado, nome, Direta ou Reserva e uma seta. Tocar abre uma folha nativa com os computadores vinculados; escolher outro guarda o proxy atual pelo prazo de sempre e o fecha quando o novo abre. A lista de Terminais separa a fase da sessão, que é ativa, pausada por Ctrl Z, finalizada ou com erro, da conexão do terminal com o computador, que aparece numa pílula à parte quando a ponte cai. A ordem continua a de `orderedSessions()`, com as fixadas no topo, e filtro e busca nunca reordenam.

Limitações conhecidas:

| Limitação | Alternativa adotada |
| --- | --- |
| A página do computador é desmontada ao trocar de aba e recarrega ao voltar | A barra fica fora do terminal; manter a página viva exigiria mudar a casca e o ciclo de vida da conexão |
| O Início nativo não alcança a ponte do computador | A página manda um retrato com contas, uso, projetos e sessões, e o Início mostra a idade dele, pela decisão 046 |
| O computador não informa sistema, memória, CPU, contagem de pastas e arquivos, nome nem foto da pessoa, e não há notificações | O card do computador mostra nome, estado, caminho e sessões abertas; na lista de Computadores, o caminho direto e o último acesso no lugar de sistema e RAM; a saudação é genérica e o sino não aparece |
| Trocar de computador recarrega a página | A página é montada por computador; os processos continuam no computador e a lista volta com esqueletos |
| O teclado das referências é o do sistema | O app só desenha as teclas especiais acima dele |
| `react-native-svg` é módulo nativo | O visual em aparelho depende de um novo build do cliente de desenvolvimento |
| O fundo escuro do terminal exige trocar o tema ANSI do xterm no claro | O token existe, mas o terminal só muda na etapa do terminal, junto com o tema |

## Regras de texto na interface

Sem parênteses para informação secundária; sem hífen isolado, meia-risca ou travessão como separador de campos, rótulos, metadados, títulos ou frases; relações mostradas por rótulo e valor, linhas separadas, subtítulos, chips, colunas, cards, listas ou espaçamento; hifens da ortografia, valores negativos e sintaxe de código preservados; dados brutos podem manter a grafia de origem. Antes de entregar uma tela, varrer o texto visível por `(`, `)`, ` - `, `–` e `—`. A interface oferece português do Brasil como padrão e fallback, inglês e espanhol neutro. Cialai, Headscale, Claude Code e Codex conservam seus nomes.

## Capturas de referência

Gerar com a demo `?terminais=demo&motion=0#terminais` em 1380 por 880, claro e escuro, no Control e no Cialai, e comparar lado a lado: lista com cinco sessões cobrindo os estados, área de trabalho com editor e terminal, explorador com marcadores Git, Dev Browser, celular em 393 por 852 nas quatro telas. No Control a captura usa `macos/tools/wksnap`; no Cialai a mesma ferramenta no macOS e Playwright nos outros sistemas. Fora do Tauri o xterm não desenha na captura, então o terminal é conferido dentro do app.

As capturas do macOS e da página móvel foram produzidas com dados fictícios em `docs/evidence/task-1.11` e são usadas no README público. A geração por Playwright nos outros sistemas e as capturas nativas das lojas continuam pendentes.
