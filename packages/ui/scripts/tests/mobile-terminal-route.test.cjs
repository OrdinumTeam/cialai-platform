// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/phone-navigation.js');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); }, removeItem: (key) => { map.delete(key); }, map };
}

test('sem nada guardado a rota comeca na lista', async () => {
  const { readPhoneRoute, initialPhoneRoute } = await load();
  assert.deepEqual(readPhoneRoute(memoryStorage()), initialPhoneRoute()); assert.deepEqual(readPhoneRoute(null), initialPhoneRoute());
});
test('a rota gravada volta com sessao, painel e caminho', async () => {
  const { readPhoneRoute, writePhoneRoute, PHONE_ROUTE_KEY } = await load(); const storage = memoryStorage();
  writePhoneRoute(storage, { pane: 'preview', sessionId: 'work', path: 'src/app.js' }); assert.ok(storage.map.has(PHONE_ROUTE_KEY)); assert.deepEqual(readPhoneRoute(storage), { pane: 'preview', sessionId: 'work', path: 'src/app.js' });
  writePhoneRoute(storage, { pane: 'terminal', sessionId: 'work', path: null }); assert.deepEqual(readPhoneRoute(storage), { pane: 'terminal', sessionId: 'work', path: null });
});
test('voltar para a lista apaga a rota guardada', async () => {
  const { readPhoneRoute, writePhoneRoute, initialPhoneRoute, PHONE_ROUTE_KEY } = await load(); const storage = memoryStorage();
  writePhoneRoute(storage, { pane: 'terminal', sessionId: 'work', path: null }); writePhoneRoute(storage, initialPhoneRoute()); assert.equal(storage.map.has(PHONE_ROUTE_KEY), false); assert.deepEqual(readPhoneRoute(storage), initialPhoneRoute());
});
test('valores corrompidos ou incompletos caem em algo seguro', async () => {
  const { readPhoneRoute, initialPhoneRoute, PHONE_ROUTE_KEY } = await load();
  assert.deepEqual(readPhoneRoute(memoryStorage({ [PHONE_ROUTE_KEY]: '{nao é json' })), initialPhoneRoute());
  assert.deepEqual(readPhoneRoute(memoryStorage({ [PHONE_ROUTE_KEY]: JSON.stringify({ pane: 'list', sessionId: 'work' }) })), initialPhoneRoute());
  assert.deepEqual(readPhoneRoute(memoryStorage({ [PHONE_ROUTE_KEY]: JSON.stringify({ pane: 'terminal', sessionId: 42 }) })), initialPhoneRoute());
  assert.deepEqual(readPhoneRoute(memoryStorage({ [PHONE_ROUTE_KEY]: JSON.stringify({ pane: 'preview', sessionId: 'work' }) })), { pane: 'files', sessionId: 'work', path: null });
  assert.deepEqual(readPhoneRoute(memoryStorage({ [PHONE_ROUTE_KEY]: JSON.stringify({ pane: 'files', sessionId: 'work', path: 'x' }) })), { pane: 'files', sessionId: 'work', path: null });
  assert.deepEqual(readPhoneRoute({ getItem() { throw new Error('bloqueado'); } }), initialPhoneRoute());
});
