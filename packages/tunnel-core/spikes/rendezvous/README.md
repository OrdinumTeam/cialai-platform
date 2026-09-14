# Spike de rendezvous Tor para QUIC

Este diretório contém o protocolo, a máquina de estados e os adaptadores reais
que tentam trocar uma sessão autenticada pelo Tor por uma conexão QUIC direta.
Ainda faltam os comandos de campo sobre os runtimes do `torpath` e os ensaios
em duas máquinas; portanto o teste local não comprova furo de NAT.

Fluxo implementado:

1. o cliente cria um `sessionId` aleatório e envia pelo canal Tor autenticado
   sua chave Ed25519 QUIC e candidatos LAN, IPv6, mapeados e STUN;
2. o servidor confere que a chave da oferta é a mesma identidade autenticada
   no mTLS do Tor e devolve seus candidatos;
3. servidor e cliente enviam pacotes de abertura. A interface exige que coleta
   de oferta, abertura e QUIC compartilhem um único socket UDP;
4. o cliente disca os candidatos do servidor e envia `direct_ready` pelo Tor;
5. só depois de o servidor aceitar QUIC e responder `switch_ack` os dois lados
   consideram o caminho direto confirmado;
6. falha no dial ou no accept envia `fallback`, preservando o caminho Tor.

O wire format é JSON delimitado por nova linha, versão 1, limitado a 64 KiB,
sem campos desconhecidos nem JSON extra. Cada oferta aceita no máximo 32
candidatos válidos e sem endereços duplicados. As chaves das ofertas são
comparadas em tempo constante com o peer já pinado no canal Tor; a mensagem não
substitui a autenticação mTLS.

```sh
cd packages/tunnel-core
go test -race -count=1 -v ./spikes/rendezvous
go vet ./spikes/rendezvous
```

O transporte falso cobre sucesso e fallback. No sucesso, o teste exige que o
servidor mande abertura ao candidato STUN refletido do cliente antes de o dial
direto completar, e que os dois lados registrem a mesma sessão. No fallback,
simula NAT simétrico e confirma que nenhuma conexão direta é devolvida.

`NewTLSControl` adapta o stream TLS 1.3 já pinado do onion e deriva
`PeerPublicKey` do certificado efetivamente aceito. `NewQUICDirectTransport`
possui um único socket UDP para candidatos locais, PCP/NAT-PMP/UPnP, STUN,
pacotes não QUIC de abertura, dial e accept; `Probe` expõe os dados da coleta.
O teste de adaptadores faz handshake mTLS e uma conexão QUIC real em loopback,
mas não substitui os ensaios físicos com UPnP ligado e desligado, 4G/5G e CGNAT.

Os comandos de campo vivem no binário `torpath`, pois reaproveitam o bundle, o
estado persistente e a publicação do onion do CON-011. Depois de criar as duas
identidades e trocar somente as chaves públicas, rode no servidor:

```sh
BIN=build/torpath/torpath
TOR=build/tor/macos-aarch64/tor/tor
$BIN rendezvous-server \
  --tor "$TOR" --state build/rendezvous-server \
  --identity build/rendezvous-server/tls.key \
  --peer-key '<CHAVE_PUBLICA_DO_CLIENTE>' \
  --stun stun.cloudflare.com:3478
```

Copie o `address` de `rendezvous_onion_published` e rode no cliente:

```sh
BIN=build/torpath/torpath
TOR=build/tor/macos-aarch64/tor/tor
$BIN rendezvous-client \
  --tor "$TOR" --state build/rendezvous-client \
  --onion '<ENDERECO_ONION:443>' \
  --identity build/rendezvous-client/tls.key \
  --peer-key '<CHAVE_PUBLICA_DO_SERVIDOR>' \
  --stun stun.cloudflare.com:3478
```

Cada lado emite `rendezvous_measurement` com o caminho final, candidato,
tempos, contagem de pacotes de abertura e `probe`. `--include-loopback` existe
somente para smoke na mesma máquina. O smoke local confirmou a troca onion
mTLS → QUIC e está registrado em
`build/rendezvous-{server,client}/smoke-attempt-3.jsonl`; ele não substitui os
ensaios em duas máquinas e nas redes físicas exigidas.
