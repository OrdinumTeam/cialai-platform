import { pairErrorMessage } from './pair-errors';
import { setLocale } from '../i18n';

describe('pairing errors', () => {
  beforeEach(async () => {
    await setLocale('pt-BR');
  });

  test.each([
    ['payload_invalid', 'não é um código de pareamento'],
    ['payload_version', 'Atualize o Cialai'],
    ['payload_expired', 'expirou'],
    ['pair_consumed', 'já foi usado'],
    ['pair_expired', 'expirou'],
    ['pair_unknown', 'cancelado'],
    ['pair_denied', 'recusou'],
    ['pair_timeout', 'não respondeu'],
    ['pair_rate_limited', 'Muitas tentativas'],
    ['pair_secret_mismatch', 'não confere'],
    ['pair_key_mismatch', 'não confere'],
    ['reserve_preparing', 'reserva'],
    ['reserve_unavailable', 'alcançar o computador'],
    ['no_path', 'alcançar o computador'],
    ['desktop_unreachable', 'alcançar o computador']
  ])('maps %s without exposing the native message', (code, expected) => {
    const message = pairErrorMessage(new Error(`${code}: segredo do payload`));
    expect(message).toContain(expected);
    expect(message).not.toContain('segredo');
  });

  test('accepts the Android code and the iOS message chain', () => {
    expect(pairErrorMessage({ code: 'pair_denied', message: 'segredo do payload' })).toContain('recusou');
    expect(pairErrorMessage(new Error("Calling the 'pair' function has failed\n→ Caused by: pair_timeout: sem resposta")))
      .toContain('não respondeu');
  });

  test('falls back for unknown or Headscale era codes', () => {
    expect(pairErrorMessage(new Error('unknown: hskey-auth-sensitive'))).toBe('Não foi possível ler este código.');
    expect(pairErrorMessage(new Error('control_unreachable: https://hs.example.com'))).toBe('Não foi possível ler este código.');
    expect(pairErrorMessage('pair_denied')).toBe('Não foi possível ler este código.');
  });
});
