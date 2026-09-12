# CI, CD e distribuição

Desktop, núcleo do túnel e interface passam pelo GitHub Actions, gratuito para repositório público e com `tauri-action`. Os celulares passam pelo Codemagic, o padrão da Ordinum para as lojas, copiando os workflows do Control e do Advoris. Nenhum valor de credencial aparece aqui; a seção de credenciais diz onde cada valor vive.

Estado da execução em 12/09/2026: existem somente `ci.yml` para a fundação e `spike-headscale.yml` para o experimento da Fase 0. Ambos estão preparados localmente, sem execução remota. Go foi corrigido para 1.26.5 pela decisão 022 e Rust está fixado em 1.98.1. Os workflows de produto, release, Codemagic e lojas descritos abaixo continuam planejados.

## GitHub Actions

| Workflow | Gatilho | Passos |
| --- | --- | --- |
| `ci.yml` | push e PR | Matriz `ubuntu-22.04`, `windows-2022`, `macos-14`; `actions/setup-node` 22, `dtolnay/rust-toolchain` 1.98.1, `actions/setup-go` 1.26.5; no Linux `apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev zsh`; `npm ci`; `npm run test:ui`; `npx playwright install --with-deps chromium` e `webkit` no macOS e no Linux; `npm run test:browser`; `go test ./...`; `go build` do sidecar para o triplo local; `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` sem display, porque os testes abrem o próprio PTY ou ConPTY; `npm run check:text`; `tauri build` sem assinatura com artefatos anexados ao run |
| `release.yml` | tag `v*` | Compila o sidecar para os cinco triplos com `CGO_ENABLED=0 -trimpath -ldflags="-s -w"`; matriz `macos-14`, `macos-13`, `ubuntu-22.04`, `windows-2022`; `tauri-apps/tauri-action` gerando dmg, nsis, msi, AppImage, deb e rpm; assinatura Developer ID e notarização por `notarytool` no macOS; Authenticode por Azure Trusted Signing no Windows; assinatura do updater; release no GitHub com `latest.json`, SHA-256 e notas do `CHANGELOG.md` |
| `headscale-integration.yml` | push em `packages/tunnel-core` e diário | `ubuntu-22.04` com Docker; `go test -tags integration ./integration` contra `headscale/headscale:0.29.3` |
| `nightly-e2e.yml` | diário | `selftest-app.js` por `tauri-driver` sob `xvfb-run` no Linux e com `msedgedriver` no Windows; capturas da demo por Playwright anexadas |
| `mobile-artifacts.yml` | tag `v*` e manual | `gomobile bind` para iOS no `macos-14` e Android no `ubuntu-22.04`; publica `Tunnelcore.xcframework.zip` e `tunnelcore.aar` com SHA-256 como artefatos da release, consumidos pelo Codemagic |

Segredos do GitHub, nomes: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Builds de PR nunca recebem segredos.

## Codemagic

Três workflows em `codemagic.yaml`, no padrão de `$CONTROL/codemagic.yaml` e `$ADVORIS/codemagic.yaml`: instância `mac_mini_m2`, 60 minutos, `node 22`, `xcode latest`, `cocoapods default`, sem bloco `triggering`, disparo pelos scripts ou pelo painel.

| Workflow | Passos | Publicação |
| --- | --- | --- |
| `ios-testflight` | Validar `APP_STORE_APP_ID` e `CERTIFICATE_PRIVATE_KEY`; baixar o xcframework da release pelo SHA-256 ou compilar com Go e `gomobile` no próprio runner; `npm ci`, `typecheck`, `lint`, `jest --runInBand`, `swift tools/release/check-app-icon.swift apps/mobile/assets/icon.png`, `bash tools/release/cm-build-number.test.sh`, `bash tools/release/cm-download.test.sh`, `node --test tools/release/cm-config.test.cjs`; `npx expo prebuild --platform ios --no-install` e `pod install`; número de build por `cm-next-build-number.sh` com `agvtool`; assinatura por `keychain initialize`, chave RSA decodificada de `CERTIFICATE_PRIVATE_KEY` em arquivo temporário, `app-store-connect fetch-signing-files br.com.ordinum.cialai --type IOS_APP_STORE --certificate-key=@file:… --create`, `keychain add-certificates`, `xcode-project use-profiles`; `xcode-project build-ipa --workspace apps/mobile/ios/Cialai.xcworkspace --scheme Cialai` | `app_store_connect` com `auth: integration`, `submit_to_testflight: false`, `submit_to_app_store: false`; o grupo interno recebe todo build sem Beta App Review |
| `ios-archive` | Igual, com `PROJECT_BUILD_NUMBER` | Nenhuma; só o IPA como artefato |
| `android-play` | Mesma instância; AAR da release ou compilado no runner com Go, `gomobile` e NDK; `npm ci` e testes; `npx expo prebuild --platform android --no-install`; keystore decodificado de `CM_KEYSTORE_BASE64` para `secrets/upload-keystore.jks` do build e `android/key.properties` gravado com `CM_KEYSTORE_PASSWORD`, `CM_KEY_PASSWORD` e `CM_KEY_ALIAS`; `./gradlew bundleRelease` | Bloco `google_play` com `credentials: $GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` e `track: internal`, ou `tools/release/play_api.py upload <aab> internal --commit` |

Integração no Codemagic: chave do App Store Connect registrada em Settings, Integrations, Developer Portal com o nome exato `Cialai ASC API Key`, referenciado em `integrations.app_store_connect`. Grupos de variáveis: `appstore_credentials` com `CERTIFICATE_PRIVATE_KEY` em base64 marcada como secreta; `android_credentials` com `CM_KEYSTORE_BASE64`, `CM_KEYSTORE_PASSWORD`, `CM_KEY_PASSWORD` e `CM_KEY_ALIAS` injetadas pela API; `google_play` com `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`. Variáveis simples: `APP_STORE_APP_ID`, `BUNDLE_ID`, `APP_ENV`. Contas pessoais não podem usar variáveis globais, então tudo fica por app.

Scripts em `tools/release`, copiados do Control e do Advoris: `_lib.sh` lendo `CODEMAGIC_API_TOKEN` e `CODEMAGIC_APP_ID` do ambiente ou de um `.env` local fora da árvore pública, com `cm_download` que só manda o token para `api.codemagic.io` sem porta e reclassifica a URL após redirecionamento; `cm-trigger.sh`, `cm-watch.sh` a cada 15 s, `cm-log.sh` com `--download`, `cm-publish.sh`, `cm-next-build-number.sh` que aborta em saída não numérica; `_stores.py` com JWT ES256 para o App Store Connect e RS256 com OAuth2 para o Play, usando só `cryptography` e `curl --http1.1 --retry 3`; `asc_api.py` com `builds`, `versions`, `testflight`; `play_api.py` com `status` e `upload` em modo de ensaio sem `--commit`; `ios-gen-signing-key.sh` gerando a chave RSA de assinatura com `ssh-keygen -m PEM`. Os três scripts de loja são idênticos aos do Advoris e do CowSynch e precisam ser espelhados quando mudarem.

## Identificadores

| Item | Valor |
| --- | --- |
| Empresa | ORDINUM INOVACAO E TECNOLOGIA LTDA |
| Team ID da Apple | `F3A8C9VTYD` |
| Bundle e `applicationId` | `br.com.ordinum.cialai`; testes `br.com.ordinum.cialai.RunnerTests` |
| Identificador do desktop | `br.com.ordinum.cialai` no `tauri.conf.json` |
| Esquema de URL | `cialai`, reservado para deep links futuros |
| App no App Store Connect | A criar com o bundle acima; o número resultante vira `APP_STORE_APP_ID` |
| App no Codemagic | A criar apontando para `OrdinumTeam/cialai-platform`; o id vai em `CODEMAGIC_APP_ID` |
| App no Google Play | A criar na conta Ordinum, id `7730543760992383205`, com verificação de desenvolvedor já feita |
| Projeto no Google Cloud para a conta de serviço do Play | `cialai-platform`, conta `cialai-play-publisher@cialai-platform.iam.gserviceaccount.com`, com `androidpublisher.googleapis.com` ligado e só os papéis de ver informações, publicar em produção e em faixas de teste |
| Nome de exibição | Cialai |
| Referências existentes | Control: app `6809897505` e Codemagic `6aa03dae642175d18c41fe72`; Advoris: app `6783436909`, Codemagic `6a3acb9e11b238d7837dbe12`, Play `4971975462970394779` |

## Credenciais por referência

| Credencial | Onde vive | Quem usa | Rotação |
| --- | --- | --- | --- |
| Chave da API do App Store Connect, `.p8`, papel Admin ou App Manager | Integração do Codemagic e `secrets/` local fora da árvore pública | `ios-testflight`, `asc_api.py` | Anual; trocar a integração e o arquivo local |
| Chave RSA de assinatura, `codemagic_cert_key.pem` | `secrets/` local e `CERTIFICATE_PRIVATE_KEY` em base64 no Codemagic | `fetch-signing-files` | Só com novo certificado de distribuição |
| Certificado Developer ID e credenciais do `notarytool` | GitHub Secrets | `release.yml` | Cinco anos; senha de app do Apple ID |
| Conta do Azure Trusted Signing | GitHub Secrets | `release.yml` | Conforme o Azure |
| Par de chaves do updater do Tauri | GitHub Secrets e cópia offline | `release.yml` | Nunca sem migração dos clientes |
| Keystore de upload do Android, `upload-keystore.jks` | `secrets/` local e grupo `android_credentials` | `android-play` | Não gira sozinho; Play App Signing guarda a chave de assinatura |
| Conta de serviço do Play, `google-play-service-account.json` | `secrets/` local e grupo `google_play` | `play_api.py`, publicação | Anual |
| Token da API do Codemagic | `.env` local fora da árvore | `cm-*.sh` | Anual |
| Chave da API do Headscale de cada pessoa | Keychain do desktop de quem instala | Sidecar | Rotação automática 14 dias antes de expirar |

O repositório privado `ordinum-credentials` guarda referências, donos e procedimentos, nunca valores. No monorepo público existe só `tools/release/.env.example` com os nomes `CODEMAGIC_API_TOKEN`, `CODEMAGIC_APP_ID`, `CODEMAGIC_ASC_INTEGRATION_NAME`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `APP_STORE_APP_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_PRIVATE_KEY_PATH`, `GOOGLE_PLAY_ACCOUNT_ID`, `ANDROID_PACKAGE` e `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH`, com os caminhos apontando para fora do repositório. Auditoria antes de cada commit: `for f in secrets/*; do git check-ignore -q "$f" && echo "ok $f" || echo "EXPOSTO $f"; done`.

## Lojas

| Etapa | Regras |
| --- | --- |
| TestFlight interno | Grupo Ordinum Team recebe todo build sem revisão; builds expiram em 90 dias; até 100 testadores; Apple processa em 5 a 15 minutos |
| TestFlight externo | Exige informações de teste e conta de demonstração; Beta App Review de cerca de um dia; usado como ensaio do App Review antes da submissão, spike 6 |
| App Store | Submissão manual pela primeira vez; notas de revisão com um desktop de demonstração acessível e um vídeo do pareamento; nunca a palavra VPN; conformidade de exportação com algoritmos padrão e isenção de mercado de massa; questionário de privacidade sem coleta; política de privacidade publicada |
| Play interno | Faixa `internal` por `play_api.py upload` ou pelo bloco `google_play`; relatório de pré-lançamento conferido pelo aviso de texto claro |
| Play produção | Data safety sem coleta; `targetSdk` 36; ícone adaptativo; capturas por tamanho |
| Textos | Bloco curto em português para os 500 caracteres do Play e versão longa para a App Store, em inglês e português, no padrão dos `release-notes-*.md` do Advoris |
| Versões | Desktop pela tag `v<semver>`; celular com versão de marketing `X.Y.Z` e número de build monotônico do `cm-next-build-number.sh` no iOS e do `versionCode` no Android |

## Lista de verificação de release

1. `CHANGELOG.md` atualizado e docs desta pasta revisados para o que existe.
2. `npm test` verde nos três sistemas e `headscale-integration.yml` verde.
3. Tag `v<semver>` empurrada; `release.yml` publica os seis instaladores assinados, os cinco sidecars, `latest.json` e os artefatos móveis.
4. Instalação limpa em cada sistema até um celular pareado, pelos roteiros manuais do documento 06.
5. `cm-publish.sh` para `ios-testflight`; instalação pelo grupo interno; `play_api.py upload` na faixa interna.
6. Submissões às lojas com os textos e as respostas de conformidade; registro das datas e dos números de build em `docs/12-decisoes.md`.
