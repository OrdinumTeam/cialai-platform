// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ui = `${root}packages/ui/src`;
const read = (path) => readFileSync(`${ui}/${path}`, 'utf8');
const SHELL = ':is([data-shell="desktop"],[data-platform="macos"])';
const BARE_MAC = /\[data-platform="macos"\]/g;
const bareMac = (source) => { const stripped = source.replaceAll(SHELL, ''); return [...stripped.matchAll(BARE_MAC)].map((match) => stripped.slice(match.index, stripped.indexOf('{', match.index)).trim()); };

// shell.css é a camada da casca em qualquer sistema. O escopo amplo mantém a
// fixture do celular, que marca data-platform="macos", com o mesmo resultado.
assert.ok(existsSync(`${ui}/desktop/shell.css`), 'shell.css ausente');
const shell = read('desktop/shell.css');
assert.ok(shell.includes(`${SHELL}{\n  --mac-font:`), 'tokens da casca devem valer para data-shell="desktop"');
const bare = bareMac(shell);
assert.deepEqual(bare, [
  '[data-platform="macos"] body',
  '[data-platform="macos"] .mac-sidebar__drag',
  '[data-platform="macos"] .mac-toolbar.is-sidebar-hidden',
], 'somente semáforos e suavização de fonte ficam restritos ao macOS');
assert.match(shell, /\[data-platform="macos"\] body\{-webkit-font-smoothing:antialiased\}/);
assert.doesNotMatch(shell.replace(/\[data-platform="macos"\] body\{-webkit-font-smoothing:antialiased\}/, ''), /font-smoothing/, 'suavização de fonte só no macOS');

// macos.css permanece só como entrada de compatibilidade da página do celular.
assert.equal(read('desktop/macos.css').replace(/\/\*[\s\S]*?\*\//g, '').trim(), "@import './shell.css';");
const main = read('desktop/main.jsx');
assert.ok(main.indexOf("import './shell.css';") > 0 && main.indexOf("import './shell.css';") < main.indexOf("import './platform.css';"), 'desktop importa shell.css antes de platform.css');
assert.ok(!main.includes("import './macos.css';"));

const terminals = read('views/Terminais.css');
assert.deepEqual(bareMac(terminals), [], 'Terminais.css não pode depender só do macOS');
assert.ok(terminals.includes(`${SHELL} .mac-content:has(> .terminais-page)`));

// Fontes por sistema, com a JetBrains Mono empacotada como último recurso do
// terminal no Linux.
const platform = read('desktop/platform.css');
const tokens = (os) => {
  const block = platform.match(new RegExp(`\\[data-shell="desktop"\\]\\[data-platform="${os}"\\]\\{([^}]*)\\}`));
  assert.ok(block, `bloco de fontes ausente para ${os}`);
  return Object.fromEntries([...block[1].matchAll(/(--mac-font(?:-mono)?):([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
};
assert.deepEqual(tokens('macos'), {
  '--mac-font': '-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif',
  '--mac-font-mono': '"SF Mono",SFMono-Regular,ui-monospace,Menlo,monospace',
});
assert.deepEqual(tokens('windows'), {
  '--mac-font': '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif',
  '--mac-font-mono': '"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,monospace',
});
assert.deepEqual(tokens('linux'), {
  '--mac-font': 'system-ui,"Inter",Cantarell,Ubuntu,"Noto Sans",sans-serif',
  '--mac-font-mono': 'ui-monospace,"JetBrains Mono","Fira Code","DejaVu Sans Mono","Noto Sans Mono","Cialai JetBrains Mono",monospace',
});
for (const [weight, file] of [['400', 'JetBrainsMono-Regular.woff2'], ['700', 'JetBrainsMono-Bold.woff2']]) {
  assert.match(platform, new RegExp(`@font-face\\{font-family:"Cialai JetBrains Mono";font-style:normal;font-weight:${weight};font-display:swap;src:url\\("\\.\\./fonts/${file.replace('.', '\\.')}"\\) format\\("woff2"\\)\\}`));
  const bytes = readFileSync(`${ui}/fonts/${file}`);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${file} não é WOFF2`);
}
assert.match(readFileSync(`${ui}/fonts/OFL.txt`, 'utf8'), /JetBrains Mono Project Authors[\s\S]*SIL Open Font License, Version 1\.1/);

// Interruptor estilizado, sem o atributo switch exclusivo do WebKit do macOS.
assert.doesNotMatch(shell, /\[switch\]/);
for (const rule of ['input[type=checkbox].mac-switch{', 'input[type=checkbox].mac-switch::after{', 'input[type=checkbox].mac-switch:checked{', 'input[type=checkbox].mac-switch:checked::after{']) {
  assert.ok(shell.includes(`${SHELL} ${rule}`), `regra do .mac-switch ausente: ${rule}`);
}
assert.ok(shell.includes(`${SHELL} input[type=checkbox]:not(.mac-switch){`));

// MUI segue o mesmo token de fonte da casca.
assert.match(read('desktop/theme.macos.js'), /fontFamily: 'var\(--mac-font\)'/);

console.log('PASS platform css: desktop shell tokens on every system, macOS-only chrome, per-system fonts, bundled JetBrains Mono and .mac-switch');
