// SPDX-License-Identifier: Apache-2.0
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`;

function withManifestPolicy(config) {
  return withAndroidManifest(config, next => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(next.modResults);
    application.$['android:allowBackup'] = 'false';
    application.$['android:usesCleartextTraffic'] = 'false';
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return next;
  });
}

function withNetworkSecurityFile(config) {
  return withDangerousMod(config, ['android', async next => {
    const xmlDirectory = path.join(next.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    await fs.mkdir(xmlDirectory, { recursive: true });
    await fs.writeFile(path.join(xmlDirectory, 'network_security_config.xml'), NETWORK_SECURITY_XML, 'utf8');
    return next;
  }]);
}

function withLoopbackNetworkSecurity(config) {
  return withNetworkSecurityFile(withManifestPolicy(config));
}

module.exports = withLoopbackNetworkSecurity;
module.exports.NETWORK_SECURITY_XML = NETWORK_SECURITY_XML;
