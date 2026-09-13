# Rede, Headscale e pareamento

Este documento especifica a camada que liga o celular ao computador: o Headscale auto hospedado, o núcleo Go do túnel, a borda no desktop, o proxy no celular, o pareamento por QR, o registro de dispositivos, o modelo de ameaças, os testes e os spikes que precisam passar antes de qualquer outra fase.

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| Receita e política Headscale | Implementado | Compose, modelos, bootstrap e check existem; política e expiração passaram em Docker local |
| Núcleo Go e sidecar | Implementado | Nó, cliente REST, stdio, armazenamento e logs passam nas suítes locais |
| Borda, proxy e pareamento | Implementado | Contratos, segurança, limites e integração Docker passam sem aparelho físico |
| Supervisor e ponte desktop | Implementado | Processo real falso, timeouts, reinício, eventos e segredo da borda foram testados localmente |
| Ligações gomobile | Preparado | API, script e bindings gerados existem; execução nativa em iOS e Android está pendente |
| Modelo de ameaças | Implementado | Controles estão refletidos no código e nos testes locais; auditoria externa e prova em aparelhos não ocorreram |
| Roteiros manuais | Preparado | Folhas iOS e Android cobrem trinta cenários no total; todos permanecem sem resultado |
| Plano B com app Tailscale | Pendente | Não foi ativado nem executado, pois o caminho principal ainda não falhou em aparelho |

Estado dos spikes:

| Spike | Estado | Evidência e limite |
| --- | --- | --- |
| 1. gomobile e tsnet em aparelhos | Preparado | API e bindings foram gerados; iPhone, Android, LTE, tamanho e memória não foram medidos |
| 2. Rede e suspensão | Pendente | Ganchos existem, mas as dez execuções por caso em cada aparelho não ocorreram |
| 3. Política e expiração | Implementado | Mesmo usuário, isolamento, porta e expiração foram verificados localmente com Headscale 0.29.3 |
| 4. WKWebView e proxy | Pendente | Checks simulados não substituem WKWebView nativo |
| 5. Android WebView e AAR | Pendente | Prebuild estático não substitui Android 12, Android 14 e relatório do Play |
| 6. TestFlight externo | Pendente | Nenhum build foi submetido a Beta App Review |
| 7. Empacotamento e assinatura | Pendente | Nenhum conjunto assinado dos três sistemas foi instalado |
| 8. Robustez por 24 horas | Pendente | Testes unitários de carga existem, mas o soak não foi executado |

## Princípios

1. Um só núcleo de rede em Go, sobre `tailscale.com/tsnet` 1.102, compilado como sidecar no desktop e como biblioteca `gomobile` nos celulares. Nada de cliente Tailscale do sistema, nada de `tailscale serve`, nada de certificado na borda.
2. Autenticação nas duas bordas Go. O celular prova quem é com um token por dispositivo injetado pelo proxy nativo; o desktop prova à ponte que a conexão veio da borda com um segredo por abertura. A página do WebView nunca vê credencial.
3. Nada escuta fora do loopback, exceto a borda, que só existe no IP da tailnet. O Headscale só coordena e relê; o tráfego é WireGuard ponta a ponta.
4. A chave da API do Headscale é raiz do servidor inteiro e só pode ficar num desktop porque o Headscale é da própria pessoa. Toda chamada administrativa passa pela interface `ControlAdmin`, para um corretor hospedado entrar depois sem tocar no resto.
5. Um usuário do Headscale por pessoa, nós sem tag, política com `autogroup:self`. Um celular pareado com dois desktops da mesma pessoa é um nó só.

Componentes verificados em setembro de 2026: Headscale 0.29.3 de 29/07/2026, com `grants`, correção de `autogroup:self`, chaves de pré-autenticação por id, chaves de API `hskey-api-{prefixo}-{segredo}`, DERP embutido e cliente mínimo 1.82; `tsnet` com `ControlURL`, `AuthKey`, `Hostname`, `Dir`, `Ephemeral`, `Up`, `Listen`, `Dial`, `LocalClient` e `Loopback`, ignorando `AuthKey` quando já existe estado salvo salvo `TSNET_FORCE_LOGIN=1`; `gomobile bind` gerando `.xcframework` e `.aar` como o app Android oficial faz; correção upstream do `os.Executable()` no iOS reportada na revisão e a confirmar no spike 1.

## Headscale

### Requisitos

| Item | Valor |
| --- | --- |
| Servidor | Linux ou BSD com IP público, de preferência IPv4 e IPv6, usuário dedicado, dados em `/var/lib/headscale` |
| Portas públicas | `tcp/443` para os clientes e o DERP; `tcp/80` só para o HTTP-01 do Let's Encrypt embutido; `udp/3478` para STUN |
| Porta interna | `tcp/9090` para métricas, nunca exposta |
| Versão | `headscale/headscale:0.29.3` fixada; o assistente do desktop recusa versões abaixo de 0.29 |
| Cliente | Todos os nós vêm do mesmo módulo `tailscale.com`, acima do mínimo 1.82 |

### `config.yaml`

```yaml
server_url: https://hs.example.com
listen_addr: 0.0.0.0:443
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: cialai
    region_name: "Cialai relay"
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: 198.51.100.1
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
node:
  ephemeral:
    inactivity_timeout: 30m
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
tls_letsencrypt_hostname: hs.example.com
tls_letsencrypt_cache_dir: /var/lib/headscale/cache
tls_letsencrypt_challenge_type: HTTP-01
tls_letsencrypt_listen: ":http"
log:
  level: info
  format: text
policy:
  mode: file
  path: /etc/headscale/policy.json
dns:
  magic_dns: true
  base_domain: cialai.internal
  override_local_dns: false
  nameservers:
    global: []
  search_domains: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
logtail:
  enabled: false
```

Notas: `urls: []` tira a dependência dos relés públicos da Tailscale, o que faz do DERP embutido um ponto único de falha documentado; `verify_clients` só relê nós conhecidos por este Headscale; `base_domain` não pode ser o host do servidor nem um pai dele; `override_local_dns` desligado para nunca mexer no resolvedor do desktop; `policy.mode: file` impede que quem tem a chave da API reescreva a política por `PUT /api/v1/policy`. Os nós do Cialai não são efêmeros.

### `policy.json`

```jsonc
{
  // Todo nó do Cialai é de um usuário e sem tag. Os celulares de uma pessoa
  // alcançam os desktops dessa pessoa na porta do Cialai e nada mais.
  // Pessoas diferentes ficam isoladas. Sem tagOwners de propósito: nós com
  // tag saem de autogroup:self.
  "grants": [
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["tcp:4740"] }
  ],
  "tagOwners": {},
  "ssh": []
}
```

Recarga por `SIGHUP` ou `systemctl reload headscale`. Desktops compartilhados entre pessoas entram por grants explícitos por usuário, como `{"src": ["alice@"], "dst": ["bob@"], "ip": ["tcp:4740"]}`, nunca por tags.

### Receita em `infra/headscale`

`docker-compose.yml` com o serviço `headscale` da imagem fixada, portas `443:443`, `80:80` e `3478:3478/udp`, volumes `./config:/etc/headscale:ro` e `headscale-data:/var/lib/headscale`, healthcheck em `/health`, `restart: unless-stopped`. `config/config.yaml` e `config/policy.json` a partir dos modelos acima, com um script `bootstrap.sh` que pede o domínio e o IP, gera os arquivos, sobe o serviço, espera o certificado e imprime `docker compose exec headscale headscale apikeys create --expiration 365d` para colar no assistente do desktop. Os usuários são criados pelo assistente pela API. `README.md` da pasta com o guia de 10 minutos, o diagnóstico de DNS, 443, certificado e 3478, e a rotina de atualização com backup do SQLite.

## Núcleo do túnel em `packages/tunnel-core`

### Layout

```
packages/tunnel-core/
  go.mod                     módulo github.com/OrdinumTeam/cialai-platform/packages/tunnel-core, go 1.26.5, tailscale.com 1.102.0 fixado
  cmd/cialai-tunnel/main.go  sidecar do desktop, sem cgo
  internal/node/             ciclo de vida do tsnet, peers por chave de nó, ganchos de rede
  internal/edge/             estáticos, /api/health, /pair, autenticação, proxy reverso para a ponte
  internal/proxy/            proxy em loopback do celular, cookie de nonce, Origin, Bearer, prazos
  internal/pairing/          codec do QR, sessões de pareamento, registro de dispositivos, tokens
  internal/headscale/        cliente REST 0.29 e mapeamento de erros
  internal/control/          interface ControlAdmin, HeadscaleDirect, stub do corretor
  internal/rpc/              protocolo JSON por linha
  internal/statedir/         diretórios por plataforma, permissões, escrita atômica, trava
  internal/logx/             logs JSON, redação, anel
  mobile/                    pacote ligado por gomobile, só tipos aceitos pelo gobind
  testutil/                  Headscale em Docker, ponte falsa, Headscale falso
  docs/protocol.md, docs/pairing.md
```

Build do desktop com `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"` para `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` e `x86_64-pc-windows-msvc`, com os nomes que `bundle.externalBin` do Tauri espera. Build móvel com `gomobile bind -target ios,iossimulator -o Tunnelcore.xcframework ./mobile` e `gomobile bind -target android/arm64,android/amd64 -androidapi 26 -o tunnelcore.aar ./mobile`, com `golang.org/x/mobile` fixado.

### API `gomobile`, pacote `mobile`

Só `string`, `int`, `bool`, `error`, ponteiros de struct e interfaces cruzam a fronteira; tudo estruturado vai como JSON em string. O lado nativo guarda os tokens; o Go os mantém só em memória.

```go
package mobile

type Listener interface {
    // kind: "state" | "peer" | "proxy" | "pair" | "log"; payload é JSON.
    OnEvent(kind string, payloadJSON string)
}

func Version() string
func NewTunnel(stateDir string, l Listener) (*Tunnel, error)

type Tunnel struct{ /* opaco */ }

func (t *Tunnel) InspectPairPayload(payload string) (string, error)
// -> {"v":1,"control":"...","userId":"42","desktop":{"id","name","port"},"expiresAt":...,"hasAuthKey":true,"profileMatch":"existing"|"new"}; nunca ecoa segredos

func (t *Tunnel) Pair(payload, deviceName, deviceModel, platform, appVersion string) (string, error)
// Entra na tailnet se preciso, espera o peer do desktop, faz POST /pair pelo túnel.
// -> {"profileId","desktopId","deviceId","token","desktop":{"id","name","port","nodeKey"},"nodeKey":"<próprio>"}
// Erros levam prefixo de código estável: "auth_key_rejected: ...", "pair_consumed: ..."

func (t *Tunnel) StartProfile(profileID string) error
func (t *Tunnel) Stop() error
func (t *Tunnel) StatusJSON() (string, error)
// {"state","ip4","ip6","dnsName","nodeKey","keyExpiry","derp":{...},"peers":[...]}

func (t *Tunnel) OpenDesktop(desktopID, deviceToken string, preferredPort int) (string, error)
// -> {"url":"http://127.0.0.1:47400/?k=<nonce>","port":47400,"nonce":"..."}
func (t *Tunnel) CloseDesktop(desktopID string) error

func (t *Tunnel) NotifyNetworkChange(reachable bool)
func (t *Tunnel) NotifyForeground(active bool)
func (t *Tunnel) ForgetProfile(profileID string) error
func (t *Tunnel) SetLogLevel(level string)
```

### Sidecar

```
cialai-tunnel serve-stdio --state-dir <dir> --parent-pid <pid> [--log-level info|debug] [--log-file <caminho>]
cialai-tunnel doctor     --state-dir <dir> [--control-url <url>]
cialai-tunnel version
```

Tudo mais chega por stdin: URL de controle, chave da API, portas, segredos. Nunca por argumentos nem variáveis de ambiente, que processos do mesmo usuário conseguem ler. O supervisor Rust em `apps/desktop/src-tauri/src/tunnel/` copia o padrão de `macos/src-tauri/src/meetings/helper.rs`: caminho ao lado do executável por `tauri::process::current_binary`, `CIALAI_TUNNEL_BIN` como sobreposição em testes, eventos por enum etiquetado, chamadas pendentes com prazo de 30 s, reinício com recuo de 1, 2, 4 até 30 s e desistência após 10 tentativas com `tunnel.state=failed`, `shutdown` seguido de kill após 5 s na saída do app. O sidecar sai sozinho quando o pai some, conferindo a cada 2 s, e recusa iniciar se o arquivo de trava do diretório de estado pertence a um pid vivo.

### Protocolo por stdio

JSON por linha, UTF-8, um objeto por linha, máximo 256 KiB. Rust ao sidecar: `{"id":<u64>,"cmd":"<nome>","args":{...}}`. Sidecar ao Rust: `{"id":<u64>,"ok":true,"result":{...}}` ou `{"id":<u64>,"ok":false,"error":{"code":"<snake_case>","message":"<texto>","retryable":<bool>}}`; eventos `{"event":"<nome>","data":{...},"ts":"<RFC3339>"}`. Stderr só para logs. Ids únicos por processo; respostas podem chegar fora de ordem. Primeira linha do sidecar: `{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"1.102.0","pid":1234}}`; o Rust responde `hello` em até 5 s ou o sidecar sai com código 2.

| Comando | Argumentos | Resultado e eventos |
| --- | --- | --- |
| `hello` | `{protocol:1}` | `{protocol:1, capabilities:["control","edge","pairing","devices"]}` |
| `control.configure` | `{url, apiKey, caFile?}` | `{health:{ok, serverVersion}, apiKey:{prefix, expiresAt}}`; erros `control_unreachable`, `control_unauthorized`, `control_tls`, `control_unsupported_version` |
| `control.users.list` | `{}` | `{users:[{id, name, displayName}]}` |
| `control.users.create` | `{name, displayName}` | `{user:{id, name}}`; `control_conflict` se existe |
| `control.apikey.rotate` | `{days:365}` | `{apiKey, prefix, expiresAt}`; o Rust guarda e manda `control.apikey.expireOld {prefix}` |
| `node.up` | `{controlUrl, userId, userName, hostname, authKey?, forceLogin:false}` | `{state, ip4, ip6, dnsName, nodeKey}`; evento `node.state` a cada mudança |
| `node.down`, `node.status`, `node.logout` | `{}` | status `{state:"stopped"|"starting"|"needs-login"|"running"|"offline", ip4, ip6, dnsName, nodeKey, keyExpiry, health:[...], derp:{regionId, latencyMs}, peers:[{nodeKey, name, online, ip4, lastSeen}]}` |
| `edge.serve` | `{port:4740, staticDir, bridgeUrl:"http://127.0.0.1:3720", proxySecret, desktop:{id, name}, csp?}` | `{port}`; eventos `edge.state`, `session.opened {deviceId, remoteAddr, nodeKey}`, `session.closed {deviceId, reason}` |
| `edge.stop` | `{}` | `{}` |
| `pair.begin` | `{ttlSeconds:600}` | `{pairId, payload:"CIALAI1....", expiresAt, preAuthKeyId}`; eventos `pair.completed {pairId, device}`, `pair.failed {pairId, code}` |
| `pair.cancel` | `{pairId}` | `{}`; expira a chave de pré-autenticação |
| `pair.approve`, `pair.deny` | `{pairId}` | Só com aprovação exigida; a resposta de `/pair` fica retida até 60 s |
| `devices.list` | `{}` | `{devices:[...]}` sem hashes, com `online` |
| `devices.revoke` | `{deviceId, network:bool}` | `{}`; evento `devices.changed`; com `network` expira e apaga o nó no Headscale |
| `devices.rename`, `devices.rotateToken` | `{deviceId, name}`, `{deviceId}` | `{}` |
| `logs.tail` | `{lines:200}` | `{lines:[...]}` |
| `shutdown` | `{}` | Sai com 0 em até 3 s |

O Rust expõe `tunnel://state`, `tunnel://pair` e `tunnel://devices` ao webview. A mudança na ponte fica restrita a `BridgeConfig { proxy_secret, dev_open }`, ao `handshake()` de `bridge/mod.rs:141-232` e ao `device_id` na `Connection`.

### Diretórios de estado e logs

| Plataforma | Raiz | Conteúdo |
| --- | --- | --- |
| Desktop | `tunnel/` no diretório de dados do app, documento 04 | `tsnet/` com `tailscaled.state` e a chave privada do nó em 0600, `devices.json`, `identity.json` com id, nome, usuário e URL de controle, `pair.lock`, `tunnel.log` com rotação de 5 arquivos de 2 MiB, `pid` |
| iOS | `Application Support/cialai/profiles/<perfil>/tsnet/` com `NSFileProtectionCompleteUntilFirstUserAuthentication` e fora do backup | Estado do tsnet; `profiles.json` sem segredos; tokens no Keychain |
| Android | `filesDir/cialai/profiles/<perfil>/tsnet/` | Igual; `allowBackup` desligado; tokens no Keystore |

Segredos: chave da API no keychain pelo Rust, nunca em disco pelo sidecar; segredos de pareamento só em memória; tokens de dispositivo em hash no desktop e em texto só no armazenamento seguro do celular. Logs em JSON no stderr, `Logf` do tsnet descartado fora de debug, `UserLogf` sempre; filtro que mascara valores `hskey-`, `tskey-`, `nodekey:`, `privkey:` e qualquer campo cujo nome contenha secret, token ou key; anel de 500 linhas atrás de `logs.tail`; o QR nunca é logado.

## `ControlAdmin` e cliente do Headscale

```go
type ControlAdmin interface {
    Health(ctx) (ServerInfo, error)
    ListUsers(ctx) ([]User, error)
    CreateUser(ctx, name, display string) (User, error)
    CreatePreAuthKey(ctx, userID uint64, expiresAt time.Time) (PreAuthKey, error) // reusable=false, ephemeral=false, sem tags
    ExpirePreAuthKey(ctx, id uint64) error
    ListNodes(ctx, userName string) ([]Node, error)
    GetNode(ctx, id uint64) (Node, error)
    ExpireNode(ctx, id uint64) error
    DisableNodeExpiry(ctx, id uint64) error
    DeleteNode(ctx, id uint64) error
    RegisterNode(ctx, userName, mkey string) (Node, error) // só no plano B
    RotateAPIKey(ctx, expiresAt time.Time) (string, error)
    ExpireAPIKey(ctx, prefix string) error
}
```

`HeadscaleDirect` contra a REST 0.29, `Authorization: Bearer <chave>`, JSON, prazo de 15 s, convenções do grpc-gateway com uint64 como string e datas RFC3339:

| Chamada | Endpoint | Requisição | Resposta usada |
| --- | --- | --- | --- |
| Health | `GET /api/v1/health`, reserva `GET /health` | | versão quando existe |
| ListUsers | `GET /api/v1/user` | | `users[].{id, name, displayName, createdAt}` |
| CreateUser | `POST /api/v1/user` | `{"name":"foco","displayName":"Foco"}` com nome em `^[a-z0-9-]{1,32}$` | `user.{id, name}` |
| CreatePreAuthKey | `POST /api/v1/preauthkey` | `{"user":"42","reusable":false,"ephemeral":false,"expiration":"<RFC3339>","aclTags":[]}` | `preAuthKey.{id, key, expiration, used}` |
| ExpirePreAuthKey | `POST /api/v1/preauthkey/expire` | `{"id":"17"}` | `{}` |
| ListNodes | `GET /api/v1/node?user=<nome>` | | `nodes[].{id, nodeKey, machineKey, ipAddresses, name, givenName, online, lastSeen, expiry, user.id, registerMethod}` |
| GetNode | `GET /api/v1/node/{id}` | | idem |
| ExpireNode | `POST /api/v1/node/{id}/expire` | Parâmetros de URL `?expiry=<RFC3339>` ou `?disableExpiry=true`, sem corpo; verificado no spike 3 | `node` |
| DeleteNode | `DELETE /api/v1/node/{id}` | | `{}` |
| RegisterNode | `POST /api/v1/node/register?user=<nome>&key=mkey:...` | | `node` |
| RotateAPIKey | `POST /api/v1/apikey` | `{"expiration":"<RFC3339>"}` | chave completa |
| ExpireAPIKey | `POST /api/v1/apikey/expire` | `{"prefix":"..."}` | `{}` |

A execução confirma os caminhos exatos no `/swagger` do Headscale 0.29.3 implantado, porque a especificação OpenAPI não está mais no repositório. Erros: transporte e prazo em `control_unreachable`, com 3 tentativas em 1, 2 e 4 s; TLS em `control_tls` com dica de certificado, relógio ou CA própria por `caFile`; 401 e 403 em `control_unauthorized`; 404 em `control_not_found`, tratando nó ausente como já revogado; 409 em `control_conflict`; 5xx em `control_server_error` após retentativa; forma inesperada em `control_protocol` com a versão do servidor. Depois de cada resposta o cliente guarda a diferença entre o cabeçalho `Date` e o relógio local e calcula a `expiration` das chaves como `agora do servidor + ttl`.

## Borda no desktop e proxy no celular

Borda, só no listener da tailnet em `:4740`, nunca em loopback:

| Rota | Comportamento |
| --- | --- |
| `GET /`, `/mobile.html`, `/assets/*` | Estáticos de `staticDir` com as regras de `backend/node/services/mobile-site.js`: `realpath` contido na raiz, recusa de dotfiles, `..`, barras invertidas e bytes nulos, fallback para `mobile.html`, `no-store` no documento, `immutable` em `/assets/*`, `nosniff`; CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'self' blob:` |
| `GET /api/health` | `{"status":"ok","service":"cialai","desktop":{"id","name"}}` |
| `POST /pair` | Fluxo abaixo; limite de 5 por minuto por IP de origem; `pairId` bloqueado após 10 falhas |
| Upgrade de `/pty` e `/` | Exige `Authorization: Bearer cdt1.<deviceId>.<segredo>` ou, no plano B, o mesmo valor como subprotocolo; comparação em tempo constante com `tokenHash` ou `tokenPrevHash`; `WhoIs(remoteAddr)` com chave de nó igual à do dispositivo; no máximo 2 sockets por dispositivo, dentro dos 8 da ponte; `httputil.ReverseProxy` para `bridgeUrl` acrescentando `X-Cialai-Proxy-Secret`, `X-Cialai-Device-Id` e `X-Cialai-Node-Key`, removendo qualquer cabeçalho com esse prefixo vindo de fora e preservando `Origin` |

O bundle da página do celular é empacotado como recurso do Tauri e o caminho absoluto vai em `edge.serve`, porque o Tauri embute `frontendDist` no binário e o sidecar não consegue lê-lo.

Proxy no celular, em `127.0.0.1:47400` por perfil, reserva de `47401` a `47409`, depois aleatória com aviso: a primeira requisição precisa trazer `?k=<nonce>`, recebe `Set-Cookie: cialai_k=<nonce>; HttpOnly; SameSite=Strict; Path=/` e `302 /`; as demais precisam do cookie ou recebem 403 sem nunca ganhar o Bearer; upgrades de `/pty` exigem `Origin` igual à origem do proxy ou ausente; `Host` reescrito para `cialai-desktop`; `Authorization: Bearer` injetado; `DialContext` do transporte é o `Dial` do nó ao IP do desktop resolvido pela lista de peers pela chave de nó a cada discagem; prazo de leitura de 60 s no lado do túnel, renovado pelos pings de 20 s da ponte, derrubando os dois lados em qualquer erro. Depois do upgrade o proxy é um cano de bytes.

## Pareamento

### Payload do QR

Texto `CIALAI1.` seguido de base64url sem padding de:

```json
{
  "v": 1,
  "c": "https://hs.example.com",
  "u": "42",
  "un": "foco",
  "k": "hskey-auth-...",
  "d": { "id": "d_9f3k...", "n": "MacBook de Foco", "nk": "nodekey:<64 hex>", "ip4": "100.64.0.3", "p": 4740 },
  "s": "<32 bytes base64url>",
  "e": 1789000000,
  "pid": "p_a81c..."
}
```

Limites: `c` https até 128 caracteres, http só em loopback em builds de desenvolvimento; `u` uint64 em string; `un` até 32; `k` até 96 caracteres, nulo só no plano B; `d.id` 16 bytes base64url; `d.n` até 48 caracteres sem caracteres de controle; `d.nk` exatamente `nodekey:` mais 64 hex; `d.p` de 1 a 65535; `s` exatamente 32 bytes; `pid` 8 bytes; JSON total até 700 bytes, QR até a versão 20 em correção M, renderizado com 280 px ou mais. Campos desconhecidos recusados; `v` diferente de 1 pede atualização do app.

### Validade e rotação

TTL de 600 s a partir de `pair.begin`, julgado pelo relógio do desktop; QR regenerado a cada 90 s enquanto o diálogo está visível, com segredo e chave novos, a chave anterior expirada pela API e a sessão anterior cancelada; fechar o diálogo cancela. Chave de pré-autenticação com `reusable` falso, `ephemeral` falso e `expiration` de 600 s pelo relógio do servidor. O celular trata `e` como informativo: se está mais de 60 s no passado, mostra "expirado" sem tocar na rede.

### Fluxo

1. O celular lê; `InspectPairPayload` valida; a tela pergunta "Vincular a <nome>?" e pede câmera e rede local se faltarem.
2. `Pair`: casa o perfil por `c` e `u`. Perfil existente com estado válido ignora `k`, como o `tsnet` já faz. Perfil novo cria o diretório e sobe com `ControlURL=c`, `AuthKey=k`, `Hostname="cialai-<modelo>-<4 aleatórios>"`, `Ephemeral=false`.
3. Espera até 20 s o peer `d.nk` em `Status().Peer`; pega os IPs, preferindo v4; disca; `POST http://<ip>:<p>/pair` com prazo de 10 s e corpo `{"v":1,"pairId":"...","secret":"...","device":{"name":"iPhone de Foco","model":"iPhone16,1","platform":"ios","app":"1.0.0","nodeKey":"nodekey:<próprio>"}}`.
4. Borda: `pairId` existe, não expirou, não foi consumido; `subtle.ConstantTimeCompare` no segredo; `WhoIs(remoteAddr)` com chave de nó igual a `device.nodeKey` e usuário igual ao configurado; retenção opcional para aprovação; consome; grava o registro; responde `200 {"deviceId":"dev_...","token":"cdt1.dev_....<43 caracteres>","desktop":{"id","name","port":4740},"issuedAt":"..."}`; emite `pair.completed`; expira a chave de pré-autenticação de forma assíncrona.
5. Celular: token no armazenamento seguro sob `cialai.device.<desktopId>`, perfil em `profiles.json`; `OpenDesktop`; o WebView carrega a URL devolvida. Aberturas seguintes fazem só `StartProfile` e `OpenDesktop`.

Os quadros `hello` e `welcome` estendidos estão no documento 07.

### Erros e mensagens

| Código | Gatilho | Mensagem no celular |
| --- | --- | --- |
| `payload_invalid` | esquema ou limites | Este QR code não é um código de pareamento do Cialai. |
| `payload_version` | `v` não suportado | Atualize o Cialai neste celular para parear com este computador. |
| `payload_expired` | `e` no passado | Este código expirou. Gere um novo no computador. |
| `auth_key_rejected` | Headscale recusou a chave | Este código já foi usado ou expirou. Gere um novo. Se não foi você, revogue no computador. |
| `control_unreachable` | servidor inacessível | Não foi possível alcançar o servidor Cialai em hs.example.com. Confira a conexão. |
| `peer_not_found` | desktop invisível em 20 s | Seu computador ainda não está acessível. Deixe o Cialai aberto nele e tente de novo. |
| `pair_consumed`, `pair_expired`, `pair_unknown` | estado na borda | Este código já foi usado. Este código expirou. O pareamento foi cancelado no computador. |
| `pair_secret_mismatch` | segredo errado | O pareamento falhou. Gere um novo código. O desktop registra e conta |
| `pair_node_mismatch` | `WhoIs` diferente do declarado | Igual; o desktop mostra aviso de segurança |
| `pair_denied`, `pair_timeout` | aprovação | O computador recusou este pareamento. O computador não respondeu. Tente de novo. |
| `device_revoked` | 4401 depois de pareado | Este celular foi removido de <nome>. Pareie de novo para reconectar. |

### Registro de dispositivos, `devices.json`

```json
{
  "version": 1,
  "desktop": { "id": "d_...", "name": "MacBook de Foco", "createdAt": "..." },
  "devices": [{
    "id": "dev_...", "name": "iPhone de Foco", "model": "iPhone16,1", "platform": "ios", "app": "1.0.0",
    "nodeKey": "nodekey:...", "nodeId": "17", "userId": "42", "ip4": "100.64.0.9",
    "tokenHash": "sha256:...", "tokenPrevHash": null, "tokenIssuedAt": "...", "tokenRotatedAt": null, "prevValidUntil": null,
    "pairedAt": "...", "lastSeenAt": "...", "lastRemoteAddr": "100.64.0.9:51234",
    "revoked": false, "revokedAt": null
  }]
}
```

Modo 0600, escrita em arquivo temporário seguida de renomeação, JSON legível. `identity.json` guarda id, nome, usuário e URL de controle do desktop, sem segredos.

### Revogação, novo pareamento, multiplicidade e rotação

Revogar marca `revoked`, fecha os sockets do dispositivo com 4401 em menos de 1 s e emite `devices.changed`; com `network`, padrão para celular perdido, chama `expire` e `delete` do nó, o que também desconecta esse celular de qualquer outro desktop da mesma pessoa, porque o celular é um nó só; linhas revogadas ficam 30 dias. Um `/pair` de uma chave de nó já registrada troca o token, invalida o anterior na hora e mantém o id; um celular que executou `ForgetProfile` chega com chave nova e ganha linha nova, e a antiga mostra "não visto desde". Celulares por desktop sem limite, 2 sockets por dispositivo, concessão de largura entre celulares como já existe em `terminal.rs`. Desktops por celular: mesma tailnet e usuário, um nó e N tokens; tailnets diferentes, perfis separados e um nó ativo por vez, com troca de 3 a 6 s mostrada na interface. Token girado a cada 30 dias: a borda responde a um upgrade bem sucedido com `X-Cialai-Token-Next`, o proxy nativo guarda e usa no próximo upgrade, `tokenPrevHash` vale por 24 h. Chave da API girada 14 dias antes de expirar. Chaves de nó não giram; as chaves de sessão do WireGuard giram sozinhas.

## Modelo de ameaças

| Camada | O que garante |
| --- | --- |
| Identidade de nó | Só entra na tailnet quem registrou com uma chave emitida por este Headscale; revogar o nó tira o celular da rede em menos de um minuto |
| Criptografia | WireGuard ponta a ponta; nem o Headscale nem o DERP leem o tráfego |
| Isolamento | Política com `autogroup:self`: os celulares de uma pessoa só alcançam os desktops dessa pessoa na porta 4740 |
| Borda | Só na tailnet; token por dispositivo; `WhoIs` obrigatório; 2 sockets por dispositivo; limite de taxa em `/pair` |
| Ponte | Só em loopback; exige o segredo da borda; lista permitida; nenhum processo local fala com ela sem o segredo |
| Proxy | Só em loopback; nonce por abertura; cookie estrito; `Origin` obrigatório; sem Bearer para quem não tem o cookie |
| Página | Nunca vê credencial; biometria na casca para escrever, abrir e encerrar |
| Segredos em repouso | Chave da API no keychain; tokens em hash no desktop e no armazenamento seguro do celular; estado do nó com proteção de dados e fora do backup |

O que isso não cobre: a saída do terminal atravessa o túnel cifrada, mas atravessa, e `cat .env` no celular mostra o `.env` no celular; quem tem a chave da API controla o Headscale inteiro; um computador dormindo ou com o app fechado fica inacessível; o DERP embutido é ponto único de falha para caminhos relés.

## Riscos ranqueados

| Ordem | Risco | Gravidade | Chance | Tratamento |
| --- | --- | --- | --- | --- |
| 1 | Chave da API do Headscale em desktops de um servidor compartilhado | Crítica | Certa se houvesse modo hospedado sem corretor | Só auto hospedado na v1; aviso no assistente; `ControlAdmin` |
| 2 | Vazamento ou replay do QR | Alta | Média | Uso único nas duas camadas, rotação, `WhoIs`, aprovação opcional |
| 3 | App Review e conformidade de exportação | Alta | Média | Sem VPN no texto, sem NetworkExtension, ensaio por TestFlight externo |
| 4 | Isolamento errado entre usuários | Alta | Média | Política no dia um, spike 3, Headscale 0.29.3 ou mais novo |
| 5 | Reconexão após troca de rede ou segundo plano | Média | Alta | Ganchos de rede e primeiro plano, prazo de 60 s, spike 2 |
| 6 | Proxy em loopback usado por apps locais ou páginas | Média | Média | Nonce, cookie, `Origin` |
| 7 | Tamanho, memória e bateria do runtime Go | Média | Média | Spike 1 |
| 8 | Atrito da auto hospedagem | Média | Alta | Receita e assistente com diagnóstico |
| 9 | Desktop dormindo e DERP único | Média | Alta | Assertiva de vigília opcional; documentação |
| 10 | Expiração de nó ou de chave da API | Baixa | Média | Spike 3, `disableExpiry`, rotação |
| 11 | Deriva de versão entre tsnet e Headscale | Baixa | Média | Versões fixadas e integração no CI |
| 12 | Desvio de relógio | Baixa | Baixa | TTL pelo desktop, `Date` do servidor |

## Plano B: app oficial da Tailscale

Documentado como modo manual, nunca como degradação automática. O app oficial aceita servidor de coordenação próprio, mas não chave de pré-autenticação, então a pessoa faz o login interativo no Headscale, copia a chave `mkey:` da página de registro e cola no desktop, que chama `POST /api/v1/node/register`. O WebView carrega `http://<ip do desktop>:4740/?k=...` direto pela VPN do sistema, sem proxy e portanto sem injeção de Bearer: a borda aceita o token como subprotocolo do WebSocket, injetado pela casca na página, o que é mais fraco. Custos: VPN do sistema sempre ligada, bateria, conflito com outras VPNs, dois apps instalados. Implementar só se um build do núcleo Go ficar inviável numa plataforma; até lá, a borda aceita o subprotocolo por ser útil para desenvolvimento.

## Testes

### Unitários

Go, sem rede: codec e limites do QR, comparação em tempo constante, consumo único, TTL com relógio injetado, escrita atômica do registro, janelas de hash; um teste por endpoint do Headscale contra `httptest` conferindo método, caminho, corpo e Bearer, mapeamento de erros, retentativas, desvio de `Date`, uint64 como string; framing do stdio com linha longa, JSON inválido, comando desconhecido, id duplicado, respostas fora de ordem, prazo do `hello`; proxy com cookie, 403, `Origin`, injeção e remoção de `Authorization`, upgrade contra um eco falso com quadros de texto, binários e de 1 MiB, prazo de 60 s com relógio falso, captura de `X-Cialai-Token-Next`; borda com os casos de `mobile-site.js`, `/api/health`, `/pair` com cada código, limite de taxa, cabeçalhos da borda, teto de sockets; nó com peers por chave e IP atualizado, `NotifyNetworkChange` chamando `rebind` e `restun`.

Rust, estendendo `bridge/mod.rs:323-611` e `protocol.rs:131-254`: segredo válido marca `auth: "device"`; segredo ausente ou errado devolve 403 salvo `dev_open`; subprotocolo; revogação fecha com 4401; `Welcome` serializa; supervisor com eventos, recuo, `shutdown`, kill e saída pelo pai.

JS e Expo: 4401 vira "removido" sem retentativa; URL do WebSocket por `location.host`; `validateControlUrl`; saúde `cialai`; loja de perfis; transições chamando o módulo.

### Integração com Headscale em Docker

Pacote `integration` em Go com tag de build, subindo `headscale/headscale:0.29.3` com o `config.yaml` acima, TLS de teste com CA própria por `caFile`, DERP embutido e o `policy.json`; chave da API criada pela CLI no contêiner. Casos: usuários `alice` e `bob`; desktop de alice por `node.up` com chave; nó sem expiração ou `disableExpiry` funcionando; dois celulares em processo; celular de alice pareia pelo QR; replay falha com `pair_consumed` e `auth_key_rejected`; sessão expirada falha com `pair_expired`; eco por WebSocket com texto, binário e 1 MiB atravessando proxy, túnel, borda e ponte falsa, que viu o segredo e o id do dispositivo; celular de bob não alcança o desktop de alice e não o vê nos peers; revogação fecha o socket em 2 s e, com `network`, o nó some de `GET /api/v1/node`; rotação da chave da API expira o prefixo antigo; Headscale parado por 60 s mantém o caminho direto e o celular religa quando volta. Roda no CI Linux só com o núcleo do desktop; as ligações móveis ficam nos roteiros manuais.

### Roteiros manuais

| Roteiro | Passos | Aprovado quando |
| --- | --- | --- |
| Modo avião | Celular numa sessão; avião por 60 s; desliga | Desktop vê o celular desconectado em até 40 s, nenhum shell morre; celular religa em até 10 s com replay e offset certo |
| Celular atrasado | `yes \| head -c 50000000` no desktop | Desktop fluido; celular recebe `detached` e religa com 256 KiB; o proxy nunca desconecta sozinho |
| Revogação | Revogar enquanto o celular digita; parear de novo | "Removido" em até 5 s; novo pareamento funciona; com `network` o nó some do Headscale |
| Reinício do desktop | Sair e reabrir o app | Celular offline em até 40 s e de volta em até 15 s sem parear de novo; tokens sobrevivem; pid do sidecar muda uma vez |
| Reinício do app | Matar e reabrir frio | Sem QR; página em até 5 s no Wi-Fi e 10 s no LTE; `localStorage` intacto |
| Troca de rede | Wi-Fi para LTE e volta | Religa em até 10 s em cada troca; `NotifyNetworkChange` no log |
| Segundo plano | 10 minutos e volta | Religa em até 5 s; no Android o processo vive ou renasce limpo |
| Só DERP | UDP bloqueado no Wi-Fi do celular | Conecta pelo relé; latência aceitável; estado mostra relé |
| Headscale fora | Parar o servidor por 2 minutos | Sessão direta continua ou religa; estado "servidor inacessível" para conexões novas; recupera ao voltar |
| Relógio adiantado | Celular 30 minutos à frente | Pareamento funciona; anotar qualquer recusa de handshake ao voltar o relógio |
| Segundo celular e segundo desktop | Parear outro celular; parear o primeiro celular com outro desktop do mesmo usuário | Coexistem; concessão de largura correta; troca de desktop sem reentrar na rede |
| Foto do QR | Fotografar e ler a foto depois do pareamento real | Recusado com `pair_consumed` e `auth_key_rejected`; desktop mostra a tentativa |
| Permissões | Negar câmera; negar rede local | Prompts claros; negar rede local só força o DERP |

## Spikes da Fase 0

| Ordem | Spike | Aprovado quando | Se falhar |
| --- | --- | --- | --- |
| 1 | `gomobile` com `tsnet` num iPhone e num Android reais, entrando no Headscale em Docker e discando um desktop | Conecta em até 8 s por LTE via DERP; até 20 MB a mais no IPA e 25 MB no AAR arm64; até 120 MB de memória conectado; 50 ciclos de segundo plano sem travar | `libtailscale` em C com o mesmo tsnet; se Go no iOS for inviável, celular no plano B e sidecar mantido |
| 2 | Transições de rede e suspensão nos dois sistemas com os ganchos ligados | WebSocket de volta em até 10 s em 10 de 10 execuções por caso | `netmon.InjectEvent` e ciclo completo de `Stop` e `StartProfile` ao voltar |
| 3 | Política e expiração no Headscale 0.29.3 com dois usuários | Mesmo usuário conecta, estranho recusado, peers escondidos; nó sem expiração ou `disableExpiry`; `preauthkey/expire` por id | Grants explícitos por usuário; fixar na última versão boa |
| 4 | WKWebView com o proxy em loopback carregando o bundle do protótipo, só com a validação de URL e o nome do serviço ajustados | Terminal com replay, binários, `pty_ack` e concessão; sem violação de CSP; contexto seguro; `localStorage` persiste; cookie funciona com `sharedCookiesEnabled` desligado | Token por subprotocolo; prefixo de caminho por abertura |
| 5 | WebView do Android com o AAR pelo Expo Modules e o plugin de segurança de rede | Igual ao 4 em Android 12 e 14; relatório de pré-lançamento do Play sem aviso além do loopback | Texto claro global só como último recurso |
| 6 | Ensaio do App Review por TestFlight externo com texto e conformidade finais | Aprovado, ou retorno que não exija NetworkExtension | Plano B no iOS ou um projeto diferente com NetworkExtension |
| 7 | Empacotamento com o sidecar nos três sistemas, assinatura e notarização | Instalação limpa até celular pareado em até 3 minutos por alguém que não escreveu o código | Corrigir antes da Fase 1 |
| 8 | Robustez do proxy: 8 sockets, quadros de 1 MiB, rajadas de 50 MB, 24 h de soak | Zero desconexões pelo proxy; expulsão só na ponte; sem crescimento de memória | Hijack e cópia explícita nos upgrades |
