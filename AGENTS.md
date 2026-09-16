# Continuidade da execução

As notas de manutenção com histórico de execução, credenciais por referência e evidências do protótipo ficam fora do Git, em `_INTERNO_ORDINUM/`, que o `.gitignore` exclui. Leia primeiro o que houver ali, quando a pasta existir, e depois siga as tarefas e dependências de `docs/produto/11-roadmap-de-execucao.md`.

O protótipo interno Ordinum Control é fonte somente leitura. Preserve suas alterações sem commit. Não copie credenciais, estado de usuário ou conteúdo de projetos para este repositório.

Nunca adicione ao repositório segredos, certificados, chaves, arquivos `.env`, capturas do protótipo ou caminhos locais desta máquina. Antes de commitar, confira o `git status` contra o `.gitignore`.

Diferencie código preparado de comportamento verificado. Spikes em aparelhos, testes remotos, assinatura, revisão de lojas e soak só podem ser aprovados com evidência da execução correspondente.
