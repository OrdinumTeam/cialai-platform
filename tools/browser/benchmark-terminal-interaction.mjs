// SPDX-License-Identifier: Apache-2.0
// Chromium/xterm only: no real PTYs, personal profiles or distribution build.
// TaskDuration is renderer task time, not CPU/RSS of the complete Tauri app.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = `/@fs${root}packages/ui/src/terminals/runtime.js`;
const server = await createServer({ root: `${root}apps/desktop`, configFile: `${root}apps/desktop/vite.config.js`,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
const summary = (values) => {
  assert.ok(values.length, 'benchmark must collect real samples');
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    p50Ms: sorted[Math.floor(values.length * 0.5)], p95Ms: sorted[Math.min(values.length - 1, Math.floor(values.length * 0.95))] };
};
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CIALAI_TEST_CHROMIUM || undefined,
    headless: !process.env.CIALAI_TEST_HEADFUL,
    // Measure normal background scheduling, not Playwright's default bypasses.
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?terminais=demo&motion=0#terminais`);
  await page.waitForSelector('.xterm');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  const idle = async () => {
    const visibility = await page.evaluate(() => document.visibilityState);
    const start = await metrics();
    await page.waitForTimeout(1200);
    const end = await metrics();
    return { visibility, wallMs: (end.Timestamp - start.Timestamp) * 1000,
      taskMs: (end.TaskDuration - start.TaskDuration) * 1000, jsHeapBytes: end.JSHeapUsedSize };
  };
  const results = [];
  for (const count of [0, 1, 10, 30]) {
    await page.evaluate(async ({ runtime, count }) => {
      const api = await import(runtime);
      for (const session of api.orderedSessions()) assertClosed(await api.closeSession(session.id));
      function assertClosed(closed) { if (!closed) throw new Error('fixture did not close'); }
      for (let i = 0; i < count; i++) api.openSession('/fixture', { name: `latency-${i}`, select: i === 0 });
      if (api.orderedSessions().length !== count) throw new Error('incorrect fixture count');
    }, { runtime, count });
    await page.waitForTimeout(500);
    await cdp.send('HeapProfiler.collectGarbage');
    const foreground = await idle();
    const other = await page.context().newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    const background = await idle();
    background.hiddenVerified = background.visibility === 'hidden';
    await other.close();
    await page.bringToFront();
    let keyboard = null, render = null;
    if (count) {
      await page.evaluate(async (runtime) => {
        const session = (await import(runtime)).getState().selected;
        if (session.ptyId != null) throw new Error('benchmark must not use a native PTY');
        const terminal = session.term;
        const measurements = [];
        let keyAt = null;
        const keys = [], data = [];
        const capture = (event) => { keyAt = performance.now(); keys.push(event.key); };
        // Capture above xterm's parent handlers: some keys emit onData in
        // keydown rather than keypress, before a textarea-only observer runs.
        document.addEventListener('keydown', capture, true);
        const listener = terminal.onData((text) => {
          data.push(text);
          if (keyAt != null) { measurements.push(performance.now() - keyAt); keyAt = null; }
        });
        window.__interactionFixture = { measurements, keys, data, dispose: () => {
          listener.dispose(); document.removeEventListener('keydown', capture, true);
          delete window.__interactionFixture;
        } };
        terminal.focus();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (document.activeElement !== terminal.textarea) throw new Error('fixture terminal did not receive focus');
      }, runtime);
      try {
        await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123');
        const { measurements: samples, keys, data } = await page.evaluate(() => {
          const { measurements, keys, data } = window.__interactionFixture;
          return { measurements, keys, data };
        });
        assert.equal(samples.length, 30, `every input event must reach xterm exactly once: ${JSON.stringify({ keys, data })}`);
        keyboard = summary(samples);
      } finally {
        await page.evaluate(() => window.__interactionFixture?.dispose());
      }
      const samples = await page.evaluate(async (runtime) => {
        const terminal = (await import(runtime)).getState().selected.term;
        const values = [];
        for (let i = 0; i < 30; i++) {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listener.dispose(); reject(new Error('xterm render deadline exceeded')); }, 2000);
            const marker = `render-fixture-${i}`;
            const start = performance.now();
            const listener = terminal.onRender(() => {
              const buffer = terminal.buffer.active;
              const last = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '';
              if (!last.includes(marker)) return;
              values.push(performance.now() - start);
              clearTimeout(timer); listener.dispose(); resolve();
            });
            terminal.write(`\r\x1b[2K${marker}`);
          });
        }
        return values;
      }, runtime);
      render = summary(samples);
    }
    results.push({ sessions: count, foreground, background, keydownToXtermData: keyboard, writeToXtermRenderEvent: render });
  }
  console.log(JSON.stringify({ environment: 'isolated Chromium with Vite development server; no native PTYs', results }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
