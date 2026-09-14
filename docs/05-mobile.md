# Mobile

Os apps iOS e Android do Cialai são a casca Expo do iPhone do Control, em `$CONTROL/ios/app`, com quatro acréscimos: o alvo Android, o leitor de QR, os perfis de Headscale e um módulo nativo que embute o núcleo Go do túnel e expõe o proxy em loopback que o WebView usa. A interface continua sendo a página que o computador serve. Nada é reimplementado em React Native além das telas de casca.

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| Casca Expo, QR, perfis e estados | Implementado | Typecheck e lint já registrados no handoff, mais 101 testes em 15 suítes na validação final desta frente |
| Página do celular | Implementado | Composição somente com Terminais e cabeçalho compacto passou nos checks compartilhados |
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
| `App.tsx` | Estados `loading`, `connect`, `shell`, `offline`; bootstrap lendo o endereço do Keychain, validando e sondando a saúde; bloqueio biométrico por `AppState`; `changeAddress` bloqueia e navega antes de apagar | Estados `loading`, `pair`, `desktops`, `shell`, `offline`; bootstrap lê os perfis e o último desktop |
| `screens/Connect.tsx` | Endereço `.ts.net` digitado, `Testar conexão` | Substituída por `Pair.tsx` com o leitor e `Desktops.tsx` com a lista |
| `screens/Shell.tsx` | WebView em `source={{uri}}` com `originWhitelist(['*'])` e guarda própria que abre fora tudo que não é a mesma origem; `injectedJavaScriptBeforeContentLoaded` define `window.__ORDINUM_SHELL__`; saúde a cada 10 s em primeiro plano e ao voltar; `onContentProcessDidTerminate` recarrega; toolbar nativa mínima | Preservada; URL do proxy; global `__CIALAI_SHELL__`; toolbar mostra o nome do desktop e o estado do túnel |
| `screens/Offline.tsx` | Retentativas em 2, 4, 8 e 16 s, `Tentar agora` por `RequestGate`, `Alterar endereço` | Preservada; `Trocar de computador` no lugar de alterar endereço |
| `auth/biometrics.ts` | `SESSION_BACKGROUND_TTL_MS` de 5 min; `authorize('session')` só uma vez por sessão desbloqueada; `authorize('action')` sempre; fila serializada; época invalida prompts em voo; estado só em memória | Preservada |
| `bridge/messages.ts`, `downloads.ts`, `share-download.ts` | Só `auth`, `download` e `open-external`; limites de 160 caracteres de motivo, 11,2 MB de mensagem e 8 MiB de download; MIME permitidos; nomes de arquivo saneados | Preservados; nova mensagem `navigate-back` para o botão do Android |
| `config/url.ts` | Exige `https` em `.ts.net` fora do desenvolvimento | Aceita `http://127.0.0.1:<porta>/?k=<nonce>` em produção, e só isso |
| `network/health.ts` | `{"status":"ok","service":"workplace"}` com prazo de 5 s | Serviço `cialai` |
| `config/storage.ts` | Chave `ordinum.control.mac-url` no Keychain com `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | Tokens por desktop e perfis, abaixo |
| `app.config.ts` | `br.com.ordinum.control`, `platforms: ['ios']`, `supportsTablet false`, Face ID, `usesNonExemptEncryption false`, `CFBundleDevelopmentRegion pt-BR` | `br.com.ordinum.cialai`, iOS e Android, câmera, rede local, `usesNonExemptEncryption false`, pela atualização de 14/09/2026 da decisão 014 |

Toolchain herdada: Expo 57, React Native 0.86, React 19.2, `react-native-webview` 13.16, `expo-local-authentication`, `expo-secure-store`, `expo-file-system`, `expo-sharing`, Jest com `jest-expo`, ESLint com `eslint-config-expo`, TypeScript 6. Acréscimos: `expo-camera` para o QR, `@react-native-community/netinfo` para mudanças de rede, `expo-dev-client` porque um módulo nativo tira o app do Expo Go, `expo-build-properties` para o `targetSdk` e o `network_security_config`.

## Máquina de estados

```ts
type AppScreen =
  | { kind: 'loading' }
  | { kind: 'pair'; error?: string }
  | { kind: 'desktops' }
  | { kind: 'shell'; desktopId: string; url: string }
  | { kind: 'offline'; desktopId: string };
```

Bootstrap: lê `profiles.json`; sem perfil, `pair`; com perfis, `StartProfile` do último usado, `OpenDesktop` do último desktop, `shell` com a URL devolvida; falha do túnel ou da saúde, `offline`. Voltar ao primeiro plano chama `NotifyForeground(true)` e a sondagem imediata; ir ao segundo plano chama `NotifyForeground(false)` e o bloqueio biométrico existente. Mudança de rede pelo NetInfo chama `NotifyNetworkChange`.

## Telas

| Tela | Conteúdo |
| --- | --- |
| Pair | Leitor de QR em tela cheia por `CameraView` com `barcodeScannerSettings` só `qr` e `onBarcodeScanned` desligado após a primeira leitura; texto "Abra Vincular celular no computador"; botão de colar o texto do QR para quem prefere; permissão da câmera pedida aqui com o texto explicando o uso |
| Confirmação | "Vincular a <nome do desktop>?", com o servidor e o usuário do payload; com aprovação exigida, mostra o código de 4 dígitos; progresso: entrando na rede, procurando o computador, pareando |
| Desktops | Lista de desktops com nome, estado online, último acesso e perfil; tocar abre `shell`; menu com renomear, esquecer, e `Vincular outro`; trocar de perfil quando há mais de um Headscale, com aviso de 3 a 6 s |
| Shell | WebView com a página do computador; toolbar nativa com nome do desktop, ponto do túnel, botão Desktops; teclado e fileira de teclas vêm da página |
| Offline | Retentativas e `Tentar agora`; motivo visível: túnel, computador ou servidor |
| Ajustes | Perfis com servidor e usuário, esquecer perfil, nível de log, versão do núcleo e da página, licenças |

## Módulo nativo `cialai-tunnel`

Módulo local do Expo Modules API em `apps/mobile/modules/cialai-tunnel`, com `expo-module.config.json`, `ios/CialaiTunnelModule.swift`, `android/src/main/java/br/com/ordinum/cialai/tunnel/CialaiTunnelModule.kt` e `src/index.ts`. O Swift e o Kotlin só embrulham o núcleo Go; a lógica de rede fica no Go.

API em TypeScript, espelho da API `gomobile` do documento 06:

```ts
export type TunnelEvent = { kind: 'state' | 'peer' | 'proxy' | 'pair' | 'log'; payload: unknown };
export function version(): string;
export function inspectPairPayload(payload: string): Promise<PairInspection>;
export function pair(payload: string, device: { name: string; model: string; platform: 'ios' | 'android'; app: string }): Promise<PairResult>;
export function startProfile(profileId: string): Promise<void>;
export function stop(): Promise<void>;
export function status(): Promise<TunnelStatus>;
export function openDesktop(desktopId: string, deviceToken: string, preferredPort?: number): Promise<{ url: string; port: number; nonce: string }>;
export function closeDesktop(desktopId: string): Promise<void>;
export function notifyNetworkChange(reachable: boolean): void;
export function notifyForeground(active: boolean): void;
export function forgetProfile(profileId: string): Promise<void>;
export function setLogLevel(level: 'error' | 'info' | 'debug'): void;
export function addListener(handler: (event: TunnelEvent) => void): { remove(): void };
```

Integração de build: iOS por `Tunnelcore.xcframework` referenciado no podspec por `vendored_frameworks`, com o framework de dispositivo separado do de simulador para a submissão à loja; Android por `tunnelcore.aar` em `android/libs` com a dependência declarada no `build.gradle` do módulo. Os artefatos vêm do CI de `packages/tunnel-core`, com SHA-256, e um script `tools/build-tunnel-mobile.sh` gera os dois localmente com Go, `gomobile`, Xcode e NDK fixados. O diretório de estado passado a `NewTunnel` é o de dados do app, fora do backup.

Tokens: `expo-secure-store` com chave `cialai.device.<desktopId>` e `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, como o protótipo faz com o endereço. `profiles.json` no diretório de documentos do app guarda `{profiles: [{id, controlUrl, userId, userName, lastUsedAt, desktops: [{id, name, port, nodeKey, deviceId, pairedAt, lastSeenAt}]}], lastProfileId, lastDesktopId}`, sem segredos.

## WebView

O WebView carrega `http://127.0.0.1:47400/?k=<nonce>`; o proxy grava o cookie e redireciona para `/`. Propriedades preservadas de `Shell.tsx:181-205`: `allowsBackForwardNavigationGestures` desligado, `allowsLinkPreview` desligado, `contentInsetAdjustmentBehavior never`, `domStorageEnabled`, `javaScriptEnabled`, `keyboardDisplayRequiresUserAction` desligado, `pullToRefreshEnabled`, `sharedCookiesEnabled` desligado, `onContentProcessDidTerminate` recarregando, `onError` levando a `offline`, `originWhitelist(['*'])` com a guarda de `Shell.tsx:114-121` comparando a origem do proxy. `injectedJavaScriptBeforeContentLoaded` define `window.__CIALAI_SHELL__` com plataforma, versão, identificador, nome do computador e idioma. A página deriva o WebSocket de `location.host`, então conecta em `ws://127.0.0.1:47400/pty` sem saber de túnel. A saúde é sondada em `http://127.0.0.1:47400/api/health` e espera `service: "cialai"`.

Teclado: a página mede o `visualViewport` em `mobile/keyboard-viewport.js` e reposiciona o prompt; no Android o `app.json` usa `softwareKeyboardLayoutMode: "resize"` para o WebView encolher em vez de rolar. Rota do terminal persistida em `cialai_terminals_phone_route`, então recarregar devolve o mesmo painel.

## Biometria

Política de `ios/docs/arquitetura.md` preservada e igual no Android por `expo-local-authentication`:

| Nível | Quem pede | Como |
| --- | --- | --- |
| Livre | Ninguém | Leituras, `pty_attach`, `pty_ack`, métricas, arquivos |
| Sessão | A casca | Ao abrir o app e de novo depois de 5 minutos em segundo plano; a página pergunta por `confirmSensitive('session')` e a casca responde sem prompt se a sessão está desbloqueada; `pty_spawn` |
| Por ação | A casca, toda vez | `pty_kill`, primeira digitação por terminal e `pty_view_claim`, compartilhados até revogação |

A ponte não sabe de biometria; a defesa contra página adulterada é o token por dispositivo e a tailnet.

## Android

| Tema | Decisão |
| --- | --- |
| Projeto nativo | `expo prebuild --platform android` no CI, nunca versionado, como `ios/app/android` hoje |
| Texto claro | Plugin de configuração que grava `res/xml/network_security_config.xml` com `base-config cleartextTrafficPermitted="false"` e `domain-config` liberando só `127.0.0.1`; nunca `usesCleartextTraffic` global |
| Botão voltar | `BackHandler` na casca envia `navigate-back` à página, que volta do preview para arquivos, de arquivos para o terminal e do terminal para a lista; na lista, sai para Desktops |
| Ciclo de vida | Em segundo plano o núcleo fica vivo 2 minutos e então `Stop()`; ao voltar, `StartProfile` e `OpenDesktop` em 2 a 4 s com a tela Offline mostrando "reconectando" |
| Backup | `allowBackup` desligado ou `fullBackupContent` excluindo `cialai/`; tokens no Keystore pelo Secure Store |
| Permissões | `CAMERA` para o QR; `USE_BIOMETRIC`; `INTERNET`; nada de VPN, localização ou notificações |
| SDK | `targetSdk` 36 por `expo-build-properties`, exigência do Play para atualizações a partir de 31/08/2026, como o Advoris já faz; `minSdk` 26 pelo `gomobile` |
| ABI | `arm64-v8a` na loja; `x86_64` só para emulador em desenvolvimento |
| Verificação de desenvolvedor | A conta Ordinum já está registrada, conforme `$ADVORIS/docs/google-play.md` |

## iOS

| Tema | Decisão |
| --- | --- |
| Textos de permissão | `NSCameraUsageDescription` para ler o QR; `NSLocalNetworkUsageDescription` para o caminho direto na mesma rede, cuja recusa só força o DERP; `NSFaceIDUsageDescription` já existente; nada de VPN e nenhum NetworkExtension |
| Conformidade de exportação | `usesNonExemptEncryption: false` desde 14/09/2026: algoritmos padrão fora da App Store da França dispensam documentação na Apple. Mercado de massa e relatório anual continuam valendo; distribuir na França exige a declaração francesa, o código aprovado e o Info.plist verdadeiro. Confirmar com o jurídico |
| Proteção de dados | Estado do `tsnet` sob `NSFileProtectionCompleteUntilFirstUserAuthentication` e `isExcludedFromBackup` |
| Mínimo | iOS 16.4, como o protótipo |
| Segundo plano | Sem modos de segundo plano; 30 s depois de sair o iOS congela as threads do Go; ao voltar, `rebind` e `restun` e o proxy derruba upstreams mortos para a página religar |
| Texto de revisão | "Encrypted link to your own computer"; nunca a palavra VPN em interface, metadados ou notas; desktop de demonstração e vídeo do pareamento nas notas de revisão; ensaio por TestFlight externo antes da submissão |
| iPad | Recebe a casca de telefone, como hoje; `supportsTablet` desligado |

## Página do celular

Em `packages/ui/src/mobile`: `MobileApp` fica com uma seção só, Terminais, e um cabeçalho compacto com o nome do desktop e o estado da ponte; `TabBar` e `MoreSheet` saem ou ficam vazios; `links.js` e `keyboard-viewport.js` permanecem; `main.jsx` deriva a ponte de `location` como hoje. `PhoneWorkbench` e `PhoneFiles` preservam lista, terminal, arquivos e prévia, uma tela por vez. A fileira mantém Esc, Tab, Shift Tab, Ctrl C, setas, Enter, Ctrl D, Ctrl L e Colar. Toque vira rolagem por `touch-scroll.js`, `viewport.js` concede a largura e sessões encerradas conservam o histórico local. Todos os rótulos compartilhados usam o idioma enviado pela casca ou a escolha persistida na página.

## Testes

Jest com `jest-expo`, herdando os 65 casos de `ios/app` e acrescentando: inspeção do QR em cada estado de erro; `validateControlUrl` aceitando só a URL do proxy em produção; saúde com serviço `cialai`; loja de perfis; transições de primeiro e segundo plano chamando o módulo nativo; `navigate-back`; renderização de Pair, Desktops e Offline. Verificações da página: `check-phone-terminal.mjs`, `check-phone-workbench.mjs`, `check-mobile.mjs` e `check-mobile-readonly-ui.mjs` portados. Roteiros manuais de rede no documento 06, com iPhone e Android reais, porque simuladores não têm UDP confiável para o WireGuard.

## Lojas

Identificadores, credenciais por referência e workflows no documento 10. Exigências específicas: questionário de privacidade da App Store e Data safety do Play com "sem coleta", porque nada sai do aparelho além do túnel para o próprio computador; política de privacidade publicada; capturas por tamanho de tela; textos em inglês e português; ícone opaco de 1024 px conferido por `scripts/check-app-icon.swift`, herdado do Control. Textos das lojas e políticas em espanhol continuam pendentes por estarem fora da tarefa 6.6.

## Riscos

| Risco | Mitigação |
| --- | --- |
| Tamanho e memória do runtime Go no celular | Spike 1 com limites numéricos; só arm64 na loja |
| Reconexão após troca de rede ou segundo plano | Spike 2; `NotifyNetworkChange` e `NotifyForeground`; prazo de 60 s no proxy |
| Revisão da Apple lendo o túnel como VPN | Texto, notas e ensaio por TestFlight externo; plano B do documento 06 |
| Outro app ou página acessando o proxy em loopback no Android | Nonce, cookie estrito e `Origin` |
| Expo Go inutilizável | Dev client; documentado no documento 09 |
