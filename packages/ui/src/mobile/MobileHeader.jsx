// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Eye, Moon, RefreshCw, Sun, SunMoon } from 'lucide-react';

// Um toque troca para o oposto do que se ve; o seguinte volta a seguir o
// sistema, em vez de ficar preso num tema fixo.
function appearanceStep(appearance) {
  if (appearance.mode !== 'system') return { next: 'system', label: 'Voltar à aparência do sistema', Icon: SunMoon };
  if (appearance.resolved === 'dark') return { next: 'light', label: 'Usar aparência clara', Icon: Sun };
  return { next: 'dark', label: 'Usar aparência escura', Icon: Moon };
}

export default function MobileHeader({ view, appearance, onReload, connection }) {
  const step = appearanceStep(appearance);
  if (view.id === 'terminais') return connection === 'connected' ? null : <header className="ios-header ios-header--compact"><p className="ios-connection" role="status">{connection === 'connecting' ? 'Conectando ao Mac…' : 'Ponte com o Mac desconectada'}</p></header>;
  return <header className="ios-header">
    <div className="ios-header__heading"><div><h1>{view.label}</h1><p>{view.sub}</p></div>
      <button type="button" className="mac-tool" aria-label="Atualizar dados" onClick={onReload}><RefreshCw size={19} /></button>
      <button type="button" className="mac-tool" aria-label={step.label} onClick={() => appearance.setMode(step.next)}><step.Icon size={19} /></button>
    </div>
    {view.id !== 'terminais' && <p className="ios-readonly"><Eye size={13} aria-hidden="true" />Somente visualização</p>}
    {connection !== 'connected' && <p className="ios-connection" role="status">{connection === 'connecting' ? 'Conectando ao Mac…' : 'Ponte com o Mac desconectada'}</p>}
    <div id="mac-toolbar-slot" />
  </header>;
}
