import Constants from 'expo-constants';

export type AppEnvironment = 'development' | 'preview' | 'production';

export function resolveAppEnvironment(value: unknown, isDevelopment: boolean): AppEnvironment {
  if (value === undefined || value === null || value === '') return isDevelopment ? 'development' : 'production';
  if (value === 'development' || value === 'preview' || value === 'production') return value;
  throw new Error('APP_ENV inválido na configuração nativa.');
}

export function getAppEnvironment(): AppEnvironment {
  return resolveAppEnvironment(Constants.expoConfig?.extra?.appEnv, __DEV__);
}

export function getAppVersion(): string {
  const value = Constants.expoConfig?.version;
  if (!value) throw new Error('Versão do app ausente na configuração nativa.');
  return value;
}
