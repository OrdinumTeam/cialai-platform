import { formatFingerprint, formatLastSeen } from './format';

describe('desktop formatting', () => {
  test('groups the fingerprint in blocks of four for comparison', () => {
    expect(formatFingerprint('0123456789ABCDEF')).toBe('0123 4567 89ab cdef');
    expect(formatFingerprint('01234')).toBe('0123 4');
    expect(formatFingerprint('')).toBe('');
  });

  test('formats the last access and rejects invalid dates', () => {
    expect(formatLastSeen('2026-09-12T12:00:00.000Z', 'pt-BR')).toMatch(/12\/09\/2026|12\/09\/26/);
    expect(formatLastSeen('ontem', 'pt-BR')).toBeNull();
  });
});
