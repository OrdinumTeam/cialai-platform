// SPDX-License-Identifier: Apache-2.0
// Confere os textos nativos do desktop: o catálogo embutido pelo Rust precisa
// ser o gerado de @cialai/i18n, toda chave usada no Rust precisa existir e as
// chamadas precisam passar exatamente os placeholders de cada texto.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dictionaries } from '@cialai/i18n';
import { CATALOG_PATH, NATIVE_PREFIX, renderCatalog } from '../i18n/native-catalog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.join(root, 'apps/desktop/src-tauri/src');
const placeholders = (value) => [...new Set([...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]))].sort();

function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(full);
    return entry.name.endsWith('.rs') ? [full] : [];
  });
}

export function inspectRust(source, file, catalog = dictionaries['pt-BR']) {
  const errors = [];
  const line = (index) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(/"(native\.[A-Za-z0-9_.]+)"/g)) {
    if (!(match[1] in catalog)) errors.push(`${file}:${line(match.index)}: chave nativa desconhecida: ${match[1]}`);
  }
  const calls = /\b(?:t|tf|translate)\(\s*(?:[A-Za-z_][\w.()]*\s*,\s*)?"(native\.[A-Za-z0-9_.]+)"\s*(?:,\s*&\[([\s\S]*?)\]\s*,?\s*)?\)/g;
  for (const match of source.matchAll(calls)) {
    const [, key, values = ''] = match;
    if (!(key in catalog)) continue;
    const provided = [...values.matchAll(/\(\s*"([A-Za-z][A-Za-z0-9]*)"\s*,/g)].map((value) => value[1]).sort();
    const expected = placeholders(catalog[key]);
    if (provided.join('|') !== expected.join('|')) {
      errors.push(`${file}:${line(match.index)}: ${key} espera ${expected.join(', ') || 'nenhum valor'} e recebeu ${provided.join(', ') || 'nenhum valor'}`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assert.equal(readFileSync(path.join(root, CATALOG_PATH), 'utf8'), renderCatalog(), `${CATALOG_PATH} diverge de packages/i18n; rode npm run i18n:native`);

  assert.deepEqual(inspectRust('t("native.menu.quit"); tf("native.error.exists", &[("name", &name)]);', 'fixture.rs'), []);
  assert.deepEqual(inspectRust('tf("native.error.exists", &[("path", &name)]);', 'fixture.rs'), ['fixture.rs:1: native.error.exists espera name e recebeu path']);
  assert.deepEqual(inspectRust('translate(locale, "native.quit.openMany", &[]);', 'fixture.rs'), ['fixture.rs:1: native.quit.openMany espera count e recebeu nenhum valor']);
  assert.deepEqual(inspectRust('t("native.missing");', 'fixture.rs'), ['fixture.rs:1: chave nativa desconhecida: native.missing']);

  // O idioma escolhido na interface chega ao Rust e sobrevive à reabertura; o
  // menu de início substitui o padrão em inglês do Tauri e a menubar da
  // interface usa as mesmas chaves quando o idioma muda.
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const lib = read('apps/desktop/src-tauri/src/lib.rs');
  assert.match(lib, /\.enable_macos_default_menu\(false\)/);
  assert.match(lib, /i18n::restore\(&config\)/);
  assert.match(lib, /#\[cfg\(target_os = "macos"\)\]\s*menu::install\(app\.handle\(\)\)\?;/);
  assert.match(lib, /commands::app_set_locale,/);
  assert.match(read('apps/desktop/src-tauri/src/commands.rs'), /pub fn app_set_locale\(app: AppHandle, locale: String\) -> String/);
  assert.match(read('apps/desktop/src-tauri/src/lifecycle.rs'), /\.title\(t\("native\.quit\.title"\)\)/);
  assert.match(read('packages/ui/src/desktop/DesktopApp.jsx'), /invoke\('app_set_locale', \{ locale \}\)/);
  const jsMenu = read('packages/ui/src/desktop/menu.js');
  assert.doesNotMatch(jsMenu, /desktop\.menu\./);
  assert.match(jsMenu, /translate\('native\.menu\.quit'\)/);

  const files = rustFiles(sourceRoot);
  const errors = files.flatMap((file) => inspectRust(readFileSync(file, 'utf8'), path.relative(root, file)));
  assert.deepEqual(errors, []);
  const used = new Set(files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/"(native\.[A-Za-z0-9_.]+)"/g)].map((match) => match[1])));
  const nativeKeys = Object.keys(dictionaries['pt-BR']).filter((key) => key.startsWith(NATIVE_PREFIX));
  console.log(`PASS native i18n: catálogo atualizado, ${nativeKeys.length} chaves nos três idiomas, ${used.size} usadas pelo Rust em ${files.length} arquivos`);
}
