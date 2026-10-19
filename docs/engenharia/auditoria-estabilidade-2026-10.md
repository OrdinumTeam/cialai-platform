# Auditoria de estabilidade e recursos

Estado em 16/10/2026. Esta auditoria distingue correção implementada, teste automatizado executado e homologação física. Os testes não acessam sessões pessoais, credenciais ou pareamentos existentes.

## Causas confirmadas

1. A trava do túnel confundia existência numérica de PID com propriedade. Um processo diferente podia bloquear a inicialização depois da reutilização desse número.
2. Uma recuperação em primeiro plano podia ser substituída pelo retry já agendado do supervisor. Respostas antigas também precisavam ser separadas por geração. A escrita em stdin cheio não estava coberta pelo prazo RPC. A revisão encontrou ainda um mutex mantido durante o ACK de encerramento e uma falha atrasada que anunciava reconexão depois de a geração seguinte já estar saudável.
3. Abrir o shell novamente podia sobrescrever a conversa pendente no journal. Perfis padrão podiam herdar a conta ativa atual, e rollouts concorrentes podiam ser escolhidos por ordem de leitura. O cache global de probes bloqueava contas independentes. A observação da retomada terminava cedo quando o CLI ainda estava iniciando; uma falha transitória posterior não recebia nova consulta, e a ação manual não solicitava o retry guardado.
4. O atalho de texto no Windows podia chegar ao agente como `Ctrl+V`, interpretado como pedido de imagem. Eventos de paste nativos e leituras assíncronas precisavam coordenar uma única entrega.
5. O addon WebGL mantinha terminais por meio do timer do cursor depois do descarte. A árvore de processos também era reamostrada para consultas repetidas de consumidores concorrentes.

O erro `draining` de uma instalação externa do Codex não foi reproduzido naquele ambiente. Um daemon falso reproduz o contrato de erro e testa a recuperação, mas não comprova a causa específica de produção. Divergência de versões é um diagnóstico, não prova suficiente para reiniciar um serviço compartilhado.

## Correções

| Área | Implementação |
| --- | --- |
| `statedir` Go | Trava de kernel mantida em descritor aberto, inode estável e nonce nos metadados. Migração legada confere executável e criação do processo. Arquivos de identidade e pareamento não são removidos |
| Supervisor Rust | Exclusão de partidas, gerações RPC, backoff limitado e recuperação após cooldown. Escritor com fila limitada e prazo que inclui envio. Somente filhos pertencentes ao supervisor podem ser encerrados |
| Retomada | UUID, perfil, configuração, pasta, executável e argumentos validados. Probes com prazo e cache por instalação e conta. Segunda conferência do PTY, processo em primeiro plano e digitação antes do envio |
| Interface | Fila com duas operações, uma por perfil, deduplicação por geração, tentativas limitadas e cancelamento. Histórico, UUID, nova tentativa e recuperação manual preservados |
| Clipboard | Captura nativa coordenada com API, preferência por texto, distinção de imagem e vazio, cancelamento e prazo. Entrega por `term.paste`, preservando bracketed paste |
| Recursos | Amostra de processos compartilhada por até 250 ms, invalidada por mudanças. Blur antes de descartar o WebGL, remoção de timers de reattach e invalidação de viewport no fechamento |

Não há atualização automática de CLIs, dependência de rede para retomar, reinício de daemon compartilhado nem aplicação global de `--no-daemon`.

A observação da retomada permanece limitada a três consultas posteriores, com intervalos de 1, 2 e 4 segundos, inclusive após `already_started`. As esperas ficam fora das vagas do coordenador: somente chamadas ao backend disputam o limite global de duas e de uma por perfil. Uma operação por sessão e geração permanece deduplicada. Testes com relógio virtual cobrem vinte conversas no mesmo perfil ou em três perfis, entrega inicial em até dez segundos e conclusão em até quinze, sem chamadas pendentes; esses limites são da fixture, não latências reais de agentes externos. A tentativa manual continua disponível após o envio e pede autorização ao backend, sem escrever comandos diretamente.

Quando o CLI conhecido já imprimiu uma falha transitória, mas ainda está desconectando em primeiro plano, o backend aguarda sem enviar outro comando. O reenvio depende de o shell voltar a ficar livre e quieto. Outro processo, digitação do usuário ou mudança de geração continua impedindo o envio.

No Windows, os probes de versão e ajuda entram suspensos em um Job Object privado antes de executar. Ao concluir ou expirar, o job recolhe somente seus descendentes, antes da remoção do arquivo temporário; não usa o registro de sessões nem encerra daemons compartilhados. O prazo de coleta é de um segundo, seguido do fallback de encerramento vinculado ao fechamento do handle. A regressão usa wrapper `.cmd`, descendente e processo independente próprios; compilação cruzada, Clippy e execução nativa na CI passaram.

## Medições comparáveis

Host de teste nativo macOS arm64, build debug. Cem consultas consecutivas de métricas com shells isolados. CPU é tempo do processo de teste; a latência não representa renderização visual nem CPU total do aplicativo. O benefício é compartilhar amostras durante a janela de 250 ms.

| Terminais | CPU antes, ms | CPU depois, ms | p50 antes, ms | p50 depois, ms | p95 antes, ms | p95 depois, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0.354666 | 0.265000 | 0.000834 | 0.000167 | 0.000958 | 0.000167 |
| 1 | 4.030708 | 0.063000 | 0.038333 | 0.000333 | 0.088917 | 0.000416 |
| 10 | 40.252958 | 0.159666 | 0.402584 | 0.001333 | 1.170792 | 0.001375 |
| 30 | 146.524292 | 0.403083 | 2.164875 | 0.003750 | 9.634750 | 0.003833 |

| Terminais | RSS do host depois, bytes | Filhos vivos | FDs vivos | Threads vivas | Após fechar, filhos / FDs / threads |
| --- | ---: | ---: | ---: | ---: | --- |
| 0 | 12877824 | 0 | 4 | 3 | 0 / 4 / 3 |
| 1 | 15564800 | 1 | 7 | 7 | 0 / 4 / 3 |
| 10 | 17088512 | 10 | 34 | 43 | 0 / 4 / 3 |
| 30 | 19283968 | 30 | 94 | 123 | 0 / 4 / 3 |

Os FDs incluem o descritor temporário da própria enumeração. Não há alegação de redução de RSS: o baseline anterior não mediu essa mesma grandeza. A variação de abertura também não é atribuída a uma otimização de spawn.

Na fixture de sidecar responsivo, o teste de negociação, chamada e encerramento levou cerca de 3,01 s antes e 0,07 s depois de liberar o mutex antes de aguardar o ACK. O teste acrescentado exige encerramento abaixo de 1 s. Isso não mede o encerramento de Tor real; o prazo de desligamento dele continua separado.

Chromium isolado com xterm real, oito ciclos de trinta sessões, GC forçado. Comparação entre o primeiro e o oitavo fechamento com zero sessões:

| Indicador | Antes | Depois |
| --- | --- | --- |
| Nós DOM retidos | 978 → 1524 | 814 → 814 |
| Listeners | 558 → 649 | 532 → 532 |
| Heap JS, bytes | 24771276 → 26797464 | 24269428 → 25125856 |

O teste ampliado de quarenta ciclos, com verificações adicionais de clipboard, completou 1200 aberturas e fechamentos. Depois do primeiro fechamento, nós DOM e listeners permaneceram em 880 e 537 até o ciclo quarenta; nenhum terminal de coortes antigas permaneceu vivo. Heap final de 26356376 bytes, com as últimas cinco amostras entre 26327608 e 26389424. Isso não é prova de ausência global de vazamentos nem soak por horas.

A repetição posterior de **100 ciclos e 3000 aberturas e fechamentos** passou: do primeiro ao último fechamento, 878 nós e 537 listeners; heap de 24846048 para 26761564 bytes, sem terminais de coortes antigas. O número absoluto difere entre execuções isoladas; a comparação útil é a evolução dentro de cada execução. Vinte rodadas nativas com cinco e dez agentes simulados também passaram; cada fechamento retornou a zero filhos, quatro FDs e três threads.

Uma execução posterior manteve o mesmo processo Chromium durante mais de uma hora, com pausas de 18 segundos entre estados e os mesmos cem ciclos. Passou com 886 nós e 537 listeners estáveis entre o primeiro e o último fechamento; heap de 24853724 para 26756260 bytes, sem terminais de coortes antigas. Isso valida a fixture prolongada, não um soak integral do aplicativo Tauri ou das redes reais.

Medição adicional de interação em Chromium, trinta amostras por cenário, com evento de teclado do navegador e xterm real. Não inclui hardware de entrada, PTY nativo, compositor do sistema nem apresentação física do frame. Os p50 de entrada ficaram abaixo da resolução de 0,1 ms do relógio; não devem ser interpretados como latência zero.

| Terminais | Entrada até onData p95, ms | Escrita até evento de render p50, ms | Escrita até evento de render p95, ms | TaskDuration ocioso, ms em cerca de 1200 ms |
| --- | ---: | ---: | ---: | ---: |
| 0 | Não aplicável | Não aplicável | Não aplicável | 0.531 |
| 1 | 0.200 | 16.800 | 18.800 | 2.352 |
| 10 | 0.100 | 16.900 | 18.900 | 2.427 |
| 30 | 0.100 | 16.900 | 18.700 | 4.492 |

São valores atuais, sem baseline anterior equivalente e sem alegação de ganho. A tentativa de medir outra aba não produziu `document.visibilityState = hidden` neste ambiente; seus números não são aceitos como medição de segundo plano. O runtime já suspende as consultas de métricas enquanto a página informa estado oculto.

## Verificações adicionais

* A suíte completa `npm test` passou localmente, incluindo 449 testes Rust, 373 testes principais de interface, 37 de integração do runtime, 22 de protocolo e 352 testes móveis. A última regressão de opções globais elevou a biblioteca Rust a 452 aprovados; a biblioteca completa e o Clippy foram reexecutados depois dela. Os sete testes Rust ignorados não são tratados como aprovados; os benchmarks desta auditoria foram executados explicitamente.
* `go test` e `go vet` do núcleo completo passaram; as quatro áreas diretamente afetadas também passaram com detector de corridas.
* Os testes de `statedir` foram executados em Linux arm64 dentro de contêiner sem rede. Aquisição simultânea, saída abrupta, PID reutilizado, migração e preservação de dados passaram.
* O sidecar Linux em Ubuntu 22.04 arm64, com estado temporário, negociou o protocolo, abriu conexão direta, anunciou por Avahi e respondeu a `pair.begin`. Tor estava desligado nesse teste.
* Os testes opcionais com o Tor Expert Bundle real foram executados no macOS com detector de corridas e estado temporário. Encerramento normal: 21 ms; morte do proprietário: Tor ausente depois de 24 ms; verificação independente do PID do controlador: 14,893 s, dentro do intervalo de consulta do Tor. O teste onion reiniciou o serviço preservando a identidade temporária, chegou a bootstrap 100%, conectou por SOCKS com TLS fixado e trocou o eco na primeira tentativa. O cenário onion levou 35,76 s e recolheu os filhos; os dois testes terminaram em 53,084 s. Isso não homologa pareamento com aparelho físico nem perda real de rede durante uso prolongado.
* A inspeção passiva de daemon Windows está implementada por AF_UNIX não bloqueante, com prazo absoluto compartilhado por conexão, handshake e I/O. Compilação, Clippy, teste nativo desse módulo e matriz completa da candidata passaram.

A matriz inicial `38846517242` aprovou macOS e Linux, mas expôs um defeito de associação de rollout no Windows. Caminhos abertos agora são canonicalizados antes da comparação, e a busca sem handles filtra o UUID explícito antes de decidir ambiguidade. Uma conversa explicitamente identificada pode ser anterior ao processo atual; a regra de recência continua valendo para inferência sem UUID.

A matriz final [38885694036](https://github.com/OrdinumTeam/cialai-platform/actions/runs/38885694036), no código `629d46f`, passou nos três sistemas: 452 testes Rust no macOS, 445 no Linux e 406 no Windows, com respectivamente sete, seis e quatro ignorados. O Windows aprovou nativamente o probe AF_UNIX e a coleta do wrapper e descendente após timeout, preservando o processo independente e removendo o scratch. Navegador e orçamento de performance passaram no Linux: 2374 ms até interação, 639 KB e animação a 56 fps sob CPU quatro vezes mais lenta. O comparador dessa execução mediu 2368 ms; não representa a comparação histórica anterior às correções.

O smoke inicial `38845556825` abriu o AppImage no Ubuntu e no Arch. A árvore extraída no Arch foi falsamente reprovada porque a seleção por nome encontrou o PID zumbi da execução anterior. O arnês passou a conferir executável vivo, HOME isolado e marcador da fixture, inclusive no encerramento, sem `pkill` global por nome. Uma regressão com processos falsos passou no macOS e em contêiner Linux. A repetição real [38885698668](https://github.com/OrdinumTeam/cialai-platform/actions/runs/38885698668), no código `629d46f`, passou no Ubuntu 24.04 e no Arch: imagem e árvore extraída, interface, WebKit e sidecar vivos por vinte segundos em cada cenário. A assinatura do AppImage de diagnóstico foi conferida com chave descartável; não se confunde com a chave da release.

## Reproduzir

```sh
cd packages/tunnel-core
go test -mod=readonly ./...
go test -mod=readonly -race ./internal/statedir ./cmd/cialai-tunnel ./internal/tor ./internal/sidecar
go test -mod=readonly ./internal/statedir -run '^$' -bench BenchmarkAcquireRelease -benchmem -count 3
```

A partir da raiz:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib -- --test-threads=4
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib benchmark_ -- --ignored --nocapture --test-threads=1
npm test --workspace @cialai/ui
node tools/browser/check-terminal-stability.mjs
node tools/browser/benchmark-terminal-interaction.mjs
node tools/check/linux-tunnel.mjs
```

Use Node 22 e as versões fixadas pelo repositório. `CIALAI_NATIVE_SOAK_CYCLES` aceita 1 a 100 rodadas nativas; `CIALAI_BENCH_ROUNDS`, 10 a 10000 amostras; `CIALAI_SOAK_CYCLES`, 2 a 100 ciclos no navegador. `CIALAI_TEST_CHROMIUM` seleciona um Chromium já instalado. A fixture do navegador usa Vite de desenvolvimento e um PTY falso, nunca a ponte de sessões pessoais.

## Limites de aceite

* Linux em contêiner, compilação cruzada e regras de atalhos simuladas não equivalem a máquinas físicas ou menus nativos de WebView.
* Probes de sessão conferem cabeçalhos, UUID e perfil, sem reparar ou alterar bancos internos de agentes.
* Prontidão por foreground, identidade do executável e saída quieta não distingue universalmente um prompt de um builtin `read` em inicialização customizada. Esse caso exige cooperação explícita do shell para um aceite completo.
* A disponibilidade de atualização do Codex vem somente de cache local recente. Sem informação segura do Claude, o estado permanece desconhecido.
* Latência visual física, baseline de todo o aplicativo Tauri, desconexão e reconexão reais durante uso e soak integral de longa duração ainda exigem execução específica. Tor real passou nos testes opcionais descritos acima; as demais medições são do host de teste nativo e de Chromium isolado.

O relatório não converte esses limites em aprovações e não declara todos os critérios globais homologados.

## Publicação da prévia

A [0.2.13](https://github.com/OrdinumTeam/cialai-platform/releases/tag/v0.2.13) foi publicada em 16/10/2026 pelo [workflow 38887488052](https://github.com/OrdinumTeam/cialai-platform/actions/runs/38887488052). Os quatro alvos de desktop passaram; ambos os macOS receberam Developer ID e notarização. Foram conferidas localmente as dezessete entradas SHA-256 e as assinaturas de sete pacotes de atualização, anunciados em onze chaves de plataforma no manifesto. Os instaladores Windows continuam sem Authenticode, conforme as notas da versão.

O [site de downloads](https://cialai.com.br/downloads/) e o espelho foram atualizados e seus caches invalidados. A conferência pública aprovou seis páginas em três idiomas, dez objetos de download com ETag e tamanho iguais aos do armazenamento, manifesto com onze entradas e somas SHA-256. O `install.sh` servido é idêntico ao código local e consulta o manifesto 0.2.13, sem instalação no host. O APK 0.2.12 manteve os mesmos bytes e a mesma versão do objeto. O [anúncio no Discord](https://github.com/OrdinumTeam/cialai-platform/actions/runs/38891267857) foi enviado depois dessas conferências. A publicação remota foi autorizada pelo usuário durante a execução; não houve PR nem publicação móvel.

O usuário dispensou novas validações físicas ou em emulador nesta entrega. Elas não são convertidas em aprovações; a evidência nativa Windows é da CI. Android e iOS não foram recompilados nem publicados nesta atualização desktop.

## Matriz remota sem empacotamento duplicado

O disparo manual de `ci.yml` aceita `tests_only=true`: mantém as suítes e verificações nos três sistemas, mas não gera nem anexa instaladores de diagnóstico. O padrão continua sendo a CI completa com bundles. Os instaladores publicados continuam sendo responsabilidade de `release.yml`, depois do portão AppImage.

```sh
gh workflow run ci.yml --repo OrdinumTeam/cialai-platform --ref main -f tests_only=true
```
