// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSensitiveAuthorizer, remoteCommandAccess } from '../sensitive.js';

test('unknown and desktop-only commands fail closed before authorization', async () => {
  let prompts = 0;
  const authorizer = createSensitiveAuthorizer({ requireSensitive: async () => { prompts += 1; } });
  for (const command of ['unknown', 'set_preferences', 'fs_reveal', 'git_diff', 'browser_start', 'pty_resize', 'pty_presentation']) {
    await assert.rejects(authorizer.authorize(command, { id: 9 }), { code: 'MOBILE_READ_ONLY' });
  }
  assert.equal(prompts, 0);
  assert.equal(remoteCommandAccess('pty_list'), 'read');
  assert.equal(remoteCommandAccess('pty_write'), 'terminal');
  assert.equal(remoteCommandAccess('pty_kill'), 'action');
  assert.equal(remoteCommandAccess('pty_spawn'), 'session');
  assert.equal(remoteCommandAccess('set_preferences'), null);
});

test('terminal input shares a grant until lock and kill always asks again', async () => {
  const prompts = [];
  let lock;
  let releaseFirst;
  const authorizer = createSensitiveAuthorizer({
    requireSensitive: (level, reason) => {
      prompts.push([level, reason]);
      if (prompts.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve();
    },
    onLock: (listener) => { lock = listener; return () => { lock = null; }; },
  });
  const first = authorizer.authorize('pty_write', { id: 7 });
  const second = authorizer.authorize('pty_view_claim', { id: 7 });
  assert.equal(prompts.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  await authorizer.authorize('pty_write', { id: 7 });
  assert.equal(prompts.length, 1);
  lock();
  await authorizer.authorize('pty_write', { id: 7 });
  await authorizer.authorize('pty_kill', { id: 7 });
  await authorizer.authorize('pty_spawn');
  assert.deepEqual(prompts.slice(1).map(([level]) => level), ['action', 'action', 'session']);
  authorizer.dispose();
  assert.equal(lock, null);
});
