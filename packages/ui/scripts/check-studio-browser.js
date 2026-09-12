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

document.title = 'CHECK: Cialai studio';
await until(() => runtime.isDemo(), 'terminal demo mode');
assert(runtime.isDemo(), 'Browser check must run only in terminal demo mode');

if (document.documentElement.dataset.formFactor === 'phone') {
  await until(() => document.querySelector('.phone-terminal__sessions .terminais-card'), 'phone session list');
  assert(!document.querySelector('.phone-terminal__host'), 'Phone list must not mount a terminal renderer');
  assert(!document.querySelector('.ios-tabbar'), 'Cialai phone entry must expose only Terminais');
  document.querySelector('.phone-terminal__sessions .terminais-card').click();
  await until(() => document.querySelector('.phone-terminal__host .xterm'), 'phone terminal');
  assert(document.querySelectorAll('.phone-terminal__host').length === 1, 'Phone must mount one terminal pane');
  assert(document.documentElement.scrollWidth === window.innerWidth, 'Phone page must not overflow horizontally');
  document.title = 'PASS: Cialai phone terminal list, single pane and responsive viewport';
} else {
  await until(() => document.querySelector('.terminais-terminal__host .xterm'), 'desktop terminal');
  assert(document.querySelector('.mac-sidebar__brand-name')?.textContent === 'Cialai', 'Cialai brand missing');
  assert(document.querySelectorAll('.mac-nav-item').length === 1, 'Registry must expose only Terminais');
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
