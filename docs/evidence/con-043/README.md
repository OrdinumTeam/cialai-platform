# Evidência visual de CON-043

Data: 15/09/2026.

Capturas do modo demo do desktop, geradas com Playwright e Chromium headless sobre o Vite de `apps/desktop`, a partir de `?terminais=demo&motion=0&platform=macos&tunnel=demo`. O demo simula o sidecar v2: `net.start` na abertura, bootstrap do Tor, sessões por transporte e pareamento. `reserve=37` fixa a conexão de reserva em 37%; `reserve=ready` fixa o onion publicado. Nenhum sidecar, Tor ou celular real foi usado; comportamento em aparelho continua pendente.

Nome dos arquivos: `<tela>-<idioma>-<tema>-<largura>.webp`.

| Eixo | Valores |
| --- | --- |
| Idioma | `pt-BR`, `en`, `es` |
| Tema | `light`, `dark` |
| Largura | `desktop` com 1380 por 880; `narrow` com 720 por 820 |

| Tela | Reserva | Conteúdo |
| --- | --- | --- |
| `dispositivos` | pronta | Painel Acesso pelo celular sem campos, celulares conectados e badges Direta e Reserva |
| `diagnostico` | pronta | Seção avançada com identidade, candidatos, mapeamento, onion, bootstrap, redes públicas e resultado de `diagnostics.run` |
| `pareamento` | 37% | QR, conexão direta, conexão de reserva com progresso e aviso para outra rede |
| `preferencias` | 37% | Painel na seção de rede, nome do computador, aprovação por código e manter ativo |
| `onboarding` | 37% | Passo informativo do acesso pelo celular |

Cada captura teve o texto visível varrido por parênteses, hífen isolado, meia-risca e travessão antes de ser gravada e foi conferida visualmente. O fluxo completo do demo, com QR, reserva ficando pronta, leitura simulada do código, badges e diagnóstico, é verificado por `npm run test:browser`.
