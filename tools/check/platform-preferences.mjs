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
  /hints\.showLang \? <Row title=\{translate\('language\.label'\)\}/,
  /hints\.windowSection \? <section className="mac-prefs__section"><h3 className="mac-prefs__heading">\{translate\('desktop\.preferences\.window'\)\}<\/h3>/,
  /className="mac-switch"/,
  /backdrop: event\.target\.checked \? 'auto' : 'solid'/,
  /filters: hints\.chromiumFilters/,
  /invoke\('app_paths'\)/,
  /\{translate\('desktop\.preferences\.appFiles'\)\}<\/h3>/,
  /invoke\('fs_reveal', \{ path \}\)/,
  // Comando `cialai` no terminal: a linha mostra onde ficou, oferece copiar a
  // linha de PATH e remover. O caminho vem como dado do Rust.
  /invoke\('cli_status'\)/,
  /invoke\('cli_install'\)/,
  /invoke\('cli_uninstall'\)/,
]) assert.match(preferences, contract, `contrato ausente em Preferences.jsx: ${contract}`);

// Rede: sem servidor; nome do computador, aprovação por código e vigília.
const network = sanitizePreferences({ network: { controlUrl: 'https://headscale.exemplo.com', userId: '42', userName: 'alice', desktopName: 'Mac', requireApproval: 1, keepAwakeWhilePaired: 'sim' } }).network;
assert.deepEqual(network, { desktopName: 'Mac', requireApproval: true, keepAwakeWhilePaired: true });
for (const contract of [
  /network\.desktopName/,
  /network\.requireApproval/,
  /network\.keepAwakeWhilePaired/,
  /maxLength=\{DESKTOP_NAME_MAX\}/,
]) assert.match(preferences, contract, `contrato de rede ausente em Preferences.jsx: ${contract}`);
assert.doesNotMatch(preferences, /controlUrl|userName|apiKey|NetworkSetup/);

// Rust: fundo normalizado, aplicado ao salvar e caminhos por sistema.
const prefs = read('apps/desktop/src-tauri/src/prefs.rs');
assert.match(prefs, /pub fn backdrop\(&self\) -> &str/);
assert.match(prefs, /pub struct NetworkPreferences \{\s*pub desktop_name: String,\s*pub require_approval: bool,\s*pub keep_awake_while_paired: bool,\s*\}/);
assert.match(prefs, /from = "StoredNetworkPreferences"/);
assert.match(prefs, /fn old_preferences_file_drops_headscale_fields\(\)/);
assert.match(prefs, /pub fn computer_name\(\) -> String/);
const commands = read('apps/desktop/src-tauri/src/commands.rs');
assert.match(commands, /crate::window::apply_backdrop\(&window, next\.window\.backdrop\(\)\)/);
assert.match(commands, /pub fn app_paths\(app: AppHandle\) -> Result<AppPaths, String>/);
assert.match(read('apps/desktop/src-tauri/src/lib.rs'), /commands::app_paths,/);
// Comando de terminal: os tres comandos registrados e o gancho de primeira
// abertura, que nunca pode derrubar o `setup`.
for (const contract of [/pub fn cli_status\(/, /pub fn cli_install\(/, /pub fn cli_uninstall\(/]) {
  assert.match(commands, contract, `comando do terminal ausente em commands.rs: ${contract}`);
}
// O `cli::install` do gancho recebe a pasta pessoal e a de configuracao do
// app. A busca ignora espaco e quebra de linha porque quem decide o formato da
// chamada e o rustfmt, e um portao nao deve quebrar por reformatacao.
for (const contract of [/commands::cli_status,/, /commands::cli_install,/, /commands::cli_uninstall,/, /cli::install\(\s*&cli_home,\s*&cli_config/]) {
  assert.match(read('apps/desktop/src-tauri/src/lib.rs'), contract, `contrato do comando ausente em lib.rs: ${contract}`);
}
const cli = read('apps/desktop/src-tauri/src/cli.rs');
// Ate a 0.2.8 este portao exigia que o app NAO tocasse em arquivo de shell. A
// promessa nao se sustentou no Linux: `~/.local/bin` so entra no PATH pelo
// `~/.profile` do Debian se a pasta ja existir no login, e o Cialai cria a
// pasta depois, entao o usuario digitava `cialai` e levava command not found.
//
// O app passou a escrever no arquivo que o shell INTERATIVO le, que e quem
// decide se uma janela nova acha o comando. O que este portao guarda agora e o
// modo de escrever, que e o que torna a escrita segura.
assert.match(cli, /pub fn rc_file\(/, 'falta escolher o arquivo do shell interativo');
assert.match(cli, /pub fn path_block\(/);
assert.match(cli, /pub const BLOCO_INICIO/, 'o bloco precisa de marcador de abertura para a remocao ser exata');
assert.match(cli, /pub const BLOCO_FIM/, 'o bloco precisa de marcador de fechamento');
// Guardado, senao cada terminal novo empilha a pasta no PATH.
assert.match(cli, /case \\":\$PATH:\\" in/, 'o bloco do POSIX precisa da guarda que evita repetir a pasta no PATH');
// Copia de seguranca antes da primeira escrita num arquivo que ja existia.
assert.match(cli, /if rc\.exists\(\) && !atual\.contains\(BLOCO_INICIO\) \{\s*backup\(rc\)/, 'a primeira escrita no arquivo do shell precisa de copia de seguranca');
// Remover pelas Preferencias tem que desfazer a escrita.
assert.match(cli, /remove_path_block\(&rc_file\(home, shell\)\)/, 'a remocao precisa tirar o bloco do arquivo do shell');
// No fish nada e editado: o Cialai escreve um arquivo so dele em conf.d.
assert.match(cli, /conf\.d/, 'no fish o Cialai escreve arquivo proprio, nao edita configuracao alheia');
assert.match(cli, /pub fn launcher_from\(/);
assert.match(cli, /pub const CLI_MARKER/);
assert.match(read('apps/desktop/src-tauri/src/lib.rs'), /window::decorate\(&main_window, &backdrop\)/);
const windowMod = read('apps/desktop/src-tauri/src/window/mod.rs');
assert.match(windowMod, /pub fn apply_backdrop\(window: &WebviewWindow, backdrop: &str\)/);
assert.match(windowMod, /fn wants_mica\(backdrop: &str, build: u32\) -> bool/);
assert.match(read('apps/desktop/src-tauri/src/window/windows.rs'), /clear_mica/);

console.log('PASS platform preferences: per-system terminal options, Windows window backdrop, app paths, live Mica update and network preferences without a server');
