import { RequestGate } from './request-gate';

test('invalidates an old health result when the user leaves the offline screen', () => {
  const gate = new RequestGate();
  const oldRequest = gate.begin();
  gate.invalidate();
  expect(gate.isCurrent(oldRequest)).toBe(false);
});

test('only the most recent manual retry may change the screen', () => {
  const gate = new RequestGate();
  const first = gate.begin();
  const second = gate.begin();
  expect(gate.isCurrent(first)).toBe(false);
  expect(gate.isCurrent(second)).toBe(true);
});
