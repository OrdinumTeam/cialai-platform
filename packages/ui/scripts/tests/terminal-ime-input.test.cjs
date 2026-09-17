// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/ime-input.js');

// Campo oculto do xterm e a ordem em que o Chromium do Android entrega uma
// operacao do IME: keydown 229, mudanca do valor com input, keyup 229. O
// timer de 0 ms so roda quando o teste manda, o que simula teclas chegando
// juntas antes dele.
async function harness() {
  const { createImeInput, DEL } = await load();
  const field = { value: '' };
  const sent = [];
  const timers = [];
  const ime = createImeInput({ read: () => field.value, send: (data) => sent.push(data), schedule: (callback) => timers.push(callback) });
  const runTimers = () => { while (timers.length) timers.shift()(); };
  const change = (value) => { field.value = value; ime.input(); };
  const key = (edit) => { ime.key(); edit(); ime.end(); };
  const commit = (text) => key(() => change(field.value + text));
  const erase = (count = 1) => key(() => change([...field.value].slice(0, -count).join('')));
  // Enter do teclado: o xterm trata no keydown, envia CR e limpa o campo.
  const enter = () => { ime.flush(); sent.push('\r'); field.value = ''; };
  return { ime, field, sent, runTimers, change, key, commit, erase, enter, DEL };
}

test('a sequencia do adb chega uma vez so', async () => {
  const { sent, runTimers, commit } = await harness();
  commit('e'); runTimers();
  commit('c'); runTimers();
  for (const character of 'o020') commit(character);
  runTimers();
  assert.deepEqual(sent, ['e', 'c', 'o020']);
  assert.equal(sent.join(''), 'eco020');
});

test('uma tecla por vez continua saindo tecla a tecla', async () => {
  const { sent, runTimers, commit } = await harness();
  for (const character of 'eco020') { commit(character); runTimers(); }
  assert.deepEqual(sent, ['e', 'c', 'o', '0', '2', '0']);
});

test('o campo crescendo varias letras num evento vale para aquela tecla', async () => {
  const { sent, runTimers, key, change, field } = await harness();
  key(() => { change(`${field.value}ab`); change(`${field.value}c`); });
  key(() => change(`${field.value}de`));
  runTimers();
  assert.equal(sent.join(''), 'abcde');
});

test('insertText com mais de um caractere, como sugestao aceita, sai inteiro', async () => {
  const { sent, runTimers, commit } = await harness();
  commit('git '); commit('status'); commit(' ');
  runTimers();
  assert.equal(sent.join(''), 'git status ');
});

test('apagar e reescrever no mesmo lote mantem a ordem das teclas', async () => {
  const { sent, runTimers, commit, erase, DEL } = await harness();
  commit('ls'); runTimers();
  commit('x'); erase(); commit(' -la');
  runTimers();
  assert.deepEqual(sent, ['ls', `x${DEL} -la`]);
});

test('autocorrecao troca a palavra com DEL por caractere apagado', async () => {
  const { sent, runTimers, commit, erase, DEL } = await harness();
  commit('teh'); runTimers();
  erase(3); commit('the ');
  runTimers();
  assert.deepEqual(sent, ['teh', `${DEL.repeat(3)}the `]);
});

test('um emoji apagado custa um DEL so', async () => {
  const { textareaDelta, DEL } = await load();
  assert.equal(textareaDelta('ok 😀', 'ok '), DEL);
  assert.equal(textareaDelta('😀', '😃'), `${DEL}😃`);
  assert.equal(textareaDelta('abc', 'abc'), '');
  assert.equal(textareaDelta('ab', 'abcd'), 'cd');
});

test('Enter logo depois das teclas envia o texto antes do CR e nada depois', async () => {
  const { sent, runTimers, commit, enter } = await harness();
  commit('l'); commit('s'); enter();
  runTimers();
  commit('p'); commit('w'); commit('d');
  runTimers();
  assert.deepEqual(sent, ['ls', '\r', 'pwd']);
});

test('campo limpo depois do envio nao vira DEL nem repete texto', async () => {
  const { sent, runTimers, commit, field } = await harness();
  commit('ab'); commit('c');
  // Colar ou perder o foco: o xterm limpa o campo sem evento de input.
  field.value = '';
  runTimers();
  commit('d');
  runTimers();
  assert.deepEqual(sent, ['abc', 'd']);
});

test('texto da composicao fica com o xterm e o digito antes dela sai uma vez', async () => {
  const { ime, sent, runTimers, commit, field } = await harness();
  commit('2');
  // Acento composto: keydown 229, compositionstart e o input da composicao.
  ime.key();
  ime.end();
  field.value += 'á';
  ime.input();
  runTimers();
  assert.deepEqual(sent, ['2']);
  // Tecla nova depois da composicao terminada conta a partir do campo atual.
  commit('b');
  runTimers();
  assert.deepEqual(sent, ['2', 'b']);
});

test('input depois do keyup, como emoji sem keydown, nao conta para a tecla anterior', async () => {
  const { ime, sent, runTimers, commit, field } = await harness();
  commit('1');
  field.value += '😀';
  ime.input();
  runTimers();
  assert.deepEqual(sent, ['1']);
});

test('keydown 229 sem mudanca no campo nao envia nada', async () => {
  const { ime, sent, runTimers } = await harness();
  ime.key(); ime.end(); ime.key(); ime.end();
  runTimers();
  assert.deepEqual(sent, []);
});

function fakeTerminal({ withHelper = true } = {}) {
  const textarea = new EventTarget();
  textarea.value = '';
  // O metodo original fica no prototipo, como na classe do xterm.
  const helper = Object.create({ _handleAnyTextareaChanges() { throw new Error('metodo original do xterm chamado'); } });
  const inputs = [];
  // Sem arvore de DOM em Node: o elemento e o proprio campo, o que basta para
  // o ouvinte de captura receber o keydown com target no campo.
  return { textarea, element: textarea, _core: withHelper ? { _compositionHelper: helper } : {}, input: (data, user) => inputs.push([data, user]), helper, inputs };
}

const event = (type, fields = {}) => Object.assign(new Event(type), fields);

test('installImeInput troca a comparacao do xterm e envia pelo input publico', async () => {
  const { installImeInput } = await load();
  const term = fakeTerminal();
  const timers = [];
  const installed = installImeInput(term, { schedule: (callback) => timers.push(callback) });
  for (const character of 'o020') {
    term.textarea.dispatchEvent(event('keydown', { keyCode: 229 }));
    term.helper._handleAnyTextareaChanges();
    term.textarea.value += character;
    term.textarea.dispatchEvent(event('input'));
    term.textarea.dispatchEvent(event('keyup', { keyCode: 229 }));
  }
  term.textarea.dispatchEvent(event('keydown', { keyCode: 13 }));
  assert.deepEqual(term.inputs, [['o020', true]]);
  timers.forEach((callback) => callback());
  assert.deepEqual(term.inputs, [['o020', true]]);
  installed.dispose();
  assert.throws(() => term.helper._handleAnyTextareaChanges(), /metodo original/);
});

test('installImeInput nao mexe num xterm sem o CompositionHelper esperado', async () => {
  const { installImeInput } = await load();
  const term = fakeTerminal({ withHelper: false });
  assert.doesNotThrow(() => installImeInput(term).dispose());
});

test('o xterm fixado ainda tem o metodo que a correcao substitui', () => {
  const { readFileSync } = require('node:fs');
  const bundle = readFileSync(require.resolve('@xterm/xterm/lib/xterm.mjs', { paths: [__dirname] }), 'utf8');
  assert.match(bundle, /this\._compositionHelper=/);
  assert.match(bundle, /_handleAnyTextareaChanges\(\)\{let \w+=this\._textarea\.value;setTimeout\(/);
  assert.match(bundle, /input\(\w+,\w+=!0\)\{this\._core\.input\(/);
});

// --- Composicao com o CompositionHelper real do xterm ---------------------
//
// O helper real do xterm nao e exportado e so nasce dentro de Terminal.open,
// que precisa de DOM completo. Aqui vai uma replica fiel da classe do
// @xterm/xterm 6.0.0 (a classe $t em lib/xterm.mjs): compositionstart,
// compositionupdate, compositionend, _finalizeComposition, keydown e
// _handleAnyTextareaChanges, com os mesmos setTimeout. O teste acima prende
// esta replica a versao instalada; se o bundle mudar, ele acusa.

test('@xterm/xterm instalado e a versao que a replica de composicao segue', () => {
  const version = require('@xterm/xterm/package.json').version;
  assert.equal(version, '6.0.0', 'atualize a replica do CompositionHelper ao trocar de versao');
});

function realisticCompositionHelper(textarea, triggerDataEvent, schedule) {
  return {
    _isComposing: false,
    _isSendingComposition: false,
    _compositionPosition: { start: 0, end: 0 },
    _dataAlreadySent: '',
    get isComposing() { return this._isComposing; },
    compositionstart() {
      this._isComposing = true;
      this._compositionPosition.start = textarea.value.length;
      this._dataAlreadySent = '';
    },
    compositionupdate() {
      schedule(() => { this._compositionPosition.end = textarea.value.length; });
    },
    compositionend() { this._finalizeComposition(true); },
    keydown(event) {
      if (this._isComposing || this._isSendingComposition) {
        if ([20, 229, 16, 17, 18].includes(event.keyCode)) return false;
        this._finalizeComposition(false);
      }
      if (event.keyCode === 229) { this._handleAnyTextareaChanges(); return false; }
      return true;
    },
    _finalizeComposition(sendComposition) {
      this._isComposing = false;
      if (sendComposition) {
        const position = { start: this._compositionPosition.start, end: this._compositionPosition.end };
        this._isSendingComposition = true;
        schedule(() => {
          if (this._isSendingComposition) {
            this._isSendingComposition = false;
            position.start += this._dataAlreadySent.length;
            const data = this._isComposing
              ? textarea.value.substring(position.start, this._compositionPosition.start)
              : textarea.value.substring(position.start);
            if (data.length > 0) triggerDataEvent(data);
          }
        });
      } else {
        this._isSendingComposition = false;
        triggerDataEvent(textarea.value.substring(this._compositionPosition.start, this._compositionPosition.end));
      }
    },
    _handleAnyTextareaChanges() {
      const before = textarea.value;
      schedule(() => {
        if (!this._isComposing) {
          const now = textarea.value;
          const added = now.replace(before, '');
          this._dataAlreadySent = added;
          if (now.length > before.length) triggerDataEvent(added);
          else if (now.length < before.length) triggerDataEvent(DEL_CHAR);
          else if (now.length === before.length && now !== before) triggerDataEvent(now);
        }
      });
    },
  };
}

const DEL_CHAR = String.fromCharCode(0x7f);

async function composeHarness() {
  const { installImeInput } = await load();
  const textarea = new EventTarget();
  textarea.value = '';
  const sent = [];
  const timers = [];
  const schedule = (callback) => timers.push(callback);
  const helper = realisticCompositionHelper(textarea, (data) => sent.push(data), schedule);
  // Sem arvore de DOM: o elemento e o proprio campo, como nos outros testes.
  const term = { _core: { _compositionHelper: helper }, textarea, element: textarea, input: (data) => sent.push(data) };
  // Ouvintes do proprio xterm, registrados antes da correcao, como na classe.
  textarea.addEventListener('keydown', (event) => helper.keydown(event), true);
  textarea.addEventListener('compositionstart', () => helper.compositionstart());
  textarea.addEventListener('compositionupdate', (event) => helper.compositionupdate(event));
  textarea.addEventListener('compositionend', () => helper.compositionend());
  const installed = installImeInput(term, { schedule });
  const runTimers = () => { while (timers.length) timers.shift()(); };
  const emit = (type, fields = {}) => textarea.dispatchEvent(event(type, fields));
  // Uma composicao inteira. `steps` sao os valores do campo a cada tecla; cada
  // tecla chega com keydown 229, o compositionstart vem antes do primeiro
  // input, e `flushFirst` roda o timer do rastreador antes do compositionstart
  // para exercer a ordem do WKWebView do iOS.
  const compose = (steps, { flushFirst = false } = {}) => {
    // A composicao acrescenta ao que ja estava no campo, nao apaga o prefixo.
    const base = textarea.value;
    steps.forEach((value, index) => {
      emit('keydown', { keyCode: IME_KEY_CODE });
      if (index === 0 && flushFirst) runTimers();
      if (index === 0) emit('compositionstart');
      textarea.value = base + value;
      emit('compositionupdate', { data: value });
      emit('input', { isComposing: true });
    });
    emit('compositionend', { data: textarea.value });
    runTimers();
  };
  const type = (text) => {
    for (const character of text) {
      emit('keydown', { keyCode: IME_KEY_CODE });
      textarea.value += character;
      emit('input');
      emit('keyup', { keyCode: IME_KEY_CODE });
    }
  };
  return { sent, compose, type, runTimers, installed };
}

const IME_KEY_CODE = 229;

for (const flushFirst of [false, true]) {
  const order = flushFirst ? 'flush antes do compositionstart, como no iOS' : 'flush depois, como no Android';
  test(`composicao de ç, á e ã sai uma vez so (${order})`, async () => {
    for (const character of ['ç', 'á', 'ã']) {
      const { sent, compose } = await composeHarness();
      compose([character], { flushFirst });
      assert.deepEqual(sent, [character], `${character} nao pode duplicar nem vazar o parcial`);
    }
  });

  test(`dead key ´ seguida de c compoe uma vez so (${order})`, async () => {
    const { sent, compose } = await composeHarness();
    // Acento agudo seguido de c: o campo passa por ´ e termina em ć.
    compose(['´', 'ć'], { flushFirst });
    assert.deepEqual(sent, ['ć'], 'o parcial ´ nao pode sair junto do composto');
  });

  test(`a sequencia do Android c mais ¸ compoe ç uma vez so (${order})`, async () => {
    const { sent, compose } = await composeHarness();
    // c e depois a cedilha combinante, tudo dentro da mesma composicao.
    compose(['c', 'ç'], { flushFirst });
    assert.deepEqual(sent, ['ç'], 'o c nao pode ficar solto antes do ç');
  });
}

test('digitacao normal antes de uma composicao nao e engolida pela composicao', async () => {
  const { sent, type, compose } = await composeHarness();
  type('ls ');
  compose(['á']);
  assert.equal(sent.join(''), 'ls á', 'as teclas anteriores continuam saindo, so o parcial da composicao e descartado');
});

test('c seguido da cedilha combinante U+0327 sai como um unico ç pelo caminho do rastreador', async () => {
  const { textareaDelta } = await load();
  assert.equal(textareaDelta('c', 'ç'), `${DEL_CHAR}ç`, 'apaga o c e envia o ç normalizado em NFC');
  assert.equal(textareaDelta('', 'ç'), 'ç', 'a cedilha combinante entra ja composta');
});
