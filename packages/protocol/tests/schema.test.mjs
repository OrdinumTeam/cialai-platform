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

test('every shared JSON fixture validates against the bridge schema', () => {
  const files = readdirSync(`${root}/fixtures`).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, ['call.json', 'channel.json', 'event.json', 'hello.json', 'result-error.json', 'result-ok.json', 'welcome.json']);
  for (const file of files) {
    const value = JSON.parse(readFileSync(`${root}/fixtures/${file}`, 'utf8'));
    assert.equal(matches(schema, value), true, file);
  }
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
