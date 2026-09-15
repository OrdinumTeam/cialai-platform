# Experimentos da Fase 0

Estes experimentos não são o transporte de produção. Critérios de aceite completos
em [rede e pareamento](../../docs/arquitetura/06-rede-e-pareamento.md).

## Spike 3, política e expiração

Requer Docker em execução, Go 1.26.5 e acesso para baixar a imagem fixada
`headscale/headscale:0.29.3` e os módulos Go. Execute na raiz:

```sh
npm run test:spike:headscale
```

O teste cria um contêiner com nome único `cialai-spike3-*`, publicado somente em
loopback numa porta livre, estado em tmpfs e configuração temporária. Cria alice,
bob, desktop de alice e dois celulares simulados por nós tsnet reais no processo
Go. A chave administrativa é gerada para esse servidor e fica em memória. A saída
não imprime chaves. O encerramento fecha os nós e remove o contêiner do teste.

Verificações:

- Alice conecta no próprio desktop por TCP 4740 e recebe o eco.
- Bob não conecta no desktop de alice.
- Alice não conecta na porta 4741, mesmo com um listener ativo.
- Peers de outro usuário ficam ocultos.
- Módulo móvel experimental conecta, troca eco e reabre com a identidade salva, sem nova chave.
- Chave de pré-autenticação expira pela API usando seu id.
- Nó recebe expiração futura e depois tem a expiração desabilitada.
- A API não sobrescreve a política em modo arquivo.

Este teste usa HTTP local para o controle e um relé DERP de teste em loopback,
com certificado TLS fixado pelo hash SHA-256. Não usa relés externos. Isso não
valida o DERP embutido do Headscale, TLS de produção, LTE, aparelhos físicos,
WebView, protocolo da ponte ou os prazos dos demais spikes. A tentativa inicial
sem relé funcional não estabeleceu a conexão permitida neste ambiente.

Se o processo for morto sem executar a limpeza, liste apenas seus resíduos:

```sh
docker ps -a --filter label=br.com.ordinum.cialai.spike=3
```

Confira o nome exato antes de remover qualquer contêiner. Não use limpeza global
de Docker. Dados desses contêineres são descartáveis, sem relação com servidores
Headscale existentes.

## Evidências pendentes

| Spike | Evidência necessária além deste teste |
| --- | --- |
| 1 | iPhone e Android reais; conexão LTE por DERP até 8 s; aumento IPA até 20 MB e AAR até 25 MB; memória até 120 MB; 50 ciclos sem travar |
| 2 | Dez execuções por transição de rede e suspensão em cada sistema; reconexão até 10 s |
| 4 | WKWebView com bundle Control, cookie, CSP, contexto seguro, replay, binários, ack, concessão e persistência |
| 5 | O mesmo em Android 12 e 14, mais relatório de pré-lançamento |
| 6 | Retorno real do TestFlight externo e conformidade final |
| 7 | Instaladores assinados nos três sistemas, notarização e instalação por outra pessoa até pareamento em 3 minutos |
| 8 | Proxy real com oito sockets, quadros de 1 MiB, rajadas de 50 MB e soak de 24 horas, com memória e desconexões medidas |

Não substituir os resultados acima por build, simulador ou testes unitários. Registre
data, aparelho, versão do sistema, versões dos componentes, medições e resultado
em `docs/engenharia/13-progresso-e-handoff.md` e em `docs/produto/12-decisoes.md`.

## Preparação do spike 1

`packages/tunnel-core/spikes/mobileprobe` expõe `Open`, `ConnectedMillis`,
`EchoMillis` e `Close` com tipos aceitos por gomobile. O teste de política
exercita a API Go, incluindo reabertura com estado salvo. Isso não testa a ponte
nativa nem a execução do Go nos celulares.

As versões de `gomobile` e `gobind` estão fixadas no `go.mod`. Com Xcode completo
ou SDK e NDK Android instalados, gere os artefatos experimentais:

```sh
node tools/spikes/build-mobile.mjs ios
node tools/spikes/build-mobile.mjs android
```

Saída ignorada pelo Git: `packages/tunnel-core/build/spikes/CialaiProbe.xcframework`
e `packages/tunnel-core/build/spikes/cialai-probe.aar`. O script verifica o ambiente
antes de compilar e instala `gobind` apenas no diretório de build do projeto.

Ainda falta um host nativo de teste em cada plataforma. Ele deve chamar `Open`
em uma fila de trabalho, fornecer uma chave de pré-autenticação em memória,
registrar `ConnectedMillis`, chamar `EchoMillis` com o IP do desktop de teste e
fechar por `Close`. O desktop de teste precisa de listener TCP de eco na porta
4740 dentro do tsnet. Use Headscale HTTPS e DERP próprio para a medição em LTE.

Guardar estado em diretório privado do app e repetir a abertura com o mesmo
diretório e chave vazia verifica persistência. O host deve aplicar proteção e
exclusão de backup, medir RSS nativo e registrar cinquenta ciclos de segundo
plano. Nada disso está implementado ou aprovado pelos artefatos Go.
