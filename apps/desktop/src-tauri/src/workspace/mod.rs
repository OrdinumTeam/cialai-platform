// SPDX-License-Identifier: Apache-2.0
//! Terminais integrados: varios shells dentro do app, cada um aberto numa
//! pasta, dispostos lado a lado na secao Terminais.
//!
//! Desenho entregue:
//!
//! - **PTY em Rust** com o crate `portable-pty`, o mesmo do WezTerm, em
//!   [`terminal::TerminalManager`]. Comandos `pty_spawn`, `pty_write`,
//!   `pty_resize`, `pty_ack`, `pty_kill`, `pty_attach` e `pty_list`. A saida
//!   de cada sessao vai por um `Channel` do Tauri com bytes brutos, em lotes
//!   de ate 64 KiB a cada 4 ms e controle de fluxo por `pty_ack`, seguindo o
//!   guia de flow control do xterm.js. O fim da sessao chega pelo mesmo canal,
//!   depois do ultimo lote, e tambem pelo evento global [`EVENT_PTY_EXIT`].
//! - **Repositorios** listados por [`repos::list`] a partir das raizes em
//!   [`REPO_ROOTS_FROM_HOME`], para o seletor rapido da secao.
//! - **Renderizacao** com `@xterm/xterm` no webview, instancias vivas num
//!   runtime de escopo de modulo em `frontend/src/terminals/runtime.js`.
//!
//! Estudio completo, desde a segunda entrega:
//!
//! - **Metricas por sessao** em [`terminal::TerminalManager::metrics`], com
//!   CPU, memoria, processo em primeiro plano, agente reconhecido e diretorio
//!   atual do shell, lidos do kernel por [`procs`].
//! - **Arquivos** em [`files`]: listagem sob demanda, leitura e gravacao com
//!   deteccao de conflito, imagens, criar, renomear, Lixeira e busca por nome.
//! - **Git** em [`git`]: branch, avanço e arquivos alterados, e o diff de um
//!   arquivo.
//! - **Observador** em [`watch`]: kqueue nas pastas expandidas e nos arquivos
//!   abertos, avisando pelo evento [`watch::EVENT_FS_CHANGE`].
//! - **Uso do plano dos agentes** em [`ai`]: o quanto da cota de Claude Code e
//!   Codex ja foi gasto, lido de onde cada um publica.
//! - **Visualizacao de HTML** em [`preview`]: o protocolo `preview://` serve
//!   a raiz de um projeto como um servidor local.
//! - **Previas de documentos** em [`office`]: PowerPoint, Word antigo, iWork e
//!   RTF viram PDF pelo LibreOffice, com cache, e o PDF sai pelo mesmo
//!   protocolo `preview://`.
//! - **Dev Browser** em [`browser`]: um Chromium headless por sessao, com
//!   perfil e porta proprios, que o webview dirige por CDP e os agentes do
//!   terminal pela porta publicada na pasta.
//! - **Arraste para fora** em [`dragout`]: um item do explorador vira uma
//!   sessao de arraste do AppKit quando o ponteiro sai da janela, para o
//!   Finder e outros apps receberem o arquivo.
//! - **Sessoes que voltam** em [`journal`] e [`resume`]: historico e estado
//!   de cada terminal em disco e a conversa do Claude Code ou do Codex em
//!   uso, para reabrir depois que o app fecha ou cai.

pub mod ai;
pub mod browser;
pub mod dragout;
pub mod files;
pub mod git;
pub mod journal;
pub mod mobile_files;
pub mod office;
pub mod preview;
pub mod procs;
pub mod repos;
pub mod resume;
pub mod terminal;
pub mod watch;

/// Raizes de repositorios, relativas a pasta do usuario.
pub const REPO_ROOTS_FROM_HOME: &[&str] = &["Projects", "Github Projects"];

/// Evento global emitido quando o shell de uma sessao termina.
pub const EVENT_PTY_EXIT: &str = "pty://exit";

/// Shell das sessoes, aberto como login shell para herdar o PATH do usuario.
pub const DEFAULT_SHELL: &str = "/bin/zsh";
