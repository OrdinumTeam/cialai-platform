// SPDX-License-Identifier: Apache-2.0
import { onShellLock, requireSensitive } from './shell.js';

const remoteCommands = new Set([
  'pty_list', 'pty_metrics', 'ai_usage', 'pty_attach', 'pty_ack', 'pty_write', 'pty_spawn', 'pty_kill',
  'list_repo_dirs',
  'pty_view_claim', 'pty_view_renew', 'pty_view_release', 'pty_files_list', 'pty_file_read',
]);

function readOnlyError() {
  return Object.assign(new Error('No iPhone, esta área permite somente consulta. Faça alterações no Mac.'), { code: 'MOBILE_READ_ONLY' });
}

const terminalGrants = new Set();
const terminalPending = new Map();
let lockEpoch = 0;
export function resetTerminalAuthorization() { lockEpoch += 1; terminalGrants.clear(); terminalPending.clear(); }
onShellLock(resetTerminalAuthorization);

export async function authorizeNative(command, args = {}) {
  // Only terminal commands may mutate the Mac through the remote bridge.
  // Unknown commands fail closed, even if the shell could authorize them.
  if (!remoteCommands.has(command)) throw readOnlyError();
  if (command === 'pty_write' || command === 'pty_view_claim') {
    const key = args.id;
    if (terminalGrants.has(key)) return;
    if (!terminalPending.has(key)) {
      const epoch = lockEpoch;
      const request = requireSensitive('action', 'Autorizar digitação neste terminal').then(() => {
        if (epoch !== lockEpoch) throw new Error('A sessão foi bloqueada. Autorize novamente.');
        terminalGrants.add(key);
      });
      terminalPending.set(key, request);
      request.finally(() => { if (terminalPending.get(key) === request) terminalPending.delete(key); }).catch(() => {});
    }
    return terminalPending.get(key);
  }
  if (command === 'pty_kill') {
    await requireSensitive('action', 'Encerrar este terminal');
    terminalGrants.delete(args.id);
    return;
  }
  if (command === 'pty_spawn') {
    await requireSensitive('session', 'Autorizar alteração no Mac');
  }
}
