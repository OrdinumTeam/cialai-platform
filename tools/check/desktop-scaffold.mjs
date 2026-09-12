// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = `${root}/apps/desktop`;
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const common = json(`${desktop}/src-tauri/tauri.conf.json`);

assert.equal(common.productName, 'Cialai');
assert.equal(common.identifier, 'br.com.ordinum.cialai');
assert.equal(common.build.devUrl, 'http://127.0.0.1:1420');
assert.equal(common.build.frontendDist, '../dist');
assert.match(common.build.beforeDevCommand, /build:mobile-resource/);
assert.equal(common.bundle.resources['resources/mobile/'], 'mobile/');
assert.deepEqual(Object.keys(common.app.security.csp).sort(), [
  'connect-src', 'default-src', 'font-src', 'frame-src', 'img-src',
  'script-src', 'style-src', 'worker-src',
]);

const platforms = {
  macos: { transparent: true, decorations: undefined, targets: ['app', 'dmg'] },
  windows: { transparent: true, decorations: false, targets: ['nsis', 'msi'] },
  linux: { transparent: false, decorations: true, targets: ['appimage', 'deb', 'rpm'] },
};
for (const [name, expected] of Object.entries(platforms)) {
  const config = json(`${desktop}/src-tauri/tauri.${name}.conf.json`);
  const [window] = config.app.windows;
  assert.equal(window.label, 'main', name);
  assert.equal(window.transparent, expected.transparent, name);
  assert.equal(window.decorations, expected.decorations, name);
  assert.deepEqual(config.bundle.targets, expected.targets, name);
}

for (const path of [
  'index.html', 'mobile.html', 'vite.config.js', 'src/desktop.jsx', 'src/mobile.jsx',
  'src-tauri/build.rs', 'src-tauri/src/main.rs', 'src-tauri/src/lib.rs',
  'src-tauri/capabilities/default.json', 'src-tauri/icons/icon.icns',
  'src-tauri/icons/icon.ico', 'src-tauri/icons/icon.png',
]) assert.ok(existsSync(`${desktop}/${path}`), `Missing desktop scaffold file: ${path}`);

assert.match(readFileSync(`${desktop}/index.html`, 'utf8'), /src="\.\/src\/desktop\.jsx"/);
assert.match(readFileSync(`${desktop}/mobile.html`, 'utf8'), /src="\.\/src\/mobile\.jsx"/);

const capability = json(`${desktop}/src-tauri/capabilities/default.json`);
assert.deepEqual(capability.windows, ['main']);
assert.ok(capability.permissions.includes('core:default'));
console.log('PASS desktop scaffold: two Vite entries, three platform configs, capabilities and provisional icons');
