// SPDX-License-Identifier: Apache-2.0
// Minimizar, maximizar e fechar da janela sem moldura do Windows, no fim da
// toolbar. Os botões não são região de arraste.

import React, { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { windowControls } from '../lib/native.js';
import { WINDOW_CONTROL_LABELS } from './window-chrome.js';

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let off = null;
    windowControls.onMaximizedChange((value) => { if (!disposed) setMaximized(value); })
      .then((release) => { if (disposed) release(); else off = release; })
      .catch(() => {});
    return () => { disposed = true; off?.(); };
  }, []);

  const maximizeLabel = maximized ? WINDOW_CONTROL_LABELS.restore : WINDOW_CONTROL_LABELS.maximize;
  return <div className="mac-window-controls" role="group" aria-label="Controles da janela">
    <button type="button" className="mac-window-control" onClick={() => { windowControls.minimize().catch(() => {}); }} title={WINDOW_CONTROL_LABELS.minimize} aria-label={WINDOW_CONTROL_LABELS.minimize}><Minus aria-hidden="true" /></button>
    <button type="button" className="mac-window-control" onClick={() => { windowControls.toggleMaximize().catch(() => {}); }} title={maximizeLabel} aria-label={maximizeLabel}>{maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}</button>
    <button type="button" className="mac-window-control is-close" onClick={() => { windowControls.close().catch(() => {}); }} title={WINDOW_CONTROL_LABELS.close} aria-label={WINDOW_CONTROL_LABELS.close}><X aria-hidden="true" /></button>
  </div>;
}
