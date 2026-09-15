// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(readFileSync(`${root}/schema/bridge-message.schema.json`, 'utf8'));

function matches(definition, value) {
  if (definition.$ref) return matches(schema.$defs[definition.$ref.split('/').at(-1)], value);
  if (definition.const !== undefined && value !== definition.const) return false;
  if (definition.enum && !definition.enum.includes(value)) return false;
  if (definition.type === 'null') return value === null;
  if (Array.isArray(definition.type) && !definition.type.some((type) => matches({ ...definition, type }, value))) return false;
  if (definition.type === 'string' && typeof value !== 'string') return false;
  if (definition.type === 'integer' && (!Number.isInteger(value) || value < (definition.minimum ?? -Infinity))) return false;
  if (definition.type === 'boolean' && typeof value !== 'boolean') return false;
  if (definition.type === 'array') return Array.isArray(value) && value.every((item) => matches(definition.items || {}, item));
  if (definition.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((definition.required || []).some((key) => !(key in value))) return false;
    if (definition.additionalProperties === false && Object.keys(value).some((key) => !(key in (definition.properties || {})))) return false;
    if (Object.entries(definition.properties || {}).some(([key, child]) => key in value && !matches(child, value[key]))) return false;
  }
  if (definition.oneOf && definition.oneOf.filter((entry) => matches(entry, value)).length !== 1) return false;
  return true;
}

// Fixtures that are not bridge frames and have their own test below.
const nonBridgeFixtures = ['pair-v2.json'];

test('every shared JSON fixture validates against the bridge schema', () => {
  const all = readdirSync(`${root}/fixtures`).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(all.filter((name) => nonBridgeFixtures.includes(name)), nonBridgeFixtures);
  const files = all.filter((name) => !nonBridgeFixtures.includes(name));
  assert.deepEqual(files, ['call.json', 'channel.json', 'event.json', 'hello.json', 'result-error.json', 'result-ok.json', 'welcome.json']);
  for (const file of files) {
    const value = JSON.parse(readFileSync(`${root}/fixtures/${file}`, 'utf8'));
    assert.equal(matches(schema, value), true, file);
  }
});

test('pair-v2 fixture is a CIALAI2 payload with six candidates and the onion under 700 bytes', () => {
  const fixture = JSON.parse(readFileSync(`${root}/fixtures/pair-v2.json`, 'utf8'));
  assert.deepEqual(Object.keys(fixture), ['payload', 'jsonBytes', 'json']);
  assert.match(fixture.payload, /^CIALAI2\.[A-Za-z0-9_-]+$/);
  const raw = Buffer.from(fixture.payload.slice('CIALAI2.'.length), 'base64url');
  assert.equal(raw.length, fixture.jsonBytes);
  assert.ok(fixture.jsonBytes < 700, `${fixture.jsonBytes} bytes`);
  assert.equal(raw.toString('utf8'), JSON.stringify(fixture.json));
  const { json } = fixture;
  assert.deepEqual(Object.keys(json), ['v', 'd', 'o', 'c', 's', 'e', 'pid']);
  assert.equal(json.v, 2);
  assert.deepEqual(Object.keys(json.d), ['id', 'n', 'k']);
  assert.match(json.d.id, /^d_[A-Za-z0-9_-]{22}$/);
  assert.match(json.d.k, /^[A-Za-z0-9_-]{43}$/);
  assert.match(json.o, /^[a-z2-7]{56}\.onion:[1-9][0-9]{0,4}$/);
  assert.equal(json.c.length, 6);
  for (const candidate of json.c) {
    assert.deepEqual(Object.keys(candidate), ['t', 'a']);
    assert.ok(['lan', 'ipv6', 'mapped', 'stun'].includes(candidate.t), candidate.t);
  }
  assert.match(json.s, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Number.isInteger(json.e) && json.e > 0);
  assert.match(json.pid, /^p_[A-Za-z0-9_-]{11}$/);
});

test('schema rejects incomplete, extra and incompatible frames', () => {
  for (const invalid of [
    { type: 'hello', version: 2, client: 'cialai-ios' },
    { type: 'call', id: 1, cmd: 'pty_list', args: {}, secret: true },
    { type: 'result', id: 1, ok: false },
    { type: 'channel', channel: -1, message: {} },
    { type: 'unknown' },
  ]) assert.equal(matches(schema, invalid), false, JSON.stringify(invalid));
});
