// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import BrandLockup from './BrandLockup.jsx';
import { translate } from './i18n.js';

export default function Splash({ status, leaving }) {
  const message = status === 'ready' ? translate('desktop.splash.ready') : status === 'error' ? translate('desktop.splash.error') : translate('desktop.splash.loading');
  return <div className={`mac-splash${leaving ? ' is-leaving' : ''}`} data-tauri-drag-region="deep" role="status" aria-live="polite"><BrandLockup className="mac-splash__lockup" /><div className="mac-splash__status">{message}</div><div className="mac-splash__bar" aria-hidden="true"><span /></div></div>;
}
