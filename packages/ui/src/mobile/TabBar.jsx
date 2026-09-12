// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { getView } from '../views/registry.js';

export const PHONE_TABS = ['terminais'];
export default function TabBar({ active, onNavigate, onMore }) {
  return <nav className="ios-tabbar" aria-label="Seções principais">
    {PHONE_TABS.map((id) => {
      const view = getView(id); const Icon = view.icon;
      return <button key={id} type="button" aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={21} aria-hidden="true" /><span>{view.label}</span></button>;
    })}
    <button type="button" aria-current={!PHONE_TABS.includes(active) ? 'page' : undefined} onClick={onMore}><MoreHorizontal size={21} aria-hidden="true" /><span>Mais</span></button>
  </nav>;
}
