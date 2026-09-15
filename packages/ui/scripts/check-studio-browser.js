// SPDX-License-Identifier: Apache-2.0
// Imported by a visible development page opened with
// ?terminais=demo&motion=0. The title is the machine-readable result.
import * as runtime from '../src/terminals/runtime.js';

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(test, label) {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await pause();
  }
  return test();
}

async function assertTransparentMark(selector) {
  const mark = await until(() => {
    const image = document.querySelector(selector);
    return image?.complete && image.naturalWidth ? image : null;
  }, 'Cialai mark');
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  context.drawImage(mark, 0, 0, 1, 1, 0, 0, 1, 1);
  assert(context.getImageData(0, 0, 1, 1).data[3] === 0, 'Cialai mark must keep its transparent margin');
}

// Teclado virtual no xterm real: keydown 229, valor novo com input e keyup,
// como o Chromium do Android entrega cada operacao do IME, com o input
// composed como o do navegador. Teclas em lote, antes do timer de 0 ms do
// xterm, nao podem repetir nem perder texto.
async function assertImeTyping(term) {
  const textarea = term.textarea;
  const sent = [];
  const listener = term.onData((data) => sent.push(data));
  const fire = (type, init) => textarea.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  const ime = (edit) => {
    fire('keydown', { key: 'Unidentified', keyCode: 229 });
    edit();
    fire('keyup', { key: 'Unidentified', keyCode: 229 });
  };
  const commit = (text) => ime(() => {
    textarea.value += text;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  });
  const compose = (text) => ime(() => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
    textarea.value += text;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertCompositionText', data: text }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
  });
  const settle = () => pause(30);
  try {
    textarea.value = '';
    commit('e'); await settle();
    commit('c'); await settle();
    for (const character of 'o020') commit(character);
    await settle();
    assert(JSON.stringify(sent) === JSON.stringify(['e', 'c', 'o020']), `Fast IME typing repeated text: ${JSON.stringify(sent)}`);

    sent.length = 0;
    commit('l'); commit('s');
    fire('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
    await settle();
    assert(JSON.stringify(sent) === JSON.stringify(['ls', '\r']), `Enter after fast IME typing reordered text: ${JSON.stringify(sent)}`);

    sent.length = 0;
    textarea.value = '';
    commit('2'); compose('á');
    await settle();
    assert(sent.join('') === '2á', `IME composition after a digit lost or repeated text: ${JSON.stringify(sent)}`);
  } finally {
    listener.dispose();
    textarea.value = '';
  }
}

document.title = 'CHECK: Cialai studio';
await until(() => runtime.isDemo(), 'terminal demo mode');
assert(runtime.isDemo(), 'Browser check must run only in terminal demo mode');

const dark = document.documentElement.dataset.theme === 'dark';
const rootStyle = getComputedStyle(document.documentElement);
assert(rootStyle.getPropertyValue('--mac-accent').trim().toLowerCase() === (dark ? '#ff7ab2' : '#e23b84'), 'Cialai accent missing');

if (document.documentElement.dataset.formFactor === 'phone') {
  await until(() => document.querySelector('.phone-terminal__sessions .terminais-card'), 'phone session list');
  assert(!document.querySelector('.phone-terminal__host'), 'Phone list must not mount a terminal renderer');
  assert(!document.querySelector('.ios-tabbar'), 'Cialai phone entry must expose only Terminais');
  document.querySelector('.phone-terminal__sessions .terminais-card').click();
  await until(() => document.querySelector('.phone-terminal__host .xterm'), 'phone terminal');
  assert(document.querySelectorAll('.phone-terminal__host').length === 1, 'Phone must mount one terminal pane');
  assert(document.documentElement.scrollWidth === window.innerWidth, 'Phone page must not overflow horizontally');
  await assertImeTyping(runtime.getState().selected.term);
  document.title = 'PASS: Cialai phone terminal list, single pane, responsive viewport and fast IME typing';
} else {
  await until(() => document.querySelector('.terminais-terminal__host .xterm'), 'desktop terminal');
  assert(document.querySelector('.mac-sidebar__brand-name')?.textContent === 'Cialai', 'Cialai brand missing');
  await assertTransparentMark('.mac-sidebar__logo');
  const sidebarGradient = getComputedStyle(document.querySelector('.mac-sidebar')).backgroundImage;
  assert(sidebarGradient.includes(dark ? '58, 27, 51' : '255, 214, 230'), 'Cialai sidebar gradient missing');
  assert(!/10, 42, 94|21, 63, 128|31, 87, 171/.test(sidebarGradient), 'Ordinum blue gradient remains visible');
  assert(document.querySelectorAll('.mac-nav-item').length === 2, 'Desktop navigation must expose Terminais and Dispositivos');
  assert(!/Ordinum Control|Stack local|Reuniões/.test(document.body.textContent), 'Removed Control UI is visible');
  assert(runtime.orderedSessions().length >= 2, 'Terminal demo sessions missing');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  await until(() => document.querySelector('.mac-palette'), 'command palette');
  const paletteText = document.querySelector('.mac-palette').textContent;
  assert(/Novo terminal/.test(paletteText), 'Terminal command missing');
  assert(!/Stack|Reunião|VPN/.test(paletteText), 'Removed commands remain in palette');
  document.querySelector('.mac-palette input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !document.querySelector('.mac-palette'), 'palette close');

  const before = runtime.getTabs(runtime.getState().selectedId).length;
  runtime.requestNewFile();
  await until(() => runtime.getTabs(runtime.getState().selectedId).length > before, 'temporary file');
  await until(() => document.querySelector('.terminais-tab.is-active')?.textContent.includes('Sem título'), 'temporary file tab');
  assert(document.querySelector('.terminais-tab.is-active')?.textContent.includes('Sem título'), 'Temporary file tab missing');

  document.querySelector('[title="Mostrar ou ocultar barra lateral"]').click();
  await until(() => document.querySelector('.mac-window').classList.contains('mac-window--sidebar-hidden'), 'sidebar hide');
  document.querySelector('[title="Mostrar ou ocultar barra lateral"]').click();
  await until(() => !document.querySelector('.mac-window').classList.contains('mac-window--sidebar-hidden'), 'sidebar restore');
  document.title = 'PASS: Cialai desktop shell, terminal demo, palette, temporary file and sidebar';
}
