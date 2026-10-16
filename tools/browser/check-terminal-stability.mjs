// SPDX-License-Identifier: Apache-2.0
// Real xterm in isolated Chromium; development server only, no distribution build.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { heapRetainers } from './heap-retainers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root: `${root}apps/desktop`, configFile: `${root}apps/desktop/vite.config.js`,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CIALAI_TEST_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?terminais=demo&motion=0&platform=windows#terminais`);
  await page.waitForSelector('.xterm');
  const runtime = `/@fs${root}packages/ui/src/terminals/runtime.js`;
  const result = await page.evaluate(async (runtime) => {
    const api = await import(runtime);
    const session = api.getState().selected;
    // Demo PTYs have no native bridge. Assign a fixture-only ID to exercise
    // xterm's onData path; no command leaves this browser context.
    session.ptyId = 900001;
    const output = [];
    const listener = session.term.onData((text) => output.push(text));
    await new Promise((resolve) => session.term.write('\x1b[?2004h', resolve));
    const text = 'ação 😀\n$literal `texto`';
    let release;
    const reading = session.clipboard.read({ readText: () => new Promise((resolve) => { release = resolve; }) });
    const data = new DataTransfer(); data.setData('text/plain', text);
    session.term.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    release(text); await reading;
    const native = [...output]; output.length = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => text,
      writeText: async (value) => (window.__stabilityCopied ||= []).push(value) } });
    session.term.focus();
    window.__stabilityOutput = output;
    window.__stabilityDispose = () => { listener.dispose(); session.ptyId = null; delete navigator.clipboard; delete window.__stabilityOutput; delete window.__stabilityCopied; delete window.__stabilityDispose; };
    return { native, expected: `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~` };
  }, runtime);
  assert.deepEqual(result.native, [result.expected], 'native paste + async read must produce one bracketed paste');
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => window.__stabilityOutput.length > 0);
  assert.deepEqual(await page.evaluate(() => [...window.__stabilityOutput]), [result.expected], 'Windows shortcut must paste text, not Ctrl+V image request');
  await page.evaluate(() => { window.__stabilityOutput.length = 0; });
  await page.keyboard.press('Control+c');
  assert.deepEqual(await page.evaluate(() => [...window.__stabilityOutput]), ['\x03'], 'without selection Ctrl+C must interrupt');
  for (const [os, shortcut, agent] of [
    ['windows', 'Shift+Insert', null], ['windows', 'Control+Shift+v', 'Claude Code'],
    ['linux', 'Control+Shift+v', null], ['linux', 'Shift+Insert', null],
    ['linux', 'Control+v', 'Codex'], ['linux', 'Control+v', 'Claude Code'],
  ]) {
    await page.evaluate(({ os, agent, runtime }) => import(runtime).then((api) => {
      document.documentElement.dataset.platform = os;
      const session = api.getState().selected;
      session.activity = { foreground: agent ? { agent } : null };
      window.__stabilityOutput.length = 0; session.term.focus();
    }), { os, agent, runtime });
    await page.keyboard.press(shortcut);
    await page.waitForFunction(() => window.__stabilityOutput.length > 0);
    assert.deepEqual(await page.evaluate(() => [...window.__stabilityOutput]), [result.expected], `${os} ${shortcut} ${agent || 'shell'} inserts once`);
  }
  await page.evaluate(async (runtime) => {
    document.documentElement.dataset.platform = 'linux';
    const api = await import(runtime); api.getState().selected.activity = { foreground: null };
    window.__stabilityOutput.length = 0;
  }, runtime);
  await page.keyboard.press('Control+v');
  assert.deepEqual(await page.evaluate(() => [...window.__stabilityOutput]), ['\x16'], 'Linux shell retains literal-next');
  await page.evaluate(async (runtime) => {
    const session = (await import(runtime)).getState().selected;
    document.documentElement.dataset.platform = 'windows';
    session.term.selectAll(); window.__stabilityOutput.length = 0;
  }, runtime);
  await page.keyboard.press('Control+Insert');
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => window.__stabilityCopied.length), 2, 'Windows selection copy shortcuts each run once');
  assert.deepEqual(await page.evaluate(() => [...window.__stabilityOutput]), [], 'copying a selection must not interrupt');
  const nativeCopy = await page.evaluate(async (runtime) => {
    const session = (await import(runtime)).getState().selected;
    document.documentElement.dataset.platform = 'macos';
    const expected = session.term.getSelection(), data = new DataTransfer();
    const event = new ClipboardEvent('copy', {bubbles:true,cancelable:true,clipboardData:data});
    session.term.textarea.dispatchEvent(event); session.term.clearSelection();
    return {expected,actual:data.getData('text/plain'),prevented:event.defaultPrevented};
  }, runtime);
  assert.ok(nativeCopy.expected.length > 0);
  assert.equal(nativeCopy.actual, nativeCopy.expected, 'macOS native copy uses terminal selection');
  assert.equal(nativeCopy.prevented, true);
  const formats = await page.evaluate(async (runtime) => {
    const session = (await import(runtime)).getState().selected;
    session.activity = {foreground:{agent:'Codex'}};
    const writes = [];
    window.__TAURI_INTERNALS__ = {invoke: async (command, args) => { if(command==='pty_write') writes.push(args.data); }};
    const send = async (text, image) => {
      window.__stabilityOutput.length = 0;
      writes.length = 0;
      const data = new DataTransfer();
      if (text) data.setData('text/plain', text);
      if (image) data.items.add(new File(['fixture'], 'fixture.png', {type:'image/png'}));
      session.term.textarea.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data}));
      await session.lastWrite;
      return [...writes];
    };
    try { return {image:await send('',true),empty:await send('',false),multi:await send('texto',true)}; }
    finally { delete window.__TAURI_INTERNALS__; }
  }, runtime);
  assert.deepEqual(formats.image, ['\x16'], 'only an actual image invokes the agent image-paste path');
  assert.deepEqual(formats.empty, [], 'empty clipboard must not invoke image paste');
  assert.deepEqual(formats.multi, ['\x1b[200~texto\x1b[201~'], 'text wins over image in mixed formats');
  const editables = await page.evaluate(() => ['textarea','div'].map((tag) => {
    const field = document.createElement(tag); if(tag==='div') field.contentEditable='true';
    document.body.appendChild(field); field.focus();
    const event = new KeyboardEvent('keydown', {key:'v',code:'KeyV',ctrlKey:true,bubbles:true,cancelable:true});
    field.dispatchEvent(event); field.remove(); return event.defaultPrevented;
  }));
  assert.deepEqual(editables, [false,false], 'ordinary editables retain their native clipboard handling');
  await page.evaluate(() => window.__stabilityDispose());

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const measurements = [];
  const cycles = Math.min(100, Math.max(2, Number(process.env.CIALAI_SOAK_CYCLES) || 2));
  for (const count of [0, 1, 10, ...Array.from({ length: cycles }, () => [30, 0]).flat()]) {
    await page.evaluate(async ({ runtime, count }) => {
      const api = await import(runtime);
      const selected = api.getState().selected;
      // Track the repeated fixture cohort. The initial UI/clipboard warmup
      // may remain in Chromium's bounded style cache and is not this cohort.
      if (selected?.name?.startsWith('fixture-')) (window.__closedRefs ||= []).push({ session: new WeakRef(selected), terminal: new WeakRef(selected.term), element: new WeakRef(selected.term.element) });
      for (const session of api.orderedSessions()) {
        if (!await api.closeSession(session.id)) throw new Error('fixture did not close');
      }
      if (api.orderedSessions().length) throw new Error('session retained after close');
      for (let i = 0; i < count; i++) api.openSession('/fixture', { name: `fixture-${i}`, select: i === 0 });
    }, { runtime, count });
    await page.waitForTimeout(1000);
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    const dom = await cdp.send('Memory.getDOMCounters');
    measurements.push({ sessions: count, jsHeapBytes: values.JSHeapUsedSize, ...dom,
      liveNodes: await page.evaluate(() => document.querySelectorAll('*').length),
      retainedTerminals: await page.evaluate(() => (window.__closedRefs || []).filter((entry) => entry.terminal.deref()).length) });
  }
  console.log(JSON.stringify({ checks: ['native/API paste once', 'Windows/Linux shortcut matrix', 'Ctrl+C copy versus interrupt',
    'native macOS copy', 'text/image/multiformat/empty', 'ordinary editables', 'old terminal collection'], measurements }, null, 2));
  if (process.env.CIALAI_HEAP_TRACE) console.log(await heapRetainers(cdp, 'window.__closedRefs[0].session.deref()'));
  const retainedOldTerminals = await page.evaluate(() => (window.__closedRefs || []).slice(0, -2).filter((entry) => entry.terminal.deref()).length);
  assert.equal(retainedOldTerminals, 0, 'closed terminals from old cycles must be collected');
} finally {
  await browser?.close();
  await server.close();
}
