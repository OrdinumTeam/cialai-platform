// SPDX-License-Identifier: Apache-2.0
// Componentes de terceiros que o app do celular leva, copiados do NOTICE da
// raiz do repositório. Nome e licença são dados, não texto de interface, e
// ficam iguais nos três idiomas. Um teste confere cada nome contra o NOTICE.

export type License = { name: string; license: string; platform?: 'ios' | 'android' };

export const APP_LICENSE = { name: 'Cialai', license: 'Apache-2.0', copyright: 'Copyright 2026 ORDINUM INOVACAO E TECNOLOGIA LTDA' } as const;

export const THIRD_PARTY_LICENSES: readonly License[] = Object.freeze([
  { name: 'Tailscale / tsnet', license: 'BSD-3-Clause' },
  { name: 'Pion mDNS v2.2.0', license: 'MIT' },
  { name: 'Pion logging v0.2.4', license: 'MIT' },
  { name: 'Tor.framework', license: 'MIT', platform: 'ios' },
  { name: 'Tor 0.4.9.11', license: 'BSD-3-Clause' },
  { name: 'libevent 2.1.13', license: 'BSD-3-Clause', platform: 'ios' },
  { name: 'OpenSSL 3.6.3', license: 'Apache-2.0', platform: 'ios' },
  { name: 'liblzma from XZ Utils 5.8.3', license: '0BSD', platform: 'ios' },
  { name: 'tor-android 0.4.9.11', license: 'BSD-3-Clause', platform: 'android' },
  { name: 'libevent 2.1.12-stable', license: 'BSD-3-Clause', platform: 'android' },
  { name: 'OpenSSL 3.5.7', license: 'Apache-2.0', platform: 'android' },
  { name: 'zlib 1.3.2', license: 'Zlib', platform: 'android' },
  { name: 'zstd 1.5.7', license: 'BSD-3-Clause', platform: 'android' },
  { name: 'jtorctl 0.4.5.7', license: 'BSD-3-Clause', platform: 'android' },
  { name: 'AndroidX LocalBroadcastManager 1.1.0', license: 'Apache-2.0', platform: 'android' },
  { name: '@lobehub/icons-static-svg 1.95.0', license: 'MIT' },
  { name: 'Outfit 1.100', license: 'OFL-1.1' },
  { name: 'React', license: 'MIT' },
  { name: 'Expo', license: 'MIT' }
]);

export function licensesFor(platform: string): License[] {
  return THIRD_PARTY_LICENSES.filter(item => !item.platform || item.platform === platform);
}
