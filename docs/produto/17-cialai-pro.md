# Cialai Pro

O Cialai Pro é a modalidade premium planejada do Cialai. Este documento registra
o escopo inicial, os objetivos, os comportamentos esperados, os requisitos
funcionais e as dependências técnicas de cada função. Nada aqui está
implementado. Preço, licenciamento e regras comerciais ficam fora deste
documento.

## Estado em 13/10/2026

| Item | Estado | Limite atual |
| --- | --- | --- |
| Escopo inicial do Cialai Pro | Pendente | Registrado neste documento e na decisão 053; nenhuma função tem código |
| Multi-Device Sessions | Pendente | Conceito funcional definido; desenho técnico não aprovado |
| Agents Manager | Pendente | Conceito funcional e disposição geral definidos; layout visual não definido |

## Escopo inicial

O escopo inicial planejado do Cialai Pro é composto exclusivamente por duas
funções.

| Função | Objetivo |
| --- | --- |
| [Multi-Device Sessions](#multi-device-sessions) | Uma mesma sessão de desenvolvimento acessada ao mesmo tempo por computadores e celulares, com troca de aparelho sem perder o contexto |
| [Agents Manager](#agents-manager) | Um painel dentro do terminal que mostra os agentes de IA, os subagentes e os processos paralelos de uma sessão |

Uma função nova só entra no Pro por decisão registrada no documento 12, que
atualiza esta tabela. Nenhuma outra função está prevista.

## O que não muda

O Pro amplia o Cialai sem trocar a proposta original. Valem para as duas
funções os princípios do documento 01 e as regras abaixo.

| Regra | Consequência para o Pro |
| --- | --- |
| O Cialai é open source sob Apache 2.0 | Tudo que a edição aberta faz hoje continua na edição aberta |
| A conectividade é a mesma da edição aberta | Caminho direto e Tor embutido, com TLS 1.3 mútuo, sem servidor da pessoa, da Ordinum ou do projeto. O Pro não cria serviço hospedado |
| O computador manda, o celular acompanha ou cai | Um aparelho lento ou que caiu nunca trava a sessão no computador |
| Tudo que a interface afirma foi observado | Nenhum estado de agente ou processo é inferido |
| Uma só implementação da interface | O que o Pro mostra no celular chega pela mesma página que o computador serve |
| O computador precisa estar ligado com o Cialai aberto | Continua valendo. As sessões vivem no computador anfitrião |

## Multi-Device Sessions

### Objetivo

Permitir que a pessoa trabalhe numa mesma sessão de desenvolvimento a partir de
vários aparelhos, ao mesmo tempo ou alternando entre eles, com a experiência
contínua independentemente do aparelho usado.

### Ponto de partida na edição aberta

A edição aberta já tem parte da base. O Pro parte dela e não a retira.

| Capacidade atual | Onde está descrita |
| --- | --- |
| Uma sessão aceita vários assinantes: o webview do computador e cada conexão remota recebem a mesma saída | Documento 03, fluxo do terminal |
| Quem anexa recebe o replay dos últimos 256 KiB e segue do deslocamento certo | Documento 07 |
| A escrita remota entra numa fila ordenada por `pty_write` | Documento 03 |
| Um dispositivo por vez controla as dimensões do PTY pela concessão de largura, de 15 s renovada a cada 5 s | Documento 07 |
| A tela Dispositivos lista, renomeia e revoga os celulares pareados | Documento 06 |
| O histórico fica em disco e as conversas de Claude Code e Codex são retomadas depois que o app fecha | Documento 01 |

Limites atuais que o Pro precisa enfrentar:
- O pareamento liga celular a computador. Um computador não abre as sessões de
  outro computador.
- O estado de interface de cada cliente, como layout das colunas e estado do
  grafo, fica no `localStorage` daquele cliente e não é compartilhado.
- Editor, Dev Browser e grafo da documentação ficam fora da ponte do celular.

### Requisitos funcionais

| Nº | Requisito |
| --- | --- |
| MD1 | Conectar vários aparelhos à mesma sessão de desenvolvimento, computadores e celulares, cada um identificado pelo próprio pareamento |
| MD2 | Abrir as sessões de um computador anfitrião a partir de outro computador pareado |
| MD3 | Compartilhar o estado da sessão entre os aparelhos conectados: terminais, agentes, processos e os demais elementos da sessão |
| MD4 | Alternar entre computador e celular sem perder o contexto: o aparelho que chega encontra a sessão no ponto em que ela está |
| MD5 | Preservar terminais, agentes e processos durante a alternância. Nada é reiniciado por causa da troca de aparelho |
| MD6 | Mostrar quais aparelhos estão conectados a cada sessão e permitir desconectar um deles |
| MD7 | Garantir continuidade e consistência com acessos simultâneos: uma ordem única de escrita, um dono por vez das dimensões e uma regra conhecida para entradas concorrentes |

### Comportamentos esperados

| Situação | Comportamento |
| --- | --- |
| A pessoa sai do computador com um agente trabalhando e abre a sessão no celular | O celular mostra a sessão no ponto atual, com o agente ainda trabalhando |
| A pessoa volta ao computador | O computador mostra o que aconteceu enquanto ela estava no celular, sem reabrir nada |
| Dois aparelhos digitam na mesma sessão | Vale a ordem de chegada no computador, e todos os aparelhos veem o mesmo resultado |
| Um aparelho perde a conexão | A sessão segue no computador. O aparelho volta com replay e continua do ponto certo |
| A pessoa desconecta um aparelho de uma sessão | Só aquele aparelho deixa a sessão. O pareamento continua; revogar segue sendo ação da tela Dispositivos |
| Um elemento da sessão não existe no aparelho que chegou | O elemento continua preservado no computador e reaparece quando a pessoa volta a ele |

### Dependências técnicas e questões abertas

| Tema | Dependência ou questão |
| --- | --- |
| Pareamento entre computadores | Não existe. Precisa do mesmo modelo de identidade Ed25519, TLS 1.3 mútuo e revogação usado pelos celulares |
| Fonte do estado compartilhado | Definir o que é estado da sessão além do PTY e mover para o computador o que hoje vive em cada cliente |
| Presença por sessão | A ponte já sabe quais conexões assinam cada sessão. Falta expor isso como lista de aparelhos |
| Concorrência de entrada | Decidir se a fila ordenada basta ou se a sessão precisa de indicação de quem está digitando |
| Elementos só do computador | Editor, Dev Browser e grafo continuam fora da ponte do celular, salvo decisão nova no documento 12 |
| Desempenho | Cada assinante a mais custa replay e banda. O limite de assinantes por sessão ainda não foi definido |

## Agents Manager

### Objetivo

Dar à pessoa uma visão única, dentro do próprio terminal, de tudo que roda numa
sessão: agentes de IA, subagentes e processos em segundo plano, com o estado e a
atividade de cada um.

### Ponto de partida na edição aberta

| Capacidade atual | Onde está descrita |
| --- | --- |
| O card da sessão mostra o estado do agente em primeiro plano, lido de `agentTurn` e `outputAgeMs` | Documento 04, Estados da sessão, e decisão 038 |
| A Barra de IA mostra um anel por conta e a atividade das sessões de cada conta | Documento 15 |
| O Rust percorre a árvore de processos do shell e reconhece Claude Code e Codex pela linha de comando | `apps/desktop/src-tauri/src/workspace/procs/mod.rs` |
| As linhas de subagente do Claude Code são reconhecidas e descartadas, para não falarem pela sessão | `apps/desktop/src-tauri/src/notch/sessions/claude.rs` |
| A sessão pede atenção por sino, OSC 9, OSC 777 e fim de job | Documento 02, Atenção |

Hoje cada sessão mostra um estado só, o do processo em primeiro plano. Não há
lugar que mostre os subagentes nem os processos em segundo plano da sessão.

### Requisitos funcionais

| Nº | Requisito |
| --- | --- |
| AM1 | Identificar os agentes, subagentes e processos em segundo plano associados à sessão atual |
| AM2 | Mostrar individualmente o que cada agente está executando |
| AM3 | Exibir para cada item os estados executando, aguardando, concluído e erro |
| AM4 | Permitir acompanhar a atividade e os logs de cada execução, quando disponíveis |
| AM5 | Distinguir agentes de IA de processos convencionais, como shells e scripts |
| AM6 | Centralizar o acompanhamento de várias execuções simultâneas, inclusive quando iniciadas por Claude Code ou Codex |

### Estados e sinais observados

Cada estado só aparece quando há um sinal observado que o sustente. Silêncio
nunca vira concluído, como já vale para o card pela decisão 038.

| Estado | Agente de IA | Processo convencional |
| --- | --- | --- |
| Executando | Turno em andamento gravado pelo próprio agente | Processo vivo com saída recente ou CPU acima do piso |
| Aguardando | A própria ferramenta grava que espera a pessoa | Não se aplica |
| Concluído | Fim de turno gravado pelo agente | Saída com código 0 |
| Erro | Falha gravada pelo agente | Saída com código diferente de zero ou por sinal |

Sem sinal próprio, o item aparece só como aberto, sem estado afirmado. O Codex
não publica espera, então um item do Codex nunca aparece como aguardando.

### Disposição na interface

| Diretriz | Valor |
| --- | --- |
| Onde fica | Dentro do próprio espaço do terminal, sem abrir página independente |
| Forma | Painel integrado à sessão, que a pessoa expande ou recolhe |
| Convivência | O painel coexiste com o conteúdo da sessão, e o terminal continua recebendo digitação com ele aberto |
| Celular | O painel chega pela mesma página que o computador serve e segue a mesma regra de não sair do terminal |
| Layout visual | Não definido. Cores, formatos dos componentes, dimensões, organização dos cards e demais características estéticas ficam para uma etapa própria |

### Dependências técnicas e questões abertas

| Tema | Dependência ou questão |
| --- | --- |
| Subagentes do Claude Code | O leitor atual descarta as linhas `isSidechain`. Usá-las exige confirmar o formato por versão do Claude Code e onde cada versão grava o subagente |
| Subagentes e execuções paralelas do Codex | Confirmar se o Codex publica essa informação. Ele também não publica pid |
| Processos em segundo plano | A árvore de processos do shell dá a lista. A saída deles chega misturada no mesmo PTY, então log separado só existe quando o processo ou o agente grava em fonte própria |
| Leitura contínua | As sessões da Barra de IA são lidas a cada 1 s. O painel precisa caber no orçamento de `npm run check:performance` |
| Sistemas | Árvore de processos e ConPTY diferem no Windows, conforme o documento 14 |
| Celular | Definir o que a ponte libera ao celular, em especial logs e ações sobre processos |

## Fora deste documento

| Item | Onde fica |
| --- | --- |
| Preço, licenciamento e regras comerciais | Fora da documentação do produto neste momento |
| Outras funções Pro | Só entram por decisão nova no documento 12 |
| Layout visual do Agents Manager | Etapa própria de desenho |
| Código, interface e tarefas de desenvolvimento | Entram no documento 11 quando o desenvolvimento for aprovado |
