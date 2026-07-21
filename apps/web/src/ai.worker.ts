/// <reference lib="webworker" />

import { AI, VSearch, type GameState, type TurnPlan } from '@pokemon-splendor/game-core';
import {
  cards as CARD_DB,
  megas as MEGA_DB,
  pokemart as POKEMART_DB,
} from '@pokemon-splendor/game-data';

interface AiWorkerRequest {
  readonly id: number;
  readonly kind: string;
  readonly g: GameState;
  readonly opts?: Readonly<Record<string, number | boolean>>;
}

function isDifficulty(value: string): value is 'easy' | 'normal' | 'hard' {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

function reattach(dynamicState: GameState): GameState {
  const state = dynamicState;
  state.cardDB = CARD_DB;
  state.megaDB = MEGA_DB;
  state.pokemartDB = POKEMART_DB;
  state.byId = Object.fromEntries(
    [...CARD_DB, ...MEGA_DB, ...POKEMART_DB].map((card) => [card.id, card]),
  );
  if (!Array.isArray(state.log)) state.log = [];
  return state;
}

self.onmessage = (event: MessageEvent<AiWorkerRequest>): void => {
  const message = event.data;
  try {
    const state = reattach(message.g);
    let plan: TurnPlan;
    if (message.kind === 'ultra') {
      plan = VSearch.chooseTurn(state, message.opts);
    } else {
      const difficulty = isDifficulty(message.kind) ? message.kind : 'hard';
      plan = AI.chooseTurn(state, { difficulty });
    }
    self.postMessage({ id: message.id, plan });
  } catch (error) {
    self.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
