# CI, CD e distribuição

A distribuição foi desenhada com GitHub Actions para desktop, núcleo do túnel e interface, e Codemagic para os celulares. Nenhum valor de credencial aparece aqui; a seção de credenciais registra somente nomes, destinos e responsabilidades.

## Repositórios

| Repositório | Visibilidade | Uso |
| --- | --- | --- |
| `OrdinumTeam/cialai-platform` | Privado | Desenvolvimento, histórico completo, CI e Codemagic enquanto o projeto não for aberto |
| Organização `Cialai`, em https://github.com/Cialai | Pública | Destino do projeto open source quando todo o trabalho estiver concluído: código, releases dos binários de macOS, Linux e Windows, issues e contribuições. Nome do repositório a definir |

A exportação para a organização `Cialai` só acontece depois da conclusão. Antes dela:

1. Decidir se o público recebe o histórico completo ou um ponto de partida limpo. O histórico e os documentos internos citam caminhos locais, o Ordinum Control e o diário de execução.
2. Revisar `docs/13-progresso-e-handoff.md`, as variáveis de caminho de `docs/README.md` e qualquer referência interna que não deva ficar pública.
3. Trocar o caminho do repositório em `packages/tunnel-core/go.mod` e nos imports Go do módulo, no endpoint do updater em `apps/desktop/src-tauri/tauri.conf.json` e `tools/release/check-updater.mjs`, em `apps/mobile/modules/cialai-tunnel/ios/CialaiTunnel.podspec` e nos links dos documentos.
4. Publicar a primeira release já com o endpoint do updater apontando para a organização `Cialai`. Apps instalados só procuram atualização na URL compilada neles.
5. Definir onde ficam o app do Codemagic e os secrets de assinatura. Workflows disparados por PR de fork nunca recebem secrets.
6. Confirmar o contato de segurança de `SECURITY.md` e o `CODE_OF_CONDUCT.md` antes de abrir.

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| `ci.yml` | Preparado | Matriz Ubuntu 22.04, Windows 2022 e macOS 14 com sidecar local, `npm test`, bundle sem assinatura e artefatos por sistema está versionada; nenhuma execução remota foi observada |
| `spike-headscale.yml` | Preparado | Contrato existe e o spike passou localmente; execução no GitHub não foi observada |
| `headscale-integration.yml` | Preparado | Workflow e integração Docker existem; o gate remoto no SHA da candidata está pendente |
| `release.yml` | Preparado | Matriz desktop, cinco sidecars, updater e rascunho existem; assinaturas de plataforma, publicação dos sidecars brutos e execução por tag continuam pendentes |
| `nightly-e2e.yml` | Preparado | Self test diário no Ubuntu 22.04 e no Windows 2022 por `tauri-driver` 2.0.6, com WebKitWebDriver e Xvfb no Linux e Edge WebDriver da versão do WebView2 no Windows; nenhuma execução remota foi observada |
| `mobile-artifacts.yml` | Pendente | O workflow dedicado ao XCFramework e ao AAR ainda não existe; Codemagic pode compilar os bindings no runner |
| `ios-testflight`, `ios-archive` e `android-play` | Preparado | Configuração e checks locais existem; apps, integrações, credenciais, builds e uploads não foram executados |
| Scripts em `tools/release` | Implementado | Contratos locais, modo de ensaio e guardas estão versionados e testados sem credenciais reais |
| Atualizador do desktop | Preparado | Plugin, artefatos, endpoint e secrets estão configurados; a chave pública provisória bloqueia a release |
| Identificadores públicos | Preparado | Bundle, Team ID e nomes estão documentados; os registros dos apps e ids resultantes dependem do usuário |
| Credenciais | Pendente | Somente nomes e locais esperados estão versionados; nenhum valor foi criado ou copiado para o repositório |
| Materiais das lojas | Preparado | Políticas, respostas, textos, capturas planejadas e notas de revisão existem; URLs publicadas e formulários estão pendentes |
| Release `v1.0.0` | Preparado | `CHANGELOG.md`, procedimento e guarda existem com seis gates pendentes; nenhuma tag ou release foi criada |

Go está fixado em 1.26.5 pela decisão 022 e Rust em 1.98.1. As tabelas seguintes descrevem o contrato completo. O estado acima prevalece quando um workflow ou serviço ainda não foi executado.

## GitHub Actions

| Workflow | Gatilho | Passos |
| --- | --- | --- |
| `ci.yml` | push, PR e manual | Matriz `ubuntu-22.04`, `windows-2022` e `macos-14`; Node, npm, Rust 1.98.1 e Go pelo `go.mod`; no Linux instala WebKitGTK 4.1, GTK, AppIndicator, SVG, `patchelf`, XDo, OpenSSL e zsh; `npm ci`; build do sidecar local; `npm test`; `tauri build` sem assinatura; dmg, AppImage, deb, rpm, nsis e msi anexados ao run. `CARGO_BUILD_JOBS=2` limita Rust. Playwright e `check:text` ainda aguardam seus scripts, e o workflow não substitui os testes físicos |
| `release.yml` | tag `v*` e manual | Bloqueia a chave pública provisória e secrets vazios; testa e compila cinco sidecars; entrega o artefato à matriz `macos-14`, `macos-13`, `ubuntu-22.04` e `windows-2022`; `tauri-action` compila os bundles e mantém a release em rascunho. Assinatura de plataforma, sidecars brutos, hashes, notas do changelog e artefatos móveis ainda não estão completos no workflow |
| `headscale-integration.yml` | mudanças no túnel, diário e manual | `ubuntu-22.04` com Docker; vet e integração contra `headscale/headscale:0.29.3` com prazo de doze minutos |
| `spike-headscale.yml` | PR no túnel e manual | Executa o spike de política e expiração com Headscale 0.29.3 no Linux |
| `nightly-e2e.yml` | Diário às 05:17 UTC e manual | Matriz `ubuntu-22.04` e `windows-2022`; instala dependências, `tauri-driver` 2.0.6 e, no Windows, o Edge WebDriver da versão do WebView2; compila sidecar e app de depuração sem bundle; roda `tools/selftest/driver.mjs`, sob Xvfb no Linux, e anexa `selftest.json`, `app.log` e o log do driver mesmo em falha. Não consome secrets |
| `mobile-artifacts.yml` | Planejado para tag e manual | Ainda ausente; deve publicar `Tunnelcore.xcframework.zip`, `tunnelcore.aar` e hashes para a release |

O workflow atual referencia somente `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Os nomes planejados para Developer ID, notarização e Azure Trusted Signing ainda precisam ser ligados ao workflow sem expor valores. Builds de PR nunca devem receber secrets.

## Codemagic

Três workflows em `codemagic.yaml`, no padrão de `$CONTROL/codemagic.yaml` e `$ADVORIS/codemagic.yaml`: instância `mac_mini_m2`, 60 minutos, `node 22`, `xcode latest`, `cocoapods default`, sem bloco `triggering`, disparo pelos scripts ou pelo painel.

| Workflow | Passos | Publicação |
| --- | --- | --- |
| `ios-testflight` | Valida ambiente, instala Go, compila e confere o XCFramework, executa os testes móveis, gera o projeto, busca perfis, numera e compila o IPA | `app_store_connect` usa a integração, mas `submit_to_testflight` e `submit_to_app_store` estão falsos. O IPA permanece artefato até o usuário mudar e executar a política de publicação |
| `ios-archive` | Igual, com `PROJECT_BUILD_NUMBER` | Nenhuma; só o IPA como artefato |
| `android-play` | Valida ambiente, instala Go, compila e confere o AAR, executa os testes móveis, gera o projeto, grava credenciais temporárias e compila o AAB | O bloco `google_play` aponta para a faixa interna. A execução publicaria externamente e depende de autorização e credenciais do usuário |

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
| App no Codemagic | Criado em 13/09/2026 a partir do repositório privado `OrdinumTeam/cialai-platform`, `CODEMAGIC_APP_ID` igual a `6aa7525c8ec3de31de94f9ee` |
| App no Google Play | Criado em 13/09/2026 na conta `7730543760992383205`, Play App ID `4975087090602407034` |
| Conta de serviço do Play | `ordinum-play-publisher@ordinum.iam.gserviceaccount.com`, do projeto `ordinum`, compartilhada pelos apps da Ordinum e validada pela API em 13/09/2026 |
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
| TestFlight interno | Pendente. Exige app, integração, assinatura, build e grupo confirmados pelo usuário |
| TestFlight externo | Pendente. Exige informações de teste, conta de demonstração e Beta App Review; será o ensaio antes da submissão |
| App Store | Materiais preparados. Submissão, política publicada, auditoria do archive e respostas finais continuam pendentes |
| Play interno | Pendente. Workflow aponta para `internal`, e o script de API ensaia sem `--commit`; relatório de pré lançamento depende do AAB enviado |
| Play produção | Materiais preparados. Data safety proposta, alvo 36, ícone e capturas precisam ser conferidos contra o AAB final |
| Textos | Versões curta e longa em português e inglês estão em `docs/stores`; campos marcados dependem de confirmação do usuário |
| Versões | Desktop pela tag `v<semver>`; celular com versão de marketing `X.Y.Z` e número de build monotônico do `cm-next-build-number.sh` no iOS e do `versionCode` no Android |

## Lista de verificação de release

1. `CHANGELOG.md` atualizado e docs desta pasta revisados para o que existe.
2. `npm test` verde nos três sistemas e `headscale-integration.yml` verde.
3. Tag `v<semver>` empurrada; `release.yml` publica os seis instaladores assinados, os cinco sidecars, `latest.json` e os artefatos móveis.
4. Instalação limpa em cada sistema até um celular pareado, pelos roteiros manuais do documento 06.
5. `cm-publish.sh` para `ios-testflight`; instalação pelo grupo interno; `play_api.py upload` na faixa interna.
6. Submissões às lojas com os textos e as respostas de conformidade; registro das datas e dos números de build em `docs/12-decisoes.md`.
