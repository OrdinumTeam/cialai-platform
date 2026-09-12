// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rust = `${root}/apps/desktop/src-tauri/src`;
const read = (path) => readFileSync(`${rust}/${path}`, 'utf8');

for (const path of [
  'commands.rs',
  'diagnostics.rs',
  'lifecycle.rs',
  'prefs.rs',
  'platform/mod.rs',
  'tunnel/mod.rs',
  'window.rs',
  'bridge/mod.rs',
  'bridge/protocol.rs',
  'workspace/terminal.rs',
  'workspace/files.rs',
  'workspace/browser.rs',
]) {
  assert.ok(existsSync(`${rust}/${path}`), `Modulo Rust extraido ausente: ${path}`);
}

for (const path of ['stack.rs', 'meetings', 'vpn']) {
  assert.ok(!existsSync(`${rust}/${path}`), `Produto removido voltou ao crate: ${path}`);
}

const lib = read('lib.rs');
const commands = read('commands.rs');
const dispatch = read('bridge/dispatch.rs').split('#[cfg(test)]')[0];
const allowlist = read('bridge/protocol.rs')
  .split('pub fn allowed_command')[1]
  .split('#[cfg(test)]')[0];

for (const [name, source] of Object.entries({ lib, commands, dispatch, allowlist })) {
  for (const removed of ['StackManager', 'VpnManager', 'RecorderManager', 'meetings::', 'vpn::']) {
    assert.ok(!source.includes(removed), `${name} ainda referencia ${removed}`);
  }
}
for (const prefix of ['stack_', 'vpn_', 'meetings_']) {
  assert.ok(!allowlist.includes(`"${prefix}`), `Ponte ainda permite ${prefix}*`);
}

assert.match(lib, /MobileSite::resolve\(app\.handle\(\)\)/);
assert.match(lib, /app\.manage\(mobile_site\)/);
assert.match(read('tunnel/mod.rs'), /pub fn mobile_static_dir/);

const prefs = read('prefs.rs').split('#[cfg(test)]')[0];
for (const field of [
  'appearance',
  'terminal',
  'project_roots',
  'dev_browser',
  'window',
  'network',
]) {
  assert.match(prefs, new RegExp(`pub ${field}:`), `Preferencia ausente: ${field}`);
}
for (const field of ['pub repo_dir:', 'pub stop_stack_on_quit:', 'pub meetings:']) {
  assert.ok(!prefs.includes(field), `Preferencia removida voltou: ${field}`);
}

assert.match(read('workspace/terminal.rs'), /TERM_PROGRAM", "Cialai"/);
assert.match(read('workspace/terminal.rs'), /pub shell_flavor: ShellFlavor/);
assert.match(commands, /pub fn app_platform/);
for (const contract of ['PlatformInfo', 'ShellSpec', 'ShellFlavor', 'to_portable', 'default_lang', 'path_prefix']) {
  assert.match(read('platform/mod.rs'), new RegExp(`\\b${contract}\\b`), `Contrato de plataforma ausente: ${contract}`);
}
assert.doesNotMatch(read('workspace/repos.rs'), /REPO_ROOTS_FROM_HOME/);
assert.doesNotMatch(read('workspace/mobile_files.rs'), /REPO_ROOTS_FROM_HOME/);
assert.match(commands, /prefs\.get\(\)\.project_roots/);
assert.match(dispatch, /PrefsState>\(\)\.get\(\)\.project_roots/);
assert.deepEqual(
  JSON.parse(readFileSync(`${root}/apps/desktop/src-tauri/capabilities/default.json`, 'utf8')).windows,
  ['main'],
);

console.log('PASS desktop extraction: studio Rust present; stack, meetings and VPN absent; preferences and PTY bridge reduced');
