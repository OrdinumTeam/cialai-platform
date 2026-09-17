// SPDX-License-Identifier: Apache-2.0
// Runs inside the real Tauri webview. It touches only an app-owned cache run
// returned by Rust and writes the final report under app_log_dir. Commands,
// quoting and system metadata follow the platform and the shell flavor, so the
// same script runs on macOS, Linux and Windows.
//
// A rede automática usa o sidecar v2 real e a identidade do app: o roteiro não
// preenche nenhum campo, só observa o ponto de estado, lê o QR do diálogo e
// abre Dispositivos. O relatório nunca leva payload, onion ou endereço.

import * as runtime from '../../packages/ui/src/terminals/runtime.js';
import { fs, shellQuote } from '../../packages/ui/src/terminals/files.js';
import { invoke } from '../../packages/ui/src/lib/native.js';
import { platform } from '../../packages/ui/src/lib/platform.js';
import { translate } from '../../packages/ui/src/desktop/i18n.js';
import {
  DIAGNOSTIC_CHECKS,
  DIAGNOSTICS_MS,
  EXECUTED_PATH,
  NETWORK_FIELDS,
  NETWORK_PROBLEM_MS,
  NETWORK_READY_MS,
  NETWORK_READY_STATES,
  noiseFixtures,
  PAIR_QR_MS,
  PAIR_QR_PREFIX,
  progressPattern,
  PTY_ATTEMPTS,
  PTY_MARKER,
  PTY_OUTPUT_MS,
  ptyMarkerCommand,
  quotedTail,
  TERMINAL_READY_MS,
} from './portable.js';
import { decodeImage } from './qr.js';

const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
// Andamento lido pelo driver quando o roteiro não termina: etapa atual, resultados e
// diagnósticos, para uma parada no runner mostrar onde e por que parou.
const progress = { step: null, stepStartedAt: null, results, diagnostics: {} };
window.__CIALAI_SELFTEST_PROGRESS__ = progress;
let sessionId = null;
let shellFlavor = null;
let paths = null;

// Ponto de estado da toolbar desde a abertura do app. O observador fica só no
// botão do ponto, então um estado curto como "Pronto para parear" antes do
// bootstrap do Tor não se perde entre duas leituras. Com o documento inteiro
// observado, o item do Dev Browser deixou de receber o primeiro quadro no macOS.
const network = { states: [], startedAt: Date.now() };
progress.diagnostics.network = network;
const TUNNEL_LABELS = Object.freeze({
  pairable: 'desktop.tunnel.pairable',
  accessible: 'desktop.tunnel.accessible',
  problem: 'desktop.tunnel.problem',
  reconnecting: 'desktop.tunnel.reconnecting',
  starting: 'desktop.tunnel.starting',
  off: 'desktop.tunnel.off',
});
let tunnelLabel = null;

function tunnelKind(label) {
  for (const [kind, key] of Object.entries(TUNNEL_LABELS)) if (label === translate(key)) return kind;
  if (progressPattern((value) => translate('desktop.tunnel.reservePreparing', { progress: value })).test(label)) return 'reserve';
  return 'other';
}

function recordTunnel() {
  const label = document.querySelector('.mac-tunnel-status')?.textContent?.trim() || '';
  if (!label || label === tunnelLabel) return;
  tunnelLabel = label;
  const state = tunnelKind(label);
  if (network.states.at(-1)?.state !== state) network.states.push({ state, ms: Date.now() - network.startedAt });
}

const tunnelObserver = new MutationObserver(recordTunnel);
let observedStatus = null;
// O botão nasce com a toolbar e o React pode recriá-lo; a verificação leve
// liga o observador ao nó atual.
function watchTunnel() {
  const status = document.querySelector('.mac-tunnel-status');
  if (status && status !== observedStatus) {
    tunnelObserver.disconnect();
    tunnelObserver.observe(status, { subtree: true, childList: true, characterData: true });
    observedStatus = status;
  }
  recordTunnel();
}
const tunnelWatch = setInterval(watchTunnel, 100);
watchTunnel();

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
  const started = Date.now();
  progress.step = name;
  progress.stepStartedAt = new Date(started).toISOString();
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail || '', ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message || String(error), ms: Date.now() - started });
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
// caminho do mouse não conta. O alvo pode ser uma função: a árvore se refaz
// quando o observador de arquivos avisa, e a linha antiga sai do documento.
async function drag(source, target, highlight) {
  const resolve = typeof target === 'function' ? target : () => target;
  const from = center(source);
  mouse(source, 'mousedown', from.x, from.y);
  await pause(30);
  mouse(document.body, 'mousemove', from.x + 12, from.y + 7);
  await pause(30);
  const deadline = Date.now() + 3000;
  let highlighted = false;
  let to = center(resolve());
  while (Date.now() < deadline) {
    const current = resolve();
    if (current) {
      to = center(current);
      mouse(document.body, 'mousemove', to.x, to.y);
      highlighted = current.matches(highlight);
      if (highlighted) break;
    }
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

// Resumo de net.status sem identidade, endereços nem onion.
async function networkSummary() {
  try {
    const status = await invoke('tunnel_call', { command: 'net.status', args: {} });
    const tor = status?.tor || {};
    network.reserve = { state: tor.state, progress: tor.progress ?? 0, published: tor.published === true };
    const error = status?.error?.code ? `, erro ${status.error.code}` : '';
    return `rede ${status?.state}, direta ${status?.direct?.state}, reserva ${tor.state} em ${tor.progress ?? 0}% ${tor.published ? 'publicada' : 'sem publicar'}, mdns ${status?.mdns?.state}, borda ${status?.edge?.state}${error}`;
  } catch (error) {
    return `net.status falhou: ${error?.message || String(error)}`;
  }
}

function readQr(canvas) {
  try {
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return decodeImage(image);
  } catch (error) {
    progress.diagnostics.qrError = error?.message || String(error);
    return null;
  }
}

function navItem(label) {
  return [...document.querySelectorAll('.mac-nav-item')].find((item) => item.textContent.trim() === label);
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
  // O ConPTY pergunta a posição do cursor ao nascer e o Rust responde essa primeira
  // pergunta; aqui contam as que chegam ao xterm e as respostas que ele gera.
  const cursor = { queries: 0, replies: 0 };
  progress.diagnostics.cursor = cursor;
  session.term.parser.registerCsiHandler({ final: 'n' }, (params) => {
    if (params[0] === 6) cursor.queries += 1;
    return false;
  });
  session.term.onData((data) => {
    if (/^\x1b\[\d+;\d+R$/.test(data)) cursor.replies += 1;
  });
  // Na tela de 1024 px dos runners do Windows a coluna de arquivos recolhe
  // sozinha; o autoteste abre pelo mesmo botão que a pessoa usa.
  progress.step = 'abertura';
  progress.stepStartedAt = new Date().toISOString();
  await until(() => {
    const found = row('destino');
    if (!found) document.querySelector('.terminais-edge--right .terminais-edge__btn')?.click();
    return found;
  }, 'a árvore listar a pasta destino');
  // Na primeira abertura, WebKitGTK e WebView2 ainda criam caches de fonte e de
  // renderização; os itens do terminal só começam com o xterm montado na tela.
  await until(() => document.querySelector('.terminais-terminal__host .xterm-screen'), 'o terminal montar', TERMINAL_READY_MS);
  // Renderizador do terminal, GPU vista pelo WebGL do xterm e atraso da fila de
  // eventos; o roteiro não cria contexto WebGL próprio.
  progress.diagnostics.renderer = runtime.terminalRenderer();
  const lag = { maxMs: 0 };
  progress.diagnostics.eventLoopLag = lag;
  let tick = Date.now();
  setInterval(() => {
    const now = Date.now();
    lag.maxMs = Math.max(lag.maxMs, now - tick - 250);
    tick = now;
  }, 250);

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

  await check('replay não gera entrada', async () => {
    // A marca de replay cala a entrada enquanto o histórico volta ao xterm.
    // Um reattach reproduz o histórico com as consultas do shell dentro; se a
    // marca falhasse, o xterm responderia a ESC[6n e a resposta sairia por
    // onData. Reattacha a sessão pelo mesmo caminho da recarga do webview e
    // afirma que nenhuma resposta de cursor vazou.
    await runtime.restart(sessionId);
    await until(() => runtime.getSession(sessionId)?.status === 'running', 'o shell reabrir');
    await until(() => document.querySelector('.terminais-terminal__host .xterm-screen'), 'o terminal montar de novo', TERMINAL_READY_MS);
    if (cursor.replies !== 0) {
      throw new Error(`o xterm respondeu ${cursor.replies} consultas de cursor no reattach`);
    }
    return `nenhuma resposta de cursor vazou em ${cursor.queries} consultas vistas`;
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
    const target = () => row('destino');
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

  await check('rede automática', async () => {
    const preferences = await invoke('get_preferences');
    const fields = Object.keys(preferences?.network || {}).sort();
    if (fields.join() !== NETWORK_FIELDS.join()) throw new Error(`preferências de rede inesperadas: ${fields.join(', ') || 'nenhuma'}`);
    let problemSince = null;
    const deadline = Date.now() + NETWORK_READY_MS;
    for (;;) {
      recordTunnel();
      const reached = network.states.find((item) => NETWORK_READY_STATES.includes(item.state));
      const current = network.states.at(-1)?.state;
      // Depois de "Pronto para parear", o bootstrap do Tor mostra a reserva
      // preparando; um problema depois disso continua reprovando.
      if (reached && (NETWORK_READY_STATES.includes(current) || current === 'reserve')) {
        const summary = await networkSummary();
        const path = network.states.map((item) => item.state).join(', ');
        return `${translate(TUNNEL_LABELS[reached.state])} em ${(reached.ms / 1000).toFixed(1)} s sem campo preenchido; estados ${path}; ${summary}`;
      }
      problemSince = current === 'problem' ? problemSince ?? Date.now() : null;
      if (Date.now() > deadline || (problemSince && Date.now() - problemSince > NETWORK_PROBLEM_MS)) {
        throw new Error(`o ponto parou em ${tunnelLabel || 'nenhum estado'}; ${await networkSummary()}`);
      }
      await pause(250);
    }
  });

  await check('QR de pareamento', async () => {
    // O QR fica borrado na tela enquanto o roteiro roda, para as capturas do
    // runner não levarem um código válido; getImageData lê o canvas sem o filtro.
    const blur = document.createElement('style');
    blur.textContent = '.mac-pair__qr canvas { filter: blur(14px); }';
    document.head.append(blur);
    try {
      const status = document.querySelector('.mac-tunnel-status');
      if (!status) throw new Error('a toolbar não tem o ponto de estado');
      status.click();
      const canvas = await until(() => document.querySelector('.mac-pair__qr canvas'), 'o QR do diálogo Vincular celular', PAIR_QR_MS);
      const dialog = canvas.closest('[role="dialog"]');
      if (!dialog?.textContent.includes(translate('desktop.action.pairPhone'))) throw new Error('o QR não está no diálogo Vincular celular');
      const box = canvas.getBoundingClientRect();
      if (box.width < 200 || box.height < 200 || getComputedStyle(canvas).visibility !== 'visible') throw new Error('o QR não ficou visível no diálogo');
      const qr = await until(() => readQr(canvas), 'um QR legível no canvas', PAIR_QR_MS);
      if (!qr.text.startsWith(PAIR_QR_PREFIX)) throw new Error(`o texto do QR não começa com ${PAIR_QR_PREFIX}`);
      const reserveTitle = translate('desktop.access.reserve');
      const row = [...dialog.querySelectorAll('.mac-pair__reserve > div')].find((item) => item.querySelector('dt')?.textContent.trim() === reserveTitle);
      if (!row) throw new Error('a linha da conexão de reserva não apareceu');
      const reserve = row.querySelector('dd')?.textContent.trim() || '';
      const ready = reserve === translate('desktop.access.reserveReady');
      const preparing = progressPattern((value) => translate('desktop.access.reservePreparing', { progress: value })).test(reserve);
      if (!ready && !preparing) throw new Error(`a linha da reserva mostrou ${reserve || 'nada'}`);
      const notice = Boolean(dialog.querySelector('.mac-pair__notice'));
      if (notice === ready) throw new Error(ready ? 'o aviso da reserva continuou com a reserva pronta' : 'faltou o aviso de que outra rede espera a reserva');
      if (dialog.querySelector('input, select, textarea')) throw new Error('o diálogo pediu dados');
      return `QR versão ${qr.version} nível ${qr.level} com ${qr.text.length} caracteres começando com ${PAIR_QR_PREFIX}; ${reserveTitle}: ${reserve}`;
    } finally {
      document.querySelector(`[role="dialog"] button[aria-label="${translate('shared.action.close')}"]`)?.click();
      await until(() => !document.querySelector('.mac-pair__qr'), 'o diálogo Vincular celular fechar', 5000).catch(() => {});
      blur.remove();
    }
  });

  await check('painel de dispositivos', async () => {
    const item = navItem(translate('desktop.view.devices.label'));
    if (!item) throw new Error('a barra lateral não tem Dispositivos');
    item.click();
    try {
      const view = await until(() => document.querySelector('#view-dispositivos'), 'a tela Dispositivos abrir');
      await until(() => view.querySelector('.mac-access') && view.querySelector('.mac-devices__list-section'), 'o painel de acesso e a lista de celulares');
      await until(() => !view.querySelector('.mac-devices__list-section .mac-state--loading'), 'a lista de celulares carregar');
      if (view.querySelector('input, select, textarea')) throw new Error('Dispositivos mostrou campo de servidor, endereço, porta ou chave');
      const phones = view.querySelectorAll('.mac-device-row').length;
      view.querySelector('.mac-access__link')?.click();
      const advanced = await until(() => view.querySelector('.mac-advanced[open] .mac-advanced__body'), 'o diagnóstico avançado abrir');
      const fingerprint = advanced.querySelector('[aria-labelledby="advanced-identity"]')?.querySelectorAll('dd')[1]?.textContent.trim();
      if (!fingerprint || fingerprint === translate('desktop.common.unavailable')) throw new Error('a impressão digital do computador não apareceu');
      advanced.querySelector('.mac-advanced__checks .btn-secondary')?.click();
      await until(() => advanced.querySelector('.mac-advanced__check-list li') || view.querySelector('[role="alert"]'), 'o resultado de diagnostics.run', DIAGNOSTICS_MS);
      const alerts = [...view.querySelectorAll('[role="alert"]')].map((node) => node.textContent.trim()).filter(Boolean);
      if (alerts.length) throw new Error(`Dispositivos mostrou erro: ${alerts.join('; ')}`);
      const checks = [...advanced.querySelectorAll('.mac-advanced__check-list li')];
      if (checks.length !== DIAGNOSTIC_CHECKS) throw new Error(`diagnostics.run trouxe ${checks.length} verificações em vez de ${DIAGNOSTIC_CHECKS}`);
      const passed = checks.filter((node) => node.classList.contains('is-ok')).length;
      return `celulares vinculados: ${phones}; diagnóstico avançado aberto com ${passed} de ${checks.length} verificações em ordem`;
    } finally {
      navItem(translate('view.terminais.label'))?.click();
    }
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
    clearInterval(tunnelWatch);
    tunnelObserver.disconnect();
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
    diagnostics: progress.diagnostics,
  };
  window.__CIALAI_SELFTEST_RESULT__ = report;
  if (paths?.output) await fs.writeText(paths.output, `${JSON.stringify(report, null, 2)}\n`, null).catch(() => {});
  document.title = report.ok ? 'SELFTEST PASS' : 'SELFTEST FAIL';
  await pause(500);
  await invoke('app_request_quit').catch(() => {});
}
