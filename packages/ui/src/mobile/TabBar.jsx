// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { getView } from '../views/registry.js';
import { useI18n } from './i18n.js';

export const PHONE_TABS = ['terminais'];
export default function TabBar({ active, onNavigate, onMore }) {
  const { t } = useI18n();
  return <nav className="ios-tabbar" aria-label={t('navigation.mainSections')}>
    {PHONE_TABS.map((id) => {
      const view = getView(id); const Icon = view.icon;
      return <button key={id} type="button" aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={21} aria-hidden="true" /><span>{t(`view.${view.id}.label`)}</span></button>;
    })}
    <button type="button" aria-current={!PHONE_TABS.includes(active) ? 'page' : undefined} onClick={onMore}><MoreHorizontal size={21} aria-hidden="true" /><span>{t('navigation.more')}</span></button>
  </nav>;
}
