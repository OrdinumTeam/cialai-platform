// SPDX-License-Identifier: Apache-2.0
// Busca rapida de arquivos do projeto da sessao selecionada, no espirito do
// ⌘P dos editores. Usa a busca por nome do Rust, com indice em cache.

import React, { useEffect, useRef, useState } from 'react';
import { File, Folder, Search } from 'lucide-react';
import { baseName, dirName, fs } from '../files.js';
import { translate, useI18n } from '../../shared/i18n.js';

export default function QuickOpen({ root, onClose, onOpenFile, onRevealDir }) {
  useI18n();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    const focus = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(focus);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fs.find(root, query, 40).then((result) => { setItems(result.items || []); setIndex(0); }).catch(() => setItems([]));
    }, 120);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, root]);

  useEffect(() => {
    listRef.current?.children?.[index]?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  const run = (item) => {
    onClose();
    if (item.kind === 'dir') onRevealDir(item.path);
    else onOpenFile(item.path);
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, items.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (items[index]) run(items[index]); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };

  return (
    <div className="mac-palette-backdrop" onMouseDown={onClose}>
      <div className="mac-palette terminais-quick" role="dialog" aria-label={translate('terminal.quickOpen.title')} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mac-palette__search">
          <Search size={17} strokeWidth={2} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={translate('terminal.quickOpen.placeholder', { name: baseName(root) })}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label={translate('terminal.quickOpen.title')}
          />
          <kbd>{translate('terminal.common.escape')}</kbd>
        </div>
        <ul className="mac-palette__list" role="listbox" ref={listRef}>
          {items.length === 0 && <li className="mac-palette__empty">{translate(query ? 'terminal.explorer.nothingFound' : 'terminal.explorer.typeToSearch')}</li>}
          {items.map((item, position) => {
            const active = position === index;
            const Icon = item.kind === 'dir' ? Folder : File;
            const parent = item.relative.includes('/') ? dirName(item.relative) : '';
            return (
              <li
                key={item.path}
                role="option"
                aria-selected={active}
                className={`mac-palette__item${active ? ' is-active' : ''}`}
                onMouseEnter={() => setIndex(position)}
                onClick={() => run(item)}
              >
                <Icon size={15} strokeWidth={1.75} className="mac-palette__icon" aria-hidden="true" />
                <span className="mac-palette__label">{baseName(item.path)}</span>
                <span className="mac-palette__kind">{parent}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
