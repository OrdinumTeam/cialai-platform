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
| 2 `enviar` | Commita e envia a main | **Público**, mas ainda não dispara release |
| 3 `linux` | Constrói e abre o AppImage pelo `appimage-smoke`, antes da tag. Exige o AppImage abrindo em cada distro, que é o que o usuário baixa; relata a árvore extraída sem bloquear enquanto ela não tiver base verde | Portão |
| 4 `marcar` | Cria e envia a tag `vX.Y.Z` | A tag dispara o `release.yml` |
| 5 `desktop` | Acompanha o `release.yml` até a release sair do rascunho | macOS arm64 e Intel, Linux, Windows |
| 6 `android` | Dispara o `android-play` no Codemagic, anexa o APK à release com nome estável e refaz o `SHA256SUMS` | Codemagic e GitHub |
| 7 `ios` | Dispara o `ios-testflight` no Codemagic | TestFlight |
| 8 `site` | Atualiza o número da versão nas páginas, espelha os instaladores em `/downloads/` e publica o site. Árvore suja do site também não bloqueia, e o plano lista o que vai junto | Repositório do site |
| 9 `anuncio` | Confere se o `release.yml` já anunciou no Discord e só reenvia quando faltou | Discord |
| 10 `conferir` | Lê o `latest.json` do espelho e confirma que o público recebe a versão nova | Verificação |

**Por que o Linux tem portão próprio.** O empacotamento do Linux é o que mais
quebra, e quebra por coisa de fora: o `linuxdeploy` muda o layout do AppDir e o
`fix-appimage.mjs` para. Isso não aparece no `npm test`, porque nada ali monta
um AppImage. Na 0.2.7 a falha só apareceu com a tag já criada e a release pela
metade. Agora o AppImage é construído e aberto antes da tag.

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
| Codemagic e lojas | O script carrega sozinho **os dois** arquivos de `ordinum-control/secrets`: `ordinum/ordinum.env`, com o token do Codemagic, a chave da App Store Connect e a conta do Google Play, e `cialai/cialai.env`, com o que é deste app. Carregar só o segundo deixa o Codemagic sem token, e foi o que travou Android e iOS na primeira tentativa da 0.2.7. Para outra pasta, aponte `CIALAI_SECRETS_DIR`. O plano diz qual pasta achou, nunca o conteúdo |
| Caminhos de chave | Os `*_PATH` dos arquivos são relativos e resolvem contra a raiz de um repositório, onde as chaves não estão. O script os converte para absolutos dentro da pasta de segredos |
| AWS para o site | Perfil `aws-ordinum` |
| Repositório do site ao lado deste, ou `CIALAI_SITE_REPO` | O plano avisa. O `deploy.sh` de lá publica a árvore de trabalho, então o que está sem commit já costuma estar no ar; parar a entrega por isso deixaria a release publicada e o site na versão anterior |

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
