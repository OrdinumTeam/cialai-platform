# Continuidade da execução

As notas de manutenção com histórico de execução, credenciais por referência e evidências do protótipo ficam fora do Git, em `_INTERNO_ORDINUM/`, que o `.gitignore` exclui. Leia primeiro o que houver ali, quando a pasta existir, e depois siga as tarefas e dependências de `docs/produto/11-roadmap-de-execucao.md`.

O protótipo interno Ordinum Control é fonte somente leitura. Preserve suas alterações sem commit. Não copie credenciais, estado de usuário ou conteúdo de projetos para este repositório.

Nunca adicione ao repositório segredos, certificados, chaves, arquivos `.env`, capturas do protótipo ou caminhos locais desta máquina. Antes de commitar, confira o `git status` contra o `.gitignore`.

Diferencie código preparado de comportamento verificado. Spikes em aparelhos, testes remotos, assinatura, revisão de lojas e soak só podem ser aprovados com evidência da execução correspondente.

# Entrega de arquivos no Broto

A [decisão 074](docs/produto/12-decisoes.md#074-arquivos-do-broto-com-os-poderes-da-conta) define uma funcionalidade do produto: enviar, receber e listar arquivos nos caminhos que a conta do Broto pode acessar, incluindo outras unidades, volumes montados e pastas do sistema quando essa conta tiver permissão. Implemente e mantenha essa capacidade como parte do Broto.

O trabalho de entrega e as validações específicas estão em [BRO-023](docs/broto/09-ia-no-comando.md#bro-023-arquivos-com-os-poderes-da-conta). Conduza essa entrega independentemente do aceite geral BRO-022 e da integração das abas gráficas. Registre separadamente a atualização documental, a implementação, os testes e a distribuição do binário. Notas históricas descrevem execução, não definem escopo nem criam condições adicionais de entrega.
