import {
  AI,
  VSearch,
  type GameState,
  type TurnPlan,
  type VSearchOptions,
} from '@pokemon-splendor/game-core';

export type AiDifficulty = 'easy' | 'normal' | 'hard' | 'ultra';

interface AiWorkerResponse {
  readonly id: number;
  readonly plan?: TurnPlan;
  readonly error?: string;
}

interface PendingAiJob {
  readonly resolve: (plan: TurnPlan) => void;
  readonly state: GameState;
  readonly difficulty: AiDifficulty;
}

const ULTRA_OPTIONS: VSearchOptions = { timeMs: 900 };

let worker: Worker | null = null;
let workerAttempted = false;
let nextJobId = 0;
const jobs = new Map<number, PendingAiJob>();

function chooseFallback(state: GameState, difficulty: AiDifficulty): TurnPlan {
  if (difficulty === 'ultra') return VSearch.chooseTurn(state, ULTRA_OPTIONS);
  return AI.chooseTurn(state, { difficulty });
}

function failJobs(): void {
  for (const job of jobs.values()) job.resolve(chooseFallback(job.state, job.difficulty));
  jobs.clear();
}

function getWorker(): Worker | null {
  if (workerAttempted) return worker;
  workerAttempted = true;
  if (typeof Worker === 'undefined') return null;

  try {
    worker = new Worker(new URL('../../ai.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<AiWorkerResponse>): void => {
      const job = jobs.get(event.data.id);
      if (!job) return;
      jobs.delete(event.data.id);
      job.resolve(event.data.plan ?? chooseFallback(job.state, job.difficulty));
    };
    worker.onerror = (): void => {
      worker?.terminate();
      worker = null;
      failJobs();
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function chooseAiTurn(state: GameState, difficulty: AiDifficulty): Promise<TurnPlan> {
  const aiWorker = getWorker();
  if (!aiWorker) return Promise.resolve(chooseFallback(state, difficulty));

  const {
    cardDB: _cardDB,
    byId: _byId,
    megaDB: _megaDB,
    pokemartDB: _pokemartDB,
    ...dynamic
  } = state;
  const id = ++nextJobId;
  return new Promise<TurnPlan>((resolve) => {
    jobs.set(id, { resolve, state, difficulty });
    try {
      aiWorker.postMessage({ id, kind: difficulty, g: dynamic, opts: ULTRA_OPTIONS });
    } catch {
      jobs.delete(id);
      resolve(chooseFallback(state, difficulty));
    }
  });
}
