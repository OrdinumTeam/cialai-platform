import { t } from '../i18n';
import { tunnelErrorCode } from '../network/tunnel-errors';

const ERROR_KEYS: Record<string, string> = {
  payload_invalid: 'mobile.pairError.payloadInvalid',
  payload_version: 'mobile.pairError.payloadVersion',
  payload_expired: 'mobile.pairError.payloadExpired',
  pair_consumed: 'mobile.pairError.pairConsumed',
  pair_expired: 'mobile.pairError.pairExpired',
  pair_unknown: 'mobile.pairError.pairUnknown',
  pair_denied: 'mobile.pairError.pairDenied',
  pair_timeout: 'mobile.pairError.pairTimeout',
  pair_rate_limited: 'mobile.pairError.rateLimited',
  pair_secret_mismatch: 'mobile.pairError.mismatch',
  pair_key_mismatch: 'mobile.pairError.mismatch',
  reserve_preparing: 'mobile.pairError.reservePreparing',
  reserve_unavailable: 'mobile.pairError.unreachable',
  no_path: 'mobile.pairError.unreachable',
  desktop_unreachable: 'mobile.pairError.unreachable'
};

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(ERROR_KEYS));

export function pairErrorMessage(caught: unknown): string {
  const code = tunnelErrorCode(caught, KNOWN_CODES);
  return code ? t(ERROR_KEYS[code]!) : t('mobile.pairError.fallback');
}
