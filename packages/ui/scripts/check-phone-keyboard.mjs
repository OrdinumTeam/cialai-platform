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
const icons = await load('ui/PhoneKeyIcons.jsx');
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
// O miolo do botão com este nome acessível, e o ícone do mapa central.
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const face = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="${escaped(label)}"[^>]*>([\\s\\S]*?)</button>`))?.[1] ?? '';
const icon = (id, size) => renderToStaticMarkup(React.createElement(icons.KeyIcon, { id, size }));
const modifierButtons = (html) => [...html.matchAll(/<button[^>]*class="phone-keys__key phone-keys__modifier([^"]*)" aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => ({ armed: match[1].includes('is-armed'), pressed: match[2] === 'true', inner: match[3], name: match[3].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '') }));

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
  for (const key of ['Esc', 'Tab', 'Enter', 'Backspace, apagar', 'Seta para cima', 'Seta para a esquerda', 'Seta para baixo', 'Seta para a direita']) assert.ok(labels(html).includes(key), key);
  assert.deepEqual(modifierButtons(html).map((button) => `${button.name}:${button.pressed}`), ['Ctrl:false', 'Alt:false', 'Shift:false', 'Meta:false']);
  assert.match(html, /class="phone-dpad" role="group" aria-label="Setas"/);
  assert.equal(html.match(/phone-dpad__key /g)?.length, 4);
  // Os comandos mais usados nos agentes já vêm na primeira aba; Colar é Ctrl V, para o agente colar no computador.
  for (const key of ['Shift Tab, modo do agente', 'Ctrl C, interromper', 'Colar no computador, Ctrl V', 'Ctrl R, buscar histórico']) assert.ok(labels(html).includes(key), key);
});

test('as teclas com ícone usam o desenho do mapa central e uma legenda pequena', () => {
  const html = renderSheet();
  // O mesmo ícone da barra, vindo de PhoneKeyIcons.jsx, e a legenda embaixo.
  for (const [label, id, caption] of [
    ['Esc', 'Escape', 'Esc'], ['Tab', 'Tab', 'Tab'], ['Enter', 'Enter', 'Enter'], ['Backspace, apagar', 'Backspace', 'Apagar'],
    ['Shift Tab, modo do agente', 'ShiftTab', 'Shift Tab'], ['Ctrl C, interromper', 'CtrlC', 'Interromper'],
    ['Colar no computador, Ctrl V', 'CtrlV', 'Colar'], ['Ctrl R, buscar histórico', 'CtrlR', 'Histórico'],
  ]) assert.equal(face(html, label), `${icon(id)}<span class="phone-keys__caption" aria-hidden="true">${caption}</span>`, label);
  for (const id of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) assert.ok(html.includes(`phone-dpad__key--${id}"`) && html.includes(icon(id)), id);
  for (const [name, id] of [['Ctrl', 'ctrl'], ['Alt', 'alt'], ['Shift', 'shift'], ['Meta', 'meta']]) {
    assert.equal(modifierButtons(html).find((button) => button.name === name)?.inner, `${icon(id)}<span class="phone-keys__caption">${name}</span>`, name);
  }
  // Esc é o ⎋ desenhado para o painel, nunca a seta de desfazer; Ctrl C é o quadrado de parar, nunca o de copiar.
  assert.match(icon('Escape'), /class="lucide lucide-escape-key"/);
  assert.match(icon('CtrlC'), /class="lucide lucide-square"/);
  assert.doesNotMatch(html, /lucide-(undo|undo-2|rotate-ccw|copy)"/);
  // Tamanho e traço iguais em todos os ícones de tecla.
  const drawn = [...html.matchAll(/<button[^>]*class="phone-(?:keys__key|dpad__key)[^"]*"[^>]*><svg[^>]*>/g)].map((match) => match[0]);
  assert.equal(drawn.length, 16);
  assert.ok(drawn.every((svg) => /width="22" height="22"/.test(svg) && /stroke-width="2"/.test(svg)));
  // O teclado do aparelho continua no rodapé, com o ícone dele.
  assert.ok(html.includes(`${icon('native', 18)}Teclado do aparelho`));
});

test('modificador armado aparece selecionado, e o rodapé oferece digitar a próxima tecla', () => {
  const html = renderSheet({ arm: ['ctrl', 'shift'] });
  assert.deepEqual(modifierButtons(html).map((button) => `${button.name}:${button.armed}:${button.pressed}`), ['Ctrl:true:true', 'Alt:false:false', 'Shift:true:true', 'Meta:false:false']);
  assert.match(html, /Digitar a próxima tecla/);
  assert.doesNotMatch(html, /phone-keys__lock/, 'cadeado só no modo fixo');
});

test('modo fixo mostra o cadeado no modificador preso', () => {
  const controller = createKeyController({ send: () => true, mode: 'sticky' });
  controller.toggleModifier('alt');
  const html = renderSheet({ controller, state: controller.getState() });
  assert.match(modifierButtons(html).find((button) => button.name === 'Alt').inner, />Alt<\/span><svg[^>]*phone-keys__lock/);
});

test('Navegação, Edição e Símbolos trazem as teclas pedidas', () => {
  const navigation = labels(renderSheet({ initialTab: 'navigation' }));
  for (const key of ['Seta para cima', 'Home', 'End', 'Page Up', 'Page Down']) assert.ok(navigation.includes(key), key);
  const editing = renderSheet({ initialTab: 'editing' });
  for (const key of ['Delete', 'Insert', 'Ctrl D, fim da entrada', 'Ctrl A, início da linha', 'Ctrl Z, suspender', 'Colar da área de transferência, do celular']) assert.ok(labels(editing).includes(key), key);
  assert.ok(!labels(editing).includes('Ctrl C, interromper'), 'o que já está no Básico não se repete');
  // Colar do celular tem ícone próprio e legenda que o separa do Colar do computador.
  assert.equal(face(editing, 'Colar da área de transferência, do celular'), `${icon('Paste')}<span class="phone-keys__caption" aria-hidden="true">Colar do celular</span>`);
  assert.notEqual(icon('Paste'), icon('CtrlV'));
  const symbols = labels(renderSheet({ initialTab: 'symbols' }));
  for (const key of ['F1', 'F12', '|', '~', '/', '\\', '$', '&gt;']) assert.ok(symbols.includes(key) || symbols.includes(key.replace('&gt;', '>')), key);
});

test('toda aba tem Enter e Backspace, com o ícone da barra', () => {
  for (const tab of ['basic', 'navigation', 'editing', 'symbols']) {
    const html = renderSheet({ initialTab: tab });
    for (const [label, id] of [['Enter', 'Enter'], ['Backspace, apagar', 'Backspace']]) {
      assert.equal(labels(html).filter((item) => item === label).length, 1, `${label} em ${tab}`);
      assert.ok(face(html, label).startsWith(icon(id)), `${label} em ${tab}`);
    }
  }
  // Básico, Navegação e Edição começam pela mesma linha.
  for (const tab of ['basic', 'navigation', 'editing']) {
    assert.deepEqual(labels(renderSheet({ initialTab: tab }).split('class="phone-keys__grid"')[1]).slice(0, 4), ['Esc', 'Tab', 'Enter', 'Backspace, apagar'], tab);
  }
  // Em Símbolos os dois fecham as linhas das teclas de função.
  const functions = labels(renderSheet({ initialTab: 'symbols' }).split('phone-keys__grid--functions')[1].split('phone-keys__grid--symbols')[0]);
  assert.deepEqual(functions, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'Backspace, apagar', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Enter']);
});

test('sem terminal interativo todas as teclas ficam desabilitadas, e fechar continua valendo', () => {
  const html = renderSheet({ interactive: false });
  const keys = html.match(/<button[^>]*class="phone-(keys__key|dpad__key)[^"]*"[^>]*>/g) || [];
  assert.ok(keys.length >= 12);
  assert.ok(keys.every((button) => button.includes('disabled=""')));
  assert.doesNotMatch(html.match(/<button[^>]*phone-keys__foot-button--close[^>]*>/)[0], /disabled/);
});

test('preferências: favoritos em ordem, modo dos modificadores, abertura automática e vibração só se houver', () => {
  const prefs = { ...defaultKeyboardPrefs(), favorites: ['CtrlC', 'Escape', 'Tab', 'CtrlV'], modifierMode: 'sticky' };
  const without = renderToStaticMarkup(React.createElement(sheet.KeyboardPreferences, { prefs, onChange() {}, canVibrate: false }));
  // Cada favorito aparece com o ícone que tem na barra e o nome do painel.
  assert.deepEqual([...without.matchAll(/<li>(<svg[\s\S]*?<\/svg>)<span>([^<]+)<\/span>/g)].map((match) => [match[2], match[1]]), [['Interromper', icon('CtrlC', 18)], ['Esc', icon('Escape', 18)], ['Tab', icon('Tab', 18)], ['Colar', icon('CtrlV', 18)]]);
  const chips = [...without.matchAll(/<button[^>]*class="phone-keys__chip[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1].replace(/<svg[\s\S]*?<\/svg>/g, ''));
  assert.deepEqual(chips, ['Esc', 'Tab', 'Enter', 'Shift Tab', 'Interromper', 'Colar', 'Ctrl D', 'Ctrl L', 'Histórico', 'Ctrl Z', 'Apagar', 'Home', 'End', 'Colar do celular']);
  assert.equal(new Set(chips).size, chips.length, 'nenhum nome repetido entre os favoritos');
  assert.match(without, /checked="" value="sticky"/);
  assert.match(without, /Abrir ao entrar no terminal/);
  assert.doesNotMatch(without, /Vibrar ao tocar/);
  assert.match(without, /phone-keys__chip" aria-pressed="false" disabled=""[^>]*><svg[\s\S]*?<\/svg>Enter</, 'barra cheia não aceita outro favorito');
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

test('o ícone de cada comando rápido fica solto, sem placa, no acento ou no vermelho', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(fileURLToPath(new URL('../src/views/Terminais.css', import.meta.url)), 'utf8');
  const rule = (selector) => css.split('\n').find((line) => line.startsWith(`[data-form-factor="phone"] ${selector} {`)) || '';
  assert.match(rule('.phone-quick__item-icon'), /width: 36px; height: 36px; color: var\(--mac-accent-text\);/, 'a largura fica para os títulos não saírem do lugar');
  assert.doesNotMatch(rule('.phone-quick__item-icon'), /background|border-radius/);
  assert.match(rule('.phone-quick__item-icon.is-danger'), /color: var\(--phone-danger\)/);
  assert.doesNotMatch(rule('.phone-quick__item-icon.is-danger'), /background/);
});

test('alvo de toque: a área de cada tecla avança para os lados até o meio do vão, e o painel dá retorno ao toque', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(fileURLToPath(new URL('../src/views/Terminais.css', import.meta.url)), 'utf8');
  assert.match(css, /\.phone-keys__key::after,\n\[data-form-factor="phone"\] \.phone-dpad__key::after \{ content: ""; position: absolute; inset: 0 -5px; \}/);
  // No telefone de 320 px a barra e o painel ganham largura para os sete alvos de 44 px.
  assert.match(css, /@media \(max-width: 339px\) \{\n  \[data-form-factor="phone"\] \.phone-keybar \{ margin-inline: -4px; \}\n  \[data-form-factor="phone"\] \.phone-keys \{ padding-left: 8px; padding-right: 8px; \}\n/);
  assert.match(css, /\.phone-keys__key:not\(:disabled\):active,\n\[data-form-factor="phone"\] \.phone-dpad__key:not\(:disabled\):active \{[^}]*transform: scale/);
  assert.match(css, /\.phone-keys__tab:active,[\s\S]*?\.phone-keys__chip:not\(:disabled\):active \{ opacity: \.7; \}/);
});
