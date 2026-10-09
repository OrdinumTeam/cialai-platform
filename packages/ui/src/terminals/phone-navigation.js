// SPDX-License-Identifier: Apache-2.0
export const initialPhoneRoute = () => ({ pane: 'list', sessionId: null, path: null });

// A rota volta depois de recarregar a pagina dentro do mesmo WebView, como
// quando o iOS encerra o processo da página. Fica no sessionStorage: sair da
// aba Terminais desmonta o WebView, e voltar a ela abre na lista de sessões,
// não no terminal que ficou aberto.
export const PHONE_ROUTE_KEY = 'cialai_terminals_phone_route';
const RESTORABLE_PANES = ['terminal', 'files', 'preview'];

export function phoneRouteStorage() {
  try {
    if (typeof window === 'undefined') return null;
    // A rota guardada antes no localStorage deixaria a primeira volta presa no terminal.
    window.localStorage?.removeItem(PHONE_ROUTE_KEY);
    return window.sessionStorage;
  } catch (_error) { return null; }
}

export function readPhoneRoute(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PHONE_ROUTE_KEY) || 'null');
    if (!parsed || !RESTORABLE_PANES.includes(parsed.pane) || typeof parsed.sessionId !== 'string' || !parsed.sessionId) return initialPhoneRoute();
    const path = parsed.pane === 'preview' && typeof parsed.path === 'string' && parsed.path ? parsed.path : null;
    if (parsed.pane === 'preview' && !path) return { pane: 'files', sessionId: parsed.sessionId, path: null };
    return { pane: parsed.pane, sessionId: parsed.sessionId, path };
  } catch (_error) {
    return initialPhoneRoute();
  }
}

export function writePhoneRoute(storage, route) {
  try {
    if (!route?.sessionId) storage?.removeItem(PHONE_ROUTE_KEY);
    else storage?.setItem(PHONE_ROUTE_KEY, JSON.stringify({ pane: route.pane, sessionId: route.sessionId, path: route.path ?? null }));
  } catch (_error) { /* sem storage */ }
}

export function phoneRoute(route, event) {
  if (event.type === 'select') return { pane: 'terminal', sessionId: event.id, path: null };
  if (event.type === 'reset') return initialPhoneRoute();
  if (!route.sessionId) return route;
  if (event.type === 'files') return { ...route, pane: 'files', path: null };
  if (event.type === 'preview') return { ...route, pane: 'preview', path: event.path };
  if (event.type === 'back') {
    if (route.pane === 'preview') return { ...route, pane: 'files', path: null };
    if (route.pane === 'files') return { ...route, pane: 'terminal', path: null };
    return initialPhoneRoute();
  }
  return route;
}
