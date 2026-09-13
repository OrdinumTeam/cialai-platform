// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Link2, Moon, PanelLeft, RefreshCw, Search, Settings, Sun } from 'lucide-react';

export default function Toolbar({ view, sidebarHidden, onToggleSidebar, onOpenPalette, onReload, appearance, onOpenPreferences, tunnelStatus, onOpenPair }) {
  const dark = appearance.resolved === 'dark';
  return <header className={`mac-toolbar${sidebarHidden ? ' is-sidebar-hidden' : ''}`} data-tauri-drag-region="deep">
    <div className="mac-toolbar__leading"><button type="button" className="mac-tool" onClick={onToggleSidebar} title="Mostrar ou ocultar barra lateral"><PanelLeft size={16} strokeWidth={1.75} /></button><div className="mac-toolbar__titles" key={view.id}><h1 className="mac-toolbar__title" id="topbarTitle">{view.label}</h1><span className="mac-toolbar__subtitle" id="topbarSub">{view.sub}</span></div></div>
    <div className="mac-toolbar__trailing"><div id="mac-toolbar-slot" className="mac-toolbar__slot" /><button type="button" className={`mac-tunnel-status is-${tunnelStatus?.tone || 'idle'}`} onClick={onOpenPair} title="Vincular celular"><Link2 aria-hidden="true" /><span className={`mac-dot is-${tunnelStatus?.tone || 'idle'}`} aria-hidden="true" /><span>{tunnelStatus?.label || 'Rede não configurada'}</span></button><button type="button" className="mac-tool" onClick={onReload} title="Recarregar navegador ativo"><RefreshCw size={15} strokeWidth={1.75} /></button><button type="button" className="mac-tool" onClick={() => appearance.setMode(dark ? 'light' : 'dark')} title={dark ? 'Aparência clara' : 'Aparência escura'}>{dark ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}</button><button type="button" className="mac-tool" onClick={onOpenPreferences} title="Preferências"><Settings size={15} strokeWidth={1.75} /></button><button type="button" className="mac-tool mac-tool--search" onClick={onOpenPalette} title="Buscar comandos"><Search size={13} strokeWidth={2} /><span>Buscar</span><kbd>⌘K</kbd></button></div>
  </header>;
}
