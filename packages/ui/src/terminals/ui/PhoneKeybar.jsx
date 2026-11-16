// SPDX-License-Identifier: Apache-2.0
// Barra fixa do terminal do celular, sempre na mesma ordem: Conversa, Esc,
// Colar, teclado especial, comandos rápidos, Interromper e Enter. Os ícones
// vêm de `PhoneKeyIcons.jsx`, os mesmos do teclado especial.
//
// O toque curto executa. Segurar mostra só o nome da função num balão acima
// do botão e, ao soltar, nada acontece; com mouse o balão aparece ao passar o
// cursor. O gesto fica em `keybar-gesture.js`. As teclas saem pelo
// controlador de `special-keys.js`, como no painel; nenhuma repete ao segurar.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KEY_CATALOG } from '../keyboard-prefs.js';
import { createHintGesture, placeHint } from '../keybar-gesture.js';
import { keyName } from './PhoneKeyboardSheet.jsx';
import { KeyIcon } from './PhoneKeyIcons.jsx';
import { translate } from '../../shared/i18n.js';

// A classe decide o fundo: neutro, vermelho de parar ou a cor da sessão.
export const KEYBAR_BUTTONS = Object.freeze([
  { id: 'compose', icon: 'compose', hint: 'terminal.phone.bar.compose', className: 'phone-keybar__compose' },
  { id: 'Escape', icon: 'Escape', hint: 'terminal.phone.bar.escape', key: 'Escape', className: 'phone-keybar__key' },
  { id: 'CtrlV', icon: 'CtrlV', hint: 'terminal.phone.bar.paste', key: 'CtrlV', className: 'phone-keybar__key' },
  { id: 'keys', icon: 'keys', hint: 'terminal.phone.bar.keys', className: 'phone-keybar__keys' },
  { id: 'quick', icon: 'quick', hint: 'terminal.phone.bar.quick', className: 'phone-keybar__more' },
  { id: 'CtrlC', icon: 'CtrlC', hint: 'terminal.phone.bar.interrupt', key: 'CtrlC', className: 'phone-keybar__key phone-keybar__interrupt' },
  { id: 'Enter', icon: 'Enter', hint: 'terminal.phone.bar.enter', key: 'Enter', className: 'phone-keybar__key phone-keybar__enter' },
]);

function KeybarHint({ hint }) {
  const node = useRef(null);
  const [place, setPlace] = useState(null);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const width = document.documentElement.clientWidth || window.innerWidth;
    setPlace(placeHint(hint.anchor, { width: element.offsetWidth, height: element.offsetHeight }, width));
  }, [hint]);
  const style = place
    ? { left: `${place.left}px`, top: `${place.top}px`, '--phone-keybar-hint-arrow': `${place.arrow}px` }
    : { left: 0, top: 0, visibility: 'hidden' };
  return createPortal(
    <span ref={node} role="tooltip" id="phone-keybar-hint" className={`phone-keybar__hint${place?.below ? ' is-below' : ''}`} style={style}>
      {translate(hint.label)}
    </span>,
    document.body,
  );
}

const anchorOf = (element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom };
};

export default function PhoneKeybar({
  controller,
  interactive,
  keysOpen,
  armed,
  armedLabel,
  onPress,
  onCompose,
  onKeys,
  onQuick,
}) {
  const [hint, setHint] = useState(null);
  const gesture = useRef(null);
  if (!gesture.current) {
    gesture.current = createHintGesture({
      show: (id, anchor) => {
        const button = KEYBAR_BUTTONS.find((item) => item.id === id);
        if (button) setHint({ id, label: button.hint, anchor });
      },
      hide: () => setHint(null),
    });
  }
  useEffect(() => () => gesture.current.dispose(), []);

  const sendKey = (id) => {
    const entry = KEY_CATALOG[id];
    controller.click(entry.key, entry.mods);
    onPress(null, true);
  };

  const actions = {
    compose: onCompose,
    keys: onKeys,
    quick: onQuick,
    Escape: () => sendKey('Escape'),
    CtrlV: () => sendKey('CtrlV'),
    CtrlC: () => sendKey('CtrlC'),
    Enter: () => sendKey('Enter'),
  };

  const labels = {
    compose: translate('terminal.phone.composer.open'),
    keys: armed ? translate('terminal.phone.keys.openArmed', { keys: armedLabel }) : translate('terminal.phone.keys.open'),
    quick: translate('terminal.phone.quick.open'),
  };

  const handlers = (button) => ({
    onPointerDown: (event) => {
      // As teclas guardam no toque se o terminal tinha o foco, para devolvê-lo.
      if (button.key) onPress(event);
      gesture.current.pointerDown(button.id, event.pointerType, anchorOf(event.currentTarget));
    },
    onPointerUp: (event) => gesture.current.pointerUp(event.pointerType),
    onPointerCancel: () => gesture.current.pointerCancel(),
    onPointerLeave: () => gesture.current.pointerLeave(),
    onPointerEnter: (event) => gesture.current.pointerEnter(button.id, event.pointerType, anchorOf(event.currentTarget)),
    // O mousedown sem efeito padrão não tira o foco do terminal, e o menu do
    // toque longo daria lugar ao balão.
    onMouseDown: (event) => event.preventDefault(),
    onContextMenu: (event) => event.preventDefault(),
    onClick: () => { if (gesture.current.click(button.id)) actions[button.id](); },
  });

  return <>
    <div className="phone-keybar" role="toolbar" aria-label={translate('terminal.phone.terminalKeys')}>
      {KEYBAR_BUTTONS.map((button) => {
        const isKeys = button.id === 'keys';
        const className = `${button.className}${isKeys && armed ? ' is-armed' : ''}`;
        return <button
          key={button.id}
          type="button"
          className={className}
          disabled={isKeys ? undefined : !interactive}
          aria-label={button.key ? keyName(button.key) : labels[button.id]}
          aria-expanded={isKeys ? keysOpen : undefined}
          aria-describedby={hint?.id === button.id ? 'phone-keybar-hint' : undefined}
          {...handlers(button)}
        ><KeyIcon id={button.icon} /></button>;
      })}
    </div>
    {hint ? <KeybarHint hint={hint} /> : null}
  </>;
}
