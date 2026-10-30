# 03 · Controle e execução

## Estado em 28/10/2026

RPC reversa, exec, PTY e sessões remotas preparados e integrados localmente. O canal funciona sobre stream QUIC e sobre TLS da reserva. Processos e terminais reais passaram no macOS, em VM Linux amd64 e em VM Windows 11 com ConPTY. A prova no console antigo do runner Windows continua separada. Os resultados estão em `../evidence/broto-local/README.md`.

| Peça | Estado | Base que reaproveita ou espelha |
| --- | --- | --- |
| Stream de RPC reversa | Preparado | `internal/transport`, que já abre stream no QUIC direto |
| Verbo `exec` | Preparado | Novo; não há equivalente no protocolo da ponte |
| Verbos de terminal | Preparado | Espelham `pty_write`, `pty_kill` e afins do protocolo da ponte |
| Camada de PTY no Broto | Preparado | Reescreve em Go o que `apps/desktop/src-tauri/src/workspace/pty` faz em Rust |
| Aparição das sessões do Broto | Preparado | `pty_list` e `syncSharedSessions()` em `packages/ui/src/terminals/runtime.js` |

## O canal da RPC reversa

Hoje a conexão só vai do aparelho para dentro do hospedeiro. O Broto inverte o sentido do controle, mas não da discagem: o Broto continua discando, e sobre a conexão aberta o hospedeiro manda as ordens.

O canal de controle que já existe, o `rendezvous`, não serve para isso. Ele tem um conjunto de mensagens fixo por papel, um quadro limitado a 16 KiB e fecha a conexão se chegar um tipo desconhecido. É desenhado para coordenar o furo de NAT e renovar os candidatos, não para carregar saída de terminal.

Então a RPC reversa anda num stream longo próprio, que o Broto abre logo depois de conectar e mantém aberto. O hospedeiro escreve ordens nesse stream e lê as respostas e a saída. O mesmo desenho funciona no QUIC direto e na reserva pelo Tor, porque nos dois casos quem abre o stream é o Broto, o lado que disca. No QUIC direto o hospedeiro até consegue abrir stream ao par, mas depender disso quebraria na reserva, onde abrir stream de fora é recusado. Por isso a regra é simples: o Broto abre, o hospedeiro usa.

### Formato

O estilo segue o protocolo da ponte: JSON por mensagem, uma chamada com id, um resultado com o mesmo id e eventos sem id. A saída de terminal, que é volumosa e binária, anda em quadros binários com o número do canal na frente, como o `[u32 canal][bytes]` da ponte, para não inflar com base64.

```
Hospedeiro para o Broto   {"id":12,"cmd":"exec","args":{...}}
Broto para o hospedeiro   {"id":12,"ok":true,"result":{...}}
Broto para o hospedeiro   {"event":"pty.output","data":{"id":3},"ts":"..."}  seguido do quadro binário
```

## Os verbos

| Verbo | Argumentos | Resultado |
| --- | --- | --- |
| `hello` | A versão do protocolo e as capacidades do Broto | As capacidades aceitas, por exemplo `exec`, `pty`, `files` |
| `exec` | O comando, os argumentos, a pasta, o ambiente e um prazo | stdout, stderr e o código de saída, quando o comando termina |
| `pty.open` | A pasta, o shell, as colunas e as linhas | O id da sessão no Broto |
| `pty.write` | O id e os bytes a escrever | Um sinal de recebido |
| `pty.resize` | O id, as colunas e as linhas | Um sinal de recebido |
| `pty.kill` | O id | Um sinal de recebido |
| `exec.cancel` | O id da chamada | Cancela a árvore de processos |
| `files.list` | `path` | Nome, tipo, tamanho e data das entradas |
| `files.stat` | `path` | Metadados e SHA256 de arquivo regular |
| `files.get` | Caminho, transferência, offset e tamanho do bloco | Bytes, hash do bloco, próximo offset e hash final |
| `files.put` | Caminho, transferência, bytes, offset, tamanho, hash e sobrescrita | Progresso e confirmação após conferir o hash final |
| `files.cancel` | Caminho e transferência | Cancela e remove o recebimento parcial |

### exec contra pty

O `exec` é o verbo que a IA mais usa. Ele roda um comando sem terminal e devolve um resumo limitado da saída e o código de saída quando o comando termina; com `stream: true`, também publica saída ao vivo. Isso resolve o problema de saber quando um comando acabou: num terminal cru não há aviso de término, e sem o `exec` seria preciso colar um marcador na saída, algo como escrever o código de saída no fim. Com o `exec`, o Broto roda o processo, junta a saída e responde com o código, sem marcador.

O `pty` é para o que precisa de terminal de verdade: um editor, um `top`, um agente interativo. Ele abre um PTY no Broto e transmite a saída ao vivo, exatamente como uma sessão do estúdio.

### A camada de PTY no Broto

O Broto precisa da própria camada de PTY, em Go, porque a do hospedeiro é Rust e usa a crate `portable-pty`. No Windows essa camada precisa repetir as correções que o desktop já fez para o ConPTY antigo, registradas na manutenção do projeto: responder a consulta de posição do cursor, o `ESC[6n`, e drenar a saída até o fim antes de fechar o console, senão o `ClosePseudoConsole` trava em versões do Windows anteriores à 24H2. O runner `windows-2022` do CI tem o console antigo e é onde essa prova vale.

## Como as sessões do Broto aparecem

O estúdio e o celular mostram as sessões porque o laço `syncSharedSessions()` consulta `pty_list` a cada 3 s e adota qualquer PTY que ainda não conhece. Se o hospedeiro listar os terminais do Broto nesse mesmo `pty_list`, eles aparecem no desktop e no celular sem tela nova. Essa é a maior economia do desenho.

O hospedeiro implementa três peças para isso:

| Peça | O que faz |
| --- | --- |
| Id local por sessão remota | O hospedeiro dá um id `u32` local a cada terminal do Broto e guarda o par Broto mais id remoto, para dois Brotos nunca colidirem no mesmo id |
| Origem na sessão | Cada sessão carrega de qual Broto ela vem, para a interface marcar e para o roteamento |
| Roteamento por id | `pty_write`, `pty_kill` e afins, quando o id é de uma sessão de Broto, viajam pela RPC reversa até o Broto certo, em vez de irem para um PTY local |

A saída da sessão remota entra no mesmo anel de 256 KiB por sessão que o estúdio já usa, então o histórico, a rolagem e a releitura por offset funcionam igual.

## As abas que não funcionam numa sessão de Broto

O editor, o explorador, o grafo da documentação e o Dev Browser do estúdio usam comandos de arquivo locais do hospedeiro, por caminho. Numa sessão que vive em outra máquina, esses comandos apontariam para o disco errado. A integração dessas abas gráficas usa uma etapa própria. Os verbos `files.list`, `files.stat`, `files.get` e `files.put` atendem a CLI e o MCP, com acesso conforme a conta de execução pela [decisão 074](../produto/12-decisoes.md#074-arquivos-do-broto-com-os-poderes-da-conta). A entrega de arquivos avança independentemente da integração das abas.

## Contrato preparado em código

A RPC usa tamanho u32 big-endian, byte de tipo e carga. Tipo zero contém JSON; tipo um contém u32 de canal seguido de bytes. O limite é 4 MiB. O primeiro comando é hello versão 1. Exec limita stdout e stderr a 256 KiB cada e informa truncamento; o prazo padrão é cinco minutos e o teto local é configurável por `maxDurationMinutes`, com padrão de trinta minutos. A aprovação da IA espera até dez minutos. A saída em fluxo usa eventos `exec.output` com canal e bytes em base64; o limite do resumo não corta esses eventos.

O anel remoto guarda 256 KiB. pty.read lê no máximo 64 KiB por chamada, com offset, next_offset e total_offset. O desktop drena todas as páginas finais antes de encerrar o fluxo. IDs remotos são reservados em sequência persistida antes da abertura, para uma reconexão não reutilizar uma sessão antiga. O hospedeiro atribui IDs locais a partir de 0x80000000.

Pausar recusa mutações novas e mantém os processos existentes. Lista e leitura continuam disponíveis. Desconectar encerra os processos e apaga o vínculo. As transferências usam `allowFiles` e `maxFileMB`, com acesso aos caminhos conforme a conta do Broto. A adequação do executor e sua distribuição estão em [BRO-023](./09-ia-no-comando.md#bro-023-arquivos-com-os-poderes-da-conta), com entrega prevista no Broto 0.1.2. A pausa recusa transferências novas e cancela recebimentos parciais. Operações de arquivos de uma sessão remota devem usar o disco do Broto correspondente.

Ao desconectar, o Broto espera por `disconnected.ack` durante até 500 ms antes de fechar o transporte. O hospedeiro confirma depois de revogar o vínculo. Se a confirmação não chegar, o Broto ainda apaga o vínculo local. Essa ordem evita perder a revogação quando o fechamento do QUIC ultrapassa o último evento.

## IA no comando do hospedeiro

A continuação do protocolo está em [09 · IA no comando](./09-ia-no-comando.md). A implementação local acrescenta execução em fluxo, cancelamento e transferência por blocos com hash. O CLI e o MCP usam o mesmo IPC com autor IA. A resposta final de exec mantém o resumo limitado; os eventos carregam a saída ao vivo. O estado de validação desta fase fica no checklist BRO-014 a BRO-022, separado das provas anteriores.

## Isolamento de saída e recuperação de transferência

Cada execução tem sua fila de entrega. Um consumidor parado não bloqueia a leitura da RPC nem os terminais do mesmo Broto. Se a fila limitada exceder a capacidade, somente a chamada afetada é cancelada e recebe `output_backpressure`; a resposta de sucesso só é entregue depois de drenar a saída.

Transferências usam a mesma conta de execução de exec e PTY, com seus poderes no sistema conforme as decisões 072 e 074. Recebimentos sem atividade por quinze minutos são encerrados. O bloqueio do destino protege outro processo vivo e permite recuperar o parcial após queda do dono. Erros de arquivo têm códigos sanitizados específicos para caminho, permissão, tamanho, integridade e concorrência.

## Log operacional do hospedeiro

Consultas repetidas `pty.list`, `pty.read`, `files.list` e `files.stat` entram em nível debug no `tunnel.log`. O nível info preserva ações como `exec`, `pty.open` e `pty.write`, incluindo autor, aparelho e resultado. Isso evita que polling consuma a rotação de 2 MB e encubra avisos de configuração. O registro de atividade continua seguindo as regras da interface, sem conteúdo de arquivo ou credenciais.

## Codificação no Windows

Exec abre um processo auxiliar com console privado e define as páginas de entrada e saída como UTF-8, código 65001, antes de iniciar o programa solicitado. Isso prepara PowerShell e comandos que respeitam a página do console sem inserir texto no script, alterar argumentos ou mudar o perfil da conta. Stdout, stderr, diretório, ambiente e código de saída permanecem separados ou preservados conforme o contrato de exec. O auxiliar herda a mesma conta e participa do cancelamento da árvore de processos.

O terminal prepara a mesma página antes de abrir o shell no ConPTY. O transporte do ConPTY é UTF-8, mas a página usada pelo programa dentro dele precisa ser configurada separadamente, como descreve a [documentação de pseudoconsoles da Microsoft](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles). Ctrl C chega ao shell e o auxiliar permanece disponível enquanto o shell estiver vivo.

O auxiliar do PTY também limpa a opção herdada de ignorar Ctrl C antes de abrir o shell. Essa opção pode vir de um processo iniciado em grupo separado e se propaga aos filhos, conforme o contrato de [SetConsoleCtrlHandler](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler). Apenas o auxiliar instala seu próprio handler para sobreviver ao cancelamento; o shell recebe Ctrl C normalmente. A regressão foi reproduzida na conta comum do serviço e coberta também por um teste que cria explicitamente outro grupo de processos.

Os eventos transportam bytes, incluindo caracteres divididos entre blocos. Os consumidores devem manter o estado do decodificador entre blocos; o resumo limitado de exec evita cortar um caractere UTF-8 na borda. Não há tentativa de adivinhar a codificação de cada bloco. Programas que escolhem uma página própria continuam exigindo sua opção de saída UTF-8; o `chcp.exe`, por exemplo, pode emitir sua mensagem localizada na página ANSI mesmo após mostrar 65001. A preferência `$OutputEncoding` do PowerShell para entrada enviada a programas nativos também continua sob controle do script.

Testes nativos isolados no Windows verificaram stdout e stderr com acentos, CJK e emoji, argumentos e código de saída com `-File`, leituras de um byte no ConPTY, Ctrl C, prazo e encerramento da árvore de processos. Essa prova usa um binário de testes e não atualiza o serviço instalado.
