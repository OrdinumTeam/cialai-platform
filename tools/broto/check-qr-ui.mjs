// SPDX-License-Identifier: Apache-2.0
// Janela do Broto, Ligar pelo celular: a tela real em React, num Chromium, com
// um serviço falso no lugar do Tauri. Cobre o QR, os números, a espera, as
// falhas e a volta ao monitor, nos três idiomas e na janela mais estreita.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import QRCode from 'qrcode';
import { createI18n } from '@cialai/i18n';
import { chromium } from '../browser/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const QR_METHODS = ['broto.qr.begin', 'broto.qr.confirm', 'broto.qr.cancel'];

// O Tauri só carrega `broto_control` com os métodos da lista, e os parâmetros
// seguem até o serviço nos dois caminhos, socket e pipe do Windows.
const rust = readFileSync(join(root, 'apps/broto/src-tauri/src/main.rs'), 'utf8');
const allowlist = rust.split('fn validate_method')[1].split('\n}\n')[0];
const allowed = [...allowlist.matchAll(/"(broto\.[a-z.]+)"/g)].map((match) => match[1]);
for (const method of QR_METHODS) assert.ok(allowed.includes(method), `janela do Broto não libera ${method}`);
assert.match(rust, /spawn_blocking\(move \|\| control\(&method, params\)\)/, 'o socket recebe os parâmetros da página');
assert.match(rust, /windows_control::control\(&method, params\)/, 'o pipe do Windows recebe os parâmetros da página');
assert.match(rust, /exchange\(stream, method, params\)/, 'o pedido ao serviço leva os parâmetros');

// O serviço falso guarda o estado que `broto.status` devolve. O teste muda o
// estado por fora, como o serviço faria, e a janela vê na consulta seguinte.
const service = `
const clone = (value) => JSON.parse(JSON.stringify(value));
const fake = window.brotoFake = { status: { state: 'disconnected', activity: [] }, calls: [], fail: new Set(), delay: 0, issued: 0 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const invoke = async (command, args = {}) => {
  fake.calls.push({ command, args: clone(args) });
  if (command !== 'broto_control') throw 'unsupported_command';
  const { method, params } = args;
  if (method !== 'broto.status' && fake.delay) await wait(fake.delay);
  if (fake.fail.has(method)) throw 'service_request_failed';
  if (method === 'broto.status') return clone(fake.status);
  if (method === 'broto.qr.begin') {
    const payload = window.brotoPayloads[fake.issued++ % window.brotoPayloads.length];
    const expiresAt = new Date(Date.now() + 600000).toISOString();
    fake.status.qr = { payload, expiresAt, stage: 'showing', attemptsLeft: 3 };
    return { payload, expiresAt };
  }
  if (method === 'broto.qr.cancel') { delete fake.status.qr; return {}; }
  if (method === 'broto.qr.confirm') {
    const qr = fake.status.qr;
    if (params.digits === '4821') { qr.stage = 'approving'; return { ok: true }; }
    qr.attemptsLeft -= 1;
    if (qr.attemptsLeft === 0) Object.assign(qr, { stage: 'failed', reason: 'digits' });
    return { ok: false, attemptsLeft: qr.attemptsLeft };
  }
  if (method === 'broto.disconnect') { fake.status = { state: 'disconnected', activity: [] }; return {}; }
  throw 'service_request_failed';
};`;

const bundle = await build({
  entryPoints: [join(root, 'packages/ui/src/broto/main.jsx')],
  bundle: true,
  write: false,
  outdir: join(tmpdir(), 'broto-qr-ui'),
  format: 'iife',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl' },
  plugins: [{
    name: 'broto-service-fixture',
    setup(api) {
      api.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'fixture' }));
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: service, loader: 'js' }));
    },
  }],
});
const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
const style = bundle.outputFiles.find((file) => file.path.endsWith('.css')).text;

// Um texto do tamanho real: chave, segredo, prazo, nome e sistema em base64url.
const payloads = [0, 1, 2, 3].map(() => `CIALAIQ1.${randomBytes(150).toString('base64url')}`);

const systemBrowsers = process.platform === 'darwin' ? ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : process.platform === 'linux' ? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'] : [];
const executablePath = process.env.BROTO_UI_BROWSER || (existsSync(chromium.executablePath()) ? undefined : systemBrowsers.find(existsSync));
const browser = await chromium.launch({ headless: true, executablePath });
const WINDOW = { width: 620, height: 640 };
const NARROW = { width: 360, height: 640 };

async function qrBits(page) {
  return page.evaluate(({ size, margin }) => {
    const canvas = document.querySelector('.broto-qr canvas');
    const scale = canvas.width / (size + margin * 2);
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let bits = '';
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const x = Math.floor((col + margin + 0.5) * scale);
        const y = Math.floor((row + margin + 0.5) * scale);
        bits += data[(y * canvas.width + x) * 4] < 128 ? '1' : '0';
      }
    }
    return { bits, width: canvas.width, height: canvas.height };
  }, { size: (await expectedQr(page)).size, margin: 2 });
}

async function expectedQr(page) {
  const payload = await page.evaluate(() => window.brotoFake.status.qr.payload);
  return QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules;
}

try {
  for (const [locale, scheme] of [['pt-BR', 'light'], ['en', 'dark'], ['es', 'light']]) {
    const t = createI18n(locale).t;
    const page = await browser.newPage({ locale, viewport: WINDOW, colorScheme: scheme });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
    await page.evaluate(({ locale: shellLocale, list }) => { window.__CIALAI_SHELL__ = { locale: shellLocale }; window.brotoPayloads = list; }, { locale, list: payloads });
    await page.addStyleTag({ content: style });
    await page.addScriptTag({ content: script });
    const screenshots = [];
    const shot = async (name) => {
      const path = join(tmpdir(), `broto-qr-ui-${locale}-${name}.png`);
      await page.screenshot({ path, fullPage: true });
      screenshots.push(path);
    };
    const methods = async () => page.evaluate(() => window.brotoFake.calls.filter((call) => call.command === 'broto_control' && call.args.method !== 'broto.status').map((call) => call.args));
    const lastMethod = async () => (await methods()).at(-1);
    const setQr = (patch) => page.evaluate((next) => { Object.assign(window.brotoFake.status.qr, next); }, patch);
    const stage = (name) => page.locator(`[data-broto-qr-stage="${name}"]`);
    const text = async (selector) => (await page.locator(selector).first().textContent()).trim();
    // A janela pode encolher até 360 px: nada pode vazar para o lado.
    // A varredura da barra de progresso anda dentro de uma caixa que corta.
    const fits = async (name, { capture = false } = {}) => {
      await page.setViewportSize(NARROW);
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, right: Math.max(...[...document.querySelectorAll('.broto *:not(.broto-progress *)')].map((el) => el.getBoundingClientRect().right)) }));
      assert.ok(geometry.scroll <= geometry.width, `${name}: rolagem lateral em 360 px ${JSON.stringify(geometry)}`);
      assert.ok(geometry.right <= geometry.width, `${name}: elemento passa da borda em 360 px ${JSON.stringify(geometry)}`);
      if (capture) await shot(`${name}-narrow`);
      await page.setViewportSize(WINDOW);
    };

    // Conectar: o QR é a ação principal e o código colado continua ali.
    await page.locator('[data-broto-action="qr"]').waitFor();
    assert.equal(await text('[data-broto-action="qr"]'), t('broto.qr.show'));
    assert.ok(await page.locator('[data-broto-action="qr"]').evaluate((el) => el.classList.contains('broto-btn--primary')), 'mostrar QR é a ação principal');
    assert.equal(await text('.broto-choice h2'), t('broto.qr.choose'));
    assert.equal(await page.locator('#pairing').count(), 1, 'o campo do código continua para o selftest e para quem já tem um');
    assert.equal(await page.locator('[data-broto-action="connect"]').count(), 1);
    assert.equal(await text('.broto-or'), t('broto.connect.or'));
    await shot('connect');
    await fits('connect');

    // Falha ao pedir o QR: aviso na própria tela, sem sair dela.
    await page.evaluate(() => window.brotoFake.fail.add('broto.qr.begin'));
    await page.locator('[data-broto-action="qr"]').click();
    await page.getByText(t('broto.qr.beginFailed'), { exact: true }).waitFor();
    assert.equal(await page.locator('#pairing').count(), 1);
    await page.evaluate(() => window.brotoFake.fail.delete('broto.qr.begin'));

    // Enquanto o QR é pedido, só o botão dele gira.
    await page.evaluate(() => { window.brotoFake.delay = 400; });
    await page.locator('[data-broto-action="qr"]').click();
    await page.locator('[data-broto-action="qr"].is-busy .broto-spinner').waitFor();
    assert.equal(await page.locator('[data-broto-action="connect"].is-busy').count(), 0, 'o botão do código não gira com o QR');
    await stage('showing').waitFor();
    await page.evaluate(() => { window.brotoFake.delay = 0; });
    assert.deepEqual(await lastMethod(), { method: 'broto.qr.begin', params: {} });

    // QR: o desenho é o do texto do serviço, com correção M, 280 px e margem 2.
    assert.equal(await text('.broto-screen--qr h1'), t('broto.qr.title'));
    assert.equal(await text('.broto-screen--qr .broto-lead'), t('broto.qr.instruction'));
    const drawn = await qrBits(page);
    assert.equal(drawn.width, 280);
    assert.equal(drawn.height, 280);
    assert.equal(drawn.bits, Array.from((await expectedQr(page)).data, (dark) => (dark ? '1' : '0')).join(''), 'o canvas mostra o QR do texto do serviço');
    assert.equal(await page.locator('.broto-qr canvas').getAttribute('aria-label'), t('broto.qr.label'));
    assert.equal(await page.locator('.broto-qr').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'o QR fica em fundo branco também no tema escuro');
    assert.match(await text('[role="timer"] strong'), /^(10:00|09:5\d)$/);
    assert.equal(await text('[role="timer"] span'), t('broto.qr.remaining'));
    assert.equal(await text('.broto-qr__status'), t('broto.qr.searching'));
    await shot('qr');
    await fits('qr', { capture: true });

    // O prazo chega a 00:00 e o QR apaga, sem número negativo.
    await setQr({ expiresAt: new Date(Date.now() + 1200).toISOString() });
    await page.locator('.broto-qr.is-expired').waitFor();
    assert.equal(await text('[role="timer"] strong'), '00:00');

    // Cancelar devolve à tela de conectar.
    await page.locator('[data-broto-action="qr-cancel"]').click();
    await page.locator('#pairing').waitFor();
    assert.deepEqual(await lastMethod(), { method: 'broto.qr.cancel', params: {} });

    // Números: campo numérico de quatro dígitos, já focado, e Enter confirma.
    await page.locator('[data-broto-action="qr"]').click();
    await stage('showing').waitFor();
    await setQr({ stage: 'digits' });
    await stage('digits').waitFor();
    const field = page.locator('#qr-digits');
    assert.deepEqual(await field.evaluate((el) => ({ focused: document.activeElement === el, inputMode: el.inputMode, maxLength: el.maxLength, pattern: el.pattern })), { focused: true, inputMode: 'numeric', maxLength: 4, pattern: '[0-9]*' });
    assert.equal(await text('#qr-digits-note'), t('broto.qr.digits.rule'));
    assert.ok(await page.locator('[data-broto-action="qr-confirm"]').isDisabled(), 'confirmar espera os quatro números');
    await fits('digits', { capture: true });
    await page.keyboard.type('12a34');
    assert.equal(await field.inputValue(), '1234', 'só números entram');
    await page.keyboard.press('Enter');
    await page.getByText(t('broto.qr.digits.missMany', { count: 2 }), { exact: true }).waitFor();
    assert.deepEqual(await lastMethod(), { method: 'broto.qr.confirm', params: { digits: '1234' } });
    assert.equal(await field.inputValue(), '');
    assert.ok(await field.evaluate((el) => document.activeElement === el && el.classList.contains('is-error')), 'depois do erro o campo volta limpo e focado');
    await shot('digits-miss');
    await field.fill('9999');
    await page.keyboard.press('Enter');
    await page.getByText(t('broto.qr.digits.missOne'), { exact: true }).waitFor();
    await field.fill('4821');
    await page.keyboard.press('Enter');

    // Números certos: falta o celular confirmar.
    await stage('approving').waitFor();
    assert.equal(await text('[data-broto-qr-stage="approving"] h1'), t('broto.qr.approving.title'));
    assert.equal(await text('[data-broto-qr-stage="approving"] .broto-lead'), t('broto.qr.approving.lead'));
    assert.equal(await page.locator('[data-broto-qr-stage="approving"] [data-broto-action="qr-cancel"]').count(), 1);
    await shot('approving');
    await fits('approving');

    // Concluído: o serviço tira o `qr` e a janela volta ao monitor.
    await page.evaluate(() => { const fake = window.brotoFake; delete fake.status.qr; Object.assign(fake.status, { state: 'connected', host: 'Mac de teste', transport: 'direct' }); });
    await page.locator('.broto-monitor').waitFor();
    assert.equal(await text('.broto-monitor h1'), t('broto.connected', { host: 'Mac de teste' }));

    // Três erros encerram o QR com o motivo dos números.
    await page.locator('[data-broto-action="disconnect"]').click();
    await page.locator('[data-broto-action="qr"]').click();
    await stage('showing').waitFor();
    await setQr({ stage: 'digits' });
    await stage('digits').waitFor();
    // Cada envio espera a resposta do anterior: durante o pedido o Enter não vale.
    for (const [digits, note] of [['1111', t('broto.qr.digits.missMany', { count: 2 })], ['2222', t('broto.qr.digits.missOne')]]) {
      await field.fill(digits);
      await page.keyboard.press('Enter');
      await page.locator('#qr-digits-note', { hasText: note }).waitFor();
    }
    await field.fill('3333');
    await page.keyboard.press('Enter');
    await stage('failed').waitFor();
    assert.equal(await text('[data-broto-qr-stage="failed"] h1'), t('broto.qr.failed.title'));
    assert.equal(await text('[data-broto-qr-stage="failed"] .broto-lead'), t('broto.qr.failed.digits'));
    await shot('failed');
    await fits('failed');

    // Cada motivo tem o próprio texto; um motivo novo cai no texto geral.
    for (const [reason, key] of [['expired', 'broto.qr.failed.expired'], ['denied', 'broto.qr.failed.denied'], ['refused', 'broto.qr.failed.refused'], ['later', 'broto.qr.failed.other']]) {
      await setQr({ reason });
      await page.locator('[data-broto-qr-stage="failed"] .broto-lead', { hasText: t(key) }).waitFor();
      assert.equal(await text('[data-broto-qr-stage="failed"] .broto-lead'), t(key));
    }

    // QR novo começa outro pedido; Voltar desiste e mostra a tela de conectar.
    const issued = await page.evaluate(() => window.brotoFake.issued);
    await page.locator('[data-broto-action="qr-new"]').click();
    await stage('showing').waitFor();
    assert.deepEqual(await lastMethod(), { method: 'broto.qr.begin', params: {} });
    assert.equal(await page.evaluate(() => window.brotoFake.issued), issued + 1);
    assert.equal(await page.locator('[data-broto-action="qr-new"]').count(), 0);
    await setQr({ stage: 'failed', reason: 'denied' });
    await stage('failed').waitFor();
    await page.locator('[data-broto-action="qr-back"]').click();
    await page.locator('#pairing').waitFor();
    assert.deepEqual(await lastMethod(), { method: 'broto.qr.cancel', params: {} });

    // Todo método que a tela usou passa pela lista do Tauri.
    const used = [...new Set((await methods()).map((call) => call.method))];
    for (const method of used) assert.ok(allowed.includes(method), `a janela chama ${method}, que o Tauri recusa`);
    for (const method of QR_METHODS) assert.ok(used.includes(method), `o teste não exercitou ${method}`);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, locale, scheme, checks: ['allowlist and params', 'connect keeps the code path', 'begin failure', 'busy only on the QR button', 'QR matches the payload', 'countdown to 00:00', 'cancel', 'digits field', 'misses with attempts left', 'approving', 'done returns to the monitor', 'three misses', 'reason texts', 'new QR and back', 'narrow window'], screenshots }));
    await page.close();
  }
} finally {
  await browser.close();
}
