// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { ToastProvider, useToast } from '../components/ui.jsx';
import ContentArea from '../components/ContentArea.jsx';
import { AppearanceContext, useAppearance } from '../desktop/appearance.js';
import { installShellBridge } from '../desktop/shell-bridge.js';
import { buildMacTheme } from '../desktop/theme.macos.js';
import * as remote from '../lib/remote.js';
import { isMobileShell, onShellTheme, shellTheme } from '../lib/shell.js';
import { VIEW_COMPONENTS } from '../views/registry.js';
import MobileHeader from './MobileHeader.jsx';
import { translate } from './i18n.js';
import { useViewportBox } from './keyboard-viewport.js';

function ErrorNotice() {
  const notify = useToast();
  useEffect(() => {
    const report = (event) => notify(event.detail, 'warning');
    window.addEventListener('cialai:mobile-error', report);
    return () => window.removeEventListener('cialai:mobile-error', report);
  }, [notify]);
  return null;
}

export default function MobileApp() {
  const appearance = useAppearance();
  const theme = useMemo(() => buildMacTheme(appearance.resolved), [appearance.resolved]);
  const connection = useSyncExternalStore(remote.subscribeState, remote.state);
  // A casca ocupa exatamente a area visivel de agora, com teclado ou sem.
  const viewport = useViewportBox(true);
  const inShell = isMobileShell();
  useEffect(() => { installShellBridge({ navigate() {}, setSidebarHidden() {}, openPalette() {} }, { sidebarHidden: true }); }, []);
  // A aparencia escolhida nos ajustes do aplicativo vale tambem na pagina:
  // chega no bootstrap e em cada mensagem da casca.
  useEffect(() => {
    const initial = shellTheme();
    if (initial) appearance.setMode(initial);
    return onShellTheme((mode) => appearance.setMode(mode));
  }, [appearance.setMode]);
  const desktopName = connection.desktop?.name || window.__CIALAI_SHELL__?.desktopName || translate('desktop.fallback');
  return <AppearanceContext.Provider value={appearance}><ThemeProvider theme={theme}><CssBaseline enableColorScheme /><ToastProvider><ErrorNotice /><div className={`ios-shell ios-shell--terminal${viewport ? ' ios-shell--viewport' : ''}${viewport?.keyboard ? ' ios-shell--keyboard' : ''}${inShell ? ' ios-shell--native' : ''}`} style={viewport ? { '--ios-viewport-top': `${viewport.top}px`, '--ios-viewport-height': `${viewport.height}px` } : undefined}><MobileHeader desktopName={desktopName} connection={connection.status} compact={inShell} /><main className="ios-content" id="content"><ContentArea ViewComponent={VIEW_COMPONENTS.terminais} viewId="terminais" /></main></div></ToastProvider></ThemeProvider></AppearanceContext.Provider>;
}
