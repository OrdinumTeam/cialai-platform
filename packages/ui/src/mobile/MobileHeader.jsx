// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { useI18n } from './i18n.js';

const STATES = new Set(['connected', 'connecting', 'removed', 'incompatible', 'disconnected', 'disabled']);

export default function MobileHeader({ desktopName, connection }) {
  const { locale, t } = useI18n();
  const state = STATES.has(connection) ? connection : 'disconnected';
  return <header className="ios-header ios-header--terminal" data-locale={locale}>
    <h1>{desktopName}</h1>
    <p className={`ios-connection ios-connection--${connection}`} role="status"><span aria-hidden="true" />{t(`connection.${state}`)}</p>
  </header>;
}
