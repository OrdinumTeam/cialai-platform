import type { TorProgress } from 'cialai-tunnel';

export const PAIR_STAGES = ['reading', 'lan', 'internet', 'reserve', 'confirming'] as const;
export type PairStage = typeof PAIR_STAGES[number];

// Orçamentos do plano: rede local em 1,5 s e candidatos diretos em 3 s antes do onion.
// Sem evento do núcleo, a etapa exibida avança por esses prazos.
export const PAIR_LAN_BUDGET_MS = 1_500;
export const PAIR_DIRECT_BUDGET_MS = 3_000;

export type PairProgress = { stage: PairStage; tor: TorProgress | null };

export type PairProgressAction =
  | { type: 'reading' }
  | { type: 'start' }
  | { type: 'elapsed'; ms: number }
  | { type: 'core-stage'; state: string }
  | { type: 'tor'; tor: TorProgress };

// Estados do evento `pair` que indicam a etapa em curso do lado do núcleo.
const CORE_STAGES: Readonly<Record<string, PairStage>> = {
  lan: 'lan',
  direct: 'internet',
  tor: 'reserve',
  confirming: 'confirming'
};

export const initialPairProgress = (): PairProgress => ({ stage: 'reading', tor: null });

function later(current: PairStage, next: PairStage): PairStage {
  return PAIR_STAGES.indexOf(next) > PAIR_STAGES.indexOf(current) ? next : current;
}

export function advancePairProgress(progress: PairProgress, action: PairProgressAction): PairProgress {
  switch (action.type) {
    case 'reading': return initialPairProgress();
    case 'start': return { stage: 'lan', tor: progress.tor };
    case 'elapsed': {
      if (progress.stage === 'reading') return progress;
      const timed: PairStage = action.ms >= PAIR_DIRECT_BUDGET_MS ? 'reserve'
        : action.ms >= PAIR_LAN_BUDGET_MS ? 'internet' : 'lan';
      const stage = later(progress.stage, timed);
      return stage === progress.stage ? progress : { ...progress, stage };
    }
    case 'core-stage': {
      const next = CORE_STAGES[action.state];
      if (!next || progress.stage === 'reading') return progress;
      const stage = later(progress.stage, next);
      return stage === progress.stage ? progress : { ...progress, stage };
    }
    case 'tor': return { ...progress, tor: action.tor };
  }
}

export type StageStatus = 'done' | 'current' | 'pending';

export function stageStatus(progress: PairProgress, stage: PairStage): StageStatus {
  const current = PAIR_STAGES.indexOf(progress.stage);
  const index = PAIR_STAGES.indexOf(stage);
  return index < current ? 'done' : index === current ? 'current' : 'pending';
}
