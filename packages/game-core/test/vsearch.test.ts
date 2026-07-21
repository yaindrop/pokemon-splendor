import assert from 'node:assert/strict';
import { Engine, VSearch } from '@pokemon-splendor/game-core';
import { cards } from '../../game-data/src/index.js';
import { test } from 'vitest';

test('VSearch returns a legal, executable turn plan', () => {
  const game = Engine.createGame(cards, { numPlayers: 2, seed: 2026 });
  const plan = VSearch.chooseTurn(game, { sims: 12, endgame: false });
  assert.notEqual(plan.action, null);
  assert.equal(Engine.validActionShape(plan.action), true);

  const result = plan.action === null ? { ok: false } : Engine.applyAction(game, plan.action);
  assert.equal(result.ok, true);
});
