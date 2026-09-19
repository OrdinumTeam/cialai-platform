// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import './desktop.css';
import DesktopApp from './DesktopApp.jsx';
import { initPlatform } from '../lib/platform.js';

// A plataforma vem de um comando do Rust. `initPlatform` trata erro, mas não
// trata promessa que nunca resolve, e um `await` no topo do módulo trava a
// montagem do React para sempre: a janela fica com `#root` vazio e, sem a
// região de arraste que o React desenha, não dá nem para movê-la. A disputa
// abaixo monta a interface de qualquer jeito; a reserva por `navigator` já
// cobre o que a tela precisa até o valor real chegar.
const PLATFORM_DEADLINE_MS = 1500;
await Promise.race([
  initPlatform(),
  new Promise((resolve) => { setTimeout(resolve, PLATFORM_DEADLINE_MS); }),
]);
if (new URLSearchParams(window.location.search).get('motion') === '0') document.documentElement.dataset.motion = 'none';
// A janela separada da previa carrega a mesma pagina com `?docpreview=1`: so
// o documento renderizado, sem estudio nem rede por tras.
if (new URLSearchParams(window.location.search).get('docpreview') === '1') {
  const { default: DocPreviewWindow } = await import('./DocPreviewWindow.jsx');
  createRoot(document.getElementById('root')).render(<DocPreviewWindow />);
} else {
  createRoot(document.getElementById('root')).render(<DesktopApp />);
}

if (new URLSearchParams(window.location.search).get('cialai_selftest')) {
  import('../../../../tools/selftest/selftest-app.js').catch((error) => console.error('[autoteste]', error));
}
if (new URLSearchParams(window.location.search).get('network-check') === '1') {
  import('../../scripts/check-network-browser.js').catch((error) => { document.title = `FAIL: ${error.message}`; console.error('[network-check]', error); });
}
