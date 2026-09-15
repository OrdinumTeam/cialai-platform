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
import AccessPanel from './AccessPanel.jsx';
import { useTunnel } from './TunnelContext.jsx';
import { DESKTOP_NAME_MAX } from './tunnel-model.js';
import Updater from './Updater.jsx';
import { getLocale, setLocale, translate } from './i18n.js';

const APPEARANCE_OPTIONS = () => [
  { value: 'system', label: translate('desktop.appearance.systemShort') },
  { value: 'light', label: translate('desktop.appearance.lightShort') },
  { value: 'dark', label: translate('desktop.appearance.darkShort') },
];
export const LANGUAGE_OPTIONS = () => [
  { value: 'pt-BR', label: translate('language.portuguese') },
  { value: 'en', label: translate('language.english') },
  { value: 'es', label: translate('language.spanish') },
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
  const tunnel = useTunnel();
  const native = isTauri();
  const [draft, setDraft] = useState(null);
  const [savedKey, setSavedKey] = useState('');
  const [effectiveShell, setEffectiveShell] = useState(null);
  const [appPaths, setAppPaths] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installingHook, setInstallingHook] = useState(false);
  const [error, setError] = useState('');

  // Linha de estado do Claude Code: copia o hook para ~/.cialai e aponta o
  // statusLine de cada perfil para ele. O card das sessoes passa a ler o uso.
  const installClaudeHook = async () => {
    setInstallingHook(true);
    try {
      const result = await invoke('ai_install_claude_hook');
      const count = Number(result?.installed) || 0;
      notify(count > 0 ? translate('desktop.preferences.claudeHookDone', { count: count.toLocaleString(getLocale()) }) : translate('desktop.preferences.claudeHookNone'), count > 0 ? 'success' : 'warning');
    } catch (hookError) {
      notify(translate('desktop.preferences.claudeHookFailed', { error: hookError?.message || hookError }), 'warning');
    } finally { setInstallingHook(false); }
  };

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    const load = native
      ? Promise.all([invoke('get_preferences'), invoke('app_shell'), invoke('app_paths').catch(() => null)])
      : Promise.resolve([{ ...DEFAULT_PREFERENCES, network: tunnel.preferences }, null, null]);
    load.then(([value, shell, paths]) => {
      if (cancelled) return;
      const next = normalizePreferenceDraft({ ...(value || {}), appearance: appearance.mode });
      setDraft(next);
      setSavedKey(snapshotKey(next));
      setEffectiveShell(shell?.path ? shell : null);
      setAppPaths(paths);
    }).catch((loadError) => {
      if (!cancelled) setError(translate('desktop.preferences.loadError', { error: loadError?.message || loadError }));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, native]);

  const hints = platformPreferenceHints(platform().os, effectiveShell?.flavor || platform().defaultShellFlavor);
  const shownPaths = appPaths
    ? [[translate('desktop.preferences.filePreferences'), appPaths.preferences], [translate('desktop.preferences.fileData'), appPaths.data], [translate('desktop.preferences.fileLogs'), appPaths.logs]].map(([label, path]) => [label, path, shortPath(path)])
    : [[translate('desktop.preferences.filePreferences'), hints.paths.preferences], [translate('desktop.preferences.fileData'), hints.paths.data], [translate('desktop.preferences.fileLogs'), hints.paths.logs]].map(([label, path]) => [label, null, path]);

  const currentKey = useMemo(() => draft ? snapshotKey(draft) : '', [draft]);
  const dirty = Boolean(draft && currentKey !== savedKey);
  const updateTerminal = (value) => setDraft((current) => ({ ...current, terminal: { ...current.terminal, ...value } }));
  const updateNetwork = (value) => setDraft((current) => ({ ...current, network: { ...current.network, ...value } }));

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
    const picked = await chooseDirectory({ title: translate('desktop.preferences.addProjectFolder'), defaultPath: draft?.projectRoots?.[0] || undefined });
    if (picked) setDraft((current) => ({ ...current, projectRoots: addUniquePath(current.projectRoots, picked) }));
  };

  const pickChromium = async () => {
    const picked = await chooseFile({ title: translate('desktop.preferences.chooseChromium'), defaultPath: draft?.devBrowser?.chromiumPath || undefined, filters: hints.chromiumFilters });
    if (picked) setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: picked } }));
  };

  const reveal = async (path) => {
    try {
      await invoke('fs_reveal', { path });
    } catch (revealError) {
      notify(translate('desktop.preferences.openError', { error: revealError?.message || revealError }), 'warning');
    }
  };

  const save = async () => {
    const next = sanitizePreferences(draft);
    if (next.projectRoots.length === 0) {
      setError(translate('desktop.preferences.projectRequired'));
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
      // Nome e aprovação valem na hora: `net.start` é idempotente.
      const previousNetwork = savedKey ? JSON.parse(savedKey).network : null;
      if (JSON.stringify(sanitizePreferences(normalized).network) !== JSON.stringify(previousNetwork)) {
        tunnel.applyNetworkPreferences(normalized.network).catch(() => { /* o painel mostra o erro da rede */ });
      }
      notify(native ? translate('desktop.preferences.saved') : translate('desktop.preferences.previewUpdated'), 'success');
    } catch (saveError) {
      setError(translate('desktop.preferences.saveError', { error: saveError?.message || saveError }));
    } finally { setSaving(false); }
  };

  const footer = draft ? <><button type="button" className="btn btn-quiet" disabled={saving} onClick={close}>{translate('desktop.action.cancel')}</button><button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? translate('desktop.preferences.saving') : translate('desktop.preferences.saveChanges')}</button></> : null;

  return <AppModal open={open} title={translate('desktop.preferences.title')} onClose={close} maxWidth="md" footer={footer}><div className="mac-prefs">
    {loading ? <p className="mac-prefs__note" role="status">{translate('desktop.preferences.loading')}</p> : null}
    {!loading && !native ? <p className="mac-prefs__note">{translate('desktop.preferences.previewNote')}</p> : null}
    {draft ? <>
      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">{translate('desktop.preferences.appearance')}</h3>
        <Row title={translate('desktop.preferences.windowTheme')} description={translate('desktop.preferences.windowThemeDescription')}><Segmented value={draft.appearance} options={APPEARANCE_OPTIONS()} onChange={changeAppearance} ariaLabel={translate('desktop.preferences.windowTheme')} /></Row>
        <Row title={translate('language.label')} description={translate('desktop.preferences.languageDescription')}><Segmented value={getLocale()} options={LANGUAGE_OPTIONS()} onChange={setLocale} ariaLabel={translate('language.label')} /></Row>
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">{translate('desktop.preferences.terminal')}</h3>
        <Row title="Shell" description={effectiveShell ? translate('desktop.preferences.detected', { path: effectiveShell.path }) : hints.shellDescription}><input className="field__control mac-prefs__input" value={draft.terminal.shell || ''} placeholder={effectiveShell?.path || hints.shellPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ shell: event.target.value || null })} aria-label={translate('desktop.preferences.shellPath')} /></Row>
        <Row title={translate('desktop.preferences.arguments')} description={hints.argsDescription} wide><textarea className="field__control field__control--area mac-prefs__textarea" rows="2" value={draft.terminal.args.join('\n')} placeholder={hints.argsPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ args: splitLines(event.target.value) })} aria-label={translate('desktop.preferences.shellArguments')} /></Row>
        {hints.showLang ? <Row title={translate('language.label')} description={hints.langDescription}><input className="field__control mac-prefs__input" value={draft.terminal.lang || ''} placeholder={hints.langPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ lang: event.target.value || null })} aria-label={translate('desktop.preferences.terminalLanguage')} /></Row> : null}
        <Row title={translate('desktop.preferences.pathPrefixes')} description={hints.pathPrefixDescription} wide><textarea className="field__control field__control--area mac-prefs__textarea" rows="2" value={draft.terminal.pathPrefix.join('\n')} placeholder={hints.pathPrefixPlaceholder} spellCheck="false" onChange={(event) => updateTerminal({ pathPrefix: splitLines(event.target.value) })} aria-label={translate('desktop.preferences.pathPrefixes')} /></Row>
        {native ? <Row title={translate('desktop.preferences.claudeHook')} description={translate('desktop.preferences.claudeHookDescription')}><button type="button" className="btn btn-secondary btn-sm" disabled={installingHook} onClick={installClaudeHook}>{translate(installingHook ? 'desktop.preferences.claudeHookInstalling' : 'desktop.preferences.claudeHookInstall')}</button></Row> : null}
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">{translate('desktop.preferences.projects')}</h3>
        <p className="mac-prefs__note">{translate('desktop.preferences.projectsDescription')}</p>
        <div className="mac-prefs__roots" aria-label={translate('desktop.preferences.projectFolders')}>{draft.projectRoots.map((path) => <div className="mac-prefs__root" key={path}><code>{path}</code><button type="button" className="btn btn-quiet btn-sm" disabled={draft.projectRoots.length === 1} onClick={() => setDraft((current) => ({ ...current, projectRoots: removePath(current.projectRoots, path) }))} aria-label={translate('desktop.preferences.removePath', { path })}><Trash2 aria-hidden="true" />{translate('desktop.action.remove')}</button></div>)}</div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addProjectRoot}><FolderPlus aria-hidden="true" />{translate('desktop.preferences.addFolder')}</button>
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">{translate('desktop.preferences.network')}</h3>
        <p className="mac-prefs__note">{translate('desktop.preferences.networkDescription')}</p>
        <AccessPanel heading={false} onPair={() => { close(); window.dispatchEvent(new CustomEvent('cialai:pair-device')); }} onDiagnostics={() => { close(); window.dispatchEvent(new CustomEvent('cialai:network-diagnostics')); }} />
        <Row title={translate('desktop.preferences.computerName')} description={translate('desktop.preferences.computerNameDescription')}><input className="field__control mac-prefs__input" value={draft.network.desktopName || ''} placeholder={tunnel.desktopName || translate('desktop.preferences.computerNamePlaceholder')} maxLength={DESKTOP_NAME_MAX} spellCheck="false" onChange={(event) => updateNetwork({ desktopName: event.target.value || null })} aria-label={translate('desktop.preferences.computerName')} /></Row>
        <Row title={translate('desktop.preferences.confirmPhone')} description={translate('desktop.preferences.confirmPhoneDescription')}><input type="checkbox" className="mac-switch" checked={Boolean(draft.network.requireApproval)} onChange={(event) => updateNetwork({ requireApproval: event.target.checked })} aria-label={translate('desktop.preferences.confirmPhone')} /></Row>
        <Row title={translate('desktop.preferences.keepAwake')} description={translate('desktop.preferences.keepAwakeDescription')}><input type="checkbox" className="mac-switch" checked={Boolean(draft.network.keepAwakeWhilePaired)} onChange={(event) => updateNetwork({ keepAwakeWhilePaired: event.target.checked })} aria-label={translate('desktop.preferences.keepAwake')} /></Row>
      </section>

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Dev Browser</h3>
        <Row title={translate('desktop.preferences.chromiumExecutable')} description={translate('desktop.preferences.chromiumDescription')} wide><input className="field__control mac-prefs__browser-path" value={draft.devBrowser.chromiumPath || ''} placeholder={hints.chromiumPlaceholder} spellCheck="false" onChange={(event) => setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: event.target.value || null } }))} aria-label={translate('desktop.preferences.chromiumExecutable')} /></Row>
        <div className="mac-prefs__actions">{draft.devBrowser.chromiumPath ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDraft((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: null } }))}><RotateCcw aria-hidden="true" />{translate('desktop.preferences.detectAutomatically')}</button> : null}<button type="button" className="btn btn-secondary btn-sm" onClick={pickChromium}>{translate('desktop.preferences.chooseExecutable')}</button></div>
      </section>

      {hints.windowSection ? <section className="mac-prefs__section"><h3 className="mac-prefs__heading">{translate('desktop.preferences.window')}</h3>
        <Row title="Material Mica" description={translate('desktop.preferences.micaDescription')}><input type="checkbox" className="mac-switch" checked={draft.window.backdrop === 'auto'} onChange={(event) => setDraft((current) => ({ ...current, window: { ...current.window, backdrop: event.target.checked ? 'auto' : 'solid' } }))} aria-label="Material Mica" /></Row>
      </section> : null}

      <section className="mac-prefs__section"><h3 className="mac-prefs__heading">{translate('desktop.preferences.appFiles')}</h3>
        <p className="mac-prefs__note">{native ? translate('desktop.preferences.appFilesNative') : translate('desktop.preferences.appFilesPreview')}</p>
        <div className="mac-prefs__roots" aria-label={translate('desktop.preferences.appFiles')}>{shownPaths.map(([label, path, shown]) => <div className="mac-prefs__root" key={label}><span className="mac-prefs__root-label">{label}</span><code title={shown}>{shown}</code>{path ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => reveal(path)} aria-label={`${hints.revealLabel}: ${label}`}><FolderOpen aria-hidden="true" />{hints.revealLabel}</button> : null}</div>)}</div>
      </section>

      <section className="mac-prefs__section mac-prefs__section--last"><h3 className="mac-prefs__heading">{translate('desktop.preferences.updates')}</h3>
        <Updater />
      </section>

      {error ? <p className="mac-prefs__error" role="alert">{error}</p> : null}
    </> : null}
    {!draft && error ? <p className="mac-prefs__error" role="alert">{error}</p> : null}
  </div></AppModal>;
}
