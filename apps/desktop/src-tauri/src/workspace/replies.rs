// SPDX-License-Identifier: Apache-2.0
//! Respostas automaticas do terminal, que nao sao digitacao.
//!
//! O xterm responde sozinho as consultas que os programas fazem: posicao do
//! cursor, atributos do terminal, cores de frente e de fundo, modos, versao,
//! relato de foco. Essas respostas descem pelo mesmo caminho do teclado. A
//! retomada do agente desiste quando a pessoa digita no shell novo, para nao
//! misturar o comando com a digitacao; um shell ou um prompt que consulta o
//! terminal ao abrir nao pode contar como digitacao.
//!
//! [`is_terminal_reply`] aceita so um lote feito inteiramente de respostas
//! conhecidas e completas. Qualquer outro byte, como uma seta, um clique ou
//! texto, faz o lote valer como entrada.

/// Lote composto so de respostas automaticas do terminal.
pub fn is_terminal_reply(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let mut rest = bytes;
    while !rest.is_empty() {
        match reply_len(rest) {
            Some(length) => rest = &rest[length..],
            None => return false,
        }
    }
    true
}

fn reply_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 3 || bytes[0] != 0x1b {
        return None;
    }
    match bytes[1] {
        b'[' => csi_reply(bytes),
        b']' => osc_reply(bytes),
        b'P' => dcs_reply(bytes),
        _ => None,
    }
}

/// `ESC [`, prefixo opcional `?` ou `>`, parametros, `$` opcional e o byte
/// final. So as formas que o terminal manda como resposta.
fn csi_reply(bytes: &[u8]) -> Option<usize> {
    let mut index = 2;
    let prefix = match bytes.get(index) {
        Some(&byte @ (b'?' | b'>')) => {
            index += 1;
            Some(byte)
        }
        _ => None,
    };
    let start = index;
    while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b';') {
        index += 1;
    }
    let params = &bytes[start..index];
    let dollar = bytes.get(index) == Some(&b'$');
    if dollar {
        index += 1;
    }
    let last = *bytes.get(index)?;
    let accepted = match (prefix, dollar, last) {
        // Posicao do cursor, `ESC [ linha ; coluna R`.
        (None, false, b'R') => numbers(params) == Some(2),
        // Atributos primarios e secundarios do terminal.
        (Some(b'?') | Some(b'>'), false, b'c') => numbers(params).is_some(),
        // Estado do terminal e da impressora.
        (None, false, b'n') => params == b"0" || params == b"3",
        // Relato de modo, `ESC [ ? modo ; valor $ y`.
        (None | Some(b'?'), true, b'y') => numbers(params) == Some(2),
        // Bandeiras do teclado estendido do kitty.
        (Some(b'?'), false, b'u') => params.is_empty() || numbers(params) == Some(1),
        // Tamanho da janela e das celulas.
        (None, false, b't') => {
            numbers(params) == Some(3) && matches!(params.first(), Some(b'4' | b'6' | b'8'))
        }
        // Relato de foco.
        (None, false, b'I' | b'O') => params.is_empty(),
        _ => false,
    };
    accepted.then_some(index + 1)
}

/// Quantidade de numeros separados por `;`, ou `None` se algum vier vazio.
fn numbers(params: &[u8]) -> Option<usize> {
    if params.is_empty() {
        return None;
    }
    let mut count = 0;
    for part in params.split(|byte| *byte == b';') {
        if part.is_empty() {
            return None;
        }
        count += 1;
    }
    Some(count)
}

/// `ESC ] numero ; valor` terminado por BEL ou ST, so para as cores: paleta,
/// frente, fundo, cursor e realce.
fn osc_reply(bytes: &[u8]) -> Option<usize> {
    let mut index = 2;
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let number: u32 = std::str::from_utf8(&bytes[start..index])
        .ok()?
        .parse()
        .ok()?;
    if !(number == 4 || (10..=19).contains(&number)) || bytes.get(index) != Some(&b';') {
        return None;
    }
    index += 1;
    let body = index;
    while index < bytes.len() {
        match bytes[index] {
            0x07 => return color_body(&bytes[body..index]).then_some(index + 1),
            0x1b if bytes.get(index + 1) == Some(&b'\\') => {
                return color_body(&bytes[body..index]).then_some(index + 2);
            }
            byte if byte < 0x20 => return None,
            _ => index += 1,
        }
    }
    None
}

fn color_body(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    text.contains("rgb:") || text.contains("rgba:") || text.starts_with('#')
}

/// `ESC P` ate ST, so para versao, configuracao consultada e recursos do
/// terminal.
fn dcs_reply(bytes: &[u8]) -> Option<usize> {
    let body = &bytes[2..];
    const PREFIXES: &[&[u8]] = &[b">|", b"!|", b"1$r", b"0$r", b"1+r", b"0+r"];
    if !PREFIXES.iter().any(|prefix| body.starts_with(prefix)) {
        return None;
    }
    let end = body.windows(2).position(|pair| pair == b"\x1b\\")?;
    if body[..end].iter().any(|byte| *byte < 0x20) {
        return None;
    }
    Some(2 + end + 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_to_terminal_queries_are_not_typing() {
        for reply in [
            &b"\x1b[24;80R"[..],
            b"\x1b[?62;22c",
            b"\x1b[>0;276;0c",
            b"\x1b[0n",
            b"\x1b[?2004;1$y",
            b"\x1b[?0u",
            b"\x1b[8;40;120t",
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1b]4;1;rgb:cdcd/0000/0000\x1b\\",
            b"\x1bP>|xterm.js(5.5.0)\x1b\\",
            b"\x1bP1$r0m\x1b\\",
            // Varias respostas no mesmo lote.
            b"\x1b[?62;22c\x1b]11;rgb:0000/0000/0000\x07\x1b[3;1R",
        ] {
            assert!(
                is_terminal_reply(reply),
                "{:?}",
                String::from_utf8_lossy(reply)
            );
        }
    }

    #[test]
    fn keys_clicks_and_text_are_typing() {
        for typed in [
            &b""[..],
            b"a",
            b"ls\r",
            b"\x03",
            b"\x1b",
            b"\x1b[A",
            b"\x1b[1;5D",
            b"\x1b[3~",
            b"\x1bOP",
            b"\x1b[<0;10;5M",
            b"\x1b[200~colado\x1b[201~",
            // Resposta seguida de digitacao vale como digitacao.
            b"\x1b[24;80Rx",
            // Incompleta ou desconhecida.
            b"\x1b[24;80",
            b"\x1b]11;rgb:0000/0000/0000",
            b"\x1b]0;titulo\x07",
            b"\x1b]52;c;dGV4dG8=\x07",
            b"\x1bPqualquer\x1b\\",
        ] {
            assert!(
                !is_terminal_reply(typed),
                "{:?}",
                String::from_utf8_lossy(typed)
            );
        }
    }
}
