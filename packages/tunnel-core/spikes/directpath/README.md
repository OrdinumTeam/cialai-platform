# Direct path spike

This directory is the reproducible harness for CON-010. It is not product
code. It tests QUIC over one shared UDP socket, mutually pinned Ed25519
identities, LAN and global IPv6 candidates, UPnP/NAT-PMP/PCP discovery and
mapping, STUN reflexive candidates, and non-QUIC opening packets.

## Same-machine smoke test

Run from `packages/tunnel-core` in two terminals. First create the client key:

```sh
go run ./spikes/directpath keygen \
  --identity build/spikes/directpath/client.key
```

Copy the printed `publicKey` into the server command:

```sh
go run ./spikes/directpath server \
  --identity build/spikes/directpath/server.key \
  --peer-key CLIENT_PUBLIC_KEY \
  --offer build/spikes/directpath/server-offer.json \
  --include-loopback \
  --max-connections 1
```

Then run the client:

```sh
go run ./spikes/directpath client \
  --identity build/spikes/directpath/client.key \
  --offer build/spikes/directpath/server-offer.json \
  --count 10
```

The final JSON line records the selected candidate, handshake duration, RTT
minimum, median, p95, maximum and mean, addresses, fingerprints and QUIC
version. A wrong server key or a client key other than `--peer-key` fails the
TLS handshake.

## Two computers and manual candidate exchange

Generate the client identity first and give its public key to the server. On
both commands add one or more STUN endpoints, for example
`--stun stun.cloudflare.com:3478`. Transfer `server-offer.json` to the client.
For simultaneous opening packets, start the server with
`--peer-offer client-offer.json`, and start the client with
`--write-offer client-offer.json --connect-after 15s`. Transfer the client
offer to the exact path watched by the server during that interval. The two
processes send opening packets from the same UDP sockets later used by QUIC.

Run the experiment on the same LAN, with the client computer routed through a
phone on 4G/5G, and on a third real network. Preserve the JSON lines and both
offers, but review them before sharing because they contain public network
addresses. Record whether PCP, NAT-PMP or UPnP was discovered, the mapping and
STUN result, handshake time and RTT. Real-network runs are required before
CON-010 itself can be marked complete.

