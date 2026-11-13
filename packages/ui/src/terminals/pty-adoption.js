// SPDX-License-Identifier: Apache-2.0
// Qual sessão adota um PTY vivo que voltou sem tag, como o de uma versão antiga
// do app. A tag é a identidade da sessão; sem ela, a pasta só serve quando
// aponta uma sessão e mais nenhuma. Com duas sessões livres na mesma pasta não
// há como saber qual era a dona, e adivinhar troca o terminal, o histórico e o
// status de um card pelo de outro.

export function untaggedOwner(sessions, info) {
  if (!info || info.tag || !info.cwd) return null;
  const candidates = sessions.filter((session) => session.ptyId == null && !session.spawning && session.cwd === info.cwd);
  return candidates.length === 1 ? candidates[0] : null;
}
