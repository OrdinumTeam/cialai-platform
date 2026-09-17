// SPDX-License-Identifier: Apache-2.0
// Casca da janela por sistema. O macOS mantém semáforos, menubar nativa e a
// guarda do Escape. Linux e Windows não têm menubar, porque os aceleradores
// nativos engoliriam Ctrl T, Ctrl W e Ctrl C antes do terminal: as mesmas
// ações ficam num botão de menu na toolbar. Só o Windows, sem moldura, desenha
// os próprios controles; no Linux eles vêm do gerenciador de janelas.

import { currentOs } from '../lib/keys.js';
import { toggleShortcut } from '../notch/model.js';
import { translate } from './i18n.js';

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

export function windowControlLabels(t = translate) {
  return Object.freeze({ minimize: t('desktop.window.minimize'), maximize: t('desktop.window.maximize'), restore: t('desktop.window.restore'), close: t('desktop.window.close') });
}

// Contrato legado dos checks e consumidores sem reatividade. A interface usa
// windowControlLabels para acompanhar mudanças de idioma em tempo de execução.
export const WINDOW_CONTROL_LABELS = windowControlLabels();

// Itens do botão de menu, na ordem da menubar do macOS. `label` recebe uma
// combinação como 'Mod+T' e devolve o rótulo do sistema; `os` decide a
// combinação da barra de IA, que muda fora do macOS.
export function appMenuItems(actions, views = [], { label = () => '', t = translate, os = currentOs() } = {}) {
  const run = (name, ...args) => () => actions?.[name]?.(...args);
  const item = (id, text, combo, name, ...args) => ({ id, label: text, hint: combo ? label(combo) : '', run: run(name, ...args) });
  return [
    item('new-terminal', t('desktop.action.newTerminal'), 'Mod+T', 'newTerminal'),
    item('new-file', t('desktop.action.newFile'), 'Mod+N', 'newFile'),
    item('close-terminal', t('desktop.action.close'), 'Mod+W', 'closeActiveTerminalOrWindow'),
    item('reload-data', t('desktop.action.reloadBrowserShort'), 'Mod+R', 'reloadData'),
    { separator: true },
    item('command-palette', t('desktop.palette.title'), 'Mod+K', 'openPalette'),
    item('toggle-sidebar', t('desktop.action.toggleSidebar'), '', 'toggleSidebar'),
    item('notch-toggle', t('desktop.notch.action.toggle'), toggleShortcut(os), 'toggleNotch'),
    item('notch-hide', t('desktop.notch.action.hide'), '', 'hideNotch'),
    { separator: true },
    item('appearance-system', t('desktop.appearance.systemMenu'), '', 'setAppearance', 'system'),
    item('appearance-light', t('desktop.appearance.light'), '', 'setAppearance', 'light'),
    item('appearance-dark', t('desktop.appearance.dark'), '', 'setAppearance', 'dark'),
    { separator: true },
    ...views.slice(0, 9).map((view, index) => item(`view-${view.id}`, view.label, `Mod+${index + 1}`, 'navigate', view.id)),
    { separator: true },
    item('preferences', t('desktop.preferences.title'), 'Mod+Comma', 'openPreferences'),
    item('close-window', t('desktop.action.closeWindow'), '', 'closeWindow'),
    item('quit', t('desktop.action.quit'), '', 'quitApp'),
  ];
}
