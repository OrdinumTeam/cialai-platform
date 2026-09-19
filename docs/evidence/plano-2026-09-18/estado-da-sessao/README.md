# EST-01: estados, rótulos e animação

Estado: código e testes automáticos prontos, execução manual pendente.

O computador passou a publicar `agentTurn` e `outputAgeMs` em `pty_metrics`, e a interface deriva rótulo, tom e animação de `deriveActivity`. Falta ver isso acontecer numa máquina de verdade.

## Matriz manual no macOS

Uma linha por caso, no card da lista e no cabeçalho do terminal, no computador e no celular.

| Caso | Rótulo esperado | Anima | Confere | Captura |
| --- | --- | --- | --- | --- |
| Claude Code respondendo | Processando | Sim | ☐ |  |
| Claude Code parado depois de responder | Resposta entregue | Não | ☐ |  |
| Claude Code pedindo permissão | Aguardando você | Não | ☐ |  |
| Codex respondendo | Processando | Sim | ☐ |  |
| Codex parado depois de responder | Resposta entregue | Não | ☐ |  |
| Duas sessões do Codex na mesma pasta | Estados independentes | ☐ | ☐ |  |
| `ssh` aberto e parado | Processo aberto | Não | ☐ |  |
| `ssh` com comando produzindo saída | Em execução | Sim | ☐ |  |
| REPL do `python` parado | Processo aberto | Não | ☐ |  |
| REPL do `python` calculando | Em execução | Sim | ☐ |  |
| Build longo | Em execução | Sim | ☐ |  |
| `sleep 300` | Processo aberto | Não | ☐ |  |
| Processo parado por Ctrl Z | Processo parado | Não | ☐ |  |
| Shell no prompt | Pronto para comando | Não | ☐ |  |

## Capturas do modo de demonstração

`seedDemo` já mostra os estados novos. Abra com `?terminais=demo` e capture.

| Tela | Tema claro | Tema escuro |
| --- | --- | --- |
| Lista do computador | ☐ | ☐ |
| Lista do celular em 393 px | ☐ | ☐ |
| Cabeçalho do terminal no celular | ☐ | ☐ |
