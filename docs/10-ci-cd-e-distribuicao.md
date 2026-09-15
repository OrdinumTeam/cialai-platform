# CI, CD e distribuição

A distribuição foi desenhada com GitHub Actions para desktop, núcleo do túnel e interface, e Codemagic para os celulares. Nenhum valor de credencial aparece aqui; a seção de credenciais registra somente nomes, destinos e responsabilidades.

## Repositórios

| Repositório | Visibilidade | Uso |
| --- | --- | --- |
| `OrdinumTeam/cialai-platform` | Privado | Desenvolvimento, histórico completo, CI e Codemagic enquanto o projeto não for aberto |
| Organização `Cialai`, em https://github.com/Cialai | Pública | Destino do projeto open source quando todo o trabalho estiver concluído: código, releases dos binários de macOS, Linux e Windows, issues e contribuições. Nome do repositório a definir |

Em 13/09/2026 o repositório público `Cialai/cialai` foi criado com histórico limpo, em um único commit gerado por `tools/release/public-export/export_public.py` e auditado por `audit_public.py` na mesma pasta. A cópia exclui o diário de execução, o mapa de credenciais, `AGENTS.md`, a guarda de proveniência do Control, as capturas do Control e a própria pasta de exportação, e troca caminhos locais e referências internas. A suíte completa passou na cópia antes do push. Novas sincronizações repetem os dois scripts e publicam por cima do repositório público.

Checklist original da exportação:

1. Decidir se o público recebe o histórico completo ou um ponto de partida limpo. O histórico e os documentos internos citam caminhos locais, o Ordinum Control e o diário de execução.
2. Revisar `docs/13-progresso-e-handoff.md`, as variáveis de caminho de `docs/README.md` e qualquer referência interna que não deva ficar pública.
3. Feito em 13/09/2026: o módulo Go, os imports, o endpoint do updater, o podspec e os links dos documentos já usam `github.com/Cialai/cialai`.
4. Publicar a primeira release pelo repositório público `Cialai/cialai`. Apps instalados só procuram atualização na URL compilada neles.
5. Definir onde ficam o app do Codemagic e os secrets de assinatura. Workflows disparados por PR de fork nunca recebem secrets.
6. Confirmar o contato de segurança de `SECURITY.md` e o `CODE_OF_CONDUCT.md` antes de abrir.

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| `ci.yml` | Implementado | Matriz Ubuntu 22.04, Windows 2022 e macOS 14 com sidecar local, `npm test`, bundle sem assinatura e artefatos por sistema; no Ubuntu também `check:text` e checks de navegador por Playwright. Verde nos três sistemas nos runs `34813846975` e `34815427824` de 14/09/2026, depois das correções de CRLF, chave do updater no bundle, npm no Windows, caminhos dos checks, suíte Rust nativa do Windows, bit de execução, tipos do site móvel e caminhos dos testes Go. O commit da prévia `13d205a` também ficou verde. No privado os workflows estão desligados desde 14/09/2026 às 04:40 para conter minutos; a CI do público continua ativa |
| `appimage-smoke.yml` | Preparado | O run `34948496705` de 15/09/2026, na branch temporária `ci/appimage` do público, abriu com os mesmos scripts a prévia 0.2.0 publicada antes e depois de `fix-appimage.mjs`. Sem a correção o Arch abortou com `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`, `mesa-conflicts.sh` achou nove dependências do Mesa no bundle e o Ubuntu 24.04 mostrou `undefined symbol: g_task_set_static_name` no GVfs; corrigido, os dois abriram a interface com os processos do WebKit vivos e zero conflitos. O workflow completo, com o AppImage gerado do código e a assinatura descartável, ainda não terminou no GitHub: o run `34949534433` foi cancelado pela plataforma durante o build, sem relação com o código |
| `spike-headscale.yml` | Preparado | Contrato existe e o spike passou localmente; execução no GitHub não foi observada |
| `headscale-integration.yml` | Histórico | Verde no push dos dois repositórios em 14/09/2026, por último no público em `e0c0ce3`, run `34812765185`. Desde 15/09/2026 o sidecar v2 não tem o modo Headscale no RPC, o teste não compila e o fluxo ficou só com disparo manual até a remoção em CON-070 |
| `release.yml` | Implementado | Guarda com canal de prévia, cinco sidecars, rascunho único, matriz macOS arm64 e Intel, Linux e Windows, assinatura de plataforma opcional, nomes estáveis, `SHA256SUMS` e publicação. Sem Developer ID o macOS sai com assinatura ad hoc e sem Azure Trusted Signing o Windows sai sem Authenticode |
| `nightly-e2e.yml` | Preparado | Desligado com `gh workflow disable` em 14/09/2026 às 04:40, nos dois repositórios, para conter o consumo de minutos; religar só com outra abordagem para o autoteste do Windows. Rodou no público em 14/09/2026 e o Ubuntu 22.04 passou 8 de 8 em todas as rodadas. No Windows 2022 as capturas mostraram a janela em 1024 por 728, o explorador aberto e o PowerShell respondendo, mas a página do WebView2 sem GPU ficou lenta e deixou de responder ao WebDriver antes do fim do roteiro |
| `mobile-artifacts.yml` | Implementado | Disparo manual com tag opcional. O run `34811514866` de 14/09/2026 compilou no `macos-14` o `Tunnelcore.xcframework.zip` de 46,6 MB e o `tunnelcore.aar` de 29,9 MB com `arm64-v8a` e `x86_64`, com hashes conferidos, em 7 min 28 s e sem tag. O anexo a uma release ainda não foi executado |
| `ios-testflight`, `ios-archive` e `android-play` | Implementado | Em 14/09/2026 o `ios-testflight` enviou a 0.1.0 build 1 ao TestFlight interno depois de quatro tentativas e o `android-play` gerou AAB e APK e enviou o AAB como rascunho na faixa interna na primeira tentativa. O `ios-archive` não foi disparado |
| Scripts em `tools/release` | Implementado | Contratos locais, modo de ensaio e guardas estão versionados e testados sem credenciais reais |
| Atualizador do desktop | Implementado | Par gerado em 14/09/2026; chave pública em `tauri.conf.json`, validada por `check-updater.mjs`, e chave privada com senha apenas fora do repositório e nos secrets do repositório público |
| Identificadores públicos | Preparado | Bundle, Team ID e nomes estão documentados; os registros dos apps e ids resultantes dependem do usuário |
| Credenciais | Pendente | Somente nomes e locais esperados estão versionados; nenhum valor foi criado ou copiado para o repositório |
| Materiais das lojas | Preparado | Políticas, respostas, textos, capturas planejadas e notas de revisão existem; URLs publicadas e formulários estão pendentes |
| Release `v1.0.0` | Preparado | `CHANGELOG.md`, procedimento e guarda existem com seis gates pendentes. A prévia `v0.1.0` foi publicada em 14/09/2026 em `Cialai/cialai`, sem assinatura de plataforma |

Go está fixado em 1.26.5 pela decisão 022 e Rust em 1.98.1. As tabelas seguintes descrevem o contrato completo. O estado acima prevalece quando um workflow ou serviço ainda não foi executado.

## GitHub Actions

| Workflow | Gatilho | Passos |
| --- | --- | --- |
| `ci.yml` | push, PR e manual | Matriz `ubuntu-22.04`, `windows-2022` e `macos-14`; Node, npm, Rust 1.98.1 e Go pelo `go.mod`; no Linux instala WebKitGTK 4.1, GTK, AppIndicator, SVG, `patchelf`, XDo, OpenSSL e zsh; `npm ci`; cache do arquivo do Tor Expert Bundle por sistema; build do sidecar local, que também prepara `resources/tor`; `npm test`; `tauri build` sem assinatura e com `tauri.ci.conf.json`, que desliga os artefatos do updater porque a CI não recebe a chave privada; no Linux, `fix-appimage.mjs` corrige o AppImage antes do anexo; dmg, AppImage, deb, rpm, nsis e msi anexados ao run. `CARGO_BUILD_JOBS=2` limita Rust. No Ubuntu roda também `npm run check:text`, que confere o texto visível dos três idiomas, das lojas, das políticas e das notas de release, e `npm run test:browser`, que sobe o Vite e executa por Playwright 1.63.0 os roteiros do estúdio, da rede e do celular em Chromium headless. O workflow não substitui os testes físicos |
| `release.yml` | tag `v*` e manual com a tag | Exige a chave pública e os secrets do updater e confere a tag com as versões do desktop; prévias abaixo de `v1.0.0` dispensam os gates da versão 1 e tags estáveis exigem `check-release.mjs --release`; testa e compila cinco sidecars; cria um único rascunho com as notas de `tools/release/notes`; a matriz `macos-14` arm64 e Intel, `ubuntu-22.04` e `windows-2022` prepara e confere o Tor Expert Bundle do alvo em `resources/tor` com `fetch-tor.mjs`, roda `signing-mode.mjs`, assina com Developer ID os Mach-O aninhados do Tor quando há certificado e, no macOS e no Windows, roda `tauri-action@v1` com nomes sem versão. No Linux compila pelo CLI do Tauri, corrige o AppImage com `fix-appimage.mjs`, apaga a assinatura do atualizador gerada no build, assina de novo o arquivo final com `tauri signer sign`, confere com `verify-updater-signature.mjs` contra a chave pública do `tauri.conf.json` e só então envia AppImage, deb e rpm com as assinaturas por `release-assets.mjs upload-linux`, com os mesmos nomes estáveis; o último job monta o `latest.json` a partir dessas assinaturas, confere os arquivos, grava `SHA256SUMS` e publica como release mais recente. Sidecars brutos e artefatos móveis ainda não entram no workflow; o APK do Codemagic é anexado depois |
| `appimage-smoke.yml` | PR que toque o empacotamento e manual; PR só no público | `ubuntu-22.04` gera o AppImage com `tauri.ci.conf.json` e só o alvo AppImage, roda `fix-appimage.mjs`, assina com uma chave descartável e confere com `verify-updater-signature.mjs`. Depois, `ubuntu-24.04` com Mesa, WebKitGTK 4.1 e GVfs do sistema e um contêiner `archlinux:latest` com `mesa`, `webkit2gtk-4.1` e `gvfs` abrem o AppImage por 20 s sob Xvfb com `tools/release/appimage/smoke.sh`, pelo arquivo e pela árvore extraída, sempre fora de `$APPDIR/usr`. O smoke falha com biblioteca não resolvida sem `LD_LIBRARY_PATH`, auxiliar do WebKit ligado à `libwebkit2gtk` do sistema, app encerrado antes do prazo, `WebKitWebProcess` ou `WebKitNetworkProcess` do bundle ausente, variável vazada pelo AppRun, janela ausente, `Aborting`, `undefined symbol`, módulo GIO que não carrega ou coredump. No Arch, `mesa-conflicts.sh` falha se alguma dependência do Mesa do sistema estiver no bundle. Logs e capturas vão para o artefato. Não consome secrets |
| `headscale-integration.yml` | só manual, histórico | `ubuntu-22.04` com Docker; vet e integração contra `headscale/headscale:0.29.3`; não compila desde o sidecar v2 e sai em CON-070 |
| `spike-headscale.yml` | PR no túnel e manual | Executa o spike de política e expiração com Headscale 0.29.3 no Linux |
| `nightly-e2e.yml` | Diário às 05:17 UTC só no público e manual | Matriz `ubuntu-22.04` e `windows-2022`; instala dependências, `tauri-driver` 2.0.6 e, no Windows, o Edge WebDriver da versão do WebView2; compila sidecar e app de depuração sem bundle; roda `tools/selftest/driver.mjs`, sob Xvfb no Linux, e anexa `selftest.json` com a duração de cada etapa e os diagnósticos de cursor, renderizador e fila de eventos, `app.log`, capturas e o log do driver mesmo em falha; quando o roteiro não termina, grava o andamento em `selftest-progress.json` se a página responder. Não consome secrets |
| `mobile-artifacts.yml` | manual, com tag opcional | `macos-14`; Go pelo `go.mod` e NDK `28.2.13676358`, o mesmo do Codemagic; `tools/build-tunnel-mobile.sh all`; confere os hashes, que levam só o nome do arquivo; guarda `cialai-mobile-bindings` como artefato e, com a tag de uma release existente, anexa os quatro arquivos e refaz o `SHA256SUMS` com `release-assets.mjs checksums`. Com `ios_app`, o job `ios-app` no `macos-15` com o Xcode mais novo coloca o XCFramework no módulo nativo, roda `expo prebuild` e `pod install` e compila o app para o simulador com `CODE_SIGNING_ALLOWED=NO`, sem secrets |

O workflow exige `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Developer ID e notarização entram quando existirem os secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY` e `APPLE_API_PRIVATE_KEY`. A notarização usa a Team Key `GitHub Actions Notarization` do App Store Connect, com papel Developer, gravada em `$RUNNER_TEMP/private_keys`, sem Apple ID nem senha de app. Depois do build, `tools/release/notarize-dmg.sh` notariza e grampeia também o DMG, que o Tauri cria depois de notarizar o `.app` e deixava só assinado, e substitui `Cialai_aarch64.dmg` e `Cialai_x64.dmg` no rascunho; em 15/09/2026 o teste sobre o DMG da 0.2.0 foi aceito em 32 s e o `spctl` passou a responder `source=Notarized Developer ID` para o próprio DMG. Azure Trusted Signing entra com os secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` e `AZURE_TENANT_ID` e as variáveis `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT` e `WINDOWS_SIGNING_PROFILE`. O passo sem Developer ID não recebe nenhuma credencial Apple. Builds de PR nunca recebem secrets.

## Codemagic

Três workflows em `codemagic.yaml`, no padrão de `$CONTROL/codemagic.yaml` e `$ADVORIS/codemagic.yaml`: instância `mac_mini_m2`, 60 minutos, `node 22`, `xcode 26.6` nos dois workflows iOS, fixado no Xcode que gerou o build 2 da 0.2.0, e `latest` no Android, `cocoapods default`, sem bloco `triggering`, disparo pelos scripts ou pelo painel.

| Workflow | Passos | Publicação |
| --- | --- | --- |
| `ios-testflight` | Valida ambiente, instala Go, compila e confere o XCFramework, executa os testes móveis, gera o projeto, busca perfis, numera e compila o IPA | `app_store_connect` usa a integração, mas `submit_to_testflight` e `submit_to_app_store` estão falsos. O IPA permanece artefato até o usuário mudar e executar a política de publicação |
| `ios-archive` | Igual, com `PROJECT_BUILD_NUMBER` | Nenhuma; só o IPA como artefato |
| `android-play` | Valida ambiente, instala Go, compila e confere o AAR, executa os testes móveis, gera o projeto, grava credenciais temporárias, compila o AAB e o APK universal com `:app:bundleRelease :app:assembleRelease`, confere com `verify-android-signature.sh` que os dois saíram assinados pela chave de upload e guarda o APK como `build/android/cialai-android-<versão>-<build>-universal.apk` com o `.sha256` | O bloco `google_play` envia o AAB como rascunho na faixa interna. O APK fica só como artefato para distribuição direta e para a release do GitHub |

Integração no Codemagic: chave do App Store Connect da conta Ordinum já registrada como `Advoris ASC API Key` e referenciada em `integrations.app_store_connect`. Grupos de variáveis: `appstore_credentials` com `CERTIFICATE_PRIVATE_KEY` em base64 marcada como secreta; `android_credentials` com `CM_KEYSTORE_BASE64`, `CM_KEYSTORE_PASSWORD`, `CM_KEY_PASSWORD` e `CM_KEY_ALIAS` injetadas pela API; `google_play` com `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`. Variáveis simples: `APP_STORE_APP_ID`, `BUNDLE_ID`, `APP_ENV`. Contas pessoais não podem usar variáveis globais, então tudo fica por app.

Scripts em `tools/release`, copiados do Control e do Advoris: `_lib.sh` lendo `CODEMAGIC_API_TOKEN` e `CODEMAGIC_APP_ID` do ambiente ou de um `.env` local fora da árvore pública, com `cm_download` que só manda o token para `api.codemagic.io` sem porta e reclassifica a URL após redirecionamento; `cm-trigger.sh`, `cm-watch.sh` a cada 15 s, `cm-log.sh` com `--download`, `cm-publish.sh`, `cm-next-build-number.sh` que aborta em saída não numérica; `_stores.py` com JWT ES256 para o App Store Connect e RS256 com OAuth2 para o Play, usando só `cryptography` e `curl --http1.1 --retry 3`; `asc_api.py` com `builds`, `versions`, `testflight`; `play_api.py` com `status` e `upload` em modo de ensaio sem `--commit`; `ios-gen-signing-key.sh` gerando a chave RSA de assinatura com `ssh-keygen -m PEM`. Os três scripts de loja são idênticos aos do Advoris e do CowSynch e precisam ser espelhados quando mudarem.

## Identificadores

| Item | Valor |
| --- | --- |
| Empresa | ORDINUM INOVACAO E TECNOLOGIA LTDA |
| Team ID da Apple | `F3A8C9VTYD` |
| Bundle e `applicationId` | `br.com.ordinum.cialai`; testes `br.com.ordinum.cialai.RunnerTests` |
| Identificador do desktop | `br.com.ordinum.cialai` no `tauri.conf.json` |
| Esquema de URL | `cialai`, reservado para deep links futuros |
| App no App Store Connect | Criado em 13/09/2026, `APP_STORE_APP_ID` igual a `6811702125` |
| App no Codemagic | `6aa75e1e235d9cae411b55df`, nome `cialai-platform`, criado pelo painel com a integração GitHub para `OrdinumTeam/cialai-platform`. Os grupos `appstore_credentials`, `android_credentials` e `google_play` foram cadastrados pela API em 14/09/2026 e o ID está em `CODEMAGIC_APP_ID` do `cialai.env`. O app `6aa75ddaa551baf04258c20c` aponta para o público `Cialai/cialai` e não é usado pelos builds |
| App no Google Play | Criado em 13/09/2026 na conta `7730543760992383205`, Play App ID `4975087090602407034` |
| Conta de serviço do Play | `ordinum-play-publisher@ordinum.iam.gserviceaccount.com`, do projeto `ordinum`, compartilhada pelos apps da Ordinum e validada pela API em 13/09/2026 |
| Nome de exibição | Cialai |
| Referências existentes | Control: app `6809897505` e Codemagic `6aa03dae642175d18c41fe72`; Advoris: app `6783436909`, Codemagic `6a3acb9e11b238d7837dbe12`, Play `4971975462970394779` |

## Credenciais por referência

| Credencial | Onde vive | Quem usa | Rotação |
| --- | --- | --- | --- |
| Chave da API do App Store Connect, `.p8`, papel Admin ou App Manager | Integração do Codemagic e `secrets/` local fora da árvore pública | `ios-testflight`, `asc_api.py` | Anual; trocar a integração e o arquivo local |
| Chave RSA de assinatura, `codemagic_cert_key.pem` | `secrets/` local e `CERTIFICATE_PRIVATE_KEY` em base64 no Codemagic | `fetch-signing-files` | Só com novo certificado de distribuição |
| Certificado Developer ID e credenciais do `notarytool` | GitHub Secrets | `release.yml` | Certificado de cinco anos, até 15/09/2031; notarização pela chave da API do App Store Connect |
| Conta do Azure Trusted Signing | GitHub Secrets | `release.yml` | Conforme o Azure |
| Par de chaves do updater do Tauri | GitHub Secrets e cópia offline | `release.yml` | Nunca sem migração dos clientes |
| Keystore de upload do Android, `upload-keystore.jks` | `secrets/` local e grupo `android_credentials` | `android-play` | Não gira sozinho; Play App Signing guarda a chave de assinatura |
| Conta de serviço do Play, `google-play-service-account.json` | `secrets/` local e grupo `google_play` | `play_api.py`, publicação | Anual |
| Token da API do Codemagic | `.env` local fora da árvore | `cm-*.sh` | Anual |
| Chave da API do Headscale gravada pelas prévias 0.1.x | Keychain do desktop de quem instalou essas prévias, se ainda existir | Ninguém desde a prévia 0.2.0; a conectividade automática não usa chave de servidor | Não gira mais; apagar nos diagnósticos avançados da tela Dispositivos |

O repositório privado `ordinum-credentials` guarda referências, donos e procedimentos, nunca valores. No monorepo público existe só `tools/release/.env.example` com os nomes `CODEMAGIC_API_TOKEN`, `CODEMAGIC_APP_ID`, `CODEMAGIC_ASC_INTEGRATION_NAME`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `APP_STORE_APP_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_PRIVATE_KEY_PATH`, `GOOGLE_PLAY_ACCOUNT_ID`, `ANDROID_PACKAGE` e `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH`, com os caminhos apontando para fora do repositório. Auditoria antes de cada commit: `for f in secrets/*; do git check-ignore -q "$f" && echo "ok $f" || echo "EXPOSTO $f"; done`.

## Lojas

| Etapa | Regras |
| --- | --- |
| TestFlight interno | Em uso desde 14/09/2026: build 1 da 0.1.0 no grupo interno da equipe, com acesso a todos os builds |
| TestFlight externo | Pendente. Exige informações de teste, conta de demonstração e Beta App Review; será o ensaio antes da submissão |
| App Store | Materiais preparados. Submissão, política publicada, auditoria do archive e respostas finais continuam pendentes |
| Play interno | AAB 0.1.0 com `versionCode` 2 em rascunho na faixa interna desde 14/09/2026; liberar para testadores e o relatório de pré lançamento dependem do Play Console |
| Play produção | Materiais preparados. Data safety proposta, alvo 36, ícone e capturas precisam ser conferidos contra o AAB final |
| Textos | Versões curta e longa em português e inglês estão em `docs/stores`; campos marcados dependem de confirmação do usuário |
| Versões | Desktop pela tag `v<semver>`; celular com versão de marketing `X.Y.Z` e número de build monotônico do `cm-next-build-number.sh` no iOS e do `versionCode` no Android |

## Lista de verificação de release

1. `CHANGELOG.md` atualizado e docs desta pasta revisados para o que existe.
2. `npm test` verde nos três sistemas.
3. Tag `v<semver>` empurrada; `release.yml` publica os seis instaladores assinados, os cinco sidecars, `latest.json` e os artefatos móveis.
4. Instalação limpa em cada sistema até um celular pareado, pelo roteiro físico de conectividade em `docs/testes/roteiro-conectividade.md`.
5. `cm-publish.sh` para `ios-testflight`; instalação pelo grupo interno; `play_api.py upload` na faixa interna.
6. Submissões às lojas com os textos e as respostas de conformidade; registro das datas e dos números de build em `docs/12-decisoes.md`.
