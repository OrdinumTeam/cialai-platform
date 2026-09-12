// SPDX-License-Identifier: Apache-2.0
// Seletor de pasta para uma sessão nova: recentes, raízes configuradas e
// busca, com um nome opcional. "Escolher outra pasta"
// abre o dialogo nativo. Popover por portal em body, fora da regiao de
// arrasto da toolbar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, FolderSearch, Search } from 'lucide-react';
import { invoke, isTauri, hasBridge } from '../../lib/native.js';
import { isPhone } from '../../lib/shell.js';
import { getRecent, isDemo } from '../runtime.js';
import { baseName, shortPath } from '../files.js';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function parentName(path) {
  const parts = String(path || '').replace(/\/+$/, '').split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

export default function NewSessionPopover({ anchor, onClose, onPick, onBrowse }) {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [repos, setRepos] = useState(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!hasBridge() || isDemo()) { setRepos({ roots: [], repos: [] }); return; }
    invoke('list_repo_dirs')
      .then((listing) => setRepos(listing || { roots: [], repos: [] }))
      .catch(() => setRepos({ roots: [], repos: [] }));
  }, []);

  useEffect(() => {
    // No celular o foco automatico abriria o teclado em cima da lista.
    const timer = isPhone() ? null : setTimeout(() => inputRef.current?.focus(), 20);
    const onDown = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      if (timer != null) clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  const groups = useMemo(() => {
    const needle = normalize(query.trim());
    const matches = (item) => !needle || normalize(item.name).includes(needle) || normalize(item.path).includes(needle);
    const result = [];
    const recent = getRecent().map((path) => ({ path, name: baseName(path) || path })).filter(matches);
    if (recent.length) result.push({ label: 'Recentes', items: recent, showParent: true });
    const roots = repos?.roots || [];
    roots.forEach((root) => {
      const items = (repos?.repos || []).filter((repo) => repo.root === root.label).filter(matches);
      if (items.length) result.push({ label: root.label, items, showParent: false });
    });
    return result;
  }, [repos, query]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  useEffect(() => { setIndex(0); }, [query]);

  const pick = useCallback((path) => { onPick(path, name.trim()); }, [onPick, name]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(flat.length - 1, value + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (flat[index]) pick(flat[index].path);
      else if (!flat.length && isTauri()) onBrowse(name.trim());
    }
  };

  const style = anchor
    ? { top: anchor.top + 6, right: Math.max(8, window.innerWidth - anchor.right) }
    : { top: 58, right: 16 };

  let running = -1;
  return createPortal(
    <div className="terminais-pop" ref={boxRef} role="dialog" aria-label="Nova sessão" style={style}>
      <div className="terminais-pop__search">
        <Search size={14} strokeWidth={2} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Buscar pasta"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Buscar pasta"
        />
      </div>
      <div className="terminais-pop__list" role="listbox">
        {groups.map((group) => (
          <div key={group.label} className="terminais-pop__group">
            <div className="terminais-pop__label">{group.label}</div>
            {group.items.map((item) => {
              running += 1;
              const active = running === index;
              return (
                <button
                  type="button"
                  key={item.path}
                  role="option"
                  aria-selected={active}
                  className={`terminais-pop__item${active ? ' is-active' : ''}`}
                  onClick={() => pick(item.path)}
                  onMouseEnter={() => setIndex(flat.indexOf(item))}
                  title={shortPath(item.path)}
                >
                  <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="terminais-pop__name">{item.name}</span>
                  {group.showParent ? <span className="terminais-pop__meta">{parentName(item.path)}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="terminais-pop__empty">{repos ? 'Nenhuma pasta encontrada' : 'Carregando pastas…'}</div>
        )}
      </div>
      <div className="terminais-pop__namefield">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Nome da sessão, opcional"
          spellCheck={false}
          autoCorrect="off"
          aria-label="Nome da sessão"
        />
      </div>
      {isTauri() && <div className="terminais-pop__foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBrowse(name.trim())}><FolderSearch size={13} />Escolher outra pasta…</button>
      </div>}
    </div>,
    document.body,
  );
}
