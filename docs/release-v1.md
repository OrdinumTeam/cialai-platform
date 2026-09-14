# Procedimento da versão 1

Estado em 13/09/2026: preparado, não executado. Este documento não comprova uma release. A publicação de `v1.0.0` depende de contas, chaves, aparelhos e decisões do usuário indicadas abaixo.

## Comandos de guarda

Use as versões fixadas pelo repositório:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm ci
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm run check:release
```

O segundo comando valida a estrutura deste procedimento e deve passar durante a preparação. A guarda final é intencionalmente mais rígida:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm run check:release -- --release
```

Ela deve falhar enquanto houver uma linha `PENDENTE`, versões diferentes de `1.0.0`, ausência da tag local `v1.0.0` no commit atual ou a chave pública provisória do atualizador. Um resultado verde só confirma os dados versionados e o estado local. Evidências do GitHub, dos aparelhos e das lojas ainda precisam ser abertas e conferidas.

## Responsabilidades que dependem do usuário

| Dependência | Ação necessária |
| --- | --- |
| Chave do atualizador | Feito em 14/09/2026: par gerado fora do repositório, chave pública na configuração e chave privada com senha nos secrets do GitHub. Guardar a cópia offline |
| Assinatura Apple | Disponibilizar Developer ID, notarização, App Store Connect e perfis do aplicativo |
| Assinatura Windows | Disponibilizar a conta e os parâmetros do Azure Trusted Signing |
| Assinatura Android | Disponibilizar o keystore de upload e a conta de serviço do Google Play fora do repositório |
| Contas de loja | Criar ou confirmar os aplicativos, contratos, contatos, política publicada, faixa interna e grupos de teste |
| Aparelhos e ambientes | Fornecer máquinas limpas dos três sistemas desktop, iPhone, Android e um Headscale de produção ou homologação |
| Conteúdo final | Confirmar contato de segurança, URL da política, textos, capturas, conta de demonstração e data do lançamento |

O comando para gerar o par do atualizador está em `tools/release/README.md`. A chave privada, senhas, tokens, perfis, certificados, arquivos de usuário e conteúdo de projetos nunca entram neste repositório.

## Etapa 1, congelar a candidata

1. Escolher um commit integrado que contenha as frentes finais e não tenha alterações locais.
2. Atualizar para `1.0.0` os manifests raiz e dos workspaces, `apps/mobile/app.config.ts`, `apps/desktop/src-tauri/tauri.conf.json` e `apps/desktop/src-tauri/Cargo.toml`.
3. Atualizar o lockfile com npm 10.9.8 e manter a mesma versão nos pacotes próprios.
4. Mover as mudanças pertinentes de `Unreleased` para uma seção `1.0.0` datada no `CHANGELOG.md`.
5. Confirmar os contatos pendentes em `SECURITY.md`, `CODE_OF_CONDUCT.md` e nas duas políticas de privacidade.
6. Criar o commit da candidata e registrar seu SHA na tabela de evidências.

## Etapa 2, testar antes da tag

1. Executar `npm test` em macOS, Windows e Linux no mesmo commit.
2. Conferir `headscale-integration.yml` verde no GitHub para o mesmo SHA.
3. Executar os roteiros dos documentos 06 e `docs/testes` com os resultados reais, inclusive suspensão, troca de rede, revogação e relé.
4. Registrar plataforma, versão do sistema, arquitetura, data, duração, resultado e URL ou caminho sanitizado da evidência.
5. Não converter código preparado, check estático ou execução em outro sistema em aceite da plataforma ausente.

## Etapa 3, configurar assinatura

1. Conferir que a chave pública do atualizador em `tauri.conf.json` continua a gerada em 14/09/2026, com `check-updater.mjs`.
2. Não trocar o par sem plano de migração dos clientes que já instalaram a prévia.
3. Conferir `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` nos secrets do GitHub.
4. Configurar Developer ID e notarização para macOS e Azure Trusted Signing para Windows.
5. Conferir as credenciais móveis por nomes e permissões, sem imprimir valores.
6. Rodar a guarda final. Não criar a tag enquanto ela estiver vermelha.

## Etapa 4, criar e acompanhar a release

Esta etapa é uma ação do usuário porque envia uma tag e aciona serviços externos.

1. Criar a tag anotada `v1.0.0` no commit aprovado.
2. Rodar novamente a guarda final com a tag apontando para `HEAD`.
3. Enviar a tag ao GitHub.
4. Acompanhar `release.yml` e manter a release como rascunho durante a conferência.
5. Confirmar os seis formatos desktop: DMG, NSIS, MSI, AppImage, DEB e RPM.
6. Confirmar os cinco sidecars: macOS arm64, macOS x64, Linux x64, Linux arm64 e Windows x64, além de `SHA256SUMS`.
7. Confirmar `latest.json`, assinaturas do atualizador e URLs de download acessíveis.
8. Confirmar os artefatos móveis `Tunnelcore.xcframework.zip` e `tunnelcore.aar` com SHA 256. O workflow dedicado a esses artefatos ainda precisa existir no commit integrado.
9. Conferir assinatura, notarização e Authenticode antes de publicar o rascunho.

## Etapa 5, instalar os artefatos publicados

1. Instalar o DMG num macOS arm64 limpo e num macOS x64 limpo.
2. Instalar NSIS e MSI em ambientes Windows limpos.
3. Instalar AppImage, DEB e RPM nas distribuições declaradas compatíveis.
4. Em cada sistema, iniciar o sidecar empacotado, parear com um celular real e concluir os roteiros manuais.
5. Instalar uma versão anterior assinada e provar a atualização por `latest.json` até `1.0.0`.
6. Guardar hashes, telas de assinatura, logs sanitizados e resultados por instalador.

## Etapa 6, validar e enviar os aplicativos móveis

1. Disparar `ios-testflight` e acompanhar o build com os scripts em `tools/release`.
2. Instalar pelo grupo interno do TestFlight e preencher o roteiro iOS.
3. Gerar o AAB assinado, executar primeiro o ensaio sem `--commit` e então enviar à faixa interna somente após conferência do usuário.
4. Conferir o relatório de pré lançamento do Play e preencher o roteiro Android.
5. Auditar os binários finais antes de confirmar as respostas de privacidade e Data safety.
6. Fazer as capturas nativas conforme `docs/stores/screenshots.md` e revisar os textos nos dois idiomas.
7. Registrar datas, versões e números de build em `docs/12-decisoes.md`.
8. Enviar App Store e Play para revisão somente após todos os gates verificados.

## Recuo

Se um instalador, atualização ou build móvel falhar, mantenha a release em rascunho ou interrompa a implantação da loja. Preserve os artefatos e logs sanitizados, abra o defeito, corrija em uma nova candidata e repita todos os gates afetados. Não reutilize uma versão ou número de build já enviado às lojas e não troque a chave do atualizador sem um plano de migração.

## Evidências da candidata

Edite `Estado` para `VERIFICADO` somente depois de anexar evidência executada no mesmo commit. Substitua cada texto da coluna Evidência por SHA, URLs, números de workflow, matrizes de aparelhos e datas. A guarda final rejeita linhas pendentes e marcadores vazios.

<!-- RELEASE_GATES_START -->
| Gate | Estado | Evidência |
| --- | --- | --- |
| 1 | PENDENTE | Changelog, documentos vivos, versão, contatos e SHA da candidata a confirmar |
| 2 | PENDENTE | npm test nos três sistemas e workflow Headscale a executar no mesmo SHA |
| 3 | PENDENTE | Tag, seis instaladores assinados, cinco sidecars, latest.json e artefatos móveis a produzir |
| 4 | PENDENTE | Instalações limpas, atualização assinada e pareamento real por sistema a executar |
| 5 | PENDENTE | TestFlight interno e faixa interna do Play a gerar, instalar e conferir |
| 6 | PENDENTE | Formulários, textos, builds, datas e submissões das duas lojas a confirmar |
<!-- RELEASE_GATES_END -->
