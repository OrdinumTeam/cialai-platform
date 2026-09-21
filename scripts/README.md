# deploy-full

Uma entrega inteira do Cialai com um comando, do número da versão ao anúncio.
Existe para não precisar repetir a lista toda a cada release.

```sh
scripts/deploy-full.sh 0.2.7             # plano, não muda nada
scripts/deploy-full.sh 0.2.7 --aplicar   # executa
```

Sem `--aplicar` ele imprime tudo que faria, confere as travas e lista os
impedimentos. Nada sai para fora nesse modo.

## O que ele cobre

| Etapa | O que faz | Onde |
| --- | --- | --- |
| 1 `preparar` | Grava a versão nos nove arquivos que a carregam, refaz os lockfiles, exige a página da release e roda `npm test`, os checks de navegador, o orçamento de desempenho e os portões de release | Local, reversível |
| 2 `marcar` | Commita, envia a main e cria a tag `vX.Y.Z` | **Público.** A tag dispara o `release.yml` |
| 3 `desktop` | Acompanha o `release.yml` até a release sair do rascunho | macOS arm64 e Intel, Linux, Windows |
| 4 `android` | Dispara o `android-play` no Codemagic, anexa o APK à release com nome estável e refaz o `SHA256SUMS` | Codemagic e GitHub |
| 5 `ios` | Dispara o `ios-testflight` no Codemagic | TestFlight |
| 6 `site` | Atualiza o número da versão nas páginas, espelha os instaladores em `/downloads/` e publica o site | Repositório do site |
| 7 `anuncio` | Confere se o `release.yml` já anunciou no Discord e só reenvia quando faltou | Discord |
| 8 `conferir` | Lê o `latest.json` do espelho e confirma que o público recebe a versão nova | Verificação |

**O comando `curl` não tem etapa própria de propósito.** O `install.sh` do site
lê o `latest.json` de `/downloads/`, então a etapa `site` já atualiza o
instalador por `curl` ao refazer o espelho.

## Retomar do meio

Uma entrega leva dezenas de minutos e falhar no meio é normal. As etapas são
idempotentes: `marcar` não recria uma tag que existe, `android` não reanexa um
APK que já está lá.

```sh
scripts/deploy-full.sh 0.2.7 --aplicar --de site      # retoma da etapa 6
scripts/deploy-full.sh 0.2.7 --aplicar --ate marcar   # para depois da tag
scripts/deploy-full.sh 0.2.7 --aplicar --pular ios    # sem a etapa do iOS
```

## Antes de rodar

| Precisa | Como conferir |
| --- | --- |
| Na `main` e igual ao `origin/main` | O plano avisa. Árvore suja é normal: o commit de release carrega o trabalho da entrega, e o plano lista o que vai junto |
| `docs/releases/<versao>.md` com `Resumo` e `Destaques` | O plano avisa. É de onde sai o anúncio do Discord |
| `gh` autenticado | `gh auth status` |
| Codemagic e lojas | O script procura sozinho `ordinum-control/secrets/cialai/cialai.env` ao lado deste repositório e na home. Para outro caminho, aponte `CIALAI_RELEASE_ENV_FILE`. Os nomes das variáveis estão em `tools/release/.env.example`. O plano diz qual arquivo achou, nunca o conteúdo |
| AWS para o site | Perfil `aws-ordinum` |
| Repositório do site ao lado deste, ou `CIALAI_SITE_REPO` | O plano avisa |

## O que continua manual

Isto não é esquecimento: são passos que a API não faz sozinha.

- **App Store.** O build chega ao TestFlight. Liberar para testadores e enviar
  à revisão é no App Store Connect.
- **Google Play.** A API só chega ao rascunho. Escolher países e mandar à
  revisão é no console.
- **Assinatura do Windows.** Sem os segredos do Azure Trusted Signing os
  instaladores saem sem Authenticode.

## Onde cada peça mora

O `deploy-full` é um maestro: ele não reimplementa nada. As peças são
`tools/release/`, com o detalhe em `tools/release/README.md`, os workflows em
`.github/workflows/`, o `codemagic.yaml` para celular, e no repositório do site
o `scripts/mirror-release.sh` e o `scripts/deploy.sh`. A lista de versões
publicadas fica em `docs/releases/README.md`.

## Outros scripts desta pasta

| Arquivo | O que é |
| --- | --- |
| `cialai-command-macos.sh`, `-linux.sh`, `-windows.cmd` | Corpo do comando `cialai` no terminal, embutido no binário e gravado pelo app na primeira abertura |
| `claude-statusline.py` | Linha de estado do Claude Code que publica uso do plano, modelo, contexto e custo |
| `install-claude-statusline.*` | Instaladores dessa linha de estado, fora do app |
| `test-claude-statusline.py` | Teste da linha de estado |

O APK baixado do Codemagic fica em `.deploy-full/`, fora do Git.
