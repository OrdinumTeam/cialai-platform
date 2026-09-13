import { expect, test } from '@jest/globals';

import signingPlugin from './with-android-release-signing.cjs';

const { appendReleaseSigning } = signingPlugin;
const base = `plugins { id 'com.android.application' }

android {
  buildTypes {
    release {
      signingConfig signingConfigs.debug
    }
  }
}
`;

test('adds an idempotent release signing block backed by key.properties', () => {
  const once = appendReleaseSigning(base);
  const twice = appendReleaseSigning(once);
  expect(twice).toBe(once);
  expect(once).toContain("rootProject.file('key.properties')");
  expect(once).toContain('storePassword cialaiKeystoreProperties');
  expect(once).toContain('signingConfig signingConfigs.cialaiRelease');
  expect(once).not.toContain('CM_KEYSTORE_PASSWORD');
});
