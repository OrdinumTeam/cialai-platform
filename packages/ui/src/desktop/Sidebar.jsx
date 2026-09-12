// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { groupViews } from '../views/registry.js';
import logo from '../../../../brand/logo/cialai-mantis-v4-1-head-4k.png';

const GROUPS_KEY = 'cialai_groups_closed';

function readClosedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (_error) { return new Set(); }
}

export default function Sidebar({ views, active, onNavigate, hidden }) {
  const groups = useMemo(() => groupViews(views), [views]);
  const [closed, setClosed] = useState(readClosedGroups);
  const navRef = useRef(null);
  const [indicator, setIndicator] = useState({ y: 0, height: 30, visible: false, settled: false });

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const measure = () => {
      const item = nav.querySelector('.mac-nav-item.is-active');
      if (!item) { setIndicator((previous) => ({ ...previous, visible: false })); return; }
      setIndicator((previous) => ({ ...previous, y: item.offsetTop, height: item.offsetHeight, visible: true }));
    };
    measure();
    const frame = requestAnimationFrame(measure);
    const timer = setTimeout(measure, 260);
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    nav.addEventListener('transitionend', measure);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); observer.disconnect(); nav.removeEventListener('transitionend', measure); };
  }, [active, closed, hidden]);
  useEffect(() => { const timer = setTimeout(() => setIndicator((value) => ({ ...value, settled: true })), 80); return () => clearTimeout(timer); }, []);

  const toggleGroup = useCallback((group) => {
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group); else next.add(group);
      try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...next])); } catch (_error) { /* storage unavailable */ }
      return next;
    });
  }, []);

  let order = 0;
  const renderItem = (view) => {
    const Icon = view.icon; const isActive = active === view.id; const index = order++;
    return <button key={view.id} type="button" className={`mac-nav-item${isActive ? ' is-active' : ''}`} style={{ '--i': index }} onClick={() => onNavigate(view.id)} aria-current={isActive ? 'page' : undefined} title={view.sub}><Icon size={16} strokeWidth={1.75} className="mac-nav-item__icon" aria-hidden="true" /><span className="mac-nav-item__label">{view.label}</span></button>;
  };

  return <aside className={`mac-sidebar${hidden ? ' is-hidden' : ''}`} aria-label="Navegação principal" aria-hidden={hidden}><div className="mac-sidebar__drag" data-tauri-drag-region /><div className="mac-sidebar__brand" data-tauri-drag-region="deep"><img src={logo} alt="" className="mac-sidebar__logo" draggable="false" /><span className="mac-sidebar__brand-name">Cialai</span></div><nav className="mac-sidebar__nav" ref={navRef}><span className={`mac-nav-indicator${indicator.visible ? ' is-visible' : ''}${indicator.settled ? ' is-settled' : ''}`} style={{ transform: `translateY(${indicator.y}px)`, height: indicator.height }} aria-hidden="true" />{groups.map((entry) => {
    if (!entry.group) return entry.views.map(renderItem);
    const collapsed = closed.has(entry.group) && !entry.views.some((view) => view.id === active); const index = order++;
    return <section key={entry.key} className={`mac-nav-group${collapsed ? ' is-collapsed' : ''}`}><button type="button" className="mac-nav-group__header" style={{ '--i': index }} onClick={() => toggleGroup(entry.group)} aria-expanded={!collapsed}><span>{entry.group}</span><ChevronRight size={12} strokeWidth={2} className="mac-nav-group__chevron" aria-hidden="true" /></button><div className="mac-nav-group__items"><div>{entry.views.map(renderItem)}</div></div></section>;
  })}</nav></aside>;
}
