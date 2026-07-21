/* AI sanity & strength tests — node test/ai.test.js */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AI, Engine as E, type GameAction, type GameState } from '@pokemon-splendor/game-core';
import { cards as DB } from '../../game-data/src/index.js';

type PlayerKind = 'ai' | 'rand';

function requiredAction(action: GameAction | undefined): GameAction {
  if (!action) throw new Error('AI 测试未生成合法行动');
  return action;
}

function captureValue(
  g: GameState,
  action: Extract<GameAction, { readonly type: 'capture' }>,
): number {
  const card = g.byId[action.cardId];
  if (!card) throw new Error(`AI 测试引用未知卡牌：${action.cardId}`);
  return card.vp;
}

function randomTurn(g: GameState, rng: () => number): void {
  const acts = E.legalActions(g);
  if (!acts.length) g.acted = true;
  else {
    const caps = acts
      .filter((a) => a.type === 'capture')
      .sort((a, b) => captureValue(g, b) - captureValue(g, a));
    const pick = caps.length && rng() < 0.85 ? caps[0] : acts[Math.floor(rng() * acts.length)];
    E.applyAction(g, requiredAction(pick));
  }
  const p = E.activePlayer(g);
  while (E.needsDiscard(g, p)) {
    const c = E.ALL_TOKENS.find((x) => p.tokens[x] > 0);
    if (!c) throw new Error('需要归还精灵球但训练家没有筹码');
    E.actionDiscard(g, c);
  }
  const evos = E.evolutionOptions(g, p);
  const evolution = evos[0];
  if (evolution && rng() < 0.7) E.actionEvolve(g, evolution.fromId, evolution.toId);
  E.endTurn(g);
}

let turns = 0;
function playGame(seed: number, p0kind: PlayerKind, p1kind: PlayerKind): GameState {
  const g = E.createGame(DB, { numPlayers: 2, seed });
  const rng = E.makeRng(seed * 3 + 1);
  let plies = 0;
  while (g.phase !== 'gameover' && plies < 3000) {
    const kind = g.turn === 0 ? p0kind : p1kind;
    if (kind === 'ai') {
      AI.playTurn(g, { difficulty: 'hard' });
      turns++;
    } else randomTurn(g, rng);
    plies++;
  }
  return g;
}

test('AI terminates games, beats greedy play, and stays responsive', () => {
  const startedAt = Date.now();
  turns = 0;
  let maxPlies = 0;
  for (let i = 0; i < 20; i++) {
    const g = playGame(200 + i, 'ai', 'ai');
    assert.strictEqual(g.phase, 'gameover', 'AIvAI game ' + i + ' finished');
    const scores = g.players.map((p) => E.scoreOf(g, p));
    assert.ok(Math.max(...scores) >= E.WIN_SCORE);
    maxPlies = Math.max(maxPlies, g.round * 2);
  }
  assert.ok(maxPlies > 0);

  let aiWins = 0;
  const games = 40;
  for (let i = 0; i < games; i++) {
    const aiSeat = i % 2;
    const g = playGame(500 + i, aiSeat === 0 ? 'ai' : 'rand', aiSeat === 0 ? 'rand' : 'ai');
    if (g.winner === aiSeat) aiWins++;
  }
  const rate = aiWins / games;
  assert.ok(
    rate >= 0.8,
    'AI should beat greedy-random >=80% (got ' + (rate * 100).toFixed(0) + '%)',
  );

  const avgMs = (Date.now() - startedAt) / Math.max(turns, 1);
  assert.ok(avgMs < 250, 'AI turn should be < 250ms (got ' + avgMs.toFixed(0) + ')');

  const lengths: number[] = [];
  for (let i = 0; i < 10; i++) {
    lengths.push(playGame(900 + i, 'ai', 'ai').round);
  }
  const avgRounds = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  assert.ok(avgRounds >= 8 && avgRounds <= 60, 'game length sane');
});
