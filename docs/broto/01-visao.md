# 01 · Visão e escopo do Broto

## Estado em 28/10/2026

Implementação local preparada. Os critérios de produto abaixo exigem provas físicas e permanecem pendentes, mesmo com código e testes locais disponíveis.

| Critério | Estado | Evidência necessária para concluir |
| --- | --- | --- |
| O Broto pareia com um hospedeiro e sobe a conexão | Pendente | Binário rodando em outro computador, pareado e conectado pela rede local, direta e pela reserva |
| Nenhum Broto entra sem aprovação | Pendente | Pedido na lista Brotos ligando, recusado e aprovado, provado entre dois computadores reais |
| O hospedeiro roda um comando no Broto e recebe a saída | Pendente | `exec` com stdout, stderr e código de saída provado entre dois computadores reais |
| O hospedeiro abre um terminal no Broto | Pendente | Sessão de PTY no Broto vista e digitada no desktop e no celular |
| A IA do hospedeiro usa o Broto pelo MCP | Pendente | Claude Code rodando um comando no Broto com a permissão respeitada |
| Quem está na máquina do Broto pausa e desconecta | Pendente | Pausar e Desconectar na janela do Broto refletidos no hospedeiro em segundos |
| Revogar no hospedeiro corta o Broto | Pendente | Conexão fechada em menos de 1 s depois da revogação, como já ocorre com celular |

## O problema

Hoje o Cialai liga um computador a um celular. A IA que trabalha no computador só alcança o terminal daquele computador. Quem tem mais de uma máquina, um servidor de casa, um computador no trabalho ou um aparelho de teste, não consegue pôr a IA do Cialai para trabalhar nessas outras máquinas sem abrir porta, configurar SSH e expor cada uma à internet.

O Broto resolve isso sem servidor e sem porta aberta. A outra máquina instala um programa pequeno, cola um código gerado no hospedeiro e liga para ele. A pessoa aprova no hospedeiro, e o Broto passa a esperar ordens. A IA e a pessoa, no hospedeiro, operam aquela máquina como se fosse mais uma sessão do estúdio.

## Para quem

| Perfil | Necessidade que o Broto atende |
| --- | --- |
| Quem tem um servidor ou um segundo computador em casa | Rodar e acompanhar tarefas nele a partir do computador principal, sem expor a máquina |
| Quem desenvolve e testa em várias máquinas | Dar à IA um terminal em cada máquina de teste, com um pareamento por máquina |
| Quem opera máquinas atrás de NAT difícil | Alcançar o terminal mesmo sem IP fixo, pela reserva do Tor |

## O que entra na primeira versão

| Item | Detalhe |
| --- | --- |
| Sistemas | macOS, Linux x86_64 e Windows x64 |
| Conexão | Rede local, direto pela internet por QUIC e reserva pelo Tor, reaproveitando o núcleo do celular |
| Pareamento | Código aleatório gerado em Conectar novo Broto e aprovação obrigatória pela lista Brotos ligando |
| Execução | O verbo `exec`, que roda um comando sem terminal e devolve a saída e o código de saída |
| Terminal | Uma sessão de PTY de verdade, para programas interativos |
| Interface no hospedeiro | A seção Brotos na página Dispositivos, e as sessões do Broto na lista do estúdio e do celular |
| Janela do Broto | Uma tela para colar o código e ligar e, depois de aprovado, um monitor de atividades com Pausar e Desconectar |
| IA | O adaptador MCP que entrega o Broto ao Claude Code do hospedeiro |

## O que fica de fora da primeira versão

| Item | Motivo |
| --- | --- |
| Android, Android TV e tablets | O controle é parcial, limitado ao que um app consegue; entra numa fase seguinte |
| iPhone, iPad e Apple TV | A Apple não deixa um app rodar terminal; sem caminho viável |
| TVs Samsung e LG | Sistemas muito fechados; sem caminho viável hoje |
| Linux ARM64 | O Tor Expert Bundle não tem versão oficial para esse alvo, como registra `tools/fetch-tor.mjs` |
| Editor, explorador, grafo e Dev Browser numa sessão de Broto | Essas abas usam caminho de arquivo local do hospedeiro e não servem a uma máquina remota na primeira versão |
| Transferência de arquivo grande e encaminhamento de porta | Ficam para depois; a primeira versão é terminal e execução |
| Um Broto ligado a mais de um hospedeiro | Por ora, cada Broto aponta para um hospedeiro só |

## Relação com o Cialai Pro

O documento 17 descreve o Cialai Pro e o requisito MD2, abrir as sessões de um computador anfitrião a partir de outro computador pareado, e diz que o pareamento entre computadores ainda não existe.

O Broto e o MD2 não são a mesma coisa e esta é a fronteira:

| Aspecto | Broto | Cialai Pro MD2 |
| --- | --- | --- |
| Papel do aparelho | Ponta que executa, sem estúdio próprio | Dois hospedeiros completos que compartilham uma sessão |
| Preço | Gratuito e aberto | Modalidade paga |
| Objetivo | Dar à IA e à pessoa um terminal em outra máquina | Continuar a mesma sessão trocando de computador sem perder contexto |

O que os dois têm em comum é a necessidade de um computador reconhecer outro. O pareamento e o papel de identidade do Broto podem ser reaproveitados pelo MD2 quando o Pro for desenvolvido. O Broto não antecipa nem bloqueia o MD2; resolve um problema menor e gratuito primeiro.

## Princípios

1. O Broto nunca escuta em porta nenhuma. Quem disca é sempre o Broto, como o celular faz hoje. A superfície de ataque na máquina do Broto é zero do lado da rede de entrada.
2. O Broto guarda um hospedeiro só. Parear de novo substitui o anterior. Não existe Broto ligado a dois hospedeiros ao mesmo tempo. Um hospedeiro, ao contrário, tem quantos Brotos quiser.
3. Nenhum Broto entra sem a pessoa aprovar no hospedeiro. O código sozinho não basta.
4. O hospedeiro decide o que cada Broto pode fazer, e o Broto decide o teto do que aceita. As duas pontas limitam, e a mais restrita vence.
5. A IA passa pela mesma camada de permissão de uma pessoa. Nada do que a IA faz escapa do que o hospedeiro autorizou para aquele Broto.
6. Quem está na máquina do Broto sempre pode parar. Pausar e Desconectar ficam na janela do próprio Broto e não dependem do hospedeiro.
7. Reaproveitar a rede, o pareamento e o protocolo que já existem. O Broto é uma persona nova sobre a mesma base, não uma segunda rede.
