# WIN-01: desktop no Windows

Estado: primeira execução em Windows real registrada em 24 e 25/09/2026, numa máquina virtual. Cinco defeitos encontrados e corrigidos no working tree, cada um provado com um build cruzado instalado na mesma máquina. Windows 10 e máquina x64 física seguem pendentes.

A rodada completa, com diário, capturas e os scripts que dirigem a máquina, fica fora do Git em `/Volumes/ORDINUM-SSD/Emulators/Desktop/Windows11/tools/campanha-2026-09-24/`. O relatório é o `relatorio.md` dessa pasta.

## Ambientes

| Código | Origem | Edição e build do Windows | GPU | WebView2 | Data |
| --- | --- | --- | --- | --- | --- |
| A1 | VM UTM em Mac M4, Windows ARM64 com o Cialai x64 sob emulação | Windows 11 Pro 24H2, build 26100.4349, pt-BR | Por software, sem driver de vídeo dedicado; o WebGL do xterm não carrega | 137.0.3296.68 | 24 e 25/09/2026 |
| A2 |  |  |  |  |  |

Os tempos medidos em A1 valem só como comparação entre cenários na mesma máquina. Numa máquina x64 o app e o WebView2 rodam nativos.

## O que o 0.2.9 publicado fazia em A1

| Sintoma | Causa | Correção no working tree |
| --- | --- | --- |
| Teclado e roda do mouse mortos em todo o app, cliques funcionando | `lib.rs` pedia foco ao webview em resposta ao próprio `Focused(true)`, que no Windows o Tauri sintetiza a partir do `GotFocus` do WebView2; o foco oscilava 69 vezes em 45 s entre as duas janelas do WebView2 | chamada limitada aos outros sistemas |
| Terminal sem cores e com fonte proporcional | o Tauri acrescenta ao `style-src` o hash do `<style>` do `index.html`; com hash presente o navegador ignora `'unsafe-inline'` e bloqueia a folha que o xterm injeta | `dangerousDisableAssetCspModification: ["style-src"]` |
| `claude` instalado e não encontrado até reiniciar ou configurar Prefixos do PATH | lista de pastas padrão vazia no Windows e PATH copiado na abertura do app | `~/.local/bin`, `%APPDATA%/npm`, winget, cargo e scoop entram sozinhos e o PATH do registro é lido a cada shell |
| `[I` na linha de comando ao clicar fora e voltar | o ConPTY liga o modo 1004, o xterm relata foco com `ESC[I` e o PSReadLine 2.0 do Windows ecoa como texto | relatos de foco descartados no Windows antes do `pty_write` |
| Dica de arrasto falando em tecla Option | texto fixo do Mac | tecla por parâmetro: Option no Mac, Alt no resto |

## Hipóteses de janela

| Código | Hipótese | Confirmada | Refutada | Linha do registro ou captura |
| --- | --- | --- | --- | --- |
| H1 | Janela nasce pequena, sem moldura e sem poder redimensionar | ☐ | ☑ | `app.log`: `[window] crescendo de 440x320 para 1380x880`, tamanho de trabalho em 931 ms; redimensiona pela moldura invisível, t4d |
| H2 | A rede de segurança não agia porque a janela já nascia visível | ☐ | ☑ | `app.log` 24/09 21:52: `o frontend nao sinalizou a abertura em 6s; resgatando a janela RescuePlan { grow: true, system_frame: true }`, num build de desenvolvimento sem página |
| H3 | Sem o React montado não existe região de arraste nem botão de janela | ☑ | ☐ | mesmo evento das 21:52: a janela só ficou móvel e fechável pela moldura do sistema que o resgate ligou |
| H4 | `initPlatform` nunca resolve e o React não monta | ☐ | ☑ | a página montou em todas as aberturas dos builds de release, t12-02 e t15-01 |
| H5 | O `setup` falhou e o `panic` está no `app.log` | ☐ | ☑ | nenhum panic no `setup`; os dois panics do log são no encerramento do 0.2.9 original, `cannot move state from Destroyed`, e não ocorreram nas cinco saídas dos builds corrigidos |
| H6 | Janela vazada porque o fundo é transparente antes de a página pintar | ☐ | ☑ | a abertura mostra a placa `#37112F` em todas as capturas de abertura |
| H7 | Sem Mica por build anterior ao 22621 | ☐ | ☐ | build 26100; o Mica não foi avaliado porque a máquina não tem composição por GPU |
| H8 | WebView2 Runtime faltando na instalação | ☐ | ☑ | 137.0.3296.68 presente, chave `EdgeUpdate\Clients` |
| H9 | WebGL por software trava a página | ☐ | ☑ | o WebGL do xterm nem carrega nesta máquina e a página roda no renderizador DOM sem travar, `cialai-term-diag.json` |
| H10 | Prefixo estendido vazou para o `staticDir` do sidecar | ☐ | ☐ | túnel "Acessível" assim que houve rede; a página do celular não foi aberta |

## Hipóteses de pastas

| Código | Hipótese | Confirmada | Refutada | Linha do registro ou captura |
| --- | --- | --- | --- | --- |
| P2 | Resultado do diálogo nativo guardado com barra invertida | ☐ | ☑ | `preferences.json` grava `C:/Users/ordinum/...`; a pasta escolhida no diálogo nativo abriu o explorador no lugar certo, t9f-01 |
| P3 | `cwd` do processo com barra invertida em `shellCwd` | ☐ | ☐ | não avaliado |
| P4 | Comparações entre as duas formas falhando | ☐ | ☐ | não avaliado |
| P5 | Raiz de unidade inalcançável | ☐ | ☐ | não avaliado |
| P6 | Separador e pasta pessoal anunciados em formas diferentes | ☑ | ☐ | só na apresentação: o cabeçalho da sessão mostra `~\Documents\projeto\` e o painel de arquivos mostra `~/Documents/pr...` na mesma tela, t19-03 |
| P7 | Soltar arquivo do Explorer ignorado | ☐ | ☐ | não avaliado |
| P8 | Nome da pasta acima errado no seletor | ☐ | ☐ | não avaliado |
| P9 | `AppData` e `NTUSER.DAT` como itens comuns | ☐ | ☑ | o seletor lista Documents, Meus Vídeos, Minhas Imagens, Minhas Músicas e projeto, t14-01 |
| P10 | Comparações sensíveis a maiúsculas | ☐ | ☐ | não avaliado |

## Aceite final

| Item | Windows 10 | Windows 11 | Evidência |
| --- | --- | --- | --- |
| Instalar e abrir | ☐ | ☑ | `Cialai_x64-setup.exe` instalou em `AppData\Local\Cialai` e abriu; o comando `cialai` foi instalado na primeira abertura |
| Mover e redimensionar a janela | ☐ | ☑ | mover pelo título com precisão de pixel, t4c; redimensionar pelos três lados a partir da moldura invisível, t4d; maximizar e restaurar, t4-01 e t4-02 |
| Navegar e selecionar pastas | ☐ | ☑ | seletor de nova sessão, diálogo nativo, explorador com busca, nova pasta e menu de contexto, t2 e t14 |
| Abrir e usar um terminal | ☐ | ☑ | com o build corrigido: comandos, cores, `Ctrl+C`, histórico, Tab, 20000 linhas com digitação concorrente, Claude Code e Codex até a tela de login, t1, t17 e t11. Com o 0.2.9 publicado o teclado não chega ao terminal |
| Cinco minutos sem janela de console | ☐ | ☑ | quatro horas de uso sem nenhuma janela de console nas capturas |

## Ainda em aberto em A1

- Colar com `Ctrl+Shift+V` abre o prompt de permissão do WebView2 para a área de transferência.
- `Ctrl+Shift+0`, o reset de fonte no terminal, é reservado pelo Windows para troca de layout.
- O filtro do seletor de nova sessão casa o caminho inteiro, então "Docu" traz todas as pastas do Documents.
