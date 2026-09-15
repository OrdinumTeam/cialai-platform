import {
  advancePairProgress,
  initialPairProgress,
  PAIR_DIRECT_BUDGET_MS,
  PAIR_LAN_BUDGET_MS,
  PAIR_STAGES,
  stageStatus,
  type PairProgress,
  type PairProgressAction
} from './pair-progress';

function run(...actions: PairProgressAction[]): PairProgress {
  return actions.reduce(advancePairProgress, initialPairProgress());
}

describe('pairing progress', () => {
  test('starts by reading the code and does not advance before confirmation', () => {
    expect(initialPairProgress()).toEqual({ stage: 'reading', tor: null });
    expect(run({ type: 'elapsed', ms: 10_000 }, { type: 'core-stage', state: 'tor' }).stage).toBe('reading');
  });

  test('follows the plan budgets when the core sends no stage', () => {
    expect(run({ type: 'start' }).stage).toBe('lan');
    expect(run({ type: 'start' }, { type: 'elapsed', ms: PAIR_LAN_BUDGET_MS - 1 }).stage).toBe('lan');
    expect(run({ type: 'start' }, { type: 'elapsed', ms: PAIR_LAN_BUDGET_MS }).stage).toBe('internet');
    expect(run({ type: 'start' }, { type: 'elapsed', ms: PAIR_DIRECT_BUDGET_MS }).stage).toBe('reserve');
  });

  test('core stages move forward and never back', () => {
    const reserve = run({ type: 'start' }, { type: 'core-stage', state: 'tor' });
    expect(reserve.stage).toBe('reserve');
    expect(advancePairProgress(reserve, { type: 'core-stage', state: 'lan' })).toBe(reserve);
    expect(advancePairProgress(reserve, { type: 'elapsed', ms: 0 })).toBe(reserve);
    expect(advancePairProgress(reserve, { type: 'core-stage', state: 'confirming' }).stage).toBe('confirming');
    expect(advancePairProgress(reserve, { type: 'core-stage', state: 'unknown' })).toBe(reserve);
    expect(run({ type: 'start' }, { type: 'core-stage', state: 'direct' }).stage).toBe('internet');
  });

  test('keeps the Tor progress across stages and resets on a new code', () => {
    const progress = run({ type: 'start' }, { type: 'tor', tor: { state: 'bootstrapping', progress: 40 } }, { type: 'elapsed', ms: 5_000 });
    expect(progress).toEqual({ stage: 'reserve', tor: { state: 'bootstrapping', progress: 40 } });
    expect(advancePairProgress(progress, { type: 'reading' })).toEqual(initialPairProgress());
  });

  test('marks earlier stages done and later ones pending', () => {
    const progress = run({ type: 'start' }, { type: 'elapsed', ms: PAIR_LAN_BUDGET_MS });
    expect(PAIR_STAGES.map(stage => stageStatus(progress, stage))).toEqual(['done', 'done', 'current', 'pending', 'pending']);
  });
});
