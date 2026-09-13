// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bridgeEnv, freePort, reportPath, targetDirProblem } from './common.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const targetProblem = targetDirProblem(process.env.CARGO_TARGET_DIR);
if (targetProblem) throw new Error(targetProblem);

const output = reportPath({ platform: process.platform, env: process.env, home: homedir() });
if (existsSync(output)) unlinkSync(output);
const env = bridgeEnv(process.env, await freePort());

const child = spawn('npm', [
  'run', 'dev', '--workspace', '@cialai/desktop', '--',
  '--config', 'src-tauri/tauri.selftest.conf.json',
], {
  cwd: root,
  env,
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
