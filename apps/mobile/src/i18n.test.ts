import { jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';

import * as localeModule from './i18n';

const hydrateLocale = (localeModule as typeof localeModule & {
  hydrateLocale(): Promise<'pt-BR' | 'en' | 'es'>;
}).hydrateLocale;

afterEach(() => {
  jest.restoreAllMocks();
});

test('hydrates a regional locale and persists the normalized selection', async () => {
  const get = jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue('es-MX');
  const set = jest.spyOn(SecureStore, 'setItemAsync').mockResolvedValue();

  await localeModule.setLocale('pt-BR');
  await expect(hydrateLocale()).resolves.toBe('es');
  expect(get).toHaveBeenCalledWith('cialai.language');
  expect(localeModule.getLocale()).toBe('es');

  await expect(localeModule.setLocale('en-US')).resolves.toBe('en');
  expect(set).toHaveBeenLastCalledWith('cialai.language', 'en');
});
