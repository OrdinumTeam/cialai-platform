# Módulo nativo iOS

## Tunnelcore local

O Codemagic gera `Tunnelcore.xcframework` neste diretório antes de `expo prebuild` e `pod install`. O binário e seu ZIP não são versionados.

## API

`CialaiTunnelModule.swift` expõe a API v2 de `src/index.ts`: `inspectPairPayload`, `pair`, `connect`, `openDesktop`, `closeDesktop`, `stop`, `status`, `desktops`, `notifyNetworkChange`, `notifyForeground`, `forgetDesktop`, `setLogLevel` e o evento `onTunnelEvent` com `kind` em `state`, `path`, `tor`, `proxy`, `pair` e `log`.

- O estado nativo muda numa fila serial. As chamadas ao Go que esperam a rede rodam numa fila própria, fora da fila compartilhada do Expo, para `stop`, `status` e as notificações responderem durante um `connect` longo.
- Rejeições levam o código do Go em `code`, como `reserve_preparing`, e a mensagem inteira no formato `codigo: mensagem`.
- O estado do núcleo fica em `Application Support/cialai/tunnel`, com permissão 0700, protegido até o primeiro desbloqueio e fora do backup.

## Tor em processo

`TorRuntime.swift` embute o pod `Tor` 409.11.2 do Tor.framework, fixado no podspec e em `extraPods` de `app.config.ts` com cabeçalhos modulares.

- `TORConfiguration` com `DataDirectory` em `Application Support/cialai/tor`, 0700, protegido até o primeiro desbloqueio e fora do backup; `SocksPort auto OnionTrafficOnly`; `ClientOnly`; cookie de autenticação.
- Controle por socket Unix em `tmp/tor/ctl`, porque o caminho em Application Support passa dos 104 bytes de `sun_path`. Quando nem esse caminho cabe, como no simulador, o controle usa `ControlPort auto` em loopback.
- `TORController` autentica com o cookie, acompanha `STATUS_CLIENT BOOTSTRAP`, emite `tor {state, progress}` e entrega ao Go o SOCKS, o controle e o cookie por `SetTorEndpoints`. Os comandos ao controle saem um de cada vez, porque o TORController entrega cada resposta ao observador mais recente.
- O tor em C roda uma única vez por processo. Nada encerra o Tor: segundo plano pausa a rede com `DisableNetwork=1` e o primeiro plano volta com `DisableNetwork=0`, conferindo de novo o controle, a porta SOCKS e o bootstrap. `TORController.disconnect()` não é usado porque envia `SIGNAL SHUTDOWN`. `stop` do núcleo não mexe no Tor. Se a thread do Tor terminar por erro, o estado fica `failed`, o Go recebe endereços vazios e responde `reserve_unavailable` até o app abrir de novo.

## Descoberta local

`LanDiscovery.swift` procura `_cialai._udp` com `NWBrowser` e TXT, só quando há computador pareado e o app está em primeiro plano. Instâncias com o `id` de um computador pareado e o `fp` que esse id determina são resolvidas por uma `NWConnection` UDP por família de endereço, que fica pronta sem enviar pacote. Os endereços vão ao Go por `ReportLanCandidates`, que valida o relatório. Nenhum socket multicast é aberto, então a capacidade `com.apple.developer.networking.multicast` não é necessária. O app declara `NSLocalNetworkUsageDescription` e `NSBonjourServices`; com a permissão negada a busca espera e segue quando ela é concedida, e a volta ao primeiro plano abre uma busca nova.

## Ciclo de vida

O iOS suspende o app quando decide e não garante tempo em segundo plano. `notifyForeground(false)` repassa ao Go, para a busca local e pausa a rede do Tor. `notifyForeground(true)` retoma o Tor e a busca, repassa ao Go e marca um recomeço do zero: o próximo `connect` ou `pair` pedido pelo App chama `Stop` antes, fechando proxy, caminho e socket QUIC que a suspensão pode ter matado, e o App segue com `OpenDesktop`. Se o proxy ainda responder, o App não pede nova conexão e nada é refeito.

## Pendente em aparelho

- Bootstrap frio e quente, recuperação depois de 1, 10 e 30 min de suspensão e comportamento dos listeners em loopback depois de uma suspensão longa, em CON-015 e CON-088.
- Redes móveis só IPv6 sem tradução para IPv4 no aparelho: o Tor usa a configuração padrão de IPv4 e IPv6.
- Tempo da descoberta local depois de negar e aceitar a permissão de Rede Local, critério de CON-052.
