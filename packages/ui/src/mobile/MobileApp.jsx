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
import { VIEW_COMPONENTS } from '../views/registry.js';
import MobileHeader from './MobileHeader.jsx';
import { useKeyboardBox } from './keyboard-viewport.js';

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
  const keyboard = useKeyboardBox(true);
  useEffect(() => { installShellBridge({ navigate() {}, setSidebarHidden() {}, openPalette() {} }, { sidebarHidden: true }); }, []);
  const desktopName = connection.desktop?.name || window.__CIALAI_SHELL__?.desktopName || 'Computador';
  return <AppearanceContext.Provider value={appearance}><ThemeProvider theme={theme}><CssBaseline enableColorScheme /><ToastProvider><ErrorNotice /><div className={`ios-shell ios-shell--terminal${keyboard ? ' ios-shell--keyboard' : ''}`} style={keyboard ? { '--ios-keyboard-top': `${keyboard.top}px`, '--ios-keyboard-height': `${keyboard.height}px` } : undefined}><MobileHeader desktopName={desktopName} connection={connection.status} /><main className="ios-content" id="content"><ContentArea ViewComponent={VIEW_COMPONENTS.terminais} viewId="terminais" /></main></div></ToastProvider></ThemeProvider></AppearanceContext.Provider>;
}
