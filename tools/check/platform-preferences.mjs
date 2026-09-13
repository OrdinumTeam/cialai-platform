// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const model = await import(pathToFileURL(`${root}packages/ui/src/desktop/preferences-model.js`).href);
const { BACKDROPS, normalizePreferenceDraft, platformPreferenceHints, sanitizePreferences } = model;

// Fundo da janela: só automático, com Mica quando o Windows permite, ou sólido.
assert.deepEqual(BACKDROPS, ['auto', 'solid']);
assert.equal(normalizePreferenceDraft({ window: { backdrop: 'solid' } }).window.backdrop, 'solid');
assert.equal(normalizePreferenceDraft({ window: { backdrop: 'acrylic' } }).window.backdrop, 'auto');
assert.equal(sanitizePreferences({ window: { backdrop: 42 } }).window.backdrop, 'auto');

// Opções e caminhos que mudam por sistema, com o padrão do Rust em cada um.
const mac = platformPreferenceHints('macos', 'posix');
assert.equal(mac.shellPlaceholder, '/bin/zsh');
assert.equal(mac.argsPlaceholder, '-l');
assert.equal(mac.showLang, true);
assert.equal(mac.pathPrefixPlaceholder, '/opt/homebrew/bin');
assert.match(mac.pathPrefixDescription, /\/opt\/homebrew\/bin e \/usr\/local\/bin/);
assert.equal(mac.chromiumPlaceholder, '/Applications/Chromium.app/Contents/MacOS/Chromium');
assert.deepEqual(mac.chromiumFilters, []);
assert.equal(mac.windowSection, false);
assert.equal(mac.revealLabel, 'Mostrar no Finder');
assert.deepEqual(mac.paths, {
  preferences: '~/Library/Application Support/br.com.ordinum.cialai/preferences.json',
  data: '~/Library/Application Support/br.com.ordinum.cialai',
  logs: '~/Library/Logs/br.com.ordinum.cialai',
});

const linux = platformPreferenceHints('linux', 'posix');
assert.equal(linux.shellPlaceholder, '/bin/bash');
assert.equal(linux.showLang, true);
assert.equal(linux.langPlaceholder, 'C.UTF-8');
assert.equal(linux.pathPrefixPlaceholder, '~/.local/bin');
assert.equal(linux.chromiumPlaceholder, '/usr/bin/chromium');
assert.equal(linux.windowSection, false);
assert.equal(linux.revealLabel, 'Mostrar em Arquivos');
assert.deepEqual(linux.paths, {
  preferences: '~/.config/br.com.ordinum.cialai/preferences.json',
  data: '~/.local/share/br.com.ordinum.cialai',
  logs: '~/.local/share/br.com.ordinum.cialai/logs',
});

const windows = platformPreferenceHints('windows', 'powershell');
assert.equal(windows.shellPlaceholder, 'pwsh.exe');
assert.match(windows.shellDescription, /PowerShell 7.*Windows PowerShell.*cmd/);
assert.equal(windows.argsPlaceholder, '-NoLogo');
assert.equal(windows.showLang, false, 'o Windows não define LANG');
assert.equal(windows.pathPrefixPlaceholder, 'C:\\Tools\\bin');
assert.equal(windows.chromiumPlaceholder, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
assert.deepEqual(windows.chromiumFilters, [{ name: 'Executável', extensions: ['exe'] }]);
assert.equal(windows.windowSection, true);
assert.equal(windows.revealLabel, 'Mostrar no Explorer');
assert.deepEqual(windows.paths, {
  preferences: '%APPDATA%\\br.com.ordinum.cialai\\preferences.json',
  data: '%APPDATA%\\br.com.ordinum.cialai',
  logs: '%LOCALAPPDATA%\\br.com.ordinum.cialai\\logs',
});
assert.equal(platformPreferenceHints('windows', 'cmd').argsPlaceholder, '');
assert.equal(platformPreferenceHints('linux', 'powershell').argsPlaceholder, '-NoLogo');

for (const hints of [mac, linux, windows]) {
  for (const text of [hints.shellDescription, hints.argsDescription, hints.langDescription, hints.pathPrefixDescription, hints.revealLabel]) {
    assert.doesNotMatch(String(text), /[()–—]| - /, `texto de preferência com separador proibido: ${text}`);
  }
}

// Interface: seção Janela só no Windows, com o interruptor da 5.13, LANG fora
// do Windows, filtros do seletor e caminhos reais do aplicativo.
const preferences = read('packages/ui/src/desktop/Preferences.jsx');
for (const contract of [
  /platformPreferenceHints\(platform\(\)\.os, /,
  /hints\.showLang \? <Row title="Idioma"/,
  /hints\.windowSection \? <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Janela<\/h3>/,
  /className="mac-switch"/,
  /backdrop: event\.target\.checked \? 'auto' : 'solid'/,
  /filters: hints\.chromiumFilters/,
  /invoke\('app_paths'\)/,
  />Arquivos do aplicativo</,
  /invoke\('fs_reveal', \{ path \}\)/,
]) assert.match(preferences, contract, `contrato ausente em Preferences.jsx: ${contract}`);

// Rust: fundo normalizado, aplicado ao salvar e caminhos por sistema.
const prefs = read('apps/desktop/src-tauri/src/prefs.rs');
assert.match(prefs, /pub fn backdrop\(&self\) -> &str/);
const commands = read('apps/desktop/src-tauri/src/commands.rs');
assert.match(commands, /crate::window::apply_backdrop\(&window, next\.window\.backdrop\(\)\)/);
assert.match(commands, /pub fn app_paths\(app: AppHandle\) -> Result<AppPaths, String>/);
assert.match(read('apps/desktop/src-tauri/src/lib.rs'), /commands::app_paths,/);
assert.match(read('apps/desktop/src-tauri/src/lib.rs'), /window::decorate\(&main_window, &backdrop\)/);
const windowMod = read('apps/desktop/src-tauri/src/window/mod.rs');
assert.match(windowMod, /pub fn apply_backdrop\(window: &WebviewWindow, backdrop: &str\)/);
assert.match(windowMod, /fn wants_mica\(backdrop: &str, build: u32\) -> bool/);
assert.match(read('apps/desktop/src-tauri/src/window/windows.rs'), /clear_mica/);

console.log('PASS platform preferences: per-system terminal options, Windows window backdrop, app paths and live Mica update');
