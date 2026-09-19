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
| 014 | Preparado | Desde 14/09/2026 o Info.plist declara criptografia isenta de documentação, sem distribuição na França; declaração francesa e confirmação jurídica pendentes |
| 015 | Implementado | Marca, acento, sessões e ANSI aplicados |
| 016 | Implementado | Em 14/09/2026 o GitHub Actions publicou a prévia `v0.1.0` e o Codemagic enviou o build 1 ao TestFlight interno e o AAB à faixa interna do Play |
| 017 | Implementado | Entrada pública em inglês e interface em três idiomas estão integradas |
| 018 | Implementado | Tokens `--mac-*` foram mantidos |
| 019 | Pendente | Atalhos Linux e Windows dependem da integração da Fase 5 |
| 020 | Implementado | Arraste para fora segue só no macOS; desde 14/09/2026 a leitura de arquivos pelo celular também vale no Windows pela tarefa 6.4 |
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
| 032 | Preparado | Codemagic concentra os builds móveis; execução em aparelhos permanece pendente |
| 033 | Preparado | Soak curto registrado; execução contínua de 24 horas permanece pendente |
| 034 | Preparado | Dependências externas e critérios de aceite continuam explícitos |
| 035 | Implementado | Português do Brasil, inglês e espanhol neutro adotados nas interfaces, no núcleo nativo do desktop e nos metadados do app móvel |
| 038 | Implementado | Estado de atividade derivado de `agentTurn` e `outputAgeMs`, com leitor único no Rust e função pura única na interface |
| 039 | Implementado | Caixa de texto do celular com Inserir e Enviar como ações separadas, na página e sem passar pelas lojas |
| 040 | Implementado | Apresentação do card com o Rust como fonte de verdade, e `list_dirs` devolvendo só nomes de pasta dentro de limites do servidor |
| 041 | Implementado | O app móvel abre sempre no início, substituindo o trecho Abertura do app da decisão 037 |
| 042 | Implementado | Troca de conta dos agentes por escolha de pasta, sem tocar em credencial, valendo para sessões novas |
| 043 | Implementado | Grafo da documentação numa aba do estúdio, só com Markdown e as pastas que levam até eles |

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

Atualização em 14/09/2026, tomada na execução noturna e pendente de confirmação do usuário e do jurídico. O primeiro envio ao App Store Connect foi recusado com o erro 90592: com `ITSAppUsesNonExemptEncryption` verdadeiro a Apple exige `ITSEncryptionExportComplianceCode`, que só nasce de uma declaração aprovada. A API recusou criar a declaração com a mensagem de que ela só existe para criptografia proprietária ou para criptografia de terceiros com distribuição na França. Pela tabela da Apple, algoritmos padrão fora da App Store da França não exigem documento, e a orientação para esse caso é declarar `ITSAppUsesNonExemptEncryption` falso, que no vocabulário da Apple significa isento de documentação. O app passou a declarar falso. Continuam valendo o enquadramento em mercado de massa e o relatório anual de autoclassificação, que não dependem do Info.plist. Antes de distribuir na França, a conta precisa enviar a declaração francesa de criptografia, criar a declaração no App Store Connect com `availableOnFrenchStore` verdadeiro, voltar o Info.plist para verdadeiro e incluir o código aprovado.

Nota em 15/09/2026, da tarefa CON-050 e pendente da mesma confirmação jurídica. O app iOS passa a embutir o Tor em processo pelo Tor.framework 409.11.2, com tor 0.4.9.11 e OpenSSL 3.6.3. O Tor é software aberto e publicamente disponível e usa só algoritmos padrão e publicados, como TLS 1.2 e 1.3, AES, RSA, Curve25519, Ed25519 e as famílias SHA, pela OpenSSL e pelo próprio código aberto do Tor, sem criptografia proprietária. O enquadramento acima não muda: algoritmos padrão fora da App Store da França, `ITSAppUsesNonExemptEncryption` falso, mercado de massa e relatório anual, e a conclusão jurídica continua pendente. Precedente registrado: o Onion Browser, navegador que embute o Tor pelo mesmo Tor.framework, é distribuído na App Store há anos. O precedente mostra que a revisão da Apple aceita app com Tor embutido; ele não prova como aquele app declarou a conformidade de exportação e não substitui a confirmação jurídica.

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

Atualização em 14/09/2026: a tarefa 6.4 ligou no Windows o backend Win32, que abre cada alvo sem seguir reparse points, confere o caminho final do handle dentro da raiz e recusa hard links, com testes na suíte Rust. O arraste para fora continua só no macOS.

## 021 Extração a partir do working tree do Control

Contexto: oito arquivos do Control estão modificados sem commit, incluindo `browser.rs`, `office.rs`, `prefs.rs` e `runtime.js`. Decisão: extrair do working tree e pedir ao usuário o commit antes da Fase 1. Consequência: a origem de cada arquivo fica rastreável por commit.

## 022 Toolchain Go corrigida na execução

Data: 12/09/2026. Contexto: o planejamento fixava Go 1.24 com `tailscale.com` 1.102.0, mas o [go.mod oficial dessa versão](https://github.com/tailscale/tailscale/blob/v1.102.0/go.mod) exige Go 1.26.5. Decisão: manter o cliente planejado e usar Go 1.26.5 no módulo e no CI. Alternativa: reduzir a versão do cliente e repetir a análise de compatibilidade. Consequência: o Go global 1.26.3 baixa automaticamente a toolchain 1.26.5 quando `GOTOOLCHAIN=auto`; nenhum Go global foi substituído.

## 023 Fundação separada do aceite do produto

Data: 12/09/2026. Contexto: os spikes exigem aparelhos reais, Xcode, assinatura e revisão externa antes da extração. Decisão: criar workspaces mínimos e experimentos explícitos em `packages/tunnel-core/spikes`, com CI da fundação sem simular testes de produto inexistentes. Consequência: `npm test` aprovado nesta etapa não representa paridade com Control. O resultado de cada spike e suas limitações fica no registro de progresso.

## 024 Inventário verificável da origem antes do commit

Data: 12/09/2026. Contexto: os oito arquivos do Control continuam modificados e a origem é somente leitura. Decisão: guardar o commit base e SHA-256 de cada arquivo modificado num inventário interno, conferíveis por `npm run check:source`. Consequência: alterações posteriores são detectáveis sem copiar conteúdo privado ou modificar o Control. O inventário não substitui o commit solicitado em 0.2 nem cobre todos os arquivos da futura extração.

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

## 035 Interface em português do Brasil, inglês e espanhol neutro

Data: 13/09/2026. Contexto: a tarefa 6.6 previa preparar a tradução para inglês, mas a interface precisa atender também usuários de língua espanhola sem fragmentar o produto por região. Decisão: adotar português do Brasil como idioma padrão e fallback, com inglês e espanhol neutro como alternativas. Variações regionais de inglês e espanhol são normalizadas para os respectivos idiomas. O primeiro uso segue o idioma do sistema quando compatível. A escolha fica no Secure Store da casca móvel e no armazenamento local das interfaces web e desktop. Cialai, Headscale, Claude Code e Codex conservam seus nomes.

Alternativa rejeitada: dicionários próprios no Rust, no Expo e nos checks, mantidos à mão, porque divergiriam a cada texto novo.

Consequência: `@cialai/i18n` é a fonte única, com dicionários separados por idioma e área e a mesma API pública. O núcleo Rust embute o catálogo das chaves `native.*` gerado por `tools/i18n/native-catalog.mjs` e segue o idioma enviado pela interface, que fica gravado para o menu de início e a confirmação de saída da próxima abertura. O app móvel gera os textos de permissão por idioma pelo campo `locales` do Expo e declara as mesmas línguas no Android por `localeConfig`. `check:i18n` exige as três línguas com as mesmas chaves, valores e placeholders, confere os valores de cada chamada e rejeita textos literais e chaves sem uso; `check:native-i18n` confere o catálogo gerado e as chamadas do Rust. Erros do sidecar e do supervisor com código estável são traduzidos na interface desktop, e erros do protocolo trazem código para a interface traduzir. Mensagens detalhadas criadas pelo computador seguem o idioma escolhido no computador, inclusive quando chegam ao celular. Textos de lojas e políticas em espanhol ficam fora desta decisão e continuam pendentes.

## 036 Primeira submissão às lojas sem ambiente dedicado de revisão

Data: 16/09/2026. Contexto: a ficha das duas lojas estava pronta em pt-BR e o `docs/review/desktop-demo-runbook.md` previa um computador dedicado, acordado e alcançável, para o revisor pareá-lo. Montar esse ambiente é trabalho do responsável e não estava feito. O Cialai se encaixa em três critérios de app restrito do Google: código QR, biometria e ação em outro aparelho.

Decisão: declarar o acesso como restrito nas duas lojas, informar que não existe credencial e instruir o revisor a instalar o app desktop gratuito e parear por conta própria. A App Store recebeu a versão longa dessas instruções no campo de notas; o Google Play recebeu a mesma substância aparada para os 500 caracteres do campo.

Alternativa rejeitada: adiar a submissão até o ambiente dedicado existir.

Consequência: as duas submissões entraram em revisão em 16/09/2026, App Store com a 0.2.2 build 5 e Google Play com a ficha mais dez declarações, tendo a 0.2.2 `versionCode` 15 na faixa interna. Este é o maior risco de rejeição das duas, porque o revisor pode não conseguir ver o terminal funcionando. Se a rejeição vier por acesso, o caminho é o runbook, que continua íntegro no repositório.

Duas respostas ficaram como julgamento e merecem revisão se a classificação for contestada. No questionário da IARC, conteúdo online foi respondido como ausente, tratando o Cialai como app de acesso remoto à máquina do próprio usuário, no mesmo critério de clientes de terminal e desktop remoto. Na Apple, acesso irrestrito à web foi respondido como falso, com apoio no `webview.test.ts`, que trava a WebView em uma origem loopback única e não abre navegação externa. As duas lojas devolveram classificação livre.

Palavras chave da App Store foram escolhidas junto com a categoria, sem medição de desempenho na busca, e estão registradas em `docs/stores/listing-pt-BR.md`.

## 037 Tela inicial do app como hub e destino do voltar

Data: 16/09/2026. Contexto: a raiz do app era a lista de computadores, o app abria direto no WebView do terminal, Ajustes era um link de texto no canto da lista e Vincular ficava no fim da rolagem. Sair do terminal fechava o proxy e a conexão inteira, então não existia ir a um hub e voltar barato. Não havia ícones no app.

Decisão: a casca ganha o estado `home` em `src/state/machine.ts` e a tela `src/screens/Home.tsx`, com título grande, o card Continuar com o último computador, o ponto de estado e o chip de transporte, e quatro cards de altura mínima 92: Computadores com a contagem, Vincular, Terminal e Ajustes. Todos os botões de volta apontam para o início com o rótulo Início: barra do terminal, botão Voltar do Android na lista de sessões, Ajustes, Sem conexão, Vincular e um voltar novo na lista de computadores. A tela sem conexão oferece Início e os atalhos Computadores, Ajustes e Vincular.

Abertura do app: começa no início só quando não há `lastDesktopId` ou quando a última conexão falhou, marca gravada no Secure Store em `cialai.lastConnectionFailed` sempre que a casca vai para a tela sem conexão e apagada quando o proxy abre. Nos demais casos abre direto no terminal, porque é onde a pessoa quer chegar e `App.test.js` espera o WebView na abertura. Depois do pareamento o app segue para o terminal, como antes.

Ir ao início não derruba a conexão: `App.tsx` guarda o proxy por `HOME_PROXY_GRACE_MS`, 90 segundos, e um temporizador chama `closeDesktop` se a pessoa não voltar. Voltar ao terminal dentro do prazo refaz `Connect` e `OpenDesktop` e o núcleo devolve a mesma URL, porta e nonce, então a página recarrega com o cookie que já tem e sem novo pareamento do proxy. Abrir outro computador fecha o proxy guardado na hora. O card Continuar mostra Desconectar enquanto o proxy está guardado, que é o encerramento explícito.

Ícones: glifos simples desenhados só com `View` no acento da paleta, em `Home.tsx`, para monitor, código QR, janela de terminal e controles. Alternativa rejeitada: uma dependência de ícones, porque o app não tinha nenhuma e quatro glifos não justificam uma biblioteca nem o peso no build nativo.

Consequência: `docs/arquitetura/05-mobile.md` e os roteiros de teste citam o início como raiz da navegação; a chave `mobile.offline.switchDesktop` e as chaves `mobile.shell.desktops` e `mobile.shell.showDesktops` saem dos dicionários, e as chaves `mobile.home.*`, `mobile.loading.detail` e o novo valor de `mobile.pair.back` entram nos três idiomas. Capturas antes e depois em `docs/evidence/` continuam pendentes até existir aparelho ou simulador com o build.

## 038 O computador é a fonte única do estado de atividade da sessão

Data: 18/09/2026. Contexto: o card lia dois fatos de processo, existe processo em primeiro plano e chegou byte nos últimos 1500 ms pelo relógio local de cada cliente. Para um agente interativo esses fatos dizem o contrário do que a pessoa lê: o `claude` continua em primeiro plano depois de entregar a resposta, então as barras animavam do início até o `/exit`, e uma sessão `ssh` parada ou um REPL do `python` no prompt apareciam como Processo em execução. Depois de perder e recuperar a conexão o card continuava animando, porque a evidência de atividade era a de antes da queda, e a lista dizia Sessão desconectada para terminais vivos no computador enquanto cada um não fosse aberto.

Decisão: o computador passa a publicar o estado. `SessionMetrics` ganha `agentTurn`, lido dos arquivos que o próprio agente grava, e `outputAgeMs`, medido no relógio do computador. Os leitores puros saem da Barra de IA para `workspace/agent_state.rs`, e a Barra de IA passa a reexportá-los, então anel e card leem a mesma coisa. Na interface, `deriveActivity` em `packages/ui/src/terminals/activity-state.js` é a única função que decide rótulo, tom e animação, e o card, o cabeçalho do computador e o cabeçalho do celular usam o mesmo componente de indicador. Quando o turno do agente existe, ele decide sozinho; sem ele valem saída recente e CPU acima do piso. Silêncio nunca vira concluído e, sem amostra nova desde a conexão atual, nada anima. Métricas passam a valer para toda sessão com PTY vivo segundo `pty_list`, anexada ou estacionada, então a lista se corrige sem reanexar e sem repetir o replay.

Alternativa rejeitada: manter a inferência no cliente e apenas alargar a janela de saída. Ela não distingue um agente que terminou de um comando longo e quieto, e continuaria discordando entre computador e celular por usar dois relógios.

Consequência: as chaves `terminal.session.receivingOutput`, `terminal.session.processRunning`, `terminal.session.processStopped` e `terminal.session.ready` saem dos três dicionários e entram as oito chaves `terminal.session.activity.*`. O cabeçalho do terminal no celular ganha o indicador que não tinha. `packages/ui/scripts/tests/terminal-activity-state.test.cjs` cobre cada linha da tabela de estados, `packages/ui/scripts/check-session-card.mjs` confere o card real e `packages/ui/scripts/check-terminal-sync.mjs` cobre a queda e a volta da ponte com uma sessão selecionada e uma estacionada. A matriz manual no macOS, a conferência em aparelho e as capturas de evidência continuam pendentes.

## 039 Inserir e Enviar como ações separadas na caixa de texto do celular

Data: 18/09/2026. Contexto: digitar direto no terminal pelo celular é desconfortável e um Enter sem querer executa o que ainda estava sendo escrito. A página do celular não tinha compositor nem caixa de várias linhas: existiam a fileira de nove teclas, o botão Colar e a pílula de voltar ao fim. Também não estava claro se uma caixa de texto deveria entregar o conteúdo já executando ou apenas escrevendo.

Decisão: a caixa mora na página, em `packages/ui/src/terminals/ui/PhoneComposer.jsx`, e usa um `textarea` do próprio aparelho, que traz teclado, seleção, copiar e colar, autocorreção e o ditado do sistema sem nenhuma dependência nova. Duas ações separadas: Inserir escreve o texto e para ali; Enviar escreve o texto e, só depois de confirmada a escrita, manda o Enter numa segunda escrita. Dentro da caixa, Enter sempre quebra linha. A entrega passa pelo `paste` do xterm, que respeita a colagem entre colchetes e converte as quebras de linha, e um texto de várias linhas indo para um programa sem esse modo pede uma segunda confirmação, porque cada quebra executaria a linha anterior.

Alternativa rejeitada: uma ação única que sempre envia. Ela reintroduz exatamente o acidente que motivou o pedido, e não existe forma de revisar o texto no terminal depois que ele chega lá.

Consequência: a caixa chega ao celular com uma versão nova do desktop, sem build nativo e sem revisão de loja, porque a página é servida pelo computador. `submitText` e `bracketedPaste` entram em `runtime.js`, `writeTerminal` passa a devolver a promessa da escrita e a guardar em `session.lastWrite`, e a fileira de teclas continua igual. As chaves `terminal.phone.composer.*` entram nos três idiomas. `packages/ui/scripts/check-submit-text.mjs` exercita a entrega com o xterm de verdade e `check-phone-composer.mjs` cobre a caixa, o aviso de várias linhas e o rascunho por sessão. A conferência em aparelho continua pendente. Esta decisão é também o pré-requisito do ditado por voz, que entregará o texto transcrito nesta mesma caixa.

## 040 Apresentação do card no Rust e navegação de pastas por nome

Data: 18/09/2026. Contexto: as ações de terminal do computador não existiam no celular, porque o card no modo toque desligava menu de contexto, arraste, duplo clique e o botão de três pontos. Duas coisas impediam simplesmente ligá las. A apresentação do card era publicada só pelo computador e guardada em memória no Rust, então um nome dado pelo celular seria apagado pelo próximo `persist` do computador. E o seletor de pasta listava só as subpastas de primeiro nível de cada raiz de projeto: com a raiz apontando para Documentos, não havia como abrir uma sessão na própria Documentos nem subir um nível, que foi o caso relatado.

Decisão: o Rust passa a ser a fonte de verdade da apresentação, com uma `revision` atribuída a cada gravação. Quem grava recebe a revisão nova; quem lê adota a apresentação quando a revisão recebida é maior que a conhecida. `pty_presentation` entra na lista da ponte com nível de sessão, porque é apresentação de card e não toca em processo nenhum. Para a navegação entra um comando novo, `list_dirs`, que devolve o caminho normalizado, o pai quando permitido, as subpastas e a marca de truncado, com teto de 200. Os limites são do servidor: a árvore da pasta pessoal, as raízes de projeto e, no macOS, `/Volumes`; no Windows, as unidades montadas. Pasta oculta, nome com cara de segredo e link simbólico ficam de fora, e `..`, caminho relativo e caminho fora dos limites são recusados. Só nome de pasta sai daqui, nunca conteúdo de arquivo.

Alternativa rejeitada: deixar o celular publicar a apresentação sem revisão e resolver a disputa por quem escreveu por último no relógio. Os dois relógios não concordam, e o resultado seria o nome piscando entre as duas formas.

Consequência: o celular ganha o botão de três pontos com alvo de 44 px, o toque longo de 500 ms e a folha de ações com renomear, subtítulo, cor, fixar, mover, nova sessão nesta pasta, alterar pasta, copiar caminho, reiniciar e encerrar. O cabeçalho do terminal aberto usa o mesmo menu. O seletor passa a oferecer cada raiz e o modo navegar, nos dois lados. Listar nomes de pasta não amplia o que o celular alcança, porque ele já podia abrir um shell em qualquer pasta por `pty_spawn`; o limite existe para o seletor não virar um explorador do disco inteiro. `tools/check/desktop-extraction.mjs` passou a exigir que todo comando liberado na ponte tenha braço no despacho e nível em `sensitive.js`, nos dois sentidos. A conferência em aparelho continua pendente.

## 041 O app móvel abre sempre no início

Data: 18/09/2026. Contexto: a decisão 037 fez do início um hub, mas manteve a abertura condicional: sem `lastDesktopId` ou com a marca `cialai.lastConnectionFailed` o app começava no início, e nos demais casos ia direto ao terminal. Isso deixava a abertura imprevisível, montava a WebView e abria a conexão antes de qualquer toque, e escondia Computadores, Vincular e Ajustes atrás de um voltar.

Decisão: com pelo menos um computador vinculado, o app despacha sempre `show-home`. Sem computador nenhum continua indo para o pareamento, e depois de parear continua indo ao terminal. A marca `cialai.lastConnectionFailed` perde a função e é apagada do Secure Store uma vez, junto com `rememberLastConnection` e as chamadas dela. Este trecho substitui Abertura do app da decisão 037; o resto da 037 continua valendo.

Alternativa rejeitada: manter a abertura condicional e só melhorar o caminho de volta. Ela não resolve a imprevisibilidade, que é o incômodo relatado, e mantém a conexão sendo aberta sem a pessoa pedir.

Consequência: nenhuma conexão é aberta antes do toque em Continuar, o que também economiza bateria e tráfego quando o app é aberto por engano. `App.test.js` ganhou um auxiliar que toca em Continuar antes de esperar a WebView, mais dois casos: a abertura no início com o último computador saudável e sem WebView montada, e a limpeza única da marca antiga. `05-mobile.md` acompanha. A conferência em aparelho continua pendente.

## 042 Troca de conta dos agentes por escolha de pasta

Data: 18/09/2026. Contexto: quando o limite de uma conta é atingido, a única saída era abrir um terminal e exportar `CODEX_HOME` ou `CLAUDE_CONFIG_DIR` na mão. Esta máquina tem cinco pastas do Codex e sete do Claude, e nada na interface dizia qual delas cada sessão estava usando nem permitia trocar. O Codex CLI também não tem troca de conta embutida, e trocar o `auth.json` com uma sessão rodando arrisca a renovação de token gravar no perfil errado.

Decisão: o Cialai escolhe qual pasta o agente vai usar e nada além disso. Nunca move `auth.json`, nunca copia credencial e nunca lê o conteúdo de um arquivo de credencial. A conta ativa de cada agente vira a preferência `agents.activeProfile`, e um terminal novo nasce com as variáveis dela, aplicadas no Rust depois da limpeza de marcadores herdados. Conta padrão ativa remove as variáveis; uma nomeada as define. O cliente nunca envia variável nem caminho: manda o id do perfil, e o servidor resolve a pasta a partir da própria pasta pessoal e confere os marcadores. Um terminal já aberto não muda de ambiente; para ele existe a ação Abrir o agente neste perfil, que digita a linha montada por `resume::launch_command`, com a mesma citação por sabor de shell da retomada, e só com o shell no prompt. Uma tarefa em execução continua na conta em que começou.

Alternativa rejeitada: trocar o `auth.json` de lugar para o agente usar sempre a mesma pasta. Além de mexer em credencial, ela corrompe o perfil quando uma renovação de token chega no meio da troca.

Consequência: entram quatro comandos, `agent_profiles` como `read`, `agent_profile_select` e `agent_profile_create` como `session` e `pty_launch_agent` como `terminal`. `AgentProfileView` não carrega `accountKey`, token nem caminho de credencial, e um teste afirma exatamente o conjunto de campos que ela leva. Criar perfil cria a pasta vazia com permissão 0700 e abre um terminal já nela, onde o login é feito pelo próprio CLI; até os marcadores aparecerem, a conta fica listada como aguardando login. O card continua mostrando o perfil lido do processo real, então um arquivo de inicialização do shell que exporte a variável vence o valor injetado e o card mostra a verdade. A conferência com contas de teste de cada agente e no aparelho continua pendente, e o login do Codex pode depender de navegador no próprio computador.

## 043 Grafo da documentação numa aba do estúdio

Data: 19/09/2026. Contexto: um projeto com mil pastas e documentação espalhada em dez áreas não cabe na cabeça de ninguém pelo explorador, que mostra uma pasta por vez e não diz onde a documentação está. O Ordinum Control, o protótipo interno de onde este estúdio foi extraído, resolveu isso com um grafo de forças e o recurso ficou bom o bastante para virar produto.

Decisão: o grafo vem para o Cialai inteiro, com a mesma experiência. Mora numa aba virtual da área central, no molde do Dev Browser, e não numa janela nem numa seção da casca. Os nós são a união dos Markdown com seus ancestrais até a raiz: ramo que não leva a nenhum `.md` fica fora. A varredura é do Rust, em `workspace/docgraph.rs`, por caminhos e metadados, sem abrir arquivo nenhum; a hierarquia podada é montada na interface por função pura. O motor é o `d3-force` sobre canvas, carregado por `import()` só quando o painel monta, e a câmera veio do mapa do protótipo.

Alternativa rejeitada: ler os links entre os Markdown e desenhar o grafo de referências. Ela responde outra pergunta, exige abrir todo arquivo e não mostra onde a documentação mora. Ficou no roadmap, por cima da hierarquia física.

Consequência: entram dois comandos locais, `docgraph_scan` e `docgraph_cancel`, que **não** são liberados na ponte: o grafo é do computador, como o editor e o Dev Browser. `.gitignore` não é aplicado, porque os projetos da casa guardam documentação legítima fora do Git, como `_INTERNO_ORDINUM/`. Pasta simbólica nunca é percorrida, o que também elimina ciclos, e uma varredura parcial nunca se passa por completa. A `files.rs` abriu `SKIP_DIRS`, `is_noise`, `absolute` e os construtores de `FsError` para o módulo novo, sem refatorar o `build_index`. O `runtime.js` ganhou `watchPathAs` com dono, para o explorador não soltar um observador que o grafo ainda usa. São 107 chaves `terminal.docgraph.*` nos três idiomas, 24 testes do Rust e 29 verificações em `check-docgraph.mjs`. O documento canônico é `docs/arquitetura/16-grafo-da-documentacao.md`.
