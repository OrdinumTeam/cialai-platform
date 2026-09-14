// SPDX-License-Identifier: Apache-2.0
// Declara no Android os mesmos idiomas da interface para a escolha de idioma
// por aplicativo do sistema. A lista vem de @cialai/i18n pelo app.config.ts.
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

function localeConfigXml(locales) {
  if (!Array.isArray(locales) || locales.length === 0) throw new Error('android_locales_missing');
  for (const locale of locales) {
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) throw new Error(`android_locale_invalid:${locale}`);
  }
  const entries = locales.map(locale => `  <locale android:name="${locale}" />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
${entries}
</locale-config>
`;
}

function applyLocaleConfig(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:localeConfig'] = '@xml/locales_config';
  return manifest;
}

function withAndroidLocales(config, { locales } = {}) {
  const xml = localeConfigXml(locales);
  const withManifest = withAndroidManifest(config, next => {
    applyLocaleConfig(next.modResults);
    return next;
  });
  return withDangerousMod(withManifest, ['android', async next => {
    const xmlDirectory = path.join(next.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    await fs.mkdir(xmlDirectory, { recursive: true });
    await fs.writeFile(path.join(xmlDirectory, 'locales_config.xml'), xml, 'utf8');
    return next;
  }]);
}

module.exports = withAndroidLocales;
module.exports.applyLocaleConfig = applyLocaleConfig;
module.exports.localeConfigXml = localeConfigXml;
