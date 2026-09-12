// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import Drawer from '@mui/material/Drawer';
import { ChevronRight, X } from 'lucide-react';
import { VIEWS, groupViews } from '../views/registry.js';
import { PHONE_TABS } from './TabBar.jsx';

export default function MoreSheet({ open, onClose, onNavigate, active }) {
  return <Drawer anchor="bottom" open={open} onClose={onClose} PaperProps={{ className: 'ios-more', role: 'dialog', 'aria-label': 'Mais seções' }}>
    <div className="ios-more__head"><h2>Mais</h2><button type="button" className="mac-tool" aria-label="Fechar seções" onClick={onClose}><X size={20} /></button></div>
    <nav aria-label="Todas as seções">{groupViews(VIEWS.filter((view) => !PHONE_TABS.includes(view.id))).map((group) => <section key={group.key}>
      {group.group && <h3>{group.group}</h3>}
      {group.views.map((view) => { const Icon = view.icon; return <button type="button" key={view.id} aria-current={active === view.id ? 'page' : undefined} onClick={() => { onNavigate(view.id); onClose(); }}><Icon size={20} aria-hidden="true" /><span>{view.label}</span><ChevronRight size={17} aria-hidden="true" /></button>; })}
    </section>)}</nav>
  </Drawer>;
}
