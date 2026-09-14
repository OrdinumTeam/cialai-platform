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

test('localizes biometric reasons received from the shared page', async () => {
  await localeModule.setLocale('es-MX');

  expect(localeModule.localizeSensitiveReason('Autorizar digitação neste terminal'))
    .toBe('Autorizar escritura en este terminal');
  expect(localeModule.localizeSensitiveReason('Encerrar este terminal'))
    .toBe('Finalizar este terminal');
  expect(localeModule.localizeSensitiveReason('terminal_input'))
    .toBe('Autorizar escritura en este terminal');
  expect(localeModule.localizeSensitiveReason('Finalizar este terminal'))
    .toBe('Finalizar este terminal');
  expect(localeModule.localizeSensitiveReason('Autorizar alteração no computador'))
    .toBe('Autorizar cambios en la computadora');
  expect(localeModule.localizeSensitiveReason('Motivo externo')).toBe('Motivo externo');
});
