// SPDX-License-Identifier: Apache-2.0
// Card de sessão do celular, compacto como na referência: nome, agente,
// pasta, estado com tempo, CPU e memória medidos e um botão redondo que abre
// a sessão. O card do computador continua em SessionCard.jsx.
//
// A fase visual (ativa, pausada, finalizada, erro) vem do estado do processo.
// A conexão do terminal com o computador é outra coisa e aparece numa pílula
// à parte, para "Processando" e "Desconectado" nunca se confundirem.
//
// Como o card do computador, assina só a atividade da própria sessão, e o
// tom vem do mesmo lugar: a cor escolhida ou, sem cor, o rosa do Cialai, na
// barra lateral, no ícone, no nome do agente, nas barras de atividade e no
// botão de abrir.
import React, { memo, useEffect, useRef } from 'react';
import { ArrowRight, Bell, CheckCircle2, EllipsisVertical, Folder, Pin, Power, XCircle } from 'lucide-react';
import { fmtCpu, fmtElapsed, fmtMemory, shortPath } from '../files.js';
import { describe, runningLabel, sessionProfileLabel } from '../runtime.js';
import { sessionAccentStyle } from '../session-accent.js';
import { useRuntimeEvents } from '../hooks.js';
import { sessionPhase } from '../phone-session-list.js';
import ActivityIndicator from './ActivityIndicator.jsx';
import SessionIcon from './SessionIcon.jsx';
import { translate, useI18n } from '../../shared/i18n.js';

// Toque longo que abre o menu de ações, sem disparar seleção nem rolagem.
const LONG_PRESS_MS = 500;

// O mesmo sinal de atenção do card do computador: concluído, erro ou o sino.
function AttentionIcon({ kind }) {
  if (kind === 'finished') return <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />;
  if (kind === 'error') return <XCircle size={14} strokeWidth={2} aria-hidden="true" />;
  return <Bell size={14} strokeWidth={2} aria-hidden="true" />;
}

function PhoneSessionCard({ session, onSelect, onMenu, onClose }) {
  useI18n();
  useRuntimeEvents(['activity', 'sessions'], session.id);
  const longPress = useRef(null);
  const cancelLongPress = () => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } };
  useEffect(() => cancelLongPress, []);

  const status = describe(session);
  const phase = sessionPhase(status);
  const running = runningLabel(session);
  const activity = session.activity;
  const profileLabel = running?.agent ? sessionProfileLabel(activity) : null;
  const live = session.status === 'running';
  const cpu = live && activity?.available && activity.cpu != null ? fmtCpu(activity.cpu) : null;
  const memory = live && activity?.available && activity.memory > 0 ? fmtMemory(activity.memory) : null;
  const measuring = live && !activity;
  const elapsed = session.jobStartedAt && live && !running?.background ? fmtElapsed(Date.now() - session.jobStartedAt) : null;
  // A sessão segue viva no computador, mas a ponte caiu: o estado do agente
  // continua no rótulo e a conexão vai na pílula.
  const linkLost = session.status === 'disconnected' && status.code !== 'disconnected';
  const agent = running?.text || translate('terminal.phone.defaultShell');

  // Encerramento e falha já aparecem no estado escrito; o resto da atenção
  // ganha uma linha própria, como no computador.
  const attention = session.attention && session.attention.kind !== 'exited' && session.attention.kind !== 'error' ? session.attention : null;
  // `session-scope` com as variáveis inline: o card fica com o tom da sessão
  // e nunca herda o de outra. A barra lateral aparece em todo card.
  const classes = ['phone-session', 'session-scope', `phone-session--${phase}`];
  if (session.color) classes.push('has-color');
  if (attention) classes.push('has-attention', `has-attention--${attention.kind}`);
  if (session.pinned) classes.push('is-pinned');

  return (
    <div
      className={classes.join(' ')}
      style={sessionAccentStyle(session)}
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
        <SessionIcon session={session} size={17} className="phone-session__icon" />
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
      {profileLabel ? <div className="phone-session__profile"><span className="terminais-card__profile" title={translate('terminal.session.profile', { profile: profileLabel })}>{profileLabel}</span></div> : null}
      <div className="phone-session__dir"><Folder size={13} strokeWidth={1.8} aria-hidden="true" /><span>{shortPath(session.cwd)}</span></div>
      {session.status === 'error' && onClose ? <button type="button" className="phone-session__close btn btn-quiet" onClick={(event) => { event.stopPropagation(); onClose(session); }}>
        <Power size={16} strokeWidth={2} aria-hidden="true" />{translate('terminal.menu.closeSession')}
      </button> : null}
      <div className="phone-session__state">
        <span className={`phone-session__status phone-session__status--${status.tone}`} title={session.status === 'error' ? session.error : undefined}>{status.label}</span>
        {elapsed ? <span className="phone-session__elapsed">{elapsed}</span> : null}
      </div>
      {attention ? (
        <div className={`phone-session__attention phone-session__attention--${attention.kind}`}>
          <AttentionIcon kind={attention.kind} />
          <span>{attention.message}</span>
        </div>
      ) : null}
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
