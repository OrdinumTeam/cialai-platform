# Visão e escopo

## O produto

Cialai é um estúdio de terminais para quem trabalha com vários projetos e vários agentes de código ao mesmo tempo. No computador, cada sessão é um shell numa pasta, com um card que mostra o que está rodando, se precisa de atenção e quanto consome de CPU e memória. Trocar de card troca só o que está sendo exibido: processo, histórico, rolagem e arquivos abertos continuam onde estavam. Ao lado do terminal ficam o editor e a árvore do projeto. Fechar o app não apaga o que aconteceu: o histórico volta e as conversas de Claude Code e Codex são retomadas.

No celular, a pessoa vê os mesmos cards, entra em qualquer sessão, lê a saída ao vivo, digita, encerra e consulta os arquivos do projeto. A comunicação é bidirecional e passa por um túnel cifrado ponta a ponta entre os dois aparelhos, coordenado por um Headscale que a própria pessoa hospeda. O vínculo entre computador e celular nasce de um QR code.

O produto é open source sob Apache 2.0, mantido pela Ordinum, com o código, a documentação, a infraestrutura de exemplo e as configurações de publicação neste monorepo.

## Para quem

| Perfil | Necessidade que o Cialai atende |
| --- | --- |
| Desenvolvedora com vários agentes de código abertos em pastas diferentes | Saber qual sessão pede atenção, qual terminou, quanto do plano do agente já foi gasto, sem alternar janelas |
| Quem deixa processos longos rodando e sai da mesa | Acompanhar e intervir pelo celular, com o computador acordado e o app aberto |
| Equipes que não podem depender de um serviço de terceiros no meio do caminho | Túnel próprio, servidor de coordenação próprio, nada escutando fora do loopback |

## Princípios herdados do protótipo

Estes princípios estão implementados no Ordinum Control e definem a experiência que o Cialai preserva. Estão detalhados no documento 02.

1. Tudo que o card afirma foi observado, nunca inferido. O estado vem do grupo de processos em primeiro plano, de bytes recebidos, do código de saída e dos sinais que o programa emite. O estúdio não diz que um agente "está pensando".
2. O computador manda, o celular acompanha ou cai. Um celular com rádio ruim nunca trava um shell no computador.
3. Nada escuta fora do loopback, exceto a borda do túnel, que só existe dentro da tailnet.
4. Uma só implementação da interface. O celular recebe a mesma página que o computador empacota; não há segunda interface para manter.
5. Selecionar outro card muda só o que é exibido. Processo, histórico, rolagem, comando digitado e abas continuam.
6. O que foi gravado volta. Histórico bruto em disco, tamanho do terminal, conversa do agente, nome, cor, ordem, abas e pastas expandidas sobrevivem ao fechamento e à queda do app.

## O que entra

| Área | Conteúdo |
| --- | --- |
| Desktop | App Tauri 2 em Rust com frontend React para macOS, Linux e Windows, com o estúdio completo: sessões, terminal, explorador, editor, Git, prévias de documentos, Dev Browser e uso do plano dos agentes |
| Onboarding | Instalar, conceder permissões, escolher as pastas de projetos e o shell, criar o primeiro terminal; a rede é opcional e pode ser configurada depois |
| Vincular celular | Botão sempre visível na barra lateral e no estado vazio da lista de sessões; QR code com rotação e expiração; tela Dispositivos com revogação |
| Celular | Apps iOS e Android em Expo, com leitor de QR, perfis de Headscale, WebView da interface servida pelo computador, biometria para ações sensíveis, terminal ajustado à largura do telefone, arquivos somente leitura |
| Rede | Núcleo Go sobre `tsnet`, embutido no desktop como sidecar e nos celulares como biblioteca; Headscale auto hospedado com receita pronta; DERP embutido; política de acesso; pareamento com token por dispositivo |
| Monorepo | Código, documentação, infraestrutura de exemplo, scripts de verificação, CI para desktop e configurações de publicação nas lojas |

## O que fica de fora

| Item | Motivo |
| --- | --- |
| Seções de negócio do Control: clientes, projetos, caixa, fatura, AWS, DLM, documentos, contratos, mapa | Não fazem parte de um produto de terminais |
| Reuniões e VPN | Módulos do Control sem relação com o estúdio; a VPN do Control é OpenVPN corporativa |
| Backend Node e Python, launcher `ordinum-control`, integrações n8n, S3, Asaas, OnConte | O estúdio nunca os usou; os terminais vivem em Rust |
| Serviço hospedado pela Ordinum para coordenação ou pareamento | Fora da v1 por decisão do usuário; a interface `ControlAdmin` deixa a porta aberta |
| Notificações push e Live Activities | Exigiriam um relé fora do computador; o celular acompanha em primeiro plano, como no protótipo |
| Shells que sobrevivem ao fim do app | Item do roadmap do próprio Control; o Cialai preserva o comportamento atual de histórico e retomada |
| iPad como layout próprio | O celular recebe a casca de telefone; o iPad recebe a mesma casca, como hoje |
| Dev Browser no celular | A ponte recusa `browser_*` no remoto, como hoje |

## Decisões confirmadas pelo usuário em 12/09/2026

| Decisão | Valor |
| --- | --- |
| Nome | Cialai, apesar de o pedido original soletrar C-I-A-L-I-A. Pasta `cialai-platform`, marca `CIALAI`, bundle `br.com.ordinum.cialai`, esquema `cialai://` reservado para depois |
| Hospedagem do Headscale | Auto hospedado como único caminho da v1, com receita pronta em `infra/headscale`; o app aceita qualquer URL de Headscale |
| Escopo da primeira versão pública | Estúdio completo, em paridade com o Control, construído em fases internas |
| Licença | Apache 2.0, com `LICENSE`, cabeçalho curto nos arquivos novos e `NOTICE` com as licenças BSD e MIT das dependências |

## Critérios de sucesso

1. Uma pessoa que nunca viu o Control instala o Cialai no seu sistema, escolhe as pastas e abre o primeiro terminal em menos de 3 minutos.
2. Com um Headscale próprio já no ar, o pareamento do celular pelo QR leva menos de 1 minuto e a sessão aparece no telefone com histórico.
3. As suítes de verificação herdadas do protótipo passam no Cialai: 137 testes Rust, `check-terminal-sync.mjs` com 17 casos, `check-phone-*.mjs`, os testes Node de `terminal-*` e `mobile-*` e o `selftest-app.js` dentro do app.
4. Os roteiros manuais de rede do documento 06 passam nos três sistemas desktop e nas duas plataformas móveis.
5. Os cinco estados visuais da demo do estúdio ficam idênticos ao Control nas capturas de referência, exceto pela marca.
