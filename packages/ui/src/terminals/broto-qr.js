// SPDX-License-Identifier: Apache-2.0
// Ligar um Broto pelo QR lido no celular. A pagina manda ao computador o texto
// que a casca leu e acompanha o pedido a cada 1,5 s ate um fim. Quem pede e o
// aparelho desta conexao, que a ponte acrescenta: a pagina nunca o escolhe.
// Puro: recebe a chamada da ponte e os relogios, para o teste guiar o tempo.
import { dictionaries } from '@cialai/i18n';

export const BROTO_QR_POLL_MS = 1500;
export const BROTO_QR_FINAL_STAGES = Object.freeze(['done', 'denied', 'expired']);
const STAGES = ['waiting', 'verify', 'approved', 'done', 'denied', 'expired'];
const ONION_STATES = ['publishing', 'ready', 'off'];
const QR_ID = /^q_[A-Za-z0-9_-]{1,64}$/;
const DIGITS = /^\d{4}$/;
// Folga para o relogio do celular e o do computador nao baterem.
const EXPIRY_GRACE_MS = 5000;
// Codigos estaveis do sidecar. Todos encerram o pedido, menos `qr_not_ready`,
// que so diz que ainda nao ha numeros para confirmar.
export const BROTO_QR_ERRORS = Object.freeze(['qr_invalid', 'qr_expired', 'qr_used', 'qr_busy', 'qr_unknown', 'qr_not_ready']);
const ENDS_REQUEST = new Set(['qr_invalid', 'qr_expired', 'qr_used', 'qr_busy', 'qr_unknown', 'outdated']);
// A conexao com o computador caiu ou demorou: a consulta seguinte tenta de novo.
const TRANSIENT = new Set(['bridge_disconnected', 'bridge_timeout']);
// Uma ponte anterior a 0.6.0 recusa o comando com este texto, no idioma do
// computador; um sidecar antigo responde `command_unknown`.
const DESKTOP_ONLY = new Set(Object.values(dictionaries).map((dictionary) => dictionary['native.error.desktopOnly']));

// Falha da ponte num codigo que a folha traduz. Texto livre que ja veio
// traduzido, como a biometria cancelada, segue como veio.
export function brotoQrError(error) {
  const message = typeof error === 'string' ? error : String(error?.message ?? '');
  const code = typeof error?.code === 'string' ? error.code : '';
  if (BROTO_QR_ERRORS.includes(message)) return { code: message, message: '' };
  if (code === 'command_unknown' || message === 'command_unknown' || DESKTOP_ONLY.has(message)) return { code: 'outdated', message: '' };
  if (TRANSIENT.has(code)) return { code, message };
  return { code: 'failed', message: /^[a-z][a-z0-9_]*$/.test(message) ? '' : message };
}

const text = (value, limit = 128) => (typeof value === 'string' ? value.slice(0, limit) : '');

// Estado do sidecar sobre o que a folha ja sabe. Os numeros so valem enquanto
// ha o que conferir.
function merge(view, state) {
  const stage = STAGES.includes(state?.stage) ? state.stage : view.stage;
  const digits = ['verify', 'approved'].includes(stage) && DIGITS.test(state?.digits) ? state.digits : '';
  return {
    ...view,
    stage,
    digits,
    name: text(state?.name) || view.name,
    platform: text(state?.platform, 32) || view.platform,
    expiresAt: text(state?.expiresAt, 64) || view.expiresAt,
    onion: ONION_STATES.includes(state?.onion) ? state.onion : view.onion,
  };
}

export function createBrotoQrFlow({
  invoke,
  payload,
  onChange = () => {},
  now = () => Date.now(),
  schedule = (callback, ms) => setTimeout(callback, ms),
  unschedule = (timer) => clearTimeout(timer),
  pollMs = BROTO_QR_POLL_MS,
}) {
  let view = { stage: 'starting', qrId: '', name: '', platform: '', digits: '', expiresAt: '', onion: '', busy: false, error: null, notice: null };
  let closed = false;
  let timer = null;
  // Cada decisao abre uma epoca: a consulta que saiu antes dela traz um estado
  // velho e e descartada.
  let epoch = 0;
  const ended = () => BROTO_QR_FINAL_STAGES.includes(view.stage) || view.stage === 'error';
  const emit = (patch) => {
    view = { ...view, ...patch };
    if (!closed) onChange(view);
  };
  const stop = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
  };
  const next = () => {
    stop();
    if (!closed && !ended() && !view.busy) timer = schedule(poll, pollMs);
  };
  const fail = (error) => {
    stop();
    emit({ stage: 'error', digits: '', busy: false, error });
  };
  const lapsed = () => {
    const expiry = Date.parse(view.expiresAt);
    return Number.isFinite(expiry) && now() > expiry + EXPIRY_GRACE_MS;
  };
  // Recusa sem esperar resposta: a folha ja fechou e o computador apaga o
  // pedido sozinho quando o QR vence.
  const deny = (qrId) => {
    Promise.resolve()
      .then(() => invoke('broto_qr_decide', { qrId, approve: false }))
      .catch(() => {});
  };

  async function poll() {
    timer = null;
    if (closed || ended() || view.busy) return;
    if (lapsed()) {
      emit({ stage: 'expired', digits: '' });
      return;
    }
    const asked = epoch;
    try {
      const state = await invoke('broto_qr_state', { qrId: view.qrId });
      if (closed || view.busy || asked !== epoch) return;
      emit({ ...merge(view, state), notice: null });
    } catch (raw) {
      if (closed || view.busy || asked !== epoch) return;
      const error = brotoQrError(raw);
      if (!TRANSIENT.has(error.code)) {
        fail(error);
        return;
      }
      emit({ notice: error });
    }
    next();
  }

  async function start() {
    try {
      const begun = await invoke('broto_qr_begin', { payload });
      const qrId = typeof begun?.qrId === 'string' && QR_ID.test(begun.qrId) ? begun.qrId : '';
      if (closed) {
        if (qrId) deny(qrId);
        return;
      }
      if (!qrId) {
        fail({ code: 'failed', message: '' });
        return;
      }
      emit({ stage: 'waiting', qrId, name: text(begun.name), platform: text(begun.platform, 32), expiresAt: text(begun.expiresAt, 64) });
      next();
    } catch (raw) {
      if (!closed) fail(brotoQrError(raw));
    }
  }

  // Confirmar so vale com os numeros na tela; recusar vale ate um fim.
  async function decide(approve) {
    if (closed || view.busy || ended() || !view.qrId) return;
    if (approve && view.stage !== 'verify') return;
    stop();
    epoch += 1;
    emit({ busy: true, notice: null });
    try {
      const result = await invoke('broto_qr_decide', { qrId: view.qrId, approve: Boolean(approve) });
      if (closed) return;
      const stage = STAGES.includes(result?.stage) ? result.stage : approve ? 'approved' : 'denied';
      emit({ stage, busy: false, digits: ['verify', 'approved'].includes(stage) ? view.digits : '' });
    } catch (raw) {
      if (closed) return;
      const error = brotoQrError(raw);
      if (ENDS_REQUEST.has(error.code)) {
        fail(error);
        return;
      }
      emit({ busy: false, notice: error });
    }
    next();
  }

  // Fechar antes de um fim recusa o pedido. Se o QR ainda estava a caminho, a
  // recusa sai quando o computador responder.
  function close() {
    if (closed) return;
    const pending = !ended() && view.qrId;
    closed = true;
    stop();
    if (pending) deny(view.qrId);
  }

  start();
  return Object.freeze({ decide, close, view: () => view });
}
