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

// A assinatura oficial na barra lateral: a peca do tema atual visivel, com o
// nome no alt, no tamanho minimo da marca, e a outra escondida. O simbolo
// vazado antigo e o nome em fonte do sistema nao podem voltar.
// Com a lateral fechada, o lettering da assinatura, sem a cabeca, passa para
// a toolbar, pequeno e apagado, e volta a sair dela quando a lateral reabre.
async function assertToolbarLockup(dark) {
  const toggle = document.querySelector('.mac-toolbar__leading .mac-tool');
  assert(toggle, 'Sidebar toggle missing');
  assert(!document.querySelector('.mac-toolbar__brand'), 'Toolbar wordmark must wait for the sidebar to close');
  toggle.click();
  const visible = await until(() => {
    const image = document.querySelector(`.mac-toolbar__wordmark--${dark ? 'dark' : 'light'}`);
    return image?.complete && image.naturalWidth && image.getBoundingClientRect().width ? image : null;
  }, 'toolbar wordmark');
  assert(visible.alt === 'Cialai', 'Toolbar wordmark must name the brand');
  assert(/cialai-wordmark(-dark)?\.png|data:image\/png/.test(visible.src), 'Toolbar must use the official lettering without the head');
  const box = visible.getBoundingClientRect();
  assert(box.height <= 18 && box.width >= 40, 'Toolbar wordmark must stay small and legible');
  assert(Number(getComputedStyle(visible).opacity) < 1, 'Toolbar wordmark must be faded');
  assert(!document.querySelector(`.mac-toolbar__wordmark--${dark ? 'light' : 'dark'}`), 'Only the toolbar wordmark of the current theme may load');
  toggle.click();
  await until(() => !document.querySelector('.mac-toolbar__brand'), 'toolbar wordmark leaves with the sidebar back');
}

async function assertBrandLockup(dark) {
  const visible = await until(() => {
    const image = document.querySelector(`.mac-sidebar__lockup--${dark ? 'dark' : 'light'}`);
    return image?.complete && image.naturalWidth ? image : null;
  }, 'Cialai lockup');
  assert(visible.alt === 'Cialai', 'Cialai lockup must name the brand');
  assert(/cialai-lockup(-dark)?\.png|data:image\/png/.test(visible.src), 'Cialai lockup must use the official asset');
  assert(visible.getBoundingClientRect().width >= 120, 'Cialai lockup below the brand minimum width');
  assert(!document.querySelector(`.mac-sidebar__lockup--${dark ? 'light' : 'dark'}`), 'Only the lockup of the current theme may load: a hidden image is still downloaded');
  assert(!document.querySelector('.mac-sidebar__logo, .mac-sidebar__brand-name'), 'Old hollow mark or typed brand name is back');
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

// O terminal se integra ao tema: o viewport do xterm, visivel no respiro e
// abaixo da ultima linha, e a caixa de composicao do IME usam o fundo que o
// tema pinta nas linhas, e nao o preto do CSS da biblioteca.
function assertTerminalSurface(host) {
  const color = (selector) => getComputedStyle(host.querySelector(selector)).backgroundColor;
  const surface = color('.xterm-scrollable-element');
  assert(!['rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)'].includes(surface), `Terminal theme background missing, got ${surface}`);
  assert(color('.xterm-viewport') === surface, `Terminal viewport must use the theme background ${surface}, got ${color('.xterm-viewport')}`);
  assert(color('.composition-view') === surface, `IME composition box must use the theme background ${surface}, got ${color('.composition-view')}`);
}

// Cmd F no terminal abre a busca na saida, que precisa marcar os resultados
// sem erro no parser de cores do xterm.
async function assertTerminalFind(session) {
  const errors = [];
  const onError = (event) => errors.push(event.message || String(event.error));
  let results = 0;
  const listener = session.search.onDidChangeResults((event) => { results = event.resultCount; });
  window.addEventListener('error', onError);
  try {
    session.term.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true }));
    const input = await until(() => document.querySelector('.terminais-find input'), 'terminal find bar');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'claude');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => results > 0, 'terminal find results');
    await pause(250);
    assert(errors.length === 0, `Terminal find failed: ${errors[0]}`);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !document.querySelector('.terminais-find'), 'terminal find close');
  } finally {
    listener.dispose();
    window.removeEventListener('error', onError);
  }
}

document.title = 'CHECK: Cialai studio';
await until(() => runtime.isDemo(), 'terminal demo mode');
assert(runtime.isDemo(), 'Browser check must run only in terminal demo mode');

const dark = document.documentElement.dataset.theme === 'dark';
const rootStyle = getComputedStyle(document.documentElement);
assert(rootStyle.getPropertyValue('--mac-accent').trim().toLowerCase() === (dark ? '#ff7ab2' : '#e23b84'), 'Cialai accent missing');

if (document.documentElement.dataset.formFactor === 'phone') {
  // Só cards de sessão: o esqueleto da lista também usa .phone-session, sem data-session-id.
  await until(() => document.querySelector('.phone-terminal__sessions .phone-session[data-session-id]'), 'phone session list');
  assert(!document.querySelector('.phone-terminal__host'), 'Phone list must not mount a terminal renderer');
  assert(!document.querySelector('.ios-tabbar'), 'Cialai phone entry must expose only Terminais');
  document.querySelector('.phone-terminal__sessions .phone-session[data-session-id]').click();
  await until(() => document.querySelector('.phone-terminal__host .xterm'), 'phone terminal');
  assertTerminalSurface(document.querySelector('.phone-terminal__host'));
  assert(document.querySelectorAll('.phone-terminal__host').length === 1, 'Phone must mount one terminal pane');
  assert(document.documentElement.scrollWidth === window.innerWidth, 'Phone page must not overflow horizontally');
  await assertImeTyping(runtime.getState().selected.term);
  document.title = 'PASS: Cialai phone terminal list, single pane, themed terminal surface, responsive viewport and fast IME typing';
} else {
  await until(() => document.querySelector('.terminais-terminal__host .xterm'), 'desktop terminal');
  assertTerminalSurface(document.querySelector('.terminais-terminal__host'));
  await assertBrandLockup(dark);
  // Barra lateral rosa e solida, sem gradiente: rosa clarinho no claro e o
  // ameixa da marca no escuro.
  const sidebarStyle = getComputedStyle(document.querySelector('.mac-sidebar'));
  assert(sidebarStyle.backgroundImage === 'none', 'Desktop sidebar must be solid');
  assert(sidebarStyle.backgroundColor === (dark ? 'rgb(49, 24, 44)' : 'rgb(252, 235, 243)'), 'Desktop sidebar pink tone missing');
  await assertToolbarLockup(dark);
  assert(document.querySelectorAll('.mac-nav-item').length === 2, 'Desktop navigation must expose Terminais and Dispositivos');
  assert(!/Ordinum Control|Stack local|Reuniões/.test(document.body.textContent), 'Removed Control UI is visible');
  assert(runtime.orderedSessions().length >= 2, 'Terminal demo sessions missing');
  assert(!document.querySelector('.terminais-work__actions [aria-label="Buscar na saída"], .terminais-work__actions [aria-label="Copiar seleção"]'), 'Session header must not show find or copy buttons');
  await assertTerminalFind(runtime.getState().selected);

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
  document.title = 'PASS: Cialai desktop shell, terminal demo, themed terminal surface, output find, palette, temporary file and sidebar';
}
