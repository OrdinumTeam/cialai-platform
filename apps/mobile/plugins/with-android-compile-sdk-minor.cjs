// SPDX-License-Identifier: Apache-2.0
// O tor-android publica AAR com minCompileSdk 37, então todo módulo do app compila na
// API 37. Da API 36 em diante o Google só publica a plataforma com versão menor, logo o
// pacote instalável é platforms;android-37.0 e nenhum android-37 existe. O AGP 8.12 monta
// o alvo a partir de compileSdk mais compileSdkMinor; sem o menor ele procura android-37
// e para com Failed to find target with hash string.
//
// O menor só entra onde o módulo já compila na 37, porque android-35.0 e android-36.0 não
// existem e quebrariam quem fixa uma API anterior. Ele também precisa entrar depois do
// compileSdk, já que trocar a maior recria a versão sem a menor.
//
// São dois pontos porque a avaliação dos módulos não é uniforme. Quando o projeto raiz
// roda, o módulo app já está avaliado e não aceita mais um afterEvaluate, enquanto os
// outros ainda nem foram avaliados. O app recebe o ajuste no próprio script, logo após o
// compileSdk; os demais recebem pelo gancho da raiz.
const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

const COMPILE_SDK_MAJOR = 37;
const MARKER = '// Cialai compile SDK minor for the android-37.0 platform';

const ROOT_COMPILE_SDK_MINOR = `${MARKER}
subprojects { cialaiSubproject ->
  if (cialaiSubproject.state.executed) return
  cialaiSubproject.afterEvaluate {
    def cialaiAndroid = cialaiSubproject.extensions.findByName('android')
    if (cialaiAndroid == null) return
    if (!cialaiAndroid.hasProperty('compileSdkMinor')) return
    if (cialaiAndroid.compileSdk == ${COMPILE_SDK_MAJOR} && cialaiAndroid.compileSdkMinor == null) {
      cialaiAndroid.compileSdkMinor = 0
    }
  }
}
`;

const APP_COMPILE_SDK_MINOR = `${MARKER}
android {
  if (compileSdk == ${COMPILE_SDK_MAJOR} && compileSdkMinor == null) {
    compileSdkMinor = 0
  }
}
`;

function appendCompileSdkMinor(contents, block) {
  if (contents.includes(MARKER)) return contents;
  return `${contents.trimEnd()}\n\n${block}`;
}

function appendRootCompileSdkMinor(contents) {
  return appendCompileSdkMinor(contents, ROOT_COMPILE_SDK_MINOR);
}

function appendAppCompileSdkMinor(contents) {
  return appendCompileSdkMinor(contents, APP_COMPILE_SDK_MINOR);
}

function requireGroovy(modResults) {
  if (modResults.language !== 'groovy') {
    throw new Error('O alvo android-37.0 do Cialai exige Gradle em Groovy.');
  }
}

function withAndroidCompileSdkMinor(config) {
  const withRoot = withProjectBuildGradle(config, next => {
    requireGroovy(next.modResults);
    next.modResults.contents = appendRootCompileSdkMinor(next.modResults.contents);
    return next;
  });
  return withAppBuildGradle(withRoot, next => {
    requireGroovy(next.modResults);
    next.modResults.contents = appendAppCompileSdkMinor(next.modResults.contents);
    return next;
  });
}

module.exports = withAndroidCompileSdkMinor;
module.exports.appendRootCompileSdkMinor = appendRootCompileSdkMinor;
module.exports.appendAppCompileSdkMinor = appendAppCompileSdkMinor;
module.exports.COMPILE_SDK_MAJOR = COMPILE_SDK_MAJOR;
