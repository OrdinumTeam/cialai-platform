// SPDX-License-Identifier: Apache-2.0
// Runtime da barra de IA.
//
// A barra e desenhada dentro da propria janela, entao aqui fica so o que o
// resto da casca precisa: as preferencias, para a toolbar e as Preferencias,
// e as acoes que o menu nativo, a paleta e os atalhos guardam. As acoes sao
// invokes estaveis, sem estado, no molde de shell-bridge.js.

import { useEffect, useState } from 'react';
import { invoke, isTauri, listen } from '../lib/native.js';

const runtime = {
  prefs: null,
  profiles: [],
  listeners: new Set(),
  subscribed: false,
};

function emit() {
  runtime.listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.error('[notch]', error); }
  });
}

export function subscribeNotch(listener) {
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

/// Le o estado uma vez e passa a seguir `notch://prefs`. Fora do app nao ha
/// o que ler: a toolbar fica sem o botao e as Preferencias usam o padrao.
export function ensureSubscribed() {
  if (runtime.subscribed || !isTauri()) return;
  runtime.subscribed = true;
  invoke('notch_state')
    .then((state) => {
      if (!state) return;
      runtime.prefs = state.prefs || null;
      runtime.profiles = Array.isArray(state.allProfiles) ? state.allProfiles : [];
      emit();
    })
    .catch(() => {});
  listen('notch://prefs', (prefs) => {
    if (!prefs) return;
    runtime.prefs = prefs;
    emit();
  }).catch(() => {});
}

/// Acoes estaveis, para o menu nativo, o botao de menu, a paleta e os
/// atalhos.
export const notchActions = {
  refresh: (profileId) => invoke('notch_refresh', { profileId: profileId || null }),
  state: () => invoke('notch_state'),
  setPrefs: async (next) => {
    const saved = await invoke('notch_set_prefs', { next });
    runtime.prefs = saved || next;
    emit();
    return runtime.prefs;
  },
  setVisibility: async (visibility) => {
    const saved = await invoke('notch_set_visibility', { visibility });
    if (runtime.prefs) runtime.prefs = { ...runtime.prefs, visibility: saved || visibility };
    emit();
    return saved;
  },
  /// Aberta vira recolhida; qualquer outro estado vira aberta.
  toggle: async () => {
    const current = runtime.prefs?.visibility || (await invoke('notch_state'))?.prefs?.visibility || 'open';
    return notchActions.setVisibility(current === 'open' ? 'collapsed' : 'open');
  },
};

/// Preferencias da barra, para a toolbar e as Preferencias.
export function useNotch() {
  const [value, setValue] = useState(() => ({ prefs: runtime.prefs, profiles: runtime.profiles }));
  useEffect(() => {
    ensureSubscribed();
    setValue({ prefs: runtime.prefs, profiles: runtime.profiles });
    return subscribeNotch(() => setValue({ prefs: runtime.prefs, profiles: runtime.profiles }));
  }, []);
  return value;
}

/// Um pedido da barra para abrir uma sessao do estudio de terminais.
///
/// Quem sabe navegar ate a sessao e a casca: o Rust so publica a tag do PTY
/// daquela sessao.
export function onFocusSession(handler) {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen('notch://focus-session', (payload) => {
    if (payload && payload.ptyTag) handler(payload.ptyTag);
  });
}

/// Um pedido da barra para abrir as Preferencias na secao dela.
export function onOpenSettings(handler) {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen('notch://open-settings', () => handler());
}
