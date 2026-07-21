import {
  Engine as E,
  type BaseTier,
  type Card,
  type GameState,
  type Player,
  type TokenCounts,
} from '@pokemon-splendor/game-core';

export type TutorialMode = 'base' | 'megas';

export interface TutorialSnapshot {
  readonly board: number;
  readonly buried: number;
  readonly reserve: number;
  readonly tokens: number;
  readonly mega: number;
  readonly score: number;
}

export interface TutorialStep {
  readonly title: string;
  readonly copy: readonly string[];
  readonly next?: boolean;
  readonly target?: string;
  readonly hideEndTurn?: boolean;
  readonly arrange?: (game: GameState) => void;
  readonly complete?: (game: GameState, baseline: TutorialSnapshot) => boolean;
}

interface TutorialCatalog {
  readonly cards: readonly Card[];
  readonly megaCards: readonly Card[];
}

function tutorialPlayer(game: GameState): Player {
  const player = game.players[0];
  if (!player) throw new Error('教程缺少训练家');
  return player;
}

function tutorialCard(game: GameState, id: string): Card {
  const card = game.byId[id];
  if (!card) throw new Error(`教程卡牌不存在：${id}`);
  return card;
}

function purge(game: GameState, id: string): void {
  for (const tier of E.FIELD_TIERS) {
    game.decks[tier] = game.decks[tier].filter((cardId) => cardId !== id);
    const slots = game.field[tier];
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index] === id) slots[index] = null;
    }
  }
}

function placeField(game: GameState, tier: BaseTier, slot: number, id: string): void {
  purge(game, id);
  const slots = game.field[tier];
  if (slot < 0 || slot >= slots.length) throw new Error(`教程卡槽不存在：${tier}/${slot}`);
  slots[slot] = id;
}

function give(game: GameState, id: string): void {
  purge(game, id);
  tutorialPlayer(game).board.push(id);
}

function setTokens(game: GameState, tokens: Partial<TokenCounts>): void {
  const player = tutorialPlayer(game);
  player.tokens = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
  for (const color of E.ALL_TOKENS) player.tokens[color] = tokens[color] ?? 0;
}

export function snapshotTutorial(game: GameState): TutorialSnapshot {
  const player = tutorialPlayer(game);
  return {
    board: player.board.length,
    buried: player.buried.length,
    reserve: player.reserve.length,
    tokens: E.tokenTotal(player),
    mega: player.megaToken,
    score: E.scoreOf(game, player),
  };
}

export function createTutorialGame(mode: TutorialMode, catalog: TutorialCatalog): GameState {
  if (mode === 'megas') {
    const game = E.createGame(catalog.cards, {
      numPlayers: 1,
      names: ['你'],
      ai: [false],
      megas: true,
      megaDB: catalog.megaCards,
      winScore: 999,
    });
    give(game, 's3_01');
    setTokens(game, { red: 3 });
    return game;
  }

  const game = E.createGame(catalog.cards, {
    numPlayers: 1,
    names: ['你'],
    ai: [false],
    winScore: 999,
  });
  give(game, 's1_14');
  give(game, 's1_20');
  placeField(game, 'stage1', 0, 's1_07');
  placeField(game, 'stage1', 1, 's1_04');
  placeField(game, 'stage1', 2, 's1_21');
  placeField(game, 'stage1', 3, 's1_33');
  placeField(game, 'stage2', 0, 's2_03');
  E.refill(game, 'stage2');
  setTokens(game, {});
  return game;
}

const BASE_STEPS: readonly TutorialStep[] = [
  {
    title: '欢迎来到训练家学院 🎓',
    copy: [
      '核心循环很简单：领取精灵球 → 捕捉宝可梦得分 → 进化拿更高分。',
      '本练习先凑够约 8 分就算成功；正式对局的目标是 18 分。',
      '你已经捕捉了两只凯西，它们提供 2 个粉色折扣，马上会派上用场。',
    ],
    next: true,
  },
  {
    title: '① 领取精灵球（3 个不同色）',
    copy: [
      '每回合只能做一个主要行动。最常用的行动是领取 3 个不同颜色的精灵球。',
      '在高亮的供应区选择 3 个不同颜色，再确认领取。',
    ],
    target: '#supply',
    arrange: (game) => {
      for (const color of E.COLORS) game.supply[color] = 4;
      setTokens(game, {});
    },
    complete: (game, baseline) => E.tokenTotal(tutorialPlayer(game)) >= baseline.tokens + 3,
  },
  {
    title: '② 领取精灵球（2 个同色）',
    copy: [
      '另一种领法是领取 2 个相同颜色；前提是该颜色在供应区还剩至少 4 个。',
      '连续选择同一种颜色两次，再确认领取。',
    ],
    target: '#supply',
    arrange: (game) => {
      for (const color of E.COLORS) game.supply[color] = 4;
    },
    complete: (game, baseline) => E.tokenTotal(tutorialPlayer(game)) >= baseline.tokens + 2,
  },
  {
    title: '③ 捕捉宝可梦',
    copy: [
      '捕捉会花掉精灵球、把宝可梦收入囊中，并立刻得分。',
      '喇叭芽需要 2 红 + 2 粉；你的 2 个粉色折扣抵掉了粉色，因此只要 2 个红球。',
      '选择喇叭芽，再选择「捕捉」。',
    ],
    target: '[data-card="s1_04"]',
    arrange: (game) => {
      setTokens(game, { red: 2 });
      placeField(game, 'stage1', 1, 's1_04');
      E.refill(game, 'stage1');
    },
    complete: (game, baseline) => tutorialPlayer(game).board.length > baseline.board,
  },
  {
    title: '④ 进化',
    copy: [
      '捕捉后，回合结束时可进化一只宝可梦。进化只看折扣，不花手里的精灵球。',
      '喇叭芽能进化成口呆花，需要 2 个粉色折扣；你正好满足条件。',
    ],
    target: '.evo-option',
    hideEndTurn: true,
    complete: (game, baseline) => tutorialPlayer(game).buried.length > baseline.buried,
  },
  {
    title: '⑤ 预留宝可梦',
    copy: [
      '暂时无法捕捉的宝可梦可以预留到专属预留区，最多 3 张，其他训练家不能抢走。',
      '预留还会获得 1 个大师球；选择一个可预留的牌堆顶试试。',
    ],
    target: '.deck-pile.reservable',
    complete: (game, baseline) => tutorialPlayer(game).reserve.length > baseline.reserve,
  },
  {
    title: '⑥ 拿下胜利！🏆',
    copy: [
      '场上已经放好了喷火龙，并给你准备了刚好够用的精灵球。',
      '捕捉它就能达到本练习的目标，成为冠军训练家。',
    ],
    target: '[data-card="s3_11"]',
    arrange: (game) => {
      const player = tutorialPlayer(game);
      placeField(game, 'stage3', 0, 's3_11');
      const target = tutorialCard(game, 's3_11');
      const bonuses = E.bonuses(game, player);
      const tokens: TokenCounts = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
      for (const color of E.COLORS)
        tokens[color] = Math.max(0, target.cost[color] - bonuses[color]);
      player.tokens = tokens;
      game.winScore = E.scoreOf(game, player) + target.vp;
    },
    complete: (game) => game.phase === 'gameover',
  },
];

const MEGA_STEPS: readonly TutorialStep[] = [
  {
    title: '超级进化扩展 ⚡',
    copy: [
      '有些宝可梦能超级进化成更强的 Mega 形态，获得更高分数与折扣。',
      '你已经捕捉了耿鬼；接下来把它进化成超级耿鬼。',
    ],
    next: true,
  },
  {
    title: '① 获得 Mega 代币',
    copy: ['超级进化需要 1 个 Mega 代币；领取它会占用整个回合。', '选择供应区里的 Mega 代币。'],
    target: '[data-take-mega]',
    complete: (game, baseline) => tutorialPlayer(game).megaToken >= baseline.mega + 1,
  },
  {
    title: '② 超级进化！',
    copy: [
      '拿到 Mega 代币后，回合结算时可以超级进化。',
      '这里已经准备好 3 个红球；选择超级进化按钮完成练习。',
    ],
    target: '.evo-option.mega-evo',
    hideEndTurn: true,
    complete: (game) =>
      tutorialPlayer(game).board.some((id) => tutorialCard(game, id).tier === 'mega'),
  },
];

export function tutorialSteps(mode: TutorialMode): readonly TutorialStep[] {
  return mode === 'megas' ? MEGA_STEPS : BASE_STEPS;
}

export function tutorialCompletion(mode: TutorialMode): readonly string[] {
  return mode === 'megas'
    ? [
        '耿鬼已经超级进化成超级耿鬼。正式的 Mega 对局会要求 20 分、集齐 5 种颜色折扣并拥有至少 1 只 Mega。',
      ]
    : ['你已经体验了领取、捕捉、预留和进化。现在可以开始一局真正的对局，挑战电脑或朋友。'];
}
