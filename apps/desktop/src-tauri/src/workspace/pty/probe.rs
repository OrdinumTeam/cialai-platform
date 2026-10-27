// SPDX-License-Identifier: Apache-2.0
//! PTY descartavel do onboarding: abre o shell, guarda o primeiro prompt e fecha.
//!
//! No Windows o ConPTY nasce perguntando a posicao do cursor e so desenha depois
//! da resposta, e antes do Windows 11 24H2 fechar o console espera alguem
//! esvaziar a saida. O ensaio lia um unico trecho, nao respondia e soltava o
//! master sem leitora, entao o comando nunca voltava e o onboarding ficava em
//! "Abrindo…".

use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, PtySize};

use super::{CursorPosition, ProcessTree, StartupCursorQuery, force_kill_tree, spawn_shell};

/// Prazo para o shell mostrar o prompt.
const WAIT: Duration = Duration::from_secs(4);
/// Silencio que encerra a leitura depois que algum texto apareceu.
const QUIET: Duration = Duration::from_millis(400);
/// O onboarding mostra pouco mais de mil caracteres.
const LIMIT: usize = 16 * 1024;
const READ_BUFFER: usize = 4096;

/// Abre o shell num PTY, devolve o que ele escreveu ate o prompt e encerra a arvore.
pub(crate) fn probe_shell(command: CommandBuilder, size: PtySize) -> Result<Vec<u8>, String> {
    let spawned = spawn_shell(command, size)?;
    let pair = spawned.pair;
    let mut child = spawned.child;
    let tree = spawned.tree;
    drop(pair.slave);
    let streams = pair
        .master
        .try_clone_reader()
        .and_then(|reader| Ok((reader, pair.master.take_writer()?)));
    let (reader, writer) = match streams {
        Ok(streams) => streams,
        Err(error) => {
            stop(child.as_mut(), tree.as_ref());
            return Err(error.to_string());
        }
    };
    let chunks = drain(reader, writer);
    let output = collect(&chunks, WAIT, QUIET, LIMIT);
    stop(child.as_mut(), tree.as_ref());
    // Fechar o ConPTY espera o console sair. Num fio a parte o onboarding recebe
    // a resposta mesmo que o Windows demore, e a leitora segue ate o EOF.
    thread::spawn(move || {
        let _ = child.wait();
        drop(pair.master);
    });
    Ok(output)
}

fn stop(child: &mut (dyn Child + Send + Sync), tree: Option<&ProcessTree>) {
    let pid = child.process_id();
    let _ = child.kill();
    force_kill_tree(pid, tree);
}

/// Le o PTY ate o EOF, responde a pergunta de cursor do ConPTY e repassa o resto.
/// A leitura continua depois que o ensaio para de ouvir, porque o console so
/// fecha com a saida esvaziada.
fn drain(mut reader: Box<dyn Read + Send>, mut writer: Box<dyn Write + Send>) -> Receiver<Vec<u8>> {
    let (send, receive) = mpsc::channel();
    let mut startup = StartupCursorQuery::for_platform(CursorPosition::default());
    thread::spawn(move || {
        let mut buffer = [0_u8; READ_BUFFER];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let (output, reply) = startup.filter(&buffer[..read]);
                    if let Some(reply) = reply {
                        let _ = writer.write_all(&reply).and_then(|()| writer.flush());
                    }
                    if !output.is_empty() {
                        let _ = send.send(output);
                    }
                }
            }
        }
        let held = startup.finish();
        if !held.is_empty() {
            let _ = send.send(held);
        }
    });
    receive
}

/// Junta a saida ate o prompt assentar: texto visivel seguido de silencio, o
/// fim do prazo ou o limite de bytes, o que vier antes.
fn collect(chunks: &Receiver<Vec<u8>>, wait: Duration, quiet: Duration, limit: usize) -> Vec<u8> {
    let deadline = Instant::now() + wait;
    let mut output = Vec::new();
    let mut visible = false;
    while output.len() < limit {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match chunks.recv_timeout(if visible { left.min(quiet) } else { left }) {
            Ok(chunk) => {
                output.extend_from_slice(&chunk);
                visible = visible || has_visible_text(&output);
            }
            Err(_) => break,
        }
    }
    output.truncate(limit);
    output
}

/// Diz se a saida ja mostra algum caractere alem de espacos e sequencias de
/// controle, como os modos e o titulo que o ConPTY manda antes do prompt.
fn has_visible_text(bytes: &[u8]) -> bool {
    #[derive(Clone, Copy)]
    enum State {
        Text,
        Escape,
        Csi,
        Osc,
    }
    let mut state = State::Text;
    for &byte in bytes {
        state = match state {
            State::Text if byte == 0x1b => State::Escape,
            State::Text if byte.is_ascii_graphic() || byte >= 0x80 => return true,
            State::Text => State::Text,
            State::Escape if byte == b'[' => State::Csi,
            State::Escape if byte == b']' => State::Osc,
            State::Escape if (0x20..=0x2f).contains(&byte) => State::Escape,
            State::Escape => State::Text,
            State::Csi if (0x40..=0x7e).contains(&byte) => State::Text,
            State::Csi => State::Csi,
            State::Osc if byte == 0x07 => State::Text,
            State::Osc if byte == 0x1b => State::Escape,
            State::Osc => State::Osc,
        };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::pty::TestShell;

    #[test]
    fn control_sequences_and_spaces_are_not_a_prompt() {
        assert!(!has_visible_text(b""));
        assert!(!has_visible_text(
            b"\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H"
        ));
        assert!(!has_visible_text(
            b"\x1b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\x07"
        ));
        assert!(!has_visible_text(b"\x1b]0;titulo\x1b\\\x1b(B\x1b=\r\n \t"));
        assert!(has_visible_text(
            b"\x1b]0;pwsh\x07\x1b[?25hPS C:\\Users\\ana> "
        ));
        assert!(has_visible_text("\x1b[1m→".as_bytes()));
    }

    #[test]
    fn collect_waits_for_text_then_stops_on_quiet() {
        let (send, receive) = mpsc::channel();
        send.send(b"\x1b[?25l".to_vec()).unwrap();
        send.send(b"PS> ".to_vec()).unwrap();
        let started = Instant::now();
        let output = collect(
            &receive,
            Duration::from_secs(5),
            Duration::from_millis(50),
            LIMIT,
        );
        assert_eq!(output, b"\x1b[?25lPS> ");
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(send);
    }

    #[test]
    fn collect_gives_up_at_the_deadline_or_the_limit() {
        let (send, receive) = mpsc::channel::<Vec<u8>>();
        send.send(b"\x1b[?25l".to_vec()).unwrap();
        let output = collect(
            &receive,
            Duration::from_millis(80),
            Duration::from_millis(10),
            LIMIT,
        );
        assert_eq!(output, b"\x1b[?25l");
        send.send(vec![b'a'; 64]).unwrap();
        let output = collect(&receive, Duration::from_secs(5), Duration::from_secs(5), 16);
        assert_eq!(output.len(), 16);
    }

    #[test]
    fn probe_returns_the_prompt_and_does_not_hang_on_close() {
        let shell = TestShell::isolated();
        let mut command = CommandBuilder::new(&shell.spec().path);
        for arg in &shell.spec().args {
            command.arg(arg);
        }
        command.cwd(shell.cwd());
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(probe_shell(
                command,
                PtySize {
                    rows: 12,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
            ));
        });
        let output = finished
            .recv_timeout(WAIT + Duration::from_secs(6))
            .expect("o ensaio do PTY voltou")
            .expect("o shell abriu");
        assert!(
            has_visible_text(&output),
            "prompt visivel: {:?}",
            String::from_utf8_lossy(&output)
        );
        assert!(!output.windows(4).any(|window| window == b"\x1b[6n"));
    }
}
