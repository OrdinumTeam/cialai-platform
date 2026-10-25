// SPDX-License-Identifier: Apache-2.0
// Modal Perfis de agentes. À esquerda, as contas do Codex e do Claude Code
// com a cota de cada uma e o formulário que cria um perfil novo; à direita,
// o tutorial animado. Criar um perfil abre uma sessão no Cialai que já
// digita o login, porque o login do Claude Code pergunta coisas no terminal.
//
// As contas e a cota vêm de `agent_profiles`, a mesma lista da tela de contas
// e da Barra de IA. A pasta de configuração nunca chega à interface: o
// caminho mostrado na linha sai do id, que já é o nome da pasta.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import { X } from 'lucide-react';
import claudeGlyph from '../notch/glyphs/claude.svg?raw';
import openaiGlyph from '../notch/glyphs/openai.svg?raw';
import { useToast } from '../components/ui.jsx';
import { invoke, isTauri, listen } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import { demoProfiles } from '../terminals/agent-profiles-demo.js';
import { shortPath } from '../terminals/files.js';
import {
  AGENTS,
  NAME_LIMIT,
  agentById,
  finalName,
  profileExists,
  profileFolder,
  profileName,
  profilesOf,
  quotaLine,
  sanitizeName,
  tutorialShell,
} from './agent-profiles-model.js';
import { publishAgentMenu } from './agent-menu.js';
import AgentProfilesTutorial from './AgentProfilesTutorial.jsx';
import { translate, useI18n } from './i18n.js';
import './agent-profiles.css';

// A lista relê sozinha só de vez em quando: no macOS cada leitura pergunta ao
// chaveiro por conta. Criar ou escolher uma conta avisa por evento.
const REFRESH_MS = 30_000;
const TITLE_ID = 'cialai-agents-title';
const GLYPHS = Object.freeze({ claude: claudeGlyph, codex: openaiGlyph });

function homePath(folder) {
  const home = String(platform().home || '').replace(/[\\/]+$/, '');
  return home ? `${home}/${folder}` : folder;
}

function errorText(error) {
  return error?.message || String(error || '');
}

function ProfileRow({ profile, onLogin, busy, locale, now }) {
  const t = translate;
  const label = profile.label || profileName(profile) || t('agentProfiles.default');
  const path = shortPath(homePath(profileFolder(profile.agent, profileName(profile))));
  const line = quotaLine(profile, { now, locale, t });
  return <div className="cialai-agents__row">
    <span className="cialai-agents__avatar" aria-hidden="true">{label.replace(/[_-]/g, '').slice(0, 1)}</span>
    <span className="cialai-agents__who">
      <span className="cialai-agents__name" title={profile.account || label}>{label}</span>
      <span className="cialai-agents__path" title={path}>{path}</span>
    </span>
    {line.state === 'none'
      ? <span className="cialai-agents__quota"><span className="cialai-agents__value is-muted">{line.value}</span><button type="button" className="cialai-agents__login" disabled={busy} onClick={() => onLogin(profile)}>{t('agentProfiles.login')}</button></span>
      : <span className="cialai-agents__quota">
        <span className={`cialai-agents__value is-${line.tone}`}>{line.value}</span>
        {line.tone === 'free' || line.tone === 'out' ? <span className="cialai-agents__bar"><i style={{ width: `${line.free}%` }} /></span> : null}
        {line.detail ? <span className="cialai-agents__detail">{line.detail}</span> : null}
      </span>}
  </div>;
}

export default function AgentProfilesDialog({ open, agent: initialAgent, onClose, onOpenTerminals }) {
  const { locale } = useI18n();
  const t = translate;
  const notify = useToast();
  const native = isTauri();
  const [profiles, setProfiles] = useState(null);
  const [shellSpec, setShellSpec] = useState(null);
  const [agent, setAgent] = useState('codex');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);

  const load = useCallback(async () => {
    // Fora do app a prévia mostra as contas de demonstração da tela de contas.
    if (!native) {
      setProfiles((current) => current || demoProfiles());
      return;
    }
    try {
      const list = await invoke('agent_profiles');
      setProfiles(Array.isArray(list) ? list : []);
    } catch (loadError) {
      setProfiles([]);
      setError(errorText(loadError));
    }
    setNow(Date.now());
  }, [native]);

  useEffect(() => {
    if (!open) return undefined;
    setError('');
    if (initialAgent && AGENTS.some((item) => item.id === initialAgent)) setAgent(initialAgent);
    load();
    if (native) invoke('app_shell').then(setShellSpec).catch(() => {});
    const timer = setInterval(load, REFRESH_MS);
    const off = native ? listen('agents://profiles', () => load()) : null;
    return () => {
      clearInterval(timer);
      off?.then((stop) => stop?.()).catch(() => {});
    };
  }, [open, initialAgent, load, native]);

  const taken = profileExists(profiles, agent, finalName(name));
  const tool = agentById(agent);
  const groups = useMemo(() => (agent === 'codex' ? AGENTS : [...AGENTS].reverse()), [agent]);
  const shell = useMemo(() => tutorialShell(shellSpec, platform().os), [shellSpec]);
  const draftPath = shortPath(homePath(profileFolder(agent, finalName(name) || t('agentProfiles.tutorial.sampleName'))));

  // O login roda numa sessão nova na pasta pessoal. O computador digita a
  // linha com a pasta da conta, achada pelo id; a interface não monta comando.
  const startLogin = async (profileAgent, id, label) => {
    if (!native) { notify(t('agentProfiles.previewCreated'), 'info'); return; }
    const runtime = await import('../terminals/runtime.js');
    onClose();
    onOpenTerminals?.();
    const session = runtime.openSession(platform().home, { name: t('agentProfiles.loginSession', { name: label }) });
    if (session) await runtime.launchAgentWhenReady(session, profileAgent, id, { login: true });
  };

  const create = async (event) => {
    event.preventDefault();
    const wanted = finalName(name);
    if (!wanted) { setError(t('agentProfiles.error.name')); return; }
    if (taken || busy) return;
    setBusy(true);
    setError('');
    try {
      let id = `${agent}-${wanted}`;
      if (native) {
        id = await invoke('agent_profile_create', { agent, name: wanted });
        publishAgentMenu().catch(() => {});
      } else {
        setProfiles((current) => [...(current || []), { id, agent, label: wanted, isDefault: false, active: false, needsLogin: true }]);
      }
      setName('');
      if (native) notify(t('agentProfiles.created', { name: wanted }), 'success');
      await startLogin(agent, id, wanted);
    } catch (createError) {
      setError(errorText(createError));
    } finally {
      setBusy(false);
    }
  };

  const login = async (profile) => {
    setBusy(true);
    try { await startLogin(profile.agent, profile.id, profile.label || profileName(profile) || t('agentProfiles.default')); }
    catch (loginError) { notify(errorText(loginError), 'warning'); }
    finally { setBusy(false); }
  };

  const hint = error || (taken ? t('agentProfiles.error.exists', { name: finalName(name), tool: tool.label }) : '');

  return <Dialog open={open} onClose={onClose} maxWidth={false} disableScrollLock aria-labelledby={TITLE_ID} PaperProps={{ className: 'cialai-agents' }}>
    <section className="cialai-agents__main">
      <header className="cialai-agents__head">
        <h2 id={TITLE_ID}>{t('agentProfiles.title')}</h2>
        <button type="button" className="cialai-agents__icon" onClick={onClose} aria-label={t('shared.action.close')}><X size={15} strokeWidth={1.75} /></button>
      </header>
      <div className="cialai-agents__scroll">
        <form className="cialai-agents__create" onSubmit={create} autoComplete="off">
          <span className="cialai-agents__label">{t('agentProfiles.newProfile')}</span>
          <div className="cialai-agents__fields">
            <input className={`cialai-agents__input${hint ? ' is-error' : ''}`} value={name} maxLength={NAME_LIMIT} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={t('agentProfiles.namePlaceholder')} aria-label={t('agentProfiles.name')} aria-invalid={Boolean(hint)} aria-describedby="cialai-agents-hint" onChange={(event) => { setName(sanitizeName(event.target.value)); setError(''); }} />
            <div className="cialai-agents__segmented" role="radiogroup" aria-label={t('agentProfiles.tool')}>
              {AGENTS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={agent === item.id} className={agent === item.id ? 'is-selected' : undefined} onClick={() => { setAgent(item.id); setError(''); }}><span className="cialai-agents__glyph" aria-hidden="true" dangerouslySetInnerHTML={{ __html: GLYPHS[item.id] }} />{item.label}</button>)}
            </div>
            <button type="submit" className="cialai-agents__primary" disabled={busy || taken}>{busy ? t('agentProfiles.creating') : t('agentProfiles.create')}</button>
          </div>
          <p id="cialai-agents-hint" className={`cialai-agents__hint${hint ? ' is-error' : ''}`} role={hint ? 'alert' : undefined}>{hint || draftPath}</p>
        </form>
        {profiles === null ? <p className="cialai-agents__empty" role="status">{t('agentProfiles.loading')}</p> : groups.map((group) => {
          const list = profilesOf(profiles, group.id);
          return <div className="cialai-agents__group" key={group.id}>
            <div className="cialai-agents__group-head"><h4>{group.label}</h4><span>{list.length}</span></div>
            <div className="cialai-agents__list">{list.map((profile) => <ProfileRow key={profile.id} profile={profile} onLogin={login} busy={busy} locale={locale} now={now} />)}</div>
          </div>;
        })}
      </div>
    </section>
    <aside className="cialai-agents__tutorial">
      <AgentProfilesTutorial agent={agent} name={finalName(name)} path={draftPath} shell={shell} />
    </aside>
  </Dialog>;
}
