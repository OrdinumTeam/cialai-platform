// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGETS, binaryName } from '../build-tunnel.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

const triples = Object.keys(TARGETS);
assert.deepEqual(triples, [
  'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc',
]);
assert.equal(binaryName('x86_64-pc-windows-msvc'), 'cialai-tunnel-x86_64-pc-windows-msvc.exe');
assert.equal(binaryName('aarch64-apple-darwin'), 'cialai-tunnel-aarch64-apple-darwin');

const tauri = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
assert.deepEqual(tauri.bundle.externalBin, ['binaries/cialai-tunnel']);
assert.match(read('apps/desktop/src-tauri/src/tunnel/supervisor.rs'), /"cialai-tunnel"/);
assert.match(read('.gitignore'), /^apps\/desktop\/src-tauri\/binaries\/$/m);

const release = read('.github/workflows/release.yml');
assert.match(release, /tags: \["v\*"\]/);
for (const triple of triples) {
  assert.match(release, new RegExp(`--target ${triple}\\b`), `release.yml does not build ${triple}`);
}
const desktopTargets = [...release.matchAll(/^\s+target: ([a-z0-9_-]+)$/gm)].map((match) => match[1]);
assert.deepEqual(desktopTargets, ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']);
assert.match(release, /--verify --target \$\{\{ matrix\.target \}\}/);
assert.match(release, /tauri-apps\/tauri-action@v0/);
assert.match(release, /releaseDraft: true/);
assert.match(release, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(release, /check-updater\.mjs --release/);

const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
assert.match(desktopPackage.scripts.dev, /^npm run sidecar && /);
assert.match(desktopPackage.scripts.build, /^npm run sidecar && /);
assert.equal(desktopPackage.scripts.sidecar, 'node ../../tools/build-tunnel.mjs --local');

console.log('PASS release sidecar: five Go targets, Tauri externalBin, checksum verification and signed updater release');
