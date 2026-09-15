import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigContext } from 'expo/config';

import { SUPPORTED_LOCALES, dictionaries } from '@cialai/i18n';

import buildConfig from './app.config';

const context = { config: {} } as ConfigContext;

describe('Expo app config', () => {
  const originalAppEnv = process.env.APP_ENV;
  const originalBuildNumber = process.env.PROJECT_BUILD_NUMBER;
  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalBuildNumber === undefined) delete process.env.PROJECT_BUILD_NUMBER;
    else process.env.PROJECT_BUILD_NUMBER = originalBuildNumber;
  });

  test('defines both identities without a global cleartext bypass', () => {
    process.env.APP_ENV = 'production';
    const config = buildConfig(context);
    expect(config.name).toBe('Cialai');
    expect(config.platforms).toEqual(['ios', 'android']);
    expect(config.ios?.bundleIdentifier).toBe('br.com.ordinum.cialai');
    expect(config.android?.package).toBe('br.com.ordinum.cialai');
    expect(config.ios?.supportsTablet).toBe(false);
    expect(config.ios?.infoPlist).not.toHaveProperty('NSAppTransportSecurity');
  });

  test('declares the documentation exempt encryption, data protection, no backup and SDK plugin', () => {
    const config = buildConfig(context);
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(false);
    expect(config.ios?.entitlements?.['com.apple.developer.default-data-protection'])
      .toBe('NSFileProtectionCompleteUntilFirstUserAuthentication');
    expect(config.android?.allowBackup).toBe(false);
    expect(JSON.stringify(config.plugins)).toContain('targetSdkVersion');
  });

  test('localizes native permission prompts from the shared dictionaries', () => {
    const config = buildConfig(context);
    expect(config.ios?.infoPlist?.CFBundleDevelopmentRegion).toBe('pt-BR');
    expect(config.ios?.infoPlist?.CFBundleLocalizations).toEqual([...SUPPORTED_LOCALES]);
    expect(Object.keys(config.locales ?? {})).toEqual([...SUPPORTED_LOCALES]);
    for (const locale of SUPPORTED_LOCALES) {
      expect(config.locales?.[locale]).toEqual({ ios: {
        NSCameraUsageDescription: dictionaries[locale]['mobile.permission.camera'],
        NSLocalNetworkUsageDescription: dictionaries[locale]['mobile.permission.localNetwork'],
        NSFaceIDUsageDescription: dictionaries[locale]['mobile.permission.faceId']
      } });
    }
    expect(config.ios?.infoPlist?.NSCameraUsageDescription).toBe(dictionaries['pt-BR']['mobile.permission.camera']);
    expect(JSON.stringify(config.locales)).toContain('cámara');
    expect(JSON.stringify(config.locales)).toContain('local network');
    expect(config.plugins).toContainEqual(['./plugins/with-android-locales.cjs', { locales: [...SUPPORTED_LOCALES] }]);
  });

  test('uses the approved Cialai icon on iOS and an adaptive icon on Android', () => {
    const config = buildConfig(context);
    expect(config.icon).toBe('../desktop/design/app-icon-1024.png');
    expect(config.android?.adaptiveIcon).toEqual({
      foregroundImage: '../desktop/design/android-foreground-1024.png',
      backgroundColor: '#FFFFFF'
    });
  });

  test('fails clearly for an invalid application environment', () => {
    process.env.APP_ENV = 'invalid';
    expect(() => buildConfig(context)).toThrow('APP_ENV');
  });

  test('builds Android only for the ABIs shipped by the gomobile binding', () => {
    const plugin = buildConfig(context).plugins?.find(
      entry => Array.isArray(entry) && entry[0] === 'expo-build-properties'
    ) as [string, { android: { buildArchs: string[] } }] | undefined;
    expect(plugin?.[1].android.buildArchs).toEqual(['arm64-v8a', 'x86_64']);
    const binder = readFileSync(join(__dirname, '../../tools/build-tunnel-mobile.sh'), 'utf8');
    expect(binder).toContain('-target=android/arm64,android/amd64');
  });

  test('declares the local discovery service and pins the in-process Tor pod once for iOS', () => {
    const config = buildConfig(context);
    expect(config.ios?.infoPlist?.NSBonjourServices).toEqual(['_cialai._udp']);
    expect(config.ios?.infoPlist?.NSLocalNetworkUsageDescription).toBe(dictionaries['pt-BR']['mobile.permission.localNetwork']);
    const plugin = config.plugins?.find(
      entry => Array.isArray(entry) && entry[0] === 'expo-build-properties'
    ) as [string, { ios: { extraPods: { name: string; version: string; modular_headers: boolean }[] } }] | undefined;
    const tor = plugin?.[1].ios.extraPods.find(pod => pod.name === 'Tor');
    expect(tor).toEqual({ name: 'Tor', version: expect.stringMatching(/^409\.\d+\.\d+$/), modular_headers: true });
    const podspec = readFileSync(join(__dirname, 'modules/cialai-tunnel/ios/CialaiTunnel.podspec'), 'utf8');
    expect(podspec).toContain(`spec.dependency 'Tor', '${tor?.version}'`);
  });

  test('uses the monotonic Codemagic build number as Android version code', () => {
    process.env.PROJECT_BUILD_NUMBER = '42';
    expect(buildConfig(context).android?.versionCode).toBe(42);
    process.env.PROJECT_BUILD_NUMBER = 'invalid';
    expect(() => buildConfig(context)).toThrow('project_build_number_invalid');
  });
});
