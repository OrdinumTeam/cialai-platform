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
for (const section of ['Aparência', 'Terminal', 'Projetos', 'Dev Browser']) {
  assert.match(source, new RegExp(`>${section}<`), `Missing preferences section: ${section}`);
}
for (const field of ['args', 'lang', 'pathPrefix', 'projectRoots', 'chromiumPath']) {
  assert.match(source, new RegExp(field), `Missing preference field: ${field}`);
}
assert.match(source, /chooseDirectory/);
assert.match(source, /chooseFile/);

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
  network: { desktopName: 'Estúdio' },
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
  controlUrl: null,
  userId: null,
  userName: null,
  desktopName: 'Estúdio',
  requireApproval: false,
  keepAwakeWhilePaired: false,
});
assert.equal(original.terminal.shell, '  /bin/fish  ', 'Sanitizing must not mutate the loaded snapshot');

assert.deepEqual(addUniquePath(['/a'], '/a'), ['/a']);
assert.deepEqual(addUniquePath(['/a'], ' /b '), ['/a', '/b']);
assert.deepEqual(removePath(['/a', '/b'], '/a'), ['/b']);

console.log('PASS preferences: four sections, native pickers and normalized snapshots');
