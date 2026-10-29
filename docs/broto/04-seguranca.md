# 04 · Segurança

## Estado em 28/10/2026

Controles preparados localmente: papel persistido por rota, aprovação obrigatória, permissões no hospedeiro, teto local, auditoria, pausa e desconexão. Testes cobrem recusa, aprovação, limites locais e vínculo da chave TLS. A prova em duas máquinas permanece pendente.

| Controle | Estado |
| --- | --- |
| Papel gravado no hospedeiro separa rotas de Broto e de celular | Preparado; `go test ./...` verde em 28/10/2026 |
| Aprovação obrigatória pela lista Brotos ligando | Preparado |
| Três camadas de permissão | Preparado |
| Teto local no próprio Broto | Preparado |
| Registro de auditoria nos dois lados | Preparado |
| Pausar e Desconectar na máquina do Broto | Preparado |
| Permissão da IA igual à de uma pessoa | Preparado |

## O risco central, a resolver antes de tudo

Um Broto que pareasse como um aparelho comum herdaria os direitos de um celular no hospedeiro. A borda encaminha qualquer chave registrada para a rota `/pty`, e a ponte aceita abrir e escrever em terminais. O portão de ação sensível, com a confirmação biométrica, existe só na página do celular, em `packages/protocol/sensitive.js`, então ele não protegeria um Broto, que não tem essa página.

A consequência seria grave: um Broto poderia abrir um terminal dentro do hospedeiro, o inverso do que se quer. O Broto é a ponta que recebe ordens, nunca a que manda no hospedeiro.

A base de todo o resto é separar os papéis no hospedeiro, no momento do pareamento, e decidir as rotas pelo papel:

| Papel | Pode | Não pode |
| --- | --- | --- |
| `phone` | Entrar na rota `/pty` e comandar os terminais do hospedeiro | Entrar na rota de RPC reversa do Broto |
| `broto` | Entrar só na rota de RPC reversa, para receber ordens | Entrar na rota `/pty` e comandar o hospedeiro |

O papel vem gravado no registro, no `devices.json`, e a borda confere a cada conexão. Um token de Broto apresentado na rota do celular é recusado, e um token de celular na rota do Broto também. Essa separação é a primeira coisa a implementar e a primeira a testar.

## A porta de entrada: código e aprovação

Nenhum Broto entra só com o código. O código é aleatório, gerado na hora em Conectar novo Broto, de uso único, válido por 10 minutos e preso ao primeiro aparelho que o apresenta. Mesmo com o código certo, o Broto fica na lista Brotos ligando até a pessoa aprovar no hospedeiro, conferindo os quatro dígitos que aparecem nos dois lados. Um código vazado, sozinho, não abre nada: o pedido do intruso aparece na lista, com dígitos que não batem com nenhuma janela de Broto da pessoa, e ela recusa.

## As três camadas de permissão

O que um Broto pode executar passa por três camadas. A mais restrita vence.

### Camada 1, no hospedeiro, por Broto

Na página Dispositivos, cada Broto tem um nível:

| Nível | O que permite |
| --- | --- |
| Só leitura | Ver as sessões e a saída, sem rodar comando nem escrever |
| Pedir confirmação | A pessoa no hospedeiro ou no celular opera direto; cada comando, abertura de terminal ou escrita pedida pela IA espera um sim da pessoa no hospedeiro |
| Livre | A pessoa e a IA operam sem confirmação por comando |

O nível padrão de um Broto recém aprovado é pedir confirmação. Subir para livre é uma escolha explícita da pessoa.

### Camada 2, no próprio Broto

O Broto tem um arquivo de política local, que o hospedeiro não altera pela rede, com o teto do que o aparelho aceita, independentemente do que o hospedeiro pedir:

| Ajuste | Efeito |
| --- | --- |
| Usuário de execução | Por padrão o Broto roda os comandos com um usuário sem privilégio, não como administrador |
| Pasta inicial | Onde o `exec` e o terminal começam; não é uma cerca, porque um shell anda pelo disco com as permissões do usuário de execução |
| Teto de capacidade | Desligar o `exec`, ou o `pty`, ou os dois, deixando o Broto só como presença |

A cerca real são as permissões do usuário de execução no sistema. Por isso o padrão é um usuário sem privilégio: o que ele não pode fazer na máquina, nenhuma ordem pelo Broto consegue. Esse arquivo é a defesa de quem instala o Broto numa máquina sensível: mesmo que o hospedeiro seja comprometido, o Broto não ultrapassa o teto local.

### Camada 3, registro de auditoria

Os dois lados registram o que aconteceu. O hospedeiro registra quem pediu, a pessoa, o celular ou a IA, qual verbo e para qual Broto. O Broto registra o que executou e quando. O registro é a trilha que permite saber, depois, o que foi feito em cada máquina. Do lado do Broto, esse registro é o que a janela mostra no monitor de atividades, ao vivo, para quem está na máquina.

### Por cima das três camadas, o controle de quem está no Broto

Quem está na máquina do Broto tem Pausar e Desconectar na janela, descritos no documento 05. Eles valem por cima de tudo: pausado, o Broto recusa qualquer ordem nova, venha da pessoa no hospedeiro, do celular ou da IA. Desconectado, o vínculo acaba. Nenhum dos dois depende do hospedeiro, então funcionam mesmo com o hospedeiro desligado ou comprometido.

## A execução pela IA

A IA que trabalha no hospedeiro entra pelo adaptador MCP, descrito no documento 06, que fala a ponte local do hospedeiro. A IA não tem um caminho próprio e privilegiado até o Broto: ela passa pela mesma camada 1 que uma pessoa. O nível pedir confirmação existe para ela: um Broto em pedir confirmação faz cada comando da IA esperar um sim no hospedeiro. A pessoa não espera por si mesma, porque o clique ou a tecla dela já é a decisão; por decisão do usuário em 28/10/2026, registrada no documento 12 como 064.

Isso é deliberado. Dar à IA um terminal numa máquina remota é poderoso e merece o mesmo freio que daríamos a qualquer automação: um teto por aparelho, confirmação quando a pessoa quer, um registro do que foi feito e um botão de parar na própria máquina.

## Modelo de ameaças do Broto

| Ameaça | Controle |
| --- | --- |
| Um Broto quer mandar no hospedeiro | Separação de papéis; o token de Broto não entra na rota do hospedeiro |
| Um Broto comprometido quer alcançar outro Broto | Os Brotos não se falam; cada um só tem uma conexão, com o hospedeiro |
| Alguém rouba o código de pareamento | Código aleatório gerado na hora para cada Broto, de uso único, válido por 10 minutos e preso ao primeiro aparelho que o apresenta; nada entra sem Aprovar na lista Brotos ligando, conferindo os quatro dígitos |
| Alguém na rede observa o tráfego | TLS 1.3 mútuo no caminho direto e na reserva pelo Tor; a saída de terminal cruza cifrada ponta a ponta |
| O hospedeiro é roubado | Revogar o Broto corta a conexão; quem está na máquina do Broto também pode Desconectar; o teto local limita o estrago até lá |
| A máquina do Broto é sensível | O teto local e o usuário sem privilégio limitam o que qualquer ordem alcança |
| O hospedeiro está desligado | O Broto fica só esperando; sem hospedeiro não há ordem, e o Broto não escuta ninguém |
| Quem está na máquina do Broto quer parar tudo | Pausar e Desconectar na janela do próprio Broto, sem depender do hospedeiro, e o monitor mostra o que foi feito |

## O que o Broto não resolve

| Limite | Observação |
| --- | --- |
| Um hospedeiro comprometido com o Broto em livre | Nesse caso o atacante tem o terminal da máquina do Broto, limitado pelo teto local e pelo usuário de execução; por isso o padrão é pedir confirmação e o usuário sem privilégio |
| A máquina do Broto já comprometida por outro caminho | O Broto não é antivírus; ele protege o canal, não a máquina inteira |
| Windows sem assinatura Authenticode | O instalador avisa, confere a soma assinada e o `codesign` onde há; o detalhe está no documento 07 |

A borda já recusa acesso cruzado entre os papéis. A rota `/broto` autentica o token e a chave TLS antes de aceitar o canal reverso. Toda mutação passa pelo nível do hospedeiro e pelo teto local. A suíte cobre também o upgrade alternativo em `/`, os estáticos e a saúde do hospedeiro.

## Aprovação e transferência de arquivos

A fase [IA no comando](./09-ia-no-comando.md) mantém só acompanhar como recusa de execução e transferência, inclusive para a pessoa. Listagem e metadados continuam consultas. Enviar e baixar pela IA exigem uma aprovação por arquivo no nível confirmar IA. A liberação por 15 minutos é exclusiva do Broto, somente em memória e revogável. Arquivos usam raízes locais, limites de tamanho e hash antes da entrega; nenhum conteúdo de arquivo entra na prévia de aprovação.

## IPC do hospedeiro e isolamento de instâncias

O endpoint pertence ao estado de uma única instância. A escolha explícita da instância pela IA está em [MCP](./06-mcp.md). O hospedeiro publica falhas de configuração no diagnóstico `broto_ipc`, com caminho e motivo, sem impedir que os terminais locais continuem funcionando.

No Unix, a pasta pai precisa ser real, pertencer ao usuário e não permitir escrita de grupo ou de outros. Links na pasta pai continuam recusados. Resolver um link não elimina corridas entre validação e uso; esta correção mantém a recusa e identifica o motivo, preservando a checagem existente. O socket precisa pertencer ao usuário e ter modo 0600. Não existe fallback para pasta temporária ou compartilhada. No Windows, permanece o named pipe com ACL restrita ao usuário.
