import { pairErrorMessage } from './pair-errors';

describe('pairing QR errors', () => {
  test.each([
    ['payload_invalid', 'não é um código de pareamento'],
    ['payload_version', 'Atualize o Cialai'],
    ['payload_expired', 'expirou'],
    ['auth_key_rejected', 'já foi usado'],
    ['peer_not_found', 'ainda não está acessível'],
    ['pair_consumed', 'já foi usado'],
    ['pair_expired', 'expirou'],
    ['pair_unknown', 'cancelado'],
    ['pair_denied', 'recusou'],
    ['pair_timeout', 'não respondeu'],
    ['control_unreachable', 'alcançar o servidor']
  ])('maps %s without exposing QR contents', (code, expected) => {
    const message = pairErrorMessage(new Error(`${code}: Não foi possível interpretar o código.`));
    expect(message).toContain(expected);
    expect(message).not.toContain('hskey-auth');
  });

  test('accepts the native error code and redacts an unknown message', () => {
    expect(pairErrorMessage({ code: 'pair_denied', message: 'segredo do payload' })).toContain('recusou');
    expect(pairErrorMessage(new Error('unknown: hskey-auth-sensitive'))).toBe('Não foi possível ler este código.');
  });
});
