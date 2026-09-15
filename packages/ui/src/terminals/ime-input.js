// SPDX-License-Identifier: Apache-2.0
// Texto que o teclado virtual entrega ao campo oculto do xterm.
//
// O Android, e qualquer IME, anuncia cada tecla como keydown 229 e so depois
// muda o valor do campo. O xterm 6 guarda o valor nesse keydown e, num
// setTimeout de 0 ms, envia a diferenca para o valor atual. Quando varias
// teclas chegam antes do primeiro timer rodar (digitacao rapida com a pagina
// ocupada, IME que entrega varias operacoes de uma vez, adb), cada timer ve
// tambem o texto das teclas seguintes: `eco020` vira `e`, `c`, `o020`, `020`,
// `20`, `0`. E, se um Enter limpar o campo antes do timer, o texto pendente
// sai depois do Enter como um DEL.
//
// Aqui cada tecla vale so o que mudou entre o proprio keydown e o fim do
// proprio evento: o ultimo input antes do keyup, do keydown seguinte ou do
// inicio de uma composicao. O texto pendente sai numa escrita so, e antes de
// qualquer tecla que o xterm trate direto no keydown, como Enter e Ctrl C. O
// que a composicao digita, acentos inclusive, continua com o
// CompositionHelper do proprio xterm.
//
// Sem DOM na conta: quem liga aos eventos injeta leitura do campo, envio e
// agendador, o que deixa a logica testavel em Node.

export const DEL = String.fromCharCode(0x7f);
export const IME_KEY_CODE = 229;

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

// O que o terminal precisa receber para a linha passar de `before` a `after`:
// um DEL por caractere apagado depois do prefixo comum e o texto novo. Conta
// pontos de codigo, nao unidades UTF-16, para um emoji custar um DEL so.
export function textareaDelta(before, after) {
  if (before === after) return '';
  const limit = Math.min(before.length, after.length);
  let common = 0;
  while (common < limit && before.charCodeAt(common) === after.charCodeAt(common)) common += 1;
  if (common > 0 && common < before.length && isHighSurrogate(before.charCodeAt(common - 1))) common -= 1;
  return DEL.repeat([...before.slice(common)].length) + after.slice(common);
}

export function createImeInput({ read, send, schedule }) {
  let entries = [];
  let scheduled = false;

  function close() {
    const entry = entries[entries.length - 1];
    if (!entry?.open) return;
    entry.open = false;
    if (entry.after === null) entry.after = read();
  }

  function flush() {
    scheduled = false;
    if (!entries.length) return;
    const pending = entries;
    entries = [];
    let data = '';
    for (const entry of pending) data += textareaDelta(entry.before, entry.after ?? read());
    if (data) send(data);
  }

  return {
    // O xterm viu um keydown 229 fora de composicao.
    key() {
      close();
      entries.push({ before: read(), after: null, open: true });
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    // O campo mudou; so conta para a tecla que ainda nao terminou.
    input() {
      const entry = entries[entries.length - 1];
      if (entry?.open) entry.after = read();
    },
    // keyup ou compositionstart: o que vier depois nao e desta tecla.
    end() {
      close();
    },
    // Uma tecla tratada no keydown vai sair agora; o pendente sai antes dela.
    flush() {
      close();
      flush();
    },
  };
}

// Liga a conta ao xterm aberto. Troca so o metodo do CompositionHelper que
// compara o campo; se a versao do xterm nao tiver esse formato, nada muda.
export function installImeInput(term, { schedule = (callback) => setTimeout(callback, 0) } = {}) {
  const helper = term?._core?._compositionHelper;
  const textarea = term?.textarea;
  const element = term?.element;
  if (!textarea || !element || typeof helper?._handleAnyTextareaChanges !== 'function') return { dispose() {} };

  let active = true;
  const tracker = createImeInput({
    read: () => textarea.value,
    send: (data) => { if (active) term.input(data, true); },
    schedule,
  });
  const onKeydown = (event) => {
    if (event.target === textarea && event.keyCode !== IME_KEY_CODE) tracker.flush();
  };
  const onInput = () => tracker.input();
  const onEnd = () => tracker.end();

  helper._handleAnyTextareaChanges = () => tracker.key();
  // Captura no elemento do terminal para rodar antes dos ouvintes do xterm,
  // que ficam no proprio campo.
  element.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keyup', onEnd);
  textarea.addEventListener('compositionstart', onEnd);

  return {
    dispose() {
      active = false;
      element.removeEventListener('keydown', onKeydown, true);
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('keyup', onEnd);
      textarea.removeEventListener('compositionstart', onEnd);
      delete helper._handleAnyTextareaChanges;
    },
  };
}
