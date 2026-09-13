// SPDX-License-Identifier: Apache-2.0
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// Cialai release signing from ignored key.properties';
const RELEASE_SIGNING = `${MARKER}
def cialaiKeystoreProperties = new Properties()
def cialaiKeystorePropertiesFile = rootProject.file('key.properties')
if (cialaiKeystorePropertiesFile.exists()) {
  cialaiKeystoreProperties.load(new FileInputStream(cialaiKeystorePropertiesFile))
}

android {
  signingConfigs {
    cialaiRelease {
      if (cialaiKeystorePropertiesFile.exists()) {
        storeFile file(cialaiKeystoreProperties['storeFile'])
        storePassword cialaiKeystoreProperties['storePassword']
        keyAlias cialaiKeystoreProperties['keyAlias']
        keyPassword cialaiKeystoreProperties['keyPassword']
      }
    }
  }
  buildTypes {
    release {
      if (cialaiKeystorePropertiesFile.exists()) {
        signingConfig signingConfigs.cialaiRelease
      }
    }
  }
}
`;

function appendReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;
  return `${contents.trimEnd()}\n\n${RELEASE_SIGNING}`;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, next => {
    if (next.modResults.language !== 'groovy') {
      throw new Error('A assinatura Android do Cialai exige Gradle em Groovy.');
    }
    next.modResults.contents = appendReleaseSigning(next.modResults.contents);
    return next;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.appendReleaseSigning = appendReleaseSigning;
