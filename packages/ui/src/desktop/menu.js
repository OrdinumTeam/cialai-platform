// SPDX-License-Identifier: Apache-2.0
import { isTauri } from '../lib/native.js';
import { currentOs, isAppShortcut, isShortcut, isTerminalFocused } from '../lib/keys.js';
import { translate } from './i18n.js';

let installedLocale = '';
export async function installNativeMenu(actionsRef, views = [], locale = '') {
  if (!isTauri() || document.documentElement.dataset.platform !== 'macos' || installedLocale === locale) return;
  installedLocale = locale;
  const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
  const run = (name, ...args) => () => actionsRef.current?.[name]?.(...args);
  const item = (id, text, accelerator, name, ...args) => MenuItem.new({ id, text, accelerator, action: run(name, ...args) });
  const predefined = (kind, text) => PredefinedMenuItem.new(text ? { item: kind, text } : { item: kind });
  const separator = () => predefined('Separator');
  const appMenu = await Submenu.new({ text: 'Cialai', items: [
    await PredefinedMenuItem.new({ item: { About: { name: 'Cialai', comments: translate('native.menu.aboutComment'), copyright: 'Ordinum' } }, text: translate('native.menu.about') }),
    await separator(), await item('preferences', translate('desktop.preferences.title'), 'CmdOrCtrl+Comma', 'openPreferences'), await separator(), await predefined('Services', translate('native.menu.services')), await separator(), await predefined('Hide', translate('native.menu.hide')), await predefined('HideOthers', translate('native.menu.hideOthers')), await predefined('ShowAll', translate('native.menu.showAll')), await separator(), await item('quit', translate('native.menu.quit'), 'CmdOrCtrl+Q', 'quitApp'),
  ] });
  const fileMenu = await Submenu.new({ text: translate('native.menu.file'), items: [await item('new-file', translate('desktop.action.newFile'), 'CmdOrCtrl+N', 'newFile'), await item('new-terminal', translate('desktop.action.newTerminal'), 'CmdOrCtrl+T', 'newTerminal'), await item('close-terminal', translate('desktop.action.close'), 'CmdOrCtrl+W', 'closeActiveTerminalOrWindow'), await separator(), await item('reload-data', translate('desktop.action.reloadBrowserShort'), 'CmdOrCtrl+R', 'reloadData'), await separator(), await item('close-window', translate('desktop.action.closeWindow'), 'CmdOrCtrl+Shift+W', 'closeWindow')] });
  const editMenu = await Submenu.new({ text: translate('native.menu.edit'), items: [await predefined('Undo', translate('native.menu.undo')), await predefined('Redo', translate('native.menu.redo')), await separator(), await predefined('Cut', translate('native.menu.cut')), await predefined('Copy', translate('native.menu.copy')), await predefined('Paste', translate('native.menu.paste')), await predefined('SelectAll', translate('native.menu.selectAll'))] });
  const appearanceMenu = await Submenu.new({ text: translate('desktop.preferences.appearance'), items: [await item('appearance-system', translate('desktop.appearance.systemShort'), undefined, 'setAppearance', 'system'), await item('appearance-light', translate('desktop.appearance.lightShort'), undefined, 'setAppearance', 'light'), await item('appearance-dark', translate('desktop.appearance.darkShort'), undefined, 'setAppearance', 'dark')] });
  const sections = [];
  for (let index = 0; index < views.length; index += 1) sections.push(await item(`view-${views[index].id}`, views[index].label, `CmdOrCtrl+${index + 1}`, 'navigate', views[index].id));
  const viewMenu = await Submenu.new({ text: translate('native.menu.view'), items: [await item('toggle-sidebar', translate('desktop.action.toggleSidebar'), 'Ctrl+Cmd+S', 'toggleSidebar'), await item('command-palette', translate('desktop.palette.title'), 'CmdOrCtrl+K', 'openPalette'), await separator(), appearanceMenu, await separator(), ...sections, await separator(), await predefined('Fullscreen', translate('native.menu.fullscreen'))] });
  const windowMenu = await Submenu.new({ text: translate('native.menu.window'), items: [await predefined('Minimize', translate('native.menu.minimize')), await predefined('Maximize', translate('native.menu.zoom'))] });
  await (await Menu.new({ items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu] })).setAsAppMenu();
}

// Fora do macOS nativo não há menubar: os atalhos do app vivem no DOM. Dentro
// do terminal só a variante com Shift é do app, para Ctrl chegar ao shell.
export function installDomShortcuts(actionsRef, views = []) {
  if (isTauri() && document.documentElement.dataset.platform === 'macos') return () => {};
  const onKeyDown = (event) => {
    const actions = actionsRef.current || {};
    const inTerminal = isTerminalFocused();
    const app = (combo) => isAppShortcut(event, combo, { inTerminal });
    let run = null;
    if (app('Mod+K')) run = actions.openPalette;
    else if (app('Mod+T')) run = actions.newTerminal;
    else if (app('Mod+N')) run = actions.newFile;
    else if (app('Mod+W')) run = actions.closeActiveTerminalOrWindow;
    else if (isTauri() && app('Mod+R')) run = actions.reloadData;
    else if (app('Mod+Comma')) run = actions.openPreferences;
    else if (currentOs() === 'macos' && isShortcut(event, 'Ctrl+Mod+S')) run = actions.toggleSidebar;
    else {
      const digit = /^Digit([1-9])$/.exec(event.code || '')?.[1] || (/^[1-9]$/.test(event.key) ? event.key : '');
      const view = digit ? views[Number(digit) - 1] : null;
      if (view && app(`Mod+${digit}`)) run = () => actions.navigate?.(view.id);
    }
    if (!run) return;
    event.preventDefault();
    run();
  };
  window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
}
