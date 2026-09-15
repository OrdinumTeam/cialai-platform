// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { useI18n } from './i18n.js';

const STATES = new Set(['connected', 'connecting', 'removed', 'incompatible', 'disconnected', 'disabled']);

// Dentro do aplicativo a casca nativa ja mostra o computador, o transporte e
// o botao de voltar; a pagina so avisa quando a ponte nao esta conectada, numa
// faixa fina. No navegador o cabecalho completo continua.
export default function MobileHeader({ desktopName, connection, compact = false }) {
  const { locale, t } = useI18n();
  const state = STATES.has(connection) ? connection : 'disconnected';
  if (compact && state === 'connected') return null;
  if (compact) {
    return <header className={`ios-header ios-header--strip ios-header--strip-${state}`} data-locale={locale}>
      <p className={`ios-connection ios-connection--${state}`} role="status"><span aria-hidden="true" />{t(`connection.${state}`)}</p>
    </header>;
  }
  return <header className="ios-header ios-header--terminal" data-locale={locale}>
    <h1>{desktopName}</h1>
    <p className={`ios-connection ios-connection--${state}`} role="status"><span aria-hidden="true" />{t(`connection.${state}`)}</p>
  </header>;
}
