// SPDX-License-Identifier: Apache-2.0
// Botão de menu da toolbar no Linux e no Windows, com as ações da menubar do
// macOS. Os atalhos continuam no DOM por `installDomShortcuts`.

import React, { useCallback, useRef, useState } from 'react';
import { Menu as MenuIcon } from 'lucide-react';
import Menu from '../terminals/ui/Menu.jsx';
import '../views/Terminais.css';
import { shortcutLabel } from '../lib/keys.js';
import { appMenuItems } from './window-chrome.js';

const REOPEN_GUARD_MS = 250;

export default function AppMenuButton({ actions, views }) {
  const [anchor, setAnchor] = useState(null);
  const closedAt = useRef(0);
  const close = useCallback(() => { closedAt.current = Date.now(); setAnchor(null); }, []);
  const toggle = (event) => {
    // O clique que fecha o menu por fora não deve reabri-lo no mesmo gesto.
    if (Date.now() - closedAt.current < REOPEN_GUARD_MS) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor((current) => current ? null : { x: rect.right, y: rect.bottom + 6, align: 'right' });
  };
  return <>
    <button type="button" className={`mac-tool mac-tool--menu${anchor ? ' is-open' : ''}`} onClick={toggle} title="Menu do aplicativo" aria-label="Menu do aplicativo" aria-haspopup="menu" aria-expanded={Boolean(anchor)}><MenuIcon size={16} strokeWidth={1.75} /></button>
    {anchor ? <Menu anchor={anchor} items={appMenuItems(actions, views, { label: shortcutLabel })} onClose={close} label="Menu do aplicativo" /> : null}
  </>;
}
