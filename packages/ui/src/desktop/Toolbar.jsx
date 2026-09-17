// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Link2, Moon, PanelLeft, RefreshCw, Search, Settings, Sun } from 'lucide-react';
import { shortcutLabel } from '../lib/keys.js';
import { platform } from '../lib/platform.js';
import AppMenuButton from './AppMenuButton.jsx';
import NotchIndicator from './NotchIndicator.jsx';
import { windowChrome } from './window-chrome.js';
import WindowControls from './WindowControls.jsx';
import { translate } from './i18n.js';

export default function Toolbar({ view, sidebarHidden, onToggleSidebar, onOpenPalette, onReload, appearance, onOpenPreferences, tunnelStatus, onOpenPair, menuActions, views }) {
  const dark = appearance.resolved === 'dark';
  const chrome = windowChrome(platform().os);
  return <header className={`mac-toolbar${sidebarHidden ? ' is-sidebar-hidden' : ''}`} data-tauri-drag-region="deep">
    <div className="mac-toolbar__leading"><button type="button" className="mac-tool" onClick={onToggleSidebar} title={translate('desktop.action.toggleSidebar')}><PanelLeft size={16} strokeWidth={1.75} /></button><div className="mac-toolbar__titles" key={view.id}><h1 className="mac-toolbar__title" id="topbarTitle">{view.label}</h1><span className="mac-toolbar__subtitle" id="topbarSub">{view.sub}</span></div></div>
    <div className="mac-toolbar__trailing"><div id="mac-toolbar-slot" className="mac-toolbar__slot" /><NotchIndicator /><button type="button" className={`mac-tunnel-status is-${tunnelStatus?.tone || 'idle'}`} onClick={onOpenPair} title={translate('desktop.action.pairPhone')}><Link2 aria-hidden="true" /><span className={`mac-dot is-${tunnelStatus?.tone || 'idle'}`} aria-hidden="true" /><span>{tunnelStatus?.label || translate('desktop.tunnel.starting')}</span></button><button type="button" className="mac-tool" onClick={onReload} title={translate('desktop.action.reloadBrowser')}><RefreshCw size={15} strokeWidth={1.75} /></button><button type="button" className="mac-tool" onClick={() => appearance.setMode(dark ? 'light' : 'dark')} title={dark ? translate('desktop.appearance.light') : translate('desktop.appearance.dark')}>{dark ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}</button><button type="button" className="mac-tool" onClick={onOpenPreferences} title={translate('desktop.preferences.title')}><Settings size={15} strokeWidth={1.75} /></button><button type="button" className="mac-tool mac-tool--search" onClick={onOpenPalette} title={translate('desktop.palette.title')}><Search size={13} strokeWidth={2} /><span>{translate('desktop.action.search')}</span><kbd>{shortcutLabel('Mod+K')}</kbd></button>{chrome.menuButton ? <AppMenuButton actions={menuActions} views={views} /> : null}</div>
    {chrome.windowControls ? <WindowControls /> : null}
  </header>;
}
