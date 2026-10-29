# MCP local do Broto

O binário `cialai-broto-mcp` roda no hospedeiro e fala MCP por stdin e stdout.
Não abre porta TCP. Implemente o listener do hospedeiro com
`brotohostipc.Serve` e o handler central de autorização do Broto.

```sh
claude mcp add --transport stdio cialai-broto -- /CAMINHO/cialai-broto-mcp
```

A CLI do cliente MCP deve ser instalada separadamente. O adaptador não recebe
segredo de ponte, token do Broto nem chave do túnel. Ele se conecta ao socket
`Cialai/broto-host.sock` dentro de `os.UserConfigDir`, ou ao named pipe de mesmo
escopo no Windows. `CIALAI_BROTO_HOST_SOCKET` permite selecionar outro endpoint
local. Não aponte para endpoints de outro usuário.

No Unix o socket tem permissão 0600. Seu diretório precisa pertencer ao usuário
sem escrita para outros. Um socket existente não é removido automaticamente.
No Windows o named pipe tem ACL exclusiva do SID do processo hospedeiro.
Processos do mesmo usuário e administradores ficam fora dessa barreira.

Ferramentas disponíveis, `listar_brotos`, `listar_sessoes`, `ler_saida`, `rodar`,
`abrir_terminal`, `escrever` e `esperar_texto`. As duas primeiras usam os métodos
`broto.list` e `broto.sessions`. As demais usam `broto.call`, com origem `ai`
forçada pelo servidor IPC e somente `exec`, `pty.open`, `pty.list`, `pty.read`
e `pty.write` permitidos. O handler do hospedeiro decide leitura, confirmação,
pausa e revogação. Nunca use o IPC como substituto da autorização do Hub.

A versão negociada é MCP 2025-03-26. Cada mensagem JSON-RPC ocupa uma linha,
sem texto de diagnóstico em stdout. Requisições MCP são sequenciais, limitadas a
1 MiB; mensagens IPC são limitadas a 4 MiB para comportar saída JSON escapada. A espera de texto tem prazo máximo de 120 segundos e suporta texto
partido entre leituras. Cancelamento antecipado por notificação MCP ainda não
é implementado; o prazo e o contexto do processo encerram a operação.

Referências oficiais usadas na implementação

- https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- https://modelcontextprotocol.io/specification/2025-03-26/server/tools

Os testes locais exercitam handshake, schemas, chamada, recusa só leitura,
origem IA, bloqueio de métodos administrativos e IPC real Unix. A compilação
Windows foi verificada; named pipe e registro no Claude Code real ainda exigem
execução correspondente. Não há aceite de execução remota real nesta entrega.
