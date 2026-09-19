# Roteiro de Windows Real

Estado: roteiro preparado, execução em Windows real pendente

Nenhuma execução do Cialai em Windows real foi registrada até 18/09/2026. O relato que abriu esta frente diz que, depois de instalar, a janela abre, o conteúdo não carrega, nada responde, a janela não se move, as pastas se comportam errado e o terminal fica inutilizável. Este roteiro existe para transformar esse relato em fatos por hipótese, antes de qualquer correção depender de adivinhação.

Regra de aprovação: um cenário só é aprovado com execução em máquina real ou em máquina virtual com Windows, e com o registro preenchido nesta folha. Compilar no `windows-2022` da integração contínua não aprova nenhum cenário, porque a integração gera o pacote e nunca o abre.

## Como usar

- Imprima uma cópia por rodada, em paisagem.
- Use somente projetos, nomes de computador e arquivos fictícios. Nenhum caminho real da máquina entra nas capturas.
- Instale o pacote NSIS publicado, não o binário de `target`. O caminho de instalação é parte do que está sendo testado.
- Antes do primeiro cenário, rode `tools/windows/collect-diagnostics.ps1` e anexe o arquivo gerado.
- Em cada hipótese, marque uma única caixa e escreva a linha do registro ou o nome da captura que sustenta a marca.
- Os registros ficam em `%LOCALAPPDATA%\br.com.ordinum.cialai\logs\app.log` e em `tunnel\tunnel.log`, na pasta de dados local.

## Identificação da rodada

| Campo | Registro |
| --- | --- |
| Data e hora inicial |  |
| Pessoa responsável |  |
| Commit do código |  |
| Origem da máquina: real, máquina virtual ou de quem relatou |  |
| Edição e versão do Windows |  |
| Número do build do Windows |  |
| Processador e arquitetura |  |
| Placa de vídeo |  |
| Escala da tela em por cento |  |
| Efeitos de transparência ligados |  |
| Versão do WebView2 Runtime |  |
| Versão do Cialai instalada |  |
| Arquivo de diagnóstico anexado |  |

## Cenários

| Código | O que fazer | Aprovado | Reprovado | Evidência |
| --- | --- | --- | --- | --- |
| WIN-A1 | Instalar o pacote NSIS publicado numa máquina sem o Cialai | ☐ | ☐ |  |
| WIN-A2 | Abrir o app pela primeira vez e esperar dez segundos sem tocar em nada | ☐ | ☐ |  |
| WIN-A3 | Conferir que a janela cresceu do tamanho de abertura para o de trabalho | ☐ | ☐ |  |
| WIN-A4 | Mover a janela arrastando a área superior | ☐ | ☐ |  |
| WIN-A5 | Redimensionar a janela pelas bordas | ☐ | ☐ |  |
| WIN-A6 | Usar os botões de minimizar, maximizar e fechar | ☐ | ☐ |  |
| WIN-A7 | Escolher uma pasta de projeto pelo diálogo do sistema | ☐ | ☐ |  |
| WIN-A8 | Navegar no explorador até a raiz da unidade e voltar | ☐ | ☐ |  |
| WIN-A9 | Expandir três níveis da árvore de arquivos e usar a seta para a esquerda para subir | ☐ | ☐ |  |
| WIN-A10 | Soltar um arquivo vindo do Explorer dentro de uma pasta do estúdio | ☐ | ☐ |  |
| WIN-A11 | Abrir um terminal em PowerShell 7 | ☐ | ☐ |  |
| WIN-A12 | Abrir um terminal em Windows PowerShell | ☐ | ☐ |  |
| WIN-A13 | Abrir um terminal em `cmd.exe` | ☐ | ☐ |  |
| WIN-A14 | Conferir que a faixa Terminal em some ao voltar à pasta da sessão | ☐ | ☐ |  |
| WIN-A15 | Deixar um agente escrevendo arquivos por cinco minutos e contar as janelas de console que aparecerem. Esta é a WIN-07 do plano de 16/09/2026 | ☐ | ☐ |  |
| WIN-A16 | Parear um celular e abrir um terminal por ele | ☐ | ☐ |  |

## Hipóteses de janela

| Código | Hipótese | Confirmada | Refutada | Linha do registro ou captura |
| --- | --- | --- | --- | --- |
| H1 | A janela nasce com 440 por 320, sem moldura e sem poder redimensionar | ☐ | ☐ |  |
| H2 | A rede de segurança de seis segundos não age porque a janela já nasce visível | ☐ | ☐ |  |
| H3 | Sem o React montado não existe nenhuma região de arraste nem botão de janela | ☐ | ☐ |  |
| H4 | `initPlatform` fica esperando para sempre e o React nunca monta | ☐ | ☐ |  |
| H5 | O `setup` falhou e o `panic` está no `app.log` | ☐ | ☐ |  |
| H6 | A janela fica vazada porque o fundo é transparente antes de a página pintar | ☐ | ☐ |  |
| H7 | Não há Mica porque o build do Windows é anterior ao 22621 | ☐ | ☐ |  |
| H8 | O WebView2 Runtime faltava e a instalação tentou baixá-lo | ☐ | ☐ |  |
| H9 | Sem placa de vídeo o WebGL cai em renderizador por software e a página trava | ☐ | ☐ |  |
| H10 | O prefixo `\\?\` vazou para o `staticDir` entregue ao sidecar | ☐ | ☐ |  |

## Hipóteses de pastas

| Código | Hipótese | Confirmada | Refutada | Linha do registro ou captura |
| --- | --- | --- | --- | --- |
| P1 | O Rust devolve caminho com barra normal | ☐ | ☐ |  |
| P2 | O resultado do diálogo nativo chega com barra invertida e é guardado cru | ☐ | ☐ |  |
| P3 | O `cwd` do processo sai com barra invertida e vira `shellCwd` | ☐ | ☐ |  |
| P4 | Comparações entre as duas formas falham e o explorador troca de raiz sem parar | ☐ | ☐ |  |
| P5 | A raiz de unidade não é alcançável e a listagem de unidades não existe | ☐ | ☐ |  |
| P6 | O mesmo objeto anuncia separador e pasta pessoal em formas diferentes | ☐ | ☐ |  |
| P7 | Soltar arquivo vindo do Explorer é ignorado | ☐ | ☐ |  |
| P8 | O nome da pasta acima aparece errado no seletor de nova sessão | ☐ | ☐ |  |
| P9 | `AppData` e `NTUSER.DAT` aparecem como itens comuns | ☐ | ☐ |  |
| P10 | Comparações sensíveis a maiúsculas quebram num sistema que não diferencia | ☐ | ☐ |  |

## Registro livre

Uma linha por observação que não coube acima, com hora, o que foi feito e o que aconteceu.

| Hora | O que foi feito | O que aconteceu |
| --- | --- | --- |
|  |  |  |
|  |  |  |
|  |  |  |
