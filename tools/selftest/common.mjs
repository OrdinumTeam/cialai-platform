// SPDX-License-Identifier: Apache-2.0
// Contratos compartilhados pelos runners do self test: onde o app grava o
// relatório, onde o Cargo deixa o binário de depuração e como o WebDriver abre
// o roteiro dentro do binário real.

import { createServer } from 'node:net';
import path from 'node:path';

const IDENTIFIER = 'br.com.ordinum.cialai';
export const DRIVER_PORT = 4444;
export const DEFAULT_TIMEOUT_SECONDS = 300;
// Capturas da janela durante o roteiro, anexadas como evidência do nightly.
export const SCREENSHOT_INTERVAL_MS = 3000;
export const MAX_SCREENSHOTS = 8;

// Mesmo diretório de `app_log_dir` do Tauri em cada sistema.
export function reportPath({ platform, env, home }) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Logs', IDENTIFIER, 'selftest.json');
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), IDENTIFIER, 'logs', 'selftest.json');
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), IDENTIFIER, 'logs', 'selftest.json');
}

// A ponte do app escuta em 3720 por padrão, a mesma porta de um Cialai ou
// Control já aberto na máquina. O self test usa uma porta livre própria, salvo
// quando CIALAI_BRIDGE_PORT já foi definida.
export function bridgeEnv(env, port) {
  return env.CIALAI_BRIDGE_PORT ? { ...env } : { ...env, CIALAI_BRIDGE_PORT: String(port) };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Fora do bundle, o Tauri só encontra os recursos quando o executável fica em
// target/<perfil> ou target/<triplo>/<perfil>; em outra pasta o app aborta no
// setup por não achar a página do celular.
export function targetDirProblem(targetDir) {
  if (!targetDir) return '';
  const name = path.basename(String(targetDir).replace(/[\\/]+$/, ''));
  return name === 'target'
    ? ''
    : `CARGO_TARGET_DIR precisa terminar em uma pasta chamada target para o Tauri achar os recursos; recebido ${targetDir}`;
}

export function appBinary(platform, targetDir) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(targetDir, 'debug', platform === 'win32' ? 'cialai-desktop.exe' : 'cialai-desktop');
}

// O binário abre a interface empacotada; o roteiro só carrega com o
// parâmetro, então o runner navega para a mesma origem com ele.
export function selftestUrl(current) {
  const url = new URL(current);
  url.searchParams.set('cialai_selftest', '1');
  url.searchParams.set('onboarding', 'skip');
  url.searchParams.set('motion', '0');
  url.hash = 'terminais';
  return url.toString();
}

export function driverCapabilities(application) {
  return { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application } } } };
}

export function parseDriverArgs(argv, { root, platform, env }) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const targetDir = env.CARGO_TARGET_DIR || path.join(root, 'apps', 'desktop', 'src-tauri', 'target');
  const port = Number(value('--port') || DRIVER_PORT);
  const nativeDriver = value('--native-driver');
  return {
    app: value('--app') || appBinary(platform, targetDir),
    artifacts: path.resolve(root, value('--artifacts') || path.join('target', 'selftest')),
    timeoutMs: Number(value('--timeout') || DEFAULT_TIMEOUT_SECONDS) * 1000,
    port,
    driver: value('--driver') || env.TAURI_DRIVER || 'tauri-driver',
    driverArgs: ['--port', String(port), ...(nativeDriver ? ['--native-driver', nativeDriver] : [])],
  };
}
