// SPDX-License-Identifier: Apache-2.0
//! Resposta a pergunta de cursor com que o ConPTY do Windows nasce.
//!
//! O portable-pty cria o ConPTY com PSEUDOCONSOLE_INHERIT_CURSOR, e com isso o
//! console pergunta a posicao do cursor com ESC[6n e nao inicia o shell antes da
//! resposta. Pelo xterm a resposta dependia de a sessao estar a vista e com a
//! concessao de largura; sem ela o terminal ficava em branco. Quem abre a sessao
//! ja sabe onde o cursor esta, entao o Rust responde na hora e tira a pergunta da
//! saida, e nenhum xterm responde de novo.

const QUERY: &[u8] = b"\x1b[6n";

/// A pergunta vem antes do primeiro desenho; passado este volume a saida segue intacta.
const STARTUP_BYTES: usize = 512;

/// Posicao do cursor no xterm de quem abriu a sessao, contada a partir de 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorPosition {
    pub row: u16,
    pub col: u16,
}

impl Default for CursorPosition {
    fn default() -> Self {
        Self { row: 1, col: 1 }
    }
}

impl CursorPosition {
    /// Coordenadas enviadas pelo cliente; ausentes ou zeradas viram a primeira celula.
    pub fn from_client(row: Option<u16>, col: Option<u16>) -> Self {
        Self {
            row: row.unwrap_or(1).max(1),
            col: col.unwrap_or(1).max(1),
        }
    }
}

pub(crate) struct StartupCursorQuery {
    reply: Option<Vec<u8>>,
    pending: Vec<u8>,
    seen: usize,
}

impl StartupCursorQuery {
    /// So o ConPTY faz a pergunta; nos outros sistemas a saida passa direto.
    pub(crate) fn for_platform(cursor: CursorPosition) -> Self {
        if cfg!(windows) {
            Self::answering(cursor)
        } else {
            Self::inactive()
        }
    }

    pub(crate) fn answering(cursor: CursorPosition) -> Self {
        let reply = format!("\x1b[{};{}R", cursor.row.max(1), cursor.col.max(1)).into_bytes();
        Self {
            reply: Some(reply),
            pending: Vec::new(),
            seen: 0,
        }
    }

    pub(crate) fn inactive() -> Self {
        Self {
            reply: None,
            pending: Vec::new(),
            seen: 0,
        }
    }

    pub(crate) fn active(&self) -> bool {
        self.reply.is_some()
    }

    /// Recebe um trecho lido do PTY e devolve o que segue para o app e, uma unica
    /// vez, a resposta que deve ser escrita no PTY.
    pub(crate) fn filter(&mut self, chunk: &[u8]) -> (Vec<u8>, Option<Vec<u8>>) {
        if self.reply.is_none() {
            return (chunk.to_vec(), None);
        }
        self.pending.extend_from_slice(chunk);
        self.seen += chunk.len();
        if let Some(at) = find(&self.pending, QUERY) {
            let mut output = std::mem::take(&mut self.pending);
            output.drain(at..at + QUERY.len());
            return (output, self.reply.take());
        }
        if self.seen >= STARTUP_BYTES {
            self.reply = None;
            return (std::mem::take(&mut self.pending), None);
        }
        let keep = partial_query_suffix(&self.pending);
        let output = self.pending.drain(..self.pending.len() - keep).collect();
        (output, None)
    }

    /// Fim da leitura: devolve o comeco de pergunta que ficou guardado.
    pub(crate) fn finish(&mut self) -> Vec<u8> {
        self.reply = None;
        std::mem::take(&mut self.pending)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn partial_query_suffix(bytes: &[u8]) -> usize {
    (1..QUERY.len())
        .rev()
        .find(|&size| bytes.ends_with(&QUERY[..size]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: u16, col: u16) -> StartupCursorQuery {
        StartupCursorQuery::answering(CursorPosition { row, col })
    }

    #[test]
    fn answers_once_with_the_cursor_and_removes_the_question() {
        let mut query = at(3, 7);
        let (output, reply) = query.filter(b"\x1b[?9001h\x1b[6n\x1b[?25l");
        assert_eq!(output, b"\x1b[?9001h\x1b[?25l");
        assert_eq!(reply.as_deref(), Some(&b"\x1b[3;7R"[..]));
        assert!(!query.active());
        let (output, reply) = query.filter(b"PS> \x1b[6n");
        assert_eq!(output, b"PS> \x1b[6n");
        assert!(reply.is_none());
    }

    #[test]
    fn a_question_split_between_reads_is_still_answered() {
        let mut query = at(1, 1);
        let (output, reply) = query.filter(b"abc\x1b[");
        assert_eq!(output, b"abc");
        assert!(reply.is_none());
        let (output, reply) = query.filter(b"6nPS>");
        assert_eq!(output, b"PS>");
        assert_eq!(reply.as_deref(), Some(&b"\x1b[1;1R"[..]));
    }

    #[test]
    fn an_escape_that_is_not_the_question_is_released_on_the_next_read() {
        let mut query = at(1, 1);
        assert_eq!(query.filter(b"\x1b[").0, b"");
        let (output, reply) = query.filter(b"?25l");
        assert_eq!(output, b"\x1b[?25l");
        assert!(reply.is_none());
        assert!(query.active());
    }

    #[test]
    fn output_without_a_question_stops_being_inspected() {
        let mut query = at(1, 1);
        let text = vec![b'a'; STARTUP_BYTES];
        let (output, reply) = query.filter(&text);
        assert_eq!(output, text);
        assert!(reply.is_none());
        assert!(!query.active());
        assert_eq!(query.filter(b"\x1b[6n").0, b"\x1b[6n");
    }

    #[test]
    fn the_end_of_the_stream_releases_a_held_prefix() {
        let mut query = at(1, 1);
        assert_eq!(query.filter(b"\x1b[6").0, b"");
        assert_eq!(query.finish(), b"\x1b[6");
        assert!(!query.active());
    }

    #[test]
    fn zero_coordinates_become_the_first_cell_and_only_windows_answers() {
        assert_eq!(
            CursorPosition::from_client(None, Some(0)),
            CursorPosition::default()
        );
        assert_eq!(
            CursorPosition::from_client(Some(4), Some(9)),
            CursorPosition { row: 4, col: 9 }
        );
        let mut query = at(0, 0);
        assert_eq!(
            query.filter(b"\x1b[6n").1.as_deref(),
            Some(&b"\x1b[1;1R"[..])
        );
        let mut inactive = StartupCursorQuery::inactive();
        assert_eq!(inactive.filter(b"\x1b[6n"), (b"\x1b[6n".to_vec(), None));
        assert_eq!(
            StartupCursorQuery::for_platform(CursorPosition::default()).active(),
            cfg!(windows)
        );
    }
}
