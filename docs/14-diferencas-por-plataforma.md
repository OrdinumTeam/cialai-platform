# Diferenças do desktop por plataforma

Este guia reúne o contrato operacional do Cialai em macOS, Linux e Windows. A
especificação detalhada continua em [04-desktop.md](./04-desktop.md); este texto
é a referência curta para desenvolver, testar e explicar diferenças esperadas.

## Estado da verificação

| Sistema | Evidência local em 13/09/2026 | Ainda não verificado |
| --- | --- | --- |
| macOS arm64 | Suíte Rust nativa com 151 casos aprovados e dois ensaios externos ignorados. O caso do instalador do Chromium passou novamente depois do ajuste portável do fixture | Bundle assinado, notarização e instalação limpa |
| Ubuntu 22.04 arm64 | Suíte Rust em contêiner com 145 casos aprovados e dois ensaios externos ignorados | WebKitGTK visível, instaladores e IME real |
| Windows x86_64 | `cargo-xwin check --all-targets` aprovou código e testes para MSVC. Em 14/09/2026 a CI no `windows-2022` rodou a suíte Rust nativa com 159 casos, o núcleo Go, o Jest e o bundle sem assinatura, e o self test mostrou janela, explorador e ConPTY com PowerShell funcionando | Máquina física, WebView2 com GPU, self test completo, IME, instalação dos instaladores e Authenticode |

O contêiner Linux teve limite de 6 GiB e dois CPUs e foi removido ao final. O
cross check Windows usou `CIALAI_SKIP_WINDOWS_RESOURCES=1` porque o host não
tinha `llvm-rc`; portanto ele não valida o arquivo de recursos. A CI remota
executou os três sistemas em 14/09/2026; assinaturas de plataforma continuam
como trabalho preparado, não como evidência de execução.

## Janela, menu e aparência

| Tema | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Moldura | Barra sobreposta, título oculto e semáforos nativos | Decorações do gerenciador de janelas | Moldura própria, sombra e controles na toolbar |
| Efeito | Vibrancy na barra lateral | Fundo opaco, sem efeito nativo | Mica a partir do build 22621, com falha não fatal |
| Abertura | Animação nativa do quadro | X11 anima posição e tamanho. Wayland abre direto no tamanho final | `SetWindowPos` atualiza o quadro em pixels físicos |
| Menu | Menu nativo, inclusive Editar para o WKWebView | Botão na toolbar com ações no DOM | Botão na toolbar com ações no DOM |
| Idioma | Menu de início localizado pelo Rust e menubar da interface refeita ao trocar de idioma | Menu da toolbar no idioma da interface | Menu da toolbar no idioma da interface |
| Tela cheia | Escape tem guarda contra saída acidental | Escape segue o comportamento da página | Escape segue o comportamento da página |
| Texto | San Francisco e SF Mono quando disponíveis | Fonte do sistema e família Linux | Segoe UI e Cascadia quando disponíveis |

Nos três sistemas, a confirmação de saída e as mensagens do núcleo usam o idioma escolhido na interface, gravado pelo comando `app_set_locale`. O app não tem ícone de bandeja.

No Wayland, o compositor controla a posição. Restaurar posição e centralizar o
splash podem não produzir efeito. O app não simula controles próprios nesse
ambiente.

O terminal usa JetBrains Mono empacotada somente como último recurso no Linux.
A licença OFL acompanha a fonte no pacote. macOS e Windows priorizam as fontes
nativas dos respectivos sistemas.

## Terminal e processos

| Comportamento | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Shell inicial | Shell do usuário em modo de login | Shell do usuário em modo de login | PowerShell 7, Windows PowerShell ou `cmd.exe` |
| Terminal virtual | PTY Unix | PTY Unix | ConPTY |
| Árvore de processos | Backend Darwin | `sysinfo` e detalhes de `/proc` | `sysinfo`, working set privado e Job Object |
| Encerramento | Sinal para o grupo e término forçado após o prazo | Sinal para o grupo e término forçado após o prazo | Interrupção graciosa e encerramento do Job Object após o prazo |
| Retomada | Sintaxe POSIX | Sintaxe POSIX | Sintaxe PowerShell ou cmd conforme o shell |

Os cards somam CPU e memória da árvore do shell nos três sistemas. A CPU é
medida entre duas amostras e 100% equivale a um núcleo. A memória é o
`ri_phys_footprint` no macOS, o PSS de `smaps_rollup` no Linux, com RSS como
reserva, e o working set privado no Windows. No Linux, pasta atual,
executável, argv e ambiente são relidos do `/proc` a cada amostra, porque o
snapshot do `sysinfo` guarda esses campos da primeira leitura do pid e não
acompanha `cd` nem `exec`. Um lançador que só cita o agente num argumento,
como `python3 wrai.py claude`, não define o perfil: vale o ambiente do CLI
que ele abre. O uso do plano do Codex também é lido dos homes que as sessões
abertas indicam por `CODEX_HOME`, inclusive fora de `~/.codex*`.

O Windows exige 10 21H2 ou mais novo. ConPTY pode refluir a saída durante o
redimensionamento e PowerShell 5.1 não oferece todos os modos de colagem do
PowerShell 7. A preferência Terminal guarda shell, argumentos, `LANG` e prefixos
de `PATH`; a escolha padrão muda por sistema.

O ConPTY nasce perguntando a posição do cursor e só inicia o shell depois da
resposta. O Rust responde com a posição que o xterm tinha ao abrir a sessão e
tira a pergunta da saída, então nenhum xterm responde de novo e a sessão abre
mesmo fora da tela ou antes de o app ter a concessão de largura.

O terminal exibido usa WebGL. Num runner do Windows sem GPU o WebView2 desenha
esse WebGL por SwiftShader e a página ficou lenta a ponto de não responder ao
WebDriver; o app registra a GPU do contexto do xterm para diagnóstico, e a
troca para o renderizador DOM nesses casos aguarda teste num WebView2 real.

## Atalhos

No macOS, Mod significa Command e mantém os glifos nativos. Linux e Windows
reservam Ctrl Shift quando o terminal está focado para não capturar combinações
do shell.

| Ação | macOS | Linux e Windows |
| --- | --- | --- |
| Nova sessão | ⌘T | Ctrl Shift T |
| Fechar | ⌘W | Ctrl Shift W |
| Buscar arquivo | ⌘P | Ctrl Shift P |
| Buscar no terminal | ⌘F | Ctrl Shift F |
| Buscar no editor | ⌘F | Ctrl F |
| Apagar linha | ⌘⌫ | Ctrl Shift Backspace |
| Copiar no terminal | ⌘C | Ctrl Shift C ou Ctrl Insert |
| Colar no terminal | ⌘V | Ctrl Shift V ou Shift Insert |
| Dev Browser | ⇧⌘B | Ctrl Shift B |
| Paleta | ⌘K | Ctrl Shift K |
| Excluir na árvore | ⌘⌫ | Delete ou Ctrl Shift Backspace |

Salvar no editor usa Mod S. Mover cards usa Option com seta no macOS e Alt com
seta nos demais sistemas.

## Caminhos e integrações

| Recurso | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Configuração | `~/Library/Application Support/br.com.ordinum.cialai` | `~/.config/br.com.ordinum.cialai` | `%APPDATA%\br.com.ordinum.cialai` |
| Dados e jornais | `~/Library/Application Support/br.com.ordinum.cialai` | `~/.local/share/br.com.ordinum.cialai` | `%LOCALAPPDATA%\br.com.ordinum.cialai` |
| Cache do Chromium | `~/Library/Caches/ms-playwright` | `~/.cache/ms-playwright` | `%LOCALAPPDATA%\ms-playwright` |
| Gerenciador de arquivos | Finder | Gerenciador padrão | Explorer |
| Observação de arquivos | kqueue | notify | notify |
| Lixeira | API do sistema | API do sistema | API do sistema |

Caminhos enviados à interface usam barras normais em todos os sistemas. Entradas
Windows aceitam barras normais e invertidas. Links são recriados somente no
Unix; no Windows, a operação evita seguir reparse points.

O Dev Browser procura Chromium e Chrome nos locais conhecidos e no cache do
Playwright. Se não encontrar um executável, instale com `npx playwright install
chromium` ou indique o binário em Preferências. O LibreOffice é descoberto em
aplicativos do macOS, no `PATH` e diretórios Linux conhecidos, ou em Program
Files e `PATH` no Windows.

No Linux, falhas gráficas do WebKitGTK podem ser diagnosticadas separadamente
com `WEBKIT_DISABLE_DMABUF_RENDERER=1` e
`WEBKIT_DISABLE_COMPOSITING_MODE=1`. Essas variáveis são alternativas de
diagnóstico, não padrões do produto.

## Energia durante o uso remoto

A preferência Manter ativo durante o uso remoto, gravada como
`network.keepAwakeWhilePaired`, vem desligada. Desligada, o Cialai não cria
assertiva nem inibidor e a energia segue a política do sistema. Ligada, o app
impede o repouso por inatividade enquanto houver pelo menos um celular com
sessão aberta no túnel e libera o pedido quando o último celular desconecta,
quando a preferência é desligada, quando o núcleo do túnel para e quando o app
sai. A tela continua apagando pelo próprio temporizador e a tampa continua
valendo nos três sistemas.

| Tema | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Pedido | `IOPMAssertionCreateWithName` com `PreventUserIdleSystemSleep` | Inibidores por D-Bus no logind, no GNOME e em `org.freedesktop.PowerManagement` | `SetThreadExecutionState` com `ES_CONTINUOUS` e `ES_SYSTEM_REQUIRED` |
| Como conferir | `pmset -g assertions` lista `Cialai com celular conectado` | `systemd-inhibit --list` e `gnome-session-inhibit --list` | `powercfg /requests` num terminal de administrador, na seção SYSTEM |
| Evidência | Assertiva real criada e liberada em 14/09/2026 | Não verificado | Não verificado |

O app registra em `app.log` quando a vigília fica ativa, quando é liberada e
quando o sistema recusa o pedido. Uma recusa não afeta o túnel e o pedido é
tentado de novo na próxima conexão ou desconexão.

No macOS, a assertiva não impede o repouso pela tampa, pelo menu Apple ou por
falta de bateria. A sessão de 20 minutos sem repouso por inatividade ainda
aguarda validação física.

No Linux, o Cialai considera a vigília ativa quando pelo menos um destes pedidos
é aceito:

- bloqueio `idle` do `org.freedesktop.login1`, respeitado pelo logind quando
  `IdleAction` está configurado;
- `org.gnome.SessionManager.Inhibit` com o sinalizador de suspensão, que o
  gnome-settings-daemon consulta antes da suspensão automática;
- `org.freedesktop.PowerManagement.Inhibit`, oferecido por gerenciadores de
  energia como os do KDE Plasma e do XFCE.

O GNOME não consulta o bloqueio `idle` do logind para suspender por
inatividade, por isso o pedido ao gerenciador de sessão é necessário. Nesse
ambiente, o inibidor de suspensão também pode fazer o comando Suspender do menu
não agir enquanto houver celular conectado; a tampa segue a configuração do
logind. Nenhum dos pedidos mantém a tela acesa ou impede o bloqueio de tela.
Sem barramento de sessão ou de sistema, sem logind ou com um gerenciador de
energia que ignora esses serviços, como em alguns gerenciadores de janelas,
contêineres e WSL, a política normal continua valendo.

No Windows, uma thread própria do Cialai cria e libera o pedido, porque
`SetThreadExecutionState` vale só para a thread que chamou. Em computadores com
Modern Standby, que `powercfg /a` identifica como S0 Low Power Idle, o pedido
reinicia o temporizador de repouso, mas há aparelhos que entram em espera
conectada depois que a tela apaga mesmo com ele ativo. Nessa espera, a política
de rede do sistema decide se o Wi-Fi continua ligado, e o celular pode perder a
conexão. Tampa e botão de energia levam à espera em qualquer caso. O Cialai não
mantém a tela acesa nem usa `PowerRequestExecutionRequired`; o comportamento
num aparelho físico com Modern Standby ainda não foi verificado.

## Empacotamento

| Sistema | Formatos | Política de distribuição |
| --- | --- | --- |
| macOS | `app` e `dmg` | Developer ID, hardened runtime e notarização nas releases |
| Linux | `deb`, `rpm` e `AppImage` | Build de referência em Ubuntu 22.04, sem assinatura de código |
| Windows | `nsis` e `msi` | Authenticode nas releases e pacote sem assinatura em nightly |

O sidecar precisa ser compilado para o triplo de destino antes do Tauri. A CI de
push e pull request prepara bundles sem credenciais; publicar, assinar e criar
release pertencem a fluxos separados.

## Conectividade com o celular

A conectividade automática sobe igual nos três sistemas quando o app abre, sem
servidor Headscale e sem Docker: identidade Ed25519, ouvinte QUIC em UDP 4740
ou porta livre, mapeamento por UPnP, NAT-PMP ou PCP, STUN opcional, anúncio
DNS-SD na rede local e serviço onion do Tor de salto único como encontro e
reserva. O que muda por sistema é o Tor empacotado:

| Alvo | Tor no desktop |
| --- | --- |
| macOS arm64 e x86_64 | Tor Expert Bundle 15.0.22 com tor 0.4.9.12, conferido por SHA-256 e assinado com Developer ID nas releases |
| Linux x86_64 | Tor Expert Bundle 15.0.22 com tor 0.4.9.12, conferido por SHA-256 |
| Linux arm64 | Sem pacote do Tor; o build sai sem a conexão de reserva e o caminho direto continua |
| Windows x86_64 | Tor Expert Bundle 15.0.22 com tor 0.4.9.12, conferido por SHA-256 |

O comportamento em redes e aparelhos reais segue pendente no roteiro
`docs/testes/roteiro-conectividade.md`.

## Como validar

Em qualquer sistema, gere o sidecar antes da suíte e limite Rust a dois jobs:

```sh
npm ci
npm run sidecar --workspace @cialai/desktop
CARGO_BUILD_JOBS=2 npm test
```

No Linux, execute também a interface sob X11 e Wayland quando houver um desktop
real. No Windows, valide PowerShell 7, Windows PowerShell, `cmd.exe`, WebView2 e
os dois instaladores. Esses ensaios só devem mudar de pendentes para aprovados
depois da execução no sistema correspondente.
