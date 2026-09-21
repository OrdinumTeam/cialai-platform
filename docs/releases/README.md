# Releases do Cialai

Uma página por versão publicada, com a ficha da entrega, o que mudou e como
atualizar. O registro técnico completo continua no `CHANGELOG.md` da raiz, e o
texto que vai ao corpo da release no GitHub continua em
`tools/release/notes/`, em inglês. Aqui o assunto é o que foi entregue em cada
data e onde cada arquivo está.

## Versões

| Versão | Data | Tag | Onde está |
| --- | --- | --- | --- |
| [0.2.7](0.2.7.md) | 21/09/2026 | `v0.2.7` | `OrdinumTeam/cialai-platform` |
| [0.2.6](0.2.6.md) | 19/09/2026 | `v0.2.6` | `OrdinumTeam/cialai-platform` |
| [0.2.5](0.2.5.md) | 19/09/2026 | `v0.2.5` | `OrdinumTeam/cialai-platform` |
| [0.2.4](0.2.4.md) | 18/09/2026 | Sem tag | Somente celular, pelo Codemagic |
| [0.2.3](0.2.3.md) | 17/09/2026 | `v0.2.3` | `OrdinumTeam/cialai-platform` |
| [0.2.2](0.2.2.md) | 16/09/2026 | `v0.2.2` | Tag criada, release não publicada |
| [0.2.1](0.2.1.md) | 15/09/2026 | `v0.2.1` | `OrdinumTeam/cialai-platform` |
| [0.2.0](0.2.0.md) | 15/09/2026 | `v0.2.0` | `Cialai/cialai`, repositório anterior |
| [0.1.1](0.1.1.md) | 14/09/2026 | `v0.1.1` | `Cialai/cialai`, repositório anterior |
| [0.1.0](0.1.0.md) | 14/09/2026 | `v0.1.0` | `Cialai/cialai`, repositório anterior |

## Onde cada arquivo mora

**Entrega inteira num comando.** Desde a 0.2.7, a sequência completa é o
`scripts/deploy-full.sh`, documentado em `scripts/README.md`. Ele orquestra o
que está descrito abaixo e não substitui nenhuma dessas peças.

**Release no GitHub.** O workflow `release.yml` monta os instaladores e publica
a release quando uma tag `v*` chega ao repositório. Os nomes são estáveis e não
levam a versão, para `releases/latest/download` continuar valendo.

**Espelho do site.** Quem baixa de `https://cialai.com.br/downloads/` recebe a
cópia espelhada por `scripts/mirror-release.sh`, no repositório do site. O
`latest.json` de lá aponta para o próprio site, e é ele que o `install.sh` lê.

**APK do Android.** Não faz parte da release do desktop. Ele sai do workflow
`android-play` no Codemagic e é anexado à release com nome estável antes do
espelho ser refeito.

**iOS.** Sai do workflow `ios-testflight` no Codemagic e vai direto ao
TestFlight. Não há arquivo para baixar.

## Anúncio no Discord

Toda release publicada é anunciada num canal do Discord. O texto vem desta
pasta: `tools/release/discord-notify.mjs` lê o `Resumo` e os `Destaques` da
página da versão e monta a mensagem. Por isso a página precisa existir antes da
tag, e o portão `check:discord-release` recusa uma versão sem página.

O envio automático é o último passo do `release.yml`, depois da publicação. Ele
não usa o evento `release`, porque uma release publicada com o `GITHUB_TOKEN`
não dispara outro workflow. Para reenviar à mão existe o workflow `Anúncio no
Discord`, que recebe a tag.

O endereço do webhook mora só no segredo `DISCORD_WEBHOOK` do repositório
público. O mesmo portão varre os arquivos versionados e recusa qualquer endereço
de webhook escrito em arquivo.

## Mudança de repositório

Até a 0.2.0 as releases saíram de `Cialai/cialai`. Em 15/09/2026 a organização
`Cialai` deixou de estar visível no GitHub, e desde a 0.2.1 as releases saem de
`OrdinumTeam/cialai-platform`. O atualizador embutido procura primeiro o
`latest.json` dessa release e depois o do espelho do site, então quem estava na
0.2.0 ou antes continua recebendo atualização.
