# Controles da janela na barra de busca

Data: 06/10/2026. Escopo: janela principal do desktop.

Executar no macOS, Windows, Linux X11 e Linux Wayland, anotando versão do
sistema, versão do aplicativo, resultado e evidência de cada cenário. A
simulação de plataforma no Chromium não aprova operações de janela nativas.

| Cenário | Resultado esperado |
| --- | --- |
| Abrir o aplicativo | Uma única toolbar de 52 px, com busca, menu e controles à direita; nenhuma linha reservada aos controles antigos |
| Minimizar e reabrir | A janela minimiza e volta pelo Dock ou pela barra de tarefas, com o terminal aceitando teclado |
| Maximizar no Windows e Linux | O botão central maximiza, muda para restaurar e devolve o tamanho anterior no próximo clique |
| Tela cheia no Mac | O verde entra e sai da tela cheia do macOS; o amarelo fica desabilitado enquanto a janela está em tela cheia; os botões antigos não reaparecem à esquerda |
| Mover | Arrastar espaços livres e o título da toolbar move a janela; busca, menu e controles executam suas ações sem iniciar arraste |
| Redimensionar | As quatro bordas e os quatro cantos funcionam; no Linux, as áreas próprias desaparecem ao maximizar ou entrar em tela cheia |
| Fechar com terminal aberto | O X ou o vermelho usa a confirmação existente; cancelar mantém janela, sessões e foco utilizáveis |
| Fechar sem terminal aberto | A janela fecha pelo mesmo fluxo de saída usado antes da alteração |
| Largura e sidebar | Em 1040 e 1440 px e com sidebar aberta ou fechada, os controles permanecem na mesma linha e acessíveis |
| Tema e idioma | Conferir claro e escuro, português, inglês e espanhol; rótulos indicam a ação atual, inclusive sair da tela cheia ou restaurar |
| Recuperação | Se o bundle não carregar, a recuperação existente torna a janela utilizável e devolve controles do sistema; no Mac, os semáforos nativos voltam |

O caso de recuperação deve usar um build descartável, sem modificar dados
ou a instalação utilizada pela pessoa. Compilação e testes unitários não
substituem a execução deste roteiro.
