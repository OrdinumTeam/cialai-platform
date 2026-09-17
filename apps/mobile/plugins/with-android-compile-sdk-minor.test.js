import { expect, test } from '@jest/globals';

import compileSdkMinorPlugin from './with-android-compile-sdk-minor.cjs';

const { appendRootCompileSdkMinor, appendAppCompileSdkMinor } = compileSdkMinorPlugin;

const rootBase = `buildscript {
  ext {
    compileSdkVersion = 37
    targetSdkVersion = 36
  }
}

apply plugin: "expo-root-project"
`;

const appBase = `apply plugin: "com.android.application"

android {
  compileSdk rootProject.ext.compileSdkVersion
  namespace 'br.com.ordinum.cialai'
}
`;

test('the root hook is idempotent and only touches modules already on API 37', () => {
  const once = appendRootCompileSdkMinor(rootBase);
  const twice = appendRootCompileSdkMinor(once);
  expect(twice).toBe(once);
  expect(once).toContain('cialaiAndroid.compileSdk == 37');
  expect(once).toContain('cialaiAndroid.compileSdkMinor == null');
  expect(once).toContain('compileSdkMinor = 0');
  // android-35.0 e android-36.0 não existem, então a guarda é a comparação exata.
  expect(once).not.toContain('cialaiAndroid.compileSdk >=');
});

test('the root hook skips a module that Gradle already evaluated', () => {
  const once = appendRootCompileSdkMinor(rootBase);
  // O módulo app já está avaliado quando a raiz roda e recusaria um afterEvaluate.
  expect(once).toContain('if (cialaiSubproject.state.executed) return');
});

test('the app module sets the minor in its own script, after the major', () => {
  const once = appendAppCompileSdkMinor(appBase);
  const twice = appendAppCompileSdkMinor(once);
  expect(twice).toBe(once);
  expect(once).toContain('compileSdkMinor = 0');
  expect(once.indexOf('compileSdk rootProject.ext.compileSdkVersion')).toBeLessThan(
    once.indexOf('compileSdkMinor = 0')
  );
});

test('both blocks keep the generated script above them intact', () => {
  expect(appendRootCompileSdkMinor(rootBase)).toContain('apply plugin: "expo-root-project"');
  expect(appendAppCompileSdkMinor(appBase)).toContain("namespace 'br.com.ordinum.cialai'");
});
