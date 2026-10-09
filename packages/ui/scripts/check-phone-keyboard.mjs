// SPDX-License-Identifier: Apache-2.0
// Teclado especial e comandos rápidos do celular, renderizados de verdade e
// sem PTY. O comportamento das teclas é do controlador, coberto em
// `tests/terminal-special-keys.test.cjs`; aqui fica o que a tela mostra.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/terminals/${entry}`, import.meta.url))],
    bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  });
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, require: createRequire(import.meta.url), console,
    document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.module.exports;
}

const sheet = await load('ui/PhoneKeyboardSheet.jsx');
const quick = await load('ui/PhoneQuickCommands.jsx');
const { createKeyController } = await import('../src/terminals/special-keys.js');
const { defaultKeyboardPrefs } = await import('../src/terminals/keyboard-prefs.js');

function renderSheet(props = {}) {
  const controller = createKeyController({ send: () => true });
  if (props.arm) props.arm.forEach((name) => controller.toggleModifier(name));
  return renderToStaticMarkup(React.createElement(sheet.default, {
    open: true, controller, state: controller.getState(), interactive: true, prefs: defaultKeyboardPrefs(),
    onPrefsChange() {}, onPaste() {}, onNativeKeyboard() {}, onClose() {}, ...props,
  }));
}
const labels = (html) => [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);

test('o painel fechado não renderiza nada', () => {
  assert.equal(renderSheet({ open: false }), '');
});

test('cabeçalho da referência: puxador, título, preferências, fechar e quatro abas', () => {
  const html = renderSheet();
  assert.match(html, /phone-keys__grabber/);
  assert.match(html, /<h2>Teclado especial<\/h2>/);
  assert.match(html, /aria-label="Preferências do teclado"/);
  assert.match(html, /aria-label="Fechar o teclado especial"/);
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['Básico', 'Navegação', 'Edição', 'Símbolos']);
  assert.match(html, /aria-selected="true"[^>]*>Básico/);
  assert.match(html, /Fechar teclado/);
});

test('Básico: Esc, Tab, Enter, Backspace, os quatro modificadores e as setas em cruz', () => {
  const html = renderSheet();
  for (const key of ['Esc', 'Tab', 'Enter', 'Backspace', 'Seta para cima', 'Seta para a esquerda', 'Seta para baixo', 'Seta para a direita']) assert.ok(labels(html).includes(key), key);
  const modifiers = [...html.matchAll(/phone-keys__modifier[^"]*" aria-pressed="(true|false)"[^>]*>(\w+)/g)].map((match) => `${match[2]}:${match[1]}`);
  assert.deepEqual(modifiers, ['Ctrl:false', 'Alt:false', 'Shift:false', 'Meta:false']);
  assert.match(html, /class="phone-dpad" role="group" aria-label="Setas"/);
  assert.equal(html.match(/phone-dpad__key /g)?.length, 4);
  // Os comandos mais usados nos agentes já vêm na primeira aba; Colar é Ctrl V, para o agente colar no computador.
  for (const key of ['Shift Tab, modo do agente', 'Ctrl C, interromper', 'Colar no computador, Ctrl V', 'Ctrl R, buscar histórico']) assert.ok(labels(html).includes(key), key);
  assert.match(html, /phone-keys__label">Colar<\/span><span class="phone-keys__hint" aria-hidden="true">Ctrl V</);
});

test('modificador armado aparece selecionado, e o rodapé oferece digitar a próxima tecla', () => {
  const html = renderSheet({ arm: ['ctrl', 'shift'] });
  assert.match(html, /phone-keys__modifier is-armed" aria-pressed="true"[^>]*>Ctrl/);
  assert.match(html, /phone-keys__modifier is-armed" aria-pressed="true"[^>]*>Shift/);
  assert.match(html, /phone-keys__modifier" aria-pressed="false"[^>]*>Alt/);
  assert.match(html, /Digitar a próxima tecla/);
  assert.doesNotMatch(html, /phone-keys__lock/, 'cadeado só no modo fixo');
});

test('modo fixo mostra o cadeado no modificador preso', () => {
  const controller = createKeyController({ send: () => true, mode: 'sticky' });
  controller.toggleModifier('alt');
  const html = renderSheet({ controller, state: controller.getState() });
  assert.match(html, /is-armed[^>]*>Alt<svg[^>]*phone-keys__lock/);
});

test('Navegação, Edição e Símbolos trazem as teclas pedidas', () => {
  const navigation = labels(renderSheet({ initialTab: 'navigation' }));
  for (const key of ['Seta para cima', 'Home', 'End', 'Page Up', 'Page Down']) assert.ok(navigation.includes(key), key);
  const editing = renderSheet({ initialTab: 'editing' });
  for (const key of ['Delete', 'Insert', 'Ctrl D, fim da entrada', 'Ctrl A, início da linha', 'Ctrl Z, suspender', 'Colar da área de transferência, do celular']) assert.ok(labels(editing).includes(key), key);
  assert.ok(!labels(editing).includes('Ctrl C, interromper'), 'o que já está no Básico não se repete');
  const symbols = labels(renderSheet({ initialTab: 'symbols' }));
  for (const key of ['F1', 'F12', '|', '~', '/', '\\', '$', '&gt;']) assert.ok(symbols.includes(key) || symbols.includes(key.replace('&gt;', '>')), key);
});

test('sem terminal interativo todas as teclas ficam desabilitadas, e fechar continua valendo', () => {
  const html = renderSheet({ interactive: false });
  const keys = html.match(/<button[^>]*class="phone-(keys__key|dpad__key)[^"]*"[^>]*>/g) || [];
  assert.ok(keys.length >= 12);
  assert.ok(keys.every((button) => button.includes('disabled=""')));
  assert.doesNotMatch(html.match(/<button[^>]*phone-keys__foot-button--close[^>]*>/)[0], /disabled/);
});

test('preferências: favoritos em ordem, modo dos modificadores, abertura automática e vibração só se houver', () => {
  const prefs = { ...defaultKeyboardPrefs(), favorites: ['CtrlC', 'Escape', 'Tab'], modifierMode: 'sticky' };
  const without = renderToStaticMarkup(React.createElement(sheet.KeyboardPreferences, { prefs, onChange() {}, canVibrate: false }));
  assert.deepEqual([...without.matchAll(/<li><span>([^<]+)<\/span>/g)].map((match) => match[1]), ['Ctrl C', 'Esc', 'Tab']);
  assert.match(without, /checked="" value="sticky"/);
  assert.match(without, /Abrir ao entrar no terminal/);
  assert.doesNotMatch(without, /Vibrar ao tocar/);
  assert.match(without, /phone-keys__chip" aria-pressed="false" disabled=""[^>]*>Enter/, 'barra cheia não aceita outro favorito');
  const withVibration = renderToStaticMarkup(React.createElement(sheet.KeyboardPreferences, { prefs, onChange() {}, canVibrate: true }));
  assert.match(withVibration, /Vibrar ao tocar/);
});

const memory = (value) => ({ getItem: () => (value === undefined ? null : JSON.stringify(value)), setItem() {}, removeItem() {} });
const renderQuick = (props = {}) => renderToStaticMarkup(React.createElement(quick.default, {
  open: true, interactive: true, onInsert: async () => true, onRun: async () => true, onClose() {}, storage: memory(), ...props,
}));

test('comandos rápidos: busca, os quatro exemplos e o gerenciar, sem executar nada', () => {
  const html = renderQuick();
  assert.match(html, /placeholder="Digite um comando rápido…"/);
  const titles = [...html.matchAll(/phone-quick__item-title">([^<]+)/g)].map((match) => match[1]);
  assert.deepEqual(titles, ['git status', 'git pull', 'npm run dev', 'docker compose up']);
  assert.match(html, /Ver o estado do repositório/);
  assert.match(html, /Gerenciar comandos rápidos/);
  assert.doesNotMatch(html, /Executar|Inserir/, 'a lista só abre a prévia');
  assert.equal(renderQuick({ open: false }), '');
});

test('comando destrutivo aparece marcado na lista', () => {
  const html = renderQuick({ storage: memory([{ id: 'a', command: 'git reset --hard' }, { id: 'b', command: 'ls' }]) });
  assert.match(html, /phone-quick__item-icon is-danger/);
  assert.equal(html.match(/is-danger/g).length, 1);
});

test('prévia mostra o comando e as duas ações; destrutivo traz o aviso', () => {
  const render = (entry, interactive = true) => renderToStaticMarkup(React.createElement(quick.Preview, { entry, interactive, onInsert: async () => true, onRun: async () => true }));
  const safe = render({ id: 'a', command: 'git status', label: '', description: 'terminal.phone.quick.seed.gitStatus' });
  assert.match(safe, /<pre class="phone-quick__code"[^>]*>git status<\/pre>/);
  assert.match(safe, /Inserir/);
  assert.match(safe, /Executar/);
  assert.doesNotMatch(safe, /phone-quick__warning/);
  const danger = render({ id: 'b', command: 'rm -rf dist', label: 'Limpar' });
  assert.match(danger, /phone-quick__warning/);
  assert.match(danger, /difícil de desfazer/);
  const asked = render({ id: 'c', command: 'make deploy', confirm: true });
  assert.match(asked, /pede confirmação/);
  const offline = render({ id: 'd', command: 'ls' }, false);
  assert.equal(offline.match(/disabled=""/g).length, 2, 'sem terminal Inserir e Executar ficam desabilitados');
});

test('gerenciar e formulário: editar, remover, reordenar e o aviso de segredo', () => {
  const commands = [{ id: 'a', command: 'git status' }, { id: 'b', command: 'npm test', label: 'Testes' }];
  const manager = renderToStaticMarkup(React.createElement(quick.Manager, { commands, onEdit() {}, onAdd() {}, onMove() {}, onRemove() {} }));
  for (const label of ['Mover git status para cima', 'Mover Testes para baixo', 'Editar Testes', 'Remover git status']) assert.ok(labels(manager).includes(label), label);
  assert.match(manager, /disabled=""[^>]*aria-label="Mover git status para cima"/);
  assert.match(manager, /Novo comando/);
  const form = renderToStaticMarkup(React.createElement(quick.Editor, { entry: { id: 'x', command: 'sudo reboot', label: '', description: '' }, onCancel() {}, onSave() {} }));
  assert.match(form, /Não guarde senhas nem tokens/);
  assert.match(form, /type="checkbox" disabled="" checked=""/, 'destrutivo sempre pede confirmação');
});

// Ligação dos botões ao controlador, com eventos de ponteiro como o navegador
// os entrega e o relógio na mão do teste.
function wiredKey(key, fixed) {
  const sent = [];
  const timers = [];
  let now = 0;
  const controller = createKeyController({
    send: (data) => { sent.push(data); return true; },
    schedule: (callback, ms) => { const timer = { at: now + ms, callback }; timers.push(timer); return timer; },
    cancel: (timer) => { if (timer) timer.cancelled = true; },
  });
  const pressed = [];
  const handlers = sheet.keyHandlers(controller, key, fixed, (event, done) => pressed.push(done ? 'click' : 'down'));
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((timer) => !timer.cancelled && !timer.ran && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at; next.ran = true; next.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = end;
  };
  return { sent, handlers, advance, pressed };
}
const event = () => { const calls = []; return { calls, preventDefault: () => calls.push('prevent') }; };

test('botão de tecla: toque curto envia uma vez, no click, e não rouba o foco do terminal', async () => {
  const key = wiredKey('Tab');
  const mouse = event();
  key.handlers.onMouseDown(mouse);
  key.handlers.onPointerDown(event());
  key.handlers.onPointerUp();
  key.handlers.onClick();
  await key.advance(1000);
  assert.deepEqual(key.sent, ['\t']);
  assert.deepEqual(mouse.calls, ['prevent'], 'o mousedown não tira o foco do terminal');
  assert.deepEqual(key.pressed, ['down', 'click']);
  const menu = event();
  key.handlers.onContextMenu(menu);
  assert.deepEqual(menu.calls, ['prevent'], 'o menu do toque longo não aparece');
});

test('botão de seta: segurar repete, sair do botão para, e o click do fim não duplica', async () => {
  const key = wiredKey('ArrowUp');
  key.handlers.onPointerDown(event());
  await key.advance(400 + 80 * 2);
  key.handlers.onPointerLeave();
  await key.advance(1000);
  key.handlers.onClick();
  assert.deepEqual(key.sent, Array(3).fill('\x1b[A'));
  const cancelled = wiredKey('ArrowDown');
  cancelled.handlers.onPointerDown(event());
  cancelled.handlers.onPointerCancel();
  await cancelled.advance(1000);
  assert.deepEqual(cancelled.sent, [], 'o sistema cancelou o toque antes da repetição');
});

test('a tecla com modificador próprio leva o modificador pelo botão', async () => {
  const key = wiredKey('c', { ctrl: true });
  key.handlers.onPointerDown(event());
  key.handlers.onPointerUp();
  key.handlers.onClick();
  assert.deepEqual(key.sent, ['\x03']);
});
