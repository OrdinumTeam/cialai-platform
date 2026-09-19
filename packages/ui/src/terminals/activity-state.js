// SPDX-License-Identifier: Apache-2.0
// Estado de atividade de uma sessão, derivado só do que foi observado.
//
// Antes, o card lia dois fatos de processo: existe processo em primeiro plano
// e chegou byte há pouco. Para um agente interativo esses fatos significam o
// contrário do que a pessoa lê: o `claude` continua em primeiro plano depois
// de responder, então o card animava do início ao `/exit`.
//
// Agora o computador é a fonte única. `pty_metrics` traz `agentTurn`, lido dos
// arquivos que o próprio agente grava, e `outputAgeMs`, medido no relógio do
// computador para todos os clientes concordarem. Quando o turno existe, ele
// decide sozinho; sem ele, vale a evidência de atividade. Silêncio nunca vira
// concluído, e sem amostra nova nada anima.
//
// A conta é pura, sem DOM nem timers, para o teste de unidade exercer só a
// decisão.

// Tom e animação de cada estado. O rótulo vem do dicionário, pela chave
// `terminal.session.activity.<código>`.
export const ACTIVITY_STATES = Object.freeze({
  'agent-busy': { tone: 'busy', animated: true },
  'agent-waiting': { tone: 'warn', animated: false },
  'agent-done': { tone: 'ok', animated: false },
  'agent-idle': { tone: 'ok', animated: false },
  active: { tone: 'busy', animated: true },
  open: { tone: 'muted', animated: false },
  stopped: { tone: 'warn', animated: false },
  idle: { tone: 'ok', animated: false },
});

// Janela de saída recente. Maior que o intervalo de amostra com a tela
// visível, de 2 s, para um build que escreve devagar não piscar.
export const OUTPUT_WINDOW_MS = 3000;
// Piso de CPU da árvore que conta como trabalho.
export const CPU_FLOOR_PERCENT = 2;
// Acima disto a amostra é velha demais para sustentar animação. Cobre o poll
// de 6 s da tela oculta com folga.
export const SAMPLE_MAX_AGE_MS = 15000;

function turnCode(state) {
  if (state === 'busy') return 'agent-busy';
  if (state === 'waiting') return 'agent-waiting';
  if (state === 'done') return 'agent-done';
  return 'agent-idle';
}

// Saída recente ou CPU acima do piso. A idade vem do relógio do computador e
// é corrigida pelo tempo passado desde a amostra.
function busyWithoutSignal({ outputAgeMs, cpuPercent, elapsedMs }) {
  if (typeof cpuPercent === 'number' && cpuPercent >= CPU_FLOOR_PERCENT) return true;
  if (typeof outputAgeMs !== 'number') return false;
  return outputAgeMs + elapsedMs < OUTPUT_WINDOW_MS;
}

// `sample` reúne o que a última amostra de `pty_metrics` trouxe para esta
// sessão. `sampleAt` é o relógio local de quando ela chegou e `evidenceSince`
// é a época da conexão atual: amostra de antes da queda não vale.
export function deriveActivity(sample = {}, now = Date.now()) {
  const {
    agentTurn = null,
    foreground = null,
    outputAgeMs = null,
    cpuPercent = null,
    sampleAt = null,
    evidenceSince = 0,
  } = sample || {};
  const elapsedMs = typeof sampleAt === 'number' ? Math.max(0, now - sampleAt) : Infinity;
  const fresh = typeof sampleAt === 'number'
    && sampleAt >= (Number(evidenceSince) || 0)
    && elapsedMs <= SAMPLE_MAX_AGE_MS;

  let code;
  if (agentTurn && agentTurn.state) code = turnCode(agentTurn.state);
  else if (!foreground) code = 'idle';
  else if (foreground.stopped) code = 'stopped';
  else if (fresh && busyWithoutSignal({ outputAgeMs, cpuPercent, elapsedMs })) code = 'active';
  else code = 'open';

  const entry = ACTIVITY_STATES[code];
  return {
    code,
    tone: entry.tone,
    // Sem amostra nova desde a reconexão, nada anima.
    animated: Boolean(entry.animated && fresh),
    waitingFor: (agentTurn && agentTurn.waitingFor) || null,
    sinceMs: (agentTurn && typeof agentTurn.sinceMs === 'number' ? agentTurn.sinceMs : null),
  };
}
