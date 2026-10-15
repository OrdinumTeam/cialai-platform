// SPDX-License-Identifier: Apache-2.0
// Window controls next to the app menu. The macOS green button toggles
// fullscreen; the middle button maximizes and restores on other platforms.

import React, { useEffect, useState } from 'react';
import { Copy, Maximize2, Minimize2, Minus, Square, X } from 'lucide-react';
import { watchFullscreen, windowControls } from '../lib/native.js';
import { platform } from '../lib/platform.js';
import { windowControlLabels } from './window-chrome.js';
import { translate, useI18n } from './i18n.js';

export default function WindowControls() {
  useI18n();
  const mac = platform().os === 'macos';
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let disposed = false;
    let off = null;
    const watch = mac ? watchFullscreen : windowControls.onMaximizedChange;
    watch((value) => { if (!disposed) setExpanded(value); })
      .then((release) => { if (disposed) release(); else off = release; })
      .catch(() => {});
    return () => { disposed = true; off?.(); };
  }, [mac]);

  const labels = windowControlLabels();
  const expandLabel = mac
    ? translate(expanded ? 'desktop.window.exitFullscreen' : 'desktop.window.enterFullscreen')
    : expanded ? labels.restore : labels.maximize;
  const minimize = <button key="minimize" type="button" data-control="minimize" className="mac-window-control is-minimize" disabled={mac && expanded} onClick={() => { windowControls.minimize().catch(() => {}); }} title={labels.minimize} aria-label={labels.minimize}><Minus aria-hidden="true" /></button>;
  const expand = <button key="expand" type="button" data-control={mac ? 'fullscreen' : 'maximize'} className="mac-window-control is-expand" onClick={() => { (mac ? windowControls.toggleFullscreen() : windowControls.toggleMaximize()).catch(() => {}); }} title={expandLabel} aria-label={expandLabel}>{mac ? expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" /> : expanded ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}</button>;
  const close = <button key="close" type="button" data-control="close" className="mac-window-control is-close" onClick={() => { windowControls.close().catch(() => {}); }} title={labels.close} aria-label={labels.close}><X aria-hidden="true" /></button>;
  return <div className={`mac-window-controls${mac ? ' is-traffic-lights' : ''}`} data-tauri-drag-region="false" role="group" aria-label={translate('desktop.window.controls')}>
    {mac ? [close, minimize, expand] : [minimize, expand, close]}
  </div>;
}
