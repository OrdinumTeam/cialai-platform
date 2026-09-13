// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, Monitor, Moon, PanelLeft, RefreshCw, Search, Settings, SquareTerminal, Sun } from 'lucide-react';
import { collectPaletteItems } from './palette-registry.js';
import { currentOs, shortcutLabel } from '../lib/keys.js';

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
    ...views.map((view) => ({ id: `view:${view.id}`, kind: 'Seção', label: view.label, hint: view.sub, icon: view.icon, run: () => actions.navigate(view.id) })),
    { id: 'reload', kind: 'Ação', label: 'Recarregar navegador ativo', shortcut: shortcutLabel('Mod+R'), icon: RefreshCw, run: actions.reloadData },
    { id: 'sidebar', kind: 'Ação', label: 'Mostrar ou ocultar barra lateral', shortcut: currentOs() === 'macos' ? shortcutLabel('Ctrl+Mod+S') : null, icon: PanelLeft, run: actions.toggleSidebar },
    { id: 'prefs', kind: 'Ação', label: 'Preferências', shortcut: shortcutLabel('Mod+Comma'), icon: Settings, run: actions.openPreferences },
    { id: 'new-terminal', kind: 'Terminais', label: 'Novo terminal', shortcut: shortcutLabel('Mod+T'), icon: SquareTerminal, run: actions.newTerminal },
    { id: 'new-file', kind: 'Terminais', label: 'Novo arquivo temporário', shortcut: shortcutLabel('Mod+N'), icon: FilePlus2, run: actions.newFile },
    { id: 'ap-system', kind: 'Aparência', label: 'Seguir o sistema', icon: Monitor, run: () => appearance.setMode('system') },
    { id: 'ap-light', kind: 'Aparência', label: 'Aparência clara', icon: Sun, run: () => appearance.setMode('light') },
    { id: 'ap-dark', kind: 'Aparência', label: 'Aparência escura', icon: Moon, run: () => appearance.setMode('dark') },
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
  return <div className="mac-palette-backdrop" onMouseDown={onClose}><div className="mac-palette" role="dialog" aria-label="Buscar comandos" onMouseDown={(event) => event.stopPropagation()}><div className="mac-palette__search"><Search size={17} strokeWidth={2} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown} placeholder="Buscar comandos" spellCheck={false} aria-label="Buscar" /><kbd>{shortcutLabel('Escape')}</kbd></div><ul className="mac-palette__list" role="listbox" ref={listRef}>{filtered.length === 0 && <li className="mac-palette__empty">Nada encontrado</li>}{filtered.map((item, position) => { const Icon = item.icon; const active = position === index; return <li key={item.id} role="option" aria-selected={active} className={`mac-palette__item${active ? ' is-active' : ''}`} onMouseEnter={() => setIndex(position)} onClick={() => run(item)}><Icon size={15} strokeWidth={1.75} className="mac-palette__icon" aria-hidden="true" /><span className="mac-palette__label">{item.label}</span><span className="mac-palette__kind">{item.hint || item.kind}</span>{item.shortcut && <kbd className="mac-palette__shortcut">{item.shortcut}</kbd>}</li>; })}</ul></div></div>;
}
