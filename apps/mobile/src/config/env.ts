import Constants from 'expo-constants';

export type AppEnvironment = 'development' | 'preview' | 'production';

export function resolveAppEnvironment(value: unknown, isDevelopment: boolean): AppEnvironment {
  if (value === undefined || value === null || value === '') return isDevelopment ? 'development' : 'production';
  if (value === 'development' || value === 'preview' || value === 'production') return value;
  throw new Error('app_env_invalid');
}

export function getAppEnvironment(): AppEnvironment {
  return resolveAppEnvironment(Constants.expoConfig?.extra?.appEnv, __DEV__);
}

export function getAppVersion(): string {
  const value = Constants.expoConfig?.version;
  if (!value) throw new Error('app_version_missing');
  return value;
}
