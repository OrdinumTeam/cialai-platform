// SPDX-License-Identifier: Apache-2.0
// A barra de IA: um painel reto na direita da area de conteudo.
//
// E mais um painel da casca, como a sidebar e os paineis do estudio: mesmo
// fundo, mesmo separador, mesmos tons de texto, e acompanha o tema claro ou
// escuro. Aberta mostra um anel por perfil; recolhida vira uma tira com um
// ponto por perfil, para o estado continuar a vista; escondida sai do layout
// e o botao da toolbar a traz de volta.
//
// Os dados chegam por evento do Rust. O hover e do DOM, e o detalhe abre num
// popover ao lado da celula sob o ponteiro.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { invoke, isTauri, listen } from '../lib/native.js';
import { useI18n } from '../desktop/i18n.js';
import ProviderCell from './ProviderCell.jsx';
import NotchCard from './NotchCard.jsx';
import { BAR_WIDTH, cardPlacement, cellState, createHoverScheduler } from './model.js';
import { demoScenario, demoState } from './fixtures.js';
import './notch.css';

/// Relogio dos textos de reset e de tempo decorrido.
const CLOCK_MS = 10_000;
const EMPTY = { prefs: null, profiles: [], sessions: {}, activity: {}, allProfiles: [] };

export default function NotchBar() {
  const { t, locale } = useI18n();
  const scenario = useMemo(() => demoScenario(), []);
  // `locale` entra na lista para os textos da demonstracao acompanharem o
  // idioma; `t` e estavel.
  const demo = useMemo(() => (scenario ? demoState(t, scenario) : null), [t, scenario, locale]);
  const [state, setState] = useState(() => demo || EMPTY);
  const [hovered, setHovered] = useState(demo ? 0 : -1);
  const [cardTop, setCardTop] = useState(0);
  const [refreshing, setRefreshing] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const bar = useRef(null);
  const cells = useRef([]);
  const hover = useMemo(() => createHoverScheduler(setHovered), []);

  const prefs = state.prefs;

  /* ── estado vindo do Rust ──────────────────────────────────────── */

  useEffect(() => {
    if (demo || !isTauri()) return undefined;
    let alive = true;
    invoke('notch_state').then((value) => { if (alive && value) setState(value); }).catch(() => {});
    const offs = [];
    listen('notch://usage', (payload) => {
      if (Array.isArray(payload)) setState((previous) => ({ ...previous, profiles: payload }));
    }).then((off) => offs.push(off)).catch(() => {});
    listen('notch://sessions', (payload) => {
      if (payload) setState((previous) => ({ ...previous, sessions: payload.byProfile || {}, activity: payload.activity || {} }));
    }).then((off) => offs.push(off)).catch(() => {});
    listen('notch://prefs', (payload) => {
      if (payload) setState((previous) => ({ ...previous, prefs: payload }));
    }).then((off) => offs.push(off)).catch(() => {});
    return () => { alive = false; offs.forEach((off) => off && off()); };
  }, [demo]);

  // Na demonstracao os textos seguem o idioma; a visibilidade escolhida na
  // propria barra sobrevive a troca.
  useEffect(() => {
    if (!demo) return;
    setState((previous) => ({ ...demo, prefs: { ...demo.prefs, visibility: previous.prefs?.visibility || demo.prefs.visibility } }));
  }, [demo]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => hover.dispose(), [hover]);

  // Nas capturas a primeira celula ja nasce sob o ponteiro.
  useEffect(() => {
    if (demo && cells.current[0]) setCardTop(cells.current[0].getBoundingClientRect().top);
  }, [demo]);

  /* ── hover e popover ───────────────────────────────────────────── */

  const enterCell = useCallback((index) => {
    const node = cells.current[index];
    if (node) setCardTop(node.getBoundingClientRect().top);
    hover.enter(index);
  }, [hover]);

  const leave = useCallback(() => hover.leave(), [hover]);
  const keep = useCallback(() => hover.keep(), [hover]);

  /* ── acoes ─────────────────────────────────────────────────────── */

  const refresh = useCallback((snapshot) => {
    setRefreshing(snapshot.id);
    const done = () => setTimeout(() => setRefreshing(null), 380);
    if (demo) { done(); return; }
    invoke('notch_refresh', { profileId: snapshot.id }).catch(() => {}).finally(done);
  }, [demo]);

  const focusSession = useCallback((session) => {
    if (demo) return;
    invoke('notch_focus_session', { sessionId: session.id }).catch(() => {});
  }, [demo]);

  const setVisibility = useCallback((visibility) => {
    if (demo) {
      setState((previous) => ({ ...previous, prefs: { ...previous.prefs, visibility } }));
      return;
    }
    invoke('notch_set_visibility', { visibility }).catch(() => {});
  }, [demo]);

  if (!prefs || prefs.visibility === 'hidden') return null;

  const collapsed = prefs.visibility === 'collapsed';
  const hoveredSnapshot = !collapsed && hovered >= 0 ? state.profiles[hovered] : null;
  const hoveredSessions = hoveredSnapshot ? state.sessions[hoveredSnapshot.id] || [] : [];
  const toggleLabel = collapsed ? t('desktop.notch.action.open') : t('desktop.notch.action.collapse');

  return (
    <aside className={`notch-bar${collapsed ? ' is-collapsed' : ''}`} ref={bar} aria-label={t('desktop.notch.title')}>
      <div className="notch-bar__head">
        <button
          type="button"
          className="notch-bar__toggle"
          onClick={() => setVisibility(collapsed ? 'open' : 'collapsed')}
          title={toggleLabel}
          aria-label={toggleLabel}
        >
          {collapsed ? <ChevronLeft size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
        </button>
      </div>

      {collapsed ? (
        <div className="notch-bar__dots" aria-hidden="true">
          {state.profiles.map((snapshot) => {
            const { band } = cellState(snapshot, prefs);
            const live = state.activity[snapshot.id];
            return (
              <span
                key={snapshot.id}
                className={`notch-bar__dot is-${band}${live && live.state !== 'idle' ? ` is-live is-${live.state}` : ''}`}
                title={snapshot.label}
              />
            );
          })}
        </div>
      ) : (
        <div className="notch-bar__list">
          {state.profiles.length === 0 && <div className="notch-bar__empty">{t('desktop.notch.empty')}</div>}
          {state.profiles.map((snapshot, index) => (
            <ProviderCell
              key={snapshot.id}
              cellRef={(node) => { cells.current[index] = node; }}
              snapshot={snapshot}
              activity={state.activity[snapshot.id] || null}
              hovered={hovered === index}
              refreshing={refreshing === snapshot.id}
              prefs={prefs}
              onClick={() => refresh(snapshot)}
              onEnter={() => enterCell(index)}
              onLeave={leave}
            />
          ))}
        </div>
      )}

      {hoveredSnapshot && (
        <div
          className="notch-card-slot"
          style={cardSlotStyle(bar.current, cardTop)}
          onMouseEnter={keep}
          onMouseLeave={leave}
        >
          <NotchCard snapshot={hoveredSnapshot} sessions={hoveredSessions} now={now} prefs={prefs} onFocusSession={focusSession} />
        </div>
      )}
    </aside>
  );
}

function cardSlotStyle(barNode, cellTop) {
  const barLeft = barNode ? barNode.getBoundingClientRect().left : window.innerWidth - BAR_WIDTH;
  const { top, right, width, maxHeight } = cardPlacement({ barLeft, cellTop, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
  return { position: 'fixed', top: `${top}px`, right: `${right}px`, width: `${width}px`, maxHeight: `${maxHeight}px` };
}
