# 05 · Interface

## Estado em 28/10/2026

Seção Brotos, código de vínculo, pedidos de aprovação com prévia escapada, nível de acesso e abertura de terminal implementados no hospedeiro. O monitor Tauri está em `apps/broto`, com IPC local protegido, instalação do serviço a partir de payload assinado e controles de vínculo, pausa, retomada e desconexão. Strings e testes nos três idiomas passaram.

O monitor executou o fluxo nativo com daemon, borda e hub reais no macOS. No Windows, a interface WebView2 executou todos os controles na sessão interativa existente, com recusa correta de execução sob conta privilegiada, saída natural da janela e sobrevivência do daemon. Execução e PTY sob conta comum foram verificados separadamente em Session 0. A tentativa de transferir um token comum para a sessão gráfica não carregou a página no laboratório; essa combinação não está aprovada. Essas provas não substituem a validação do instalador distribuído.

No serviço Windows, abrir um app com janela por exec ou PTY não o torna visível na sessão gráfica da pessoa. O monitor já vive nessa sessão, mas ainda não é um lançador. O contrato para a IA está nos [limites do MCP](./06-mcp.md#aplicativos-gráficos-no-windows); as alternativas aguardam escolha na [proposta 069](../produto/12-decisoes.md#069-proposta-de-lançador-gráfico-do-broto-no-windows). Não há implementação aprovada de transferência de token ou tarefa interativa para esse fim.

| Peça | Estado | Base que reaproveita |
| --- | --- | --- |
| Seção Brotos na página Dispositivos | Preparado | `packages/ui/src/desktop/Devices.jsx` e `AccessPanel.jsx` |
| Conectar novo Broto e a lista Brotos ligando | Implementado | `packages/ui/src/desktop/Brotos.jsx` e comandos `broto_pair_*` |
| Nível de permissão por Broto | Implementado | `Brotos.jsx` e `broto_permission_set` |
| Sessões do Broto na lista | Preparado | `syncSharedSessions()` em `packages/ui/src/terminals/runtime.js` e `SessionCard.jsx` |
| Janela do próprio Broto | Preparado | `packages/ui` e `packages/i18n`, como o desktop |
| Strings nos três idiomas | Preparado | `packages/i18n/src/locales/<loc>/desktop.js` e um arquivo novo `broto.js` |

## Onde o Broto aparece no hospedeiro

A página Dispositivos é uma página da lateral, na rota `dispositivos`, alcançada pela lateral, pelo atalho de teclado e pela paleta de comandos. Hoje ela mostra os celulares vinculados. O Broto entra como uma segunda seção na mesma página, sem criar uma tela nova.

```
Dispositivos
├─ Celulares
│   └─ linhas de celular, como hoje
└─ Brotos
    ├─ botão Conectar novo Broto
    ├─ Brotos ligando, à espera da decisão, cada um com Aprovar e Recusar
    ├─ linhas de Broto, cada uma com nome, estado, caminho, nível de permissão e Abrir terminal
    └─ Pedidos da IA, cada um com o comando legível, Aprovar e Recusar
```

Cada linha de Broto reaproveita o visual da linha de celular em `Devices.jsx`: o selo de transporte, direto ou reserva, o ponto de estado e o botão de desvincular. O que a linha de Broto acrescenta é o nível de permissão, num controle segmentado com Só acompanhar, Confirmar IA e Livre, o botão Abrir terminal e dois estados que vêm da própria máquina do Broto: pausado e desconectado. O botão Conectar novo Broto é o primário da seção, no rosa da marca.

## Conectar novo Broto e a lista Brotos ligando

O pareamento do celular vive em `PairingDialog.jsx`, com o QR que gira a cada 90 s dentro de uma janela de 600 s. O Broto tem um fluxo próprio, em três passos:

1. Na seção Brotos, o botão Conectar novo Broto abre um diálogo com um código novo e aleatório, o botão Copiar código e o tempo que falta para ele vencer. Quando o Broto liga com esse código, o próprio diálogo mostra os quatro dígitos com Aprovar e Recusar.
2. A pessoa leva o código até a outra máquina e cola na janela do Broto. O Broto liga para o hospedeiro.
3. O pedido aparece na lista Brotos ligando, com o nome do aparelho, o sistema e quatro dígitos. A janela do Broto mostra os mesmos quatro dígitos. A pessoa confere e escolhe Aprovar ou Recusar.

| Passo | Celular | Broto |
| --- | --- | --- |
| Como o código chega ao aparelho | O celular lê o QR com a câmera | A pessoa copia o código e cola na janela do Broto |
| Validade | O QR gira a cada 90 s | O código não gira e vale por 10 minutos, de uso único |
| Aprovação | Opcional | Sempre obrigatória, pela lista Brotos ligando |

Separar os fluxos evita que alguém aponte a câmera do celular para um código de Broto e entre pelo caminho errado. O código de Broto é para copiar, não para fotografar.

Ao aprovar, o pedido sai da lista e vira uma linha de Broto, já no nível pedir confirmação. Ao recusar, o pedido some e o código deixa de valer. A lista pode ter mais de um pedido ao mesmo tempo, um por código gerado, porque um hospedeiro tem quantos Brotos quiser.

## As sessões do Broto na lista

As sessões do estúdio vivem no painel de sessões, à esquerda da área de trabalho, alimentado pelo laço que consulta `pty_list` a cada 3 s. O hospedeiro lista os terminais do Broto nesse mesmo `pty_list`, e eles aparecem na lista sem tela nova.

Abrir terminal, na linha do Broto, abre um PTY no Broto e leva à tela de Terminais com essa sessão já selecionada, como um terminal local. O card leva o nome da máquina do Broto. A pessoa digita direto, sem confirmação; o nível pedir confirmação segura só o que a IA pede, pela decisão 064.

Para a pessoa não confundir uma sessão local com uma sessão de outra máquina, o card de cada sessão de Broto leva o símbolo do Broto no canto de baixo, à direita, solto e sem placa, com o nome do Broto na dica, em `SessionCard.jsx` e no card do celular. O agrupamento por aparelho na lateral é possível depois, porque o registro de views da lateral já aceita seções que abrem e fecham, mas na primeira versão basta o selo.

O celular espelha o hospedeiro. Como ele roda o mesmo laço de sessões, qualquer sessão de Broto que o hospedeiro listar também aparece no celular, e o celular a comanda com as mesmas regras de uma pessoa no hospedeiro. Hoje a lista do celular não diz de qual aparelho vem a sessão, então o selo de origem precisa chegar também à página do celular.

## A janela do próprio Broto

Na máquina do Broto há uma janela só, com dois estados. Ela é pequena de propósito: conectar e acompanhar, e mais nada.

A janela segue o visual do Cialai: a mesma fonte, os mesmos neutros, o mesmo rosa e os mesmos raios da casca sólida do desktop, com tema claro ou escuro conforme o sistema. Os tokens ficam em `packages/ui/src/broto/monitor.css` e repetem os de `packages/ui/src/desktop/solid.css`.

### Antes de aprovado

| Tela | O que mostra |
| --- | --- |
| Serviço | Quando o serviço não responde, o motivo e o botão Instalar e iniciar serviço, no lugar do campo de código. Durante a instalação, uma barra de progresso e o aviso de responder às janelas de permissão e senha do sistema. Numa conta de administrador do Windows, o UAC pede consentimento e o serviço roda como administrador |
| Conectar | Um campo de uma linha, em fonte monoespaçada, para colar o código, com o botão Colar dentro dele, que no Windows lê a área de transferência pelo sistema para o WebView2 não pedir permissão, e o botão Ligar, que só acende com um texto no formato de código de Broto |
| Aguardando | O nome do hospedeiro, os quatro dígitos para conferir com a lista Brotos ligando e o botão Cancelar |

Se o hospedeiro recusar ou o código vencer, a janela volta para Conectar e diz o motivo.

### Depois de aprovado, o monitor

| Parte | O que mostra |
| --- | --- |
| Conexão | O nome do hospedeiro, se está conectado e o caminho, direto ou reserva |
| Atividade | A lista do que acontece, com hora e autor, como um terminal aberto pela pessoa, um comando rodado pela IA ou uma sessão encerrada. As consultas de leitura que o hospedeiro faz a cada poucos segundos não entram, e a digitação seguida do mesmo autor fica numa linha só |
| Pausar | Recusa ordem nova, terminal novo e digitação até a pessoa retomar; o vínculo continua e o hospedeiro mostra o Broto como pausado |
| Desconectar | Desfaz o vínculo: fecha as sessões e esquece o hospedeiro e o token; para voltar, só com um código novo |

A atividade é o registro de auditoria do lado do Broto, a camada 3 do documento 04, mostrado ao vivo. Um comando que já estava rodando quando a pessoa pausa termina sozinho; para interromper tudo na hora, Desconectar fecha as sessões.

Fechar a janela não desconecta. A conexão vive no serviço do sistema, descrito no documento 07, e a janela é só o rosto dele. Também não há tela de ajustes: o teto local da camada 2 do documento 04 continua num arquivo, para quem quiser, fora da janela. Numa máquina sem tela, os mesmos comandos existem na linha de comando, também descritos no documento 07.

Pausar e Desconectar são a garantia de quem está na máquina do Broto. Eles funcionam sem depender do hospedeiro, mesmo com o hospedeiro desligado.

## Texto

As strings novas do hospedeiro ficam em `packages/i18n/src/locales/<loc>/desktop.js`, nos três idiomas, com as chaves em `desktop.brotos.*`. O teste de i18n exige as mesmas chaves e os mesmos espaços reservados nos três idiomas, e o `npm run check:text` proíbe parênteses, hífen isolado, meia-risca e travessão como separador no texto visível.

Exemplos de rótulo, já dentro da regra de texto:

| Chave | Português | Inglês | Espanhol |
| --- | --- | --- | --- |
| `desktop.brotos.sectionTitle` | Brotos | Brotos | Brotos |
| `desktop.brotos.add` | Conectar novo Broto | Connect new Broto | Conectar nuevo Broto |
| `desktop.brotos.waiting` | Brotos ligando | Incoming Brotos | Brotos entrantes |
| `desktop.brotos.approve` | Aprovar | Approve | Aprobar |
| `desktop.brotos.deny` | Recusar | Decline | Rechazar |
| `desktop.brotos.empty` | Nenhum Broto vinculado | No Broto paired | Ningún Broto vinculado |
| `desktop.brotos.paused` | Pausado no aparelho | Paused on the device | Pausado en el dispositivo |
| `desktop.brotos.levelRead` | Só acompanhar | View only | Solo seguir |
| `desktop.brotos.levelConfirm` | Confirmar IA | Confirm AI | Confirmar IA |
| `desktop.brotos.levelFree` | Livre | Free | Libre |
| `desktop.brotos.origin` | Sessão no Broto {name} | Session on Broto {name} | Sesión en el Broto {name} |

O espaço reservado `{name}` segue o padrão do motor de i18n, que preenche pelo nome do Broto.

A janela do Broto usa um arquivo próprio, `packages/i18n/src/locales/<loc>/broto.js`, que entra no `index.js` de cada idioma como os demais e fica sob o mesmo teste de chaves e o mesmo `check:text`:

| Chave | Português | Inglês | Espanhol |
| --- | --- | --- | --- |
| `broto.connect.title` | Conectar ao seu Cialai | Connect to your Cialai | Conectar a tu Cialai |
| `broto.connect.code` | Cole o código gerado no Cialai | Paste the code from Cialai | Pega el código generado en Cialai |
| `broto.connect.action` | Ligar | Connect | Conectar |
| `broto.waiting` | Aguardando aprovação em {host} | Waiting for approval on {host} | Esperando aprobación en {host} |
| `broto.monitor.activity` | Atividade | Activity | Actividad |
| `broto.pause` | Pausar | Pause | Pausar |
| `broto.resume` | Retomar | Resume | Reanudar |
| `broto.disconnect` | Desconectar | Disconnect | Desconectar |

## Ícone

O símbolo do Cialai é a cabeça do louva-a-deus orquídea com a pétala de topo atrás. O Broto tem arte própria em `brand/logo/broto-icon.jpg`, aprovada em 28/10/2026 após ajuste do usuário sobre a geração do Nano Banana Pro. A composição traz duas folhas rosas, broto central claro e haste magenta, com separações brancas, seguindo a família visual da marca sem redesenhar a cabeça do inseto nem criar um mascote de corpo inteiro.

Esse arquivo é a fonte aprovada e deve ser preservado nas derivações para a seção, a janela e o instalador. As derivações saem de `tools/brand/build-broto-icons.mjs`. O monitor usa `packages/ui/src/assets/broto-mark.png`, só a arte, sem placa. Os ícones nativos ficam em `apps/broto/src-tauri/icons` e repetem a geometria do ícone do Cialai: a mesma placa branca arredondada, na grade de 824 em 1024, com a arte reduzida para os cantos não cortarem as folhas. Essa versão do ícone ainda não foi recompilada no monitor Windows nem no instalador. A seção Brotos do hospedeiro ainda usa o ícone de interface da biblioteca.

## Continuação da interface para IA

As tarefas [BRO-014 a BRO-022](./09-ia-no-comando.md) acrescentam Renomear, número por ordem de aprovação, card IA por Broto, aviso de aprovação no topo do app e instalação da skill nas telas Dispositivos e Preferências. O card IA é de leitura e aceita Ctrl C para cancelar. Os terminais interativos continuam compartilhados com a pessoa. O checklist dessa fase distingue testes locais de aceite visual e remoto.

A revisão da fase IA mantém a lista completa Pedidos da IA em Dispositivos. O aviso global e o card mostram contador e navegação sincronizada por ID, com ordem estável. Fechar o card IA apenas oculta a sessão; Ctrl C continua sendo a ação de cancelamento. Quando Claude Code e Codex apontam para a mesma skill por alias, a interface mostra remoção compartilhada explícita e não permite remover silenciosamente a instalação usada pela outra IA.
