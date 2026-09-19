# Release

## Chave do atualizador do desktop

O par de chaves do atualizador foi gerado em 14/09/2026 com `tauri signer generate` e senha forte. A chave pública está em `plugins.updater.pubkey` de `apps/desktop/src-tauri/tauri.conf.json` e `check-updater.mjs` confere que ela é uma chave pública minisign Ed25519 com identificador coerente, recusando a chave privada colada por engano. A chave privada e a senha nunca entram no repositório: ficam guardadas por quem mantém as releases e nos secrets `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` do repositório público.

Para cadastrar os secrets sem exibir valores, a partir dos arquivos locais:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Cialai/cialai < caminho/da/chave.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo Cialai/cialai < caminho/da/senha
```

Trocar o par exige migração dos clientes, porque apps instalados só aceitam atualizações assinadas pela chave compilada neles.

## Release do desktop

`.github/workflows/release.yml` roda ao receber uma tag `v*` ou por disparo manual com a tag.

| Etapa | O que faz |
| --- | --- |
| Guarda | Exige chave pública e secrets do atualizador e confere a tag com as versões de `tauri.conf.json`, `Cargo.toml` e `apps/desktop/package.json` por `release-channel.mjs`. Tags abaixo de `v1.0.0` ou com sufixo são prévias; tags estáveis também precisam de `check-release.mjs --release` |
| Sidecars | Testa o núcleo Go e compila os cinco alvos com `SHA256SUMS` |
| Rascunho | `release-assets.mjs draft` cria uma única release em rascunho com as notas de `notes/preview.md` ou `notes/stable.md` |
| Desktop | Matriz macOS arm64 e Intel em `macos-14`, Linux em `ubuntu-22.04` e Windows em `windows-2022`. `signing-mode.mjs` escolhe a assinatura e grava `tauri.release.conf.json`. No macOS e no Windows o `tauri-action@v1` envia os instaladores com nomes sem versão, como `Cialai_aarch64.dmg`, para que `/releases/latest/download` continue valendo. No Linux o CLI do Tauri compila, `fix-appimage.mjs` corrige o AppImage, `tauri signer sign` assina de novo o arquivo final, `verify-updater-signature.mjs` confere a assinatura contra a chave pública do `tauri.conf.json` e `release-assets.mjs upload-linux` envia AppImage, DEB e RPM com as assinaturas e os mesmos nomes estáveis |
| Publicação | `release-assets.mjs verify` confere instaladores e arquivos do atualizador, `checksums` grava `SHA256SUMS` e `publish` tira do rascunho e marca como mais recente |

Assinatura de plataforma:

| Sistema | Com credenciais | Sem credenciais |
| --- | --- | --- |
| macOS | Developer ID com os secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` e `APPLE_SIGNING_IDENTITY`, e notarização pela chave da API do App Store Connect com `APPLE_API_ISSUER`, `APPLE_API_KEY` e `APPLE_API_PRIVATE_KEY`. O workflow grava a chave em `$RUNNER_TEMP/private_keys` e passa só o caminho ao Tauri; `notarize-dmg.sh` notariza e grampeia depois o DMG | Assinatura ad hoc com `signingIdentity` igual a `-`, que abre no Apple Silicon depois da liberação em Privacidade e Segurança |
| Windows | Azure Trusted Signing com os secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` e `AZURE_TENANT_ID` e as variáveis `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT` e `WINDOWS_SIGNING_PROFILE` | Instaladores sem Authenticode; o SmartScreen pede Mais informações e Executar assim mesmo |
| Linux | Não se aplica | AppImage, DEB e RPM sem assinatura de pacote |

O APK Android vem do workflow `android-play` do Codemagic. Depois de publicado o desktop, anexe o APK com nome estável e refaça as somas:

```sh
gh release upload v0.1.0 Cialai_android_universal.apk --repo Cialai/cialai --clobber
GH_REPO=Cialai/cialai node tools/release/release-assets.mjs checksums v0.1.0
```

## Anúncio no Discord

`discord-notify.mjs` monta o anúncio a partir de `docs/releases/<versao>.md`,
com o `Resumo` e os `Destaques` da página, e envia ao webhook do canal.

| Comando | Ação |
| --- | --- |
| `node tools/release/discord-notify.mjs v0.2.5 --dry-run` | Imprime o payload sem enviar |
| `DISCORD_WEBHOOK=... node tools/release/discord-notify.mjs v0.2.5` | Envia |

O envio automático é o último passo do `release.yml`, depois da publicação, e o
workflow `discord-release.yml` reenvia à mão pela tag. O endereço do webhook
existe só como segredo `DISCORD_WEBHOOK` do repositório, cadastrado sem exibir
valor:

```sh
gh secret set DISCORD_WEBHOOK --repo OrdinumTeam/cialai-platform < caminho/do/arquivo
```

O portão `check:discord-release` exige que a versão do `package.json` tenha
página em `docs/releases`, que toda página tenha as duas seções e que nenhum
arquivo versionado carregue endereço de webhook.

## Builds móveis no Codemagic

Os workflows em `codemagic.yaml` não têm disparo automático. Os atalhos desta pasta usam a API do Codemagic somente quando as variáveis locais são fornecidas de forma explícita.

### Configuração local

Copie apenas os nomes de `tools/release/.env.example` para um arquivo ignorado pelo Git ou exporte as variáveis no shell. Para guardar esse arquivo fora do repositório, defina `CIALAI_RELEASE_ENV_FILE` com o caminho absoluto.

Nunca versione tokens, chaves da App Store, chaves de assinatura ou credenciais das lojas.

### Atalhos

| Comando | Ação |
| --- | --- |
| `cm-trigger.sh ios-testflight main` | Dispara o workflow escolhido |
| `cm-watch.sh BUILD_ID` | Acompanha o build a cada 15 segundos |
| `cm-log.sh BUILD_ID --download` | Mostra o resumo e baixa logs sem expor URLs assinadas |
| `cm-publish.sh ios-testflight main` | Dispara, acompanha e resume |
| `asc_api.py builds` | Consulta a App Store Connect |
| `play_api.py status` | Consulta as faixas no Google Play |
| `play_api.py upload APP.aab internal` | Valida um AAB e descarta o ensaio sem publicar |
| `ios-gen-signing-key.sh` | Gera localmente a chave RSA em `secrets` |
| `verify-android-signature.sh` | Confere que APK e AAB saíram assinados pela chave de upload |

Criar o app nas lojas e configurar integrações continuam sendo ações manuais do usuário.
