// SPDX-License-Identifier: Apache-2.0
// Navegador de pastas do celular, em tela cheia. Mostra o caminho atual, volta
// para a pasta acima, filtra as subpastas pelo nome e marca a escolhida. Tocar
// numa linha seleciona; a seta entra na pasta. O botão de baixo confirma a
// selecionada ou, sem seleção, a pasta atual.
//
// A listagem é a mesma `list_dirs` do computador, com os limites dele: sem
// caminho, os pontos de partida; pastas ocultas, de segredo e atalhos ficam de
// fora, e o computador recusa o que estiver fora das áreas permitidas.
import React, { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CornerLeftUp, Folder } from 'lucide-react';
import { invoke } from '../../lib/native.js';
import { SearchInput } from '../../mobile/ui.jsx';
import { baseName, shortPath } from '../files.js';
import { translate } from '../../shared/i18n.js';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function filterEntries(entries, query) {
  const needle = normalize(String(query || '').trim());
  return needle ? (entries || []).filter((entry) => normalize(entry.name).includes(needle)) : (entries || []);
}

export default function DirectoryBrowser({ startPath = null, title = null, confirmLabel = null, onConfirm, onClose }) {
  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);

  const openFolder = useCallback((path) => {
    setLoading(true);
    setError(null);
    setQuery('');
    setSelected(null);
    invoke('list_dirs', { path: path || null })
      .then((next) => { setListing(next || { path: '', entries: [] }); })
      .catch((reason) => {
        setError(reason?.message || String(reason));
        setListing((current) => current || { path: '', entries: [] });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { openFolder(startPath); }, [openFolder, startPath]);

  return <DirectoryBrowserView listing={listing} loading={loading} error={error} query={query} selected={selected}
    title={title} confirmLabel={confirmLabel} onQuery={setQuery} onSelect={setSelected} onOpenFolder={openFolder}
    onConfirm={onConfirm} onClose={onClose} />;
}

// Parte visual, com o estado vindo de fora: o gate renderiza cada situação
// sem ponte nem DOM.
export function DirectoryBrowserView({ listing, loading, error, query, selected, title = null, confirmLabel = null, onQuery, onSelect, onOpenFolder, onConfirm, onClose }) {
  const current = listing?.path || '';
  const entries = filterEntries(listing?.entries, query);
  const target = selected || current;
  const label = title || translate('terminal.browser.title');
  const confirm = confirmLabel || (target ? translate('terminal.browser.useNamed', { name: baseName(target) || target }) : translate('terminal.session.useThisFolder'));
  return (
    <div className="phone-flow phone-browser" role="dialog" aria-modal="true" aria-label={label}>
      <header className="phone-flow__header">
        <button type="button" className="phone-icon-btn" aria-label={translate('terminal.newSession.back')} onClick={onClose}><ChevronLeft size={26} aria-hidden="true" /></button>
        <h1>{label}</h1>
        <span className="phone-flow__header-spacer" />
      </header>
      <div className="phone-browser__path">
        <button type="button" className="phone-browser__up" disabled={loading || (!listing?.parent && !current)}
          aria-label={translate('terminal.session.folderUp')} onClick={() => onOpenFolder(listing?.parent || null)}>
          <CornerLeftUp size={18} aria-hidden="true" />
        </button>
        <span className="phone-browser__crumb" title={current}><bdi>{current ? shortPath(current) : translate('terminal.session.startingPoints')}</bdi></span>
      </div>
      <div className="phone-flow__body">
        <SearchInput value={query} onChange={onQuery} placeholder={translate('terminal.browser.filter')} />
        <div className="phone-browser__list" role="radiogroup" aria-label={label} aria-busy={loading || undefined}>
          {loading ? <p className="phone-flow__note">{translate('terminal.session.loadingFolders')}</p> : null}
          {!loading && error ? <p className="phone-flow__note is-bad" role="alert">{error}</p> : null}
          {!loading && !error && !listing?.entries?.length ? <p className="phone-flow__note">{translate('terminal.session.noSubfolder')}</p> : null}
          {!loading && listing?.entries?.length && !entries.length ? <p className="phone-flow__note">{translate('terminal.browser.noMatch')}</p> : null}
          {!loading && entries.map((entry) => {
            const checked = selected === entry.path;
            return (
              <div key={entry.path} className={`phone-browser__row${checked ? ' is-selected' : ''}`}>
                <button type="button" role="radio" aria-checked={checked} className="phone-browser__pick" onClick={() => onSelect(checked ? null : entry.path)}>
                  <span className="phone-flow__radio" aria-hidden="true">{checked ? <Check size={14} strokeWidth={3} /> : null}</span>
                  <Folder size={20} aria-hidden="true" />
                  <span className="phone-browser__name">{entry.name}</span>
                </button>
                <button type="button" className="phone-icon-btn" aria-label={translate('terminal.browser.enter', { name: entry.name })} onClick={() => onOpenFolder(entry.path)}>
                  <ChevronRight size={20} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {!loading && listing?.truncated ? <p className="phone-flow__note">{translate('terminal.session.tooManyFolders')}</p> : null}
        </div>
      </div>
      <footer className="phone-flow__footer">
        <button type="button" className="phone-flow__primary" disabled={loading || !target} onClick={() => onConfirm(target)}>
          {confirm}
        </button>
      </footer>
    </div>
  );
}
