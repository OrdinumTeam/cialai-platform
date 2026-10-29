# 06 · O Broto para a IA, pelo MCP

## Estado em 28/10/2026

Adaptador stdio implementado em cmd/cialai-broto-mcp. As dez ferramentas usam IPC local protegido, com ator IA fixado pelo servidor e permissões centralizadas no hospedeiro. Testes locais de protocolo, leitura, espera e recusa passaram. Claude Code 2.1.312 executou um comando no Broto da VM Windows, aguardando aprovação no hospedeiro macOS. O laboratório usou a borda, o hub e o IPC reais; a prova não abrange a janela completa do desktop. Resultados em `../evidence/broto-local/README.md`.

| Peça | Estado | Base que reaproveita |
| --- | --- | --- |
| Adaptador MCP local | Preparado | A ponte em `apps/desktop/src-tauri/src/bridge/` e a lista branca de comandos |
| Ferramentas do MCP | Preparado | Os verbos do Broto do documento 03 e os comandos de PTY do hospedeiro |
| Registro no Claude Code | Preparado | `claude mcp add` |

## Integração com o hospedeiro

O comando `cialai` abre o app. A ponte local que o sidecar usa para falar com o estúdio exige um segredo por abertura e tem uma lista branca de comandos de sessão. O adaptador MCP acrescenta uma entrada específica para as ferramentas do Broto, sem entregar à IA o segredo da ponte nem expor seus métodos administrativos.

O adaptador recebe as chamadas por stdio e usa o IPC privado do hospedeiro. Esse IPC encaminha somente consultas e comandos de Broto ao hub, respeitando a permissão de cada aparelho.

## Como a IA chega ao Broto

```
Claude Code no hospedeiro
  → servidor MCP cialai-broto, no mesmo computador
  → IPC privado e hub do Cialai
  → RPC reversa até o Broto
  → o comando executa no aparelho do Broto
```

O adaptador nunca abre uma porta TCP para outra máquina. Ele fala com o Claude Code por entrada e saída padrão e com o Cialai por socket Unix protegido ou named pipe restrito ao usuário no Windows. A IA não ganha a chave do túnel nem o token de nenhum Broto; ela só pede, e o hospedeiro decide.

## As ferramentas

| Ferramenta | O que faz | Nível que exige |
| --- | --- | --- |
| `listar_brotos` | Lista os Brotos vinculados e o estado de cada um | Leitura |
| `listar_sessoes` | Lista as sessões de um Broto | Leitura |
| `ler_saida` | Lê a saída recente de uma sessão | Leitura |
| `rodar` | Executa um programa com argumentos pelo verbo `exec` e devolve resumo da saída e código de saída | Confirmação ou livre |
| `abrir_terminal` | Abre uma sessão de PTY no Broto | Confirmação ou livre |
| `escrever` | Escreve texto ou teclas numa sessão | Confirmação ou livre |
| `esperar_texto` | Espera um texto no fluxo bruto do PTY, incluindo o eco da entrada | Leitura |

A ferramenta `rodar` é a indicada para obter saída e código de término sem interpretar um terminal. Ela executa o programa informado em `command` com os argumentos de `args`; para uma linha de shell, o cliente informa o shell e seus argumentos explicitamente. O resumo final continua limitado pelo contrato de [exec](./03-controle.md); a saída em fluxo alimenta o card IA.

### Prazos e eco do terminal

| Operação | Padrão | Teto e significado |
| --- | --- | --- |
| `rodar.timeout_ms` | Cinco minutos quando omitido ou zero, respeitando teto local menor | Até `MaxDuration` da política local, trinta minutos por padrão. Valor acima do teto é recusado. É o prazo de execução do processo |
| `esperar_texto.timeout_ms` | Trinta segundos | De 1 a 120000 ms. É apenas o prazo desta leitura; vencer não cancela o processo no terminal |
| Aprovação da IA | Até dez minutos | É uma espera anterior à execução, definida no hospedeiro |

`esperar_texto` casa com bytes do PTY convertidos em texto, sem distinguir saída do programa e eco da linha digitada. `matched: true` significa somente que o texto apareceu. Uma linha como `rem MARCADOR` em cmd pode casar sem que o comando produza esse marcador como saída. `offset` evita reler histórico anterior àquela posição, mas não exclui o eco que ainda chegará depois da escrita. Para obter término e resultado confiáveis, use `rodar`.

Não há filtro de eco nem integração de shell que marque o começo da saída. A proposta de uma fronteira explícita por comando está na [proposta 070](../produto/12-decisoes.md#070-proposta-de-espera-com-fronteira-de-comando). Partir marcadores dentro da linha não é contrato nem solução oficial.

### Aplicativos gráficos no Windows

Quando o Broto é instalado como serviço SCM, `rodar` e `abrir_terminal` executam na Session 0, mesmo usando a conta comum da pessoa. Uma janela iniciada ali não aparece na sessão gráfica do console. Abrir um PTY oferece terminal no Cialai, sem transferir o processo para o desktop do Windows. A IA deve comunicar essa limitação ao receber um pedido para abrir um app gráfico; sucesso do processo não comprova janela visível.

Não existe lançador gráfico suportado. Criar tarefa agendada interativa não faz parte da API. As opções e os riscos de um futuro lançador estão na [proposta 069](../produto/12-decisoes.md#069-proposta-de-lançador-gráfico-do-broto-no-windows).

## A permissão vale para a IA

Cada ferramenta que muda algo passa pela camada 1 do documento 04, o nível do Broto no hospedeiro:

| Nível do Broto | O que a IA consegue |
| --- | --- |
| Só leitura | `listar_brotos`, `listar_sessoes`, `ler_saida` e `esperar_texto`; as demais são recusadas |
| Pedir confirmação | Todas, mas `rodar`, `abrir_terminal` e `escrever` esperam um sim da pessoa no hospedeiro |
| Livre | Todas, sem confirmação por comando |

O adaptador não tem um caminho privilegiado. Se o Broto está em só leitura, a IA não roda comando nenhum nele, ponto. Isso mantém a regra do documento 04: a IA passa pela mesma porta que uma pessoa.

## Registro no Claude Code

A pessoa registra o adaptador uma vez, com `claude mcp add`, apontando para o servidor MCP do Cialai no hospedeiro. A partir daí o Claude Code enxerga as ferramentas acima e as usa quando a tarefa pede um terminal numa das máquinas com Broto.

## Limites

| Limite | Observação |
| --- | --- |
| Só funciona no hospedeiro | O adaptador usa o IPC privado do usuário; não há acesso de outra máquina |
| Não contorna a permissão | Um Broto em só leitura recusa a IA como recusa a pessoa, e em pedir confirmação cada pedido da IA espera o sim da pessoa no hospedeiro |
| Não entrega credencial | A IA pede ações; ela nunca recebe o token do Broto nem a chave do túnel |
| Registro | Toda ação da IA entra no registro de auditoria do documento 04, marcada como vinda da IA, e aparece no monitor da janela do Broto |
| Broto pausado | Enquanto quem está na máquina do Broto mantiver Pausar, toda ferramenta que muda algo é recusada, e `listar_brotos` mostra o Broto como pausado |

## Uso local

Com o hospedeiro aberto e o binário compilado, registre o adaptador no Claude Code:

```sh
claude mcp add --transport stdio cialai-broto -- /CAMINHO/cialai-broto-mcp
```

O comando acima é uma instrução de registro permanente. A prova local usou configuração temporária do Claude Code, sem alterar o cadastro do usuário. O IPC do hospedeiro aceita somente listagem e chamadas do Broto; decisões de aprovação e alteração de nível ficam fora dessa entrada. O servidor fixa actor como ai, mesmo quando o cliente tenta enviar outro valor.

## CLI como caminho principal

Pela decisão 065, a IA com acesso a terminal usa `cialai broto`; o MCP continua como alternativa sem registro automático nas IAs. A implementação local acrescenta `listar_arquivos`, `enviar_arquivo` e `baixar_arquivo`; `rodar` solicita saída em fluxo para alimentar o card IA. As transferências usam a mesma implementação de blocos e SHA256 da CLI. Confira o aceite em [BRO-015 a BRO-022](./09-ia-no-comando.md).

## Instância do hospedeiro e diagnóstico do IPC

O sidecar deriva o endpoint do seu diretório de estado. O nome usa os primeiros 16 bytes do SHA256 desse caminho absoluto e normalizado. No Unix fica em `~/.cialai-ipc/<hash>.sock`, numa pasta privada, e no Windows vira um named pipe restrito ao usuário. O socket precisa caber em 103 bytes mais o terminador do macOS. Se a pasta pessoal tornar esse caminho longo demais, a configuração falha com orientação para escolher um caminho curto em pasta privada. Nunca há fallback para pasta temporária ou compartilhada.

A seleção segue esta ordem:

1. `CIALAI_BROTO_HOST_SOCKET` escolhe um endpoint explícito.
2. `CIALAI_BROTO_HOST_STATE_DIR` escolhe o diretório de estado do hospedeiro.
3. Sem essas variáveis, CLI e MCP escolhem o estado do identificador padrão `br.com.ordinum.cialai` na pasta local de dados do sistema.

Novos terminais abertos pelo Cialai recebem `CIALAI_BROTO_HOST_STATE_DIR` da instância que os criou. Terminais já existentes mantêm o ambiente original. Clientes externos precisam selecionar o estado explicitamente quando usam uma instância de teste. Não existe busca pelo primeiro socket vivo, pois isso poderia enviar uma ordem para outro hospedeiro.

Para abrir a instância de teste no macOS com o código atualizado, use em `apps/desktop`:

```sh
npm run dev -- --config '{"identifier":"br.com.ordinum.cialai.teste-broto","productName":"Cialai Teste"}'
```

Para o MCP num terminal externo, selecione o mesmo estado:

```sh
export CIALAI_BROTO_HOST_STATE_DIR="$HOME/Library/Application Support/br.com.ordinum.cialai.teste-broto/tunnel"
/CAMINHO/cialai-broto-mcp
```

Retire do ambiente qualquer `CIALAI_BROTO_HOST_SOCKET` antigo para usar a derivação por estado. Uma instância antiga com socket explícito continua exigindo esse mesmo override no cliente até sua próxima abertura autorizada. Nenhuma instância precisa ser reiniciada para preservar o uso atual durante a preparação da atualização.

O diagnóstico do aplicativo inclui `broto_ipc`, apresentado como Conexão local da IA com os Brotos, com sucesso e caminho ou falha e motivo. Ele fica em Dispositivos, nas opções avançadas de rede, ao executar o diagnóstico. A abertura do listener é síncrona, portanto o erro já está disponível na primeira consulta de diagnóstico. Pasta pai simbólica, escrita por outros, proprietário incorreto, caminho relativo ou longo são recusados. O cliente valida a pasta antes de procurar o socket e devolve a causa da configuração; se apenas o endpoint estiver ausente, orienta a abrir a instância escolhida e conferir suas variáveis e seu diagnóstico. A checagem de segurança está no [documento 04](./04-seguranca.md).
