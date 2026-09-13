// SPDX-License-Identifier: Apache-2.0
import { isTauri } from '../lib/native.js';

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

export function installDomShortcuts(actionsRef, views = []) {
  if (isTauri() && document.documentElement.dataset.platform === 'macos') return () => {};
  const onKeyDown = (event) => {
    const meta = event.metaKey || event.ctrlKey; if (!meta) return;
    const actions = actionsRef.current || {}; const key = event.key.toLowerCase();
    if (key === 'k') { event.preventDefault(); actions.openPalette?.(); }
    else if (key === 't') { event.preventDefault(); actions.newTerminal?.(); }
    else if (key === 'n' && !event.shiftKey) { event.preventDefault(); actions.newFile?.(); }
    else if (key === ',') { event.preventDefault(); actions.openPreferences?.(); }
    else if (key === 's' && event.ctrlKey && event.metaKey) { event.preventDefault(); actions.toggleSidebar?.(); }
    else if (/^[1-9]$/.test(key) && !event.shiftKey && !event.altKey) { const view = views[Number(key) - 1]; if (view) { event.preventDefault(); actions.navigate?.(view.id); } }
  };
  window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
}
