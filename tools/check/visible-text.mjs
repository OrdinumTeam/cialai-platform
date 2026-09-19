// SPDX-License-Identifier: Apache-2.0
// Texto visível sem parênteses e sem hífen isolado, meia-risca ou travessão como separador,
// nos três idiomas da interface, nas páginas das lojas, nas políticas e nas notas de release.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

const FORBIDDEN = [
  [/[()]/, 'parênteses'],
  [/ - /, 'hífen isolado como separador'],
  [/[–—]/, 'meia-risca ou travessão'],
];

export function separatorProblems(text) {
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

// Markdown e HTML visíveis sem código, destinos de links, URLs e marcação.
export function proseOf(source) {
  return source
    // Folha de estilo e script não são texto visível. As linhas viram espaços
    // em vez de sumir, para o número da linha continuar apontando o lugar certo.
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, ' ');
}

// Contrato do próprio check.
assert.deepEqual(separatorProblems('Vincular celular'), []);
assert.deepEqual(separatorProblems('Sign-up e X-Cialai'), []);
assert.deepEqual(proseOf('<style>\n#root:not(:empty){display:none}\n</style>\nCialai').split('\n').map((line) => line.trim()), ['', '', '', 'Cialai']);
assert.deepEqual(separatorProblems('Cialai (prévia)'), ['parênteses']);
assert.deepEqual(separatorProblems('Cialai - prévia'), ['hífen isolado como separador']);
assert.deepEqual(separatorProblems('Cialai — prévia'), ['meia-risca ou travessão']);
assert.equal(proseOf('Veja [o guia](https://x.dev/guia) e `f(x)`'), 'Veja [o guia] e ');

const problems = [];
const { dictionaries } = await import(pathToFileURL(`${root}packages/i18n/src/locales/index.js`).href);
let keys = 0;
for (const [locale, dictionary] of Object.entries(dictionaries)) {
  for (const [key, value] of Object.entries(dictionary)) {
    if (typeof value !== 'string') continue;
    keys += 1;
    for (const label of separatorProblems(value)) problems.push(`${locale} ${key}: ${label}`);
  }
}

const native = JSON.parse(read('apps/desktop/src-tauri/i18n/native.json'));
assert.ok(native.locales && Object.keys(native.locales).length === 3, 'native catalog must carry three locales');
for (const [locale, entries] of Object.entries(native.locales)) {
  if (!entries || typeof entries !== 'object') continue;
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') continue;
    for (const label of separatorProblems(value)) problems.push(`native ${locale} ${key}: ${label}`);
  }
}

const documents = [
  'apps/desktop/index.html',
  'apps/desktop/mobile.html',
  'docs/stores/listing-en.md',
  'docs/stores/listing-pt-BR.md',
  'docs/legal/privacy-policy-en.md',
  'docs/legal/privacy-policy-pt-BR.md',
  'tools/release/notes/preview.md',
  'tools/release/notes/stable.md',
  'docs/testes/roteiro-conectividade.md',
  'docs/testes/roteiro-windows.md',
];
for (const path of documents) {
  proseOf(read(path)).split('\n').forEach((line, index) => {
    for (const label of separatorProblems(line)) problems.push(`${path}:${index + 1}: ${label}`);
  });
}

assert.ok(keys > 900, `dictionaries look incomplete: ${keys} strings`);
assert.deepEqual(problems, [], `Visible text breaks the separator rule:\n${problems.join('\n')}`);
console.log(`PASS visible text: ${keys} interface strings in ${Object.keys(dictionaries).length} languages and ${documents.length} public documents without parentheses or dash separators`);
