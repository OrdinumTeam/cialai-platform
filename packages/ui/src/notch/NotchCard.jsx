// SPDX-License-Identifier: Apache-2.0
// Detalhe de um perfil, num popover ao lado da barra.
//
// Segue o popover da casca: vidro, separador, sombra de popover e canto de
// 12. O cabecalho sempre diz provedor e perfil, porque num app com cinco
// contas do Codex "Codex" sozinho no titulo nao informa nada.

import React from 'react';
import { useI18n } from '../desktop/i18n.js';
import { ageCopy, elapsedCopy, groupLabel, moreSessionsCopy, planCopy, providerName, qualifierFor, resetCopy, sessionDetail, stateWord, statusMessage, usedCopy, windowLabel } from './copy.js';
import { bandOf, groupWindows } from './model.js';
import claudeGlyph from './glyphs/claude.svg?raw';
import openaiGlyph from './glyphs/openai.svg?raw';

const GLYPHS = { claude: claudeGlyph, codex: openaiGlyph };
/// Linhas de sessao antes do "e mais N".
const MAX_SESSIONS = 5;

function WindowRow({ limit, snapshot, now, prefs, headline, t, locale }) {
  const band = bandOf(limit.usedFraction, prefs.watchLimit, prefs.criticalLimit);
  const width = typeof limit.usedFraction === 'number' ? Math.max(2, Math.min(100, limit.usedFraction * 100)) : 0;
  return (
    <div className={`notch-card__window${headline ? ' is-headline' : ''}`}>
      <div className="notch-card__row">
        <span className="notch-card__label">{windowLabel(limit, t)}</span>
        <span className="notch-card__meta">{resetCopy(limit.resetsAtMs, now, prefs.resetTimeFormat, t, locale)}</span>
      </div>
      <span className="notch-card__track" aria-hidden="true">
        <span className={`notch-card__fill is-${band}`} style={{ width: `${width}%` }} />
      </span>
      <div className="notch-card__used">{usedCopy(limit.usedFraction, qualifierFor(snapshot.fidelity), t, locale)}</div>
    </div>
  );
}

function SessionRow({ session, now, onFocus, t }) {
  const clickable = Boolean(session.pid || session.ptyTag);
  return (
    <button
      type="button"
      className={`notch-card__session${clickable ? ' is-clickable' : ''}`}
      onClick={clickable ? () => onFocus(session) : undefined}
      disabled={!clickable}
      title={clickable ? t('desktop.notch.card.focusSession', { name: session.name }) : undefined}
    >
      <span className="notch-card__row">
        <span className="notch-card__label">{session.name}</span>
        <span className={`notch-card__state is-${session.state}`}>{stateWord(session.state, t)}</span>
      </span>
      <span className="notch-card__row">
        <span className="notch-card__meta">{sessionDetail(session, t)}</span>
        <span className="notch-card__meta">{elapsedCopy(session.sinceMs, now, t)}</span>
      </span>
    </button>
  );
}

export default function NotchCard({ snapshot, sessions, now, prefs, onFocusSession }) {
  const { t, locale } = useI18n();
  const provider = providerName(snapshot.provider, t);
  const title = t('desktop.notch.card.title', { provider, profile: snapshot.label });
  const hasReading = Boolean(snapshot.windows?.length);
  const stale = snapshot.status?.kind === 'stale';
  const { plain, groups } = groupWindows(snapshot.windows);
  const shown = sessions.slice(0, MAX_SESSIONS);
  const rest = sessions.length - shown.length;

  return (
    <div className="notch-card" role="dialog" aria-label={title}>
      <div className="notch-card__head">
        <span className="notch-card__glyph" dangerouslySetInnerHTML={{ __html: GLYPHS[snapshot.provider] || GLYPHS.claude }} />
        <span className="notch-card__title">{title}</span>
        {stale && <span className="notch-card__meta">{ageCopy(snapshot.fetchedAtMs, now, t)}</span>}
      </div>
      {snapshot.account && <div className="notch-card__sub">{snapshot.account}</div>}
      {snapshot.plan && <div className="notch-card__sub">{planCopy(snapshot.plan, t)}</div>}

      {!hasReading && <div className="notch-card__message">{statusMessage(snapshot, t)}</div>}

      {hasReading && (
        <div className="notch-card__windows">
          {plain.map((limit) => (
            <WindowRow key={limit.id} limit={limit} snapshot={snapshot} now={now} prefs={prefs} headline={limit.id === snapshot.headlineId} t={t} locale={locale} />
          ))}
          {groups.map(({ group, limits }) => (
            <div key={group} className="notch-card__group">
              <div className="notch-card__group-title">{groupLabel(group, t)}</div>
              {limits.map((limit) => (
                <WindowRow key={limit.id} limit={limit} snapshot={snapshot} now={now} prefs={prefs} headline={limit.id === snapshot.headlineId} t={t} locale={locale} />
              ))}
            </div>
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <div className="notch-card__sessions">
          {shown.map((session) => (
            <SessionRow key={session.id} session={session} now={now} onFocus={onFocusSession} t={t} />
          ))}
          {rest > 0 && <div className="notch-card__meta">{moreSessionsCopy(rest, t)}</div>}
        </div>
      )}
    </div>
  );
}
