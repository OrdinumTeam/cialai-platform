# Cialai Broto

## Estado em 28/10/2026

Implementação local de BRO-001 a BRO-013 preparada. O daemon, o monitor, o pareamento aprovado, a RPC, a execução, as sessões remotas, as permissões e o MCP estão integrados. Empacotamento e atualização assinada têm código e testes locais. A execução foi exercitada no macOS e em VMs Windows e Linux, incluindo Claude Code pelo MCP. Os resultados e limites estão em `../evidence/broto-local/README.md`. Não houve release nem publicação do site. As provas físicas continuam pendentes. A continuação BRO-014 a BRO-021 está preparada e validada localmente, com CLI, card IA, arquivos, aprovação global e skill; o aceite BRO-022 com dois Brotos e Claude Code segue pendente em [IA no comando](./09-ia-no-comando.md).

| Item | Estado | Situação atual |
| --- | --- | --- |
| Terceira persona Cialai Broto | Preparado | Decisões 058 a 063 registradas; produto completo ainda pendente |
| Papel de identidade `broto` no núcleo do túnel | Preparado | Papel, registro v3, token próprio e separação das rotas testados localmente |
| RPC reversa do host para o aparelho | Preparado | Canal reverso integrado ao sidecar e ao daemon |
| Camada de PTY e execução no Broto | Preparado | PTY Unix e ConPTY executados localmente nos três sistemas |
| Seção Brotos na página Dispositivos, com a lista Brotos ligando | Preparado | Brotos têm seção, aprovação e acesso próprios |
| Janela do Broto, com Conectar e o monitor | Preparado | Monitor Tauri conectado ao serviço por IPC |
| Adaptador MCP para a IA do host | Preparado | Claude Code executou comando na VM Windows via MCP e aprovação |
| Empacotamento, serviço e download no site | Preparado | Site preparado localmente; distribuição ainda não publicada |

## O que é

Envio, recebimento e listagem de arquivos fazem parte do Broto. Pela [decisão 074](../produto/12-decisoes.md#074-arquivos-do-broto-com-os-poderes-da-conta), alcançam os caminhos acessíveis à conta de execução, incluindo outras unidades, volumes montados e pastas do sistema. A entrega do executor e sua validação estão em [BRO-023](./09-ia-no-comando.md#bro-023-arquivos-com-os-poderes-da-conta), com distribuição prevista no Broto 0.1.2. O executor tem validação local em [Evidências do Broto 0.1.2](../evidence/broto-0.1.2/README.md); distribuição e atualização instalada têm estados próprios.

O Cialai Broto é um terceiro tipo de Cialai. Não tem estúdio. É um programa separado, baixado à parte, instalado num aparelho com sistema operacional, e a sua única função é manter uma conexão segura com um hospedeiro, o Cialai do computador. Depois de pareado, o hospedeiro passa a rodar comandos e abrir terminais naquele aparelho, e isso vale tanto para a pessoa quanto para a IA que trabalha no hospedeiro.

A única tela do Broto é uma janela simples. Antes do pareamento, ela serve para colar o código e ligar para o hospedeiro. Depois de aprovado, ela vira um monitor do que está acontecendo, com dois botões, Pausar e Desconectar.

## Como funciona, em quatro passos

1. No hospedeiro, em Dispositivos, a pessoa clica em Conectar novo Broto. O hospedeiro gera um código novo e aleatório.
2. A pessoa leva o código até a outra máquina e cola na janela do Broto. O Broto liga para o hospedeiro.
3. O pedido aparece no hospedeiro, na lista Brotos ligando. A pessoa decide se aprova ou recusa.
4. Aprovado, o hospedeiro e a IA passam a usar o terminal daquela máquina, e a janela do Broto mostra a atividade ao vivo.

## As três personas

| Persona | Onde roda | Papel |
| --- | --- | --- |
| Cialai, o hospedeiro | Computador, hoje em geral o Mac | Roda os terminais, hospeda a IA e manda nos Brotos |
| Cialai no celular | iPhone e Android | Espelha o hospedeiro, vê e controla as sessões, inclusive as dos Brotos |
| Cialai Broto | Outro computador, depois TV e tablet | Recebe ordens do hospedeiro, executa no próprio aparelho e mostra a atividade na sua janela |

O celular e o Broto nunca falam entre si. Os dois falam com o hospedeiro. O celular espelha o hospedeiro, então enxerga os Brotos através dele.

Cada Broto aponta para um hospedeiro só. Um hospedeiro tem quantos Brotos quiser.

## A diferença central em relação ao celular

O celular e o Broto discam o hospedeiro pela mesma rede: rede local, depois direto pela internet, depois a reserva pelo Tor. A diferença é o sentido do controle. No celular, o hospedeiro serve a tela e o celular comanda os terminais do hospedeiro. No Broto, depois que a conexão sobe, é o hospedeiro que comanda os terminais do Broto. O Broto é a ponta que executa.

## Índice

| Nº | Documento | Responde |
| --- | --- | --- |
| 01 | [Visão](./01-visao.md) | O que é, para quem, o que entra e o que fica de fora, a relação com o Cialai Pro |
| 02 | [Conexão](./02-conexao.md) | Como o Broto disca o hospedeiro, identidade, o código, a lista Brotos ligando, token e revogação |
| 03 | [Controle](./03-controle.md) | A RPC reversa, os verbos de execução e terminal, como as sessões aparecem |
| 04 | [Segurança](./04-seguranca.md) | Modelo de ameaças, permissões em três camadas, o risco central, a execução pela IA |
| 05 | [Interface](./05-interface.md) | A seção Brotos em Dispositivos, Conectar novo Broto, a lista Brotos ligando e a janela do próprio Broto |
| 06 | [MCP](./06-mcp.md) | O adaptador que dá o Broto à IA do hospedeiro, as ferramentas e os limites |
| 07 | [Empacotamento](./07-empacotamento.md) | Binário por sistema, serviço, janela, instalador, download, assinatura e atualização |
| 08 | [Roteiro e checklist](./08-roteiro.md) | O checklist por fase para marcar o andamento, as decisões a registrar e o aceite de cada fase |
| 09 | [A IA do hospedeiro no comando](./09-ia-no-comando.md) | O comando `cialai broto`, a skill `cialai`, o card IA, a aprovação em qualquer tela, arquivos pelo túnel e vários Brotos, com as tarefas BRO-014 a BRO-022 |

## Glossário

| Termo | Significado nesta pasta |
| --- | --- |
| Hospedeiro | O computador que roda o Cialai desktop e manda nos Brotos |
| Broto | O aparelho que roda o programa Cialai Broto e executa as ordens |
| Brotos ligando | A lista no hospedeiro dos Brotos que colaram um código e esperam a aprovação |
| Monitor | A janela do Broto depois de aprovado, com a atividade ao vivo e os botões Pausar e Desconectar |
| Pausar | O Broto recusa ordens novas até a pessoa retomar, sem desfazer o vínculo |
| Desconectar | O Broto desfaz o vínculo e esquece o hospedeiro; para voltar, só com um código novo |
| RPC reversa | O canal pelo qual o hospedeiro manda ordens ao Broto, no sentido inverso ao do celular |
| Papel | O tipo de identidade de um aparelho no núcleo do túnel, hoje `desktop` ou `phone`, mais o novo `broto` |
| Verbo | Uma ordem que o hospedeiro manda ao Broto, como `exec` ou `pty.open` |

## Como esta pasta se liga ao resto da documentação

A conectividade, o pareamento e o protocolo que o Broto reaproveita estão em `docs/arquitetura/06-rede-e-pareamento.md` e `docs/arquitetura/07-protocolo-da-ponte.md`. A modalidade paga e o requisito de abrir sessões entre computadores estão em `docs/produto/17-cialai-pro.md`. As decisões ficam em `docs/produto/12-decisoes.md` e as tarefas em `docs/produto/11-roadmap-de-execucao.md`. O Broto não substitui nenhum deles; é uma frente nova que se apoia na rede já existente.
