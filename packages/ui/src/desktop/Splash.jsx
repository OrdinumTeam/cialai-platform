// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import logo from '../../../../brand/logo/cialai-mantis-v4-1-head-4k.png';

export default function Splash({ status, leaving }) {
  const message = status === 'ready' ? 'Pronto' : status === 'error' ? 'Não foi possível restaurar as sessões' : 'Carregando o estúdio';
  return <div className={`mac-splash${leaving ? ' is-leaving' : ''}`} data-tauri-drag-region="deep" role="status" aria-live="polite"><div className="mac-splash__aura" aria-hidden="true" /><img src={logo} alt="" className="mac-splash__logo" draggable="false" /><div className="mac-splash__name">Cialai</div><div className="mac-splash__status">{message}</div><div className="mac-splash__bar" aria-hidden="true"><span /></div></div>;
}
