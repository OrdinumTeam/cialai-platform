# Broto: validação local

Data: 28/10/2026. Implementação local exercitada no macOS, em VM Windows 11 e em VM Linux amd64. Esta evidência não substitui os aceites físicos do checklist em `docs/broto/08-roteiro.md`.

## Código entregue

| Tarefa | Fonte e integração |
| --- | --- |
| BRO-001 e BRO-002 | Identidade broto, registro v3 compatível com v2, tokens cbt1 e guarda de rotas |
| BRO-003 | Código CIALAIB2, dez minutos, chave fixada ao primeiro pedido, aprovação e recusa por consulta curta |
| BRO-004 | cmd/cialai-broto, estado privado, pathmgr, QUIC, cliente Tor próprio e IPC local protegido |
| BRO-005 e BRO-006 | internal/brotorpc e brotoexec, canal reverso, hello versão 1, exec limitado com prazo e código de saída |
| BRO-007 | PTY Unix real no macOS e Linux; ConPTY executado no Windows, com resposta DSR e drenagem |
| BRO-008 | Mapeamento remoto no TerminalManager, origem da sessão, OutputLink existente e roteamento da ponte do celular |
| BRO-009 | Níveis read, confirm e free, teto local, pausa sem encerrar processos, desconexão e auditoria sem argumentos |
| BRO-010 | Seção Brotos, código, aprovação de vínculo e comando, nível de acesso e abertura de terminal |
| BRO-011 | Sete ferramentas MCP por stdio, IPC do hospedeiro com ator ai fixado e sem métodos administrativos |
| BRO-012 | Build de quatro alvos, Tor, monitor, serviço, assinatura separada, instalador, atualização verificada e workflow sem latest |
| BRO-013 | Monitor Tauri com conectar, aguardar, acompanhar, pausar, retomar e desconectar |

## Comandos e resultados

A suíte integral `npm test` passou com Node 22 e sem as variáveis de perfil dos agentes herdadas do processo de desenvolvimento. Foram 459 testes de UI, 487 testes Rust aprovados e oito ignorados, além de 372 testes móveis em 33 suítes. Os checks de documentação, integração, protocolo, i18n, lint e build que fazem parte desse comando também passaram.

```sh
env -u CODEX_HOME -u CLAUDE_CONFIG_DIR npm test
npm run check:text
git diff --check
```

A execução inicial sem essa limpeza falhou no teste `the_card_reads_the_agent_and_the_account_picked_in_the_menu`: o perfil herdado dispensava o menu que o teste esperava. O teste isolado e a suíte integral passaram sem essas variáveis, sem alterar a implementação de perfis.

`go test ./...` e `go test -race -p 1 ./...` do módulo passaram. Os testes com detector de concorrência das áreas Broto, pareamento, borda, sidecar, MCP e IPC também passaram. Uma rodada paralela ampliada teve uma corrida de sincronização no teste entre hello do cliente e registro no hospedeiro; a espera foi corrigida para observar as duas pontas. Sob carga, uma proteção preexistente de pareamento atingiu o fechamento do transporte; o pacote foi repetido e passou. Os logs completos e relatórios de execução ficam no histórico interno ignorado pelo Git.

`TestBrotoDaemonPairsExecutesPausesAndForgets` prova daemon e hospedeiro locais com QUIC, código, aprovação, execução pela IA aguardando decisão, pausa e desconexão. `TestBrotoDaemonTorFallbackAndPrivateRestart` usa SOCKS5 de teste e TLS real, cobrindo a reserva, estado privado, reinício e revogação. `TestBrotoReverseRPCOverBothTransports` prova execução e código de saída nos dois transportes.

Os testes de PTY usam terminal Unix real, mantêm processos existentes durante pausa, recusam escrita pausada e encerram processos ao desconectar. A saída final é drenada em blocos de 64 KiB mesmo depois da saída do processo. IDs remotos persistidos impedem reutilização após reconexão ou reinício.

Na VM Windows 11 ARM64, os executáveis x64 rodaram sob uma conta comum de teste. Passaram execução com stdout, stderr, prazo e código de saída, árvore de processos, pausa, ConPTY e drenagem final acima de 64 KiB. A drenagem também passou em vinte repetições. Os testes de borda executaram QUIC direto e a reserva TLS com SOCKS local. O IPC do hospedeiro passou em named pipes reais, incluindo ator IA obrigatório, recusa de métodos administrativos e JSON escapado de 3 MiB. A proteção do diretório de estado removeu permissões herdadas amplas e conservou acesso somente ao usuário. Isso prova Windows 11 atual; o console antigo de `windows-2022` continua exigindo seu próprio ensaio.

Na VM Linux amd64, treze pacotes passaram sob UID e GID 1000, com processos e PTY reais, assinatura Minisign e reinício da CLI pelo supervisor após troca de versão. A VM usa Alpine e QEMU com emulação x64, sem Docker nem serviços do hospedeiro. As correções de quota de aprovação e parada graciosa foram repetidas nos pacotes afetados. Os testes Linux não usaram detector de concorrência; esse detector foi executado separadamente no macOS.

O monitor passou em build Vite, cargo check e testes de IPC e do comando de instalação. A conferência visual por Playwright usou fixture de IPC: conectar, conferir dígitos, acompanhar, pausar, retomar e desconectar, incluindo largura de 360 pixels. A aprovação permaneceu acionável enquanto uma abertura de terminal aguardava decisão. Esses testes não são evidência de aplicação nativa entre máquinas.

O monitor nativo macOS também executou o fluxo completo com WebKit, IPC protegido, daemon, borda e hub reais. A prova conferiu os dígitos nos dois lados, aprovação, abertura de terminal, pausa observada pelo hospedeiro, recusa de mutação durante pausa, retomada e revogação. A janela encerrou naturalmente e o daemon continuou disponível. O laboratório não usa a janela completa do desktop como hospedeiro.

No Windows, o monitor WebView2 foi exercitado em dois contextos. Sob conta comum, a execução agendada passou por pareamento, comandos, PTY, pausa, retomada e revogação; a sessão sem desktop não encerrou naturalmente a janela. Na sessão gráfica já aberta, foram conferidos WinSta0, desktop Default e visibilidade, e todos os controles passaram, com saída natural de código zero e daemon sobrevivente. Como essa conta estava elevada, a execução remota foi corretamente recusada; nenhum PTY foi aberto nessa rodada gráfica. Tentativas de transportar uma conta comum entre sessões não carregaram a página e não foram contabilizadas como aprovação. A prova gráfica não afirma um logon interativo novo com essa conta comum.

Claude Code 2.1.312 chamou o adaptador MCP real por stdio, listou o Broto na VM Windows e executou `cmd.exe /d /c echo BROTO_CLAUDE_WINDOWS_OK`. O hospedeiro observou o ator IA e manteve a execução aguardando aprovação. Após a decisão, o Claude recebeu a saída e o código de saída. A configuração do MCP foi temporária e não alterou o cadastro permanente do usuário. A prova usa a borda, o hub e o IPC reais do hospedeiro macOS, sem substituir o MCP por fixture.

Instalação e atualização têm testes de assinatura, checksum, alvo, versão, extração e falha de codesign. Um ensaio com chave minisign efêmera confirmou verificação real e recusa de adulteração. A assinatura upstream do Tor e os hashes dos quatro alvos foram conferidos. Nenhuma chave de produção foi usada.

No Windows, o instalador assinado de teste criou um serviço SCM real sob conta comum. O IPC identificou o filho do supervisor registrado no SCM, e a conta comum recebeu acesso negado ao tentar alterar a configuração do serviço. A atualização assinada de 0.0.1 para 0.0.2 substituiu o filho e preservou o supervisor. Um candidato com executável inválido foi recusado e a versão anterior voltou saudável, mantendo o mesmo supervisor. A reinstalação após trocar a senha da conta também passou. Serviço, tarefa de atualização e estado privado do ensaio foram removidos ao terminar.

No macOS, um LaunchAgent com identificador exclusivo de teste iniciou a CLI real. Foram conferidos PID, pausa e retomada, reinício por KeepAlive e registro do job periódico. Os jobs foram removidos ao terminar. Nenhuma instalação existente foi substituída.

No Linux, uma VM Debian 13 com systemd 257 executou a instalação sob UID 1000. As units e o timer gerados foram ativados, o PID do IPC correspondeu ao MainPID e o reinício criou uma nova instância saudável. O job de atualização recebeu uma versão 0.0.2 por HTTPS com assinatura Minisign real. Uma versão 0.0.3 assinada, mas com executável inválido, foi recusada e o serviço voltou à 0.0.2 saudável. As três units do ensaio foram removidas ao terminar. A imagem oficial foi conferida por SHA512; o laboratório não usou Docker nem alterou serviços do Mac.

Os testes de recuperação usam candidatos que encerram imediatamente ou nem iniciam, verificam a saúde da versão anterior antes de retornar do rollback e encerram descendentes quando o IPC deixa de responder. Passaram no macOS com detector de concorrência, no Windows e no Linux. No Windows, a troca dos arquivos de ponteiro também foi testada enquanto outro processo mantinha o arquivo aberto.

## Instalação local do monitor Windows

Em 28/10/2026, após os ensaios isolados, o usuário solicitou uma instalação persistente na VM Windows. O monitor 0.1.0 foi recompilado sem a feature selftest, com a arte própria do Broto aprovada pelo usuário. O instalador NSIS terminou com código zero, registrou a desinstalação e criou atalhos na área de trabalho e no menu Iniciar. A janela instalada abriu na sessão gráfica e foi conferida visualmente com o novo ícone.

O executável instalado corresponde ao build com o marcador NSIS aplicado pelo empacotador. Todos os arquivos do payload do serviço conferiram com o manifesto, sem arquivos faltantes ou hashes divergentes. O payload usa assinatura Minisign local; a chave privada efêmera foi removida após o empacotamento. Isso não constitui assinatura Authenticode ou release oficial.

O serviço desta instalação permanece inativo e esta instalação ainda não foi pareada. Nenhuma conta foi criada ou alterada. A VM e a janela foram deixadas abertas ao concluir a instalação do monitor. A conta de execução segue a decisão 072.

Os resultados completos e a captura da janela estão no histórico interno ignorado pelo Git. Após a troca do ícone, passaram o build Vite, o build Windows release, o teste de encenação do payload, os 459 testes de UI, o check de texto e o check de whitespace.

## Decisões de implementação

O código ficou na branch local, sem commit ou publicação. A sequência de execução e as decisões foram guardadas no histórico interno. A rota /broto deixou de ser a reserva indisponível da primeira etapa e agora serve o protocolo negociado. Os limites de JSON do sidecar e da RPC reversa são 4 MiB, suficientes para duas saídas de 256 KiB com escape JSON.

A janela usa a arte própria aprovada do Broto, cuja fonte está documentada em [Interface](../../broto/05-interface.md). A atualização é acionada pela CLI em processo separado, com verificação periódica a cada seis horas, assinatura, trava de instalação, confirmação de saúde e rollback. A inicialização do serviço resolve a versão ativa por um supervisor estável, sem conceder à conta comum permissão para alterar a conta de execução do serviço Windows.

A execução nas VMs identificou e corrigiu problemas que a compilação cruzada não mostrava: perda do último evento de revogação no fechamento do QUIC, consumo indevido da quota durante espera de aprovação, permissões do diretório de estado Windows, prazo total do IPC e espera de named pipe ocupado. As regressões correspondentes entraram nas suítes. O hospedeiro confirma a revogação antes de responder `disconnected.ack`; consultas válidas ainda aguardando decisão não esgotam a quota de tentativas.

## Aceites ainda externos

Não foram executados dois computadores físicos, NAT entre redes distintas, rede Tor pública com este Broto, ConPTY no runner windows-2022, assinatura e notarização de distribuição, release ou publicação do site. O site e o workflow permanecem preparados localmente. Os logs completos e relatórios das VMs ficam no histórico interno ignorado pelo Git, sem copiar perfis, capturas ou credenciais para a documentação pública.
