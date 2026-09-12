// SPDX-License-Identifier: Apache-2.0
// Aparência do app: segue o sistema por padrão, com override claro ou escuro.
// O valor fica em cialai_theme no armazenamento do webview.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setWindowTheme } from '../lib/native.js';

export const AppearanceContext = createContext(null);

const MODES = ['system', 'light', 'dark'];
const STORAGE_KEY = 'cialai_theme';
const LEGACY_STORAGE_KEY = 'oc_theme';

function readStoredMode() {
  try {
    let stored = localStorage.getItem(STORAGE_KEY);
    if (stored == null) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (MODES.includes(legacy)) { stored = legacy; localStorage.setItem(STORAGE_KEY, legacy); }
    }
    return MODES.includes(stored) ? stored : 'system';
  } catch (_error) {
    return 'system';
  }
}

export function useAppearance() {
  const [mode, setModeState] = useState(readStoredMode);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_error) { /* sem storage */ }
    setWindowTheme(mode === 'system' ? null : mode).catch(() => {});
  }, [mode, resolved]);

  const setMode = useCallback((next) => {
    setModeState(MODES.includes(next) ? next : 'system');
  }, []);

  return useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
}

export function useAppearanceContext() {
  return useContext(AppearanceContext);
}
