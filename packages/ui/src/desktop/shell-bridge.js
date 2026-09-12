// SPDX-License-Identifier: Apache-2.0
// Ponte entre as views e a casca. A casca registra aqui o que uma view pode
// pedir a ela, como recolher a barra lateral no modo foco, sem a view
// receber props da casca. O objeto e estavel; os handlers sao trocados no
// lugar a cada render do DesktopApp.

const bridge = {
  handlers: {},
  listeners: new Set(),
  sidebarHidden: false,
};

export function installShellBridge(handlers, snapshot) {
  bridge.handlers = handlers || {};
  const changed = snapshot && snapshot.sidebarHidden !== bridge.sidebarHidden;
  if (snapshot) bridge.sidebarHidden = Boolean(snapshot.sidebarHidden);
  if (changed) bridge.listeners.forEach((listener) => { try { listener(); } catch (_error) { /* ouvinte defeituoso */ } });
}

export const shell = {
  isSidebarHidden: () => bridge.sidebarHidden,
  setSidebarHidden: (hidden) => bridge.handlers.setSidebarHidden?.(Boolean(hidden)),
  openPalette: () => bridge.handlers.openPalette?.(),
  navigate: (viewId) => bridge.handlers.navigate?.(viewId),
  subscribe: (listener) => {
    bridge.listeners.add(listener);
    return () => bridge.listeners.delete(listener);
  },
};
