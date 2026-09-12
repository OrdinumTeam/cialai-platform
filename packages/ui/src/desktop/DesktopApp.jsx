// SPDX-License-Identifier: Apache-2.0
// Cialai desktop shell. The terminal runtime owns its hydration lifecycle and
// is independent from the removed Control business services.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { ToastProvider } from '../components/ui.jsx';
import ContentArea from '../components/ContentArea.jsx';
import { closeCurrentWindow, invoke, watchFullscreen } from '../lib/native.js';
import { useViewRoute } from '../lib/useViewRoute.js';
import { VIEWS, VIEW_COMPONENTS, getView } from '../views/registry.js';
import { AppearanceContext, useAppearance } from './appearance.js';
import CommandPalette from './CommandPalette.jsx';
import { installDomShortcuts, installNativeMenu } from './menu.js';
import Preferences from './Preferences.jsx';
import Onboarding, { shouldShowOnboarding } from './Onboarding.jsx';
import Sidebar from './Sidebar.jsx';
import { installShellBridge } from './shell-bridge.js';
import Splash from './Splash.jsx';
import { buildMacTheme } from './theme.macos.js';
import Toolbar from './Toolbar.jsx';

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
    if (document.documentElement.dataset.platform !== 'macos') return undefined;
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

export default function DesktopApp() {
  const appearance = useAppearance();
  const theme = useMemo(() => buildMacTheme(appearance.resolved), [appearance.resolved]);
  const { view, navigate } = useViewRoute();
  const viewRef = useRef(view);
  viewRef.current = view;
  const [sidebarHidden, setSidebarHidden] = useState(() => readStored(SIDEBAR_KEY) === 'true');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
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
  const completeOnboarding = useCallback((root) => {
    setOnboardingOpen(false);
    navigate('terminais');
    import('../terminals/runtime.js').then((runtime) => runtime.openSession(root)).catch(() => {});
  }, [navigate]);

  const actions = useMemo(() => ({
    navigate, toggleSidebar, reloadData, openPalette, openPreferences,
    setAppearance: appearance.setMode, newTerminal, newFile,
    closeActiveTerminalOrWindow, closeWindow, quitApp,
  }), [navigate, toggleSidebar, reloadData, openPalette, openPreferences, appearance.setMode, newTerminal, newFile, closeActiveTerminalOrWindow, closeWindow, quitApp]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    installNativeMenu(actionsRef).catch((error) => console.error('[menu]', error));
    return installDomShortcuts(actionsRef);
  }, []);
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

  const active = getView(view);
  const ViewComponent = VIEW_COMPONENTS[active.id];
  return (
    <AppearanceContext.Provider value={appearance}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <ToastProvider>
          <div className={`mac-window${sidebarHidden ? ' mac-window--sidebar-hidden' : ''}${boot === 'ready' ? ' is-booted' : ''}${boot === 'splash' ? ' is-booting' : ''}`}>
            <Sidebar views={VIEWS} active={active.id} onNavigate={navigate} hidden={sidebarHidden} />
            <div className="mac-main">
              <Toolbar view={active} sidebarHidden={sidebarHidden} onToggleSidebar={toggleSidebar} onOpenPalette={openPalette} onReload={reloadData} appearance={appearance} onOpenPreferences={openPreferences} />
              <main className="mac-content" id="content"><ContentArea ViewComponent={ViewComponent} viewId={active.id} /></main>
            </div>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} views={VIEWS} actions={actions} appearance={appearance} />
            <Preferences open={prefsOpen} onClose={() => setPrefsOpen(false)} appearance={appearance} />
            {onboardingOpen && boot === 'ready' ? <Onboarding onComplete={completeOnboarding} /> : null}
            {splashMounted ? <Splash status={runtimeStatus} leaving={boot !== 'splash'} /> : null}
          </div>
        </ToastProvider>
      </ThemeProvider>
    </AppearanceContext.Provider>
  );
}
