// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, Monitor, Moon, PanelLeft, PanelRight, PanelRightClose, RefreshCw, Search, Settings, SquareTerminal, Sun } from 'lucide-react';
import { collectPaletteItems } from './palette-registry.js';
import { currentOs, shortcutLabel } from '../lib/keys.js';
import { toggleShortcut } from '../notch/model.js';
import { translate } from './i18n.js';

function normalize(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function score(item, query) {
  if (!query) return 1;
  const label = normalize(item.label); const kind = normalize(item.kind);
  if (label.startsWith(query)) return 100;
  if (label.includes(query)) return 60;
  if (kind.includes(query)) return 30;
  let index = 0;
  for (const char of query) { index = label.indexOf(char, index); if (index < 0) return 0; index += 1; }
  return 10;
}
function rank(items, rawQuery) {
  const query = normalize(rawQuery.trim());
  return items.map((item, order) => ({ item, order, points: score(item, query) })).filter((entry) => entry.points > 0).sort((a, b) => b.points - a.points || a.order - b.order).map((entry) => entry.item);
}

export default function CommandPalette({ open, onClose, views, actions, appearance }) {
  const [query, setQuery] = useState(''); const [index, setIndex] = useState(0); const [provided, setProvided] = useState([]);
  const inputRef = useRef(null); const listRef = useRef(null);
  const items = useMemo(() => [
    ...provided,
    ...views.map((view) => ({ id: `view:${view.id}`, kind: translate('desktop.palette.section'), label: view.label, hint: view.sub, icon: view.icon, run: () => actions.navigate(view.id) })),
    { id: 'reload', kind: translate('desktop.palette.action'), label: translate('desktop.action.reloadBrowser'), shortcut: shortcutLabel('Mod+R'), icon: RefreshCw, run: actions.reloadData },
    { id: 'sidebar', kind: translate('desktop.palette.action'), label: translate('desktop.action.toggleSidebar'), shortcut: currentOs() === 'macos' ? shortcutLabel('Ctrl+Mod+S') : null, icon: PanelLeft, run: actions.toggleSidebar },
    { id: 'notch-toggle', kind: translate('desktop.palette.action'), label: translate('desktop.notch.action.toggle'), shortcut: shortcutLabel(toggleShortcut(currentOs())), icon: PanelRight, run: actions.toggleNotch },
    { id: 'notch-hide', kind: translate('desktop.palette.action'), label: translate('desktop.notch.action.hide'), icon: PanelRightClose, run: actions.hideNotch },
    { id: 'prefs', kind: translate('desktop.palette.action'), label: translate('desktop.preferences.title'), shortcut: shortcutLabel('Mod+Comma'), icon: Settings, run: actions.openPreferences },
    { id: 'new-terminal', kind: translate('view.terminais.label'), label: translate('desktop.action.newTerminal'), shortcut: shortcutLabel('Mod+T'), icon: SquareTerminal, run: actions.newTerminal },
    { id: 'new-file', kind: translate('view.terminais.label'), label: translate('desktop.action.newTemporaryFile'), shortcut: shortcutLabel('Mod+N'), icon: FilePlus2, run: actions.newFile },
    { id: 'ap-system', kind: translate('desktop.preferences.appearance'), label: translate('desktop.appearance.system'), icon: Monitor, run: () => appearance.setMode('system') },
    { id: 'ap-light', kind: translate('desktop.preferences.appearance'), label: translate('desktop.appearance.light'), icon: Sun, run: () => appearance.setMode('light') },
    { id: 'ap-dark', kind: translate('desktop.preferences.appearance'), label: translate('desktop.appearance.dark'), icon: Moon, run: () => appearance.setMode('dark') },
  ], [views, actions, appearance, provided]);
  const filtered = useMemo(() => rank(items, query), [items, query]);
  useEffect(() => { if (!open) return undefined; setQuery(''); setIndex(0); setProvided(collectPaletteItems()); const timer = setTimeout(() => inputRef.current?.focus(), 20); return () => clearTimeout(timer); }, [open]);
  useEffect(() => { listRef.current?.children?.[index]?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  if (!open) return null;
  const run = (item) => { onClose(); item.run?.(); };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, filtered.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (filtered[index]) run(filtered[index]); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };
  return <div className="mac-palette-backdrop" onMouseDown={onClose}><div className="mac-palette" role="dialog" aria-label={translate('desktop.palette.title')} onMouseDown={(event) => event.stopPropagation()}><div className="mac-palette__search"><Search size={17} strokeWidth={2} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown} placeholder={translate('desktop.palette.title')} spellCheck={false} aria-label={translate('desktop.action.search')} /><kbd>{shortcutLabel('Escape')}</kbd></div><ul className="mac-palette__list" role="listbox" ref={listRef}>{filtered.length === 0 && <li className="mac-palette__empty">{translate('desktop.palette.empty')}</li>}{filtered.map((item, position) => { const Icon = item.icon; const active = position === index; return <li key={item.id} role="option" aria-selected={active} className={`mac-palette__item${active ? ' is-active' : ''}`} onMouseEnter={() => setIndex(position)} onClick={() => run(item)}><Icon size={15} strokeWidth={1.75} className="mac-palette__icon" aria-hidden="true" /><span className="mac-palette__label">{item.label}</span><span className="mac-palette__kind">{item.hint || item.kind}</span>{item.shortcut && <kbd className="mac-palette__shortcut">{item.shortcut}</kbd>}</li>; })}</ul></div></div>;
}
