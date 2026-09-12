// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ui = `${root}/packages/ui`;
const source = `${ui}/src`;
const read = (path) => readFileSync(path, 'utf8');

for (const path of [
  'src/desktop/DesktopApp.jsx', 'src/desktop/main.jsx', 'src/mobile/main.jsx',
  'src/lib/platform.js', 'src/terminals/runtime.js', 'src/views/Terminais.jsx', 'src/views/registry.js',
  'scripts/check-terminal-sync.mjs', 'scripts/check-studio-browser.js',
]) assert.ok(existsSync(`${ui}/${path}`), `Missing extracted UI file: ${path}`);

for (const path of [
  'src/AppContext.jsx', 'src/lib/api.js', 'src/lib/query.js', 'src/lib/queries.js',
  'src/lib/meetings.js', 'src/lib/vpn.js', 'src/desktop/StackGate.jsx',
  'src/desktop/StackStatus.jsx', 'src/desktop/RecordingIndicator.jsx',
]) assert.equal(existsSync(`${ui}/${path}`), false, `Removed Control module was copied: ${path}`);

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:js|jsx)$/.test(entry.name)) files.push(path);
  }
}
walk(source);
const combined = files.map((path) => read(path)).join('\n');
for (const pattern of [
  /from\s+['"][^'"]*AppContext/, /from\s+['"][^'"]*lib\/(?:api|query|queries|meetings|vpn)\.js/,
  /\b(?:meetingsActions|stackActions|useStack|StackGate|StackStatus|RecordingIndicator)\b/,
  /chart\.js\/auto/,
]) assert.doesNotMatch(combined, pattern);

const registry = read(`${source}/views/registry.js`);
assert.match(registry, /DEFAULT_VIEW = 'terminais'/);
assert.doesNotMatch(registry, /control|reunioes|fatura|clientes|projetos/);

const runtime = read(`${source}/terminals/runtime.js`);
const layout = read(`${source}/terminals/layout.js`);
const appearance = read(`${source}/desktop/appearance.js`);
for (const [body, current, legacy] of [
  [runtime, 'cialai_terminals', 'oc_terminals'],
  [layout, 'cialai_terminals_layout', 'oc_terminals_layout'],
  [appearance, 'cialai_theme', 'oc_theme'],
]) {
  assert.ok(body.includes(current), `Missing current storage key: ${current}`);
  assert.ok(body.includes(legacy), `Missing one-time migration source: ${legacy}`);
}
assert.match(read(`${source}/lib/shell.js`), /__CIALAI_SHELL__/);
assert.match(read(`${source}/desktop/main.jsx`), /cialai_selftest/);
assert.match(read(`${source}/desktop/main.jsx`), /await initPlatform\(\)/);
assert.match(runtime, /info\.shellFlavor/);
assert.match(runtime, /shellQuote\(path, session\.shellFlavor\)/);
assert.match(read(`${source}/desktop/Sidebar.jsx`), /cialai_groups_closed/);

const manifest = JSON.parse(read(`${ui}/package.json`));
assert.equal(manifest.dependencies['chart.js'], undefined);
assert.match(manifest.dependencies.xlsx, /xlsx-0\.20\.3\.tgz$/);
console.log(`PASS UI extraction: ${files.length} source files, terminal-only registry, removed Control modules absent, migrations present`);
