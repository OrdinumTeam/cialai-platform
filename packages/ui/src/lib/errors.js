// SPDX-License-Identifier: Apache-2.0
// Falhas do protocolo chegam com código estável e texto em português. Na
// fronteira da interface o código vira a mensagem do idioma ativo.
import { translate } from '../shared/i18n.js';

const ERROR_KEYS = Object.freeze({
  bridge_disconnected: 'shared.bridge.disconnected',
  bridge_failed: 'shared.bridge.failed',
  bridge_timeout: 'shared.bridge.timeout',
  MOBILE_READ_ONLY: 'shared.bridge.readOnly',
  session_locked: 'shared.bridge.sessionLocked',
});

export function localizeError(error) {
  const key = error && typeof error === 'object' ? ERROR_KEYS[error.code] : undefined;
  if (!key) return error;
  return Object.assign(new Error(translate(key), { cause: error }), { code: error.code });
}
