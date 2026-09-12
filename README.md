# Cialai

Cialai é um estúdio de terminais open source, mantido pela Ordinum. No computador, cada sessão é um shell numa pasta, com um card que mostra o que está rodando, se precisa de atenção e quanto consome. No celular, a pessoa acompanha e controla esses terminais por um túnel cifrado ponta a ponta, coordenado por um Headscale que ela mesma hospeda, com o vínculo entre os aparelhos criado por um QR code.

O produto nasce do estúdio de terminais do Ordinum Control, preservando sua experiência: criação e organização de sessões, cores, aparência, interações, histórico que volta depois de fechar o app e retomada de conversas de Claude Code e Codex.

## Estado

Fase 0 aberta e Fase 1 iniciada em 12/09/2026 por autorização do usuário. A fundação contém workspaces npm, módulo Go, CI mínima e experimentos de rede. O scaffold Tauri da tarefa 1.1 compila no macOS, mas o estúdio ainda não foi extraído do Control. A execução segue [o roadmap](./docs/11-roadmap-de-execucao.md), com tarefas e evidências em [progresso e handoff](./docs/13-progresso-e-handoff.md).

Para validar a fundação com Node 22 e npm 10:

```sh
npm ci
npm test
```

Requisitos e instruções em [CONTRIBUTING.md](./CONTRIBUTING.md).

## Plataformas

| Plataforma | Papel |
| --- | --- |
| macOS, Linux e Windows | Desktop em Tauri 2 e Rust, onde os terminais são criados e executados |
| iOS e Android | Apps em Expo que acompanham e controlam os terminais do computador |
| Servidor próprio | Headscale auto hospedado, com receita pronta em `infra/headscale` |

## Documentação

Índice e ordem de leitura em [docs/README.md](./docs/README.md).

## Estrutura prevista

```
apps/desktop        Tauri 2 e Rust
apps/mobile         Expo, iOS e Android, módulo nativo do túnel
packages/ui         React: estúdio, casca desktop, casca do celular
packages/protocol   contrato da ponte e do pareamento
packages/tunnel-core  Go: tsnet, borda, proxy, pareamento, Headscale
infra/headscale     docker compose, config, política
tools               verificações, capturas, self test, release
docs                planejamento e documentação viva
```

## Licença

Apache 2.0.
