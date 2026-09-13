// SPDX-License-Identifier: Apache-2.0
// Visible browser contract for the desktop network screens.

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

document.title = 'CHECK: Cialai network';
await until(() => document.querySelectorAll('.mac-nav-item').length === 2, 'desktop navigation');
assert(document.querySelector('.mac-sidebar__pair'), 'Pairing action missing from sidebar');
assert(document.querySelector('.mac-tunnel-status.is-ok'), 'Toolbar network status missing');

const devicesButton = [...document.querySelectorAll('.mac-nav-item')].find((button) => button.textContent.includes('Dispositivos'));
assert(devicesButton, 'Devices route missing');
devicesButton.click();
await until(() => document.querySelectorAll('.mac-device-row').length === 2, 'device list');
assert(document.querySelector('.mac-machine')?.textContent.includes('100.64.0.8'), 'Tailnet address missing');
assert(document.querySelector('.mac-machine')?.textContent.includes('Válida até'), 'API key validity missing');
assert(document.querySelector('.mac-network-badge.is-ok'), 'Device screen network state missing');

document.querySelector('.mac-sidebar__pair').click();
const canvas = await until(() => {
  const candidate = document.querySelector('.mac-pair__qr canvas');
  return candidate?.width >= 280 ? candidate : null;
}, 'pairing QR');
assert(canvas.width >= 280 && canvas.height >= 280, 'Pairing QR is too small');
assert(document.querySelector('.mac-pair__timers')?.textContent.includes('1:30'), 'Ninety second rotation is not visible');
assert(!/[()–—]| - /.test(document.body.innerText), 'Visible copy uses a forbidden separator');

if (new URLSearchParams(window.location.search).get('approval') === '1') {
  await until(() => document.querySelector('.mac-pair__approval output')?.textContent === '4827', 'pair approval');
}

const theme = document.documentElement.dataset.theme;
assert(theme === 'light' || theme === 'dark', 'Resolved theme missing');
document.title = `PASS: Cialai network screens and rotating QR in ${theme} theme`;
