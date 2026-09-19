// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  'window/mod.rs',
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

// Todo comando liberado na ponte precisa ter braço no despacho e nível na
// política do celular: liberar sem despachar devolve desktopOnly, e despachar
// sem nível reprova fechado antes de qualquer autorização.
const allowed = [...allowlist.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
assert.ok(allowed.length >= 14, `lista de comandos da ponte parece incompleta: ${allowed.length}`);
const { REMOTE_COMMANDS } = await import(pathToFileURL(`${root}packages/protocol/sensitive.js`).href);
for (const command of allowed) {
  assert.match(dispatch, new RegExp(`"${command}"`), `Ponte libera ${command} sem braço no despacho`);
  assert.ok(REMOTE_COMMANDS.includes(command), `Ponte libera ${command} sem nível em sensitive.js`);
}
for (const command of REMOTE_COMMANDS) {
  assert.ok(allowed.includes(command), `sensitive.js dá nível a ${command}, que a ponte não libera`);
}

// A rede sobe numa função só, e a falha de qualquer peça vira registro e
// estado em vez de derrubar o `setup` com um `panic` que ninguém vê.
assert.match(lib, /fn start_network\(app: &tauri::AppHandle, awake: tunnel::Awake\) -> Result<Network, String>/);
assert.match(lib, /MobileSite::resolve\(app\)\?/);
assert.match(
  lib,
  /Supervisor::for_app\(app, &site, bridge_session, bridge_control, awake\)\?/,
);
assert.match(lib, /app\.manage\(network\.site\)/);
assert.match(lib, /app\.manage\(network\.supervisor\)/);
assert.match(lib, /diagnostics::note\(&format!\("\[rede\] indisponivel: \{reason\}"\)\)/);
const setup = lib.slice(lib.indexOf('.setup(|app|'), lib.indexOf('.build(tauri::generate_context!())'));
assert.doesNotMatch(setup, /map_err\(std::io::Error::other\)\?/, 'nenhuma peça da rede pode derrubar o setup');
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
