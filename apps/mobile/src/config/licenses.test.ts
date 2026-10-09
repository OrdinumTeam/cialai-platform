import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_LICENSE, THIRD_PARTY_LICENSES, licensesFor } from './licenses';

const notice = readFileSync(join(__dirname, '../../../../NOTICE'), 'utf8').replace(/\s+/g, ' ');

test('every listed component and license comes from the root NOTICE', () => {
  expect(notice).toContain(APP_LICENSE.copyright);
  for (const item of THIRD_PARTY_LICENSES) {
    expect(notice).toContain(item.name);
    expect(notice).toContain(item.license);
  }
});

test('each platform only lists what it bundles', () => {
  const ios = licensesFor('ios').map(item => item.name);
  const android = licensesFor('android').map(item => item.name);
  expect(ios).toContain('Tor.framework');
  expect(ios).not.toContain('tor-android 0.4.9.11');
  expect(android).toContain('tor-android 0.4.9.11');
  expect(android).not.toContain('Tor.framework');
});
