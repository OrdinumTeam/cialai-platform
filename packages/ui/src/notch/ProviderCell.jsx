// SPDX-License-Identifier: Apache-2.0
// Celula de um perfil na barra: anel, percentual e o nome do perfil.
//
// O nome e o que distingue cinco contas do mesmo provedor; o glifo sozinho
// nao diz nada. O percentual e o da janela do anel daquela conta, a sessao
// atual. O anel de dentro e o do uso semanal, quando a conta tem um; a
// descricao acessivel nomeia as duas janelas, o uso e a renovacao.
//
// A atividade da sessao aparece como o estudio ja mostra nos cards: tres
// barras respirando enquanto trabalha, um ponto ambar quando espera, um ponto
// verde quando acabou.

import React, { useId } from 'react';
import { useI18n } from '../desktop/i18n.js';
import Ring from './Ring.jsx';
import { cellState, weeklyState } from './model.js';
import { DASH, percentText, providerName, ringsCopy } from './copy.js';

function Live({ activity }) {
  if (!activity || activity.state === 'idle') return null;
  if (activity.state === 'busy') {
    return (
      <span className="notch-live notch-live--busy" aria-hidden="true">
        <i /><i /><i />
      </span>
    );
  }
  return <span className={`notch-live notch-live--dot is-${activity.state}`} aria-hidden="true" />;
}

export default function ProviderCell({ snapshot, activity, hovered, refreshing, prefs, onClick, onEnter, onLeave, cellRef }) {
  const { t, locale } = useI18n();
  const { fraction, hasReading, stale, band } = cellState(snapshot, prefs);
  const weekly = weeklyState(snapshot, prefs || {});
  const percent = hasReading && fraction !== null ? `${percentText(fraction, locale)}%` : DASH;
  const describedBy = useId();

  return (
    <button
      ref={cellRef}
      type="button"
      className={`notch-cell${hovered ? ' is-hovered' : ''}${refreshing ? ' is-refreshing' : ''}`}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      aria-label={t('desktop.notch.cell.label', { provider: providerName(snapshot.provider, t), profile: snapshot.label })}
      aria-describedby={describedBy}
    >
      <span id={describedBy} className="sr-only">{ringsCopy(snapshot, prefs || {}, Date.now(), t, locale)}</span>
      <span className="notch-cell__ring">
        <Ring provider={snapshot.provider} fraction={fraction} band={band} stale={stale} weekly={weekly} />
        <Live activity={activity} />
      </span>
      <span className={`notch-cell__percent is-${band}`}>{percent}</span>
      <span className="notch-cell__profile">{snapshot.label}</span>
    </button>
  );
}
