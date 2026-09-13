// SPDX-License-Identifier: Apache-2.0
// Runs inside the real Tauri webview. It touches only an app-owned cache run
// returned by Rust and writes the final report under app_log_dir. Commands,
// quoting and system metadata follow the platform and the shell flavor, so the
// same script runs on macOS, Linux and Windows.

import * as runtime from '../../packages/ui/src/terminals/runtime.js';
import { fs, shellQuote } from '../../packages/ui/src/terminals/files.js';
import { invoke } from '../../packages/ui/src/lib/native.js';
import { platform } from '../../packages/ui/src/lib/platform.js';
import { EXECUTED_PATH, noiseFixtures, PTY_ATTEMPTS, PTY_MARKER, PTY_OUTPUT_MS, ptyMarkerCommand, quotedTail, TERMINAL_READY_MS } from './portable.js';

const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let sessionId = null;
let shellFlavor = null;
let paths = null;

async function until(test, what, limit = 20000) {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Tempo excedido ao aguardar ${what}`);
    await pause();
  }
}

async function untilAsync(test, what, limit = 8000) {
  const deadline = Date.now() + limit;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > deadline) throw new Error(`Tempo excedido ao aguardar ${what}`);
    await pause();
  }
}

async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message || String(error) });
  }
}

function mouse(node, type, x, y) {
  const buttons = type === 'mouseup' ? 0 : 1;
  node.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
  }));
}

function center(node) {
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 12) };
}

// Arrasta pelo gesto do estúdio e confere o destaque do próprio alvo: pasta
// com is-drop e terminal com is-dropping. O destaque de outro elemento no
// caminho do mouse não conta.
async function drag(source, target, highlight) {
  const from = center(source);
  mouse(source, 'mousedown', from.x, from.y);
  await pause(30);
  mouse(document.body, 'mousemove', from.x + 12, from.y + 7);
  await pause(30);
  const to = center(target);
  mouse(document.body, 'mousemove', to.x, to.y);
  const deadline = Date.now() + 1500;
  let highlighted = false;
  while (Date.now() < deadline) {
    highlighted = target.matches(highlight);
    if (highlighted) break;
    await pause(40);
  }
  const ghost = Boolean(document.querySelector('.terminais-ghost'));
  mouse(document.body, 'mouseup', to.x, to.y);
  await pause(400);
  return { ghost, highlighted };
}

const rows = () => [...document.querySelectorAll('.terminais-tree .terminais-row')];
const row = (name) => rows().find((item) => item.querySelector('.terminais-row__name')?.textContent === name);
const exists = async (path) => Boolean((await fs.stat(path).catch(() => null))?.exists);

function bufferText(session) {
  const buffer = session.term.buffer.active;
  let text = '';
  for (let index = 0; index <= buffer.baseY + buffer.cursorY; index += 1) {
    const line = buffer.getLine(index);
    if (line) text += `${line.isWrapped ? '' : '\n'}${line.translateToString(true)}`;
  }
  return text.normalize('NFC');
}

async function prepare(root) {
  await fs.createDir(`${root}/destino`);
  await fs.writeText(`${root}/origem.txt`, 'origem\n', null);
  await fs.writeText(`${root}/com espaço.txt`, 'espaço\n', null);
  await fs.writeText(`${root}/exemplo.csv`, 'Nome,Valor\nA,1\nB,2\n', null);
}

async function run() {
  await until(() => document.visibilityState === 'visible', 'a janela ficar visível', 180000);
  paths = await invoke('app_selftest_paths');
  if (!paths?.root || !paths?.output) throw new Error('app_selftest_paths devolveu um contrato incompleto');
  await prepare(paths.root);
  await runtime.hydrate();

  sessionId = runtime.openSession(paths.root, { name: 'autoteste Cialai' });
  if (!sessionId) throw new Error('openSession não devolveu identificador');
  await until(() => runtime.getSession(sessionId)?.status === 'running', 'o shell abrir');
  runtime.selectSession(sessionId);
  const session = runtime.getSession(sessionId);
  shellFlavor = session.shellFlavor || null;
  await until(() => row('destino'), 'a árvore listar a pasta destino');
  // Na primeira abertura, WebKitGTK e WebView2 ainda criam caches de fonte e de
  // renderização; os itens do terminal só começam com o xterm montado na tela.
  await until(() => document.querySelector('.terminais-terminal__host .xterm-screen'), 'o terminal montar', TERMINAL_READY_MS);

  await check('PTY real', async () => {
    await until(() => bufferText(session).trim(), 'o prompt do shell', TERMINAL_READY_MS);
    for (let attempt = 1; attempt <= PTY_ATTEMPTS; attempt += 1) {
      runtime.insertText(sessionId, ptyMarkerCommand(session.shellFlavor));
      try {
        await until(() => bufferText(session).includes(PTY_MARKER), 'a saída do PTY', PTY_OUTPUT_MS);
        return `shell ${session.shellFlavor} respondeu no PTY${attempt > 1 ? ` na tentativa ${attempt}` : ''}`;
      } catch (error) {
        if (attempt === PTY_ATTEMPTS) throw error;
      }
    }
    return '';
  });

  await check('arquivos pelo Rust', async () => {
    const original = await fs.readText(`${paths.root}/origem.txt`);
    if (original.content !== 'origem\n') throw new Error('a leitura devolveu conteúdo diferente');
    await fs.copy(`${paths.root}/origem.txt`, `${paths.root}/copia.txt`);
    const copy = await fs.readText(`${paths.root}/copia.txt`);
    if (copy.content !== original.content) throw new Error('a cópia mudou o conteúdo');
    const listing = await fs.listDir(paths.root);
    if (!listing.entries.some((item) => item.name === 'copia.txt')) throw new Error('a listagem não trouxe a cópia');
    return 'leitura, cópia e listagem passaram pela ponte Rust';
  });

  await check('arraste entre pastas', async () => {
    const source = await until(() => row('origem.txt'), 'a linha origem.txt');
    const target = row('destino');
    const gesture = await drag(source, target, '.is-drop');
    if (!gesture.ghost) throw new Error('o gesto não mostrou a marca de arraste');
    if (!gesture.highlighted) throw new Error('a pasta não mostrou o destaque de destino');
    await untilAsync(() => exists(`${paths.root}/destino/origem.txt`), 'o arquivo entrar na pasta');
    if (await exists(`${paths.root}/origem.txt`)) throw new Error('o arquivo continuou na origem');
    return 'origem.txt foi movido para destino e conferido no disco';
  });

  await check('caminho no terminal', async () => {
    runtime.insertText(sessionId, '\x03');
    const source = await until(() => row('com espaço.txt'), 'a linha com espaço');
    const target = session.term.element?.closest('.terminais-terminal') || document.querySelector('.terminais-terminal');
    const gesture = await drag(source, target, '.is-dropping');
    if (!gesture.ghost || !gesture.highlighted) throw new Error('o terminal não aceitou o gesto de arraste');
    await until(() => bufferText(session).includes('com espaço.txt'), 'o caminho no terminal');
    const text = bufferText(session);
    const quoted = shellQuote(`${paths.root}/com espaço.txt`, session.shellFlavor);
    if (!text.includes(quotedTail(quoted))) throw new Error(`o caminho não veio absoluto e protegido por aspas de ${session.shellFlavor}`);
    if (EXECUTED_PATH.test(text)) throw new Error('o caminho foi executado sem confirmação');
    runtime.insertText(sessionId, '\x03');
    return 'caminho absoluto inserido sem executar o arquivo';
  });

  await check('sujeira do sistema filtrada', async () => {
    const fixtures = noiseFixtures(platform().os);
    for (const name of fixtures) await fs.writeText(`${paths.root}/${name}`, 'fixture', null);
    const listing = await fs.listDir(paths.root);
    const noise = listing.entries.filter((item) => fixtures.includes(item.name));
    if (noise.length) throw new Error(`a listagem expôs ${noise.map((item) => item.name).join(', ')}`);
    return `${fixtures.join(' e ')} não aparecem na listagem de ${platform().os}`;
  });

  await check('editor de CSV', async () => {
    const editor = await import('../../packages/ui/src/terminals/editor.js');
    const tab = await editor.openFile(sessionId, `${paths.root}/exemplo.csv`);
    await until(() => !tab.loading, 'o CSV carregar');
    editor.setTabMode(tab, 'preview');
    await until(() => tab.viewer?.kind === 'sheet', 'a tabela do CSV');
    if (tab.viewer.sheets[0].rows[1][1] !== '1') throw new Error('a tabela trouxe dados diferentes da fixture');
    await until(() => document.querySelector('.terminais-sheet table td'), 'a tabela aparecer na tela');
    editor.closeTab(sessionId, tab);
    return 'fixture fictícia abriu como tabela e foi renderizada';
  });

  await check('preferências e shell', async () => {
    const [preferences, shell] = await Promise.all([invoke('get_preferences'), invoke('app_shell')]);
    if (!preferences?.terminal || !Array.isArray(preferences.projectRoots) || !preferences?.devBrowser) throw new Error('snapshot de preferências incompleto');
    if (!shell?.path || !Array.isArray(shell.args) || !shell.flavor) throw new Error('shell efetivo incompleto');
    return `snapshot completo e shell ${shell.path}`;
  });

  await check('Dev Browser', async () => {
    const browser = await import('../../packages/ui/src/terminals/browser/runtime.js');
    browser.openBrowserTab(sessionId, { start: true });
    await until(() => ['ready', 'error', 'stopped'].includes(runtime.getSession(sessionId).browser.status), 'o Chromium abrir', 60000);
    const state = runtime.getSession(sessionId).browser;
    if (state.status !== 'ready') throw new Error(`Chromium ${state.status}: ${state.error || 'sem detalhe'}`);
    await browser.navigate(sessionId, 'data:text/html,<body style="margin:0;background:%23ff3b84"></body>');
    const canvas = await until(() => document.querySelector('.terminais-browser__canvas'), 'o canvas do Dev Browser');
    await until(() => browser.hasFrame(sessionId), 'o primeiro quadro do Dev Browser', 20000);
    await pause(500);
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    if (!(pixel[0] > 200 && pixel[1] < 110 && pixel[2] > 90)) throw new Error(`pixel central inesperado: ${[...pixel].join(',')}`);
    const port = state.info.port;
    await browser.stopBrowser(sessionId);
    return `Chromium respondeu na porta ${port} e desenhou o quadro esperado`;
  });
}

if (!window.__CIALAI_SELFTEST_RUNNING__) {
  window.__CIALAI_SELFTEST_RUNNING__ = true;
  const startedAt = new Date().toISOString();
  try {
    await run();
  } catch (error) {
    results.push({ name: 'roteiro', ok: false, detail: error?.message || String(error) });
  } finally {
    if (sessionId != null) {
      try { runtime.closeSession(sessionId); } catch (_error) { /* best effort */ }
      await pause(400);
    }
  }

  const report = {
    ok: results.length > 0 && results.every((item) => item.ok),
    platform: platform().os,
    shellFlavor,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
  window.__CIALAI_SELFTEST_RESULT__ = report;
  if (paths?.output) await fs.writeText(paths.output, `${JSON.stringify(report, null, 2)}\n`, null).catch(() => {});
  document.title = report.ok ? 'SELFTEST PASS' : 'SELFTEST FAIL';
  await pause(500);
  await invoke('app_request_quit').catch(() => {});
}
