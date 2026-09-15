// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addUniquePath,
  normalizePreferenceDraft,
  removePath,
  sanitizePreferences,
} from '../src/desktop/preferences-model.js';

const source = readFileSync(fileURLToPath(new URL('../src/desktop/Preferences.jsx', import.meta.url)), 'utf8');
const updater = readFileSync(fileURLToPath(new URL('../src/desktop/Updater.jsx', import.meta.url)), 'utf8');
for (const section of ['appearance', 'terminal', 'projects', 'network', 'updates']) {
  assert.match(source, new RegExp(`desktop\\.preferences\\.${section}`), `Missing translated preferences section: ${section}`);
}
assert.match(source, />Dev Browser</, 'Missing Dev Browser section');
for (const field of ['args', 'lang', 'pathPrefix', 'projectRoots', 'chromiumPath']) {
  assert.match(source, new RegExp(field), `Missing preference field: ${field}`);
}
assert.match(source, /chooseDirectory/);
assert.match(source, /chooseFile/);
assert.match(source, /<Updater \/>/);
assert.match(source, /LANGUAGE_OPTIONS/);
assert.match(source, /language\.label/);
assert.match(source, /setLocale/);
assert.match(updater, /@tauri-apps\/plugin-updater/);
assert.match(updater, /downloadAndInstall/);
assert.match(updater, /@tauri-apps\/plugin-process/);

const original = {
  appearance: 'neon',
  terminal: {
    shell: '  /bin/fish  ',
    args: [' -l ', '', '-C'],
    lang: ' pt_BR.UTF-8 ',
    pathPrefix: [' /opt/bin ', '/opt/bin', ''],
  },
  projectRoots: [' ~/Projects ', '~/Projects', ' /work '],
  devBrowser: { chromiumPath: '  /Applications/Chromium.app/Contents/MacOS/Chromium  ' },
  window: { backdrop: 'auto' },
  network: { desktopName: ' Estúdio ', controlUrl: 'https://headscale.exemplo.com', userId: '42', userName: 'alice' },
};
const normalized = normalizePreferenceDraft(original);
const sanitized = sanitizePreferences(normalized);
assert.equal(sanitized.appearance, 'system');
assert.deepEqual(sanitized.terminal, {
  shell: '/bin/fish',
  args: ['-l', '-C'],
  lang: 'pt_BR.UTF-8',
  pathPrefix: ['/opt/bin'],
});
assert.deepEqual(sanitized.projectRoots, ['~/Projects', '/work']);
assert.equal(sanitized.devBrowser.chromiumPath, '/Applications/Chromium.app/Contents/MacOS/Chromium');
assert.deepEqual(sanitized.network, {
  desktopName: 'Estúdio',
  requireApproval: false,
  keepAwakeWhilePaired: false,
});
assert.deepEqual(Object.keys(normalized.network), ['desktopName', 'requireApproval', 'keepAwakeWhilePaired'], 'Headscale fields leave the draft');
assert.equal(normalized.network.desktopName, ' Estúdio ', 'The draft keeps what is being typed');
assert.equal(sanitizePreferences({ network: { desktopName: '   ' } }).network.desktopName, null, 'Empty name falls back to the computer name in Rust');
assert.match(source, /<AccessPanel /, 'Preferences show the access panel');
assert.doesNotMatch(source, /NetworkSetup|controlUrl|apiKey/, 'Preferences have no server fields');
assert.match(source, /tunnel\.applyNetworkPreferences\(normalized\.network\)/, 'Saved name and approval reach net.start');
assert.equal(original.terminal.shell, '  /bin/fish  ', 'Sanitizing must not mutate the loaded snapshot');

assert.deepEqual(addUniquePath(['/a'], '/a'), ['/a']);
assert.deepEqual(addUniquePath(['/a'], ' /b '), ['/a', '/b']);
assert.deepEqual(removePath(['/a', '/b'], '/a'), ['/b']);

console.log('PASS preferences: six sections, signed updater, phone access panel, native pickers and normalized snapshots');
