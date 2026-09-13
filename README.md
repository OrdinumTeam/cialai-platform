# Cialai

Cialai é um estúdio de terminais open source, mantido pela Ordinum. Cada sessão
é um shell numa pasta, com contexto de arquivos, prévias e Dev Browser. Um
celular pareado acompanha e controla essas sessões por um túnel cifrado ponta a
ponta, coordenado por um Headscale que a própria pessoa hospeda.

## Estado

A portabilidade desktop da Fase 5 está em execução. O núcleo Rust foi executado
nativamente no macOS e no Ubuntu 22.04. O alvo Windows passou no `cargo-xwin`,
sem execução nativa. Isso não equivale a aplicativo final, instalador aprovado
ou matriz remota concluída.

O [roadmap](./docs/11-roadmap-de-execucao.md) define o aceite e o
[progresso e handoff](./docs/13-progresso-e-handoff.md) registra os comandos e
resultados observados. O
[guia de diferenças por plataforma](./docs/14-diferencas-por-plataforma.md)
explica os comportamentos de macOS, Linux e Windows.

## Preparação comum

Use Git, Node 22, npm 10, Rust 1.98.1 e Go 1.26.5. O Go pode baixar a versão
declarada no módulo quando `GOTOOLCHAIN=auto` estiver ativo.

```sh
npm ci
npm run sidecar --workspace @cialai/desktop
npm test
```

Compile o sidecar novamente antes de chamar Cargo diretamente ou iniciar o app.
Neste repositório, compilações Rust usam no máximo dois jobs.

```sh
npm run sidecar --workspace @cialai/desktop
CARGO_BUILD_JOBS=2 npm run dev:desktop
```

### macOS

Requer macOS 13 ou mais novo e as ferramentas de linha de comando do Xcode. O
shell detectado recebe argumentos de login. O pacote local usa `app` e `dmg`.

```sh
xcode-select --install
npm run sidecar --workspace @cialai/desktop
CARGO_BUILD_JOBS=2 npm run dev:desktop
```

Assinatura Developer ID e notarização não fazem parte do fluxo local.

### Linux

A referência de build é Ubuntu 22.04 com WebKitGTK 4.1. Instale as dependências
do Tauri antes da preparação comum.

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev zsh
npm run sidecar --workspace @cialai/desktop
CARGO_BUILD_JOBS=2 npm run dev:desktop
```

Os pacotes previstos são `deb`, `rpm` e `AppImage`. Em problemas de composição
do WebKitGTK, consulte o guia por plataforma antes de alterar o ambiente.

### Windows

Requer Windows 10 21H2 ou mais novo, WebView2 Runtime e Visual Studio Build Tools
com Desktop development with C++. PowerShell 7 é preferido; Windows PowerShell
e `cmd.exe` permanecem reservas suportadas.

```powershell
npm ci
npm run sidecar --workspace @cialai/desktop
$env:CARGO_BUILD_JOBS = "2"
npm run dev:desktop
```

Os pacotes previstos são `nsis` e `msi`. Execução nativa no Windows segue
pendente; o resultado disponível é um cross check do código Rust, sem validar
WebView2, ConPTY, recursos do instalador ou assinatura.

## Documentação

Índice e ordem de leitura em [docs/README.md](./docs/README.md). Instruções para
contribuir em [CONTRIBUTING.md](./CONTRIBUTING.md).

## Estrutura

```text
apps/desktop          Tauri 2 e Rust
apps/mobile           Expo, iOS e Android, módulo nativo do túnel
packages/ui           React, estúdio e cascas desktop e celular
packages/protocol     Contrato da ponte e do pareamento
packages/tunnel-core  Go, tsnet, borda, proxy, pareamento e Headscale
infra/headscale       Docker Compose, configuração e política
tools                 Verificações, capturas, autoteste e release
docs                  Planejamento e documentação viva
```

## Licença

Apache 2.0.
