// SPDX-License-Identifier: Apache-2.0
// Tom da capa de cada projeto, estavel pelo nome. A mesma conta do
// aplicativo nativo (apps/mobile/src/dashboard/model.ts), para a pasta ter a
// mesma cor no Inicio e na sessao nova.
export const PROJECT_TINTS = Object.freeze(['pink', 'blue', 'green', 'orange', 'violet']);

export function projectTint(name) {
  let hash = 0;
  for (const char of String(name || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_TINTS[hash % PROJECT_TINTS.length];
}

const ENDED_STATUSES = new Set(['exited', 'error']);

// Sessoes abertas dentro da pasta, inclusive em subpastas, com a barra do
// Windows tambem. As que terminaram nao contam como abertas.
export function sessionsInFolder(sessions, path) {
  const root = String(path || '').replace(/[\\/]+$/, '');
  if (!root) return [];
  return (sessions || []).filter((session) => {
    const cwd = String(session.cwd || '');
    return !ENDED_STATUSES.has(session.status) && (cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`));
  });
}
