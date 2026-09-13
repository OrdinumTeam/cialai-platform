import { t } from '../i18n';

type TunnelError = {
  code?: unknown;
  message?: unknown;
};

const ERROR_KEYS: Record<string, string> = {
  payload_invalid: 'mobile.pairError.payloadInvalid',
  payload_version: 'mobile.pairError.payloadVersion',
  payload_expired: 'mobile.pairError.payloadExpired',
  auth_key_rejected: 'mobile.pairError.authKeyRejected',
  control_unreachable: 'mobile.pairError.controlUnreachable',
  peer_not_found: 'mobile.pairError.peerNotFound',
  pair_consumed: 'mobile.pairError.pairConsumed',
  pair_expired: 'mobile.pairError.pairExpired',
  pair_unknown: 'mobile.pairError.pairUnknown',
  pair_denied: 'mobile.pairError.pairDenied',
  pair_timeout: 'mobile.pairError.pairTimeout'
};

function errorCode(caught: unknown): string | null {
  if (typeof caught !== 'object' || caught === null) return null;
  const error = caught as TunnelError;
  if (typeof error.code === 'string' && error.code in ERROR_KEYS) return error.code;
  if (typeof error.message !== 'string') return null;
  const code = error.message.match(/^([a-z_]+)(?::|$)/)?.[1];
  return code && code in ERROR_KEYS ? code : null;
}

export function pairErrorMessage(caught: unknown): string {
  const code = errorCode(caught);
  return code ? t(ERROR_KEYS[code]!) : t('mobile.pairError.fallback');
}
