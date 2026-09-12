// SPDX-License-Identifier: Apache-2.0
// Restauracao de uma sessao que o app perdeu ao fechar. O Rust devolve o
// historico gravado ja com a volta ao estado padrao do terminal no fim; aqui
// ficam o aviso que separa o historico do shell novo, o tamanho em que o
// historico foi escrito e a espera pelo prompt do shell novo antes de digitar
// o comando que retoma o agente.

export const PROMPT_POLL_MS = 100;
// Leituras seguidas sem saida nova que contam como prompt desenhado.
export const PROMPT_QUIET_POLLS = 4;
// Teto da espera, em leituras: oito segundos.
export const PROMPT_MAX_POLLS = 80;

function two(value) {
  return String(value).padStart(2, '0');
}

// Linha esmaecida escrita no fim do historico restaurado.
export function restoredNotice(updatedAtMs, now = Date.now()) {
  let text = 'Histórico restaurado.';
  const at = Number(updatedAtMs);
  if (Number.isFinite(at) && at > 0) {
    const date = new Date(at);
    const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
    text += date.toDateString() === new Date(now).toDateString()
      ? ` Última gravação hoje às ${time}.`
      : ` Última gravação em ${two(date.getDate())}/${two(date.getMonth() + 1)} às ${time}.`;
  }
  return `\x1b[2m${text}\x1b[0m\r\n`;
}

// Tamanho do terminal quando o historico foi gravado, nos limites do PTY.
export function savedSize(saved) {
  const cols = Number(saved?.cols);
  const rows = Number(saved?.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return null;
  return { cols: Math.min(cols, 500), rows: Math.min(rows, 300) };
}

// Espera o shell novo mostrar o prompt: chegou saida e ela ficou parada por
// algumas leituras. `read` devolve os bytes recebidos ate agora, ou null
// quando a sessao deixou de ser a mesma. Devolve true para digitar, inclusive
// ao fim do prazo com a sessao ainda de pe, porque o terminal guarda o que
// chega antes do prompt. Conta leituras, e nao o relogio, para seguir o
// mesmo temporizador do resto do runtime.
export async function waitForPrompt(read, sleep, { pollMs = PROMPT_POLL_MS, quietPolls = PROMPT_QUIET_POLLS, maxPolls = PROMPT_MAX_POLLS } = {}) {
  let last = -1;
  let quiet = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const received = read();
    if (received === null) return false;
    if (received > 0 && received === last) {
      quiet += 1;
      if (quiet >= quietPolls) return true;
    } else {
      quiet = 0;
      last = received;
    }
    await sleep(pollMs);
  }
  return read() !== null;
}
