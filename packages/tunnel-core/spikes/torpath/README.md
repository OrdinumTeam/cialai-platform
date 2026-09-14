# Spike do caminho Tor

Este spike publica um onion service v3 single-hop com chave persistente e leva
um protocolo mínimo de eco por TLS 1.3 mútuo. Os certificados autoassinados são
Ed25519 e os dois lados conferem a chave pública esperada; conhecer apenas o
endereço `.onion` não autoriza uma conexão.

O modo single-hop é deliberadamente **não anônimo**. Ele reduz o caminho do
computador que oferece o serviço, mas expõe sua origem à rede Tor. A chave usada
neste modo nunca deve ser reutilizada num onion service anônimo normal.

## Bundle fixado

`tools/fetch-tor.mjs` baixa o Tor Expert Bundle 15.0.22 do arquivo oficial,
confere SHA-256 antes de extrair e instala em
`packages/tunnel-core/build/tor/<target>`. No macOS, os Mach-O extraídos recebem
assinatura ad hoc local depois da verificação do arquivo; a assinatura de
distribuição continua sendo trabalho de empacotamento.

| Target | SHA-256 assinado |
| --- | --- |
| macOS ARM64 | `e8ea3f667c83309abad34280f0f9e1cfae52843da6b8db111ca15d6221051db5` |
| macOS x86_64 | `be1be1cb13cd093713f02a0beade0d2471b61119011bfeb0efc08353eadf2e4e` |
| Linux x86_64 | `08d49de27f542b8f73e2014e064d8320562b5d20019c03d4725c5a5249d97985` |
| Windows x86_64 | `231dad6b9cb401a54c260db7046965ef04e4f72ff071b140d423fb5da281ab1e` |

O arquivo oficial 15.0.22 não contém Expert Bundle Linux ARM64. O downloader
falha explicitamente nesse target; CON-040 terá de escolher uma fonte de build
reprodutível ou rever essa matriz, em vez de baixar um artefato inexistente.

```sh
node tools/fetch-tor.mjs
node --test tools/fetch-tor.test.mjs
cd packages/tunnel-core
go build -trimpath -o build/torpath/torpath ./spikes/torpath
```

O binário desta versão do bundle informa Tor 0.4.9.12. O `torrc` do servidor é
gerado com:

```text
SocksPort 0
ControlPort auto
ControlPortWriteToFile "..."
CookieAuthentication 1
HiddenServiceNonAnonymousMode 1
HiddenServiceSingleHopMode 1
__OwningControllerProcess <pid-do-spike>
```

Os caminhos `GeoIPFile` e `GeoIPv6File` do bundle também são acrescentados.
O `bine` abre e autentica o control port com SAFECOOKIE, publica por
`ADD_ONION ED25519-V3` com `Flags=NonAnonymous` e encerra o processo Tor. O PID
pai no `torrc` é uma segunda proteção contra processo órfão.

## Ensaio em dois computadores

Nos dois computadores, baixe o bundle, compile o spike e crie uma identidade
TLS. Troque somente as chaves públicas impressas; nunca copie `tls.key` nem
`onion.key`.

No servidor:

```sh
TOR=build/tor/macos-aarch64/tor/tor
BIN=build/torpath/torpath
$BIN keygen --identity build/torpath-server/tls.key
$BIN server \
  --tor "$TOR" \
  --state build/torpath-server \
  --identity build/torpath-server/tls.key \
  --peer-key '<CHAVE_PUBLICA_DO_CLIENTE>' \
  --max-connections 20
```

Guarde a linha `onion_published`. Ela separa `controlReadyMs`, `bootstrapMs` e
`publishMs`. O endereço termina em `:443`.

No cliente, uma rodada quente cria dez conexões TCP/TLS novas dentro do mesmo
processo Tor já inicializado:

```sh
TOR=build/tor/macos-aarch64/tor/tor
BIN=build/torpath/torpath
$BIN keygen --identity build/torpath-client/tls.key
$BIN client \
  --tor "$TOR" \
  --state build/torpath-client-warm \
  --onion '<ENDERECO_ONION:443>' \
  --identity build/torpath-client/tls.key \
  --peer-key '<CHAVE_PUBLICA_DO_SERVIDOR>' \
  --connections 10 \
  --echoes 3 \
  --label warm
```

Para dez amostras frias, execute dez vezes com `--connections 1` e um diretório
`--state` vazio diferente em cada rodada. Assim cada amostra inclui um bootstrap
novo, sem confundir dez conexões sobre um Tor já quente com dez partidas frias.
Uma instalação externa de Tor também pode ser usada no outro computador com
`--socks 127.0.0.1:9050` no lugar de `--tor` e `--state`.

Cada conexão informa `socksDialMs`, `tlsHandshakeMs`, mediana e p95 dos ecos. A
linha `summary` agrega as amostras. Se uma chave TLS não corresponder ao pin, o
handshake é recusado.

## Reinício e encerramento

Interrompa o servidor e inicie exatamente o mesmo comando com o mesmo
`--state`. `onionKeyCreated` deve ser `false` e o endereço de
`onion_published` deve ser idêntico. A linha final `tor_stopped` traz o PID que
deve deixar de existir:

```sh
ps -p '<PID_DA_LINHA_TOR_STOPPED>' -o pid=,ppid=,stat=,command=
```

O critério físico de CON-011 só fecha depois de duas máquinas reais produzirem
dez amostras frias, dez quentes, o mesmo endereço após reinício e nenhum PID
remanescente.

## Evidência local de 14/09/2026

O harness foi exercitado num Mac ARM64 com um Tor servidor e outro cliente:

| Execução | Bootstrap servidor | Publicação | Bootstrap cliente | SOCKS dial | TLS | Eco mediana / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Primeira, conexão 1 | 15,818 s | 5,088 s | 13,194 s | 6,633 s | 0,891 s | 0,909 s / 1,249 s no agregado de 6 ecos |
| Primeira, conexão 2 | — | — | — | 1,039 s | 1,012 s | incluído no agregado acima |
| Reinício com mesmo estado | 1,801 s | 5,129 s | 2,139 s | 109,672 s | 1,005 s | 1,021 s / 1,291 s |

O endereço v3 foi idêntico antes e depois do reinício. Os quatro PIDs Tor das
duas execuções não existiam após `tor_stopped`, e o Tor 0.4.9.12 respondeu
`Configuration was valid` para o `torrc`. Estes números apenas provam o harness
local; não substituem as duas máquinas exigidas por CON-011. A demora de 109,672
s no segundo circuito também mostra por que o ensaio precisa das vinte amostras
físicas antes de qualquer decisão de produto.

Referências: [arquivo do Tor Browser 15.0.22](https://archive.torproject.org/tor-package-archive/torbrowser/15.0.22/),
[manifesto de checksums assinado](https://archive.torproject.org/tor-package-archive/torbrowser/15.0.22/sha256sums-signed-build.txt),
[configuração oficial de onion services](https://community.torproject.org/onion-services/setup/).
