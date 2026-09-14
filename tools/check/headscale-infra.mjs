// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../infra/headscale/', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

// O Windows não guarda o bit de execução no disco; lá vale o modo registrado no índice do Git.
function executable(path) {
  if (process.platform !== 'win32') return Boolean(statSync(`${root}${path}`).mode & 0o100);
  return execFileSync('git', ['ls-files', '--stage', '--', path], { cwd: root, encoding: 'utf8' }).startsWith('100755 ');
}

for (const path of ['docker-compose.yml', 'config/config.yaml.template', 'config/policy.json', 'bootstrap.sh', 'README.md', '.gitignore']) {
  assert.ok(existsSync(`${root}${path}`), `Missing Headscale recipe file: ${path}`);
}

const compose = read('docker-compose.yml');
assert.match(compose, /image: headscale\/headscale:0\.29\.3@sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72/);
for (const port of ['"443:443"', '"80:80"', '"3478:3478/udp"']) assert.ok(compose.includes(port), `Missing port ${port}`);
assert.ok(!compose.includes('9090'), 'Metrics port must not be published');
assert.match(compose, /\.\/config:\/etc\/headscale:ro/);
assert.match(compose, /headscale-data:\/var\/lib\/headscale/);
assert.match(compose, /restart: unless-stopped/);
assert.match(compose, /test: \["CMD", "\/ko-app\/headscale", "health"\]/);

const template = read('config/config.yaml.template');
for (const expected of [
  'server_url: https://__HEADSCALE_DOMAIN__',
  'listen_addr: 0.0.0.0:443',
  'metrics_listen_addr: 127.0.0.1:9090',
  'grpc_allow_insecure: false',
  'verify_clients: true',
  'stun_listen_addr: 0.0.0.0:3478',
  'ipv4: __PUBLIC_IPV4__',
  'urls: []',
  'disable_check_updates: true',
  'tls_letsencrypt_hostname: __HEADSCALE_DOMAIN__',
  'tls_letsencrypt_challenge_type: HTTP-01',
  'mode: file',
  'path: /etc/headscale/policy.json',
  'base_domain: cialai.internal',
  'override_local_dns: false',
  'unix_socket: /var/run/headscale/headscale.sock',
]) assert.ok(template.includes(expected), `Headscale template drifted from document 06: ${expected}`);
assert.deepEqual([...new Set(template.match(/__[A-Z0-9_]+__/g))].sort(), ['__HEADSCALE_DOMAIN__', '__PUBLIC_IPV4__']);

const policy = JSON.parse(read('config/policy.json').replace(/^\s*\/\/.*$/gm, ''));
assert.deepEqual(policy, {
  grants: [{ src: ['autogroup:member'], dst: ['autogroup:self'], ip: ['tcp:4740'] }],
  tagOwners: {},
  ssh: [],
});

const bootstrap = read('bootstrap.sh');
assert.match(bootstrap, /^#!\/usr\/bin\/env bash/);
assert.match(bootstrap, /set -euo pipefail/);
assert.match(bootstrap, /valid_domain "\$domain"/);
assert.match(bootstrap, /valid_ipv4 "\$ipv4"/);
assert.match(bootstrap, /configtest/);
assert.match(bootstrap, /apikeys create --expiration 365d/);
assert.ok(!/apikeys create(?![^\n]*365d)/.test(bootstrap.replace(/docker compose exec headscale headscale apikeys create --expiration 365d/g, '')), 'bootstrap must not create API keys');
assert.ok(executable('bootstrap.sh'), 'bootstrap.sh must be executable');

assert.match(read('.gitignore'), /^config\/config\.yaml$/m);

const prose = read('README.md').split(/```[\s\S]*?```/).join('\n');
for (const [index, line] of prose.split('\n').entries()) {
  const text = line.replace(/`[^`]*`/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '');
  assert.ok(!/[()–—]| - /.test(text), `README line ${index + 1} uses a forbidden separator`);
}

console.log('PASS Headscale recipe: pinned image, document 06 config, self policy, safe bootstrap and diagnostics guide');
