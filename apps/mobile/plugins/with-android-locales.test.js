import { expect, test } from '@jest/globals';

import localesPlugin from './with-android-locales.cjs';

const { applyLocaleConfig, localeConfigXml } = localesPlugin;

test('declares the interface languages for the Android per-app language setting', () => {
  expect(localeConfigXml(['pt-BR', 'en', 'es'])).toBe(`<?xml version="1.0" encoding="utf-8"?>
<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
  <locale android:name="pt-BR" />
  <locale android:name="en" />
  <locale android:name="es" />
</locale-config>
`);
  expect(() => localeConfigXml([])).toThrow('android_locales_missing');
  expect(() => localeConfigXml(['pt_BR'])).toThrow('android_locale_invalid');

  const manifest = { manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' } }] } };
  applyLocaleConfig(manifest);
  expect(manifest.manifest.application[0]?.$['android:localeConfig']).toBe('@xml/locales_config');
});
