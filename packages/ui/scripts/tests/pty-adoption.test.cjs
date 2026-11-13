// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/terminals/pty-adoption.js');
const free = (id, cwd, extra = {}) => ({ id, cwd, ptyId: null, spawning: false, ...extra });

test('um PTY sem tag so e adotado quando a pasta aponta uma sessao livre e mais nenhuma', async () => {
  const { untaggedOwner } = await load();
  const only = free('a', '/p');
  assert.equal(untaggedOwner([only, free('b', '/q')], { cwd: '/p', tag: '' }), only);
  // Duas sessoes livres na mesma pasta: nenhuma adota, para nao trocar o
  // terminal e o status de um card pelo de outro.
  assert.equal(untaggedOwner([free('a', '/p'), free('b', '/p')], { cwd: '/p', tag: '' }), null);
  // Quem ja tem PTY ou esta abrindo um nao conta como livre.
  assert.equal(untaggedOwner([free('a', '/p', { ptyId: 7 }), free('b', '/p', { spawning: true })], { cwd: '/p', tag: '' }), null);
  assert.equal(untaggedOwner([free('a', '/p', { ptyId: 7 }), free('b', '/p')], { cwd: '/p', tag: null }).id, 'b');
  // Com tag a identidade e a tag, e esta funcao nao decide nada.
  assert.equal(untaggedOwner([only], { cwd: '/p', tag: 'a' }), null);
  assert.equal(untaggedOwner([only], { cwd: '', tag: '' }), null);
});
