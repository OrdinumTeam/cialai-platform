// SPDX-License-Identifier: Apache-2.0
// Desktop-only routes. The mobile registry remains terminal-only.

import { lazy, useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone, SquareTerminal } from 'lucide-react';

export const DEFAULT_DESKTOP_VIEW = 'terminais';
export const DESKTOP_VIEW_COMPONENTS = {
  terminais: lazy(() => import('../views/Terminais.jsx')),
  dispositivos: lazy(() => import('./Devices.jsx')),
};
export const DESKTOP_VIEWS = [
  { id: 'terminais', label: 'Terminais', sub: 'Sessões, arquivos e navegador', icon: SquareTerminal },
  { id: 'dispositivos', label: 'Dispositivos', sub: 'Rede privada e celulares', icon: MonitorSmartphone },
];

export function sanitizeDesktopView(id) {
  return DESKTOP_VIEW_COMPONENTS[id] ? id : DEFAULT_DESKTOP_VIEW;
}

export function getDesktopView(id) {
  return DESKTOP_VIEWS.find((view) => view.id === sanitizeDesktopView(id)) || DESKTOP_VIEWS[0];
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
