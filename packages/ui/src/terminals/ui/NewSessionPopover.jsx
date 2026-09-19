// SPDX-License-Identifier: Apache-2.0
// Seletor de pasta para uma sessão nova: recentes, raízes configuradas e
// busca, com um nome opcional. Cada raiz oferece também a si mesma, porque
// abrir uma sessão na própria raiz era impossível: a lista mostrava só as
// subpastas de primeiro nível dela.
//
// O modo navegar cobre o resto do disco dentro dos limites do servidor: uma
// trilha de pastas, Pasta acima, Usar esta pasta e descida por toque, servido
// por `list_dirs`. Ele existe no computador e no celular, onde o diálogo
// nativo não existe. "Escolher outra pasta" continua abrindo o diálogo do
// sistema, só no Tauri. Popover por portal em body, fora da região de arrasto
// da toolbar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerLeftUp, FolderOpen, FolderSearch, FolderTree, Search } from 'lucide-react';
import { invoke, isTauri, hasBridge } from '../../lib/native.js';
import { isPhone } from '../../lib/shell.js';
import { getRecent, isDemo } from '../runtime.js';
import { baseName, portablePath, shortPath } from '../files.js';
import { translate, useI18n } from '../../shared/i18n.js';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Nome da pasta que contém esta. O caminho pode chegar do diálogo do
// Windows, com barra invertida, então passa pela forma portátil antes.
function parentName(path) {
  const parts = portablePath(path).replace(/\/+$/, '').split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

// Grupos da lista: recentes primeiro, depois uma seção por raiz de projeto.
// Cada raiz oferece também a si mesma, antes das subpastas: com a raiz
// apontando para Documentos, abrir uma sessão na própria Documentos não tinha
// caminho nenhum, e era exatamente o caso relatado.
export function folderGroups({ recent = [], repos = null, query = '' }) {
  const needle = normalize(String(query).trim());
  const matches = (item) => !needle || normalize(item.name).includes(needle) || normalize(item.path).includes(needle);
  const result = [];
  const recentItems = recent.map((path) => ({ path, name: baseName(path) || path })).filter(matches);
  if (recentItems.length) result.push({ label: translate('terminal.session.recent'), items: recentItems, showParent: true });
  for (const root of repos?.roots || []) {
    const own = root.exists && matches({ name: root.label, path: root.path })
      ? [{ path: root.path, name: root.label, self: true }]
      : [];
    const items = (repos?.repos || []).filter((repo) => repo.root === root.label).filter(matches);
    if (own.length || items.length) result.push({ label: root.label, items: [...own, ...items], showParent: false });
  }
  return result;
}

export default function NewSessionPopover({ anchor, onClose, onPick, onBrowse, startPath = null, title = null, confirmLabel = null }) {
  const { locale } = useI18n();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [repos, setRepos] = useState(null);
  const [index, setIndex] = useState(0);
  // `null` fora do modo navegar. Dentro dele, o que `list_dirs` devolveu.
  const [browse, setBrowse] = useState(null);
  const [browseError, setBrowseError] = useState(null);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  // Abre uma pasta no modo navegar. Sem caminho, o servidor devolve os pontos
  // de partida: pasta pessoal, raízes de projeto e volumes.
  const openFolder = useCallback((path) => {
    setBrowseError(null);
    setBrowse((current) => ({ ...(current || {}), loading: true }));
    invoke('list_dirs', { path: path || null })
      .then((listing) => setBrowse({ ...listing, loading: false }))
      .catch((error) => {
        setBrowseError(error?.message || String(error));
        setBrowse((current) => ({ ...(current || { path: '', entries: [] }), loading: false }));
      });
  }, []);

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

  const groups = useMemo(() => folderGroups({ recent: getRecent(), repos, query }), [repos, query, locale]);

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

  const label = title || translate('terminal.session.new');
  if (browse) {
    const current = browse.path || '';
    return createPortal(
      <div className="terminais-pop terminais-pop--browse" ref={boxRef} role="dialog" aria-label={translate('terminal.session.browseFolders')} style={style}>
        <div className="terminais-pop__trail">
          <button
            type="button"
            className="terminais-pop__up"
            disabled={!browse.parent && !current}
            aria-label={translate('terminal.session.folderUp')}
            onClick={() => openFolder(browse.parent || null)}
          >
            <CornerLeftUp size={14} strokeWidth={1.75} aria-hidden="true" />{translate('terminal.session.folderUp')}
          </button>
          <span className="terminais-pop__crumb" title={current}>{current ? shortPath(current) : translate('terminal.session.startingPoints')}</span>
        </div>
        <div className="terminais-pop__list" role="listbox">
          {browse.loading ? <div className="terminais-pop__empty">{translate('terminal.session.loadingFolders')}</div> : null}
          {!browse.loading && browseError ? <div className="terminais-pop__empty">{browseError}</div> : null}
          {!browse.loading && !browseError && !browse.entries?.length ? <div className="terminais-pop__empty">{translate('terminal.session.noSubfolder')}</div> : null}
          {(browse.entries || []).map((entry) => (
            <button
              type="button"
              key={entry.path}
              role="option"
              aria-selected={false}
              className="terminais-pop__item"
              onClick={() => openFolder(entry.path)}
              title={shortPath(entry.path)}
            >
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="terminais-pop__name">{entry.name}</span>
            </button>
          ))}
          {browse.truncated ? <div className="terminais-pop__empty">{translate('terminal.session.tooManyFolders')}</div> : null}
        </div>
        <div className="terminais-pop__foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setBrowse(null); setBrowseError(null); }}>{translate('terminal.session.backToList')}</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!current} onClick={() => pick(current)}>{confirmLabel || translate('terminal.session.useThisFolder')}</button>
        </div>
      </div>,
      document.body,
    );
  }

  let running = -1;
  return createPortal(
    <div className="terminais-pop" ref={boxRef} role="dialog" aria-label={label} style={style}>
      <div className="terminais-pop__search">
        <Search size={14} strokeWidth={2} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={translate('terminal.session.searchFolder')}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={translate('terminal.session.searchFolder')}
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
          <div className="terminais-pop__empty">{translate(repos ? 'terminal.session.noFolder' : 'terminal.session.loadingFolders')}</div>
        )}
      </div>
      <div className="terminais-pop__namefield">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={translate('terminal.session.optionalName')}
          spellCheck={false}
          autoCorrect="off"
          aria-label={translate('terminal.session.name')}
        />
      </div>
      <div className="terminais-pop__foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openFolder(startPath || null)}><FolderTree size={13} />{translate('terminal.session.browseFolders')}</button>
        {isTauri() && onBrowse ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBrowse(name.trim())}><FolderSearch size={13} />{translate('terminal.session.chooseFolder')}</button> : null}
      </div>
    </div>,
    document.body,
  );
}
