// SPDX-License-Identifier: Apache-2.0
// Visible browser contract for the desktop network screens.
// Roda sobre `?tunnel=demo`, que simula o sidecar v2: `net.start` na abertura,
// bootstrap do Tor até publicar o onion, sessões por transporte e pareamento.

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(test, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await pause();
  }
  return test();
}
const text = (selector) => document.querySelector(selector)?.textContent || '';
const assertCopy = (where) => assert(!/[()–—]| - /.test(document.body.innerText), `Visible copy uses a forbidden separator in ${where}`);
const button = (label, root = document) => [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const approval = new URLSearchParams(window.location.search).get('approval') === '1';

document.title = 'CHECK: Cialai network';
await until(() => document.querySelectorAll('.mac-nav-item').length === 2, 'desktop navigation');
assert(document.querySelector('.mac-sidebar__pair'), 'Pairing action missing from sidebar');
assert(document.querySelector('.mac-tunnel-status'), 'Toolbar network status missing');

// O QR aparece assim que a conexão direta existe, com a reserva ainda preparando.
window.dispatchEvent(new CustomEvent('cialai:pair-device'));
const canvas = await until(() => {
  const candidate = document.querySelector('.mac-pair__qr canvas');
  return candidate?.width >= 280 ? candidate : null;
}, 'pairing QR');
assert(canvas.width >= 280 && canvas.height >= 280, 'Pairing QR is too small');
assert(text('.mac-pair__timers').includes('1:30') || text('.mac-pair__timers').includes('1:29'), 'Ninety second rotation is not visible');
await until(() => /Conexão de reserva\s*preparando \d+%/.test(text('.mac-pair__reserve')), 'reserve preparing line in the pairing dialog', 4000);
assert(document.querySelector('.mac-pair__reserve [role="progressbar"]'), 'Reserve progress bar missing');
assert(text('.mac-pair__notice').includes('De outra rede'), 'Pairing dialog must explain that another network waits for the reserve');
assertCopy('pairing while the reserve prepares');
await until(() => /Conexão de reserva\s*pronta/.test(text('.mac-pair__reserve')), 'reserve ready line in the pairing dialog');
assert(!document.querySelector('.mac-pair__notice'), 'The reserve notice must leave once the reserve is ready');

// Ponto de estado: pronto para parear, reserva preparando e acessível, nessa ordem.
await until(() => (window.__cialaiTunnelStates || []).includes('accessible'), 'accessible state');
const states = window.__cialaiTunnelStates;
assert(states.indexOf('pairable') >= 0 && states.indexOf('pairable') < states.indexOf('reserve') && states.indexOf('reserve') < states.indexOf('accessible'), `Unexpected state order: ${states.join(', ')}`);
assert(!states.includes('problem'), `Demo network reported a problem: ${states.join(', ')}`);
assert(text('.mac-tunnel-status').includes('Acessível'), 'Toolbar must show Acessível');
assert(text('.mac-sidebar__pair').includes('Acessível'), 'Sidebar must show Acessível');

// Um celular lê o código: aprovação opcional e conclusão com sessão direta.
if (approval) {
  await until(() => text('.mac-pair__approval output') === '4827', 'pair approval');
  button('Autorizar', document.querySelector('.mac-pair__approval')).click();
} else {
  window.dispatchEvent(new CustomEvent('cialai:demo-phone-scan'));
}
await until(() => text('.mac-pair__success').includes('Vinculado'), 'pairing success');
assertCopy('pairing success');
button('Abrir Dispositivos').click();

// Dispositivos: painel sem campos, badges de transporte e seção avançada.
await until(() => document.querySelectorAll('.mac-device-row').length === 4, 'device list with the new phone');
const panel = document.querySelector('.mac-access');
assert(panel, 'Access panel missing');
assert(!panel.querySelector('input, select, textarea'), 'The access panel must not have fields');
assert(panel.textContent.includes('Conexão direta') && panel.textContent.includes('Conexão de reserva') && panel.textContent.includes('Celulares conectados'), 'Access panel rows missing');
await until(() => text('.mac-access__count') === '3', 'three connected phones');
await until(() => document.querySelectorAll('.mac-transport.is-direct').length === 2, 'direct badges');
assert([...document.querySelectorAll('.mac-transport.is-direct')].every((badge) => badge.textContent === 'Direta'), 'Direct badge copy');
assert(document.querySelectorAll('.mac-transport.is-tor').length === 1 && text('.mac-transport.is-tor') === 'Reserva', 'Reserve badge missing');
assert([...document.querySelectorAll('.mac-device-row')].some((row) => row.textContent.includes('iPhone de Bruno') && row.querySelector('.mac-transport.is-direct')), 'New phone must show the direct badge');
assert(!document.querySelector('.mac-devices input, .mac-devices select, .mac-devices textarea'), 'Devices must not show server, address, port or key fields');
assertCopy('devices');

button('Diagnóstico avançado', panel).click();
await until(() => document.querySelector('.mac-advanced[open] .mac-advanced__body'), 'advanced diagnostics');
const advanced = text('.mac-advanced__body');
for (const expected of ['192.168.1.24:4740', 'NAT-PMP', '.onion', 'Publicado', 'Rede Tor', 'STUN opcional', 'DNS-SD local']) {
  assert(advanced.includes(expected), `Advanced diagnostics misses ${expected}`);
}
button('Executar diagnóstico', document.querySelector('.mac-advanced__checks')).click();
await until(() => document.querySelectorAll('.mac-advanced__check-list li').length === 11, 'diagnostics.run checks');
assert(text('.mac-advanced__verdict').includes('Tudo certo'), 'Diagnostics verdict missing');
assertCopy('advanced diagnostics');

const theme = document.documentElement.dataset.theme;
assert(theme === 'light' || theme === 'dark', 'Resolved theme missing');
document.title = `PASS: Cialai v2 network flow, reserve-aware QR, transport badges and advanced diagnostics in ${theme} theme`;
