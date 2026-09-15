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
