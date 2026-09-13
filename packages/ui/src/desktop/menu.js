// SPDX-License-Identifier: Apache-2.0
import { isTauri } from '../lib/native.js';
import { currentOs, isAppShortcut, isShortcut, isTerminalFocused } from '../lib/keys.js';

let installed = false;
export async function installNativeMenu(actionsRef, views = []) {
  if (!isTauri() || document.documentElement.dataset.platform !== 'macos' || installed) return;
  installed = true;
  const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
  const run = (name, ...args) => () => actionsRef.current?.[name]?.(...args);
  const item = (id, text, accelerator, name, ...args) => MenuItem.new({ id, text, accelerator, action: run(name, ...args) });
  const predefined = (kind, text) => PredefinedMenuItem.new(text ? { item: kind, text } : { item: kind });
  const separator = () => predefined('Separator');
  const appMenu = await Submenu.new({ text: 'Cialai', items: [
    await PredefinedMenuItem.new({ item: { About: { name: 'Cialai', comments: 'Estúdio de terminais e projetos', copyright: 'Ordinum' } }, text: 'Sobre o Cialai' }),
    await separator(), await item('preferences', 'Preferências…', 'CmdOrCtrl+Comma', 'openPreferences'), await separator(), await predefined('Services', 'Serviços'), await separator(), await predefined('Hide', 'Ocultar o Cialai'), await predefined('HideOthers', 'Ocultar Outros'), await predefined('ShowAll', 'Mostrar Tudo'), await separator(), await item('quit', 'Sair do Cialai', 'CmdOrCtrl+Q', 'quitApp'),
  ] });
  const fileMenu = await Submenu.new({ text: 'Arquivo', items: [await item('new-file', 'Novo Arquivo', 'CmdOrCtrl+N', 'newFile'), await item('new-terminal', 'Novo Terminal', 'CmdOrCtrl+T', 'newTerminal'), await item('close-terminal', 'Fechar', 'CmdOrCtrl+W', 'closeActiveTerminalOrWindow'), await separator(), await item('reload-data', 'Recarregar Navegador', 'CmdOrCtrl+R', 'reloadData'), await separator(), await item('close-window', 'Fechar Janela', 'CmdOrCtrl+Shift+W', 'closeWindow')] });
  const editMenu = await Submenu.new({ text: 'Editar', items: [await predefined('Undo', 'Desfazer'), await predefined('Redo', 'Refazer'), await separator(), await predefined('Cut', 'Recortar'), await predefined('Copy', 'Copiar'), await predefined('Paste', 'Colar'), await predefined('SelectAll', 'Selecionar Tudo')] });
  const appearanceMenu = await Submenu.new({ text: 'Aparência', items: [await item('appearance-system', 'Sistema', undefined, 'setAppearance', 'system'), await item('appearance-light', 'Claro', undefined, 'setAppearance', 'light'), await item('appearance-dark', 'Escuro', undefined, 'setAppearance', 'dark')] });
  const sections = [];
  for (let index = 0; index < views.length; index += 1) sections.push(await item(`view-${views[index].id}`, views[index].label, `CmdOrCtrl+${index + 1}`, 'navigate', views[index].id));
  const viewMenu = await Submenu.new({ text: 'Visualizar', items: [await item('toggle-sidebar', 'Mostrar ou Ocultar Barra Lateral', 'Ctrl+Cmd+S', 'toggleSidebar'), await item('command-palette', 'Buscar Comandos…', 'CmdOrCtrl+K', 'openPalette'), await separator(), appearanceMenu, await separator(), ...sections, await separator(), await predefined('Fullscreen', 'Tela Cheia')] });
  const windowMenu = await Submenu.new({ text: 'Janela', items: [await predefined('Minimize', 'Minimizar'), await predefined('Maximize', 'Zoom')] });
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
