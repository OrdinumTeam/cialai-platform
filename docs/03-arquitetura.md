# Arquitetura

## Desenho alvo

```
┌──────────────────────────── Desktop Cialai, Tauri 2 ────────────────────────────┐
│ WebView: React, estúdio de terminais, onboarding, Vincular celular, Dispositivos │
│ Rust: TerminalManager, procs por SO, journal, resume, files, git, watch          │
│ Rust: ponte WebSocket em 127.0.0.1:3720, aceita só quem traz o segredo da borda  │
│ Rust: tunnel.rs supervisiona o sidecar por stdio; chave da API no keychain       │
│ Sidecar Go cialai-tunnel: nó tsnet registrado no Headscale; borda na tailnet     │
│   :4740 servindo a página do celular, /api/health, /pair e o proxy de /pty para  │
│   a ponte; cliente da API do Headscale; registro de dispositivos                 │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ WireGuard ponta a ponta, direto ou pelo DERP embutido
┌───────────────┴────────────────┐       ┌────────────────────────────────────────┐
│ Headscale 0.29.3 auto hospedado│       │ Celular Cialai, Expo                    │
│ HTTPS 443, DERP embutido com   │       │ Núcleo Go por gomobile: nó tsnet,       │
│ verify_clients, STUN udp 3478, │       │   pareamento nativo por POST /pair,     │
│ API /api/v1, um usuário por    │       │   proxy reverso em 127.0.0.1:47400 que  │
│ pessoa, política autogroup:self│       │   injeta o token do dispositivo         │
└────────────────────────────────┘       │ WebView em http://127.0.0.1:47400/      │
                                         │ Leitor de QR, Face ID, Secure Store     │
                                         └─────────────────────────────────────────┘
```

## Componentes

| Componente | Tecnologia | Origem | Responsabilidade |
| --- | --- | --- | --- |
| `apps/desktop` | Tauri 2.11, Rust 1.85 ou mais novo | `$CONTROL/macos/src-tauri` | Janela, PTY, processos, jornal, retomada, arquivos, Git, observador, prévias, Dev Browser, Office, uso do plano, ponte, supervisor do sidecar, pareamento e dispositivos na interface |
| `packages/ui` | React 18, Vite 5, xterm.js 6, CodeMirror 6 | `$CONTROL/frontend/src` | Estúdio, casca desktop, casca do celular, tokens e componentes compartilhados |
| `packages/protocol` | JavaScript e JSON | `$CONTROL/frontend/src/lib/remote.js`, `native.js`, `sensitive.js`, `ios/docs/ponte.md` | Contrato da ponte e do pareamento, cliente remoto, fixtures compartilhadas pelos testes Go, Rust e JS |
| `packages/tunnel-core` | Go 1.26.5, `tailscale.com` 1.102.0 | Novo | Nó `tsnet`, borda, proxy, pareamento, cliente Headscale, sidecar e ligação `gomobile` |
| `apps/mobile` | Expo SDK 57, React Native 0.86, módulo nativo em Swift e Kotlin | `$CONTROL/ios/app` | Casca com WebView, leitor de QR, perfis, biometria, proxy em loopback pelo núcleo Go |
| `infra/headscale` | Docker Compose, Headscale 0.29.3 | Novo | Receita de auto hospedagem com DERP embutido, Let's Encrypt e política |
| `tools` | Node, Swift, Playwright | `$CONTROL/frontend/scripts`, `macos/tools`, `scripts/cm-*.sh` | Verificações, capturas, self test, disparo e acompanhamento de builds |

## Processos e portas

| Processo | Onde escuta | Quem conecta | Observação |
| --- | --- | --- | --- |
| Ponte Rust | `127.0.0.1:3720`, configurável por `CIALAI_BRIDGE_PORT` | Só a borda do sidecar, que apresenta `X-Cialai-Proxy-Secret` | Sem o segredo, 403. `--dev-open-bridge` libera para `websocat` em desenvolvimento |
| Borda do sidecar | `:4740` no IP da tailnet, nunca em loopback | Celulares do mesmo usuário do Headscale | Serve a página do celular, `/api/health`, `/pair` e o upgrade de `/pty` |
| Proxy do celular | `127.0.0.1:47400`, reserva de `47401` a `47409` | Só o WebView do próprio app, provado pelo cookie de nonce | Injeta o Bearer do dispositivo; porta fixa para a origem da página não mudar |
| Vite em desenvolvimento | `127.0.0.1:1420` | WebView do Tauri | `devUrl` do `tauri.conf.json`, como no protótipo |
| Dev Browser | `127.0.0.1:<porta aleatória>` por sessão | WebView do desktop por CDP | Preservado do protótipo; recusado no celular |
| Headscale | `443` HTTPS, `80` para o HTTP-01, `3478` udp para STUN | Nós do desktop e dos celulares | Servidor com IP público que a pessoa hospeda |

## Fluxos

### Saída do terminal no desktop

A thread de leitura do PTY entrega lotes de até 64 KiB, coalescidos em 4 ms, a uma bomba que os distribui a todos os assinantes da sessão: o webview por `Channel` do Tauri e cada conexão remota por sua conexão da ponte. Cada sessão guarda os últimos 256 KiB num anel com contador absoluto de bytes. O webview confirma bytes consumidos por `pty_ack`; acima de 512 KiB pendentes a bomba para e o shell bloqueia, como um terminal que ninguém lê. Ao mesmo tempo a thread de lote acrescenta os bytes ao `<tag>.log` do jornal. O runtime no webview escreve no xterm da sessão, que fica adotado pela área central quando selecionado e estacionado fora da tela quando não.

### Celular acompanhando uma sessão

A página no WebView chama `pty_attach` pela ponte. A ponte cria um `Channel` em nome da conexão remota, o assinante recebe `replay` com offset e comprimento seguido de um quadro binário com o anel, e depois a saída ao vivo. Se a conexão remota passa 3 s acima da marca d'água, recebe `detached` com motivo `lagged` e é removida; o desktop segue. A página religa com `pty_attach` e recebe o replay de novo. Digitar no celular vira `pty_write` numa fila ordenada; a largura do PTY passa a ser do celular por `pty_view_claim`, renovada a cada 5 s, com concessão de 15 s.

### Pareamento

Descrito passo a passo no documento 06. Em resumo: o desktop cria uma chave de pré-autenticação de uso único no Headscale e um segredo de pareamento, mostra o QR; o celular lê, entra na tailnet com a chave, disca a borda e faz `POST /pair` com o segredo; a borda valida com `WhoIs`, registra o dispositivo e devolve um token; dali em diante o proxy do celular injeta o token em cada upgrade do WebSocket.

### Revogação

A tela Dispositivos manda `devices.revoke` ao sidecar. A borda fecha os sockets do dispositivo com 4401 em menos de 1 s; a página mostra "removido" e não tenta de novo, porque `remote.js` já para nesse código. Com `network` ligado, o sidecar expira e apaga o nó no Headscale, e o celular perde a tailnet em menos de um minuto.

### Reinício do desktop

O Rust encerra os shells na saída, grava o jornal e mantém a conversa do agente. Ao reabrir, as sessões voltam desconectadas com nome, ordem e pastas; o histórico é injetado no xterm em segundo plano, uma por vez; `Reabrir` abre um shell novo na mesma pasta, espera o prompt e digita o comando de retomada do agente. O sidecar sobe de novo com o mesmo estado do `tsnet`, então o nó continua o mesmo e os tokens dos celulares continuam válidos.

## Por que o Headscale funciona agora

O protótipo descartou o Headscale porque o `tailscale serve` em HTTPS depende de certificados no domínio `ts.net`, que só a Tailscale hospedada emite, e o WebView do iPhone recusava a conexão sem certificado válido. O Cialai não usa `tailscale serve` nem HTTPS na borda: o cliente Tailscale está embutido nos próprios apps, o WireGuard cifra ponta a ponta e o WebView fala com um proxy em loopback dentro do app. Dois fatos adicionais, verificados na revisão: o ATS do iOS não se aplica a endereços IP, então até `http://100.64.x.y:4740/` carregaria sem exceção, o que faz do proxy uma escolha de desenho e não uma necessidade; e o app oficial da Tailscale não aceita chave de pré-autenticação com servidor de coordenação próprio, o que enfraquece o plano B mas não o desenho principal.

## Decisões e alternativas descartadas

| Decisão | Alternativa descartada | Motivo |
| --- | --- | --- |
| Tauri 2 com Rust no desktop, reaproveitando `workspace/` e `bridge/` | Reescrever em Electron ou em Go | Dez mil linhas de Rust testadas, `portable-pty` já cobre ConPTY, WKWebView e WebView2 dão apps pequenos |
| Expo com WebView no celular, reaproveitando `ios/app` | Flutter como no Advoris; Tauri iOS; telas nativas | A casca existe, tem testes e ponte de mensagens; Flutter só serve de referência de publicação; Tauri iOS exigiria feature flags para tirar `portable-pty` e AppKit; telas nativas seriam uma segunda interface |
| Página do celular servida pelo desktop | Página empacotada no app do celular | Interface e ponte sempre na mesma versão; a casca fica mínima; a negociação de `features` cobre o resto |
| Um núcleo Go sobre `tsnet`, sidecar no desktop e `gomobile` nos celulares | `libtailscale` em C ligado ao Rust; TailscaleKit no iOS; app oficial da Tailscale | Ligar um arquivo C do Go ao Rust com MSVC no Windows é frágil; TailscaleKit é o mesmo código com os mesmos riscos; o app oficial não aceita chave de pré-autenticação com servidor próprio |
| Proxy HTTP em loopback com porta fixa e cookie de nonce | Encaminhador TCP bruto em porta aleatória | Porta aleatória troca a origem da página a cada abertura e apaga o `localStorage`; um cano bruto não injeta o Bearer, não barra outros apps nem páginas de terceiros e não detecta upstream morto |
| Autenticação na borda Go dos dois lados, token nunca na página | Token no `hello` da página, guardado pela casca | XSS na página roubaria o token; a ponte já aceita Bearer no handshake, então é a menor mudança em Rust; o pareamento vira um pacote Go testável sozinho |
| Um usuário do Headscale por pessoa e política com `autogroup:self` | Tags por instalação; um usuário por desktop | Tags saem de `autogroup:self` e exporiam todo desktop a todo celular; usuário por desktop obrigaria um celular a duas identidades |
| QR como texto puro lido pelo app | Deep link `cialai://pair` | Outro app pode tomar o esquema no Android e o payload é uma credencial; deep links por App Links e Universal Links ficam para depois |
| Chave da API do Headscale no keychain do desktop, só no modo auto hospedado | Um serviço corretor hospedado | A chave é raiz do servidor inteiro; num Headscale compartilhado precisaria de corretor, que fica atrás da interface `ControlAdmin` |
| DERP embutido no Headscale com `verify_clients` e sem os relés públicos | Depender dos DERPs públicos da Tailscale | Sem dependência de terceiros; ponto único de falha documentado |
| GitHub Actions para o desktop, Codemagic para os celulares | Codemagic para tudo | O plano do Codemagic da Ordinum só tem `mac_mini_m2`; Actions é grátis para repositório público e tem `tauri-action` |
