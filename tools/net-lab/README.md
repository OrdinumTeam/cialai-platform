# Laboratório de NAT e reserva

Laboratório automatizado de CON-031 e parte de CON-060. Sobe em Docker duas redes
domésticas atrás de roteadores Linux com NAT por iptables, uma internet simulada
com STUN e uma rede Tor simulada, e roda o `cialai-tunnel` real contra celulares
sem interface feitos com o pacote `mobile`. Nada fala com servidores públicos:
depois de baixar as imagens, o laboratório só usa endereços das próprias redes.

## Como rodar

Requer Docker com Compose v2 e Go 1.26.5. Na raiz do repositório:

```sh
npm run test:netlab
```

O teste compila `cialai-tunnel` e `netlab-node` para linux na arquitetura do
servidor Docker, sobe o projeto `cialai-netlab`, roda os cenários e derruba tudo
com `docker compose down --volumes --rmi local`. A imagem fixada do coturn e a
base alpine ficam no cache do Docker para a próxima execução.

Variáveis úteis:

| Variável | Efeito |
| --- | --- |
| `NETLAB_ARTIFACTS` | Pasta onde ficam `report.txt`, `report.json`, `compose.log` e um log por processo |
| `NETLAB_KEEP=1` | Mantém os contêineres ao final para inspeção |

Para rodar um cenário só, use o filtro do Go dentro de `packages/tunnel-core`:

```sh
go test -tags=netlab -count=1 -timeout=25m -v ./integration -run 'NetLab/simetrico'
```

Com `NETLAB_KEEP=1`, a limpeza manual é:

```sh
docker compose --project-name cialai-netlab --file tools/net-lab/compose.yaml down --volumes --rmi local
```

Todo comando de Compose fora do teste precisa de `NETLAB_BIN` apontando para uma
pasta com `cialai-tunnel`, `netlab-node` e `tor/tor`, este uma cópia do
`netlab-node`, todos compilados com `GOOS=linux CGO_ENABLED=0`.

## Topologia

| Rede | Sub-rede | Quem está nela |
| --- | --- | --- |
| internet | `203.0.113.0/24` | coturn em `.3`, rede Tor simulada em `.4`, lado público dos roteadores em `.11` e `.12` |
| desktop-lan | `10.231.1.0/24` | roteador `.2`, computador `.10`, celular da mesma rede `.20` |
| phone-lan | `10.231.2.0/24` | roteador `.2`, celular de outra rede `.10` |

Os roteadores não têm rota padrão, então um IP privado de outra rede é
inalcançável, como na internet. As pontas trocam a rota padrão do Docker pelo
roteador da própria rede e não publicam porta no host. O teste fala com os
processos só pelo stdio de `docker compose exec`, sem rede de gerência que possa
encurtar o caminho pelos roteadores. IPv6 fica desligado em todos os contêineres.

## Roteadores

`node/netlab-router apply MODO UDP` troca o modo em execução e apaga os fluxos
UDP do conntrack, preservando as conexões TCP abertas, como a do tor com a rede
simulada. O modo inicial vem de `DESKTOP_NAT`, `PHONE_NAT`, `DESKTOP_BLOCK_UDP` e
`PHONE_BLOCK_UDP`.

| Modo | Mapeamento | Filtragem |
| --- | --- | --- |
| `cone` | Independente de endereço e porta: SNAT para o IP público preservando a porta de origem do único host interno | Independente de endereço e porta: todo UDP que chega ao IP público vai ao host interno na mesma porta |
| `symmetric` | Dependente do destino: SNAT com `--random-fully`, uma porta pública nova por destino | Só respostas de fluxos conhecidos entram |
| UDP `blocked` | Qualquer modo | Todo UDP entre a rede interna e a internet é descartado; TCP segue |

## Reserva simulada e por que não Chutney

A reserva usa uma rede Tor simulada em vez de uma rede Tor privada por Chutney.
O `netlab-node relay` oferece um SOCKS5 para os celulares e um ponto de encontro
que o onion service alcança por conexão de saída, como no Tor: nenhum dos lados
precisa aceitar entrada, então NAT e UDP bloqueado não atrapalham. O TLS mútuo
com a chave do computador fixada no QR vai de ponta a ponta por dentro do
encaminhamento; a rede simulada nunca vê o conteúdo.

No computador, o sidecar recebe `--tor-bin /opt/netlab/tor/tor` e supervisiona o
papel `tor` do `netlab-node` exatamente como supervisiona o tor empacotado:
`torrc` gerado, cookie SAFECOOKIE, `TAKEOWNERSHIP`, `ADD_ONION` com a chave
persistida, `SETCONF DisableNetwork=0`, eventos de bootstrap e `HS_DESC UPLOADED`,
`SIGNAL SHUTDOWN` e `__OwningControllerProcess`. O endereço publicado deriva da
chave pelo mesmo cálculo do Tor, então a verificação de endereço do supervisor
também roda. Matar esse processo é a queda do tor; reiniciar o contêiner `relay`
é a queda da rede.

Motivos da escolha:

- O sidecar gera o `torrc` e não tem ponto de extensão para as linhas de
  `DirAuthority` e `TestingTorNetwork` de uma rede privada; seria preciso um
  embrulho do binário só para o laboratório.
- Chutney roda os nós em loopback de uma máquina; espalhar autoridades, relés,
  onion service e clientes por redes com NAT exige endereços por nó, consenso
  novo a cada subida e minutos de bootstrap, com instabilidade conhecida em CI.
- O objetivo aqui é o comportamento do Cialai diante de NAT, UDP bloqueado e
  quedas: seleção de caminho, supervisão do tor, reconexão e revogação. O Tor real
  já é exercitado por `TestTunnelReachesDesktopThroughRealTor` em `mobile`,
  `TestNetStartPairsAPhoneOverTheOnion` em `internal/sidecar` e pelos testes de
  `internal/tor` com `CIALAI_TOR_BIN`, pela rede Tor pública.

O que a simulação não cobre: tempo real de bootstrap e de publicação de
descritor, latência de circuitos, autorização de cliente do onion e falhas
parciais da rede Tor.

## Cenários

`TestNetLabNATAndFallback` em `packages/tunnel-core/integration/netlab_test.go`
pareia um celular novo por cenário com o QR de `pair.begin`, abre a página pelo
proxy local e faz eco de WebSocket pela ponte falsa do computador.

| Cenário | Rede | Esperado |
| --- | --- | --- |
| `lan_direta` | Celular na rede do computador | Pareamento e Connect pelo caminho `lan` |
| `cone_com_cone` | Os dois roteadores cone | Caminho `direct` pelo candidato refletido do STUN, sessão vista do IP público do celular |
| `simetrico_com_cone_reserva` | Computador simétrico, celular cone | Direto falha no orçamento de 3 s e o pareamento e o Connect vão pela reserva |
| `udp_bloqueado_reserva` | UDP bloqueado na rede do celular | Sessão direta cai por inatividade do QUIC, a reserva assume com motivo `path_failed` e um Connect do zero vai direto à reserva |
| `revogacao` | Os dois cone | `devices.revoke` fecha o socket com 4401 e o caminho com `revoked`; um novo início do app é recusado pelo direto e pela reserva |
| `reinicio_do_sidecar` | Os dois cone | TERM e KILL do sidecar, mesma identidade e onion, celular volta sem QR |
| `reinicio_do_tor` | UDP bloqueado no celular | Supervisor reinicia o tor e republica o onion; a reserva volta, inclusive depois de reiniciar a rede simulada, e o celular da LAN não troca de caminho |
| `protecoes_do_pareamento` | Direto e reserva | Foto do QR usado, aprovação por código negada e limite de tentativas, cada um com o código no celular e `pair.failed` no computador |

O furo de NAT coordenado pela reserva, passo 4 da seção 6.3 do plano, depende de
CON-032. Até lá, `cone_com_cone` vale pelo candidato refletido e o cenário
simétrico termina na reserva. Quando o furo existir, o cenário simétrico com
celular cone deve subir para direto e o relatório registra a diferença.

As demais proteções do pareamento de CON-060 rodam sem Docker, com os ouvintes
reais em loopback e o relógio do pareamento sob controle, em
`internal/edge/pairing_protection_test.go` e
`internal/sidecar/pairing_protection_test.go`.

## Relatório

Cada execução grava `report.txt` e `report.json` com o caminho escolhido e o tempo
de cada passo. No GitHub, o workflow `net-lab.yml` copia o relatório para o resumo
da execução e sobe a pasta como artefato `net-lab`. Ele roda em PR que toque
`packages/tunnel-core` ou `tools/net-lab` no repositório público e por disparo
manual; a agenda fica para CON-072.

## Arquivos

| Caminho | Papel |
| --- | --- |
| `compose.yaml` | Redes, roteadores, pontas, coturn e rede Tor simulada |
| `Dockerfile` | Imagem alpine com iptables, iproute2 e conntrack |
| `node/netlab-router` | NAT cone, simétrico e bloqueio de UDP |
| `node/netlab-endpoint` | Rota padrão pela rede doméstica |
| `packages/tunnel-core/integration/netlab` | `netlab-node`: supervisor do computador, celular, rede Tor simulada e tor falso |
| `packages/tunnel-core/integration/netlab_test.go` | Cenários e relatório |

O `netlab-node` fica dentro do módulo `tunnel-core`, com a tag `netlab`, e não em
`tools/net-lab/client`: um módulo Go separado não pode importar `internal/` e
teria de repetir o `go.sum` do núcleo a cada troca de dependência.
