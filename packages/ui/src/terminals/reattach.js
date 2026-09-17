// SPDX-License-Identifier: Apache-2.0
// Agendador do reattach de uma sessão que caiu. Um `detached` reattachava em
// 500 ms fixos; cada reattach reenvia o anel de histórico, até 256 KiB, e pela
// reserva Tor isso enche a fila e provoca novo `detached`, um ciclo que se
// realimenta. A escada abaixo espaça as tentativas com teto por sessão; um
// reattach bem sucedido zera a contagem. A conta é pura, sem DOM nem timers,
// para o teste de unidade exercer só a decisão.

export const REATTACH_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

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
// aparece, mesmo fora da tela, para a lista mostrar o que existe.
export function shouldReattachOnPoll({ status, visible }) {
  if (status === 'error') return false;
  if (status === 'disconnected' && !visible) return false;
  return true;
}
