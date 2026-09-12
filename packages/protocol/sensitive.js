// SPDX-License-Identifier: Apache-2.0
// Fail-closed authorization policy for commands sent by the mobile page.

const ACCESS = Object.freeze({
  pty_list: 'read',
  pty_metrics: 'read',
  ai_usage: 'read',
  pty_attach: 'read',
  pty_ack: 'read',
  list_repo_dirs: 'read',
  pty_view_renew: 'read',
  pty_view_release: 'read',
  pty_files_list: 'read',
  pty_file_read: 'read',
  pty_write: 'terminal',
  pty_view_claim: 'terminal',
  pty_kill: 'action',
  pty_spawn: 'session',
});

export const REMOTE_COMMANDS = Object.freeze(Object.keys(ACCESS));
export const remoteCommandAccess = (command) => ACCESS[command] || null;

function readOnlyError() {
  return Object.assign(new Error('No celular, esta área permite somente consulta. Faça alterações no computador.'), { code: 'MOBILE_READ_ONLY' });
}

export function createSensitiveAuthorizer({ requireSensitive, onLock = () => () => {} }) {
  const terminalGrants = new Set();
  const terminalPending = new Map();
  let lockEpoch = 0;

  const reset = () => {
    lockEpoch += 1;
    terminalGrants.clear();
    terminalPending.clear();
  };
  const offLock = onLock(reset);

  const authorize = async (command, args = {}) => {
    const access = remoteCommandAccess(command);
    if (!access) throw readOnlyError();
    if (access === 'read') return;
    if (access === 'terminal') {
      const key = args.id;
      if (terminalGrants.has(key)) return;
      if (!terminalPending.has(key)) {
        const epoch = lockEpoch;
        const request = Promise.resolve(requireSensitive('action', 'Autorizar digitação neste terminal')).then(() => {
          if (epoch !== lockEpoch) throw new Error('A sessão foi bloqueada. Autorize novamente.');
          terminalGrants.add(key);
        });
        terminalPending.set(key, request);
        request.finally(() => { if (terminalPending.get(key) === request) terminalPending.delete(key); }).catch(() => {});
      }
      return terminalPending.get(key);
    }
    if (access === 'action') {
      await requireSensitive('action', 'Encerrar este terminal');
      terminalGrants.delete(args.id);
      return;
    }
    await requireSensitive('session', 'Autorizar alteração no computador');
  };

  return {
    authorize,
    reset,
    dispose() {
      offLock?.();
      reset();
    },
  };
}
