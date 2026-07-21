import { cards } from '@pokemon-splendor/game-data';
import { Engine as E } from '@pokemon-splendor/game-core';
import { describe, expect, it } from 'vitest';
import { chooseAiTurn } from '../src/react/game/ai.js';

describe('web AI turn adapter', () => {
  it('falls back to a legal heuristic turn when no browser worker is available', async () => {
    const game = E.createGame(cards, { numPlayers: 2, ai: [true, false] });
    const plan = await chooseAiTurn(game, 'easy');
    const result = E.applyAction(E.clone(game), plan.action ?? { type: 'pass' });

    expect(result.ok).toBe(true);
  });
});
