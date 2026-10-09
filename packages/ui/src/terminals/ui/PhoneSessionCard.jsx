// SPDX-License-Identifier: Apache-2.0
// Card de sessão do celular, compacto como na referência: nome, agente,
// pasta, estado com tempo, CPU e memória medidos e um botão redondo que abre
// a sessão. O card do computador continua em SessionCard.jsx.
//
// A fase visual (ativa, pausada, finalizada, erro) vem do estado do processo.
// A conexão do terminal com o computador é outra coisa e aparece numa pílula
// à parte, para "Processando" e "Desconectado" nunca se confundirem.
//
// Como o card do computador, assina só a atividade da própria sessão.
import React, { memo, useEffect, useRef } from 'react';
import { ArrowRight, EllipsisVertical, Folder, Pin } from 'lucide-react';
import { fmtCpu, fmtElapsed, fmtMemory, shortPath } from '../files.js';
import { describe, runningLabel, sessionAccent } from '../runtime.js';
import { useRuntimeEvents } from '../hooks.js';
import { sessionPhase } from '../phone-session-list.js';
import ActivityIndicator from './ActivityIndicator.jsx';
import { translate, useI18n } from '../../shared/i18n.js';

// Toque longo que abre o menu de ações, sem disparar seleção nem rolagem.
const LONG_PRESS_MS = 500;

function accentStyle(session) {
  const accent = sessionAccent(session);
  if (!accent) return undefined;
  return { '--terminais-accent-light': accent.light, '--terminais-accent-dark': accent.dark };
}

function PhoneSessionCard({ session, onSelect, onMenu }) {
  useI18n();
  useRuntimeEvents(['activity', 'sessions'], session.id);
  const longPress = useRef(null);
  const cancelLongPress = () => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } };
  useEffect(() => cancelLongPress, []);

  const status = describe(session);
  const phase = sessionPhase(status);
  const running = runningLabel(session);
  const activity = session.activity;
  const live = session.status === 'running';
  const cpu = live && activity?.available && activity.cpu != null ? fmtCpu(activity.cpu) : null;
  const memory = live && activity?.available && activity.memory > 0 ? fmtMemory(activity.memory) : null;
  const measuring = live && !activity;
  const elapsed = session.jobStartedAt && live && !running?.background ? fmtElapsed(Date.now() - session.jobStartedAt) : null;
  // A sessão segue viva no computador, mas a ponte caiu: o estado do agente
  // continua no rótulo e a conexão vai na pílula.
  const linkLost = session.status === 'disconnected' && status.code !== 'disconnected';
  const agent = running?.text || translate('terminal.phone.defaultShell');

  const classes = ['phone-session', `phone-session--${phase}`];
  if (session.color) classes.push('has-color');
  if (session.pinned) classes.push('is-pinned');

  return (
    <div
      className={classes.join(' ')}
      style={accentStyle(session)}
      role="button"
      tabIndex={0}
      data-session-id={session.id}
      title={shortPath(session.cwd)}
      onClick={() => onSelect(session.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(session.id); }
      }}
      onPointerDown={(event) => {
        if (event.target.closest?.('button')) return;
        cancelLongPress();
        longPress.current = setTimeout(() => { longPress.current = null; onMenu(session); }, LONG_PRESS_MS);
      }}
      onPointerMove={cancelLongPress}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
    >
      <div className="phone-session__head">
        <ActivityIndicator tone={status.tone} animated={status.animated} />
        <span className="phone-session__name">{session.name}</span>
        {session.pinned ? <Pin size={13} strokeWidth={2} className="phone-session__pin" role="img" aria-label={translate('terminal.session.pinned')} /> : null}
        <button
          type="button"
          className="phone-session__menu"
          aria-label={translate('terminal.session.actionsFor', { name: session.name })}
          onClick={(event) => { event.stopPropagation(); onMenu(session); }}
        >
          <EllipsisVertical size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {session.subtitle ? <div className="phone-session__subtitle">{session.subtitle}</div> : null}
      <div className={`phone-session__agent${running?.agent ? ' is-agent' : ''}`}>{agent}</div>
      <div className="phone-session__dir"><Folder size={13} strokeWidth={1.8} aria-hidden="true" /><span>{shortPath(session.cwd)}</span></div>
      <div className="phone-session__state">
        <span className={`phone-session__status phone-session__status--${status.tone}`}>{status.label}</span>
        {elapsed ? <span className="phone-session__elapsed">{elapsed}</span> : null}
      </div>
      <div className="phone-session__foot">
        <div className="phone-session__metrics">
          {cpu != null ? <span><em>{translate('terminal.common.cpu')}</em> {cpu}</span> : null}
          {memory != null ? <span><em>{translate('terminal.common.memory')}</em> {memory}</span> : null}
          {measuring ? <span className="phone-session__metrics-off">{translate('terminal.session.measuring')}</span> : null}
          {linkLost ? <span className="phone-badge phone-badge--pill phone-badge--warning">{translate('terminal.session.disconnected')}</span> : null}
        </div>
        <button
          type="button"
          className="phone-session__open"
          aria-label={translate('terminal.phone.openSession', { name: session.name })}
          onClick={(event) => { event.stopPropagation(); onSelect(session.id); }}
        >
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default memo(PhoneSessionCard);

// Esqueleto com a mesma altura do card, para a lista não pular quando as
// sessões chegam.
export function PhoneSessionSkeleton() {
  return (
    <div className="phone-session phone-session--skeleton" aria-hidden="true">
      <div className="phone-session__head"><i className="phone-skeleton phone-skeleton--dot" /><i className="phone-skeleton phone-skeleton--title" /></div>
      <i className="phone-skeleton phone-skeleton--line" />
      <i className="phone-skeleton phone-skeleton--short" />
      <i className="phone-skeleton phone-skeleton--line" />
      <div className="phone-session__foot"><i className="phone-skeleton phone-skeleton--short" /><i className="phone-skeleton phone-skeleton--round" /></div>
    </div>
  );
}
