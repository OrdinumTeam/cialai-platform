// SPDX-License-Identifier: Apache-2.0
// Controlador do teclado especial do celular.
//
// Um lugar só decide o que um toque manda ao terminal: guarda os
// modificadores armados, combina com a tecla seguinte, codifica a sequência
// em `key-encoder.js` com o modo de cursor do terminal de agora, solta os
// modificadores e segura a repetição de quem fica pressionado. Os botões só
// repassam os eventos; nenhum deles escreve texto no terminal por conta
// própria.
//
// Modificadores. No modo `oneShot`, o padrão, um toque arma e a próxima tecla
// consome; um segundo toque desarma sem enviar nada. No modo `sticky` o
// modificador fica preso até ser tocado de novo. Modificador sozinho nunca é
// enviado.
//
// Envio único. A tecla sai no `click`, que o navegador só dispara quando o
// dedo levanta no mesmo botão: arrastar para rolar ou desistir no meio não
// envia nada. As teclas repetíveis seguradas por mais de `REPEAT_DELAY_MS`
// passam a repetir, e o `click` que chega quando o dedo solta é engolido.
// Cada repetição só sai depois de a escrita anterior terminar, para a
// latência da rede não acumular setas que continuariam chegando depois de
// soltar.
//
// Sem DOM: quem liga aos botões injeta envio, agendador e vibração, o que
// deixa a lógica testável em Node.
import { MODIFIERS, encodeKey, isModifier, isSingleCharacter } from './key-encoder.js';

export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 80;
export const REPEATABLE = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'PageUp', 'PageDown']);
export const MODIFIER_MODES = ['oneShot', 'sticky'];

const HAPTIC_MS = 8;
// Teclas de controle que o teclado nativo entrega como texto e que um
// modificador armado deve transformar, como Alt Enter.
const TYPED_KEYS = { '\r': 'Enter', '\x7f': 'Backspace', '\t': 'Tab', '\x1b': 'Escape' };

const noModifiers = () => Object.fromEntries(MODIFIERS.map((name) => [name, false]));

export function createKeyController({
  send,
  applicationCursor = () => false,
  schedule = (callback, ms) => setTimeout(callback, ms),
  cancel = (timer) => clearTimeout(timer),
  vibrate = null,
  mode = 'oneShot',
  haptics = false,
} = {}) {
  let armed = noModifiers();
  let currentMode = MODIFIER_MODES.includes(mode) ? mode : 'oneShot';
  let hapticsOn = Boolean(haptics);
  const listeners = new Set();
  // Repetição em curso: tecla, modificadores capturados no início e timer.
  let hold = null;
  let swallowClick = null;
  let inflight = null;

  const snapshot = () => ({ armed: { ...armed }, mode: currentMode, any: MODIFIERS.some((name) => armed[name]) });
  const emit = () => { const state = snapshot(); listeners.forEach((listener) => listener(state)); };
  const buzz = () => { if (hapticsOn && typeof vibrate === 'function') { try { vibrate(HAPTIC_MS); } catch (_error) { /* sem vibração */ } } };

  function release() {
    if (currentMode === 'sticky') return;
    if (!MODIFIERS.some((name) => armed[name])) return;
    armed = noModifiers();
    emit();
  }

  function write(data) {
    if (!data) return Promise.resolve(false);
    let result;
    try { result = send(data); } catch (_error) { result = false; }
    const pending = Promise.resolve(result).then((value) => value !== false, () => false);
    inflight = pending;
    pending.finally(() => { if (inflight === pending) inflight = null; });
    return pending;
  }

  function encode(key, mods) {
    return encodeKey(key, mods, { applicationCursor: Boolean(applicationCursor()) });
  }

  // Modificadores armados somados aos da própria tecla, como o Ctrl de Ctrl C.
  const combine = (fixed) => {
    if (!fixed) return { ...armed };
    return Object.fromEntries(MODIFIERS.map((name) => [name, Boolean(armed[name] || fixed[name])]));
  };

  // Envia a tecla com os modificadores armados e os solta.
  function press(key, fixed) {
    if (isModifier(key)) { toggleModifier(String(key).toLowerCase()); return Promise.resolve(false); }
    const data = encode(key, combine(fixed));
    if (!data) return Promise.resolve(false);
    buzz();
    release();
    return write(data);
  }

  function toggleModifier(name) {
    if (!MODIFIERS.includes(name)) return;
    armed = { ...armed, [name]: !armed[name] };
    buzz();
    emit();
  }

  function stopHold() {
    if (!hold) return;
    cancel(hold.timer);
    hold = null;
  }

  // Cada repetição codifica de novo: um programa que troca o modo de cursor
  // enquanto o dedo segura a seta recebe a sequência do modo novo.
  function tick() {
    if (!hold) return;
    // A escrita anterior ainda não voltou: espera, sem enfileirar outra.
    if (!inflight) {
      const data = encode(hold.key, hold.mods);
      if (data) write(data);
    }
    hold.timer = schedule(tick, REPEAT_INTERVAL_MS);
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(next) {
      if (!MODIFIER_MODES.includes(next) || next === currentMode) return;
      currentMode = next;
      emit();
    },
    setHaptics(value) { hapticsOn = Boolean(value); },
    toggleModifier,
    press,
    // Dedo no botão. Só as repetíveis fazem algo aqui: começam a contar o
    // tempo de segurar. Nada é enviado ainda.
    pointerDown(key, fixed) {
      stopHold();
      swallowClick = null;
      if (!REPEATABLE.has(key)) return;
      const mods = combine(fixed);
      hold = { key, mods, timer: null };
      hold.timer = schedule(() => {
        if (!hold) return;
        const data = encode(key, mods);
        if (!data) { stopHold(); return; }
        swallowClick = key;
        buzz();
        release();
        write(data);
        hold.timer = schedule(tick, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    // Dedo solto, cancelado pelo sistema ou fora do botão: a repetição para.
    pointerUp() { stopHold(); },
    // O envio normal. Depois de uma repetição, o click do fim não envia de novo.
    click(key, fixed) {
      stopHold();
      if (swallowClick === key) { swallowClick = null; return Promise.resolve(false); }
      swallowClick = null;
      return press(key, fixed);
    },
    // Texto do teclado nativo a caminho do PTY. Com modificador armado, um
    // caractere só vira a combinação e solta o modificador. O resto, como
    // colagem, palavra da autocorreção ou resposta do próprio xterm, passa
    // intacto e o modificador continua armado.
    transformTyped(data) {
      if (!MODIFIERS.some((name) => armed[name])) return data;
      const key = TYPED_KEYS[data] || (isSingleCharacter(data) ? data : null);
      if (!key) return data;
      const encoded = encode(key, armed);
      if (!encoded) return data;
      release();
      return encoded;
    },
    reset() {
      stopHold();
      swallowClick = null;
      if (!MODIFIERS.some((name) => armed[name])) return;
      armed = noModifiers();
      emit();
    },
    dispose() {
      stopHold();
      listeners.clear();
    },
  };
}

// Um controlador por sessão aberta: o envio e o modo de cursor são os dela.
export function sessionKeyController(sessionId, { sendKey, applicationCursorKeys, vibrate = null }) {
  return createKeyController({
    send: (data) => sendKey(sessionId, data),
    applicationCursor: () => applicationCursorKeys(sessionId),
    vibrate,
  });
}

// Liga o controlador à tela e ao teclado nativo da sessão. O desligar solta o
// texto nativo, para a repetição e descarta o controlador: trocar de sessão
// começa sem modificador armado, porque o controlador é outro.
export function bindSessionKeys(controller, sessionId, { setInputTransform, onState }) {
  onState(controller.getState());
  const off = controller.subscribe(onState);
  const unbind = setInputTransform(sessionId, controller.transformTyped);
  return () => { off(); unbind(); controller.dispose(); };
}
