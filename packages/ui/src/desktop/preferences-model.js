// SPDX-License-Identifier: Apache-2.0
// Pure preference helpers shared by the UI and its contract tests.

const APPEARANCES = new Set(['system', 'light', 'dark']);

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
    window: { ...DEFAULT_PREFERENCES.window, ...(value.window || {}) },
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
  };
}

export function addUniquePath(paths, path) {
  return cleanList([...strings(paths), path]);
}

export function removePath(paths, path) {
  return strings(paths).filter((item) => item !== path);
}
