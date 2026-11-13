// SPDX-License-Identifier: Apache-2.0
// Agendador do reattach de uma sessão que caiu. Um `detached` reattachava em
// 500 ms fixos; cada reattach reenvia o anel de histórico, até 256 KiB, e pela
// reserva Tor isso enche a fila e provoca novo `detached`, um ciclo que se
// realimenta. A escada abaixo espaça as tentativas com teto por sessão, e a
// contagem só zera depois de a sessão ficar anexada por um tempo. A conta é
// pura, sem DOM nem timers, para o teste de unidade exercer só a decisão.

export const REATTACH_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

// Tempo anexada sem cair que prova que o reattach deu certo. O `detached` por
// atraso só chega uns 3 s depois da resposta do `pty_attach`, então zerar a
// contagem na resposta devolvia a escada ao primeiro degrau a cada volta do
// ciclo, e ela nunca passava de 500 ms.
export const REATTACH_STABLE_MS = 30000;

// Contagem de tentativas a usar quando a sessão cai, dado há quanto tempo ela
// estava anexada. Sem registro do último attach a contagem segue como está.
export function settledAttempt(attempt, attachedForMs) {
  const count = Math.max(0, Math.trunc(attempt) || 0);
  return Number.isFinite(attachedForMs) && attachedForMs >= REATTACH_STABLE_MS ? 0 : count;
}

// Intervalo até a próxima tentativa, dado o número de tentativas já feitas.
// Acima do fim da escada fica no teto de 8 s.
export function reattachDelay(attempt) {
  const steps = REATTACH_DELAYS_MS;
  const index = Math.min(Math.max(0, Math.trunc(attempt) || 0), steps.length - 1);
  return steps[index];
}

// No poll de 3 s, uma sessão fora de `running` só reattacha quando vale a pena:
// uma sessão em `error` não volta sozinha, e uma sessão estacionada
// (`disconnected`) fora da tela espera ser exibida para não repetir o replay de
// 256 KiB à toa. Uma sessão recém descoberta (`starting`) entra assim que
// aparece no computador, mesmo fora da tela. No celular ela também espera ser
// exibida: anexar todas na abertura mandava o histórico de cada uma, 256 KiB
// por sessão, antes de a pessoa ver o terminal que abriu, e a lista não depende
// disso, porque nome e estado vêm de `pty_list` e `pty_metrics`.
export function shouldReattachOnPoll({ status, visible, phone = false }) {
  if (status === 'error') return false;
  if (status === 'disconnected' && !visible) return false;
  if (status === 'starting' && phone && !visible) return false;
  return true;
}

// Deslocamento a mandar em `pty_attach` para o computador reenviar só o que
// falta. Vale quando o xterm desta página já recebeu saída desta sessão; zero
// ou valor inválido pede o histórico inteiro.
export function resumeOffset(receivedOffset) {
  return Number.isSafeInteger(receivedOffset) && receivedOffset > 0 ? receivedOffset : null;
}
