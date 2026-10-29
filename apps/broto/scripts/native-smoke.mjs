// SPDX-License-Identifier: Apache-2.0
// Runs the native WebView against a real isolated daemon without pairing.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const daemonBinary = process.env.CIALAI_BROTO_SELFTEST_DAEMON;
const monitorBinary = process.env.CIALAI_BROTO_SELFTEST_MONITOR;
if (!daemonBinary || !monitorBinary) throw Error('Set CIALAI_BROTO_SELFTEST_DAEMON and CIALAI_BROTO_SELFTEST_MONITOR to the built binaries');
const profile = await mkdtemp(join(process.env.CIALAI_BROTO_SELFTEST_OUTPUT || tmpdir(), 'broto-native-'));
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\cialai-broto-selftest-${randomUUID()}` : join(profile, 'control.sock');
const resultFile = join(profile, 'native-result.json');
const expectPairingError = process.argv.includes('--expect-pairing-error');
const env = { ...process.env, CIALAI_BROTO_SOCKET: socket, CIALAI_BROTO_SELFTEST_RESULT: resultFile };
if (expectPairingError) env.CIALAI_BROTO_SELFTEST_PAIRING_FILE = join(profile, 'missing-pairing.code');
const daemon = spawn(daemonBinary, ['serve', '--state-dir', join(profile, 'state'), '--stun', ''], { env, stdio: 'ignore', windowsHide: true });
let monitor;
let daemonError;
daemon.on('error', error => { daemonError = error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function completion(child, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Native smoke process timed out')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Native smoke process exited ${code}`)); });
  });
}
async function status() {
  const child = spawn(daemonBinary, ['status', '--state-dir', join(profile, 'state')], { env, windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await completion(child, 5000);
  return JSON.parse(output);
}
try {
  const deadline = Date.now() + 20000;
  while (true) {
    try { if ((await status()).state === 'disconnected') break; } catch { /* service startup */ }
    if (Date.now() > deadline || daemonError || daemon.exitCode !== null) throw Error('Isolated daemon failed to start');
    await pause(100);
  }
  monitor = spawn(monitorBinary, [], { env, stdio: 'ignore', windowsHide: false });
  await completion(monitor, 45000);
  const report = JSON.parse(await readFile(resultFile, 'utf8'));
  report.serviceSurvivedWindowExit = daemon.exitCode === null && (await status()).state === 'disconnected';
  report.platform = process.platform;
  report.processExitedNaturally = true;
  report.expectedPairingError = expectPairingError;
  const validResult = expectPairingError ? !report.passed && report.error?.includes('selftest_pairing_unavailable') : report.passed;
  if (!validResult || !report.serviceSurvivedWindowExit) throw Error('Native monitor or service survival check failed');
  await writeFile(join(profile, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ profile, ...report }));
} finally {
  if (monitor?.exitCode === null) monitor.kill();
  if (daemon.exitCode === null) daemon.kill();
}
