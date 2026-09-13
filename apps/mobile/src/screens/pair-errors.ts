type TunnelError = {
  code?: unknown;
  message?: unknown;
};

const ERROR_MESSAGES: Record<string, string> = {
  payload_invalid: 'Este QR code não é um código de pareamento do Cialai.',
  payload_version: 'Atualize o Cialai neste celular para usar este código.',
  payload_expired: 'Este código expirou. Gere um novo no computador.',
  auth_key_rejected: 'Este código já foi usado ou expirou. Gere um novo.',
  control_unreachable: 'Não foi possível alcançar o servidor Cialai. Confira a conexão.',
  peer_not_found: 'O computador ainda não está acessível. Deixe o Cialai aberto nele.',
  pair_consumed: 'Este código já foi usado. Gere um novo no computador.',
  pair_expired: 'Este código expirou. Gere um novo no computador.',
  pair_unknown: 'O pareamento foi cancelado no computador.',
  pair_denied: 'O computador recusou este pareamento.',
  pair_timeout: 'O computador não respondeu. Tente de novo.'
};

function errorCode(caught: unknown): string | null {
  if (typeof caught !== 'object' || caught === null) return null;
  const error = caught as TunnelError;
  if (typeof error.code === 'string' && error.code in ERROR_MESSAGES) return error.code;
  if (typeof error.message !== 'string') return null;
  const code = error.message.match(/^([a-z_]+)(?::|$)/)?.[1];
  return code && code in ERROR_MESSAGES ? code : null;
}

export function pairErrorMessage(caught: unknown): string {
  const code = errorCode(caught);
  return code ? ERROR_MESSAGES[code]! : 'Não foi possível ler este código.';
}
