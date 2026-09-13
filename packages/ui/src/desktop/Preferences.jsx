// SPDX-License-Identifier: Apache-2.0
// Focused preference areas backed by the complete Rust snapshot.

import React, { useEffect, useMemo, useState } from 'react';
import { FolderPlus, RotateCcw, Trash2 } from 'lucide-react';
import { AppModal, useToast } from '../components/ui.jsx';
import { chooseDirectory, chooseFile, invoke, isTauri } from '../lib/native.js';
import {
  addUniquePath,
  DEFAULT_PREFERENCES,
  normalizePreferenceDraft,
  removePath,
  sanitizePreferences,
} from './preferences-model.js';
import NetworkSetup from './NetworkSetup.jsx';
import Updater from './Updater.jsx';

const APPEARANCE_OPTIONS = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
];

function Segmented({ value, options, onChange, ariaLabel }) {
  return <div className="mac-segmented" role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={`mac-segmented__option${value === option.value ? ' is-selected' : ''}`} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function Row({ title, description, wide = false, children }) {
  return <div className={`mac-prefs__row${wide ? ' mac-prefs__row--wide' : ''}`}>
    <div className="mac-prefs__row-text"><div className="mac-prefs__row-title">{title}</div>{description ? <div className="mac-prefs__row-desc">{description}</div> : null}</div>
    <div className="mac-prefs__row-control">{children}</div>
  </div>;
}

const splitLines = (value) => String(value || '').split('\n');
const snapshotKey = (value) => JSON.stringify(sanitizePreferences(value));

export default function Preferences({ open, onClose, appearance }) {
  const notify = useToast();
  const native = isTauri();
  const [draft, setDraft] = useState(null);
  const [savedKey, setSavedKey] = useState('');
  const [effectiveShell, setEffectiveShell] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    const load = native
      ? Promise.all([invoke('get_preferences'), invoke('app_shell')])
      : Promise.resolve([DEFAULT_PREFERENCES, null]);
    load.then(([value, shell]) => {
      if (cancelled) return;
      const next = normalizePreferenceDraft({ ...(value || {}), appearance: appearance.mode });
      setDraft(next);
      setSavedKey(snapshotKey(next));
      setEffectiveShell(shell?.path || '');
    }).catch((loadError) => {
      if (!cancelled) setError(`Não foi possível carregar as preferências: ${loadError?.message || loadError}`);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, native]);

  const currentKey = useMemo(() => draft ? snapshotKey(draft) : '', [draft]);
  const dirty = Boolean(draft && currentKey !== savedKey);
  const updateTerminal = (value) => setDraft((current) => ({ ...current, terminal: { ...current.terminal, ...value } }));

  const changeAppearance = (mode) => {
    appearance.setMode(mode);
    setDraft((current) => current ? { ...current, appearance: mode } : current);
  };

  const close = () => {
    if (draft && dirty) {
      const saved = savedKey ? JSON.parse(savedKey) : null;
      if (saved?.appearance) appearance.setMode(saved.appearance);
    }
    onClose();
  };

  const addProjectRoot = async () => {
    const picked = await chooseDirectory({ title: 'Adicionar pasta de projetos', defaultPath: draft?.projectRoots?.[0] || undefined });
    if (picked) setDraft((current) => ({ ...current, projectRoots: addUniquePath(current.projectRoots, picked) }));
  };

  const pickChromium = async () => {
    const picked = await chooseFile({ title: 'Escolher o executável do Chromium', defaultPath: draft?.devBrowser?.chromiumPath || undefined });
    if (picked) setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: picked } }));
  };

  const save = async () => {
    const next = sanitizePreferences(draft);
    if (next.projectRoots.length === 0) {
      setError('Adicione pelo menos uma pasta de projetos.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = native ? await invoke('set_preferences', { next }) : next;
      const normalized = normalizePreferenceDraft(saved || next);
      setDraft(normalized);
      setSavedKey(snapshotKey(normalized));
      appearance.setMode(normalized.appearance);
      notify(native ? 'Preferências salvas' : 'Prévia atualizada', 'success');
    } catch (saveError) {
      setError(`Não foi possível salvar: ${saveError?.message || saveError}`);
    } finally { setSaving(false); }
  };

  const footer = draft ? <><button type="button" className="btn btn-quiet" disabled={saving} onClick={close}>Cancelar</button><button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar alterações'}</button></> : null;

  return <AppModal open={open} title="Preferências" onClose={close} maxWidth="md" footer={footer}><div className="mac-prefs">
    {loading ? <p className="mac-prefs__note" role="status">Carregando preferências…</p> : null}
    {!loading && !native ? <p className="mac-prefs__note">Esta prévia não grava arquivos. O aplicativo desktop salva todas as opções localmente.</p> : null}
    {draft ? <>
      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Aparência</h3>
        <Row title="Tema da janela" description="Sistema acompanha o modo claro ou escuro do computador."><Segmented value={draft.appearance} options={APPEARANCE_OPTIONS} onChange={changeAppearance} ariaLabel="Tema da janela" /></Row>
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Terminal</h3>
        <Row title="Shell" description={effectiveShell ? `Detectado: ${effectiveShell}` : 'Vazio usa o shell detectado pelo sistema.'}><input className="field__control mac-prefs__input" value={draft.terminal.shell || ''} placeholder={effectiveShell || '/bin/zsh'} spellCheck="false" onChange={(event) => updateTerminal({ shell: event.target.value || null })} aria-label="Caminho do shell" /></Row>
        <Row title="Argumentos" description="Um argumento em cada linha." wide><textarea className="field__control field__control--area mac-prefs__textarea" rows="2" value={draft.terminal.args.join('\n')} spellCheck="false" onChange={(event) => updateTerminal({ args: splitLines(event.target.value) })} aria-label="Argumentos do shell" /></Row>
        <Row title="Idioma" description="Vazio usa o idioma do sistema."><input className="field__control mac-prefs__input" value={draft.terminal.lang || ''} placeholder="pt_BR.UTF-8" spellCheck="false" onChange={(event) => updateTerminal({ lang: event.target.value || null })} aria-label="Idioma do terminal" /></Row>
        <Row title="Prefixos do PATH" description="Um diretório em cada linha." wide><textarea className="field__control field__control--area mac-prefs__textarea" rows="2" value={draft.terminal.pathPrefix.join('\n')} spellCheck="false" onChange={(event) => updateTerminal({ pathPrefix: splitLines(event.target.value) })} aria-label="Prefixos do PATH" /></Row>
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Projetos</h3>
        <p className="mac-prefs__note">Estas pastas alimentam o seletor de sessões e delimitam os arquivos disponíveis no celular.</p>
        <div className="mac-prefs__roots" aria-label="Pastas de projetos">{draft.projectRoots.map((path) => <div className="mac-prefs__root" key={path}><code>{path}</code><button type="button" className="btn btn-quiet btn-sm" disabled={draft.projectRoots.length === 1} onClick={() => setDraft((current) => ({ ...current, projectRoots: removePath(current.projectRoots, path) }))} aria-label={`Remover ${path}`}><Trash2 aria-hidden="true" />Remover</button></div>)}</div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addProjectRoot}><FolderPlus aria-hidden="true" />Adicionar pasta</button>
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Rede</h3>
        <p className="mac-prefs__note">Conecte este computador ao seu Headscale para abrir o estúdio pelo celular.</p>
        <NetworkSetup value={draft.network} onChange={(network) => setDraft((current) => ({ ...current, network }))} />
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Dev Browser</h3>
        <Row title="Executável do Chromium" description="Vazio procura uma instalação compatível automaticamente." wide><input className="field__control mac-prefs__browser-path" value={draft.devBrowser.chromiumPath || ''} placeholder="Detectar automaticamente" spellCheck="false" onChange={(event) => setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: event.target.value || null } }))} aria-label="Executável do Chromium" /></Row>
        <div className="mac-prefs__actions">{draft.devBrowser.chromiumPath ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: null } }))}><RotateCcw aria-hidden="true" />Detectar automaticamente</button> : null}<button type="button" className="btn btn-secondary btn-sm" onClick={pickChromium}>Escolher executável</button></div>
      </section>

      <section className="mac-prefs__section mac-prefs__section--last"><h3 className="mac-prefs__heading">Atualizações</h3>
        <Updater />
      </section>

      {error ? <p className="mac-prefs__error" role="alert">{error}</p> : null}
    </> : null}
    {!draft && error ? <p className="mac-prefs__error" role="alert">{error}</p> : null}
  </div></AppModal>;
}
