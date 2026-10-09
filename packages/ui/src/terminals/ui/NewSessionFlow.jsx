// SPDX-License-Identifier: Apache-2.0
// Sessão nova no celular, em três etapas com indicador horizontal: projeto,
// agente e configuração. Substitui o seletor de pasta da página do telefone;
// o computador continua com o NewSessionPopover.
//
// Projeto: grade de duas colunas com as pastas que o computador lista, as
// recentes deste telefone e o navegador de pastas. Se a pasta já tem sessões,
// a etapa oferece continuar uma delas; nada abre sem toque.
//
// Agente: o terminal padrão ou um dos agentes, com as contas reais do
// computador e os limites da última leitura. Nenhuma conta é bloqueada por
// número: a leitura pode estar velha. A conta escolhida vale só para esta
// sessão; a conta ativa do computador não muda.
//
// Configuração: nome, subtítulo e cor, as mesmas opções do menu da sessão, e
// o resumo com o que vai abrir.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, FolderTree, SquareTerminal } from 'lucide-react';
import { invoke, hasBridge } from '../../lib/native.js';
import { shellDesktopName } from '../../lib/shell.js';
import { ProgressIndicator, SearchInput } from '../../mobile/ui.jsx';
import { ageCopy, percentText, windowLabel } from '../../notch/copy.js';
import claudeGlyph from '../../notch/glyphs/claude.svg?raw';
import openaiGlyph from '../../notch/glyphs/openai.svg?raw';
import { translate } from '../../shared/i18n.js';
import { baseName, compactPath, shortPath } from '../files.js';
import { sessionsInFolder } from '../project-tint.js';
import { SESSION_COLORS, getRecent, getState, isDemo, launchAgentWhenReady, openSession } from '../runtime.js';
import { AGENTS, groupProfiles, headlineWindow, readingState, usageTone, weeklyWindow } from './AgentProfiles.jsx';
import DirectoryBrowser from './DirectoryBrowser.jsx';
import FolderArt from './FolderArt.jsx';
import { folderGroups } from './NewSessionPopover.jsx';

export const FLOW_STEPS = Object.freeze(['project', 'agent', 'config']);
const SHELL = 'shell';
const GLYPHS = Object.freeze({ claude: claudeGlyph, codex: openaiGlyph });
const TONE = Object.freeze({ ok: 'primary', warn: 'warning', bad: 'danger', none: 'neutral' });

// Pastas da grade: cada raiz e os projetos dela, sem repetir caminho, e
// filtradas pela busca. As recentes ficam na faixa de cima.
export function projectItems(repos, query) {
  const seen = new Set();
  return folderGroups({ repos, query })
    .flatMap((group) => group.items)
    .filter((item) => (seen.has(item.path) ? false : seen.add(item.path)));
}

export function StepIndicator({ step, onStep }) {
  return (
    <ol className="phone-steps" aria-label={translate('terminal.newSession.steps')}>
      {FLOW_STEPS.map((id, index) => {
        const name = translate(`terminal.newSession.step.${id}`);
        const done = index < step;
        const current = index === step;
        return (
          <li key={id} className={`phone-steps__item${current ? ' is-current' : ''}${done ? ' is-done' : ''}`} aria-current={current ? 'step' : undefined}>
            <button type="button" disabled={!done} onClick={() => onStep(index)} aria-label={translate('terminal.newSession.stepOf', { step: index + 1, name })}>
              <span className="phone-steps__dot" aria-hidden="true">{done ? <Check size={13} strokeWidth={3} /> : index + 1}</span>
              <span className="phone-steps__label">{name}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function ProjectCard({ item, selected, sessionCount, onPick }) {
  const details = sessionCount
    ? translate(sessionCount === 1 ? 'terminal.newSession.sessionsOne' : 'terminal.newSession.sessionsMany', { count: sessionCount })
    : compactPath(item.path);
  return (
    <button type="button" role="radio" aria-checked={selected} className={`phone-project-card${selected ? ' is-selected' : ''}`} onClick={() => onPick(item.path)}>
      <span className="phone-project-card__cover"><FolderArt name={item.name} /></span>
      {selected ? <span className="phone-project-card__check" aria-hidden="true"><Check size={14} strokeWidth={3} /></span> : null}
      <span className="phone-project-card__name">{item.name}</span>
      <span className="phone-project-card__meta">{details}</span>
    </button>
  );
}

function UsageRows({ profile }) {
  const usage = profile.usage;
  const rows = [headlineWindow(usage), weeklyWindow(usage)].filter((window) => window && Number.isFinite(window.usedFraction));
  if (!rows.length) return null;
  return rows.map((window) => (
    <ProgressIndicator key={window.id} value={window.usedFraction} tone={TONE[usageTone(window.usedFraction)]}
      label={windowLabel(window)} detail={translate('terminal.newSession.used', { percent: `${percentText(window.usedFraction)}%` })} />
  ));
}

const STATE_KEYS = Object.freeze({
  reading: 'terminal.profiles.reading',
  unavailable: 'terminal.profiles.unavailable',
  needsLogin: 'terminal.profiles.needsLogin',
  error: 'terminal.profiles.readError',
  unmetered: 'terminal.profiles.unmetered',
  stale: 'terminal.profiles.stale',
});

export function AccountCard({ profile, selected, onPick }) {
  const state = readingState(profile);
  const age = profile.usage?.fetchedAtMs ? ageCopy(profile.usage.fetchedAtMs) : '';
  return (
    <button type="button" role="radio" aria-checked={selected} className={`phone-account${selected ? ' is-selected' : ''}`} onClick={() => onPick(profile.id)}>
      <span className="phone-account__head">
        <span className="phone-flow__radio" aria-hidden="true">{selected ? <Check size={14} strokeWidth={3} /> : null}</span>
        <strong>{profile.label || profile.id}</strong>
        {profile.plan ? <span className="phone-account__plan">{profile.plan}</span> : null}
        {profile.active ? <span className="phone-account__active">{translate('terminal.profiles.inUse')}</span> : null}
      </span>
      <UsageRows profile={profile} />
      {state !== 'ok' ? <span className={`phone-account__state phone-account__state--${state}`}>{translate(STATE_KEYS[state] || STATE_KEYS.unavailable)}</span> : null}
      {state === 'needsLogin' ? <span className="phone-account__hint">{translate('terminal.newSession.loginHint')}</span> : null}
      {age ? <span className="phone-account__age">{age}</span> : null}
    </button>
  );
}

// Etapa 3: nome, subtítulo e cor, as opções que o menu da sessão já tem, e o
// resumo do que vai abrir, com o atalho de volta a cada etapa.
export function ConfigStep({ path, agent, agentName, account, name, subtitle, color, onName, onSubtitle, onColor, onStep }) {
  return <>
    <label className="phone-field">
      <span>{translate('terminal.session.name')}</span>
      <input value={name} onChange={(event) => onName(event.target.value)} placeholder={translate('terminal.session.optionalName')}
        spellCheck={false} autoCorrect="off" maxLength={80} />
    </label>
    <label className="phone-field">
      <span>{translate('terminal.newSession.subtitle')}</span>
      <input value={subtitle} onChange={(event) => onSubtitle(event.target.value)} placeholder={translate('terminal.newSession.optionalSubtitle')}
        spellCheck={false} autoCorrect="off" maxLength={120} />
    </label>
    <section className="phone-flow__section">
      <h2>{translate('terminal.newSession.color')}</h2>
      <div className="phone-swatches" role="radiogroup" aria-label={translate('terminal.newSession.color')}>
        <button type="button" role="radio" aria-checked={!color} aria-label={translate('terminal.menu.noColor')} className="phone-swatch phone-swatch--none" onClick={() => onColor(null)}>
          {!color ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : null}
        </button>
        {SESSION_COLORS.map((entry) => (
          <button type="button" role="radio" aria-checked={color === entry.id} key={entry.id} aria-label={translate(`terminal.color.${entry.id}`)}
            className="phone-swatch" style={{ '--swatch-light': entry.light, '--swatch-dark': entry.dark }} onClick={() => onColor(entry.id)}>
            {color === entry.id ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </section>
    <section className="phone-flow__section">
      <h2>{translate('terminal.newSession.summary')}</h2>
      <dl className="phone-summary">
        {shellDesktopName() ? <div><dt>{translate('terminal.newSession.computer')}</dt><dd>{shellDesktopName()}</dd></div> : null}
        {[
          ['directory', shortPath(path), 0],
          ['agent', agentName, 1],
          ['account', agent === SHELL ? translate('terminal.newSession.noAccount') : (account?.label || account?.id || ''), 1],
        ].map(([key, value, target]) => {
          const item = translate(`terminal.newSession.${key}`);
          return (
            <div key={key}>
              <dt>{item}</dt>
              <dd title={key === 'directory' ? path : undefined}>{value}</dd>
              <button type="button" aria-label={translate('terminal.newSession.change', { item })} onClick={() => onStep(target)}>{translate('terminal.newSession.changeShort')}</button>
            </div>
          );
        })}
      </dl>
    </section>
  </>;
}

export default function NewSessionFlow({ initialPath = '', onClose, onOpen, onNotify }) {
  const [step, setStep] = useState(initialPath ? 1 : 0);
  const [path, setPath] = useState(initialPath);
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState(null);
  const [profiles, setProfiles] = useState(null);
  const [agent, setAgent] = useState(SHELL);
  const [profileId, setProfileId] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [color, setColor] = useState(null);

  useEffect(() => {
    if (!hasBridge() || isDemo()) { setRepos({ roots: [], repos: [] }); setProfiles([]); return; }
    invoke('list_repo_dirs').then((listing) => setRepos(listing || { roots: [], repos: [] })).catch(() => setRepos({ roots: [], repos: [] }));
    invoke('agent_profiles').then((list) => setProfiles(Array.isArray(list) ? list : [])).catch(() => setProfiles([]));
  }, []);

  const recent = useMemo(() => getRecent(), []);
  const items = useMemo(() => projectItems(repos, query), [repos, query]);
  const sessions = getState().sessions;
  const existing = sessionsInFolder(sessions, path);
  const groups = groupProfiles(profiles);
  const accounts = groups.find((group) => group.id === agent)?.profiles || [];
  const account = accounts.find((profile) => profile.id === profileId) || null;
  const agentName = agent === SHELL ? translate('terminal.newSession.shell') : translate(`terminal.profiles.agent.${agent}`);
  const inGrid = items.some((item) => item.path === path);
  const needle = query.trim().toLowerCase();
  const recentShown = recent.filter((entry) => !needle || entry.toLowerCase().includes(needle));

  // A conta ativa do computador vem marcada; trocar de agente refaz a escolha.
  const chooseAgent = (next) => {
    setAgent(next);
    const list = groups.find((group) => group.id === next)?.profiles || [];
    setProfileId((list.find((profile) => profile.active) || list[0])?.id || null);
  };

  const ready = step === 0 ? Boolean(path) : step === 1 ? agent === SHELL || Boolean(account) : true;
  const back = () => (step > 0 ? setStep(step - 1) : onClose());

  function create() {
    const id = openSession(path, { name, subtitle, color });
    if (!id) return;
    onOpen(id);
    if (agent !== SHELL && account) {
      launchAgentWhenReady(id, agent, account.id).catch((error) => onNotify?.(error.message, 'warning'));
    }
  }

  if (browsing) {
    return <DirectoryBrowser startPath={path || null} onClose={() => setBrowsing(false)}
      onConfirm={(picked) => { setBrowsing(false); setPath(picked); }} />;
  }

  return (
    <div className="phone-flow" role="dialog" aria-modal="true" aria-label={translate('terminal.session.new')}>
      <header className="phone-flow__header">
        <button type="button" className="phone-icon-btn" aria-label={translate('terminal.newSession.back')} onClick={back}><ChevronLeft size={26} aria-hidden="true" /></button>
        <h1>{translate('terminal.session.new')}</h1>
        <span className="phone-flow__header-spacer" />
      </header>
      <StepIndicator step={step} onStep={setStep} />
      <div className="phone-flow__body">
        {step === 0 ? <>
          <SearchInput value={query} onChange={setQuery} placeholder={translate('terminal.newSession.searchProject')} />
          {recentShown.length ? <section className="phone-flow__section">
            <h2>{translate('terminal.session.recent')}</h2>
            <div className="phone-chips" role="radiogroup" aria-label={translate('terminal.session.recent')}>
              {recentShown.map((entry) => (
                <button type="button" role="radio" aria-checked={entry === path} key={entry} title={shortPath(entry)}
                  className={`phone-chip${entry === path ? ' is-selected' : ''}`} onClick={() => setPath(entry)}>
                  {baseName(entry) || entry}
                </button>
              ))}
            </div>
          </section> : null}
          {path && !inGrid ? <section className="phone-flow__section">
            <h2>{translate('terminal.newSession.chosenFolder')}</h2>
            <div className="phone-project-grid" role="radiogroup" aria-label={translate('terminal.newSession.chosenFolder')}>
              <ProjectCard item={{ path, name: baseName(path) || path }} selected sessionCount={existing.length} onPick={setPath} />
            </div>
          </section> : null}
          <section className="phone-flow__section">
            <h2>{translate('terminal.newSession.projects')}</h2>
            {!repos ? <p className="phone-flow__note">{translate('terminal.session.loadingFolders')}</p> : null}
            {repos && !items.length ? <p className="phone-flow__note">{translate(query.trim() ? 'terminal.session.noFolder' : 'terminal.newSession.noProjects')}</p> : null}
            <div className="phone-project-grid" role="radiogroup" aria-label={translate('terminal.newSession.projects')}>
              {items.map((item) => (
                <ProjectCard key={item.path} item={item} selected={item.path === path} sessionCount={sessionsInFolder(sessions, item.path).length} onPick={setPath} />
              ))}
            </div>
          </section>
          <button type="button" className="phone-flow__secondary" onClick={() => setBrowsing(true)}>
            <FolderTree size={18} aria-hidden="true" />{translate('terminal.session.browseFolders')}
          </button>
        </> : null}

        {step === 1 ? <>
          <div className="phone-agent-grid" role="radiogroup" aria-label={translate('terminal.newSession.agent')}>
            {[SHELL, ...AGENTS].map((id) => {
              const count = id === SHELL ? 0 : groups.find((group) => group.id === id)?.profiles.length || 0;
              const missing = id !== SHELL && profiles !== null && !count;
              const detail = id === SHELL ? translate('terminal.newSession.shellDetail')
                : profiles === null ? translate('terminal.profiles.loading')
                  : missing ? translate('terminal.newSession.noAgent')
                    : translate(count === 1 ? 'terminal.newSession.agentDetailOne' : 'terminal.newSession.agentDetail', { count });
              return (
                <button type="button" role="radio" aria-checked={agent === id} key={id} disabled={missing || (id !== SHELL && profiles === null)}
                  className={`phone-agent phone-agent--${id}${agent === id ? ' is-selected' : ''}`} onClick={() => chooseAgent(id)}>
                  <span className="phone-agent__icon" aria-hidden="true">{id === SHELL ? <SquareTerminal size={22} /> : <span className={`phone-agent__glyph phone-agent__glyph--${id}`} dangerouslySetInnerHTML={{ __html: GLYPHS[id] || '' }} />}</span>
                  <strong>{id === SHELL ? translate('terminal.newSession.shell') : translate(`terminal.profiles.agent.${id}`)}</strong>
                  <span>{detail}</span>
                </button>
              );
            })}
          </div>
          {agent !== SHELL ? <section className="phone-flow__section">
            <h2>{translate('terminal.newSession.accountsFor', { agent: agentName })}</h2>
            <div className="phone-account-list" role="radiogroup" aria-label={translate('terminal.newSession.accountsFor', { agent: agentName })}>
              {accounts.map((profile) => <AccountCard key={profile.id} profile={profile} selected={profile.id === profileId} onPick={setProfileId} />)}
            </div>
            <p className="phone-flow__note">{translate('terminal.newSession.limitsNote')}</p>
            <p className="phone-flow__note">{translate('terminal.newSession.accountNote')}</p>
          </section> : null}
        </> : null}

        {step === 2 ? <ConfigStep path={path} agent={agent} agentName={agentName} account={account} name={name} subtitle={subtitle} color={color}
          onName={setName} onSubtitle={setSubtitle} onColor={setColor} onStep={setStep} /> : null}

        {path && existing.length && step < 2 ? <section className="phone-flow__existing" aria-live="polite">
          <h2>{translate('terminal.newSession.existingTitle')}</h2>
          <p>{translate('terminal.newSession.existingDetail')}</p>
          {existing.map((session) => (
            <button type="button" key={session.id} className="phone-flow__secondary" onClick={() => onOpen(session.id)}>
              <SquareTerminal size={18} aria-hidden="true" />{translate('terminal.newSession.continueSession', { name: session.name })}
            </button>
          ))}
        </section> : null}
      </div>
      <footer className="phone-flow__footer">
        <button type="button" className="phone-flow__primary" disabled={!ready} onClick={() => (step < 2 ? setStep(step + 1) : create())}>
          {translate(step < 2 ? 'terminal.newSession.continue' : 'terminal.newSession.open')}
          {step < 2 ? <ArrowRight size={20} aria-hidden="true" /> : null}
        </button>
      </footer>
    </div>
  );
}
