// SPDX-License-Identifier: Apache-2.0
// Self test do binário real por tauri-driver, usado no Linux e no Windows. O
// runner sobe o tauri-driver, abre o app por WebDriver, navega para a mesma
// origem com ?cialai_selftest=1 e espera o relatório em app_log_dir. Só usa
// módulos nativos do Node, para rodar logo depois do build sem dependências.
//
//   node tools/selftest/driver.mjs [--app caminho] [--artifacts pasta]
//     [--timeout segundos] [--port 4444] [--driver tauri-driver]
//     [--native-driver caminho]

import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appPage,
  bridgeEnv,
  driverCapabilities,
  freePort,
  MAX_SCREENSHOTS,
  parseDriverArgs,
  reportPath,
  SCREENSHOT_INTERVAL_MS,
  selftestUrl,
  targetDirProblem,
} from './common.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const options = parseDriverArgs(process.argv.slice(2), { root, platform: process.platform, env: process.env });
const output = reportPath({ platform: process.platform, env: process.env, home: homedir() });
const base = `http://127.0.0.1:${options.port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(options.app)) {
  throw new Error(`Binário do app ausente em ${options.app}; rode npm run build --workspace @cialai/desktop -- --debug --no-bundle`);
}
const targetProblem = targetDirProblem(dirname(dirname(options.app)));
if (targetProblem) throw new Error(targetProblem);
mkdirSync(options.artifacts, { recursive: true });
if (existsSync(output)) unlinkSync(output);

async function webdriver(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.value?.error) {
    throw new Error(`${method} ${path}: ${payload?.value?.error || response.status} ${payload?.value?.message || ''}`.trim());
  }
  return payload.value;
}

function readReport() {
  if (!existsSync(output)) return null;
  try { return JSON.parse(readFileSync(output, 'utf8')); } catch (_error) { return null; }
}

const driverLog = createWriteStream(join(options.artifacts, 'tauri-driver.log'));
// O app nasce do driver nativo e herda este ambiente.
const driver = spawn(options.driver, options.driverArgs, {
  env: bridgeEnv(process.env, await freePort()),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
driver.stdout.pipe(driverLog);
driver.stderr.pipe(driverLog);
let driverExit = null;
driver.on('exit', (code, signal) => { driverExit = code ?? signal; });
driver.on('error', (error) => { driverExit = error.message; });

function stopDriver() {
  if (driverExit !== null) return;
  try {
    if (process.platform === 'win32') driver.kill();
    else process.kill(-driver.pid, 'SIGTERM');
  } catch (_error) { driver.kill(); }
}

let sessionId = null;
let report = null;
let failure = null;
try {
  const ready = Date.now() + 30000;
  for (;;) {
    if (driverExit !== null) throw new Error(`tauri-driver saiu antes de responder: ${driverExit}`);
    const status = await fetch(`${base}/status`).then((response) => response.status).catch(() => 0);
    if (status > 0) break;
    if (Date.now() > ready) throw new Error(`tauri-driver não respondeu em ${base}`);
    await pause(250);
  }

  const session = await webdriver('POST', '/session', driverCapabilities(options.app));
  sessionId = session.sessionId;
  // Espera a página do app sair de about:blank antes de montar o endereço do roteiro.
  let current = null;
  const loaded = Date.now() + 60000;
  while (Date.now() < loaded) {
    current = await webdriver('GET', `/session/${sessionId}/url`).catch(() => null);
    if (appPage(current, process.platform) === current) break;
    await pause(500);
  }
  current = appPage(current, process.platform);
  const target = selftestUrl(current);
  console.log(`[selftest] ${options.app} em ${current}; navegando para ${target}`);
  await webdriver('POST', `/session/${sessionId}/url`, { url: target })
    .catch(() => webdriver('POST', `/session/${sessionId}/execute/sync`, { script: 'window.location.replace(arguments[0]);', args: [target] }));

  const deadline = Date.now() + options.timeoutMs;
  let lastProbe = 0;
  let lastShot = Date.now();
  let shots = 0;
  while (!report && Date.now() < deadline) {
    report = readReport();
    if (!report && shots < MAX_SCREENSHOTS && Date.now() - lastShot >= SCREENSHOT_INTERVAL_MS) {
      lastShot = Date.now();
      shots += 1;
      const image = await webdriver('GET', `/session/${sessionId}/screenshot`).catch(() => null);
      if (image) writeFileSync(join(options.artifacts, `screen-${shots}.png`), Buffer.from(image, 'base64'));
    }
    if (!report && Date.now() - lastProbe > 2000) {
      lastProbe = Date.now();
      // O app sai logo depois de gravar; a leitura pela página cobre uma falha
      // de escrita do arquivo enquanto a sessão ainda existe.
      report = await webdriver('POST', `/session/${sessionId}/execute/sync`, { script: 'return window.__CIALAI_SELFTEST_RESULT__ || null;', args: [] })
        .catch(() => null);
    }
    if (!report) await pause(250);
  }
  if (!report) {
    const progress = await webdriver('POST', `/session/${sessionId}/execute/sync`, { script: 'return window.__CIALAI_SELFTEST_PROGRESS__ || null;', args: [] })
      .catch(() => null);
    if (progress) writeFileSync(join(options.artifacts, 'selftest-progress.json'), `${JSON.stringify(progress, null, 2)}\n`);
    const step = progress?.step ? ` na etapa ${progress.step}` : '';
    throw new Error(`o self test excedeu ${Math.round(options.timeoutMs / 1000)} s${step} sem gravar ${output}`);
  }
} catch (error) {
  failure = error;
} finally {
  if (sessionId) await webdriver('DELETE', `/session/${sessionId}`).catch(() => {});
  stopDriver();
  driverLog.end();
}

if (report) writeFileSync(join(options.artifacts, 'selftest.json'), `${JSON.stringify(report, null, 2)}\n`);
const appLog = join(dirname(output), 'app.log');
if (existsSync(appLog)) copyFileSync(appLog, join(options.artifacts, 'app.log'));

if (failure) {
  console.error(`[selftest] ${failure.message}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
