// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const config = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
const cargo = read('apps/desktop/src-tauri/Cargo.toml');
const rust = read('apps/desktop/src-tauri/src/lib.rs');
const capability = JSON.parse(read('apps/desktop/src-tauri/capabilities/default.json'));
const ui = read('packages/ui/src/desktop/Updater.jsx');
const workflow = read('.github/workflows/release.yml');
const placeholder = 'REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY';

assert.equal(config.bundle.createUpdaterArtifacts, true);
assert.deepEqual(config.plugins?.updater?.endpoints, [
  'https://github.com/Cialai/cialai/releases/latest/download/latest.json',
]);
assert.equal(typeof config.plugins?.updater?.pubkey, 'string');
assert.match(cargo, /^tauri-plugin-updater = /m);
assert.match(cargo, /^tauri-plugin-process = /m);
assert.match(rust, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
assert.match(rust, /tauri_plugin_process::init\(\)/);
assert.ok(capability.permissions.includes('updater:default'));
assert.ok(capability.permissions.includes('process:allow-restart'));
assert.match(ui, /downloadAndInstall/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);

if (process.argv.includes('--release')) {
  assert.notEqual(config.plugins.updater.pubkey, placeholder, 'Fill the Tauri updater public key before releasing');
  assert.ok(config.plugins.updater.pubkey.trim(), 'The Tauri updater public key cannot be empty');
}

console.log(config.plugins.updater.pubkey === placeholder
  ? 'PASS updater prepared: replace the public key before a release'
  : 'PASS updater ready: public key configured');
