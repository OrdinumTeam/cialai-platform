// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Eye, Languages, Moon, RefreshCw, Sun, SunMoon } from 'lucide-react';
import { useI18n } from './i18n.js';

// Um toque troca para o oposto do que se ve; o seguinte volta a seguir o
// sistema, em vez de ficar preso num tema fixo.
function appearanceStep(appearance, t) {
  if (appearance.mode !== 'system') return { next: 'system', label: t('appearance.system'), Icon: SunMoon };
  if (appearance.resolved === 'dark') return { next: 'light', label: t('appearance.light'), Icon: Sun };
  return { next: 'dark', label: t('appearance.dark'), Icon: Moon };
}

export default function MobileHeader({ view, appearance, onReload, connection }) {
  const { locale, t, toggleLocale } = useI18n();
  const step = appearanceStep(appearance, t);
  const connectionText = t(`connection.${connection === 'connected' ? 'disconnected' : connection}`);
  const language = <button type="button" className="mac-tool" aria-label={t('language.switch')} title={t('language.switch')} onClick={toggleLocale}><Languages size={19} aria-hidden="true" /></button>;
  if (view.id === 'terminais') return connection === 'connected' ? <header className="ios-header ios-header--compact" data-locale={locale}>{language}</header> : <header className="ios-header ios-header--compact" data-locale={locale}><p className="ios-connection" role="status">{connectionText}</p>{language}</header>;
  return <header className="ios-header">
    <div className="ios-header__heading"><div><h1>{t(`view.${view.id}.label`)}</h1><p>{t(`view.${view.id}.sub`)}</p></div>
      <button type="button" className="mac-tool" aria-label={t('action.refresh')} onClick={onReload}><RefreshCw size={19} /></button>
      <button type="button" className="mac-tool" aria-label={step.label} onClick={() => appearance.setMode(step.next)}><step.Icon size={19} /></button>
      {language}
    </div>
    {view.id !== 'terminais' && <p className="ios-readonly"><Eye size={13} aria-hidden="true" />{t('state.readOnly')}</p>}
    {connection !== 'connected' && <p className="ios-connection" role="status">{connectionText}</p>}
    <div id="mac-toolbar-slot" />
  </header>;
}
