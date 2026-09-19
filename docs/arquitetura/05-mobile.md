# Mobile

Os apps iOS e Android do Cialai são a casca Expo do iPhone do Control, em `$CONTROL/ios/app`, com quatro acréscimos: o alvo Android, o leitor de QR, a lista de computadores pareados e um módulo nativo que embute o núcleo Go do túnel e expõe o proxy em loopback que o WebView usa. Desde 15/09/2026 o celular alcança o computador pela conectividade automática: rede local, direto pela internet e reserva pelo Tor, com tor-android no Android e Tor.framework no iOS; não há servidor Headscale nem perfis. A interface continua sendo a página que o computador serve. Nada é reimplementado em React Native além das telas de casca.

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| Casca Expo, QR, perfis e estados | Implementado | Typecheck e lint já registrados no handoff, mais 101 testes em 15 suítes na validação final desta frente; desde 16/09/2026 os ajustes escolhem se o Face ID ou a biometria é pedido sempre, só ao abrir o computador ou nunca, e a perda de saúde mantém a página montada com a faixa de reconexão em vez de destruir o WebView; a tela inicial é o hub e o destino de todo voltar, com o proxy guardado por 90 s ao sair do terminal, pela decisão 037 |
| Página do celular | Implementado | Composição somente com Terminais e cabeçalho compacto passou nos checks compartilhados; desde 15/09/2026 a apresentação segue o telefone do Control, com evidência em `docs/evidence/celular-control` |
| Idiomas da interface | Implementado | Português do Brasil, inglês e espanhol neutro seguem o aparelho e a escolha persistida |
| Metadados nativos por idioma | Preparado | `CFBundleLocalizations`, textos de câmera, rede local e Face ID por idioma e `localeConfig` do Android saem de `@cialai/i18n` e aparecem na introspecção do Expo; build nativo e aparelho pendentes |
| Módulo Swift e XCFramework | Preparado | Wrapper e contrato existem; build Swift, link e execução em iPhone estão pendentes |
| Configuração iOS | Preparado | Bundle, permissões, criptografia e proteção estão declarados; archive assinado não foi auditado |
| Distribuição iOS | Preparado | Workflows e scripts existem; app, credenciais, TestFlight e App Review estão pendentes |
| Roteiro iOS 3.9 | Preparado | Treze cenários imprimíveis estão sem resultado de aparelho |
| Módulo Kotlin e AAR | Preparado | Wrapper e contrato existem; build Kotlin, link e execução em Android estão pendentes |
| Configuração Android e botão Voltar | Implementado | Prebuild de inspeção e checks Node confirmaram configuração e navegação; aparelho real está fora deste aceite |
| Ciclo de vida, biometria e armazenamento Android | Preparado | Código e checks estáticos existem; suspensão, prompt e Keystore reais não foram exercitados |
| Distribuição Android | Preparado | Workflow e assinatura por variáveis existem; AAB e faixa interna não foram criados |
| Roteiro Android 4.7 | Preparado | Treze cenários de rede e quatro verificações Android estão sem resultado de aparelho |
| Relatório de pré lançamento | Pendente | Depende de AAB assinado na conta do Play |
| Materiais das lojas | Preparado | Políticas, respostas, textos e plano de capturas existem; auditoria dos binários, URLs e submissões estão pendentes |

## Ponto de partida

| Parte do Control | Comportamento | No Cialai |
| --- | --- | --- |
| `App.tsx` | Estados `loading`, `connect`, `shell`, `offline`; bootstrap lendo o endereço do Keychain, validando e sondando a saúde; bloqueio biométrico por `AppState`; `changeAddress` bloqueia e navega antes de apagar | Estados `loading`, `pair`, `home`, `desktops`, `settings`, `shell`, `offline`; bootstrap lê os perfis e o último desktop; `home` é o hub e o destino de todo voltar |
| `screens/Connect.tsx` | Endereço `.ts.net` digitado, `Testar conexão` | Substituída por `Pair.tsx` com o leitor e `Desktops.tsx` com a lista |
| `screens/Shell.tsx` | WebView em `source={{uri}}` com `originWhitelist(['*'])` e guarda própria que abre fora tudo que não é a mesma origem; `injectedJavaScriptBeforeContentLoaded` define `window.__ORDINUM_SHELL__`; saúde a cada 10 s em primeiro plano e ao voltar; `onContentProcessDidTerminate` recarrega; toolbar nativa mínima | Preservada; URL do proxy; global `__CIALAI_SHELL__`; toolbar mostra o nome do desktop e o estado do túnel; faixa nativa `Reconectando` acima da página enquanto `reconnecting` está ligado; `onError` conta como uma falha, com os mesmos dois strikes da sondagem, em vez de derrubar a conexão sozinho; `source` memorizado pela URL para o proxy reaproveitado não recarregar a página |
| `screens/Offline.tsx` | Retentativas em 2, 4, 8 e 16 s, `Tentar agora` por `RequestGate`, `Alterar endereço` | Preservada; `Início` e os atalhos Computadores, Ajustes e Vincular no lugar de alterar endereço; a escada é indexada pelo computador, não pelo motivo, e não recomeça quando o motivo alterna entre túnel, sem caminho e reserva preparando |
| `auth/biometrics.ts` | `SESSION_BACKGROUND_TTL_MS` de 5 min; `authorize('session')` só uma vez por sessão desbloqueada; `authorize('action')` sempre; fila serializada; época invalida prompts em voo; estado só em memória | Preservada |
| `bridge/messages.ts`, `downloads.ts`, `share-download.ts` | Só `auth`, `download` e `open-external`; limites de 160 caracteres de motivo, 11,2 MB de mensagem e 8 MiB de download; MIME permitidos; nomes de arquivo saneados | Preservados; nova mensagem `navigate-back` para o botão do Android |
| `config/url.ts` | Exige `https` em `.ts.net` fora do desenvolvimento | Aceita `http://127.0.0.1:<porta>/?k=<nonce>` em produção, e só isso |
| `network/health.ts` | `{"status":"ok","service":"workplace"}` com prazo de 5 s | Serviço `cialai` na rota local `/_cialai/health` do proxy, servida sem cookie e sem nonce; cada sondagem que falha registra o código HTTP ou o motivo no anel de diagnóstico |
| `config/storage.ts` | Chave `ordinum.control.mac-url` no Keychain com `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | Tokens por desktop e perfis, abaixo |
| `app.config.ts` | `br.com.ordinum.control`, `platforms: ['ios']`, `supportsTablet false`, Face ID, `usesNonExemptEncryption false`, `CFBundleDevelopmentRegion pt-BR` | `br.com.ordinum.cialai`, iOS e Android, câmera, rede local, `usesNonExemptEncryption false`, pela atualização de 14/09/2026 da decisão 014 |

Toolchain herdada: Expo 57, React Native 0.86, React 19.2, `react-native-webview` 13.16, `expo-local-authentication`, `expo-secure-store`, `expo-file-system`, `expo-sharing`, Jest com `jest-expo`, ESLint com `eslint-config-expo`, TypeScript 6. Acréscimos: `expo-camera` para o QR, `@react-native-community/netinfo` para mudanças de rede, `expo-dev-client` porque um módulo nativo tira o app do Expo Go, `expo-build-properties` para o `targetSdk` e o `network_security_config`.

## Máquina de estados

```ts
type AppScreen =
  | { kind: 'loading' }
  | { kind: 'pair'; error?: string; notice?: string }
  | { kind: 'home' }
  | { kind: 'desktops' }
  | { kind: 'settings' }
  | { kind: 'shell'; desktopId: string; url: string; transport: Transport | null; path: PathKind | null; reconnecting: boolean }
  | { kind: 'offline'; desktopId: string; reason: OfflineReason };
```

Bootstrap: lê `desktops.json`; sem computador, `pair`, com o aviso para vincular de novo quando perfis antigos do Headscale foram apagados; com pelo menos um computador vinculado, `home`, sempre, mesmo com o último computador respondendo. Nenhuma WebView é montada e nenhuma conexão é aberta antes do toque em Continuar. A marca `cialai.lastConnectionFailed`, que a regra anterior usava para escolher entre o início e o terminal, perdeu a função e é apagada do Secure Store uma vez. Depois do pareamento o app vai ao terminal. A tela `loading` mostra o nome Cialai e um texto curto sob o spinner. Voltar ao primeiro plano chama `NotifyForeground(true)` e a sondagem imediata; quando ela responde, `notifyHealthy` avisa o módulo iOS que o proxy sobreviveu à suspensão e a próxima conexão não recomeça do zero. Ir ao segundo plano chama `NotifyForeground(false)` e o bloqueio biométrico existente.

### Início como hub e destino do voltar

A ação `show-home` leva ao estado `home` de qualquer tela. A tela inicial mostra o card Continuar com o último computador, o ponto de estado de `describeDesktop` e o chip de transporte, e quatro cards: Computadores com a contagem, Vincular, Terminal e Ajustes. Todos os botões de volta apontam para o início com o rótulo Início: a barra do terminal, o `navigate-back` do Android na lista de sessões, Ajustes, Sem conexão, Vincular e o voltar novo da lista de computadores. Sair do terminal não chama `closeDesktop`: `App.tsx` guarda o proxy por `HOME_PROXY_GRACE_MS`, 90 s, e um temporizador o fecha se a pessoa não voltar. Voltar ao terminal dentro do prazo refaz `Connect` e `OpenDesktop`; o núcleo devolve a mesma URL, porta e nonce para o mesmo computador, então a página recarrega com o cookie que já tem. Abrir outro computador fecha o proxy guardado na hora. Enquanto o proxy está guardado, o card Continuar mostra Desconectar, que fecha o proxy de propósito; a tela sem conexão também oferece Início e os atalhos Computadores, Ajustes e Vincular, e sair dela cancela a escada de tentativas. Os glifos dos cards são desenhados com `View`, sem dependência de ícones, pela decisão 037. A abertura sempre no início é da decisão 041, que substitui o trecho Abertura do app da 037.

### Reconexão sem desmontar a página

A perda de saúde com a página aberta não troca de tela. As ações `shell-reconnecting` e `shell-recovered` ligam e desligam `reconnecting` dentro de `shell`; a faixa nativa `Reconectando` aparece acima do WebView e a página, com o xterm e o replay, fica montada. Com a faixa ligada o app consulta o núcleo: `state: offline` confirma que não há caminho e leva a `offline`; caminho ativo com a sondagem mais longa respondendo é só a reserva lenta e a faixa sai; nos demais casos o app refaz `Connect` e `OpenDesktop` pedindo a porta atual como `preferredPort`. O núcleo devolve a mesma URL, porta e nonce quando o proxy segue aberto para o mesmo computador, e `desktop-opened` com a mesma URL não muda o `source` do WebView. Uma falha ao reabrir dentro do prazo `SHELL_RECONNECT_DEADLINE_MS` de 45 s mantém a página; a próxima sondagem boa tira a faixa, e o prazo vencido ou a confirmação do núcleo levam a `offline`. A reabertura nativa do Android depois da parada em segundo plano usa a mesma faixa e troca a URL sem remontar o WebView.

### Uma escada de tentativas só

A tela `offline` tem a única escada de retentativas do app: 2, 4, 8 e 16 s, repetindo o último intervalo, indexada por `desktopId`. A reserva em preparo não tem mais intervalo fixo de 3 s: o app tenta na hora quando o núcleo emite `path` com transporte para o computador ou quando o Tor fica pronto, e a escada continua como reserva. O núcleo mantém a escada dele; o app não recria o proxy por conta própria a cada intervalo.

### Debounce da rede

Mudança de rede pelo NetInfo chama `NotifyNetworkChange`. Mudança de alcance é repassada na hora, porque a volta da rede destrava a reconexão. Mudança só de interface, como Wi-Fi para rede móvel com o mesmo alcance, só chega ao núcleo depois de `NETWORK_TYPE_SETTLE_MS` de 2,5 s estável, porque o NetInfo oscila entre `wifi`, `cellular` e `unknown` durante a troca; um vaivém que termina na interface de antes não gera aviso e repetições idênticas nunca chegam ao núcleo. No Android o módulo só reinicia a descoberta DNS-SD quando o transporte da rede ativa mudou de fato.

### Diagnóstico no aparelho

`src/state/diagnostics.ts` guarda um anel com as 80 últimas linhas: o app registra o código HTTP ou o motivo de cada sondagem que falhou, o motivo de cada tela sem conexão e o resultado de cada reabertura do proxy; os eventos `log` do núcleo entram como vieram. Ajustes mostra o anel em Diagnóstico avançado, em Linhas recentes, para a causa de uma queda ser lida no próprio aparelho. No iOS o módulo espelha as mesmas linhas em `os_log`, subsistema `br.com.ordinum.cialai` e categoria `tunnel`, visíveis no Console do macOS com o iPhone ligado.

## Telas

| Tela | Conteúdo |
| --- | --- |
| Pair | Leitor de QR em tela cheia por `CameraView` com `barcodeScannerSettings` só `qr` e `onBarcodeScanned` desligado após a primeira leitura; texto "Abra Vincular celular no computador"; botão de colar o texto do QR para quem prefere; permissão da câmera pedida aqui com o texto explicando o uso |
| Confirmação | "Vincular a <nome do desktop>?", com a impressão digital do computador para conferir com a exibida no computador; com aprovação exigida, a pessoa confere o código de 4 dígitos no computador; progresso: lendo código, procurando na rede local, conectando pela internet, conectando pela reserva, confirmando |
| Início | Título grande, card Continuar com o último computador, ponto de estado, badge Direta ou Reserva e Desconectar enquanto o proxy está guardado; cards Computadores com a contagem, Vincular, Terminal e Ajustes, com glifos desenhados com `View`; destino de todo voltar |
| Desktops | Lista de computadores com nome, estado, último acesso e badge Direta ou Reserva; tocar abre `shell`; menu com renomear, esquecer, e `Vincular outro`; barra com Início e Ajustes |
| Shell | WebView com a página do computador; toolbar nativa com nome do desktop, ponto do túnel, botão Início que guarda o proxy por 90 s; faixa `Reconectando` acima da página enquanto o caminho volta; teclado e fileira de teclas vêm da página |
| Offline | Retentativas em uma escada só por computador e `Tentar agora`; motivo visível: computador fora de alcance, reserva preparando, reserva indisponível ou celular removido; tenta na hora quando o núcleo anuncia um caminho; Início e os atalhos Computadores, Ajustes e Vincular |
| Ajustes | Diagnóstico avançado com transporte e caminho ativos, conexão de reserva, redes públicas usadas e as linhas recentes do anel de diagnóstico; nível de log, versão do núcleo e da página, licenças; voltar leva ao Início |

## Módulo nativo `cialai-tunnel`

Módulo local do Expo Modules API em `apps/mobile/modules/cialai-tunnel`, com `expo-module.config.json`, `ios/CialaiTunnelModule.swift`, `android/src/main/java/br/com/ordinum/cialai/tunnel/CialaiTunnelModule.kt` e `src/index.ts`. O Swift e o Kotlin só embrulham o núcleo Go; a lógica de rede fica no Go.

API em TypeScript, espelho da API `gomobile` do documento 06:

```ts
export type Transport = 'direct' | 'tor';
export type TunnelEvent = { kind: 'state' | 'path' | 'tor' | 'proxy' | 'pair' | 'log'; payload: unknown };
export function version(): string;
export function inspectPairPayload(payload: string): Promise<PairInspection>;
export function pair(payload: string, device: { name: string; model: string; platform: 'ios' | 'android'; app: string }): Promise<PairResult>;
export function connect(desktopId: string): Promise<ConnectResult>;
export function openDesktop(desktopId: string, deviceToken: string, preferredPort?: number): Promise<{ url: string; port: number; nonce: string; warning?: string }>;
export function closeDesktop(desktopId: string): Promise<void>;
export function stop(): Promise<void>;
export function status(): Promise<TunnelStatus>;
export function desktops(): Promise<DesktopRecord[]>;
export function notifyNetworkChange(reachable: boolean): void;
export function notifyForeground(active: boolean): void;
export function notifyHealthy(): void;
export function forgetDesktop(desktopId: string): Promise<void>;
export function setLogLevel(level: 'error' | 'info' | 'debug'): void;
export function addListener(handler: (event: TunnelEvent) => void): { remove(): void };
```

Integração de build: iOS por `Tunnelcore.xcframework` referenciado no podspec por `vendored_frameworks`, com o framework de dispositivo separado do de simulador para a submissão à loja; Android por `tunnelcore.aar` em `android/libs` com a dependência declarada no `build.gradle` do módulo. Os artefatos vêm do CI de `packages/tunnel-core`, com SHA-256, e um script `tools/build-tunnel-mobile.sh` gera os dois localmente com Go, `gomobile`, Xcode e NDK fixados. O diretório de estado passado a `NewTunnel` é o de dados do app, fora do backup.

Tokens: `expo-secure-store` com chave `cialai.device.<desktopId>` e `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, como o protótipo faz com o endereço. `desktops.json` no diretório de documentos do app guarda `{version: 2, desktops: [{id, name, fingerprint, deviceId, pairedAt, lastSeenAt, lastTransport}], lastDesktopId}`, sem segredos; os perfis do Headscale de versões anteriores são apagados na primeira abertura e o app pede para vincular de novo.

## WebView

O WebView carrega `http://127.0.0.1:47400/?k=<nonce>`; o proxy grava o cookie e redireciona para `/`. Propriedades preservadas de `Shell.tsx:181-205`: `allowsBackForwardNavigationGestures` desligado, `allowsLinkPreview` desligado, `contentInsetAdjustmentBehavior never`, `domStorageEnabled`, `javaScriptEnabled`, `keyboardDisplayRequiresUserAction` desligado, `pullToRefreshEnabled`, `sharedCookiesEnabled` desligado, `onContentProcessDidTerminate` recarregando, `onError` contando uma falha com os mesmos strikes da sondagem, `originWhitelist(['*'])` com a guarda de `Shell.tsx:114-121` comparando a origem do proxy. `injectedJavaScriptBeforeContentLoaded` define `window.__CIALAI_SHELL__` com plataforma, versão, identificador, nome do computador e idioma. A página deriva o WebSocket de `location.host`, então conecta em `ws://127.0.0.1:47400/pty` sem saber de túnel. A saúde é sondada em `http://127.0.0.1:47400/_cialai/health`, rota local do proxy servida antes do portão do cookie e do nonce, porque o `fetch` do app não enxerga o cookie que o WKWebView recebeu, e espera `status: "ok"` com `service: "cialai"`; 503 com `status: "offline"` e `reason` conta como falha e o motivo vai para o anel de diagnóstico.

Teclado: a página mede o `visualViewport` em `mobile/keyboard-viewport.js` e reposiciona o prompt; no Android o `app.json` usa `softwareKeyboardLayoutMode: "resize"` para o WebView encolher em vez de rolar. Rota do terminal persistida em `cialai_terminals_phone_route`, então recarregar devolve o mesmo painel.

## Biometria

Política de `ios/docs/arquitetura.md` preservada e igual no Android por `expo-local-authentication`:

| Nível | Quem pede | Como |
| --- | --- | --- |
| Livre | Ninguém | Leituras, `pty_attach`, `pty_ack`, métricas, arquivos |
| Sessão | A casca | Ao abrir o app e de novo depois de 5 minutos em segundo plano; a página pergunta por `confirmSensitive('session')` e a casca responde sem prompt se a sessão está desbloqueada; `pty_spawn` |
| Por ação | A casca, toda vez | `pty_kill`, primeira digitação por terminal e `pty_view_claim`, compartilhados até revogação |

A ponte não sabe de biometria; a defesa contra página adulterada é o token por dispositivo e o TLS 1.3 mútuo com a chave do aparelho.

## Android

| Tema | Decisão |
| --- | --- |
| Projeto nativo | `expo prebuild --platform android` no CI, nunca versionado, como `ios/app/android` hoje |
| Texto claro | Plugin de configuração que grava `res/xml/network_security_config.xml` com `base-config cleartextTrafficPermitted="false"` e `domain-config` liberando só `127.0.0.1`; nunca `usesCleartextTraffic` global |
| Botão voltar | `BackHandler` na casca envia `navigate-back` à página, que volta do preview para arquivos, de arquivos para o terminal e do terminal para a lista; na lista, sai para o Início com o proxy guardado por 90 s |
| Ciclo de vida | Em segundo plano o núcleo fica vivo 2 minutos e então `Stop()`; ao voltar, `Connect` e `OpenDesktop` em 2 a 4 s com a página montada atrás da faixa `Reconectando` e a URL nova trocada sem remontar o WebView |
| Backup | `allowBackup` desligado ou `fullBackupContent` excluindo `cialai/`; tokens no Keystore pelo Secure Store |
| Permissões | `CAMERA` para o QR; `USE_BIOMETRIC`; `INTERNET`; nada de VPN, localização ou notificações |
| SDK | `targetSdk` 36 por `expo-build-properties`, exigência do Play para atualizações a partir de 31/08/2026, como o Advoris já faz; `minSdk` 26 pelo `gomobile` |
| ABI | `arm64-v8a` na loja; `x86_64` só para emulador em desenvolvimento |
| Verificação de desenvolvedor | A conta Ordinum já está registrada, conforme `$ADVORIS/docs/google-play.md` |

## iOS

| Tema | Decisão |
| --- | --- |
| Textos de permissão | `NSCameraUsageDescription` para ler o QR; `NSLocalNetworkUsageDescription` para o DNS-SD e o caminho direto na mesma rede, cuja recusa leva ao direto pela internet ou à reserva pelo Tor; `NSFaceIDUsageDescription` já existente; nada de VPN e nenhum NetworkExtension |
| Conformidade de exportação | `usesNonExemptEncryption: false` desde 14/09/2026: algoritmos padrão fora da App Store da França dispensam documentação na Apple. Mercado de massa e relatório anual continuam valendo; distribuir na França exige a declaração francesa, o código aprovado e o Info.plist verdadeiro. Confirmar com o jurídico |
| Proteção de dados | Estado do núcleo e do Tor sob `NSFileProtectionCompleteUntilFirstUserAuthentication` e `isExcludedFromBackup` |
| Mínimo | iOS 16.4, como o protótipo |
| Segundo plano | Sem modos de segundo plano; 30 s depois de sair o iOS congela as threads do Go; ao voltar, `rebind` e `restun` e o proxy derruba upstreams mortos para a página religar. O módulo marca `freshStartPending` na volta e a limpa em `notifyHealthy`, quando a sondagem do app confirma que o proxy respondeu; assim uma conexão pedida minutos depois não derruba uma sessão saudável. A página, em `remote.js`, espera o `onclose` do socket anterior antes de abrir o novo, com prazo de segurança de 1,5 s, para não bater no limite de sockets por aparelho |
| Texto de revisão | "Encrypted link to your own computer"; nunca a palavra VPN em interface, metadados ou notas; desktop de demonstração e vídeo do pareamento nas notas de revisão; ensaio por TestFlight externo antes da submissão |
| iPad | Recebe a casca de telefone, como hoje; `supportsTablet` desligado |

## Página do celular

Em `packages/ui/src/mobile`: `MobileApp` fica com uma seção só, Terminais, e um cabeçalho compacto com o nome do desktop e o estado da ponte; `TabBar` e `MoreSheet` saem ou ficam vazios; `links.js` e `keyboard-viewport.js` permanecem; `main.jsx` deriva a ponte de `location` como hoje. `PhoneWorkbench` e `PhoneFiles` preservam lista, terminal, arquivos e prévia, uma tela por vez. A fileira mantém Esc, Tab, Shift Tab, Ctrl C, setas, Enter, Ctrl D, Ctrl L e Colar, numa linha só que rola de lado. A apresentação é a do telefone do Ordinum Control, de onde a página veio: barra de título com ícones planos, título de 20 px, cards com o tom da sessão e nome de 17 px, terminal a 13 px e teclas de 44 px; os tamanhos ficam declarados no CSS, sem depender do ajuste automático de texto do WebKit, para o Android mostrar o mesmo resultado. A casca nativa acompanha com a barra de 44 px do Control, o transporte como chip e Computadores em texto no acento, sobre os neutros do iOS. Toque vira rolagem por `touch-scroll.js`, `viewport.js` concede a largura e sessões encerradas conservam o histórico local. Todos os rótulos compartilhados usam o idioma enviado pela casca ou a escolha persistida na página.

### Caixa de texto do terminal

Digitar direto no terminal pelo celular é desconfortável e um Enter sem querer executa o que ainda estava sendo escrito. Um balão flutuante no canto inferior direito da área do terminal, com alvo de 52 px e acima da pílula de voltar ao fim, abre `PhoneComposer`: uma folha inferior com um `textarea` do próprio aparelho, que traz o teclado, a seleção, o copiar e colar, a autocorreção e o ditado nativos. A caixa mora em `packages/ui`, então chega ao celular com uma versão nova do desktop e sem passar pelas lojas.

| Regra | Como |
| --- | --- |
| Enter dentro da caixa | Quebra linha, sempre. Nenhuma tecla entrega o texto |
| Inserir | Escreve o texto no terminal e para ali |
| Enviar | Escreve o texto e, depois de confirmada a escrita, manda o Enter numa segunda escrita |
| Texto de várias linhas sem colagem entre colchetes | Aviso e segunda confirmação, porque cada quebra executaria a linha anterior |
| Rascunho | Guardado por sessão em `sessionStorage`, apagado ao inserir ou enviar |
| Sem o controle do terminal | Nada é escrito e a caixa avisa, com o texto preservado |

A entrega é de `submitText` em `runtime.js`, que usa o `paste` do xterm para respeitar a colagem entre colchetes e converter as quebras de linha, e espera a promessa da escrita anterior antes de mandar o Enter. A caixa usa fonte de 16 px, senão o iOS amplia a página inteira ao focar o campo, e respeita `--ios-keyboard-height` para o terminal continuar visível atrás.

### Ações de terminal

O card no modo toque desligava menu de contexto, arraste, duplo clique e o botão de três pontos, então nenhuma ação do menu do computador existia no aparelho. O botão de três pontos volta, com alvo de 44 px, e o toque longo de 500 ms é o atalho; os dois abrem a mesma folha inferior, `PhoneSessionMenu`. O cabeçalho do terminal aberto trocou o ícone solto de energia por esse mesmo menu e manteve o botão de arquivos.

| Ação | O que faz |
| --- | --- |
| Renomear e Subtítulo | Diálogo de nome. O processo da sessão não é tocado |
| Cor e Fixar | Mesma paleta e mesma fixação do computador |
| Mover para cima e para baixo | Reordena, desabilitado nos extremos |
| Nova sessão nesta pasta | Abre outra sessão no mesmo `cwd`; a existente segue intacta |
| Alterar pasta | Navegador de pastas; encerra o processo, e a escolha é a confirmação |
| Copiar caminho | Área de transferência do aparelho |
| Reiniciar terminal e Encerrar sessão | Iguais às do computador |

Ficam de fora as que só fazem sentido no computador: abrir e parar o Dev Browser e abrir a pasta no gerenciador de arquivos.

A barra da lista ganhou também um botão que abre as contas dos agentes, `AgentProfiles`, numa folha inferior: a mesma tela que o computador mostra nas Preferências, descrita em `docs/arquitetura/15-barra-de-ia.md`. A apresentação do card tem o Rust como fonte de verdade, com uma revisão por gravação, então renomear pelo celular não é desfeito pelo próximo `persist` do computador. E o seletor de pasta ganhou o modo navegar, servido por `list_dirs`, com trilha, Pasta acima, Usar esta pasta e descida por toque, além de cada raiz de projeto passar a se oferecer: com a raiz apontando para Documentos, abrir uma sessão na própria Documentos não tinha caminho nenhum.

## Testes

Jest com `jest-expo`, herdando os 65 casos de `ios/app` e acrescentando: inspeção do QR em cada estado de erro; `validateControlUrl` aceitando só a URL do proxy em produção; saúde com serviço `cialai` sondada com o `fetch` do Node contra um proxy HTTP de teste local, sem cookie, com 200 e 503; loja de perfis; transições de primeiro e segundo plano chamando o módulo nativo; debounce do NetInfo; `navigate-back`; renderização de Pair, Desktops, Offline e Shell com a faixa de reconexão; `App.test.js` provando que o WebView não é remontado numa falha transitória e que o proxy reaproveitado mantém o `source`. Verificações da página: `check-phone-terminal.mjs`, `check-phone-workbench.mjs`, `check-mobile.mjs` e `check-mobile-readonly-ui.mjs` portados. Roteiros manuais de rede no documento 06, com iPhone e Android reais, porque simuladores não têm UDP confiável para o caminho direto; o roteiro físico da conectividade está em `docs/testes/roteiro-conectividade.md`.

## Lojas

Identificadores, credenciais por referência e workflows no documento 10. Exigências específicas: questionário de privacidade da App Store e Data safety do Play com "sem coleta", porque nada sai do aparelho além da conexão com o próprio computador, direta ou pela rede Tor, e das consultas opcionais de STUN; política de privacidade publicada; capturas por tamanho de tela; textos em inglês e português; ícone opaco de 1024 px conferido por `scripts/check-app-icon.swift`, herdado do Control. Textos das lojas e políticas em espanhol continuam pendentes por estarem fora da tarefa 6.6.

## Riscos

| Risco | Mitigação |
| --- | --- |
| Tamanho e memória do runtime Go no celular | Spike 1 com limites numéricos; só arm64 na loja |
| Reconexão após troca de rede ou segundo plano | Spike 2; `NotifyNetworkChange` com debounce da interface e `NotifyForeground`; prazo de 60 s no proxy; faixa de reconexão sem desmontar a página |
| Revisão da Apple lendo o túnel como VPN | Texto, notas e ensaio por TestFlight externo |
| Outro app ou página acessando o proxy em loopback no Android | Nonce, cookie estrito e `Origin` |
| Expo Go inutilizável | Dev client; documentado no documento 09 |
