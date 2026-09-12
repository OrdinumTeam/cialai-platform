// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { sanitizeView } from '../views/registry.js';

function initialView() {
  let stored = '';
  try { stored = localStorage.getItem('cialai_view') || ''; } catch (_) { /* private browsing */ }
  return sanitizeView(window.location.hash.replace(/^#/, '') || stored || 'terminais');
}

export function useViewRoute() {
  const [view, setView] = useState(initialView);
  const navigate = useCallback((id) => {
    const next = sanitizeView(id);
    setView(next);
    try { localStorage.setItem('cialai_view', next); } catch (_) { /* private browsing */ }
    if (window.location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
  }, []);
  useEffect(() => {
    const onHash = () => setView(sanitizeView(window.location.hash.replace(/^#/, '')));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return { view, navigate };
}
