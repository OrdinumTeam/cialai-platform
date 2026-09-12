// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalViewport } from '../src/terminals/viewport.js';
import { phoneRoute, initialPhoneRoute } from '../src/terminals/phone-navigation.js';

test('phone opens the list and visits one pane at a time without losing session', () => {
  let route = initialPhoneRoute();
  assert.deepEqual(route, { pane: 'list', sessionId: null, path: null });
  route = phoneRoute(route, { type: 'select', id: 'work' });
  assert.equal(route.pane, 'terminal');
  route = phoneRoute(route, { type: 'files' });
  route = phoneRoute(route, { type: 'preview', path: 'src/app.js' });
  assert.equal(route.pane, 'preview');
  route = phoneRoute(route, { type: 'back' });
  assert.equal(route.pane, 'files');
  route = phoneRoute(route, { type: 'back' });
  assert.equal(route.pane, 'terminal');
  assert.equal(route.sessionId, 'work');
  assert.equal(phoneRoute(route, { type: 'back' }).pane, 'list');
});

function fixture() {
  const calls = []; let revision = 0; const applied = []; const tasks = new Map(); let timer = 0;
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    return { id: 7, owner: 'remote', leaseId: 1, revision: ++revision, cols: args.cols || 120, rows: args.rows || 32 };
  };
  const view = new TerminalViewport({ id: 7, invoke, apply: v => applied.push(v), changed() {},
    repeat: fn => { tasks.set(++timer, fn); return timer; }, cancel: id => tasks.delete(id) });
  return { view, calls, applied, tasks };
}

test('resize never claims ownership; explicit claim renews at new dimensions', async () => {
  const f = fixture();
  await f.view.resize({ cols: 45, rows: 30 });
  assert.equal(f.calls.length, 0);
  await f.view.claim({ cols: 45, rows: 30 });
  assert.equal(f.calls[0].cmd, 'pty_view_claim');
  await f.view.resize({ cols: 50, rows: 22 });
  assert.equal(f.calls.at(-1).cmd, 'pty_view_renew');
  assert.equal(f.calls.at(-1).args.cols, 50);
  await f.view.release();
  assert.equal(f.calls.at(-1).cmd, 'pty_view_release');
  assert.equal(f.tasks.size, 0);
});

test('new owner stops heartbeat and stale views never overwrite newer ones', async () => {
  const f = fixture(); await f.view.claim({ cols: 45, rows: 30 });
  f.view.receive({ id: 7, owner: 'local', leaseId: 2, revision: 10, cols: 120, rows: 32 });
  f.view.receive({ id: 7, owner: 'remote', leaseId: 1, revision: 4, cols: 45, rows: 30 });
  assert.equal(f.view.owned, false); assert.equal(f.tasks.size, 0);
  assert.equal(f.applied.at(-1).cols, 120);
  await f.view.resize({ cols: 42, rows: 32 });
  assert.equal(f.calls.length, 1);
});

test('leaving while a claim is pending releases the late grant', async () => {
  let resolve; const calls = [];
  const view = new TerminalViewport({ id: 7, apply() {}, changed() {},
    invoke: (cmd, args) => { calls.push({cmd,args}); return cmd === 'pty_view_claim' ? new Promise(done => { resolve = done; }) : Promise.resolve(); } });
  const pending = view.claim({ cols: 45, rows: 30 });
  await view.release();
  resolve({ id: 7, owner: 'remote', leaseId: 1, revision: 1, cols: 45, rows: 30 });
  await pending;
  assert.equal(view.owned, false);
  assert.equal(calls.at(-1).cmd, 'pty_view_release');
});

test('late claim response cannot steal a newer owner event', async () => {
  let resolve;
  const view = new TerminalViewport({ id: 7, apply() {}, changed() {}, invoke: () => new Promise(done => { resolve = done; }) });
  const pending = view.claim({ cols: 45, rows: 30 });
  view.receive({ id: 7, owner: 'local', leaseId: 2, revision: 2, cols: 120, rows: 32 });
  resolve({ id: 7, owner: 'remote', leaseId: 1, revision: 1, cols: 45, rows: 30 });
  await pending; assert.equal(view.owned, false);
});

test('invalidating a reused PTY never releases an old pending grant to the replacement process', async () => {
  let resolve; const calls = []; const applied = [];
  const view = new TerminalViewport({ id: 7, apply: value => applied.push(value), changed() {},
    invoke: (cmd, args) => { calls.push({cmd,args}); return new Promise(done => { resolve = done; }); } });
  const pending = view.claim({ cols: 45, rows: 30 });
  view.invalidate();
  resolve({ id: 7, owner: 'remote', leaseId: 1, revision: 51, cols: 45, rows: 30 });
  await pending;
  assert.equal(view.owned, false);
  assert.equal(applied.length, 0);
  assert.deepEqual(calls.map(call => call.cmd), ['pty_view_claim']);
});

test('invalidating an owned view cancels heartbeat without sending release', async () => {
  const f = fixture(); await f.view.claim({ cols: 45, rows: 30 });
  f.view.invalidate();
  await f.view.release();
  f.view.receive({ id: 7, owner: 'remote', leaseId: 1, revision: 99, cols: 90, rows: 30 });
  assert.equal(f.view.latest, null);
  assert.equal(f.view.owned, false);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.calls.length, 1);
});
