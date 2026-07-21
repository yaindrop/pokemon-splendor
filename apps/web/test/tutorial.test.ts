import { cards, megas } from '@pokemon-splendor/game-data';
import { Engine as E } from '@pokemon-splendor/game-core';
import { describe, expect, it } from 'vitest';
import { createTutorialGame, snapshotTutorial, tutorialSteps } from '../src/react/game/tutorial.js';

const catalog = { cards, megaCards: megas };

describe('React tutorial scenarios', () => {
  it('builds the base lesson with its promised discounts and board', () => {
    const game = createTutorialGame('base', catalog);
    const player = game.players[0];
    if (!player) throw new Error('教程训练家缺失');

    expect(player.board).toEqual(expect.arrayContaining(['s1_14', 's1_20']));
    expect(game.field.stage1).toContain('s1_04');
    expect(game.field.stage2).toContain('s2_03');
    expect(snapshotTutorial(game).tokens).toBe(0);
  });

  it('arranges the final lesson so its selected card wins immediately', () => {
    const game = createTutorialGame('base', catalog);
    const finalStep = tutorialSteps('base').at(-1);
    if (!finalStep?.arrange) throw new Error('最终教程步骤缺少布置');
    finalStep.arrange(game);
    const player = game.players[0];
    if (!player) throw new Error('教程训练家缺失');

    const result = E.applyAction(game, { type: 'capture', cardId: 's3_11', opts: {} });
    expect(result.ok).toBe(true);
    const endTurn = E.applyAction(game, { type: 'endTurn' });
    expect(endTurn.ok).toBe(true);
    expect(game.phase).toBe('gameover');
  });

  it('builds the Mega lesson with a Gengar and sufficient red balls', () => {
    const game = createTutorialGame('megas', catalog);
    const player = game.players[0];
    if (!player) throw new Error('教程训练家缺失');

    expect(game.megasEnabled).toBe(true);
    expect(player.board).toContain('s3_01');
    expect(player.tokens.red).toBe(3);
  });
});
