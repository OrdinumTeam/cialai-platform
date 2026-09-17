// SPDX-License-Identifier: Apache-2.0
// Pure preference helpers shared by the UI and its contract tests.
import { translate } from './i18n.js';
import { normalizeNetworkPreferences } from './tunnel-model.js';

const APPEARANCES = new Set(['system', 'light', 'dark']);
// Fundo da janela no Windows: automático aplica o Mica quando o sistema
// permite; sólido deixa só o fundo pintado pela página.
export const BACKDROPS = Object.freeze(['auto', 'solid']);

// Barra de IA: um bloco `notch` no mesmo arquivo de preferências, com os
// mesmos nomes e valores do Rust. A visibilidade vale na hora; o resto é
// gravado com Salvar e aplicado por `notch_set_prefs`.
export const NOTCH_VISIBILITIES = Object.freeze(['open', 'collapsed', 'hidden']);
export const NOTCH_RESET_FORMATS = Object.freeze(['automatic', 'remaining']);
export const NOTCH_THRESHOLDS = Object.freeze([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
export const DEFAULT_NOTCH_PREFERENCES = Object.freeze({
  visibility: 'open',
  profiles: Object.freeze({}),
  order: Object.freeze([]),
  hideDefaultWhenDuplicate: true,
  watchLimit: 0.5,
  criticalLimit: 0.7,
  alerts: Object.freeze({ threshold: false, limitReached: false, reset: false }),
  resetTimeFormat: 'automatic',
});

export const DEFAULT_PREFERENCES = Object.freeze({
  appearance: 'system',
  terminal: Object.freeze({ shell: null, args: [], lang: null, pathPrefix: [] }),
  projectRoots: Object.freeze(['~/Projects']),
  devBrowser: Object.freeze({ chromiumPath: null }),
  window: Object.freeze({ backdrop: 'auto' }),
  // A rede sobe sozinha; o nome vazio usa o nome do computador no Rust.
  network: Object.freeze({
    desktopName: null,
    requireApproval: false,
    keepAwakeWhilePaired: false,
  }),
  notch: DEFAULT_NOTCH_PREFERENCES,
});

const strings = (value) => Array.isArray(value) ? value.map((item) => String(item ?? '')) : [];
const cleanList = (value) => [...new Set(strings(value).map((item) => item.trim()).filter(Boolean))];
const optional = (value) => String(value ?? '').trim() || null;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const limitOf = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
};

// Preferências da barra de IA, no formato de `notch_state`. Perfis
// desconhecidos entram como vieram; o apelido vazio vira null.
export function normalizeNotchPreferences(value = {}) {
  const config = isObject(value) ? value : {};
  const profiles = {};
  if (isObject(config.profiles)) {
    for (const [id, row] of Object.entries(config.profiles)) {
      if (!isObject(row)) continue;
      profiles[id] = { enabled: row.enabled !== false, alias: optional(row.alias), muted: row.muted === true };
    }
  }
  return {
    visibility: NOTCH_VISIBILITIES.includes(config.visibility) ? config.visibility : DEFAULT_NOTCH_PREFERENCES.visibility,
    profiles,
    order: cleanList(config.order),
    hideDefaultWhenDuplicate: config.hideDefaultWhenDuplicate !== false,
    watchLimit: limitOf(config.watchLimit, DEFAULT_NOTCH_PREFERENCES.watchLimit),
    criticalLimit: limitOf(config.criticalLimit, DEFAULT_NOTCH_PREFERENCES.criticalLimit),
    alerts: {
      threshold: config.alerts?.threshold === true,
      limitReached: config.alerts?.limitReached === true,
      reset: config.alerts?.reset === true,
    },
    resetTimeFormat: NOTCH_RESET_FORMATS.includes(config.resetTimeFormat) ? config.resetTimeFormat : DEFAULT_NOTCH_PREFERENCES.resetTimeFormat,
  };
}

export function normalizePreferenceDraft(value = {}) {
  const terminal = value.terminal || {};
  const devBrowser = value.devBrowser || {};
  return {
    ...DEFAULT_PREFERENCES,
    ...value,
    appearance: APPEARANCES.has(value.appearance) ? value.appearance : 'system',
    terminal: {
      ...DEFAULT_PREFERENCES.terminal,
      ...terminal,
      shell: terminal.shell == null ? null : String(terminal.shell),
      args: strings(terminal.args),
      lang: terminal.lang == null ? null : String(terminal.lang),
      pathPrefix: strings(terminal.pathPrefix),
    },
    projectRoots: strings(value.projectRoots),
    devBrowser: {
      ...DEFAULT_PREFERENCES.devBrowser,
      ...devBrowser,
      chromiumPath: devBrowser.chromiumPath == null ? null : String(devBrowser.chromiumPath),
    },
    window: {
      ...DEFAULT_PREFERENCES.window,
      ...(value.window || {}),
      backdrop: BACKDROPS.includes(value.window?.backdrop) ? value.window.backdrop : 'auto',
    },
    network: {
      ...DEFAULT_PREFERENCES.network,
      ...normalizeNetworkPreferences(value.network),
      desktopName: value.network?.desktopName == null ? null : String(value.network.desktopName),
    },
    notch: normalizeNotchPreferences(value.notch),
  };
}

export function sanitizePreferences(value) {
  const normalized = normalizePreferenceDraft(value);
  return {
    ...normalized,
    terminal: {
      ...normalized.terminal,
      shell: optional(normalized.terminal.shell),
      args: cleanList(normalized.terminal.args),
      lang: optional(normalized.terminal.lang),
      pathPrefix: cleanList(normalized.terminal.pathPrefix),
    },
    projectRoots: cleanList(normalized.projectRoots),
    devBrowser: {
      ...normalized.devBrowser,
      chromiumPath: optional(normalized.devBrowser.chromiumPath),
    },
    network: normalizeNetworkPreferences(normalized.network),
    notch: normalizeNotchPreferences(normalized.notch),
  };
}

// Opções e caminhos que mudam por sistema. Os textos seguem o padrão que o
// Rust aplica quando o campo fica vazio; os caminhos são os do Tauri e servem
// de exemplo fora do aplicativo, onde `app_paths` não existe.
const SYSTEM_HINTS = {
  macos: {
    shellPlaceholder: '/bin/zsh',
    showLang: true,
    langPlaceholder: 'pt_BR.UTF-8',
    pathPrefixPlaceholder: '/opt/homebrew/bin',
    chromiumPlaceholder: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    chromiumFilters: [],
    windowSection: false,
    revealKey: 'desktop.preferences.revealFinder',
    paths: {
      preferences: '~/Library/Application Support/br.com.ordinum.cialai/preferences.json',
      data: '~/Library/Application Support/br.com.ordinum.cialai',
      logs: '~/Library/Logs/br.com.ordinum.cialai',
    },
  },
  linux: {
    shellPlaceholder: '/bin/bash',
    showLang: true,
    langPlaceholder: 'C.UTF-8',
    pathPrefixPlaceholder: '~/.local/bin',
    chromiumPlaceholder: '/usr/bin/chromium',
    chromiumFilters: [],
    windowSection: false,
    revealKey: 'desktop.preferences.revealFiles',
    paths: {
      preferences: '~/.config/br.com.ordinum.cialai/preferences.json',
      data: '~/.local/share/br.com.ordinum.cialai',
      logs: '~/.local/share/br.com.ordinum.cialai/logs',
    },
  },
  windows: {
    shellPlaceholder: 'pwsh.exe',
    showLang: false,
    langPlaceholder: '',
    pathPrefixPlaceholder: 'C:\\Tools\\bin',
    chromiumPlaceholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    chromiumFilters: [{ name: '', extensions: ['exe'] }],
    windowSection: true,
    revealKey: 'desktop.preferences.revealExplorer',
    paths: {
      preferences: '%APPDATA%\\br.com.ordinum.cialai\\preferences.json',
      data: '%APPDATA%\\br.com.ordinum.cialai',
      logs: '%LOCALAPPDATA%\\br.com.ordinum.cialai\\logs',
    },
  },
};

const ARGUMENT_HINTS = {
  posix: { placeholder: '-l', descriptionKey: 'desktop.preferences.argsPosix' },
  powershell: { placeholder: '-NoLogo', descriptionKey: 'desktop.preferences.argsPowerShell' },
  cmd: { placeholder: '', descriptionKey: 'desktop.preferences.argsCmd' },
};

export function platformPreferenceHints(os, shellFlavor) {
  const system = SYSTEM_HINTS[os] || SYSTEM_HINTS.linux;
  const flavor = ARGUMENT_HINTS[shellFlavor] || (os === 'windows' ? ARGUMENT_HINTS.powershell : ARGUMENT_HINTS.posix);
  return {
    ...system,
    shellDescription: translate(os === 'windows' ? 'desktop.preferences.shellWindows' : 'desktop.preferences.shellAccount'),
    pathPrefixDescription: translate(`desktop.preferences.pathPrefix.${os === 'macos' || os === 'windows' ? os : 'linux'}`),
    revealLabel: translate(system.revealKey),
    chromiumFilters: system.chromiumFilters.map((filter) => ({ ...filter, name: translate('desktop.preferences.executable'), extensions: [...filter.extensions] })),
    paths: { ...system.paths },
    argsPlaceholder: flavor.placeholder,
    argsDescription: translate(flavor.descriptionKey),
    langDescription: translate('desktop.preferences.systemLanguage'),
  };
}

export function addUniquePath(paths, path) {
  return cleanList([...strings(paths), path]);
}

export function removePath(paths, path) {
  return strings(paths).filter((item) => item !== path);
}
