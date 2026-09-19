# WIN-01: desktop no Windows

Estado: correções demonstráveis por teste aplicadas, coleta em Windows real pendente.

Nenhuma execução do Cialai em Windows real foi registrada até 18/09/2026. Rode `docs/testes/roteiro-windows.md` e `tools/windows/collect-diagnostics.ps1` e traga o resultado para as tabelas abaixo.

## Ambientes

| Código | Origem | Edição e build do Windows | GPU | WebView2 | Data |
| --- | --- | --- | --- | --- | --- |
| A1 |  |  |  |  |  |
| A2 |  |  |  |  |  |

## Hipóteses de janela

| Código | Hipótese | Confirmada | Refutada | Linha do registro ou captura |
| --- | --- | --- | --- | --- |
| H1 | Janela nasce pequena, sem moldura e sem poder redimensionar | ☐ | ☐ |  |
| H2 | A rede de segurança não agia porque a janela já nascia visível | ☐ | ☐ |  |
| H3 | Sem o React montado não existe região de arraste nem botão de janela | ☐ | ☐ |  |
| H4 | `initPlatform` nunca resolve e o React não monta | ☐ | ☐ |  |
| H5 | O `setup` falhou e o `panic` está no `app.log` | ☐ | ☐ |  |
| H6 | Janela vazada porque o fundo é transparente antes de a página pintar | ☐ | ☐ |  |
| H7 | Sem Mica por build anterior ao 22621 | ☐ | ☐ |  |
| H8 | WebView2 Runtime faltando na instalação | ☐ | ☐ |  |
| H9 | WebGL por software trava a página | ☐ | ☐ |  |
| H10 | Prefixo estendido vazou para o `staticDir` do sidecar | ☐ | ☐ |  |

## Hipóteses de pastas

| Código | Hipótese | Confirmada | Refutada | Linha do registro ou captura |
| --- | --- | --- | --- | --- |
| P2 | Resultado do diálogo nativo guardado com barra invertida | ☐ | ☐ |  |
| P3 | `cwd` do processo com barra invertida em `shellCwd` | ☐ | ☐ |  |
| P4 | Comparações entre as duas formas falhando | ☐ | ☐ |  |
| P5 | Raiz de unidade inalcançável | ☐ | ☐ |  |
| P6 | Separador e pasta pessoal anunciados em formas diferentes | ☐ | ☐ |  |
| P7 | Soltar arquivo do Explorer ignorado | ☐ | ☐ |  |
| P8 | Nome da pasta acima errado no seletor | ☐ | ☐ |  |
| P9 | `AppData` e `NTUSER.DAT` como itens comuns | ☐ | ☐ |  |
| P10 | Comparações sensíveis a maiúsculas | ☐ | ☐ |  |

## Aceite final

| Item | Windows 10 | Windows 11 | Evidência |
| --- | --- | --- | --- |
| Instalar e abrir | ☐ | ☐ |  |
| Mover e redimensionar a janela | ☐ | ☐ |  |
| Navegar e selecionar pastas | ☐ | ☐ |  |
| Abrir e usar um terminal | ☐ | ☐ |  |
| Cinco minutos sem janela de console | ☐ | ☐ |  |
