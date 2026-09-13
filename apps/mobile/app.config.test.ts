import type { ConfigContext } from 'expo/config';

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

  test('declares encryption, data protection, no backup and SDK plugin', () => {
    const config = buildConfig(context);
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(true);
    expect(config.ios?.entitlements?.['com.apple.developer.default-data-protection'])
      .toBe('NSFileProtectionCompleteUntilFirstUserAuthentication');
    expect(config.android?.allowBackup).toBe(false);
    expect(JSON.stringify(config.plugins)).toContain('targetSdkVersion');
  });

  test('fails clearly for an invalid application environment', () => {
    process.env.APP_ENV = 'invalid';
    expect(() => buildConfig(context)).toThrow('APP_ENV');
  });

  test('uses the monotonic Codemagic build number as Android version code', () => {
    process.env.PROJECT_BUILD_NUMBER = '42';
    expect(buildConfig(context).android?.versionCode).toBe(42);
    process.env.PROJECT_BUILD_NUMBER = 'invalid';
    expect(() => buildConfig(context)).toThrow('PROJECT_BUILD_NUMBER');
  });
});
