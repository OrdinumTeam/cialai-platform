// SPDX-License-Identifier: Apache-2.0
// A skill se instala e se atualiza sozinha; esta seção só mostra, edita e
// devolve à versão do Cialai.
import React, { useEffect, useState } from 'react';
import { invoke, isTauri } from '../lib/native.js';
import { getLocale, translate as t } from './i18n.js';

const AGENTS = { claude: 'Claude Code', codex: 'Codex' };
const STATES = { installed: 'desktop.skill.installed', kept: 'desktop.skill.kept', missing: 'desktop.skill.missing', pending: 'desktop.skill.pending' };

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function CialaiSkill() {
  const [skill, setSkill] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const apply = (view) => { setSkill(view); setDraft(view.content); };
  useEffect(() => { if (isTauri()) invoke('skill_view').then(apply).catch(() => setError(true)); }, []);
  const run = async (command, args) => {
    setBusy(true); setError(false);
    try { apply(await invoke(command, args)); } catch { setError(true); } finally { setBusy(false); }
  };
  if (!isTauri()) return null;
  return <section className="mac-prefs__section" id="prefs-skill"><h3 className="mac-prefs__heading">{t('desktop.skill.title')}</h3>
    <p className="mac-prefs__note">{t('desktop.skill.description')}</p>
    {skill && <>
      <div className="mac-prefs__roots">
        <div className="mac-prefs__root"><span className="mac-prefs__root-label">{t('desktop.skill.mode')}</span><span className="mac-prefs__skill-value">{t(skill.edited ? 'desktop.skill.modeEdited' : 'desktop.skill.modeAuto')}</span></div>
        <div className="mac-prefs__root"><span className="mac-prefs__root-label">{t('desktop.skill.updated')}</span><span className="mac-prefs__skill-value">{skill.updatedAt ? formatDate(skill.updatedAt) : t('desktop.skill.never')}<small>{t('desktop.skill.version', { version: skill.version })}</small></span></div>
        {skill.agents.map(agent => <div className="mac-prefs__root mac-prefs__skill-agent" key={agent.agent}><span className="mac-prefs__root-label">{AGENTS[agent.agent] || agent.agent}</span><code title={agent.path}>{agent.path}</code><span className="mac-prefs__skill-state">{t(STATES[agent.state] || STATES.missing)}</span></div>)}
      </div>
      <label className="mac-prefs__row-title" htmlFor="prefs-skill-text">{t('desktop.skill.text')}</label>
      <textarea id="prefs-skill-text" className="field__control field__control--area mac-prefs__skill" rows="14" spellCheck="false" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <p className="mac-prefs__note">{t('desktop.skill.editNote')}</p>
      <div className="mac-prefs__actions mac-prefs__skill-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || draft === skill.content} onClick={() => run('skill_edit', { content: draft })}>{t('desktop.skill.save')}</button>
        {skill.edited && <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => run('skill_restore')}>{t('desktop.skill.restore')}</button>}
      </div>
    </>}
    {error && <p className="mac-prefs__error" role="alert">{t('desktop.skill.error')}</p>}
  </section>;
}
