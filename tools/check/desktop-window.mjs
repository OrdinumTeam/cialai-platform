// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const json = (path) => JSON.parse(read(path));
const tauri = 'apps/desktop/src-tauri';
const ui = 'packages/ui/src';

// Configuração por sistema: o macOS continua com a barra sobreposta; Windows
// nasce sem moldura, com sombra e o ameixa da marca; Linux usa as decorações
// do gerenciador de janelas e fundo opaco.
const mac = json(`${tauri}/tauri.macos.conf.json`).app.windows[0];
assert.equal(mac.titleBarStyle, 'Overlay');
assert.equal(mac.hiddenTitle, true);
assert.deepEqual(mac.trafficLightPosition, { x: 20, y: 21 });
const windows = json(`${tauri}/tauri.windows.conf.json`).app.windows[0];
assert.equal(windows.decorations, false);
assert.equal(windows.shadow, true);
assert.equal(windows.transparent, true);
assert.match(windows.backgroundColor, /^#[0-9A-Fa-f]{6}$/);
assert.equal(windows.windowEffects, undefined, 'Mica vem do Rust, não de windowEffects');
const linux = json(`${tauri}/tauri.linux.conf.json`).app.windows[0];
assert.equal(linux.decorations, true);
assert.equal(linux.transparent, false);
assert.equal(linux.backgroundColor, windows.backgroundColor);

// Um backend por sistema, escolhido por cfg, com a coreografia comum.
for (const file of ['mod', 'macos', 'windows', 'generic']) {
  assert.ok(existsSync(`${root}${tauri}/src/window/${file}.rs`), `backend de janela ausente: window/${file}.rs`);
}
assert.ok(!existsSync(`${root}${tauri}/src/window.rs`), 'window.rs deve virar window/mod.rs');
const windowMod = read(`${tauri}/src/window/mod.rs`);
for (const contract of [
  /#\[cfg\(target_os = "macos"\)\]\s*mod macos;/,
  /#\[cfg\(target_os = "windows"\)\]\s*mod windows;/,
  /#\[cfg\(not\(any\(target_os = "macos", target_os = "windows"\)\)\)\]\s*mod generic;/,
  /enum Origin/,
  /fn is_wayland_session/,
  /fn mica_supported/,
  /MICA_MIN_BUILD: u32 = 22621/,
]) assert.match(windowMod, contract, `contrato ausente em window/mod.rs: ${contract}`);
const windowsBackend = read(`${tauri}/src/window/windows.rs`);
for (const contract of [/SetWindowPos/, /SWP_NOZORDER/, /SWP_NOACTIVATE/, /outer_position/, /outer_size/, /work_area/, /apply_mica/, /RtlGetVersion/]) {
  assert.match(windowsBackend, contract, `contrato ausente em window/windows.rs: ${contract}`);
}
const genericBackend = read(`${tauri}/src/window/generic.rs`);
for (const contract of [/WAYLAND_DISPLAY/, /GDK_BACKEND/, /set_position/, /set_size/, /work_area/]) {
  assert.match(genericBackend, contract, `contrato ausente em window/generic.rs: ${contract}`);
}
const macBackend = read(`${tauri}/src/window/macos.rs`);
assert.match(macBackend, /setFrame_display/);
assert.match(macBackend, /NSVisualEffectMaterial::Sidebar/);
assert.match(read(`${tauri}/src/lib.rs`), /window::decorate\(&main_window, &backdrop\)/);
const cargo = read(`${tauri}/Cargo.toml`);
assert.match(cargo, /\[target\.'cfg\(any\(target_os = "macos", target_os = "windows"\)\)'\.dependencies\]\s*window-vibrancy = "0\.8"/);
for (const feature of ['Win32_UI_WindowsAndMessaging', 'Wdk_System_SystemServices', 'Win32_System_SystemInformation']) {
  assert.ok(cargo.includes(`"${feature}"`), `feature do windows-sys ausente: ${feature}`);
}

// Controles próprios só no Windows, com a menor permissão necessária.
const controls = json(`${tauri}/capabilities/window-controls.json`);
assert.deepEqual(controls.platforms, ['windows']);
assert.deepEqual(controls.windows, ['main']);
assert.deepEqual([...controls.permissions].sort(), ['core:window:allow-minimize', 'core:window:allow-toggle-maximize']);

const { windowChrome, appMenuItems, WINDOW_CONTROL_LABELS } = await import(pathToFileURL(`${root}${ui}/desktop/window-chrome.js`).href);
assert.deepEqual(windowChrome('macos'), { nativeMenu: true, menuButton: false, windowControls: false, trafficLights: true, escapeGuard: true });
assert.deepEqual(windowChrome('windows'), { nativeMenu: false, menuButton: true, windowControls: true, trafficLights: false, escapeGuard: false });
assert.deepEqual(windowChrome('linux'), { nativeMenu: false, menuButton: true, windowControls: false, trafficLights: false, escapeGuard: false });
assert.deepEqual(WINDOW_CONTROL_LABELS, { minimize: 'Minimizar', maximize: 'Maximizar', restore: 'Restaurar', close: 'Fechar' });

const calls = [];
const actions = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
const views = [{ id: 'terminais', label: 'Terminais' }, { id: 'dispositivos', label: 'Dispositivos' }];
const items = appMenuItems(actions, views, { label: (combo) => `[${combo}]` });
const runnable = items.filter((item) => item && !item.separator);
const byLabel = Object.fromEntries(runnable.map((item) => [item.label, item]));
for (const label of ['Novo terminal', 'Novo arquivo', 'Fechar', 'Recarregar navegador', 'Buscar comandos', 'Mostrar ou ocultar barra lateral', 'Aparência do sistema', 'Aparência clara', 'Aparência escura', 'Terminais', 'Dispositivos', 'Preferências', 'Fechar janela', 'Sair do Cialai']) {
  assert.ok(byLabel[label], `item ausente no menu da toolbar: ${label}`);
}
assert.equal(byLabel['Novo terminal'].hint, '[Mod+T]');
assert.equal(byLabel.Dispositivos.hint, '[Mod+2]');
byLabel['Aparência escura'].run();
byLabel.Dispositivos.run();
byLabel['Sair do Cialai'].run();
assert.deepEqual(calls, [['setAppearance', 'dark'], ['navigate', 'dispositivos'], ['quitApp']]);
for (const item of runnable) {
  assert.doesNotMatch(item.label, /[()–—]| - /, `texto do menu com separador proibido: ${item.label}`);
}

// Interface: controles por getCurrentWindow, menu no DOM fora do macOS e
// guarda do Escape só no macOS.
const native = read(`${ui}/lib/native.js`);
assert.match(native, /export const windowControls = \{/);
for (const method of ['minimize', 'toggleMaximize', 'close', 'isMaximized', 'onMaximizedChange']) {
  assert.match(native, new RegExp(`async ${method}\\(`), `windowControls sem ${method}`);
}
const toolbar = read(`${ui}/desktop/Toolbar.jsx`);
assert.match(toolbar, /chrome\.windowControls \? <WindowControls \/> : null/);
assert.match(toolbar, /chrome\.menuButton \?/);
const windowControlsSource = read(`${ui}/desktop/WindowControls.jsx`);
assert.match(windowControlsSource, /windowControls\.minimize/);
assert.match(windowControlsSource, /windowControls\.toggleMaximize/);
assert.match(windowControlsSource, /windowControls\.close/);
assert.match(windowControlsSource, /onMaximizedChange/);
const app = read(`${ui}/desktop/DesktopApp.jsx`);
assert.match(app, /windowChrome\(platform\(\)\.os\)\.escapeGuard/);
assert.match(read(`${ui}/desktop/menu.js`), /dataset\.platform !== 'macos'/);
const css = read(`${ui}/desktop/shell.css`);
assert.match(css, /\[data-platform="macos"\] \.mac-sidebar__drag\{flex:0 0 52px;height:52px\}/);
assert.match(css, /\[data-platform="macos"\] \.mac-toolbar\.is-sidebar-hidden\{padding-left:82px\}/);
const platformCss = read(`${ui}/desktop/platform.css`);
assert.match(platformCss, /\.mac-window-controls/);
assert.match(platformCss, /\[data-platform="windows"\]/);
assert.match(read(`${ui}/desktop/desktop.css`), /@import '\.\/platform\.css';/);

console.log('PASS desktop window: per-system configs, native backends, Windows controls, DOM menu and macOS-only Escape guard');
