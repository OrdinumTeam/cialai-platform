// SPDX-License-Identifier: Apache-2.0
// Card de sessao: pequeno instrumento de acompanhamento. Nome da pasta em
// destaque, subtitulo dado pelo usuario, o que esta rodando, o estado em
// linguagem simples, um sinal de atencao quando houver e CPU e memoria
// reais. O que nao foi observado nao aparece.
//
// Com um agente reconhecido e o hook de linha de estado instalado, o card
// mostra tambem o modelo, quanto da janela de contexto ja foi usada, o custo
// estimado da sessao e o uso do plano. Sem o hook, um botao instala a linha
// de estado nos perfis do Claude Code.
//
// O card assina so a atividade da propria sessao: a saida dos outros
// terminais e as metricas dos outros cards nao o redesenham. As barras de
// atividade so animam com um processo rodando de verdade.

import React, { memo, useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle2, MoreHorizontal, Pin, Sparkles, XCircle } from 'lucide-react';
import { fmtCost, fmtCpu, fmtElapsed, fmtMemory, fmtPlan, fmtResetAt, shortPath } from '../files.js';
import { describe, runningLabel, sessionAccent, sessionPlan, sessionUsage } from '../runtime.js';
import { wasDragged } from '../drag.js';
import { useRuntimeEvents } from '../hooks.js';
import { useToast } from '../../components/ui.jsx';
import { invoke, isTauri } from '../../lib/native.js';
import { platform } from '../../lib/platform.js';
import ActivityIndicator from './ActivityIndicator.jsx';
import { claudeHookMissingTitle } from '../claude-hook-help.js';
import { getLocale, translate, useI18n } from '../../shared/i18n.js';

// Toque longo que abre o menu de acoes, sem disparar selecao nem rolagem.
const LONG_PRESS_MS = 500;


function AttentionIcon({ kind }) {
  if (kind === 'finished') return <CheckCircle2 size={12} strokeWidth={2} aria-hidden="true" />;
  if (kind === 'error') return <XCircle size={12} strokeWidth={2} aria-hidden="true" />;
  return <Bell size={12} strokeWidth={2} aria-hidden="true" />;
}

// Quanto do plano do agente ja foi gasto. A janela mais curta, a da sessao,
// e a que aparece no card; as outras ficam na dica, junto do perfil, da
// pasta de configuracao e do modelo.
function planTitle(plan, activity, model) {
  const lines = [];
  const usage = activity?.usage || null;
  const profileName = activity?.profileName || usage?.profileName;
  const dir = usage?.configDir || activity?.configDir;
  lines.push(translate(dir ? 'terminal.plan.profilePath' : 'terminal.plan.profile', {
    profile: profileName || usage?.profile || activity?.profile,
    path: shortPath(dir),
  }));
  lines.push(translate(plan.plan ? 'terminal.plan.named' : 'terminal.plan.usage', {
    agent: activity?.agent || usage?.agent,
    plan: plan.plan,
  }));
  lines.push('');
  plan.windows.forEach((window) => {
    const reset = fmtResetAt(window.resetsAtMs);
    lines.push(translate(reset ? 'terminal.plan.renews' : 'terminal.plan.window', {
      label: window.label,
      usage: fmtPlan(window.percent),
      reset,
    }));
  });
  if (model) lines.push('', translate('terminal.plan.model', { model }));
  // Leitura velha aparece apagada e diz que esta velha: um numero antigo sem
  // aviso vale menos que nenhum numero.
  if (plan.stale) lines.push('', translate('terminal.profiles.stale'));
  if (plan.updatedAtMs) lines.push(translate('terminal.plan.updated', { time: fmtAgo(plan.updatedAtMs) }));
  return lines.join('\n');
}

function fmtAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (seconds < 90) return translate('terminal.plan.secondsAgo', { count: seconds.toLocaleString(getLocale()) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return translate('terminal.plan.minutesAgo', { count: minutes.toLocaleString(getLocale()) });
  return translate('terminal.plan.hoursAgo', { count: Math.round(minutes / 60).toLocaleString(getLocale()) });
}

// Agente com perfil conhecido, mas sem numero publicado para ele.
function missingTitle(activity) {
  const profile = activity.profileName || activity.profile;
  if (activity.agent === 'Claude Code') return claudeHookMissingTitle(profile, platform().os);
  if (activity.agent === 'Codex') return translate('terminal.plan.missingCodex', { path: shortPath(activity.configDir || '') });
  return undefined;
}

// Tom do numero de uso do plano: neutro ate 75 por cento, atencao ate 90 e
// alarme acima disso. A tela de contas usa o mesmo.
export function planTone(percent) {
  if (percent >= 90) return 'bad';
  if (percent >= 75) return 'warn';
  return 'ok';
}


// Botao que instala a linha de estado nos perfis do Claude Code, so no app
// do computador: e onde os perfis moram e onde o comando existe.
function InstallHook({ activity }) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  if (!isTauri()) return null;
  const install = async (event) => {
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const result = await invoke('ai_install_claude_hook');
      const count = Number(result?.installed) || 0;
      notify(count > 0 ? translate('terminal.plan.installed', { count: count.toLocaleString(getLocale()) }) : translate('terminal.plan.installNone'), count > 0 ? 'success' : 'warning');
    } catch (error) {
      notify(translate('terminal.plan.installFailed', { error: error?.message || String(error) }), 'warning');
    } finally { setBusy(false); }
  };
  return <button type="button" className="terminais-card__install" disabled={busy} title={`${translate('terminal.plan.installTitle')}\n${missingTitle(activity) || ''}`.trim()} onMouseDown={(event) => event.stopPropagation()} onClick={install}>
    <Sparkles size={11} strokeWidth={2} aria-hidden="true" />{translate(busy ? 'terminal.plan.installing' : 'terminal.plan.install')}
  </button>;
}

// Variaveis CSS com o tom atribuido a sessao.
export function accentStyle(session) {
  const accent = sessionAccent(session);
  if (!accent) return undefined;
  return { '--terminais-accent-light': accent.light, '--terminais-accent-dark': accent.dark };
}

function SessionCard({
  order = 0,
  touch = false,
  session, selected, dragging, dropBefore, dropAfter, dropInto = false, renaming, onSelect, onMenu, onRename, onRenameDone,
  onDragStart,
}) {
  useI18n();
  // Atividade da propria sessao e os eventos de lista, raros, que trazem
  // nome, subtitulo, cor e fixacao mudados no mesmo objeto.
  useRuntimeEvents(['activity', 'sessions'], session.id);
  const [draft, setDraft] = useState(session.name);
  const inputRef = useRef(null);
  // Toque longo no card abre o mesmo menu do botao de tres pontos. O timer e
  // cancelado por qualquer movimento ou pelo fim do toque, para nao roubar um
  // toque simples nem a rolagem da lista.
  const longPress = useRef(null);
  const cancelLongPress = () => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } };
  useEffect(() => cancelLongPress, []);

  useEffect(() => {
    if (!renaming) return undefined;
    setDraft(session.name);
    const timer = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 20);
    return () => clearTimeout(timer);
  }, [renaming, session.name]);

  const status = describe(session);
  const running = runningLabel(session);
  const activity = session.activity;
  const cpu = activity?.available && activity.cpu != null ? fmtCpu(activity.cpu) : null;
  const memory = activity?.available && activity.memory != null ? fmtMemory(activity.memory) : null;
  const metricsUnavailable = session.status === 'running' && activity && !activity.available;
  // O uso e do agente, entao acompanha o nome dele na linha do que esta
  // rodando. A janela mais curta e a mostrada; as outras ficam na dica.
  // O plano da conta vem da mesma leitura da tela de contas, entao Claude
  // Code e Codex mostram o mesmo tipo de numero. O arquivo do proprio agente
  // continua sendo a fonte de modelo, contexto e custo.
  const plan = activity?.agent ? sessionPlan(activity) : null;
  const planWindow = plan?.windows?.[0] || null;
  const usage = activity?.usage?.windows?.length ? activity.usage : null;
  const detail = activity?.usage ? sessionUsage(activity) : null;
  const model = detail?.model || null;
  const context = detail?.contextUsedPercent != null ? fmtPlan(detail.contextUsedPercent) : null;
  const cost = detail?.costUsd != null ? fmtCost(detail.costUsd) : null;
  const missing = Boolean(activity?.agent && activity.profile && !planWindow);
  const showInstall = missing && activity.agent === 'Claude Code' && !touch && session.status === 'running';
  const showProfile = Boolean(activity?.profileName && activity.profile && !['claude', 'codex'].includes(activity.profile));
  const elapsed = session.jobStartedAt && session.status === 'running' ? fmtElapsed(Date.now() - session.jobStartedAt) : null;
  const attention = session.attention;

  const classes = ['terminais-card'];
  if (selected) classes.push('is-selected');
  if (dragging) classes.push('is-dragging');
  if (dropBefore) classes.push('is-drop-before');
  if (dropAfter) classes.push('is-drop-after');
  if (dropInto) classes.push('is-drop');
  if (attention) classes.push('has-attention', `has-attention--${attention.kind}`);
  if (session.pinned) classes.push('is-pinned');
  if (session.color) classes.push('has-color');

  const commit = () => onRenameDone(draft);

  // Arraste por ponteiro para reordenar, no mousedown do card; o botao de
  // menu e o campo de renomear ficam de fora para continuarem clicaveis.
  return (
    <div
      className={classes.join(' ')}
      style={{ ...accentStyle(session), '--i': order }}
      role={touch ? 'button' : 'option'}
      aria-selected={touch ? undefined : selected}
      tabIndex={touch || selected ? 0 : -1}
      data-session-id={session.id}
      onClick={() => { if (wasDragged()) return; onSelect(session.id); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(session.id); }
      }}
      onContextMenu={touch ? undefined : (event) => { event.preventDefault(); onMenu(session, { x: event.clientX, y: event.clientY, align: 'left' }); }}
      onPointerDown={touch && onMenu ? (event) => {
        if (event.target.closest?.('.terminais-card__menu')) return;
        cancelLongPress();
        longPress.current = setTimeout(() => { longPress.current = null; onMenu(session, { touch: true }); }, LONG_PRESS_MS);
      } : undefined}
      onPointerMove={touch && onMenu ? cancelLongPress : undefined}
      onPointerUp={touch && onMenu ? cancelLongPress : undefined}
      onPointerCancel={touch && onMenu ? cancelLongPress : undefined}
      onMouseDown={touch || renaming || !onDragStart ? undefined : (event) => {
        if (event.target.closest?.('.terminais-card__menu, .terminais-card__rename, .terminais-card__install')) return;
        onDragStart(event, session);
      }}
      title={shortPath(session.cwd)}
    >
      <div className="terminais-card__row">
        <ActivityIndicator tone={status.tone} animated={status.animated} />
        {renaming ? (
          <input
            ref={inputRef}
            className="terminais-card__rename"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              if (event.key === 'Escape') { event.preventDefault(); onRenameDone(null); }
            }}
            aria-label={translate('terminal.session.name')}
            spellCheck={false}
          />
        ) : (
          <span className="terminais-card__name" onDoubleClick={touch ? undefined : (event) => { event.stopPropagation(); onRename(session); }}>{session.name}</span>
        )}
        {session.pinned ? <Pin size={11} strokeWidth={2} className="terminais-card__pin" role="img" aria-label={translate('terminal.session.pinned')} /> : null}
        {onMenu ? <button
          type="button"
          className="terminais-card__menu"
          aria-label={translate('terminal.session.actionsFor', { name: session.name })}
          onClick={(event) => {
            event.stopPropagation();
            if (touch) { onMenu(session, { touch: true }); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(session, { x: rect.right, y: rect.bottom + 4, align: 'right', flipOffset: rect.height + 8 });
          }}
        >
          <MoreHorizontal size={touch ? 20 : 14} strokeWidth={2} aria-hidden="true" />
        </button> : null}
      </div>
      {session.subtitle ? <div className="terminais-card__subtitle">{session.subtitle}</div> : null}
      {running ? (
        <div className="terminais-card__running-row">
          <span className={`terminais-card__running${running.agent ? ' is-agent' : ''}`} title={running.agent && missing ? missingTitle(activity) : undefined}>{running.text}</span>
          {running.agent && planWindow ? (
            <span className={`terminais-card__plan terminais-card__plan--${planTone(planWindow.percent)}${plan.stale ? ' is-stale' : ''}`} title={planTitle(plan, activity, model)}>
              {fmtPlan(planWindow.percent)}
            </span>
          ) : null}
          {running.agent && showInstall ? <InstallHook activity={activity} /> : null}
          {running.background ? <span className="terminais-card__running-note">{translate('terminal.session.background')}</span> : null}
          {elapsed && !running.background ? <span className="terminais-card__elapsed">{elapsed}</span> : null}
        </div>
      ) : null}
      {running?.agent && (model || context || cost || showProfile) ? (
        <div className="terminais-card__agent-row">
          {model ? <span className="terminais-card__model" title={translate('terminal.session.model', { model })}>{model}</span> : null}
          {context ? <span className={`terminais-card__chip terminais-card__chip--${planTone(detail.contextUsedPercent)}`} title={translate('terminal.session.contextTitle', { percent: context })}>{translate('terminal.session.context', { percent: context })}</span> : null}
          {cost ? <span className="terminais-card__chip" title={translate('terminal.session.costTitle', { amount: cost })}>{translate('terminal.session.cost', { amount: cost })}</span> : null}
          {showProfile ? <span className="terminais-card__profile" title={translate(usage?.configDir ? 'terminal.session.profileWithPath' : 'terminal.session.profile', { profile: activity.profileName, path: shortPath(usage?.configDir) })}>{activity.profileName}</span> : null}
        </div>
      ) : null}
      <div className="terminais-card__state">
        <span className={`terminais-card__status terminais-card__status--${status.tone}`}>{status.label}</span>
      </div>
      {attention && attention.kind !== 'exited' && attention.kind !== 'error' ? (
        <div className={`terminais-card__attention terminais-card__attention--${attention.kind}`}>
          <AttentionIcon kind={attention.kind} />
          <span>{attention.message}</span>
        </div>
      ) : null}
      {session.status === 'running' ? (
        <div className="terminais-card__metrics">
          {cpu != null ? <span><em>{translate('terminal.common.cpu')}</em> {cpu}</span> : null}
          {memory != null ? <span><em>{translate('terminal.common.memory')}</em> {memory}</span> : null}
          {metricsUnavailable ? <span className="terminais-card__metrics-off">{translate('terminal.session.metricsUnavailable')}</span> : null}
          {!activity ? <span className="terminais-card__metrics-off">{translate('terminal.session.measuring')}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default memo(SessionCard);
