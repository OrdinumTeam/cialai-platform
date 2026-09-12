// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function reportPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'br.com.ordinum.cialai', 'selftest.json');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'br.com.ordinum.cialai', 'logs', 'selftest.json');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'br.com.ordinum.cialai', 'logs', 'selftest.json');
}

const output = reportPath();
if (existsSync(output)) unlinkSync(output);

const child = spawn('npm', [
  'run', 'dev', '--workspace', '@cialai/desktop', '--',
  '--config', 'src-tauri/tauri.selftest.conf.json',
], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const started = Date.now();
const timeoutMs = 180000;
let exited = false;
let exitCode = null;
child.on('exit', (code) => { exited = true; exitCode = code; });

function stop() {
  if (exited) return;
  try {
    if (process.platform === 'win32') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch (_error) { child.kill('SIGINT'); }
}

let report;
while (Date.now() - started < timeoutMs) {
  if (existsSync(output)) {
    try {
      report = JSON.parse(readFileSync(output, 'utf8'));
      break;
    } catch (_error) { /* writer may still be flushing */ }
  }
  if (exited) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (!report) {
  stop();
  throw new Error(exited
    ? `Cialai exited with code ${exitCode} before writing ${output}`
    : `Cialai selftest exceeded ${Math.round(timeoutMs / 1000)} seconds without writing ${output}`);
}

stop();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
