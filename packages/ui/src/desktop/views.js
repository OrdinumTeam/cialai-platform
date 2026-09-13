// SPDX-License-Identifier: Apache-2.0
// Desktop-only routes. The mobile registry remains terminal-only.

import { lazy, useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone, SquareTerminal } from 'lucide-react';
import { translate } from './i18n.js';

export const DEFAULT_DESKTOP_VIEW = 'terminais';
export const DESKTOP_VIEW_COMPONENTS = {
  terminais: lazy(() => import('../views/Terminais.jsx')),
  dispositivos: lazy(() => import('./Devices.jsx')),
};
export function desktopViews() {
  return [
    { id: 'terminais', label: translate('view.terminais.label'), sub: translate('view.terminais.sub'), icon: SquareTerminal },
    { id: 'dispositivos', label: translate('desktop.view.devices.label'), sub: translate('desktop.view.devices.sub'), icon: MonitorSmartphone },
  ];
}

export const DESKTOP_VIEWS = desktopViews();

export function sanitizeDesktopView(id) {
  return DESKTOP_VIEW_COMPONENTS[id] ? id : DEFAULT_DESKTOP_VIEW;
}

export function getDesktopView(id, views = DESKTOP_VIEWS) {
  return views.find((view) => view.id === sanitizeDesktopView(id)) || views[0];
}

function initialView() {
  let stored = '';
  try { stored = localStorage.getItem('cialai_view') || ''; } catch (_error) { /* private browsing */ }
  return sanitizeDesktopView(window.location.hash.replace(/^#/, '') || stored || DEFAULT_DESKTOP_VIEW);
}

export function useDesktopViewRoute() {
  const [view, setView] = useState(initialView);
  const navigate = useCallback((id) => {
    const next = sanitizeDesktopView(id);
    setView(next);
    try { localStorage.setItem('cialai_view', next); } catch (_error) { /* private browsing */ }
    if (window.location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
  }, []);
  useEffect(() => {
    const onHash = () => setView(sanitizeDesktopView(window.location.hash.replace(/^#/, '')));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return { view, navigate };
}
