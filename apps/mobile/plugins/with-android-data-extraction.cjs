// SPDX-License-Identifier: Apache-2.0
// O TorService grava o estado do tor em app_TorService, caminho fixo da biblioteca.
// allowBackup=false desliga o backup, mas a partir do Android 12 a transferência
// entre aparelhos segue as regras de extração: o diretório do tor fica de fora das
// duas. O estado do núcleo Go já mora em noBackupFilesDir.
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="root" path="app_TorService/" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="root" path="app_TorService/" />
  </device-transfer>
</data-extraction-rules>
`;

function applyDataExtractionRules(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
  return manifest;
}

function withAndroidDataExtraction(config) {
  const withManifest = withAndroidManifest(config, next => {
    applyDataExtractionRules(next.modResults);
    return next;
  });
  return withDangerousMod(withManifest, ['android', async next => {
    const xmlDirectory = path.join(next.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    await fs.mkdir(xmlDirectory, { recursive: true });
    await fs.writeFile(path.join(xmlDirectory, 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES_XML, 'utf8');
    return next;
  }]);
}

module.exports = withAndroidDataExtraction;
module.exports.applyDataExtractionRules = applyDataExtractionRules;
module.exports.DATA_EXTRACTION_RULES_XML = DATA_EXTRACTION_RULES_XML;
