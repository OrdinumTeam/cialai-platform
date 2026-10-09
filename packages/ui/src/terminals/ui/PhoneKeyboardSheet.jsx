// SPDX-License-Identifier: Apache-2.0
// Teclado especial do celular: Esc, Tab, modificadores, setas e as teclas que
// o teclado do aparelho não tem, num painel inferior com quatro abas.
//
// O painel fica no fluxo da coluna do terminal, e não por cima dele: abrir
// encolhe o terminal, que se reajusta e continua mostrando o prompt e as
// últimas linhas. Enquanto ele está aberto o teclado do aparelho fica
// fechado, e tocar no terminal fecha o painel.
//
// Nenhum botão escreve no terminal: todos repassam o toque ao controlador de
// `special-keys.js`, que combina os modificadores armados, codifica a
// sequência e evita envio duplicado.
import React, { useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronLeft, ChevronUp, Keyboard, Lock, Settings2, X } from 'lucide-react';
import { FAVORITE_CHOICES, KEYBOARD_TABS, KEY_CATALOG, MAX_FAVORITES, MODIFIER_KEYS, PASTE_KEY, SYMBOLS, moveFavorite, toggleFavorite } from '../keyboard-prefs.js';
import { translate } from '../../shared/i18n.js';

const named = (value) => (value && value.startsWith('terminal.') ? translate(value) : value);

export function keyLabel(id) {
  const entry = KEY_CATALOG[id];
  if (!entry) return id;
  return entry.translated ? translate(entry.cap) : entry.cap;
}

export function keyName(id) {
  const entry = KEY_CATALOG[id];
  if (!entry) return id;
  const name = named(entry.name) || keyLabel(id);
  return entry.hint ? `${name}, ${translate(entry.hint)}` : name;
}

// Os eventos que o controlador precisa de um botão de tecla. O mousedown sem
// efeito padrão impede o botão de roubar o foco do terminal; o menu de
// contexto do toque longo atrapalharia a repetição.
export function keyHandlers(controller, key, fixed, onPress) {
  const up = () => controller.pointerUp();
  return {
    onPointerDown: (event) => { onPress?.(event); controller.pointerDown(key, fixed); },
    onPointerUp: up,
    onPointerCancel: up,
    onPointerLeave: up,
    onMouseDown: (event) => event.preventDefault(),
    onContextMenu: (event) => event.preventDefault(),
    onClick: () => { controller.click(key, fixed); onPress?.(null, true); },
  };
}

function Key({ id, controller, disabled, onPaste, className = '' }) {
  const entry = KEY_CATALOG[id];
  if (!entry) return null;
  const hint = entry.hint ? translate(entry.hint) : null;
  const common = { type: 'button', disabled, 'aria-label': keyName(id), className: `phone-keys__key ${className}`.trim() };
  if (id === PASTE_KEY) {
    return (
      <button {...common} onMouseDown={(event) => event.preventDefault()} onClick={onPaste}>
        <span className="phone-keys__label">{keyLabel(id)}</span>
        {hint ? <span className="phone-keys__hint" aria-hidden="true">{hint}</span> : null}
      </button>
    );
  }
  return (
    <button {...common} {...keyHandlers(controller, entry.key, entry.mods)}>
      <span className="phone-keys__label">{keyLabel(id)}</span>
      {hint ? <span className="phone-keys__hint" aria-hidden="true">{hint}</span> : null}
    </button>
  );
}

// Setas em cruz, com alvos largos e a de cima centrada, como um controle.
export function DirectionPad({ controller, disabled }) {
  const arrow = (id, Icon) => (
    <button type="button" className={`phone-dpad__key phone-dpad__key--${id}`} disabled={disabled} aria-label={keyName(id)} {...keyHandlers(controller, id)}>
      <Icon size={22} strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
  return (
    <div className="phone-dpad" role="group" aria-label={translate('terminal.phone.keys.arrows')}>
      {arrow('ArrowUp', ArrowUp)}
      {arrow('ArrowLeft', ArrowLeft)}
      {arrow('ArrowDown', ArrowDown)}
      {arrow('ArrowRight', ArrowRight)}
    </div>
  );
}

function Modifiers({ controller, state, disabled }) {
  const sticky = state.mode === 'sticky';
  return (
    <div className="phone-keys__grid phone-keys__grid--modifiers" role="group" aria-label={translate('terminal.phone.keys.modifiers')}>
      {MODIFIER_KEYS.map(({ id, cap }) => {
        const armed = Boolean(state.armed[id]);
        return (
          <button
            key={id}
            type="button"
            className={`phone-keys__key phone-keys__modifier${armed ? ' is-armed' : ''}`}
            aria-pressed={armed}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => controller.toggleModifier(id)}
          >
            {cap}
            {armed && sticky ? <Lock size={12} strokeWidth={2.4} className="phone-keys__lock" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function Symbols({ controller, disabled }) {
  return (
    <div className="phone-keys__grid phone-keys__grid--symbols" role="group" aria-label={translate('terminal.phone.keys.symbols')}>
      {SYMBOLS.map((symbol) => (
        <button key={symbol} type="button" className="phone-keys__key phone-keys__symbol" disabled={disabled} aria-label={symbol} {...keyHandlers(controller, symbol)}>{symbol}</button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label, description }) {
  return (
    <label className="phone-keys__switch">
      <span className="phone-keys__switch-text">
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="phone-keys__switch-track" aria-hidden="true" />
    </label>
  );
}

// Preferências do teclado, atrás da engrenagem do painel.
export function KeyboardPreferences({ prefs, onChange, canVibrate }) {
  const favorites = prefs.favorites;
  const full = favorites.length >= MAX_FAVORITES;
  return (
    <div className="phone-keys__prefs">
      <section aria-labelledby="phone-keys-favorites">
        <h3 id="phone-keys-favorites">{translate('terminal.phone.keys.prefs.favorites')}</h3>
        <p className="phone-keys__note">{translate('terminal.phone.keys.prefs.favoritesHint', { count: MAX_FAVORITES })}</p>
        {favorites.length ? (
          <ol className="phone-keys__order">
            {favorites.map((id, index) => (
              <li key={id}>
                <span>{keyLabel(id)}</span>
                <button type="button" className="phone-keys__icon" disabled={index === 0} aria-label={translate('terminal.phone.keys.prefs.moveUp', { name: keyLabel(id) })} onClick={() => onChange(moveFavorite(prefs, id, -1))}><ChevronUp size={18} aria-hidden="true" /></button>
                <button type="button" className="phone-keys__icon" disabled={index === favorites.length - 1} aria-label={translate('terminal.phone.keys.prefs.moveDown', { name: keyLabel(id) })} onClick={() => onChange(moveFavorite(prefs, id, 1))}><ChevronDown size={18} aria-hidden="true" /></button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="phone-keys__chips">
          {FAVORITE_CHOICES.map((id) => {
            const selected = favorites.includes(id);
            return (
              <button key={id} type="button" className={`phone-keys__chip${selected ? ' is-selected' : ''}`} aria-pressed={selected} disabled={!selected && full} onClick={() => onChange(toggleFavorite(prefs, id))}>{keyLabel(id)}</button>
            );
          })}
        </div>
      </section>
      <section aria-labelledby="phone-keys-modifiers">
        <h3 id="phone-keys-modifiers">{translate('terminal.phone.keys.prefs.modifiers')}</h3>
        <div className="phone-keys__radios" role="radiogroup" aria-labelledby="phone-keys-modifiers">
          {['oneShot', 'sticky'].map((mode) => (
            <label key={mode} className={`phone-keys__radio${prefs.modifierMode === mode ? ' is-selected' : ''}`}>
              <input type="radio" name="phone-keys-modifier-mode" value={mode} checked={prefs.modifierMode === mode} onChange={() => onChange({ ...prefs, modifierMode: mode })} />
              <span>{translate(`terminal.phone.keys.prefs.${mode}`)}</span>
              <small>{translate(`terminal.phone.keys.prefs.${mode}Hint`)}</small>
            </label>
          ))}
        </div>
      </section>
      <section className="phone-keys__toggles">
        <Switch checked={prefs.autoOpen} onChange={(autoOpen) => onChange({ ...prefs, autoOpen })} label={translate('terminal.phone.keys.prefs.autoOpen')} description={translate('terminal.phone.keys.prefs.autoOpenHint')} />
        {canVibrate ? <Switch checked={prefs.haptics} onChange={(haptics) => onChange({ ...prefs, haptics })} label={translate('terminal.phone.keys.prefs.haptics')} /> : null}
      </section>
    </div>
  );
}

export default function PhoneKeyboardSheet({
  open,
  controller,
  state,
  interactive = true,
  prefs,
  onPrefsChange,
  canVibrate = false,
  onPaste,
  onNativeKeyboard,
  onClose,
  initialTab = 'basic',
}) {
  const [tab, setTab] = useState(initialTab);
  const [settings, setSettings] = useState(false);
  if (!open || !controller) return null;
  const current = KEYBOARD_TABS.find((item) => item.id === tab) || KEYBOARD_TABS[0];
  const disabled = !interactive;
  const close = () => { controller.pointerUp(); setSettings(false); onClose(); };
  return (
    <section className="phone-keys" aria-label={translate('terminal.phone.keys.title')}>
      <span className="phone-keys__grabber" aria-hidden="true" />
      <div className="phone-keys__head">
        {settings ? <button type="button" className="phone-keys__icon" aria-label={translate('terminal.phone.keys.back')} onClick={() => setSettings(false)}><ChevronLeft size={22} aria-hidden="true" /></button> : null}
        <h2>{translate(settings ? 'terminal.phone.keys.prefs.title' : 'terminal.phone.keys.title')}</h2>
        {!settings ? <button type="button" className="phone-keys__icon" aria-label={translate('terminal.phone.keys.prefs.title')} onClick={() => setSettings(true)}><Settings2 size={20} aria-hidden="true" /></button> : null}
        <button type="button" className="phone-keys__icon" aria-label={translate('terminal.phone.keys.close')} onClick={close}><X size={22} aria-hidden="true" /></button>
      </div>
      {settings ? (
        <div className="phone-keys__body">
          <KeyboardPreferences prefs={prefs} onChange={onPrefsChange} canVibrate={canVibrate} />
        </div>
      ) : <>
        <div className="phone-keys__tabs" role="tablist" aria-label={translate('terminal.phone.keys.categories')}>
          {KEYBOARD_TABS.map((item) => (
            <button key={item.id} type="button" role="tab" id={`phone-keys-tab-${item.id}`} aria-selected={item.id === current.id} aria-controls="phone-keys-panel" className={`phone-keys__tab${item.id === current.id ? ' is-selected' : ''}`} onClick={() => setTab(item.id)}>
              {translate(`terminal.phone.keys.tab.${item.id}`)}
            </button>
          ))}
        </div>
        <div className="phone-keys__body" role="tabpanel" id="phone-keys-panel" aria-labelledby={`phone-keys-tab-${current.id}`}>
          {current.id === 'navigation' ? <DirectionPad controller={controller} disabled={disabled} /> : null}
          <div className={`phone-keys__grid${current.id === 'symbols' ? ' phone-keys__grid--functions' : ''}`}>
            {current.keys.map((id) => <Key key={id} id={id} controller={controller} disabled={disabled} onPaste={onPaste} className={KEY_CATALOG[id]?.hint ? 'phone-keys__key--combo' : ''} />)}
          </div>
          {current.modifiers ? <Modifiers controller={controller} state={state} disabled={disabled} /> : null}
          {current.id === 'basic' ? <DirectionPad controller={controller} disabled={disabled} /> : null}
          {current.symbols ? <Symbols controller={controller} disabled={disabled} /> : null}
        </div>
        <div className="phone-keys__foot">
          <button type="button" className="phone-keys__foot-button" disabled={disabled} onClick={() => { setSettings(false); onNativeKeyboard(); }}>
            <Keyboard size={18} aria-hidden="true" />{translate(state.any ? 'terminal.phone.keys.typeCombined' : 'terminal.phone.keys.native')}
          </button>
          <button type="button" className="phone-keys__foot-button phone-keys__foot-button--close" onClick={close}>{translate('terminal.phone.keys.closeKeyboard')}</button>
        </div>
      </>}
    </section>
  );
}
