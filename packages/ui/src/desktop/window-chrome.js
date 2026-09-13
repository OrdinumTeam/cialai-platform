// SPDX-License-Identifier: Apache-2.0
// Casca da janela por sistema. O macOS mantém semáforos, menubar nativa e a
// guarda do Escape. Linux e Windows não têm menubar, porque os aceleradores
// nativos engoliriam Ctrl T, Ctrl W e Ctrl C antes do terminal: as mesmas
// ações ficam num botão de menu na toolbar. Só o Windows, sem moldura, desenha
// os próprios controles; no Linux eles vêm do gerenciador de janelas.

export function windowChrome(os) {
  const mac = os === 'macos';
  return {
    nativeMenu: mac,
    menuButton: !mac,
    windowControls: os === 'windows',
    trafficLights: mac,
    escapeGuard: mac,
  };
}

export const WINDOW_CONTROL_LABELS = Object.freeze({
  minimize: 'Minimizar',
  maximize: 'Maximizar',
  restore: 'Restaurar',
  close: 'Fechar',
});

// Itens do botão de menu, na ordem da menubar do macOS. `label` recebe uma
// combinação como 'Mod+T' e devolve o rótulo do sistema.
export function appMenuItems(actions, views = [], { label = () => '' } = {}) {
  const run = (name, ...args) => () => actions?.[name]?.(...args);
  const item = (id, text, combo, name, ...args) => ({ id, label: text, hint: combo ? label(combo) : '', run: run(name, ...args) });
  return [
    item('new-terminal', 'Novo terminal', 'Mod+T', 'newTerminal'),
    item('new-file', 'Novo arquivo', 'Mod+N', 'newFile'),
    item('close-terminal', 'Fechar', 'Mod+W', 'closeActiveTerminalOrWindow'),
    item('reload-data', 'Recarregar navegador', 'Mod+R', 'reloadData'),
    { separator: true },
    item('command-palette', 'Buscar comandos', 'Mod+K', 'openPalette'),
    item('toggle-sidebar', 'Mostrar ou ocultar barra lateral', '', 'toggleSidebar'),
    { separator: true },
    item('appearance-system', 'Aparência do sistema', '', 'setAppearance', 'system'),
    item('appearance-light', 'Aparência clara', '', 'setAppearance', 'light'),
    item('appearance-dark', 'Aparência escura', '', 'setAppearance', 'dark'),
    { separator: true },
    ...views.slice(0, 9).map((view, index) => item(`view-${view.id}`, view.label, `Mod+${index + 1}`, 'navigate', view.id)),
    { separator: true },
    item('preferences', 'Preferências', 'Mod+Comma', 'openPreferences'),
    item('close-window', 'Fechar janela', '', 'closeWindow'),
    item('quit', 'Sair do Cialai', '', 'quitApp'),
  ];
}
