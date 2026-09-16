# Protocolo da ponte

A ponte é o servidor WebSocket em Rust, em `macos/src-tauri/src/bridge/` no Control, que expõe à página do celular os mesmos comandos que o webview do desktop chama por IPC do Tauri. O Cialai preserva o protocolo da versão 1 e o estende com autenticação por dispositivo. Este documento é a fonte única do contrato; `packages/protocol` guarda fixtures JSON compartilhadas pelos testes em Go, Rust e JavaScript.

## Estado em 13/09/2026

| Parte | Estado | Situação atual |
| --- | --- | --- |
| Servidor e protocolo Rust | Implementado | Handshake, limites, lista permitida, ordem, replay e códigos de fechamento passam na suíte local |
| Segredo da borda e identidade do dispositivo | Implementado | Conferidos na conectividade v2 em CON-045: segredo da borda obrigatório, `X-Cialai-Device-Id` e `X-Cialai-Device-Key` do registro v2, `welcome` com nomes conhecidos e revogação com 4401, com testes Rust e 403 sem segredo verificado contra a ponte local |
| Esquema e fixtures compartilhados | Implementado | `packages/protocol` valida mensagens e compatibilidade da versão 1 |
| Transporte remoto JavaScript | Implementado | Delegação, canais, reconexão e recusa após revogação passam nos checks Node |
| Extensão `terminal-mobile-v1` | Implementado | Apresentação, concessão e leitura restrita de arquivos têm testes locais |
| Revogação ponta a ponta simulada | Implementado | Fechamento 4401 e ausência de retentativa foram verificados sem aparelho |
| Verificação com celular e rede reais | Pendente | Os roteiros imprimíveis não têm resultados de iPhone ou Android |

## Onde vive

| Parte | Origem no Control | Destino no Cialai |
| --- | --- | --- |
| Servidor, conexões, fan-out de eventos | `bridge/mod.rs`, 611 linhas | `apps/desktop/src-tauri/src/bridge/mod.rs` |
| Tipos das mensagens, lista permitida, validações puras | `bridge/protocol.rs`, 254 linhas | mesmo nome |
| Despacho para os comandos existentes | `bridge/dispatch.rs`, 279 linhas | mesmo nome, sem VPN, reuniões e stack |
| Encaminhamento de eventos do app | `bridge/events.rs`, 46 linhas | mesmo nome, só `pty://exit`, `pty://view` e `browser://exit` |
| Vários assinantes e anel de histórico | `workspace/terminal.rs:204-343` | inalterado |
| Transporte no frontend | `frontend/src/lib/remote.js`, 150 linhas; delegação em `lib/native.js` | `packages/protocol/remote.js` |
| Autorização na página | `frontend/src/lib/sensitive.js` | `packages/protocol/sensitive.js` |

## Decisões herdadas

1. `tokio-tungstenite` sobre o tokio que o Tauri já traz, sem framework HTTP; o único HTTP é o upgrade, e `accept_hdr_async` dá acesso a caminho e cabeçalhos.
2. O assinante remoto é um `Channel` do Tauri criado pela ponte em nome da conexão, então `pty_spawn` e `pty_attach` não mudam de assinatura e a CSP do webview não muda.
3. O desktop manda, o celular acompanha ou cai. O assinante do webview acima de 512 KiB pendentes para a bomba e o shell bloqueia; o assinante remoto acima da marca espera no máximo 3 s, recebe `detached` com motivo `lagged` e é removido. A fila de quadros de saída da conexão, de 4096 quadros, desliga do mesmo jeito só o canal que a encheu, com o mesmo `detached`, e a conexão segue para as outras sessões; saída maior que um quadro sai em pedaços que a página cola pelo deslocamento. Até 15/09/2026 a fila tinha 64 quadros e, cheia, derrubava a conexão inteira, o que acontecia a cada replay dos históricos e deixava o celular num ciclo de reconexão.
4. Cada sessão guarda até 256 KiB com contador absoluto; `attach` responde `replay` com offset e comprimento e um quadro binário, e só depois a saída ao vivo. O webview também recebe replay ao recarregar.
5. Comandos ordenados por sessão passam por uma fila de uma thread só, preservando a ordem do fio: `pty_spawn`, `pty_attach`, `pty_ack`, `pty_write`, `pty_kill`, `pty_view_claim`, `pty_view_renew`, `pty_view_release`. Os demais rodam em `spawn_blocking`.

## Handshake

1. Caminho do upgrade em `/`, `/pty` ou começando com `/pty/`. O `/` continua aceito porque a borda pode remover o prefixo.
2. Cabeçalho `Origin`, quando presente, precisa ser uma origem HTTP válida em loopback. A aceitação de `.ts.net` do protótipo sai; em desenvolvimento a flag `--dev-open-bridge` libera outras origens. Recusa com 403 antes do upgrade.
3. Cabeçalho `X-Cialai-Proxy-Secret` obrigatório, comparado em tempo constante com o segredo gerado pelo Rust a cada abertura do app e injetado pelo supervisor em `net.start`. Sem ele, 403, salvo com `--dev-open-bridge`. Junto vêm `X-Cialai-Device-Id`, `X-Cialai-Device-Key` e `X-Cialai-Transport`, que a borda v2 preenche com o id e a chave Ed25519 do celular no registro v2 e com o transporte, `direct` ou `tor`. Com o segredo e sem `X-Cialai-Device-Id` ou `X-Cialai-Device-Key`, 403; o antigo `X-Cialai-Node-Key` não é mais aceito nem enviado. A ponte associa id e chave à conexão para exibição e revogação. Qualquer cabeçalho com esse prefixo vindo de fora da borda é removido pela própria borda antes do encaminhamento.
4. `Authorization: Bearer` continua aceito para clientes que não são navegador, como `websocat` em desenvolvimento.
5. Depois do upgrade, o primeiro quadro de texto em até 5 s deve ser `hello`.
6. Fechamentos: 4400 para `hello` inválido ou `call` antes do `hello`; 4401 para credencial inválida ou dispositivo revogado; 4426 para versão incompatível.
7. Limites: quadro máximo de 1 MiB, até 8 conexões, 16 chamadas concorrentes por conexão, 4096 quadros de saída pendentes, ping a cada 20 s, escrita com prazo de 20 s e fechamento após dois pings sem resposta. A ponte registra no log o motivo de cada fechamento de conexão de celular.

## Esquema de mensagens

Quadros de texto são JSON. Quadros binários carregam saída de PTY com cabeçalho de 4 bytes, o id do canal em `u32` big endian, seguido dos bytes. O offset absoluto não vai por quadro porque, dentro de uma conexão, os quadros de um canal são ordenados e contíguos, e o `replay` fixa a posição a cada religação.

| Direção | Quadro | Forma |
| --- | --- | --- |
| Página ao desktop | `hello` | `{"type":"hello","version":1,"token":null,"client":"cialai-ios","app":"1.0.0"}`; `client` também aceita `cialai-android`, `cialai-dev` e o `ios` do protótipo |
| Desktop à página | `welcome` | `{"type":"welcome","version":1,"auth":"device","user":null,"device":{"id":"dev_…","name":"iPhone de Foco"},"desktop":{"id":"d_…","name":"MacBook"},"capabilities":["pty"],"features":["terminal-mobile-v1"]}` |
| Página ao desktop | chamada | `{"type":"call","id":17,"cmd":"pty_write","args":{"id":3,"data":"ls\n"}}`; canal criado no cliente vai em `args` como `{"__channel__":5}` |
| Desktop à página | resultado | `{"type":"result","id":17,"ok":true,"value":null}` ou `{"type":"result","id":17,"ok":false,"error":"Sessão encerrada"}` |
| Desktop à página | evento | `{"type":"event","name":"pty://exit","payload":{…}}` |
| Desktop à página | canal JSON | `{"type":"channel","channel":5,"message":{"type":"exit",…}}` para `exit`, `replay` e `detached` |
| Desktop à página | canal binário | `[u32 canal][bytes]` |

Valores de `auth` em `welcome`: `device` quando o segredo da borda validou e há dispositivo. Os ids seguem o registro v2, `dev_` para o celular e `d_` para o computador, e os nomes vêm do que o supervisor entregou à ponte: o computador pelo `NetStatus` de `net.start` e por `net.state`, os celulares por `devices.list` logo depois de `net.start`, por `pair.completed` e pela renomeação em `devices.changed`. O nome do celular só aparece quando a chave do cabeçalho confere com a do registro; celular revogado ou chave diferente mostra o id no lugar do nome; `token` quando a credencial veio como subprotocolo ou Bearer no plano B; `open` só com `--dev-open-bridge`. Campos novos são opcionais na desserialização, com `#[serde(default)]` como o protótipo já faz em `protocol.rs:10-16`, para a página do protótipo continuar funcionando em desenvolvimento.

## Mapa dos comandos

| Comando | Na ponte | Confirmação na casca |
| --- | --- | --- |
| `pty_list`, `pty_metrics`, `ai_usage` | Permitido | Livre |
| `pty_attach` | Permitido, assinante remoto com replay | Livre |
| `pty_ack` | Permitido, no escopo do assinante da própria conexão | Livre |
| `pty_write` | Permitido | Autorização por terminal, compartilhada com `pty_view_claim`, até revogação |
| `pty_spawn` | Permitido | Sessão |
| `pty_kill` | Permitido | Por ação |
| `pty_view_claim` | Permitido ao assinante da sessão; assume a largura | Por ação, compartilhada com a digitação |
| `pty_view_renew`, `pty_view_release` | Permitido ao dono da concessão válida | Sem novo prompt |
| `pty_files_list`, `pty_file_read` | Leitura restrita ao projeto da sessão assinada, assinatura conferida antes e depois do disco | Livre |
| `list_repo_dirs` | Permitido, só devolve caminhos das raízes configuradas | Livre |
| `pty_presentation`, `pty_resize` | Recusados; a apresentação é publicada só pelo IPC local e o celular usa a concessão | |
| `fs_*`, `git_*`, `fs_watch`, `fs_unwatch`, `preview_register`, `office_convert`, `browser_*` | Recusados com `Disponível só no computador.` | |
| Comandos de janela, preferências e ciclo de vida | Recusados | |

`vpn_*`, `meetings_*` e `stack_*` deixam de existir. `sensitive.js` na página continua rejeitando comandos remotos fora da lista antes de pedir biometria ou enviar a chamada; a recusa na ponte independe da página.

## Extensão `terminal-mobile-v1`

`pty_list` inclui `presentation` e `view`. O desktop publica a apresentação por `pty_presentation` local; o celular a consome para nome, subtítulo, cor, fixação e ordem dos cards, sem escrita remota.

| Comando | Argumentos | Resposta |
| --- | --- | --- |
| `pty_view_claim` | `id`, `cols`, `rows` | `{id, cols, rows, owner, leaseId, revision}` |
| `pty_view_renew` | `id`, `leaseId`, `cols`, `rows` | Vista atualizada, se a concessão pertence à conexão e não expirou |
| `pty_view_release` | `id`, `leaseId` | Vista após liberação e restauração local |
| `pty_files_list` | `id`, `path` relativo opcional | `{path, entries[{name, path, kind, size}], truncated}` |
| `pty_file_read` | `id`, `path` relativo | `{path, content, size}` |

A concessão remota dura 15 s; a página renova a cada 5 s. `leaseId` identifica a tomada de controle e `revision` ordena mudanças. A identidade real é a conexão assinante. Perder a assinatura, desconectar ou expirar devolve a última medida local. Resize passivo do desktop não toma o controle. A raiz das leituras é derivada pelo Rust do diretório registrado na criação da sessão e precisa estar dentro das raízes de projetos configuradas; cada pasta é limitada a 200 itens e cada prévia a 128 KiB de texto UTF-8; ocultos, nomes de credenciais, chaves, links simbólicos e caminhos que escapam da raiz são bloqueados.

## Eventos encaminhados

| Evento | Uso no celular |
| --- | --- |
| `pty://exit` | Fim de sessão, rede de segurança do quadro `exit` em banda |
| `pty://view` | Mudança de dono, dimensões, concessão e revisão |
| `browser://exit` | Informativo; o Dev Browser não abre no celular |

Não encaminhados: `fs://change`, `browser://install`, `drag-out://end`.

## Política de atraso e histórico

| Assinante | Acima de `HIGH_WATER` | Ao religar |
| --- | --- | --- |
| Webview do desktop | A bomba para e o shell bloqueia | Replay do histórico na recarga |
| Remoto | A bomba espera até 3 s, depois o assinante recebe `detached` e é removido; o desktop segue. Fila de quadros da conexão cheia: só o canal que a encheu recebe `detached` e a conexão continua | Replay com offset e continuação do ponto certo |

`pty_ack` continua sendo a confirmação de bytes consumidos, por assinante; no transporte remoto `channel` identifica o canal atual junto de `id` e `bytes`, e confirmações de canal substituído são ignoradas. `detach_all` remove a conexão de todas as sessões quando o socket fecha.

## Revogação

A ponte guarda `device_id` por conexão. `devices.revoke` no sidecar chama `edge.Server.Revoke`, que marca o celular como revogado no registro v2 e emite `devices.changed` com `revoked: true` uma única vez; o supervisor Rust repassa à ponte, que tira o celular do mapa de identidades e fecha os sockets daquele dispositivo com 4401 em menos de 1 s. A borda espera esses sockets terminarem por até 500 ms e só então fecha as sessões QUIC e Tor da chave, para o fechamento 4401 chegar ao celular. `remote.js` não tenta de novo em 4401 nem em 4426, então a página mostra o estado "removido" e a casca oferece parear de novo.

## Transporte na página

`remote.js` tem a mesma cara de `native.js`: `invoke(cmd, args)`, `listen(nome, handler)` e `createChannel(onmessage)`. `native.js` delega ao remoto quando não há Tauri e `remote.isConfigured()` é verdadeiro, depois de validar o comando em `sensitive.js`, e exporta `hasBridge()`. A reconexão espera de 0,5 a 8 s dobrando, e também tenta em `visibilitychange` e `pageshow`, porque o iOS suspende o socket em segundo plano e o mantém em `OPEN` mesmo morto; uma ocultação de menos de 15 s com o socket aberto, como o Face ID ou a central de notificações, mantém o socket em vez de religar. Quando o socket cai, todo canal aberto recebe `detached` com motivo `socket`, e o runtime religa a sessão. Desconectado, `invoke` rejeita com `Ponte com o computador desconectada.`. Chamadas nunca são reenviadas depois de uma queda. Prazo de 6 s para o handshake cobrindo TCP e `welcome`. A casca do celular configura a ponte em `mobile/main.jsx` com `ws://<host da página>/pty`, que no Cialai é o proxy em loopback; em desenvolvimento `?bridge=ws://127.0.0.1:3720/pty`.

## Compatibilidade e versionamento

| Situação | Comportamento |
| --- | --- |
| Página do protótipo contra a ponte do Cialai em desenvolvimento | `hello` com `client: "ios"` aceito; `welcome` traz campos a mais que a página ignora |
| Página do Cialai contra desktop sem `terminal-mobile-v1` | A página pede atualização do computador, como hoje |
| Nova capacidade | Entra em `features`; a página só usa o que o desktop anuncia |
| Mudança incompatível | Incrementa `version`; ponte responde 4426 |

## Verificação

1. Suíte Rust da ponte: origem recusada antes do upgrade, `call` antes do `hello` com 4400, `welcome` e lista permitida sem tocar nos gerenciadores reais, ordem do fio preservada com primeira escrita lenta, prazo do `hello`, pongs perdidos em 40 s, códigos distintos para credencial e versão, quadro acima do limite nunca chega ao despacho, fila de saída cheia fecha a conexão, chamadas concorrentes acima do limite recusadas; novos casos: segredo da borda válido marca `auth: "device"` e associa o dispositivo, segredo ausente devolve 403 salvo `--dev-open-bridge`, segredo sem `X-Cialai-Device-Key` ou só com o antigo `X-Cialai-Node-Key` devolve 403, chave diferente do registro não herda o nome conhecido, celular revogado sai da sincronização, a fixture `welcome.json` com ids v2 bate com a serialização Rust, subprotocolo com token no plano B, revogação fecha com 4401, `Welcome` serializa os campos novos.
2. `websocat -H='Origin: https://evil.example' ws://127.0.0.1:3720/` recebe 403; `websocat` sem o segredo recebe 403; com `--dev-open-bridge` e `Origin` em loopback recebe `welcome` com `auth: "open"`. Em 15/09/2026, durante CON-045, o app de desenvolvimento no macOS com `CIALAI_BRIDGE_PORT=38720` recusou com 403 o upgrade WebSocket por `curl` sem `X-Cialai-Proxy-Secret`, com segredo errado e com `Origin: https://evil.example`; `websocat` não estava instalado. O caso `--dev-open-bridge` não foi repetido.
3. `check-mobile.mjs` do protótipo, portado: ordenação do handshake, delegação, quadros de canal, dedupe do replay, retomada em primeiro plano substituindo socket morto, prazo de conexão, recusa de mutação HTTP, política do navegador, prompt único na primeira digitação, revogação do bloqueio da casca, kill exigindo autorização nova, download e link externo.
4. Pelo celular: sessão aberta no desktop aparece com histórico, saída ao vivo nos dois lados, `echo celular` digitado no telefone ecoa no desktop; `yes | head -c 50000000` mantém o desktop fluido e o telefone acompanha ou recebe `detached` e religa; modo avião por um minuto derruba a conexão no desktop em até 40 s, nenhum shell morre e o telefone religa sozinho.
