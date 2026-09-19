# Barra de IA

## Objetivo

Um painel reto na direita da área de conteúdo do Cialai, com um anel por
perfil de agente. Cada anel responde a duas perguntas ao mesmo tempo: quanto
do plano daquela conta já foi gasto, e se a sessão daquela conta está
trabalhando, esperando você ou parada.

É mais um painel da casca, como a sidebar e os painéis do estúdio: mesmo
fundo, mesmo separador, mesmos tons de texto, e acompanha o tema claro ou
escuro. Aberta mostra os anéis; recolhida vira uma tira com um ponto por
perfil; escondida sai do layout e o botão da toolbar a traz de volta. Não há
som em nenhum caso.

A lógica de leitura veio do [Codenotch](https://github.com/vinzdg/codenotch),
MIT, e foi reimplementada em Rust no Ordinum Control; o Cialai a porta para
macOS, Linux e Windows. **A diferença deliberada é a unidade**: o Codenotch
desenha um anel chamado apenas "Codex" e outro "Codex webrota". Aqui um anel
é uma **conta**, identificado pelo perfil, e não existe anel neutro. Com cinco
contas do Codex na mesma máquina, um anel que diz só "Codex" não informa nada.

O anel mostra a **sessão atual**, a janela de cinco horas, o mesmo número que
o `/usage` de cada ferramenta põe em primeiro lugar. As outras janelas, a
semanal e as por modelo, ficam no detalhe ao passar o ponteiro.

## Onde vive

| Parte | Caminho |
| --- | --- |
| Gerenciador, relógios e eventos | `apps/desktop/src-tauri/src/notch/mod.rs` |
| Comandos `notch_*` | `apps/desktop/src-tauri/src/notch/commands.rs` |
| Preferências, bloco `notch` | `apps/desktop/src-tauri/src/notch/prefs.rs` |
| Descoberta de perfis, rótulo e duplicatas | `apps/desktop/src-tauri/src/notch/profiles.rs` |
| Modelo de uso, loja e persistência | `apps/desktop/src-tauri/src/notch/usage/mod.rs` |
| Cadeia de fontes do Claude Code | `apps/desktop/src-tauri/src/notch/usage/claude.rs` |
| Cache do Claude Desktop | `apps/desktop/src-tauri/src/notch/usage/desktop_cache.rs` |
| Credencial do Claude Code, só leitura | `apps/desktop/src-tauri/src/notch/usage/credentials.rs` |
| Uso do Codex | `apps/desktop/src-tauri/src/notch/usage/codex.rs` |
| GET pelo `curl` do sistema | `apps/desktop/src-tauri/src/notch/usage/http.rs` |
| Sessões do Claude Code | `apps/desktop/src-tauri/src/notch/sessions/claude.rs` |
| Sessões do Codex | `apps/desktop/src-tauri/src/notch/sessions/codex.rs` |
| Levar à sessão | `apps/desktop/src-tauri/src/notch/sessions/focus.rs` |
| Avisos de limite, opcionais | `apps/desktop/src-tauri/src/notch/alerts.rs` |
| Textos dos avisos do sistema | chaves `native.notch.*` em `packages/i18n/src/locales/*/desktop-native.js` |

O identificador interno é `notch`, nos comandos, nas preferências e nos
módulos, pelo nome com que o recurso foi pedido; o nome visível é Barra de IA.
O Rust responde só pelos dados: onde o Control devolvia texto pronto, o Cialai
devolve um código e a interface traduz, para a tradução ficar num lugar só.

## Interface

A barra vive em `packages/ui/src/notch` e é montada em `DesktopApp.jsx` dentro de `.mac-body`, irmã da área de conteúdo, à direita, empurrando o conteúdo como a sidebar faz. A toolbar flutua sobre o topo dela. `NotchBar.jsx` lê `notch_state` na abertura e segue `notch://usage`, `notch://sessions` e `notch://prefs`; o hover abre o detalhe de `NotchCard.jsx` num popover fixo à esquerda da célula, com folga de 180 ms entre célula e popover. `ProviderCell.jsx` desenha o anel de `Ring.jsx`, o percentual da janela apontada por `headlineId`, o nome do perfil e a atividade da sessão no vocabulário do estúdio. Recolhida, a barra vira uma tira com um ponto por perfil; oculta, `NotchIndicator.jsx` na toolbar a traz de volta.

O runtime `desktop/notch-runtime.js` guarda as preferências e expõe `notchActions` para o menu nativo, o botão de menu do Linux e do Windows, a paleta e o atalho, que é Shift Cmd N no macOS e Ctrl Shift A no Linux e no Windows, onde Ctrl Shift N segue como a variante segura de novo arquivo dentro do terminal. `notch://focus-session` leva ao estúdio e seleciona a sessão pela tag do PTY; `notch://open-settings` abre as Preferências na seção Barra de IA, onde a visibilidade vale na hora e o restante grava com Salvar por `notch_set_prefs`.

Os textos passam por `copy.js`, que traduz os códigos do contrato nos três idiomas e mostra como veio o que é nome próprio ou texto sem código. O estilo em `notch.css` usa só os tokens da casca, por isso a barra sai nas cores do Cialai, magenta no acento, e desliga animações com movimento reduzido ou `data-motion="none"`. Fora do app, `?notch=demo:basic`, `states`, `single` e `collapsed` alimentam a barra com dados fixos para captura; as capturas de referência ficam em `docs/evidence/barra-de-ia/`.

## Decisões

### Um anel por conta, nunca um anel neutro

A identidade é a pasta de configuração: `~/.claude`, `~/.claude-webrota`,
`~/.codex`, `~/.codex-amorim`. O identificador é o mesmo `profile_slug` que o
estúdio de terminais já usa em `workspace/procs`, então um anel e um card de
sessão falam do mesmo perfil.

O rótulo é o sufixo da pasta. As pastas sem sufixo, `~/.claude` e `~/.codex`,
ganham o rótulo da conta logada, a parte local do e-mail. Quando essa conta já
aparece num perfil com nome, a pasta sem sufixo fica escondida por padrão, para
a barra não desenhar dois anéis da mesma conta; dar um apelido a ela na lista
das Preferências a traz de volta.

Uma pasta `~/.claude-*` só vira perfil se tiver credencial própria: o item do
chaveiro no macOS, o `.credentials.json` no Linux e no Windows. Sem essa regra,
um plugin com nome parecido viraria um anel que nunca lê nada.

### A leitura não depende de sessão aberta

Todos os perfis ligados são lidos, estejam ou não com um agente rodando. Uma
conta parada há horas mostra a sessão atual em zero, porque a janela de cinco
horas de fato zerou; a semana dela continua no detalhe.

### Nada é inferido por silêncio

Uma sessão só aparece como aguardando quando a própria ferramenta grava isso.
No Claude Code é o campo `status` do registro da sessão, que só a interface de
terminal escreve; o transcript distingue apenas trabalhando de parado e nunca
afirma espera. O Codex nunca aparece como aguardando: não existe evento que
diga isso. É a mesma regra do estúdio, e agora é literalmente o mesmo código.

### O leitor é um só

Os leitores puros moram em `apps/desktop/src-tauri/src/workspace/agent_state.rs`:
o enum `SessionState`, `parse_record` do registro do Claude Code e `state_in`
com `state_of` do rollout do Codex. A Barra de IA os reexporta em
`notch/sessions/claude.rs` e `notch/sessions/codex.rs`, e o estúdio lê daí para
preencher `agentTurn` em `pty_metrics`. Assim o anel e o card nunca discordam
sobre a mesma sessão, e a regra do silêncio vale nos dois por construção.

### Nenhum barulho

Sem som, sem abertura automática. Os avisos do sistema ao cruzar 80 por cento,
ao esgotar e ao renovar existem, mas nascem desligados nas Preferências e só
falam de quem pediu.

## De onde vem o número

### Claude Code, quatro fontes em ordem

1. **Hook de linha de estado**, que o Cialai instala pelo card ou pelas
   Preferências e que `workspace/ai.rs` já lê. Não custa processo, rede nem
   diálogo. Vale 30 minutos. Arquivo em `ai-usage/claude/<perfil>.json` na
   pasta de dados do app.
2. **Cache do Claude Desktop**, no macOS e no Windows. Só entradas cuja URL
   guardada é o `/usage` **desta organização** são abertas, então o número de
   uma conta nunca cai no anel de outra. Leitura pura: nenhum token, cookie ou
   requisição à Anthropic. O corpo vem em zstd, daí a dependência `zstd`. No
   Linux não existe o app e a fonte é pulada.
3. **`claude --print --no-session-persistence --strict-mcp-config /usage`**,
   no máximo uma vez a cada cinco minutos por perfil, com o binário procurado
   nos lugares conhecidos de cada sistema e por fim no `PATH`. A telemetria
   fica como está: desligá-la apaga a linha semanal por modelo.
4. **Credencial do Claude Code** contra `GET https://api.anthropic.com/api/oauth/usage`,
   com recuo de 60 s dobrando até 15 minutos em caso de 429.

O app nunca escreve a credencial, nunca renova e nunca copia o token. A ordem
põe a linha de comando antes da credencial de propósito: no macOS cada leitura
do chaveiro pode abrir um diálogo, e perguntar ao próprio `claude` o evita.

### Codex, duas fontes

1. `GET https://chatgpt.com/backend-api/wham/usage` com o `auth.json` daquela
   pasta.
2. A última linha com `rate_limits` da cauda do arquivo de sessão mais
   recente, que o estúdio já lê. Marcada como derivada, e o detalhe mostra `~`
   antes do número.

### HTTP

As duas chamadas saem pelo `curl` do sistema, sem pilha TLS própria:
`/usr/bin/curl` no macOS e no Linux, `System32\curl.exe` no Windows, senão o
primeiro do `PATH`. Sem `curl` a fonte fica indisponível com estado
`curlMissing` e a próxima da cascata entra.

### Ritmo

Sessões a cada 1 s, uso a cada 10 s decidindo pela loja: relê quando há sessão
trabalhando e passou um minuto, quando passam cinco minutos sem leitura, ou no
instante em que uma janela vira. A primeira leitura acontece na abertura. A
última leitura boa fica em `notch/usage.json` na pasta de dados do app e volta
apagada na abertura. Perder a credencial apaga o histórico daquele perfil;
qualquer outra falha só o envelhece.

## Diferenças por plataforma

| Tema | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Credencial do Claude Code | Item do chaveiro do login, lido por `security find-generic-password`, com cache de cinco minutos | `<pasta>/.credentials.json` | `<pasta>/.credentials.json` |
| Pasta `~/.claude-<slug>` vira perfil | Item do chaveiro com o sufixo da pasta existe | O `.credentials.json` existe | O `.credentials.json` existe |
| Cache do Claude Desktop | `~/Library/Application Support/Claude/Cache/Cache_Data` | Sem Claude Desktop; fonte pulada | `%APPDATA%\Claude\Cache\Cache_Data` |
| Binário `claude` | `~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.volta/bin`, `~/Library/pnpm`, `~/.npm-global/bin`, nvm, `/opt/homebrew/bin`, `/usr/local/bin`, `PATH` | Os mesmos da pasta pessoal, nvm, `/usr/local/bin`, `/usr/bin`, `PATH` | `~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.volta/bin`, `%APPDATA%\npm\claude.cmd`, `%LOCALAPPDATA%\Programs\claude`, `PATH` |
| `curl` | `/usr/bin/curl` | `/usr/bin/curl`, senão `PATH` | `System32\curl.exe`, senão `PATH` |
| Existência e início de processo | `proc_pidinfo` por `workspace/procs` | `sysinfo` e `/proc` por `workspace/procs` | `sysinfo` por `workspace/procs` |
| Foco de sessão dentro do estúdio | Evento `notch://focus-session` com o `ptyTag` | Igual | Igual |
| Foco de sessão fora do estúdio | App dono pela árvore de processos e `NSRunningApplication`; aba por tty no Terminal e no iTerm2 | Sem app dono; devolve `false` sem erro | Sem app dono; devolve `false` sem erro |
| Persistência | `notch/usage.json` na pasta de dados do app | Igual | Igual |

Todo processo auxiliar, `security`, `curl`, `claude` e `osascript`, passa por
`platform::configure_background_command`, para não abrir janela de console no
Windows e para ter grupo próprio no Unix.

## Comandos e eventos

| Comando | Faz |
| --- | --- |
| `notch_state` | Preferências, perfis visíveis com leitura, sessões por perfil, atividade e todos os perfis da máquina |
| `notch_refresh` | Lê o uso de um perfil pelo `profileId` ou de todos |
| `notch_set_prefs` | Grava as preferências e relê |
| `notch_set_visibility` | `open`, `collapsed` ou `hidden` |
| `notch_focus_session` | Leva à sessão pelo `sessionId`: o card do estúdio, ou o app dono do processo no macOS |
| `notch_open_settings` | Abre as Preferências na seção da barra |

Eventos: `notch://usage` com a lista de snapshots a cada leitura,
`notch://sessions` com `byProfile` e `activity` quando a lista muda,
`notch://prefs` quando as preferências mudam, `notch://focus-session` com
`ptyTag` para a casca selecionar a sessão do estúdio, `notch://open-settings`.

O comando `set_preferences` preserva o bloco `notch` gravado: o diálogo de
Preferências monta o objeto do zero e só os comandos `notch_*` o alteram. O
mesmo vale para o bloco `agents`, que só muda por `agent_profile_select`.

### Conta ativa de cada agente

Uma conta é uma pasta de configuração. O Cialai **só escolhe qual pasta o
agente vai usar**: nunca troca `auth.json` de lugar, nunca copia credencial e
nunca lê o conteúdo de arquivo de credencial nenhum.

| Comando | Faz | Nível na ponte |
| --- | --- | --- |
| `agent_profiles` | Lista as contas de cada agente com rótulo, plano, marca de ativo, marca de padrão, estado de login e as janelas de uso. Nunca inclui `accountKey`, token nem conteúdo de credencial | `read` |
| `agent_profile_select` | Grava a conta que as sessões novas vão usar e emite `agents://profiles` | `session` |
| `agent_profile_create` | Cria `~/.claude-<nome>` ou `~/.codex-<nome>` vazia e com permissão 0700, recusando pasta existente e nome fora de letras minúsculas, dígitos e hífen | `session` |
| `pty_launch_agent` | Abre o agente numa conta escolhida no terminal já aberto, digitando a linha montada no Rust, só com o shell no prompt | `terminal` |

Terminal novo nasce com as variáveis da conta ativa, aplicadas em
`spawn_for_with_spec` depois da limpeza de marcadores de sessão herdados. Conta
padrão ativa remove `CLAUDE_CONFIG_DIR` e `CLAUDE_PROFILE`, ou `CODEX_HOME` e
`CODEX_PROFILE`; uma conta nomeada as define. O cliente nunca envia variável
nem caminho: ele manda o id do perfil e o servidor resolve a pasta a partir da
própria pasta pessoal, conferindo os marcadores antes.

Terminal já aberto não muda de ambiente. Para ele existe a ação de menu Abrir o
agente neste perfil, que digita a linha montada por `resume::launch_command`,
com a mesma citação por sabor de shell da retomada, e só com o shell no prompt
e sem processo em primeiro plano. Uma tarefa em execução continua na conta em
que começou, e a tela diz isso.

Se o arquivo de inicialização do shell exportar a variável, ele vence o valor
injetado, e o card mostra a verdade lida do processo. Apelidos de shell que
definem a variável continuam funcionando.

### Bloco `notch` em `preferences.json`

```json
{
  "visibility": "open",
  "profiles": { "codex-amorim": { "enabled": true, "alias": null, "muted": false } },
  "order": ["claude-ordinum", "codex-amorim"],
  "hideDefaultWhenDuplicate": true,
  "watchLimit": 0.5,
  "criticalLimit": 0.7,
  "alerts": { "threshold": false, "limitReached": false, "reset": false },
  "resetTimeFormat": "automatic"
}
```

### Códigos que a interface traduz

O contrato mantém os nomes de campos, enums e valores do Control, em
`camelCase`. Onde o Control devolvia texto em português, o Cialai devolve um
código:

| Campo | Códigos | Significado |
| --- | --- | --- |
| `windows[].label` | `session` | Sessão atual |
| | `weeklyAll` | Todos os modelos |
| | `perModel` | Por modelo |
| | `longWindow` | Janela longa do Codex sem duração conhecida |
| | `duration` | Rótulo pela duração em `durationMs`: menos de 60 min em minutos, menos de 24 h em horas, 7 dias é semanal, 30 dias é mensal, o resto em dias |
| | outro valor | Nome próprio, como `Opus` ou `Fable`, mostrado como está |
| `windows[].group` | `Spark` | Nome próprio, como está |
| | `codeReview` | Revisão de código |
| `status.kind` `unsupported`, `status.message` | `nothingMetered` | A conta não tem limite medido |
| `status.kind` `error`, `status.message` | `timeout` | Sem resposta no prazo |
| | `http` | Resposta HTTP inesperada; `status.detail` traz o código |
| | `network` | O `curl` falhou; `status.detail` traz a mensagem dele |
| | `curlMissing` | Sem `curl` no sistema |
| `source` | `statusline` | Hook de linha de estado |
| | `desktopCache` | Cache do Claude Desktop |
| | `cli` | `claude /usage` |
| | `anthropicApi` | Credencial contra o endpoint da Anthropic |
| | `chatgptApi` | `auth.json` contra o endpoint do ChatGPT |
| | `rollout` | Cauda do arquivo de sessão do Codex |
| `sessions[].detail` | `terminal`, `desktop`, `vscode`, `agent` | De onde a sessão do Claude Code roda; a pasta vem de `cwd` |
| | `rollout` | Sessão do Codex, lida do arquivo |

Os avisos do sistema são o único texto que sai do Rust para a tela, e passam
pelas chaves `native.notch.*` do catálogo nativo, nos três idiomas.

## Verificação

```sh
source /Volumes/ORDINUM-SSD/Build/cialai/env.sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked notch
npm run check:background-commands && npm run check:native-i18n && npm run test:i18n
```

Os testes usam um `HOME` temporário e nunca leem as pastas reais da máquina.
Os que dependem do `security` ou de um app dono ficam sob
`cfg(target_os = "macos")`. Um teste ignorado,
`descobre_os_perfis_desta_maquina`, imprime os perfis da máquina de quem roda:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored descobre_os_perfis_desta_maquina --nocapture
```

## Limitações reais

- **Aguardando é só o que a ferramenta diz.** Um agente parado esperando sem
  gravar isso aparece como trabalhando ou parado, nunca como aguardando.
- **O Codex não publica pid.** Clicar numa sessão do Codex no detalhe não traz
  a janela dele para a frente; só sessões do Claude Code e as que rodam dentro
  do estúdio têm para onde levar.
- **Fora do estúdio, só o macOS levanta o app dono.** No Linux e no Windows
  o clique leva ao card do estúdio quando a sessão roda ali; fora dele nada
  acontece.
- **Só Claude Code e Codex.** A estrutura de provedores está aberta, mas nenhum
  outro entra nesta entrega.
- **O cache do Chromium é formato privado.** Se o Claude Desktop mudar a forma
  de guardar a resposta, essa fonte fica em silêncio e as outras assumem.
- **Linux e Windows foram escritos sem execução.** O código sob
  `cfg(target_os = "linux")` e `cfg(windows)` compila na CI de cada sistema;
  a leitura do `.credentials.json` e do cache do Windows aguarda verificação
  numa máquina real.

## Roadmap

Outros provedores do Codenotch e o número na barra de menus, que exige ligar a
feature `tray-icon` do Tauri.

Plano de origem no Control: `plan/2026-09-16-notch-ia.md`.
