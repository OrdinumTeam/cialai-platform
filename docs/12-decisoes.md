# Registro de decisões

Uma entrada por decisão, com contexto, decisão, alternativas e consequências. Entradas novas entram no fim com número sequencial e data. As quatro primeiras foram confirmadas pelo usuário em 12/09/2026; as demais vieram da análise técnica e das duas revisões de arquitetura do mesmo dia.

## Estado em 13/09/2026

O estado abaixo se refere à aplicação da decisão nesta linha, não à conclusão de todas as fases que dependem dela.

| Decisão | Estado | Limite atual |
| --- | --- | --- |
| 001 | Implementado | Nome, bundle e esquema adotados |
| 002 | Implementado | Headscale auto hospedado e `ControlAdmin` adotados |
| 003 | Preparado | Escopo de paridade adotado; primeira versão pública segue pendente |
| 004 | Implementado | Apache 2.0, `LICENSE` e `NOTICE` presentes |
| 005 | Implementado | Tauri e extração Rust adotados no macOS |
| 006 | Preparado | Expo e WebView adotados; builds nativos permanecem pendentes |
| 007 | Implementado | Borda Go serve o recurso móvel |
| 008 | Preparado | Sidecar implementado e bindings gerados; aparelhos permanecem pendentes |
| 009 | Implementado | Proxy fixo, nonce e cookie integrados |
| 010 | Implementado | Token fica fora da página e segredo protege a ponte |
| 011 | Implementado | Política foi exercitada localmente com dois usuários |
| 012 | Implementado | Payload textual e leitor QR adotados |
| 013 | Preparado | Subprotocolo existe; plano B não foi ativado |
| 014 | Preparado | Configuração verdadeira aplicada; confirmação jurídica e loja pendentes |
| 015 | Implementado | Marca, acento, sessões e ANSI aplicados |
| 016 | Preparado | Workflows existem; execução remota e publicação permanecem pendentes |
| 017 | Preparado | Entrada pública em inglês existe; tradução da interface permanece pendente |
| 018 | Implementado | Tokens `--mac-*` foram mantidos |
| 019 | Pendente | Atalhos Linux e Windows dependem da integração da Fase 5 |
| 020 | Implementado | Leitura móvel Unix e arraste macOS refletem o recorte decidido |
| 021 | Implementado | Extração usou o working tree inventariado; commit no Control segue como dependência do usuário |
| 022 | Implementado | Go 1.26.5 está fixado no módulo e nos workflows |
| 023 | Implementado | Fundação e aceite externo permanecem separados nos registros |
| 024 | Implementado | Inventário e check da origem estão versionados |
| 025 | Implementado | Resultado local do spike 3 está registrado com limites |
| 026 | Implementado | Pendências dos demais spikes estão registradas sem aceite indevido |
| 027 | Implementado | Fases locais avançaram com pendências preservadas |
| 028 | Implementado | Vite 7.3.6 e plugin React 5.2.0 estão fixados |
| 029 | Implementado | Ícone provisório foi aplicado e depois conferido na tarefa 1.7 |
| 030 | Implementado | Suíte Rust usa casos elegíveis e contagem real no handoff |
| 031 | Implementado | SheetJS oficial e esbuild corrigido estão no lockfile |

## 001 Nome Cialai

Contexto: o pedido soletrou C-I-A-L-I-A, mas a pasta é `cialai-platform` e a marca em `ordinum-marketing` é `CIALAI`. Decisão: `Cialai`, bundle `br.com.ordinum.cialai`, esquema `cialai`. Alternativa: renomear pasta e marca para `Cialia`. Consequência: todos os identificadores, chaves e textos usam `cialai`.

## 002 Headscale auto hospedado como único caminho da v1

Contexto: um serviço hospedado pela Ordinum exigiria infraestrutura, custo e política de abuso, e a chave da API do Headscale é raiz do servidor inteiro. Decisão: auto hospedado com receita pronta; o app aceita qualquer URL; toda chamada administrativa passa por `ControlAdmin`. Alternativas: serviço da Ordinum como padrão; auto hospedado com serviço reservado para depois. Consequência: quem instala precisa de um servidor com IP público; a interface deixa um corretor entrar sem tocar no resto.

## 003 Primeira versão pública só com o estúdio completo

Contexto: publicar cedo com um núcleo menor ou esperar a paridade. Decisão: paridade total com o Control antes da primeira versão pública, em fases internas. Alternativas: núcleo com sessões, terminal, explorador e editor; mínimo com sessões e terminal. Consequência: lançamento mais tarde; nenhuma funcionalidade do Control fica de fora.

## 004 Licença Apache 2.0

Contexto: todas as dependências centrais são MIT, Apache 2.0 ou BSD. Decisão: Apache 2.0 com `NOTICE`. Alternativas: MIT; AGPL 3.0. Consequência: uso comercial por terceiros permitido; cláusula de patentes; cabeçalho `SPDX` nos arquivos novos.

## 005 Tauri 2 com Rust no desktop, reaproveitando o Control

Contexto: dez mil linhas de Rust testadas, `portable-pty` já multiplataforma, WKWebView e WebView2 dão apps pequenos. Decisão: mover `workspace/`, `bridge/`, `commands.rs`, `lib.rs`, `window.rs`, `prefs.rs`, `lifecycle.rs` e `diagnostics.rs` e adaptar por sistema. Alternativas: Electron; Go com WebView. Consequência: um backend por sistema em `procs`, `pty`, `watch` e `window`; macOS verbatim.

## 006 Expo com WebView no celular, reaproveitando `ios/app`

Contexto: a casca existe, tem 65 testes, ponte de mensagens e Face ID; o Advoris em Flutter é referência só de publicação. Decisão: Expo com módulo nativo do túnel e alvo Android novo. Alternativas: Flutter; Tauri iOS; telas nativas. Consequência: dev client obrigatório; uma casca, duas plataformas.

## 007 Página do celular servida pelo desktop pela borda do sidecar

Contexto: o protótipo serve a página pelo Node em `3710`; o Cialai não tem Node. Decisão: a borda Go serve o bundle empacotado como recurso do Tauri na porta 4740 da tailnet. Alternativas: página empacotada no app do celular; servidor estático em Rust na mesma porta da ponte. Consequência: interface e ponte sempre na mesma versão; a ponte fica só em loopback atrás do segredo da borda.

## 008 Um núcleo Go sobre `tsnet`, sidecar no desktop e `gomobile` nos celulares

Contexto: `tsnet` é o cliente Tailscale embutido em espaço de usuário, sem daemon; `gomobile` é o que o app Android oficial usa; ligar um arquivo C do Go ao Rust com MSVC no Windows é frágil. Decisão: `packages/tunnel-core` compilado como `cialai-tunnel` e como `.xcframework` e `.aar`. Alternativas: `libtailscale` em C no Rust; cliente Tailscale do sistema com `tailscale serve`. Consequência: protocolo JSON por stdio entre Rust e sidecar; artefatos móveis gerados pelo CI.

## 009 Proxy HTTP em loopback com porta fixa e cookie de nonce

Contexto: um encaminhador TCP bruto em porta aleatória trocaria a origem da página a cada abertura, não injetaria credencial e não barraria apps locais nem páginas de terceiros. Decisão: `httputil.ReverseProxy` em `127.0.0.1:47400`, nonce em `?k=`, cookie `HttpOnly` e `SameSite=Strict`, `Origin` obrigatório em upgrades, prazo de 60 s. Consequência: `localStorage` da página sobrevive; WebSocket passa como cano de bytes depois do upgrade.

## 010 Autenticação na borda Go dos dois lados, token nunca na página

Contexto: a proposta inicial validava o segredo de pareamento no `hello` da página e devolvia o token para a casca guardar; XSS na página roubaria o token. Decisão: o núcleo Go do celular faz `POST /pair` e injeta `Authorization: Bearer` no upgrade; a borda valida token e `WhoIs`; a ponte exige `X-Cialai-Proxy-Secret` por abertura do app. Alternativa: token no `hello`. Consequência: a mudança em Rust fica restrita ao handshake; o pareamento inteiro é um pacote Go testável sozinho; `welcome` responde `auth: "device"`.

## 011 Um usuário do Headscale por pessoa, sem tags, política com `autogroup:self`

Contexto: tags saem de `autogroup:self` e exporiam todo desktop a todo celular; usuário por desktop obrigaria um celular a duas identidades. Decisão: usuário por pessoa, nós sem tag, grant de `autogroup:member` para `autogroup:self` em `tcp:4740`, `policy.mode: file`. Consequência: segundo desktop entra no mesmo usuário; desktops compartilhados entre pessoas por grants explícitos.

## 012 QR como texto puro lido pelo leitor do app

Contexto: outro app pode tomar um esquema de URL no Android e o payload é uma credencial. Decisão: `CIALAI1.<base64url>` lido por `expo-camera`, com opção de colar. Alternativa: deep link `cialai://pair`. Consequência: deep links por App Links e Universal Links ficam para depois; o esquema `cialai` fica reservado.

## 013 Sem fallback por TailscaleKit

Contexto: TailscaleKit é o mesmo código Go do `tsnet` atrás de Swift e carrega os mesmos riscos; a correção do `os.Executable()` no iOS foi reportada como feita upstream. Decisão: o único plano B é o app oficial da Tailscale com servidor de coordenação próprio, documentado como modo manual. Consequência: a borda aceita o token como subprotocolo para esse modo e para desenvolvimento.

## 014 Conformidade de exportação verdadeira

Contexto: o protótipo declara `usesNonExemptEncryption: false`; embutir WireGuard torna isso falso. Decisão: verdadeiro, com algoritmos padrão, isenção de mercado de massa e relatório anual, confirmado com o jurídico. Consequência: o `ITSAppUsesNonExemptEncryption` fixo do Advoris não se aplica.

## 015 Marca Cialai no acento, sidebar e ícones; paleta das sessões e ANSI preservados

Contexto: o usuário apontou a identidade visual da louva-a-deus orquídea; o tema do terminal do Control pinta o ANSI azul com o acento. Decisão: acento magenta e gradiente rosa e ameixa; azul do terminal fixo nos valores do tom `azul`; dezoito cores das sessões intocadas. Consequência: `brand.css` redefine só marca e acento; `theme.js` ganha a regra do azul.

## 016 GitHub Actions para o desktop e Codemagic para os celulares

Contexto: o plano do Codemagic da Ordinum só tem `mac_mini_m2`; o repositório é público. Decisão: Actions com `tauri-action` para desktop, túnel e interface; Codemagic com os workflows do Control e do Advoris para as lojas. Consequência: dois sistemas de CI, cada um no seu padrão já conhecido.

## 017 Documentação de planejamento em português, porta de entrada em inglês

Contexto: a equipe escreve em português; um produto open source precisa de inglês na porta de entrada. Decisão: estes documentos em português; README, CONTRIBUTING e textos de loja em inglês na Fase 7, com tradução da interface preparada na Fase 6. Consequência: chaves de texto no `packages/ui` e no celular.

## 018 Tokens `--mac-*` mantidos na primeira rodada

Contexto: 243 usos só em `Terminais.css`. Decisão: manter os nomes e trocar só os valores de marca; renomear para `--ui-*` como tarefa opcional da Fase 6. Consequência: CSS do estúdio move sem edição.

## 019 Esquema Ctrl Shift no Linux e no Windows com o terminal em foco

Contexto: no macOS ⌘ nunca chega ao shell; no Linux e no Windows Ctrl T, Ctrl W e Ctrl C são teclas do shell. Decisão: a convenção do Windows Terminal e do GNOME Terminal, com Ctrl simples valendo fora do terminal; sem menubar nativa fora do macOS. Consequência: `lib/keys.js` concentra os atalhos e as etiquetas.

## 020 `mobile_files` só Unix e arraste para fora só macOS na primeira rodada

Contexto: `mobile_files.rs` usa `openat` com `O_NOFOLLOW` e `nlink`; `dragout.rs` usa `NSDraggingSession`. Decisão: Windows devolve `indisponível` nas leituras do celular e o stub do arraste continua até a Fase 6. Consequência: no Windows o celular vê os terminais mas não os arquivos até a Fase 6.

## 021 Extração a partir do working tree do Control

Contexto: oito arquivos do Control estão modificados sem commit, incluindo `browser.rs`, `office.rs`, `prefs.rs` e `runtime.js`. Decisão: extrair do working tree e pedir ao usuário o commit antes da Fase 1. Consequência: a origem de cada arquivo fica rastreável por commit.

## 022 Toolchain Go corrigida na execução

Data: 12/09/2026. Contexto: o planejamento fixava Go 1.24 com `tailscale.com` 1.102.0, mas o [go.mod oficial dessa versão](https://github.com/tailscale/tailscale/blob/v1.102.0/go.mod) exige Go 1.26.5. Decisão: manter o cliente planejado e usar Go 1.26.5 no módulo e no CI. Alternativa: reduzir a versão do cliente e repetir a análise de compatibilidade. Consequência: o Go global 1.26.3 baixa automaticamente a toolchain 1.26.5 quando `GOTOOLCHAIN=auto`; nenhum Go global foi substituído.

## 023 Fundação separada do aceite do produto

Data: 12/09/2026. Contexto: os spikes exigem aparelhos reais, Xcode, assinatura e revisão externa antes da extração. Decisão: criar workspaces mínimos e experimentos explícitos em `packages/tunnel-core/spikes`, com CI da fundação sem simular testes de produto inexistentes. Consequência: `npm test` aprovado nesta etapa não representa paridade com Control. O resultado de cada spike e suas limitações fica no registro de progresso.

## 024 Inventário verificável da origem antes do commit

Data: 12/09/2026. Contexto: os oito arquivos do Control continuam modificados e a origem é somente leitura. Decisão: guardar o commit base e SHA-256 de cada arquivo modificado em `docs/evidence/control-source.json`, conferíveis por `npm run check:source`. Consequência: alterações posteriores são detectáveis sem copiar conteúdo privado ou modificar o Control. O inventário não substitui o commit solicitado em 0.2 nem cobre todos os arquivos da futura extração.

## 025 Resultado local do spike 3

Data: 12/09/2026. Resultado: política `autogroup:member` para `autogroup:self` em TCP 4740 aprovada localmente com Headscale 0.29.3 e tsnet 1.102.0. Mesmo usuário conectou, outro usuário e a porta 4741 foram bloqueados, peers ficaram ocultos, chave expirou por id e expiração do nó pôde ser desabilitada. A API não alterou a política em modo arquivo. Decisão: manter a política planejada, sem recorrer a grants explícitos por usuário.

Correção de contrato: `POST /api/v1/node/{id}/expire` recebe `expiry` e `disableExpiry` como parâmetros de URL, conforme o [contrato REST oficial](https://github.com/juanfont/headscale/blob/v0.29.3/proto/headscale/v1/headscale.proto) e a execução real. Corpo JSON não é o transporte desses campos. A atualização da política em modo arquivo retorna HTTP 500 com mensagem de desativação nesta versão. O teste verifica a mensagem e a preservação do conteúdo.

Limites: Docker local em macOS arm64, controle HTTP em loopback e DERP local de teste com certificado fixado por SHA-256. A tentativa sem relé funcional não conectou neste ambiente. Não aprova TLS de produção, DERP embutido do Headscale, LTE ou aparelhos. A suíte ampliada, incluindo persistência do módulo móvel experimental, passou em 35,830 s.

## 026 Estado dos demais spikes ao passar o contexto

Data: 12/09/2026. Spike 1 parcialmente preparado: API Go experimental, interfaces Java e Objective-C geradas por gobind e scripts de build. A API foi exercitada no desktop com eco e reabertura usando a mesma identidade. `Up` termina antes de o mapa de peers necessariamente estar disponível, então o experimento espera o peer dentro do prazo do teste de eco. Isso não substitui execução nativa.

Spikes 1 e 2 sem aceite em aparelhos. Spikes 4 e 5 sem WebView nativo validado. Spike 6 sem submissão ou revisão externa. Spike 7 sem instaladores assinados e notarização. Spike 8 sem proxy completo e sem soak de 24 horas. Nenhuma alternativa de produto foi escolhida por falta de ferramentas ou aparelhos. A Fase 0 permanece aberta e a extração não começou.

## 027 Início antecipado da Fase 1 autorizado

Data: 12/09/2026. Contexto: a Fase 0 continua aberta por depender de aparelhos, toolchains móveis, contas e ensaios externos. O usuário autorizou avançar para a próxima etapa. Decisão: iniciar a Fase 1 e preservar cada pendência da Fase 0 como não aprovada. Consequência: tarefas locais independentes podem avançar, mas nenhuma evidência do desktop substitui aceite móvel, assinatura, loja ou soak.

## 028 Vite atualizado após auditoria

Data: 12/09/2026. Contexto: Vite 5.4.8, herdado do protótipo, produziu uma vulnerabilidade alta e uma moderada no `npm audit`, ambas ligadas ao servidor de desenvolvimento. Decisão: usar Vite 7.3.6 e plugin React 5.2.0, mantendo React 18.3.1 e o alvo Safari 16. Alternativa: permanecer no Vite 5 com risco conhecido ou aplicar uma correção que ainda deixava alertas posteriores. Consequência: a tarefa 1.3 deve portar e executar todos os checks de navegador para detectar incompatibilidades com a versão nova. A auditoria ficou limpa nesta fundação.

## 029 Marca usada como ícone provisório

Data: 12/09/2026. Contexto: a tarefa 1.1 precisava de ícones e a marca Cialai já existe no repositório de marketing. A imagem `cialai-mantis-v4-1-head.png` contém JPEG apesar da extensão. Decisão: copiar como fonte, converter para PNG verdadeiro e gerar os formatos pelo Tauri. Consequência: os ícones permitem builds nos três sistemas, mas continuam provisórios até a tarefa 1.7 conferir margens, legibilidade e capturas.

## 030 Aceite Rust pela suíte elegível, não por contagem congelada

Data: 12/09/2026. Contexto: o planejamento registrava 137 testes Rust, mas a origem conferida contém 138 casos no `HEAD` e quatro adicionados no working tree preservado, totalizando 142. Stack, reuniões e VPN concentram 28 desses casos e saem do produto; o recorte elegível contém 114. Decisão: aceitar a extração por zero falhas na suíte elegível e por justificativa explícita dos ignores, mantendo a contagem real como evidência em vez de criar testes artificiais para alcançar 137. Consequência: a tarefa 1.2 compila 120 casos depois de seis testes novos dos contratos Cialai; 118 passaram e dois ensaios externos herdados ficaram ignorados. As contagens crescerão com os backends por sistema e não serão tratadas como interface estável.

## 031 SheetJS oficial e ferramentas de teste sem alertas conhecidos

Data: 12/09/2026. Contexto: a extração do visualizador de planilhas trouxe `xlsx@0.18.5` do registry npm, que a auditoria marcou com prototype pollution e ReDoS, sem correção disponível naquele registry. A documentação oficial informa que o CDN do SheetJS é a fonte autoritativa e oferece `xlsx@0.20.3` como tarball para npm. O `esbuild@0.21.5` herdado pelos checks também tinha um alerta moderado no servidor de desenvolvimento. Decisão: fixar `xlsx` no tarball oficial `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` e `esbuild` em 0.28.2. Consequência: `npm audit --audit-level=moderate` volta a zero alertas; o lockfile depende do CDN oficial do SheetJS e builds offline exigem o cache npm, condição a rever se o pacote for vendorizado.

## 032 Build móvel no Codemagic absorve os spikes móveis restantes

Data: 13/09/2026. Contexto: os spikes 1, 2, 4, 5 e 6 permanecem sem execução real por falta de Xcode completo, SDK Android, aparelhos, credenciais e distribuição externa neste host. Criar hosts descartáveis separados repetiria a integração que os aplicativos finais e seus pipelines precisam provar. Decisão: os builds móveis do Codemagic serão o ponto único de compilação, assinatura e distribuição que absorve esses cinco spikes. A geração real de XCFramework e AAR cobre a parte de build do spike 1; builds internos instalados em iPhone e Android cobrem as transições do spike 2 e os proxies WebView dos spikes 4 e 5; o build iOS final distribuído a um grupo externo do TestFlight executa o spike 6. Os workflows previstos continuam `ios-testflight`, `ios-archive` e `android-play`, com a geração dos artefatos Go como dependência anterior do mesmo fluxo.

Limite da decisão: Codemagic produzir um artefato verde não aprova comportamento em aparelho. Cada spike só muda para aprovado com logs e medições do roteiro correspondente em iPhone ou Android real; o spike 6 exige distribuição externa e retorno da revisão. Até essas execuções existirem, a decisão consolida o caminho de execução, não o resultado.

## 033 Soak curto orienta o proxy, mas não substitui 24 horas

Data: 13/09/2026. Resultado observado: o proxy real em loopback manteve oito WebSockets por 1.800,064 segundos. Depois do aquecimento, foram 180 rajadas de 50 MiB, compostas por 9.000 quadros de 1 MiB e 9.437.184.000 bytes enviados e ecoados. Não houve desconexão atribuída ao proxy nem erro inesperado do backend. O RSS foi de 49.299.456 a 62.767.104 bytes, com pico de 63.569.920 e crescimento final de 13.467.648; o heap foi de 2.459.656 a 1.673.648 bytes, com pico de 2.720.568.

Decisão: conservar a carga como suíte opt-in configurável, com padrão de 24 horas, e usar o ensaio de 30 minutos apenas como regressão local. Alternativa rejeitada: aceitar o spike 8 pela execução curta e pelo heap sem crescimento. Consequência: o resultado reduz o risco imediato e fornece uma linha de base, mas o aceite continua condicionado a `CIALAI_SOAK_DURATION=24h` sem desconexões e com memória estabilizada.

## 034 Dependências externas permanecem critérios de aceite explícitos

Data: 13/09/2026. Decisão: registrar separadamente tudo que a árvore local não consegue provar. O fluxo móvel depende do repositório conectado ao Codemagic, máquinas `mac_mini_m2`, App Store Connect com o app Cialai e API key, identidade e perfis de assinatura, grupo externo do TestFlight, conta e app no Google Play, service account, SDK e NDK compatíveis e ao menos um iPhone e um Android físicos. Os roteiros de rede dependem ainda de Headscale acessível por TLS válido, DERP funcional e redes Wi-Fi e LTE reais. App Review, revisão jurídica de exportação e contas de loja são decisões externas à compilação.

Para a matriz desktop, Linux depende de espaço local acima de 5 GiB ou runner Ubuntu 22.04 equivalente; Windows depende de runner Windows ou `cargo-xwin`, WebView2, LibreOffice e validação real das APIs de arquivos. Decisão consequente: CI, mocks, checks estruturais e código preparado não serão promovidos a comportamento verificado. Cada dependência permanece pendente no handoff até existir artefato, log ou medição da plataforma correspondente.
