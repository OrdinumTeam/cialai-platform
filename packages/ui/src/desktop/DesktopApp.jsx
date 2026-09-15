// SPDX-License-Identifier: Apache-2.0
// Cialai desktop shell. The terminal runtime owns its hydration lifecycle and
// is independent from the removed Control business services.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { ToastProvider } from '../components/ui.jsx';
import ContentArea from '../components/ContentArea.jsx';
import { closeCurrentWindow, invoke, isTauri, watchFullscreen } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import { AppearanceContext, useAppearance } from './appearance.js';
import CommandPalette from './CommandPalette.jsx';
import { installDomShortcuts, installNativeMenu } from './menu.js';
import Preferences from './Preferences.jsx';
import Onboarding, { shouldShowOnboarding } from './Onboarding.jsx';
import PairingDialog from './PairingDialog.jsx';
import Sidebar from './Sidebar.jsx';
import { installShellBridge } from './shell-bridge.js';
import Splash from './Splash.jsx';
import { buildMacTheme } from './theme.macos.js';
import Toolbar from './Toolbar.jsx';
import { TunnelProvider, useTunnel } from './TunnelContext.jsx';
import { useI18n } from './i18n.js';
import { DESKTOP_VIEW_COMPONENTS, desktopViews, getDesktopView, useDesktopViewRoute } from './views.js';
import { windowChrome } from './window-chrome.js';

const BOOT_RUNTIME_LIMIT_MS = 1500;
const BOOT_GROW_TIMEOUT_MS = 1600;
const SPLASH_FADE_MS = 420;
const SIDEBAR_KEY = 'cialai_sidebar';

function readStored(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch (_error) { return fallback; }
}

function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch (_error) { /* storage unavailable */ }
}

function useEscapeGuard() {
  useEffect(() => {
    if (!windowChrome(platform().os).escapeGuard) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

function useBoot() {
  const [boot, setBoot] = useState('splash');
  const [runtimeStatus, setRuntimeStatus] = useState('loading');
  const [splashMounted, setSplashMounted] = useState(true);
  const holdSplash = useRef(new URLSearchParams(window.location.search).get('boot') === 'splash');

  useEffect(() => {
    const readyTimer = setTimeout(() => { invoke('splash_ready').catch(() => {}); }, 40);
    if (holdSplash.current) return () => clearTimeout(readyTimer);
    let cancelled = false;
    const limit = new Promise((resolve) => setTimeout(resolve, BOOT_RUNTIME_LIMIT_MS));
    import('../terminals/runtime.js')
      .then((runtime) => Promise.race([runtime.hydrate(), limit]))
      .then(() => { if (!cancelled) { setRuntimeStatus('ready'); setBoot('grow'); } })
      .catch(() => { if (!cancelled) { setRuntimeStatus('error'); setBoot('grow'); } });
    return () => { cancelled = true; clearTimeout(readyTimer); };
  }, []);

  useEffect(() => {
    if (boot !== 'grow') return undefined;
    let cancelled = false;
    const timeout = new Promise((resolve) => setTimeout(resolve, BOOT_GROW_TIMEOUT_MS));
    Promise.race([invoke('window_grow').catch(() => false), timeout]).then(() => {
      if (!cancelled) setBoot('ready');
    });
    return () => { cancelled = true; };
  }, [boot]);

  useEffect(() => {
    if (boot !== 'ready') return undefined;
    const timer = setTimeout(() => setSplashMounted(false), SPLASH_FADE_MS);
    return () => clearTimeout(timer);
  }, [boot]);

  return { boot, runtimeStatus, splashMounted };
}

function DesktopShell() {
  const { locale } = useI18n();
  const views = useMemo(desktopViews, [locale]);
  const appearance = useAppearance();
  const tunnel = useTunnel();
  const theme = useMemo(() => buildMacTheme(appearance.resolved), [appearance.resolved]);
  const { view, navigate } = useDesktopViewRoute();
  const viewRef = useRef(view);
  viewRef.current = view;
  const [sidebarHidden, setSidebarHidden] = useState(() => readStored(SIDEBAR_KEY) === 'true');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(shouldShowOnboarding);
  const { boot, runtimeStatus, splashMounted } = useBoot();
  useEscapeGuard();

  const toggleSidebar = useCallback(() => {
    setSidebarHidden((hidden) => {
      writeStored(SIDEBAR_KEY, String(!hidden));
      return !hidden;
    });
  }, []);
  const setSidebarHiddenTransient = useCallback((hidden) => setSidebarHidden(Boolean(hidden)), []);
  const reloadData = useCallback(() => {
    if (viewRef.current !== 'terminais') return;
    import('../terminals/browser/runtime.js').then((browser) => browser.reloadActive()).catch(() => {});
  }, []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openPreferences = useCallback(() => setPrefsOpen(true), []);
  const openPair = useCallback(() => setPairOpen(true), []);
  const newTerminal = useCallback(() => {
    navigate('terminais');
    import('../terminals/runtime.js').then((runtime) => runtime.requestNewTerminal()).catch(() => {});
  }, [navigate]);
  const newFile = useCallback(() => {
    navigate('terminais');
    import('../terminals/runtime.js').then((runtime) => runtime.requestNewFile()).catch(() => {});
  }, [navigate]);
  const closeWindow = useCallback(() => { closeCurrentWindow().catch(() => {}); }, []);
  const quitApp = useCallback(() => { invoke('app_request_quit').catch(() => {}); }, []);
  const closeActiveTerminalOrWindow = useCallback(() => {
    if (viewRef.current !== 'terminais') { closeWindow(); return; }
    import('../terminals/runtime.js')
      .then((runtime) => { if (!runtime.closeActive()) closeWindow(); })
      .catch(closeWindow);
  }, [closeWindow]);
  const completeOnboarding = useCallback((root, options = {}) => {
    setOnboardingOpen(false);
    navigate('terminais');
    import('../terminals/runtime.js').then((runtime) => runtime.openSession(root)).catch(() => {});
    if (options.openPair) setPairOpen(true);
  }, [navigate]);

  const actions = useMemo(() => ({
    navigate, toggleSidebar, reloadData, openPalette, openPreferences, openPair,
    setAppearance: appearance.setMode, newTerminal, newFile,
    closeActiveTerminalOrWindow, closeWindow, quitApp,
  }), [navigate, toggleSidebar, reloadData, openPalette, openPreferences, openPair, appearance.setMode, newTerminal, newFile, closeActiveTerminalOrWindow, closeWindow, quitApp]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Menu, diálogos e mensagens do núcleo seguem o idioma da interface.
  useEffect(() => {
    if (isTauri()) invoke('app_set_locale', { locale }).catch((error) => console.error('[locale]', error));
  }, [locale]);
  useEffect(() => {
    installNativeMenu(actionsRef, views, locale).catch((error) => console.error('[menu]', error));
    return installDomShortcuts(actionsRef, views);
  }, [locale, views]);
  useEffect(() => {
    installShellBridge({ setSidebarHidden: setSidebarHiddenTransient, openPalette, navigate }, { sidebarHidden });
  }, [setSidebarHiddenTransient, openPalette, navigate, sidebarHidden]);
  useEffect(() => {
    let disposed = false;
    let off = null;
    watchFullscreen((value) => {
      if (!disposed) document.documentElement.setAttribute('data-fullscreen', value ? 'true' : 'false');
    }).then((release) => { if (disposed) release(); else off = release; }).catch(() => {});
    return () => { disposed = true; off?.(); };
  }, []);

  const { setAdvancedOpen } = tunnel;
  useEffect(() => {
    const pair = () => setPairOpen(true);
    // Preferências e o painel de acesso levam ao diagnóstico avançado em Dispositivos.
    const diagnostics = () => { setPrefsOpen(false); navigate('dispositivos'); setAdvancedOpen(true); };
    window.addEventListener('cialai:pair-device', pair);
    window.addEventListener('cialai:network-diagnostics', diagnostics);
    return () => { window.removeEventListener('cialai:pair-device', pair); window.removeEventListener('cialai:network-diagnostics', diagnostics); };
  }, [navigate, setAdvancedOpen]);

  const active = getDesktopView(view, views);
  const ViewComponent = DESKTOP_VIEW_COMPONENTS[active.id];
  return (
    <AppearanceContext.Provider value={appearance}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <ToastProvider>
          <div className={`mac-window${sidebarHidden ? ' mac-window--sidebar-hidden' : ''}${boot === 'ready' ? ' is-booted' : ''}${boot === 'splash' ? ' is-booting' : ''}`}>
            <Sidebar views={views} active={active.id} onNavigate={navigate} hidden={sidebarHidden} tunnelStatus={tunnel.status} onOpenPair={openPair} onOpenPreferences={openPreferences} />
            <div className="mac-main">
              <Toolbar view={active} sidebarHidden={sidebarHidden} onToggleSidebar={toggleSidebar} onOpenPalette={openPalette} onReload={reloadData} appearance={appearance} onOpenPreferences={openPreferences} tunnelStatus={tunnel.status} onOpenPair={openPair} menuActions={actions} views={views} />
              <main className="mac-content" id="content"><ContentArea ViewComponent={ViewComponent} viewId={active.id} /></main>
            </div>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} views={views} actions={actions} appearance={appearance} />
            <Preferences open={prefsOpen} onClose={() => setPrefsOpen(false)} appearance={appearance} />
            <PairingDialog open={pairOpen} onClose={() => setPairOpen(false)} onDevices={() => navigate('dispositivos')} />
            {onboardingOpen && boot === 'ready' ? <Onboarding onComplete={completeOnboarding} /> : null}
            {splashMounted ? <Splash status={runtimeStatus} leaving={boot !== 'splash'} /> : null}
          </div>
        </ToastProvider>
      </ThemeProvider>
    </AppearanceContext.Provider>
  );
}

export default function DesktopApp() {
  return <TunnelProvider><DesktopShell /></TunnelProvider>;
}
