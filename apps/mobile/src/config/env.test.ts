import { resolveAppEnvironment } from './env';

describe('runtime environment', () => {
  test('accepts the three declared environments', () => {
    expect(resolveAppEnvironment('development', true)).toBe('development');
    expect(resolveAppEnvironment('preview', false)).toBe('preview');
    expect(resolveAppEnvironment('production', false)).toBe('production');
  });
  test('uses a safe default for each build kind', () => {
    expect(resolveAppEnvironment(undefined, true)).toBe('development');
    expect(resolveAppEnvironment(undefined, false)).toBe('production');
  });
  test('rejects malformed native extra values', () => {
    expect(() => resolveAppEnvironment('unknown', false)).toThrow('APP_ENV');
  });
});
