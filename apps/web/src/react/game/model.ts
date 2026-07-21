import {
  Engine as E,
  type BaseTier,
  type Card,
  type Color,
  type GameState,
  type Player,
  type PokemartTier,
  type Tier,
  type TokenColor,
} from '@pokemon-splendor/game-core';

export type GameUiPhase = 'main' | 'discard' | 'evolve';
export type ReservableTier = BaseTier | PokemartTier;

export interface GameSelection {
  readonly pickedBalls: readonly Color[];
  readonly selectedCardId: string | null;
  readonly selectedDeck: ReservableTier | null;
}

export interface AffordInfo {
  readonly master: number;
  readonly pokedex?: number;
}

export interface PaymentTokenRow {
  readonly color: TokenColor;
  readonly required: number;
  readonly due: number;
  readonly after: number;
  readonly paidWild: number;
}

export const BALL_NAMES: Readonly<Record<TokenColor, string>> = {
  red: '精灵球',
  blue: '超级球',
  black: '高级球',
  pink: '治愈球',
  yellow: '先机球',
  purple: '大师球',
};

export const TIER_NAMES: Readonly<Record<Tier, string>> = {
  legend: '传说',
  rare: '稀有',
  stage3: '三阶',
  stage2: '二阶',
  stage1: '一阶',
  mega: 'Mega',
  pmL1: '商店Ⅰ',
  pmL2: '商店Ⅱ',
  pmL3: '商店Ⅲ',
};

const SEAT_COLORS = ['#e3350d', '#2f6fd6', '#46d17a', '#f4c025'];
const SEAT_AVATARS = ['ash', 'misty', 'brock', 'rocket'];
const HIDDEN_RESERVE_PREFIX = '__hidden_reserve__:';

export function seatAvatar(index: number): string {
  const avatar = SEAT_AVATARS[index % SEAT_AVATARS.length] ?? 'ash';
  return `assets/avatars/${avatar}.png`;
}

export function seatColor(index: number): string {
  return SEAT_COLORS[index % SEAT_COLORS.length] ?? '#e3350d';
}

export function isNormalTier(tier: ReservableTier): boolean {
  return E.NORMAL_TIERS.some((candidate) => candidate === tier);
}

export function isPokemartTier(tier: string): tier is PokemartTier {
  return E.PM_TIERS.some((candidate) => candidate === tier);
}

export function isReservableTier(value: string): value is ReservableTier {
  return E.FIELD_TIERS.some((tier) => tier === value) || isPokemartTier(value);
}

export function hiddenReserveTier(id: string): Tier | null {
  if (!id.startsWith(HIDDEN_RESERVE_PREFIX)) return null;
  const tier = id.slice(HIDDEN_RESERVE_PREFIX.length).split(':')[0];
  if (!tier) return null;
  if (
    tier === 'legend' ||
    tier === 'rare' ||
    tier === 'stage3' ||
    tier === 'stage2' ||
    tier === 'stage1' ||
    tier === 'mega' ||
    isPokemartTier(tier)
  ) {
    return tier;
  }
  return null;
}

export function cardFrom(state: GameState, id: string): Card {
  const card = state.byId[id];
  if (!card) throw new Error(`卡牌不存在：${id}`);
  return card;
}

export function playerFrom(state: GameState, index: number): Player {
  const player = state.players[index];
  if (!player) throw new Error(`训练家席位不存在：${index}`);
  return player;
}

export function ownSeat(state: GameState, onlineSeat: number | null): number {
  return onlineSeat !== null && onlineSeat >= 0 ? onlineSeat : state.turn;
}

export function ownPlayer(state: GameState, onlineSeat: number | null): Player {
  return playerFrom(state, ownSeat(state, onlineSeat));
}

export function isInteractiveTurn(
  state: GameState,
  onlineSeat: number | null,
  isOnline: boolean,
): boolean {
  if (state.phase !== 'play') return false;
  if (isOnline) return onlineSeat === state.turn;
  return !playerFrom(state, state.turn).isAI;
}

export function canAddBall(state: GameState, pickedBalls: readonly Color[], color: Color): boolean {
  if (state.supply[color] <= 0) return false;
  const counts: Partial<Record<Color, number>> = {};
  for (const picked of pickedBalls) counts[picked] = (counts[picked] ?? 0) + 1;
  const distinct = E.COLORS.filter((candidate) => (counts[candidate] ?? 0) > 0);
  if (pickedBalls.length === 0) return true;
  const first = distinct[0];
  if (!first) return false;
  if (distinct.length === 1 && counts[first] === 2) return false;
  if (distinct.length === 1 && counts[first] === 1) {
    if (color === first) return state.supply[color] >= 4;
    return pickedBalls.length < 3 && state.supply[color] > 0;
  }
  return pickedBalls.length < 3 && !counts[color] && state.supply[color] > 0;
}

export function takeSelectionComplete(state: GameState, pickedBalls: readonly Color[]): boolean {
  if (pickedBalls.length === 0) return false;
  const distinct = new Set(pickedBalls);
  const first = pickedBalls[0];
  if (first && pickedBalls.length === 2 && distinct.size === 1) return state.supply[first] >= 4;
  const available = E.COLORS.filter((color) => state.supply[color] > 0).length;
  return distinct.size === pickedBalls.length && pickedBalls.length === Math.min(3, available);
}

export function affordInfo(state: GameState, player: Player, card: Card): AffordInfo | null {
  if (E.isPokemart(card) && card.effect === 'discard_buy') {
    const color = card.effectParam?.discardColor;
    const needed = card.effectParam?.discardCount;
    if (!color || needed === undefined) return null;
    const owned = player.board.filter((id) => E.effBonusColor(state, player, id) === color).length;
    return owned >= needed ? { master: 0 } : null;
  }
  if (E.isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')) {
    if (!player.board.some((id) => E.effBonusColor(state, player, id))) return null;
  }
  const payment = E.computePayment(state, player, card);
  if (payment.ok) return { master: payment.pay.purple };

  const pokedex = player.board.filter(
    (id) => E.isPokemart(cardFrom(state, id)) && cardFrom(state, id).effect === 'colorless_master',
  ).length;
  for (let count = 1; count <= pokedex; count += 1) {
    const virtualPayment = E.computePayment(state, player, card, count * 2);
    if (virtualPayment.ok) return { master: virtualPayment.pay.purple, pokedex: count };
  }
  return null;
}

export function captureBlockedReason(state: GameState, player: Player, card: Card): string {
  if (E.isPokemart(card) && card.effect === 'discard_buy') {
    const color = card.effectParam?.discardColor;
    const needed = card.effectParam?.discardCount;
    if (!color || needed === undefined) return '这张卡的弃牌条件无效';
    const owned = player.board.filter((id) => E.effBonusColor(state, player, id) === color).length;
    return `需要弃掉 ${needed} 张${BALL_NAMES[color]}奖励卡，当前只有 ${owned} 张`;
  }
  if (
    E.isPokemart(card) &&
    (card.effect === 'copy' || card.effect === 'copy_free') &&
    !player.board.some((id) => E.effBonusColor(state, player, id))
  ) {
    return '需要先捕捉至少一只带奖励颜色的宝可梦';
  }
  const bonuses = E.bonuses(state, player);
  const deficits = E.COLORS.map((color) => ({
    color,
    count: Math.max(0, card.cost[color] - bonuses[color] - player.tokens[color]),
  })).filter((item) => item.count > 0);
  const mandatory = card.cost.purple;
  const pokedex = player.board.filter(
    (id) => E.isPokemart(cardFrom(state, id)) && cardFrom(state, id).effect === 'colorless_master',
  ).length;
  const availableMaster = player.tokens.purple + pokedex * 2;
  const masterNeed = mandatory + deficits.reduce((total, item) => total + item.count, 0);
  if (mandatory > availableMaster) {
    return `需要 ${mandatory} 个大师球，当前可用 ${availableMaster} 个`;
  }
  if (masterNeed > availableMaster) {
    const missing = deficits.map((item) => `${item.count} 个${BALL_NAMES[item.color]}`).join('、');
    return `缺少 ${missing}，大师球也不足以替代`;
  }
  return '当前不满足这张卡的捕捉条件';
}

export function reserveBlockedReason(state: GameState, player: Player, cardId: string): string {
  const location = E.locateCard(state, cardId);
  if (location.where === 'reserve') return '这只宝可梦已经在预留区';
  if (
    location.where !== 'field' ||
    !(isNormalTier(location.tier) || isPokemartTier(location.tier))
  ) {
    return `${TIER_NAMES[cardFrom(state, cardId).tier]}宝可梦不能预留`;
  }
  if (player.reserve.length >= E.HAND_MAX) return `预留区已满（最多 ${E.HAND_MAX} 张）`;
  return '当前不能预留这只宝可梦';
}

export function paymentRows(
  state: GameState,
  player: Player,
  card: Card,
  info: AffordInfo | null,
): readonly PaymentTokenRow[] {
  if (E.isPokemart(card) && card.effect === 'discard_buy') return [];
  const bonuses = E.bonuses(state, player);
  let virtualMasterLeft = (info?.pokedex ?? 0) * 2;
  let realMasterLeft = player.tokens.purple;
  let realMasterSpent = 0;
  const rows: PaymentTokenRow[] = [];
  const spendMaster = (
    amount: number,
  ): { readonly realUsed: number; readonly uncovered: number } => {
    const virtualUsed = Math.min(amount, virtualMasterLeft);
    virtualMasterLeft -= virtualUsed;
    const afterVirtual = amount - virtualUsed;
    const realUsed = Math.min(afterVirtual, realMasterLeft);
    realMasterLeft -= realUsed;
    realMasterSpent += realUsed;
    return { realUsed, uncovered: afterVirtual - realUsed };
  };
  const mandatory = card.cost.purple;
  const mandatoryCover = spendMaster(mandatory);
  for (const color of E.COLORS) {
    const required = card.cost[color];
    if (required === 0) continue;
    const due = Math.max(0, required - bonuses[color]);
    const paidColor = Math.min(due, player.tokens[color]);
    const covered = spendMaster(due - paidColor);
    rows.push({
      color,
      required,
      due,
      after: player.tokens[color] - paidColor - covered.uncovered,
      paidWild: covered.realUsed,
    });
  }
  if (mandatory > 0) {
    rows.push({
      color: 'purple',
      required: mandatory,
      due: mandatory,
      after: player.tokens.purple - realMasterSpent - mandatoryCover.uncovered,
      paidWild: mandatoryCover.realUsed,
    });
  }
  return rows;
}

export function dedupeEvolutionOptions(
  state: GameState,
  options: ReturnType<typeof E.evolutionOptions>,
): ReturnType<typeof E.evolutionOptions> {
  const best = new Map<string, (typeof options)[number]>();
  for (const option of options) {
    const current = best.get(option.fromId);
    if (!current || cardFrom(state, option.toId).vp > cardFrom(state, current.toId).vp) {
      best.set(option.fromId, option);
    }
  }
  return [...best.values()];
}

export function turnStatus(
  state: GameState,
  player: Player,
  seat: number,
  ownPlayerSeat: number | null,
  isOnline: boolean,
  phase: GameUiPhase,
  selection: GameSelection,
  busy: boolean,
): string | null {
  if (seat !== state.turn || state.phase !== 'play') return null;
  const mine = isOnline ? ownPlayerSeat === seat : !player.isAI;
  let status = '当前回合';
  if (player.isAI || busy) status = '思考中…';
  else if (!mine && isOnline) status = '正在行动';
  else if (phase === 'discard') status = '正在归还精灵球';
  else if (phase === 'evolve') status = '正在进化';
  else if (selection.pickedBalls.length > 0) status = '正在领取精灵球';
  else if (selection.selectedDeck) status = '正在预留牌堆';
  else if (selection.selectedCardId) status = '正在处理宝可梦';
  else if (state.acted) status = '正在结算回合';
  else if (mine) status = '你的回合';
  return state.lastRound ? `${status} · 最后一轮` : status;
}
