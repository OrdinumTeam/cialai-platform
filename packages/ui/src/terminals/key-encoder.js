// SPDX-License-Identifier: Apache-2.0
// Sequências que um terminal de verdade envia para cada tecla especial.
//
// O teclado especial do celular não tem eventos de teclado para entregar ao
// xterm: cada toque vira, aqui, os bytes que o xterm mandaria ao PTY para a
// mesma tecla. A tabela segue o `evaluateKeyboardEvent` do próprio xterm
// (`@xterm/xterm/src/common/input/Keyboard.ts`), e `check-special-keys.mjs`
// confere a paridade com ele. Onde o xterm deixa a tecla para o navegador,
// porque no computador ela é atalho do sistema, vale o que o xterm e o GNOME
// Terminal mandam no Linux:
//
// - Ctrl Shift letra sai como Ctrl letra. Nenhum programa anuncia ao terminal
//   que entende o CSI u, então mandar `ESC[112;6u` imprimiria lixo na maioria
//   deles; quem distingue Ctrl Shift P o faz pelo mesmo byte em todo terminal.
// - Insert, Page Up e Page Down levam o modificador no parâmetro, `ESC[5;5~`,
//   em vez de rolar a tela local ou sumir.
// - Meta é o bit 8 do parâmetro nas teclas de cursor e, nos caracteres, vale
//   como Alt: prefixa ESC, como o `metaSendsEscape` do xterm.
// - Ctrl Alt com dígito ou símbolo mantém o Ctrl, `ESC ^@` para Ctrl Alt 2,
//   como o xterm do X11; o xterm.js descarta o Ctrl nesse caso.
//
// Um modificador sozinho não é tecla: devolve `null` e nada é enviado.

export const ESC = '\x1b';
const DEL = '\x7f';

export const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'];

// Parâmetro de modificador do xterm: 1 + Shift 1 + Alt 2 + Ctrl 4 + Meta 8.
export function modifierParam(mods = {}) {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0) + (mods.meta ? 8 : 0);
}

const anyModifier = (mods) => MODIFIERS.some((name) => mods[name]);

// Cursor e Home/End: `ESC[1;mX` com modificador, SS3 no modo de aplicação
// (DECCKM, ligado por vim, less e pelas interfaces de tela cheia) e CSI fora
// dele.
const CURSOR = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
// Teclas do bloco de edição, no formato `ESC[n~`.
const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
// F1 a F4 saem em SS3 sem modificador.
const SS3_FUNCTION = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

// Shift sobre o teclado americano, o mesmo mapa que o xterm usa para Alt.
const SHIFTED = {
  1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  ';': ':', '=': '+', ',': '<', '-': '_', '.': '>', '/': '?', '`': '~', '[': '{', '\\': '|', ']': '}', "'": '"',
};

// Ctrl com caractere que não é letra, como nos terminais do Linux: Ctrl 2 e
// Ctrl espaço são NUL, Ctrl 3 a 7 caem de ESC a US, Ctrl 8 e Ctrl ? são DEL.
const CONTROL_SYMBOLS = {
  ' ': '\x00', '@': '\x00', 2: '\x00',
  '[': ESC, 3: ESC,
  '\\': '\x1c', 4: '\x1c',
  ']': '\x1d', 5: '\x1d',
  '^': '\x1e', 6: '\x1e',
  '_': '\x1f', 7: '\x1f', '/': '\x1f', '-': '\x1f',
  '?': DEL, 8: DEL,
};

export const SPECIAL_KEYS = ['Escape', 'Tab', 'Enter', 'Backspace', ...Object.keys(CURSOR), ...Object.keys(TILDE), ...Object.keys(SS3_FUNCTION)];

export function isModifier(key) {
  return MODIFIERS.includes(String(key).toLowerCase());
}

// Um único ponto de código imprimível: o que o teclado nativo entrega numa
// tecla, e o que um modificador armado pode combinar.
export function isSingleCharacter(data) {
  if (typeof data !== 'string' || !data) return false;
  const points = [...data];
  if (points.length !== 1) return false;
  const code = points[0].codePointAt(0);
  return code >= 0x20 && code !== 0x7f;
}

function encodeCharacter(char, mods) {
  let text = char;
  if (mods.shift) text = SHIFTED[text] ?? text.toUpperCase();
  if (mods.ctrl) {
    const lower = char.toLowerCase();
    if (lower >= 'a' && lower <= 'z' && lower.length === 1) text = String.fromCharCode(lower.charCodeAt(0) - 96);
    else if (CONTROL_SYMBOLS[text] !== undefined) text = CONTROL_SYMBOLS[text];
    else if (CONTROL_SYMBOLS[char] !== undefined) text = CONTROL_SYMBOLS[char];
  }
  return mods.alt || mods.meta ? ESC + text : text;
}

// `key` é um nome de `SPECIAL_KEYS` ou um caractere; `mods` traz ctrl, alt,
// shift e meta; `applicationCursor` é o DECCKM do terminal agora.
export function encodeKey(key, mods = {}, { applicationCursor = false } = {}) {
  if (typeof key !== 'string' || !key || isModifier(key)) return null;
  const param = modifierParam(mods);
  const modified = anyModifier(mods);
  switch (key) {
    case 'Escape': return mods.alt || mods.meta ? ESC + ESC : ESC;
    case 'Tab': return mods.shift ? `${ESC}[Z` : '\t';
    case 'Enter': return mods.alt || mods.meta ? ESC + '\r' : '\r';
    case 'Backspace': {
      const base = mods.ctrl ? '\b' : DEL;
      return mods.alt || mods.meta ? ESC + base : base;
    }
    default: break;
  }
  if (CURSOR[key]) {
    if (modified) return `${ESC}[1;${param}${CURSOR[key]}`;
    return applicationCursor ? `${ESC}O${CURSOR[key]}` : `${ESC}[${CURSOR[key]}`;
  }
  if (SS3_FUNCTION[key]) return modified ? `${ESC}[1;${param}${SS3_FUNCTION[key]}` : `${ESC}O${SS3_FUNCTION[key]}`;
  if (TILDE[key]) return modified ? `${ESC}[${TILDE[key]};${param}~` : `${ESC}[${TILDE[key]}~`;
  if (isSingleCharacter(key)) return encodeCharacter(key, mods);
  return null;
}
