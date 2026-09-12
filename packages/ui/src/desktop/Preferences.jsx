// SPDX-License-Identifier: Apache-2.0
// Preferences backed by the Cialai Rust schema. Advanced validation and
// platform-specific controls are refined in roadmap task 1.8.

import React, { useEffect, useState } from 'react';
import { AppModal, useToast } from '../components/ui.jsx';
import { invoke, isTauri } from '../lib/native.js';

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

function Row({ title, description, children }) {
  return <div className="mac-prefs__row"><div className="mac-prefs__row-text"><div className="mac-prefs__row-title">{title}</div>{description && <div className="mac-prefs__row-desc">{description}</div>}</div><div className="mac-prefs__row-control">{children}</div></div>;
}

function lines(value) {
  return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);
}

export default function Preferences({ open, onClose, appearance }) {
  const notify = useToast();
  const native = isTauri();
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !native) return;
    invoke('get_preferences').then((value) => setPrefs(value || null)).catch(() => setPrefs(null));
  }, [open, native]);

  const persist = async (next) => {
    if (!native) return;
    setSaving(true);
    try {
      const saved = await invoke('set_preferences', { next });
      setPrefs(saved || next);
      notify('Preferências salvas', 'success');
    } catch (error) {
      notify(`Não foi possível salvar: ${error?.message || error}`, 'danger');
    } finally { setSaving(false); }
  };

  const changeAppearance = (mode) => {
    appearance.setMode(mode);
    if (prefs) persist({ ...prefs, appearance: mode });
  };
  const patch = (value) => prefs && persist({ ...prefs, ...value });

  return <AppModal open={open} title="Preferências" onClose={onClose} maxWidth="sm"><div className="mac-prefs">
    <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Aparência</h3><Row title="Tema da janela" description="Sistema acompanha o modo claro ou escuro do computador."><Segmented value={appearance.mode} options={APPEARANCE_OPTIONS} onChange={changeAppearance} ariaLabel="Tema da janela" /></Row></section>
    <section className="mac-prefs__section"><h3 className="mac-prefs__heading">Terminal</h3>
      {!native && <p className="mac-prefs__note">As preferências nativas ficam disponíveis no aplicativo desktop.</p>}
      {native && <><Row title="Shell" description="Vazio usa o shell configurado no sistema."><input className="field__control" value={prefs?.terminal?.shell || ''} disabled={!prefs || saving} placeholder="/bin/zsh" onChange={(event) => setPrefs((current) => ({ ...current, terminal: { ...current.terminal, shell: event.target.value || null } }))} /></Row>
      <Row title="Raízes de projetos" description="Uma pasta por linha."><textarea className="field__control field__control--area" rows="3" value={(prefs?.projectRoots || []).join('\n')} disabled={!prefs || saving} onChange={(event) => setPrefs((current) => ({ ...current, projectRoots: lines(event.target.value) }))} /></Row>
      <Row title="Chromium do Dev Browser" description="Caminho opcional do executável."><input className="field__control" value={prefs?.devBrowser?.chromiumPath || ''} disabled={!prefs || saving} placeholder="Detectar automaticamente" onChange={(event) => setPrefs((current) => ({ ...current, devBrowser: { ...current.devBrowser, chromiumPath: event.target.value || null } }))} /></Row>
      <div className="mac-prefs__actions"><button type="button" className="btn btn-primary btn-sm" disabled={!prefs || saving} onClick={() => patch({})}>{saving ? 'Salvando…' : 'Salvar'}</button></div></>}
    </section>
    <section className="mac-prefs__section mac-prefs__section--last"><h3 className="mac-prefs__heading">Sobre</h3><p className="mac-prefs__note">Cialai mantém sessões de terminal, arquivos e ferramentas de projeto em um estúdio local.</p></section>
  </div></AppModal>;
}
