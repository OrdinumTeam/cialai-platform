// SPDX-License-Identifier: Apache-2.0
import React from 'react';

const STATES = {
  connected: 'Conectado',
  connecting: 'Conectando',
  removed: 'Celular removido',
  incompatible: 'Atualização necessária',
  disconnected: 'Sem conexão',
  disabled: 'Aguardando conexão',
};

export default function MobileHeader({ desktopName, connection }) {
  const state = STATES[connection] || STATES.disconnected;
  return <header className="ios-header ios-header--terminal">
    <h1>{desktopName}</h1>
    <p className={`ios-connection ios-connection--${connection}`} role="status"><span aria-hidden="true" />{state}</p>
  </header>;
}
