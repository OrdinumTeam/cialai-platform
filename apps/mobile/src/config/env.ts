import Constants from 'expo-constants';

export type AppEnvironment = 'development' | 'preview' | 'production';

export function getAppEnvironment(): AppEnvironment {
  const value = Constants.expoConfig?.extra?.appEnv;
  if (value === 'development' || value === 'preview' || value === 'production') return value;
  return __DEV__ ? 'development' : 'production';
}

export function getAppVersion(): string {
  const value = Constants.expoConfig?.version;
  if (!value) throw new Error('Versão do app ausente na configuração nativa.');
  return value;
}
