// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import logo from '../assets/cialai-mark-256.png';
import { translate } from './i18n.js';

export default function Splash({ status, leaving }) {
  const message = status === 'ready' ? translate('desktop.splash.ready') : status === 'error' ? translate('desktop.splash.error') : translate('desktop.splash.loading');
  return <div className={`mac-splash${leaving ? ' is-leaving' : ''}`} data-tauri-drag-region="deep" role="status" aria-live="polite"><div className="mac-splash__aura" aria-hidden="true" /><img src={logo} alt="" className="mac-splash__logo" draggable="false" /><div className="mac-splash__name">Cialai</div><div className="mac-splash__status">{message}</div><div className="mac-splash__bar" aria-hidden="true"><span /></div></div>;
}
