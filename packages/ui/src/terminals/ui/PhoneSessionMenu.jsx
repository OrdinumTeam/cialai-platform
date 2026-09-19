// SPDX-License-Identifier: Apache-2.0
// Ações de terminal no celular. O card no modo toque desligava menu de
// contexto, arraste, duplo clique e o botão de três pontos, então nenhuma das
// ações do menu do computador existia no aparelho.
//
// Aqui elas voltam numa folha inferior, aberta pelo botão de três pontos do
// card ou por toque longo, e pelo mesmo menu no cabeçalho do terminal aberto.
// Fora ficam as que só fazem sentido no computador: abrir e parar o Dev
// Browser e abrir a pasta no gerenciador de arquivos.
import React, { useState } from 'react';
import {
  ArrowDown, ArrowUp, Copy, FolderSearch, Palette, Pin, PinOff, Plus, Power, RotateCcw, Tag, TextCursorInput, UserRound,
} from 'lucide-react';
import { Sheet } from './dialogs.jsx';
import { SESSION_COLORS, canMoveSession } from '../runtime.js';
import { translate } from '../../shared/i18n.js';

// Uma entrada por ação, na ordem do menu do computador. `kind` é o que o
// chamador recebe; nenhuma ação é executada aqui dentro.
export function menuItems(session) {
  if (!session) return [];
  const running = session.status === 'running';
  return [
    { kind: 'rename', label: translate('terminal.menu.renameSession'), icon: TextCursorInput },
    { kind: 'subtitle', label: translate(session.subtitle ? 'terminal.menu.editSubtitle' : 'terminal.menu.setSubtitle'), icon: Tag },
    { kind: 'color', label: translate('terminal.menu.sessionColor'), icon: Palette },
    { kind: 'pin', label: translate(session.pinned ? 'terminal.menu.unpin' : 'terminal.menu.pin'), icon: session.pinned ? PinOff : Pin },
    { kind: 'up', label: translate('terminal.menu.moveUp'), icon: ArrowUp, disabled: !canMoveSession(session.id, -1) },
    { kind: 'down', label: translate('terminal.menu.moveDown'), icon: ArrowDown, disabled: !canMoveSession(session.id, 1) },
    { kind: 'clone', label: translate('terminal.menu.newSessionDirectory'), icon: Plus },
    // Um terminal ja aberto nao muda de ambiente: abrir o agente com as
    // variaveis na linha e a unica forma de trocar de conta nele.
    {
      kind: 'launch',
      label: translate('terminal.profiles.launchHere'),
      icon: UserRound,
      disabled: !running || Boolean(session.activity?.foreground),
      hint: session.activity?.foreground ? translate('terminal.profiles.launchBusy') : undefined,
    },
    { kind: 'directory', label: translate('terminal.menu.changeFolder'), icon: FolderSearch, disabled: !running },
    { kind: 'copy', label: translate('terminal.explorer.copyPath'), icon: Copy },
    { kind: 'restart', label: translate('terminal.menu.restartTerminal'), icon: RotateCcw },
    { kind: 'close', label: translate('terminal.menu.closeSession'), icon: Power, danger: true },
  ];
}

export default function PhoneSessionMenu({ session, open, onClose, onAction }) {
  const [colors, setColors] = useState(false);
  if (!session) return null;
  const close = () => { setColors(false); onClose(); };
  const run = (kind) => {
    if (kind === 'color') { setColors(true); return; }
    close();
    onAction(kind, session);
  };
  return (
    <Sheet
      open={open}
      title={session.name}
      onClose={close}
      actions={<button type="button" className="btn btn-ghost" onClick={close}>{translate('terminal.common.cancel')}</button>}
    >
      {colors ? (
        <div className="phone-menu phone-menu--colors" role="menu" aria-label={translate('terminal.menu.sessionColor')}>
          <button type="button" className="phone-menu__item" role="menuitem" onClick={() => { close(); onAction('color', session, null); }}>
            <span className="phone-menu__swatch phone-menu__swatch--none" aria-hidden="true" />
            {translate('terminal.menu.noColor')}
          </button>
          {SESSION_COLORS.map((color) => (
            <button
              type="button"
              key={color.id}
              className="phone-menu__item"
              role="menuitem"
              onClick={() => { close(); onAction('color', session, color.id); }}
            >
              <span className="phone-menu__swatch" style={{ background: color.dark }} aria-hidden="true" />
              {translate(`terminal.color.${color.id}`)}
            </button>
          ))}
        </div>
      ) : (
        <div className="phone-menu" role="menu" aria-label={translate('terminal.session.actionsFor', { name: session.name })}>
          {menuItems(session).map((item) => (
            <button
              type="button"
              key={item.kind}
              className={`phone-menu__item${item.danger ? ' is-danger' : ''}`}
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              onClick={() => run(item.kind)}
            >
              <item.icon size={18} strokeWidth={1.75} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
