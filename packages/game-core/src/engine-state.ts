import type { Payment } from './api.js';
import type {
  ActionResult,
  Card,
  Color,
  ColorCounts,
  GameLogEntry,
  GameState,
  Player,
  Tier,
  TokenColor,
  TokenCounts,
} from './types.js';
import {
  ALL_TOKENS,
  COLORS,
  cardById,
  deckAt,
  emptyColors,
  emptyTokens,
  fieldAt,
  fieldTiers,
  isColor,
  playerAt,
  type CardLocation,
  type FieldTier,
  type PaymentBreakdown,
} from './engine-support.js';

function activePlayer(s: GameState): Player {
  return playerAt(s, s.turn);
}

// A card's effective bonus colour for this player. Pokémart "copy" cards
// (EVOLVE STONE / RARE CANDY) take the colour of the card they were associated
// with at capture time (stored in player.assoc); cards with no real colour
// (e.g. POKÉDEX, or an unassociated copy card) contribute nothing.
function effBonusColor(s: GameState, player: Player, id: string): Color | null {
  const col = player.assoc[id] ?? cardById(s, id).bonus;
  return isColor(col) ? col : null;
}
function bonusOf(s: GameState, player: Player, color: Color): number {
  let n = 0;
  for (const id of player.board) {
    if (effBonusColor(s, player, id) === color) n += cardById(s, id).bonusCount || 1;
  }
  return n;
}
function bonuses(s: GameState, player: Player): ColorCounts {
  const b = emptyColors();
  for (const id of player.board) {
    const col = effBonusColor(s, player, id);
    if (col) b[col] += cardById(s, id).bonusCount || 1;
  }
  return b;
}
function tokenTotal(player: Player): number {
  return ALL_TOKENS.reduce((a, c) => a + player.tokens[c], 0);
}
function scoreOf(s: GameState, player: Player): number {
  let v = 0;
  for (const id of player.board) v += cardById(s, id).vp || 0;
  return v;
}
function locateCard(s: GameState, id: string): CardLocation {
  // returns {where:'field'|'deck'|'reserve'|null, tier, slot, owner}
  for (const tier of fieldTiers(s)) {
    const slot = fieldAt(s, tier).indexOf(id);
    if (slot >= 0) return { where: 'field', tier, slot };
  }
  for (const p of s.players) {
    const ri = p.reserve.indexOf(id);
    if (ri >= 0) return { where: 'reserve', owner: p.id, slot: ri };
  }
  return { where: null };
}
function refill(s: GameState, tier: FieldTier): void {
  const slots = fieldAt(s, tier);
  const deck = deckAt(s, tier);
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] == null && deck.length) slots[i] = deck.pop() ?? null;
  }
}
function log(s: GameState, msg: string, detail: Partial<GameLogEntry> = {}): void {
  s.log.push(Object.assign({ turn: s.turn, round: s.round, msg }, detail || {}));
  if (s.log.length > 200) s.log.splice(0, s.log.length - 200); // bound growth (persisted + broadcast online)
}

// ----------------------- payment computation -----------------------
// Compute how to pay for a card given current bonuses & tokens.
// Returns {ok, pay:{tokens spent}, error}. `pay` includes purple (master).
function computePayment(
  s: GameState,
  player: Player,
  card: Card,
  extraMaster = 0,
): ActionResult<Payment> {
  const b = bonuses(s, player);
  const pay = emptyTokens();
  const purpleBudget = player.tokens.purple + extraMaster;
  let masterNeeded = card.cost.purple || 0; // mandatory master (rare/legend)
  if (masterNeeded > purpleBudget) return { ok: false, error: '大师球不足' };
  for (const c of COLORS) {
    const need = Math.max(0, (card.cost[c] || 0) - b[c]);
    const useGem = Math.min(need, player.tokens[c]);
    pay[c] = useGem;
    masterNeeded += need - useGem;
  }
  if (masterNeeded > purpleBudget) return { ok: false, error: '精灵球不足（含大师球替代）' };
  // Spend the virtual (POKÉDEX) masters first; any leftover virtual is wasted.
  pay.purple = Math.max(0, masterNeeded - extraMaster);
  return { ok: true, pay, virtualMaster: masterNeeded - pay.purple };
}
function canAfford(s: GameState, player: Player, card: Card): boolean {
  return computePayment(s, player, card).ok;
}

// Per-colour breakdown of a purchase, purely for display. Mirrors
// computePayment's gold-minimising logic so the UI can show, for each colour:
//   required     = balls printed on the card cost
//   bonusCovered = covered for free by permanent bonuses (no token spent)
//   paidColor    = matching coloured tokens you hand back to the supply
//   paidWild     = covered by Master Balls (wildcard) because that colour ran short
// Plus the card's mandatory Master cost (rare/legend). Returns null if unaffordable.
function paymentBreakdown(
  s: GameState,
  player: Player,
  card: Card,
  extraMaster = 0,
): PaymentBreakdown | null {
  const cp = computePayment(s, player, card, extraMaster);
  if (!cp.ok) return null;
  const b = bonuses(s, player);
  const rows = [];
  for (const c of COLORS) {
    const required = card.cost[c] || 0;
    if (required === 0) continue;
    const bonusCovered = Math.min(required, b[c]);
    const remaining = required - bonusCovered;
    const paidColor = Math.min(remaining, player.tokens[c]);
    rows.push({ color: c, required, bonusCovered, paidColor, paidWild: remaining - paidColor });
  }
  const mandatoryMaster = card.cost.purple || 0; // purple pips printed on rare/legend
  return {
    rows,
    mandatoryMaster,
    master: cp.pay.purple, // real Master Balls spent from your stash
    virtualMaster: cp.virtualMaster || 0, // Master "balls worth" from discarded POKÉDEX
  };
}

function payTokens(s: GameState, player: Player, pay: TokenCounts): void {
  for (const c of ALL_TOKENS) {
    player.tokens[c] -= pay[c];
    s.supply[c] += pay[c];
  }
}

// --------------------------- actions -------------------------------
// Each action returns {ok:true} or {ok:false, error}. On success the
// main action is consumed (acted=true) and the turn auto-advances to the
// evolve/discard check unless more sub-steps are required.

// --------------------------- i18n bits -----------------------------
const BALL_ZH = {
  red: '精灵球',
  blue: '超级球',
  black: '高级球',
  pink: '治愈球',
  yellow: '先机球',
  purple: '大师球',
};
const TIER_ZH = {
  stage1: '一阶',
  stage2: '二阶',
  stage3: '三阶',
  rare: '稀有',
  legend: '传说',
  mega: 'Mega',
  pmL1: 'Pokémart一级',
  pmL2: 'Pokémart二级',
  pmL3: 'Pokémart三级',
};
function zhBall(c: TokenColor): string {
  return BALL_ZH[c];
}
function zhTier(t: Tier): string {
  return TIER_ZH[t];
}
function payDesc(pay: TokenCounts): string {
  const parts = ALL_TOKENS.filter((c) => pay[c] > 0).map((c) => `${pay[c]}${zhBall(c)}`);
  return parts.length ? parts.join('+') : '免费';
}

// ----- deep clone for AI search -----
function clone(s: GameState): GameState {
  const c = structuredClone(s);
  c.cardDB = s.cardDB;
  c.byId = s.byId;
  c.megaDB = s.megaDB;
  c.pokemartDB = s.pokemartDB;
  c.log = []; // share static refs, drop log
  return c;
}

export {
  activePlayer,
  bonusOf,
  bonuses,
  canAfford,
  clone,
  computePayment,
  effBonusColor,
  locateCard,
  log,
  payDesc,
  payTokens,
  paymentBreakdown,
  refill,
  scoreOf,
  tokenTotal,
  zhBall,
  zhTier,
};
