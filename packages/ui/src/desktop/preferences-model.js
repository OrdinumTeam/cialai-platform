// SPDX-License-Identifier: Apache-2.0
// Pure preference helpers shared by the UI and its contract tests.

const APPEARANCES = new Set(['system', 'light', 'dark']);
// Fundo da janela no Windows: automático aplica o Mica quando o sistema
// permite; sólido deixa só o fundo pintado pela página.
export const BACKDROPS = Object.freeze(['auto', 'solid']);

export const DEFAULT_PREFERENCES = Object.freeze({
  appearance: 'system',
  terminal: Object.freeze({ shell: null, args: [], lang: null, pathPrefix: [] }),
  projectRoots: Object.freeze(['~/Projects']),
  devBrowser: Object.freeze({ chromiumPath: null }),
  window: Object.freeze({ backdrop: 'auto' }),
  network: Object.freeze({
    controlUrl: null,
    userId: null,
    userName: null,
    desktopName: null,
    requireApproval: false,
    keepAwakeWhilePaired: false,
  }),
});

const strings = (value) => Array.isArray(value) ? value.map((item) => String(item ?? '')) : [];
const cleanList = (value) => [...new Set(strings(value).map((item) => item.trim()).filter(Boolean))];
const optional = (value) => String(value ?? '').trim() || null;

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
    network: { ...DEFAULT_PREFERENCES.network, ...(value.network || {}) },
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
    network: {
      ...normalized.network,
      controlUrl: optional(normalized.network.controlUrl)?.replace(/\/+$/, '') || null,
      userId: optional(normalized.network.userId),
      userName: optional(normalized.network.userName),
      desktopName: optional(normalized.network.desktopName),
      requireApproval: Boolean(normalized.network.requireApproval),
      keepAwakeWhilePaired: Boolean(normalized.network.keepAwakeWhilePaired),
    },
  };
}

// Opções e caminhos que mudam por sistema. Os textos seguem o padrão que o
// Rust aplica quando o campo fica vazio; os caminhos são os do Tauri e servem
// de exemplo fora do aplicativo, onde `app_paths` não existe.
const SYSTEM_HINTS = {
  macos: {
    shellPlaceholder: '/bin/zsh',
    shellDescription: 'Vazio usa o shell da sua conta.',
    showLang: true,
    langPlaceholder: 'pt_BR.UTF-8',
    pathPrefixPlaceholder: '/opt/homebrew/bin',
    pathPrefixDescription: 'Um diretório em cada linha. Vazio acrescenta /opt/homebrew/bin e /usr/local/bin quando existem.',
    chromiumPlaceholder: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    chromiumFilters: [],
    windowSection: false,
    revealLabel: 'Mostrar no Finder',
    paths: {
      preferences: '~/Library/Application Support/br.com.ordinum.cialai/preferences.json',
      data: '~/Library/Application Support/br.com.ordinum.cialai',
      logs: '~/Library/Logs/br.com.ordinum.cialai',
    },
  },
  linux: {
    shellPlaceholder: '/bin/bash',
    shellDescription: 'Vazio usa o shell da sua conta.',
    showLang: true,
    langPlaceholder: 'C.UTF-8',
    pathPrefixPlaceholder: '~/.local/bin',
    pathPrefixDescription: 'Um diretório em cada linha. Vazio acrescenta ~/.local/bin, /usr/local/bin, Linuxbrew e Snap quando existem.',
    chromiumPlaceholder: '/usr/bin/chromium',
    chromiumFilters: [],
    windowSection: false,
    revealLabel: 'Mostrar em Arquivos',
    paths: {
      preferences: '~/.config/br.com.ordinum.cialai/preferences.json',
      data: '~/.local/share/br.com.ordinum.cialai',
      logs: '~/.local/share/br.com.ordinum.cialai/logs',
    },
  },
  windows: {
    shellPlaceholder: 'pwsh.exe',
    shellDescription: 'Vazio procura o PowerShell 7, depois o Windows PowerShell e por fim o cmd.',
    showLang: false,
    langPlaceholder: '',
    pathPrefixPlaceholder: 'C:\\Tools\\bin',
    pathPrefixDescription: 'Um diretório em cada linha. Vazio mantém o PATH do Windows.',
    chromiumPlaceholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    chromiumFilters: [{ name: 'Executável', extensions: ['exe'] }],
    windowSection: true,
    revealLabel: 'Mostrar no Explorer',
    paths: {
      preferences: '%APPDATA%\\br.com.ordinum.cialai\\preferences.json',
      data: '%APPDATA%\\br.com.ordinum.cialai',
      logs: '%LOCALAPPDATA%\\br.com.ordinum.cialai\\logs',
    },
  },
};

const ARGUMENT_HINTS = {
  posix: { placeholder: '-l', description: 'Um argumento em cada linha. Vazio usa -l nos shells de login conhecidos.' },
  powershell: { placeholder: '-NoLogo', description: 'Um argumento em cada linha. Vazio usa -NoLogo.' },
  cmd: { placeholder: '', description: 'Um argumento em cada linha. Vazio não acrescenta argumentos.' },
};

export function platformPreferenceHints(os, shellFlavor) {
  const system = SYSTEM_HINTS[os] || SYSTEM_HINTS.linux;
  const flavor = ARGUMENT_HINTS[shellFlavor] || (os === 'windows' ? ARGUMENT_HINTS.powershell : ARGUMENT_HINTS.posix);
  return {
    ...system,
    chromiumFilters: system.chromiumFilters.map((filter) => ({ ...filter, extensions: [...filter.extensions] })),
    paths: { ...system.paths },
    argsPlaceholder: flavor.placeholder,
    argsDescription: flavor.description,
    langDescription: 'Vazio usa o idioma do sistema.',
  };
}

export function addUniquePath(paths, path) {
  return cleanList([...strings(paths), path]);
}

export function removePath(paths, path) {
  return strings(paths).filter((item) => item !== path);
}
