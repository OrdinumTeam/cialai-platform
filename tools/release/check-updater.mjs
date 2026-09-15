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
// O espelho no site atende quando o GitHub não entrega a release; o manifesto espelhado aponta para os mesmos arquivos assinados.
assert.deepEqual(config.plugins?.updater?.endpoints, [
  'https://github.com/Cialai/cialai/releases/latest/download/latest.json',
  'https://cialai.com.br/downloads/latest.json',
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

// The config holds the base64 of a minisign public key file: an untrusted comment and a line with
// the Ed25519 algorithm tag, the eight byte key id and the 32 byte public key.
export function parseUpdaterPublicKey(value) {
  const text = Buffer.from(value.trim(), 'base64').toString('utf8');
  const lines = text.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, 'The updater public key must have a comment and a key line');
  const comment = lines[0].match(/^untrusted comment: minisign public key: ([0-9A-F]{16})$/);
  assert.ok(comment, 'The updater key must be a minisign public key, never the private key');
  const raw = Buffer.from(lines[1], 'base64');
  assert.equal(raw.length, 42, 'The updater public key line must decode to 42 bytes');
  assert.equal(raw.subarray(0, 2).toString('latin1'), 'Ed', 'The updater public key must use Ed25519');
  const keyId = Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
  assert.equal(keyId, comment[1], 'The updater key id must match its comment');
  return { keyId };
}

const pubkey = config.plugins.updater.pubkey;
if (pubkey !== placeholder) parseUpdaterPublicKey(pubkey);

if (process.argv.includes('--release')) {
  assert.notEqual(pubkey, placeholder, 'Fill the Tauri updater public key before releasing');
  assert.ok(pubkey.trim(), 'The Tauri updater public key cannot be empty');
}

console.log(pubkey === placeholder
  ? 'PASS updater prepared: replace the public key before a release'
  : `PASS updater ready: public key ${parseUpdaterPublicKey(pubkey).keyId} configured`);
