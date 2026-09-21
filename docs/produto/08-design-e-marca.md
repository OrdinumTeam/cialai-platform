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
| Capturas Linux, Windows e lojas | Pendente | Dependem das implementações integradas, builds nativos e tamanhos exigidos pelas lojas |

## Fontes da marca

| Item | Valor |
| --- | --- |
| Pasta | `$MARCA/brand/logo` |
| Marca em iteração | `cialai-mantis-v4-1.png` é a versão mais recente em 12/09/2026, busto da louva-a-deus sobre uma orquídea de cinco pétalas; os prompts `prompt-v2a*.txt`, `prompt-v3-*.txt` e `prompt-v4-*.txt` registram a evolução. A execução usa o arquivo mais novo aprovado na pasta e não fixa este nome |
| Linguagem | Vetor plano, só preenchimentos sólidos, sem sombra, textura ou contorno, formas separadas por vãos, simetria bilateral, legível a 32 px. O símbolo em si não tem gradiente; o gradiente existe só como fundo do ícone do aplicativo |
| Paleta, contrato fixo em todas as iterações | Magenta profundo `#E23B84`; rosa quente `#FF7AB2`; rosa pálido `#FFD6E6`; ameixa `#3A1B33` só para antenas e boca; branco puro para vãos e fundo |
| Sem texto | A marca não tem letras; o nome aparece só em tipografia do sistema ao lado |

## Aplicação da marca na interface

| Lugar | Control | Cialai |
| --- | --- | --- |
| Acento | `--mac-accent #1a4fa0` claro e `#4a8ae6` escuro | `--mac-accent #E23B84` claro e `#FF7AB2` escuro; `--mac-accent-hover #c9317a` claro e `#ff8fc0` escuro; `--mac-accent-soft-hover rgba(226,59,132,.14)` claro e `rgba(255,122,178,.24)` escuro |
| Sidebar | Gradiente da marca Ordinum em azuis | Claro: gradiente de `#FFD6E6` para `#ffffff`; escuro: de `#3A1B33` para `#1c1c1e`; item ativo em pílula magenta |
| Bloco de destaque, número principal | Azul Ordinum | Magenta |
| Ícone do app | Marca Ordinum em fundo navy | Gradiente da marca ocupando o quadro inteiro, do magenta `#E23B84` no topo ao rosa `#FF7AB2` embaixo, com o símbolo em branco por cima a 70 por cento da altura. Quadrado cheio, sem cantos arredondados desenhados, porque o sistema aplica a própria máscara; no iOS o arquivo é opaco, sem alfa; no Android o primeiro plano é só o símbolo na zona segura, sobre fundo `#E23B84` |
| Splash | Marca Ordinum | Marca Cialai centralizada, mesmo tempo e mesma coreografia de janela |
| Diálogo Vincular celular | Não existe | QR em preto sobre branco, sem tingir, com a marca pequena acima e o nome do computador; nunca colorir o QR |
| Ponto de estado do túnel | Não existe | Verde conectado, âmbar reconectando, cinza sem rede, vermelho falha, com os tokens `--mac-ok`, `--mac-warn` e `--mac-bad` |
| Cabeçalho do celular | "Ordinum Control" | Nome do desktop e ponto do túnel |
| Textos | Ordinum Control, Mac, Finder | Cialai, computador, e o nome do gerenciador de arquivos da plataforma |

Tokens novos declarados em `packages/ui/src/desktop/brand.css`: `--cialai-magenta`, `--cialai-pink`, `--cialai-blush`, `--cialai-plum`, `--cialai-white`. Os tokens `--mac-*` continuam sendo os que os componentes consomem; `brand.css` só redefine acento, gradiente e cores de marca.

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

Escala tipográfica, espaçamentos de 4, 8, 12, 16, 20, 24, 32 e 40 e raios de 7, 8, 12, 14 e 18 conforme `docs/application/design-system.md` do Control.

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

Card com cor: gradiente a 135 graus de 10 para 4 por cento do acento no claro e 15 para 6 no escuro, com hover em 14 para 7 e 20 para 10. Filete lateral de 3 px marca a seleção. Barras de atividade de 2 px com gradiente de 55 por cento de branco até o acento, animação `terminaisBars` de 1,1 s escalonada em 0,18 e 0,36 s, desligada com menos movimento.

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

## Tipografia por sistema

| Sistema | Interface | Mono |
| --- | --- | --- |
| macOS | `-apple-system`, sistema | `"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace` |
| Windows | `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` | `"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace` |
| Linux | `system-ui, "Inter", Cantarell, Ubuntu, "Noto Sans", sans-serif` | `ui-monospace, "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", "Noto Sans Mono", monospace` |

JetBrains Mono, licença OFL, empacotada em `packages/ui/src/fonts` como último recurso do terminal no Linux e no Windows, para cobertura de caracteres de caixa.

## Movimento e dimensões

Tudo que aparece surge em 140 a 240 ms, só com opacidade e deslocamento, no `--mac-ease`. Largura e altura nunca animam. Cards e linhas novas da árvore entram escalonados; acima de 60 linhas novas nada anima. Tudo desliga com a preferência de menos movimento do sistema e com `data-motion="none"`. Colunas de 240 e 260 px iniciais, limites de 200 a 360 e 220 a 440, recolhimento automático abaixo de 980 e 720 px de conteúdo. Janela inicial de 440 por 320 crescendo até 1380 por 880 em 520 ms com quadros de 16 ms, mínimo de 1040 por 680 aplicado depois do crescimento. Superfícies brancas sem borda, separadores em fio de cabelo, modo claro e escuro acompanhando o sistema.

## Ícones

| Plataforma | Geração | Verificação |
| --- | --- | --- |
| Desktop | `tauri icon apps/desktop/design/desktop-icon-1024.png`, quadrado cheio de 1024 px com alfa totalmente opaco | `tools/check/desktop-icon.mjs`, que exige cantos opacos e lê o gradiente e a altura do símbolo do próprio gerador, mais conferência visual em claro e escuro no Dock, na barra de tarefas e no lançador |
| iOS | PNG opaco de 1024 px em `apps/desktop/design/app-icon-1024.png`, usado como `icon` do Expo | `tools/release/check-app-icon.swift` no Codemagic: 1024 por 1024, sem alfa, sem pixel transparente, com o rosa da marca no fundo e o símbolo em branco |
| Android | Ícone adaptativo com `foregroundImage` em `apps/desktop/design/android-foreground-1024.png` e `backgroundColor #E23B84` no `app.config.ts`. O primeiro plano é o símbolo em branco, então um fundo branco o faria sumir | Arte dentro do raio seguro de 33 dp; pré-visualização nas máscaras circular, arredondada e quadrada |
| Favicon e site | `tools/brand/build-site-brand.mjs`, que grava cada arquivo do site no tamanho exato do que ele substitui | Legibilidade a 32 px |

## Regras de texto na interface

Sem parênteses para informação secundária; sem hífen isolado, meia-risca ou travessão como separador de campos, rótulos, metadados, títulos ou frases; relações mostradas por rótulo e valor, linhas separadas, subtítulos, chips, colunas, cards, listas ou espaçamento; hifens da ortografia, valores negativos e sintaxe de código preservados; dados brutos podem manter a grafia de origem. Antes de entregar uma tela, varrer o texto visível por `(`, `)`, ` - `, `–` e `—`. A interface oferece português do Brasil como padrão e fallback, inglês e espanhol neutro. Cialai, Headscale, Claude Code e Codex conservam seus nomes.

## Capturas de referência

Gerar com a demo `?terminais=demo&motion=0#terminais` em 1380 por 880, claro e escuro, no Control e no Cialai, e comparar lado a lado: lista com cinco sessões cobrindo os estados, área de trabalho com editor e terminal, explorador com marcadores Git, Dev Browser, celular em 393 por 852 nas quatro telas. No Control a captura usa `macos/tools/wksnap`; no Cialai a mesma ferramenta no macOS e Playwright nos outros sistemas. Fora do Tauri o xterm não desenha na captura, então o terminal é conferido dentro do app.

As capturas do macOS e da página móvel foram produzidas com dados fictícios em `docs/evidence/task-1.11` e são usadas no README público. A geração por Playwright nos outros sistemas e as capturas nativas das lojas continuam pendentes.
