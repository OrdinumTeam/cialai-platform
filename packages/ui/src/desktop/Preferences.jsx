// SPDX-License-Identifier: Apache-2.0
// Focused preference areas backed by the complete Rust snapshot.

import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, FolderPlus, RotateCcw, Trash2 } from 'lucide-react';
import { AppModal, useToast } from '../components/ui.jsx';
import { chooseDirectory, chooseFile, invoke, isTauri } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import { shortPath } from '../terminals/files.js';
import {
  addUniquePath,
  DEFAULT_PREFERENCES,
  normalizePreferenceDraft,
  platformPreferenceHints,
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
  const [effectiveShell, setEffectiveShell] = useState(null);
  const [appPaths, setAppPaths] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    const load = native
      ? Promise.all([invoke('get_preferences'), invoke('app_shell'), invoke('app_paths').catch(() => null)])
      : Promise.resolve([DEFAULT_PREFERENCES, null, null]);
    load.then(([value, shell, paths]) => {
      if (cancelled) return;
      const next = normalizePreferenceDraft({ ...(value || {}), appearance: appearance.mode });
      setDraft(next);
      setSavedKey(snapshotKey(next));
      setEffectiveShell(shell?.path ? shell : null);
      setAppPaths(paths);
    }).catch((loadError) => {
      if (!cancelled) setError(`Não foi possível carregar as preferências: ${loadError?.message || loadError}`);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, native]);

  const hints = platformPreferenceHints(platform().os, effectiveShell?.flavor || platform().defaultShellFlavor);
  const shownPaths = appPaths
    ? [['Preferências', appPaths.preferences], ['Dados e jornais', appPaths.data], ['Registros', appPaths.logs]].map(([label, path]) => [label, path, shortPath(path)])
    : [['Preferências', hints.paths.preferences], ['Dados e jornais', hints.paths.data], ['Registros', hints.paths.logs]].map(([label, path]) => [label, null, path]);

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
    const picked = await chooseFile({ title: 'Escolher o executável do Chromium', defaultPath: draft?.devBrowser?.chromiumPath || undefined, filters: hints.chromiumFilters });
    if (picked) setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: picked } }));
  };

  const reveal = async (path) => {
    try {
      await invoke('fs_reveal', { path });
    } catch (revealError) {
      notify(`Não foi possível abrir: ${revealError?.message || revealError}`, 'warning');
    }
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
        <Row title="Shell" description={effectiveShell ? `Detectado: ${effectiveShell.path}` : hints.shellDescription}><input className="field__control mac-prefs__input" value={draft.terminal.shell || ''} placeholder={effectiveShell?.path || hints.shellPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ shell: event.target.value || null })} aria-label="Caminho do shell" /></Row>
        <Row title="Argumentos" description={hints.argsDescription} wide><textarea className="field__control field__control--area mac-prefs__textarea" rows="2" value={draft.terminal.args.join('\n')} placeholder={hints.argsPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ args: splitLines(event.target.value) })} aria-label="Argumentos do shell" /></Row>
        {hints.showLang ? <Row title="Idioma" description={hints.langDescription}><input className="field__control mac-prefs__input" value={draft.terminal.lang || ''} placeholder={hints.langPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ lang: event.target.value || null })} aria-label="Idioma do terminal" /></Row> : null}
        <Row title="Prefixos do PATH" description={hints.pathPrefixDescription} wide><textarea className="field__control field__control--area mac-prefs__textarea" rows="2" value={draft.terminal.pathPrefix.join('\n')} placeholder={hints.pathPrefixPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ pathPrefix: splitLines(event.target.value) })} aria-label="Prefixos do PATH" /></Row>
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
        <Row title="Executável do Chromium" description="Vazio procura uma instalação compatível automaticamente." wide><input className="field__control mac-prefs__browser-path" value={draft.devBrowser.chromiumPath || ''} placeholder={hints.chromiumPlaceholder} spellCheck="false" onChange={(event) => setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: event.target.value || null } }))} aria-label="Executável do Chromium" /></Row>
        <div className="mac-prefs__actions">{draft.devBrowser.chromiumPath ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: null } }))}><RotateCcw aria-hidden="true" />Detectar automaticamente</button> : null}<button type="button" className="btn btn-secondary btn-sm" onClick={pickChromium}>Escolher executável</button></div>
      </section>

      {hints.windowSection ? <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Janela</h3>
        <Row title="Material Mica" description="Aplica o Mica do Windows 11 atrás da janela quando o sistema permite. Desligado, a janela usa fundo sólido."><input type="checkbox" className="mac-switch" checked={draft.window.backdrop === 'auto'} onChange={(event) => setDraft((current) => ({ ...current, window: { ...current.window, backdrop: event.target.checked ? 'auto' : 'solid' } }))} aria-label="Material Mica" /></Row>
      </section> : null}

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Arquivos do aplicativo</h3>
        <p className="mac-prefs__note">{native ? 'Onde o Cialai guarda seus arquivos neste computador.' : 'Locais usados pelo aplicativo desktop neste sistema.'}</p>
        <div className="mac-prefs__roots" aria-label="Arquivos do aplicativo">{shownPaths.map(([label, path, shown]) => <div className="mac-prefs__root" key={label}><span className="mac-prefs__root-label">{label}</span><code title={shown}>{shown}</code>{path ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => reveal(path)} aria-label={`${hints.revealLabel}: ${label}`}><FolderOpen aria-hidden="true" />{hints.revealLabel}</button> : null}</div>)}</div>
      </section>

      <section className="mac-prefs__section mac-prefs__section--last"><h3 className="mac-prefs__heading">Atualizações</h3>
        <Updater />
      </section>

      {error ? <p className="mac-prefs__error" role="alert">{error}</p> : null}
    </> : null}
    {!draft && error ? <p className="mac-prefs__error" role="alert">{error}</p> : null}
  </div></AppModal>;
}
