// SPDX-License-Identifier: Apache-2.0
// Orquestra as varreduras do grafo da documentacao de uma sessao: quando
// disparar, quando juntar pedidos e, principalmente, que resposta ainda vale.
// Recebe a varredura, o cancelamento, o relogio e os temporizadores de fora,
// entao o script de verificacao simula respostas fora de ordem no Node.
//
// Regras:
//
// - Cada pedido leva um token unico, `<carga>:<sessao>:<sequencia>`. So a
//   resposta do token corrente e entregue, no caminho de sucesso e no de erro.
//   O token cobre a ida e volta entre duas raizes, que a comparacao da raiz
//   sozinha nao cobre; a raiz e conferida tambem, por garantia.
// - Uma varredura da mesma raiz nunca cancela a que esta em andamento: fica
//   uma unica na fila e roda quando a atual terminar. Uma rajada de eventos,
//   como um `npm install`, nao impede que alguma varredura termine.
// - So troca de raiz, `cancel()` e `dispose()` cancelam de verdade.
// - Pedidos vindos de eventos passam por debounce de 350 ms, com espera
//   maxima de 2 s para uma rajada continua nao adiar para sempre.

export const DEBOUNCE_MS = 350;
export const MAX_WAIT_MS = 2000;

let bootCounter = 0;
// Unico por carga do webview: uma varredura pedida antes de uma recarga pode
// ainda estar rodando no Rust com a mesma sessao e a mesma sequencia.
export function makeBootId(now = Date.now()) {
  bootCounter += 1;
  return `${now.toString(36)}${bootCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createIndexer({
  key,
  bootId,
  scan,
  cancel,
  onStart = () => {},
  onResult = () => {},
  onError = () => {},
  now = () => Date.now(),
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
}) {
  const state = { root: null, inFlight: null, queued: false, seq: 0, timer: null, firstAt: 0, disposed: false, started: 0 };

  const clearTimer = () => {
    if (state.timer !== null) { timers.clearTimeout(state.timer); state.timer = null; }
    state.firstAt = 0;
  };

  // Esquece o pedido em andamento. A resposta dele, quando chegar, nao casa
  // mais com o token corrente e e descartada.
  const abort = () => {
    const current = state.inFlight;
    state.inFlight = null;
    state.queued = false;
    clearTimer();
    if (current) Promise.resolve().then(() => cancel(key, current.token)).catch(() => {});
  };

  const start = () => {
    if (state.disposed || !state.root) return;
    clearTimer();
    state.seq += 1;
    state.started += 1;
    const token = `${bootId}:${key}:${state.seq}`;
    const root = state.root;
    state.inFlight = { token, root, at: now() };
    onStart({ token, root });
    const settle = (deliver) => {
      // Resposta de um pedido que ja nao e o corrente: descartada em silencio.
      if (state.disposed || !state.inFlight || state.inFlight.token !== token) return;
      state.inFlight = null;
      deliver();
      if (state.queued && !state.disposed) { state.queued = false; start(); }
    };
    Promise.resolve()
      .then(() => scan(key, token, root))
      .then((result) => settle(() => {
        if (!result || result.root !== state.root) return;
        onResult(result, { token, root });
      }))
      .catch((error) => settle(() => {
        if (error && error.code === 'cancelled') return;
        onError(error, { token, root });
      }));
  };

  const fire = () => {
    state.timer = null;
    state.firstAt = 0;
    if (state.inFlight) state.queued = true;
    else start();
  };

  return {
    // `immediate` para abertura, troca de raiz e botao Atualizar; sem ele o
    // pedido vem de um evento e espera o debounce.
    request(root, { immediate = false } = {}) {
      if (state.disposed || !root) return;
      if (root !== state.root) {
        abort();
        state.root = root;
        start();
        return;
      }
      if (immediate) {
        clearTimer();
        if (state.inFlight) state.queued = true;
        else start();
        return;
      }
      const at = now();
      if (state.timer === null) state.firstAt = at;
      else timers.clearTimeout(state.timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, state.firstAt + MAX_WAIT_MS - at));
      state.timer = timers.setTimeout(fire, wait);
    },
    // Para tudo sem esquecer a raiz: e o que a saida do painel faz.
    cancel() { abort(); },
    // Esquece a raiz: a proxima `request` comeca do zero.
    reset() { abort(); state.root = null; },
    dispose() { abort(); state.disposed = true; state.root = null; },
    state() { return { root: state.root, inFlight: Boolean(state.inFlight), queued: state.queued, pending: state.timer !== null, started: state.started }; },
  };
}
