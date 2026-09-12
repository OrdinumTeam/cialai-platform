# Progresso e passagem de contexto

Atualizado em 12/09/2026. Este é o ponto de entrada para continuar a execução. O escopo e as dependências permanecem em [11-roadmap-de-execucao.md](./11-roadmap-de-execucao.md).

## Regras de continuidade

1. Ler este arquivo antes de executar e atualizar após cada entrega ou impedimento encontrado.
2. Registrar comandos e resultados reais. Não confundir scaffold, código implementado, teste local e aceite de fase.
3. Preservar o working tree do Control. Ele é fonte somente leitura.
4. Não marcar spikes de aparelho, soak ou loja como aprovados por testes unitários.
5. Não iniciar a Fase 1 enquanto o aceite da Fase 0 estiver pendente, salvo mudança expressa de escopo pelo usuário.

## Estado atual

Execução iniciada. Nenhuma fase concluída.

| Tarefa | Estado | Evidência e próximo passo |
| --- | --- | --- |
| 0.1 Fundação | Base implementada e validada localmente | Git local em `main`, cinco workspaces, lockfile npm, Apache 2.0, NOTICE, guias, modelos, ignores, crate Rust e módulo Go. E-mail e prazo de segurança ainda precisam de confirmação antes da publicação |
| 0.2 Commit da origem | Pendente do usuário | Control em `c26d98bb9b6851b438918a5e10278799f4442cd7`, com os mesmos oito arquivos alterados descritos no documento 02. Nenhum arquivo da origem foi alterado nesta execução |
| 0.3 CI mínima | Implementada, execução remota pendente | `.github/workflows/ci.yml` para macOS, Linux e Windows. `npm test` passou localmente em macOS arm64. Sem remoto configurado ou push. A consulta GitHub não conseguiu resolver `OrdinumTeam/cialai-platform`, por inexistência ou falta de acesso |
| 0.4 Spike 1 | Preparação parcial | API Go experimental, interfaces Java e Objective-C geradas e script de build. Sem XCFramework, AAR ou execução em aparelhos |
| 0.6 Spike 3 | Aprovado localmente | Headscale 0.29.3 e tsnet 1.102.0; oito verificações finais passaram em 35,830 s, incluindo persistência do módulo móvel no desktop. Workflow remoto preparado |
| 0.5, 0.7 a 0.11 | Pendentes | Sem Xcode em `/Applications`, nenhum Android conectado e SDK não encontrado no caminho padrão. Ensaios móveis, loja, assinatura e soak não executados |
| 0.12 Decisões dos spikes | Atualizado parcialmente | Decisões 022 a 026 registram correções, aceite local do spike 3 e estado dos demais |
| 1.1 Scaffold desktop | Concluído localmente | Tauri real, configurações macOS, Windows e Linux, capabilities, duas entradas Vite e ícones provisórios. Build macOS sem bundle aprovado. Configurações Windows e Linux aguardam a matriz remota |
| 1.2 Extração Rust | Concluída localmente | Núcleo macOS extraído sem stack, reuniões e VPN. Clippy sem avisos, 118 testes ativos passaram, dois ensaios externos permaneceram ignorados e o binário Tauri compilou e iniciou |
| 1.3 Extração da interface | Não iniciada | Próxima tarefa. A janela ainda mostra o placeholder da tarefa 1.1 |
| 1.4 a 7.6 | Não iniciadas | Seguem as dependências do roadmap; a autorização para avançar não aprova os testes físicos pendentes |

## Ambiente observado

Diretório: `/Users/focoamorim/Github Projects/OrdinumTeam/cialai-platform`.

O diretório inicialmente não tinha Git próprio. `git rev-parse --show-toplevel` apontava para o diretório pai `OrdinumTeam`. Inicializar o Git local é a tarefa 0.1 e evita misturar alterações dos outros projetos.

| Ferramenta | Observação inicial |
| --- | --- |
| Node e npm | Node 25.6.0 e npm 11.8.0 globais, diferentes de Node 22 e npm 10 previstos |
| Rust | rustc e cargo 1.98.1 |
| Go | 1.26.3 global, documento prevê 1.24 e requer confirmação de compatibilidade com tsnet |
| Docker | Desktop disponível, Engine 29.4.2 em Linux arm64 |
| Xcode | `xcodebuild -version` falha porque o diretório ativo é CommandLineTools |
| gomobile | Não encontrado no PATH |
| Android | adb disponível, aparelhos e SDK ainda não conferidos |

## Diário

### 12/09/2026, início

Lidos o índice, visão, inventário da origem, roadmap, ferramentas, CI e especificação de rede. Confirmado que só havia README e documentos no destino. Nenhum AGENTS.md aplicável encontrado nos diretórios ancestrais. A primeira entrega será a fundação e as provas de viabilidade possíveis neste ambiente.

### 12/09/2026, fundação validada

Criados `AGENTS.md` com a regra de continuidade, Git local, manifests, lockfiles, arquivos de abertura e workflow. O pacote desktop é só uma biblioteca Rust vazia, não um aplicativo Tauri. UI, protocolo e mobile não possuem suítes de produto ainda. O script da fundação informa isso expressamente.

Comandos concluídos com código 0:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm ci
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm run check:source
```

Resultados: cinco workspaces, quinze caminhos protegidos, crate Rust com zero testes, módulo Go sem testes de produto e oito hashes da origem conferidos. Node e npm foram usados pelo cache do npm exec, sem substituir as instalações globais. Rust 1.98.1 instalado pelo rustup e Go 1.26.5 baixado automaticamente pelo Go. O `tsnet` planejado exige Go 1.26.5, decisão 022.

Docker baixou `headscale/headscale:0.29.3`, digest `sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72`. Nenhum serviço existente foi alterado. O experimento cria e remove seu próprio contêiner temporário.

### 12/09/2026, spike de política e preparação móvel

O teste original de política e expiração passou após duas correções no ambiente de teste: adicionar relé DERP local e usar o IP 127.0.0.1 como hostname compatível com o certificado fixado por SHA-256. O ensaio sem relé não estabeleceu a conexão permitida. A API de expiração funcionou com `disableExpiry` na URL. A tentativa de gravar política em modo arquivo retornou HTTP 500 com mensagem de desativação; o teste confirmou que o conteúdo permaneceu igual.

Preparado o pacote experimental `spikes/mobileprobe` e o script `tools/spikes/build-mobile.mjs`. `gomobile` e `gobind` fixados em `v0.0.0-20260908204917-8b95e45f8d3e`. `go tool gobind -lang=java,objc -outdir=build/spikes/bindings ./spikes/mobileprobe` gerou as interfaces Java e Objective-C com código 0. Isso só verifica a geração das interfaces, não compila XCFramework ou AAR. A pasta gerada foi depois movida para `_bindings`, conforme a correção abaixo.

Tentativas de build móvel pararam corretamente no preflight: iOS sem Xcode completo e Android sem SDK configurado. Não há artefato móvel compilado. A integração ampliada detectou que `Up` pode terminar antes de o mapa de peers chegar. `EchoMillis` agora espera o peer dentro do mesmo prazo de dez segundos; o caso passou, incluindo reabertura sem nova chave e confirmação de que não foi criado um segundo nó.

### 12/09/2026, validação final e limites

A suíte de integração terminou com oito verificações aprovadas em 35,830 s. `go vet -tags=integration ./...` passou após isolar os arquivos gerados de gobind. `go vet` e `go test ./...` percorriam `build/spikes/bindings` apesar do `.gitignore` e tentavam compilar Objective-C sem o cabeçalho de ligação. A correção foi mover os gerados para `build/spikes/_bindings`, pois o Go ignora diretórios iniciados por sublinhado. Nas próximas gerações, use:

```sh
cd packages/tunnel-core
go tool gobind -lang=java,objc -outdir=build/spikes/_bindings ./spikes/mobileprobe
```

Após a correção dos gerados, `npm test` foi executado novamente com Node 22.23.2 e npm 10.9.8 e passou por inteiro. O crate Rust continua com zero testes de produto e o experimento móvel compila como pacote Go. As verificações de integração são executadas separadamente pelo comando do spike.

O teste de integração fecha os nós, o relé e remove o seu contêiner descartável. Confirmado que nenhum contêiner com a etiqueta do spike permaneceu em execução. Nenhum arquivo do Control foi alterado. O comando `gh repo view OrdinumTeam/cialai-platform` não resolveu o repositório com a sessão atual; isso não distingue ausência de falta de acesso.

O checkpoint local usa a mensagem `chore: inicializa fundacao e registra spikes da fase 0`. Consulte `git log -1` para obter seu hash. Não há remoto configurado nem push. Arquivos gerados em `node_modules`, `target` e `packages/tunnel-core/build` permanecem ignorados.

### 12/09/2026, início da Fase 1 autorizado

O usuário autorizou avançar para a próxima etapa mesmo com os ensaios físicos da Fase 0 pendentes. A execução iniciou a tarefa 1.1. Isso altera a ordem operacional, sem transformar preparação ou testes locais em aceite dos spikes.

Criado o aplicativo Tauri real em `apps/desktop`, com identificador `br.com.ordinum.cialai`, duas entradas HTML, Vite servindo apenas em `127.0.0.1:1420`, CSP de produção e desenvolvimento, capability da janela principal e configurações específicas dos três sistemas. macOS usa barra sobreposta e transparência; Windows usa janela sem decoração, sombra e fundo ameixa; Linux mantém as decorações e fundo opaco. Os ícones provisórios foram gerados da imagem de marca `cialai-mantis-v4-1-head.png`; o arquivo de origem tinha conteúdo JPEG apesar da extensão PNG e foi convertido de fato antes da geração.

O Vite 5.4.8 do protótipo retornou duas vulnerabilidades no `npm audit`, uma moderada e uma alta. A fundação foi atualizada para Vite 7.3.6 e plugin React 5.2.0, compatíveis com Node 22.23.2. O build preserva `target: safari16`. Depois da atualização, `npm audit --audit-level=moderate` terminou sem vulnerabilidades.

Validação da tarefa 1.1:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm exec --workspace @cialai/desktop -- tauri build --debug --no-bundle --ci
```

Ambos terminaram com código 0. O primeiro comando validou os arquivos esperados, as duas entradas Vite, as três configurações, capabilities, ícones, bundle web, Clippy e testes Rust. O segundo gerou o executável macOS de depuração em `apps/desktop/src-tauri/target/debug/cialai-desktop`. O diretório `target` é ignorado. Nenhum instalador, assinatura, notarização ou execução Windows e Linux foi produzida.

O executável gerado também foi iniciado diretamente e permaneceu ativo por mais de cinco segundos, sem erro no stderr, até a interrupção manual com Ctrl C. Esse smoke test confirma o ciclo básico do processo; a janela não foi inspecionada visualmente e o placeholder não representa o estúdio final.

### 12/09/2026, núcleo Rust da tarefa 1.2 extraído

Copiados do working tree preservado do Control os módulos `workspace/`, `bridge/`, `commands.rs`, `diagnostics.rs`, `lifecycle.rs`, `prefs.rs` e `window.rs`. `stack.rs`, `meetings/` e `vpn/` não foram copiados. O `lib.rs` agora registra somente PTYs, arquivos, Git, observação, journal e retomada, uso do plano, previews, Office, Dev Browser, preferências, janela e ponte. Na saída, Chromiums são encerrados antes dos terminais. Não há Node ou Python no processo.

Removidos do handler Tauri, do despacho remoto e dos eventos todos os comandos de stack, reuniões e VPN. A allowlist remota ficou limitada ao contrato de terminais e leituras associadas; o `welcome` anuncia apenas `capabilities: ["pty"]`. A configuração da ponte lê `CIALAI_BRIDGE_PORT`, exige o segredo efêmero do proxy antes do upgrade e só abre sem ele com `--dev-open-bridge`; o dispositivo é associado à conexão. A entrega ao sidecar, a revogação e os campos completos do `welcome` continuam na tarefa 2.8.

`prefs.rs` foi substituído pelo esquema com Aparência, Terminal, Projetos, Dev Browser, Janela e Rede. Chave da API não é persistida. Alterar as preferências atualiza o caminho do Chromium no gerenciador vivo. A integração efetiva de `projectRoots` e a escolha do shell continuam nas tarefas 1.6 e 1.4, respectivamente. Textos, identificador do `TERM_PROGRAM`, classe de arraste, log e raízes provisórias deixaram de usar a marca do Control.

A contagem de 137 casos do planejamento estava desatualizada. A origem atual declara 142 casos: 138 no `HEAD` e quatro nas mudanças preservadas. Os 28 casos de stack, reuniões e VPN não pertencem ao Cialai; o recorte elegível trouxe 114. Seis testes dos novos contratos de preferências e autenticação da ponte elevaram o crate a 120 casos compilados. Resultado real: 118 passaram, zero falharam e dois ficaram ignorados (`installs_the_real_playwright_chromium`, que baixa um Chromium, e `converts_rtf_to_pdf_with_soffice`, integração opt-in com LibreOffice). A decisão 030 substitui a contagem congelada por suíte elegível sem falhas e ignores justificados.

Validação da tarefa 1.2:

```sh
npm run check:source
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm exec --workspace @cialai/desktop -- tauri build --debug --no-bundle --ci
apps/desktop/src-tauri/target/debug/cialai-desktop
```

Os cinco primeiros comandos terminaram com código 0. O último iniciou o app, registrou `Cialai 0.1.0 iniciado` e permaneceu ativo por cinco segundos até Ctrl C. A janela não foi inspecionada visualmente e ainda contém o placeholder; isso não valida paridade da interface. Nenhum instalador, assinatura, notarização, Windows ou Linux foi testado. `tools/check/desktop-extraction.mjs` passou a impedir o retorno dos três subsistemas removidos e a conferir o novo esquema e a redução da ponte. O `ordinum-control` continuou com exatamente as oito alterações inventariadas, sem modificação desta execução.

## Arquivos para retomar

| Arquivo | Uso |
| --- | --- |
| `package.json`, `tools/run.mjs` | Comandos reais existentes nesta etapa, incluindo build do scaffold desktop |
| `apps/desktop/vite.config.js` | Build das entradas desktop e celular |
| `apps/desktop/src-tauri/tauri*.conf.json` | Configuração comum e diferenças por sistema |
| `tools/check/desktop-scaffold.mjs` | Validação rápida das três configurações e arquivos esperados |
| `tools/check/desktop-extraction.mjs` | Guarda da extração Rust, produtos removidos, preferências e ponte PTY |
| `apps/desktop/src-tauri/src/lib.rs`, `commands.rs`, `prefs.rs` | Composição do núcleo extraído e comandos locais |
| `apps/desktop/src-tauri/src/workspace/`, `bridge/` | Estúdio nativo e transporte remoto reduzido |
| `.github/workflows/ci.yml` | Matriz mínima, sem execução remota registrada |
| `.github/workflows/spike-headscale.yml` | Integração do spike no Linux, sem execução remota registrada |
| `packages/tunnel-core/spikes/headscale/headscale_test.go` | Experimento Docker reproduzível, sem usar servidor do usuário |
| `packages/tunnel-core/spikes/mobileprobe/probe.go` | API experimental Go para o primeiro ensaio móvel |
| `tools/spikes/build-mobile.mjs` | Preflight e build experimental iOS ou Android |
| `tools/spikes/README.md` | Escopo, comandos e medições pendentes dos spikes |
| `docs/evidence/control-source.json` | Commit base e hashes da origem |

## Comandos de continuidade

Na raiz, com as versões globais atuais, use o cache do npm exec:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm ci
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm run test:spike:headscale
npm run check:source
```

`npm run dev:desktop` e `npm run build:desktop` agora compilam o núcleo Rust da tarefa 1.2, mas a interface ainda é a casca da tarefa 1.1. `dev:mobile` e o aplicativo móvel ainda não existem. Os demais scripts futuros do documento 09 continuam sendo planejamento.

## Próxima ação

1. Resolver o destino e acesso ao repositório GitHub para executar a matriz de CI. Ainda não houve publicação, push ou alteração nas lojas.
2. Confirmar um contato de segurança e o prazo de resposta antes de anunciar uma política pública completa.
3. O usuário deve fazer o commit das oito alterações do Control conforme 0.2. Depois atualizar o inventário conscientemente, sem apagar mudanças da origem.
4. Disponibilizar Xcode completo, SDK e NDK Android e aparelhos reais. Compilar os bindings experimentais e criar os hosts nativos de teste do spike 1, ainda inexistentes.
5. Executar spikes 1 e 2, depois 4 e 5, com as medições do documento 06. Preparar revisão externa e assinatura com as contas e certificados corretos. O soak de 24 horas continua obrigatório.
6. Continuar pela tarefa 1.3, abrindo a tabela de frontend do documento 04. Conferir `npm run check:source` antes de cada lote copiado. Portar as suítes Node junto dos módulos, remover as seções de negócio e manter a interface ainda não verificada separada do núcleo Rust já aprovado.
