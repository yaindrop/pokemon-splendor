import type { EngineApi, Payment } from './api.js';
import type {
  ActionResult,
  BaseTier,
  CaptureOptions,
  Card,
  CardEffect,
  CardEffectParam,
  Color,
  ColorCounts,
  CreateGameOptions,
  GameAction,
  GameLogEntry,
  GameState,
  Player,
  PokemartTier,
  RedactedGameState,
  Tier,
  TokenColor,
  TokenCounts,
  Supply,
} from './types.js';

type FieldTier = BaseTier | PokemartTier;
type CardLocation = ReturnType<EngineApi['locateCard']>;
type PaymentBreakdown = NonNullable<ReturnType<EngineApi['paymentBreakdown']>>;
type EvolutionOption = {
  readonly fromId: string;
  readonly toId: string;
  readonly color: Color;
  readonly count: number;
  readonly targetWhere: 'field' | 'reserve';
};
type FreeStep = { readonly freeId: string; readonly assoc: Color | null };
type FreePlan = ActionResult<{ readonly steps: FreeStep[] }>;
type ReserveTarget = Parameters<EngineApi['actionReserve']>[1];
type MegaEvolutionOption = ReturnType<EngineApi['megaEvolveOptions']>[number];
type TurnState = ReturnType<EngineApi['turnState']>;

/* =====================================================================
 * 璀璨宝石：宝可梦  —  Pokémon Splendor  game engine (pure logic, no DOM)
 * ---------------------------------------------------------------------
 * Faithful to the TTS mod "璀璨宝石：宝可梦（自动脚本）" + the rulebook:
 *   - 6 ball types: red(精灵球) blue(超级球) black(高级球) pink(治愈球)
 *     yellow(先机球) + purple(大师球, wild).  [internal color codes]
 *   - 3 normal stages + Rare + Legendary. Rare/Legendary need Master Balls
 *     and grant 2 bonus balls each.
 *   - Actions: take balls / reserve+master / capture.
 *   - Evolution at end of turn (not an action): paid ONLY by the discount
 *     balls on your captured cards (bonuses) — never by held tokens; you must
 *     already own enough discounts of the required color. The old card goes
 *     "under the tile" (no longer scores or grants a bonus).
 *   - 18 VP triggers the final round; tiebreak = most cards under tile,
 *     then most Pokémon in play.
 *
 * The engine is an environment-independent ESM module shared by the browser,
 * authoritative server and tests.
 * ===================================================================== */

const COLORS: readonly Color[] = ['red', 'blue', 'black', 'pink', 'yellow']; // the 5 normal ball types
const MASTER: 'purple' = 'purple'; // wild ball
const ALL_TOKENS: readonly TokenColor[] = [...COLORS, MASTER];
const NORMAL_TIERS: readonly BaseTier[] = ['stage1', 'stage2', 'stage3'];
const FIELD_TIERS: readonly BaseTier[] = ['stage1', 'stage2', 'stage3', 'rare', 'legend'];
const FIELD_SLOTS: Readonly<Record<BaseTier, number>> = {
  stage1: 4,
  stage2: 4,
  stage3: 4,
  rare: 1,
  legend: 1,
};
const SPECIAL_TIERS: readonly Extract<BaseTier, 'rare' | 'legend'>[] = ['rare', 'legend'];
// --- Pokémart expansion (opt-in via opts.pokemart + opts.pokemartDB) ---
// 3 extra decks (one per base level); each shows 2 face-up cards to the right
// of its level row. Cards capture/reserve like base cards (special effects are
// resolved separately). Empty/absent when the expansion is off.
const PM_TIERS: readonly PokemartTier[] = ['pmL1', 'pmL2', 'pmL3'];
const PM_SLOTS = 2;
// Pokémart effects whose engine logic is live. Capturing a Pokémart card whose
// effect is not yet implemented is rejected (so gameplay never silently misfires).
// double  : POTION — 2 bonuses (bonusCount already drives bonuses()).
// copy    : EVOLVE STONE — on capture, associate with an owned card's bonus.
// colorless_master : POKÉDEX — no bonus; later discardable as 2 virtual master balls.
// discard_buy : REPEL — no token cost; discard 2 owned cards of a color instead.
// free    : TM — on capture, immediately take a free face-up Level-2 card.
// copy_free : RARE CANDY — associate (like copy) + take a free Level-1 card.
const PM_EFFECTS_LIVE: Readonly<Record<CardEffect, true>> = {
  double: true,
  copy: true,
  colorless_master: true,
  discard_buy: true,
  free: true,
  copy_free: true,
};
// Canonical color-balanced sets (one bonus colour each), matching the classic
// 神兽/稀有 used in the strategy guides. Every game has exactly one rare & one
// legend per colour (red/black/yellow/blue/pink), each granting 2 same-colour bonuses.
const CANON_SPECIAL: Readonly<Record<'rare' | 'legend', readonly string[]>> = {
  rare: ['rr_06', 'rr_07', 'rr_08', 'rr_09', 'rr_10'], // 拉普拉斯红/伊布黑/卡比兽粉/百变怪蓝/化石翼龙黄
  legend: ['lg_06', 'lg_07', 'lg_08', 'lg_09', 'lg_10'], // 火焰鸟粉/超梦黑/梦幻蓝/急冻鸟黄/闪电鸟红
};
const HAND_MAX = 3;
const TOKEN_MAX = 10;
const WIN_SCORE = 18;
// --- Megas expansion (opt-in via opts.megas + opts.megaDB) ---
const MEGA_TOKENS = 4; // shared pool of "Mega" tokens
const MEGA_WIN_SCORE = 20; // with Megas: need 20 VP + 1 of each color + 1 Mega

// ----- seedable RNG (mulberry32) so shuffles are reproducible -----
function makeRng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const left = arr[i],
      right = arr[j];
    if (left === undefined || right === undefined) continue;
    arr[i] = right;
    arr[j] = left;
  }
  return arr;
}

const emptyTokens = (): TokenCounts => ({
  red: 0,
  blue: 0,
  black: 0,
  pink: 0,
  yellow: 0,
  purple: 0,
});
const emptyColors = (): ColorCounts => ({ red: 0, blue: 0, black: 0, pink: 0, yellow: 0 });

function supplyFor(numPlayers: number): Supply {
  const each = numPlayers <= 2 ? 4 : numPlayers === 3 ? 5 : 7;
  const s: Supply = emptyTokens();
  for (const c of COLORS) s[c] = each;
  s.purple = 5; // Master Balls always 5
  return s;
}

// -------------------------------------------------------------------
// Card DB: array of card objects. Engine indexes them by id.
//   { id, tier, name, vp, bonus, bonusCount, cost{6}, evolvesTo, evoCost }
// -------------------------------------------------------------------
function buildIndex(cardDB: readonly Card[]): Record<string, Card> {
  const byId: Record<string, Card> = {};
  for (const c of cardDB) byId[c.id] = c;
  return byId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBaseTier(tier: FieldTier): tier is BaseTier {
  return (
    tier === 'stage1' ||
    tier === 'stage2' ||
    tier === 'stage3' ||
    tier === 'rare' ||
    tier === 'legend'
  );
}

function isPokemartTier(tier: Tier): tier is PokemartTier {
  return tier === 'pmL1' || tier === 'pmL2' || tier === 'pmL3';
}

function effectParamOf(card: Card): CardEffectParam {
  const value = card.effectParam;
  if (!value) return {};
  return value;
}

function isColor(value: unknown): value is Color {
  return (
    value === 'red' ||
    value === 'blue' ||
    value === 'black' ||
    value === 'pink' ||
    value === 'yellow'
  );
}

function isTokenColor(value: unknown): value is TokenColor {
  return isColor(value) || value === MASTER;
}

function isFieldTier(value: unknown): value is FieldTier {
  return (
    value === 'stage1' ||
    value === 'stage2' ||
    value === 'stage3' ||
    value === 'rare' ||
    value === 'legend' ||
    value === 'pmL1' ||
    value === 'pmL2' ||
    value === 'pmL3'
  );
}

function isReservableTier(
  state: GameState,
  tier: FieldTier,
): tier is Extract<FieldTier, 'stage1' | 'stage2' | 'stage3' | PokemartTier> {
  return (
    tier === 'stage1' ||
    tier === 'stage2' ||
    tier === 'stage3' ||
    (state.pokemartEnabled && isPokemartTier(tier))
  );
}

function cardById(state: GameState, id: string): Card {
  const card = state.byId[id];
  if (!card) throw new Error(`未知卡牌：${id}`);
  return card;
}

function playerAt(state: GameState, index: number): Player {
  const player = state.players[index];
  if (!player) throw new Error(`未知训练家席位：${index}`);
  return player;
}

function deckAt(state: GameState, tier: FieldTier): (string | null)[] {
  const deck = state.decks[tier];
  if (!deck) throw new Error(`未启用牌堆：${tier}`);
  return deck;
}

function fieldAt(state: GameState, tier: FieldTier): (string | null)[] {
  const cards = state.field[tier];
  if (!cards) throw new Error(`未启用场地区域：${tier}`);
  return cards;
}

// Field tiers actually in play for this state (base tiers + Pokémart when on).
function fieldTiers(s: GameState): readonly FieldTier[] {
  return s.pokemartEnabled ? [...FIELD_TIERS, ...PM_TIERS] : FIELD_TIERS;
}
function slotCount(tier: FieldTier): number {
  return isBaseTier(tier) ? FIELD_SLOTS[tier] : PM_SLOTS;
}
function isPokemart(card: Card | null | undefined): boolean {
  return !!card && isPokemartTier(card.tier);
}

// ---------------------------- setup --------------------------------
function createGame(cardDB: readonly Card[], opts: CreateGameOptions = {}): GameState {
  const numPlayers = opts.numPlayers ?? 2;
  const seed = opts.seed != null ? opts.seed : Math.floor(Math.random() * 2 ** 31);
  const winScore = opts.winScore != null ? opts.winScore : WIN_SCORE; // tutorial may lower this
  const rng = makeRng(seed);
  const byId = buildIndex(cardDB);

  // Optional Megas expansion: index mega cards; they form a face-up "mega offer".
  const megaDB = opts.megaDB ?? [];
  const megasEnabled = opts.megas === true && megaDB.length > 0;
  if (megasEnabled) for (const c of megaDB) byId[c.id] = c;

  // Optional Pokémart expansion: index its cards; they get their own per-level decks.
  const pokemartDB = opts.pokemartDB ?? [];
  const pokemartEnabled = opts.pokemart === true && pokemartDB.length > 0;
  if (pokemartEnabled) for (const c of pokemartDB) byId[c.id] = c;

  // decks per tier (ids), shuffled
  const decks: GameState['decks'] = { stage1: [], stage2: [], stage3: [], rare: [], legend: [] };
  for (const tier of FIELD_TIERS) {
    decks[tier] = shuffle(
      cardDB.filter((c) => c.tier === tier).map((c) => c.id),
      rng,
    );
  }
  if (pokemartEnabled) {
    for (const tier of PM_TIERS) {
      decks[tier] = shuffle(
        pokemartDB.filter((c) => c.tier === tier).map((c) => c.id),
        rng,
      );
    }
  }
  // 神兽/幻兽: use the canonical colour-balanced 5 per tier (1 revealed + 4 in deck),
  // keeping the shuffled order so which one is revealed first still varies.
  for (const tier of SPECIAL_TIERS) {
    const set = opts.specialSets?.[tier] ?? CANON_SPECIAL[tier];
    decks[tier] = decks[tier].filter((id): id is string => id !== null && set.includes(id));
  }
  const allFieldTiers: readonly FieldTier[] = pokemartEnabled
    ? [...FIELD_TIERS, ...PM_TIERS]
    : FIELD_TIERS;
  const field: GameState['field'] = { stage1: [], stage2: [], stage3: [], rare: [], legend: [] };
  for (const tier of allFieldTiers) {
    const tierField: (string | null)[] = [];
    field[tier] = tierField;
    const tierDeck = decks[tier];
    if (!tierDeck) throw new Error(`缺少牌堆：${tier}`);
    for (let i = 0; i < slotCount(tier); i++) {
      tierField.push(tierDeck.pop() ?? null);
    }
  }

  const players: Player[] = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({
      id: i,
      name: opts.names?.[i] ?? '训练家 ' + (i + 1),
      isAI: !!(opts.ai && opts.ai[i]),
      tokens: emptyTokens(),
      megaToken: 0, // Megas expansion: 0 or 1 held Mega token
      board: [], // captured card ids currently in play (provide bonus + vp)
      buried: [], // card ids under the tile (evolved away — no bonus/vp)
      reserve: [], // reserved card ids (in hand)
      assoc: {}, // Pokémart copy cards: cardId -> associated bonus colour
    });
  }

  const supply = supplyFor(numPlayers);
  if (megasEnabled) supply.megaToken = MEGA_TOKENS;

  return {
    seed,
    winScore,
    cardDB,
    byId,
    numPlayers,
    supply,
    decks,
    field,
    players,
    // Megas expansion state (empty/false when the expansion is off)
    megasEnabled,
    megaDB: megasEnabled ? megaDB : [],
    megaOffer: megasEnabled ? megaDB.map((c) => c.id) : [], // the 10 unique megas, removed when taken
    // Pokémart expansion state (empty/false when off). Its face-up cards live in
    // field.pmL1/pmL2/pmL3 (2 each) and use the normal capture/reserve/refill path.
    pokemartEnabled,
    pokemartDB: pokemartEnabled ? pokemartDB : [],
    turn: 0, // index of active player
    round: 1,
    phase: 'play', // 'play' | 'discard' | 'evolve' | 'gameover'
    lastRound: false, // someone hit the win trigger
    finalTurnOf: null, // when lastRound, the player index that ends the game
    winner: null,
    log: [],
    // per-turn scratch
    acted: false, // main action used this turn
    taken: [], // colors taken this turn (for take-action validation)
    evolvedThisTurn: false, // at most one (mega-)evolution per turn
  };
}

// --------------------------- helpers -------------------------------
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

function actionTake(s: GameState, colors: readonly Color[]): ReturnType<EngineApi['actionTake']> {
  const p = activePlayer(s);
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (colors.length === 0) return { ok: false, error: '未选择精灵球' };
  if (colors.length > 6) return { ok: false, error: '非法的领取' }; // bound input before allocating a Set
  for (const c of colors) {
    if (!COLORS.includes(c)) return { ok: false, error: '不能领取大师球' };
  }
  const uniq = new Set(colors);
  let mode;
  if (colors.length === 2 && uniq.size === 1) {
    mode = 'double';
    const c = colors[0];
    if (!c) return { ok: false, error: '未选择精灵球' };
    if (s.supply[c] < 4) return { ok: false, error: '该颜色少于4个，不能领取两个' };
  } else if (uniq.size === colors.length && colors.length <= 3) {
    mode = 'distinct';
    // Official rule: take 3 tokens of different types. Only when fewer than 3
    // colors remain available in the supply may you take fewer (2, or even 1).
    const availDistinct = COLORS.filter((col) => s.supply[col] > 0).length;
    if (availDistinct >= 3 && colors.length !== 3) {
      return { ok: false, error: '必须领取3种不同颜色的精灵球' };
    }
  } else {
    return { ok: false, error: '只能领取3种不同颜色，或领取2个同色' };
  }
  for (const c of uniq)
    if (s.supply[c] < (mode === 'double' ? 2 : 1)) return { ok: false, error: '供应不足' };
  // apply
  for (const c of colors) {
    s.supply[c]--;
    p.tokens[c]++;
  }
  s.acted = true;
  s.taken = colors.slice();
  log(s, `${p.name} 领取 ${colors.map(zhBall).join('、')}`, {
    kind: 'take',
    colors: colors.slice(),
  });
  return { ok: true };
}

function actionReserve(
  s: GameState,
  target: ReserveTarget,
): ReturnType<EngineApi['actionReserve']> {
  // target: {fromField:id} or {fromDeck:tier}
  const p = activePlayer(s);
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (p.reserve.length >= HAND_MAX) return { ok: false, error: '预留区已满（最多3张）' };
  let cardId: string;
  let tier: FieldTier;
  let slot = -1;
  let fromDeck = false;
  if ('fromDeck' in target) {
    tier = target.fromDeck;
    if (!isReservableTier(s, tier)) return { ok: false, error: '稀有/传说不可预留' };
    const deck = deckAt(s, tier);
    if (!deck.length) return { ok: false, error: '牌堆已空' };
    const nextCard = deck.pop();
    if (!nextCard) return { ok: false, error: '牌堆已空' };
    cardId = nextCard;
    fromDeck = true;
  } else {
    cardId = target.fromField;
    const loc = locateCard(s, cardId);
    if (loc.where !== 'field') return { ok: false, error: '该卡不在场上' };
    if (!isReservableTier(s, loc.tier)) return { ok: false, error: '稀有/传说不可预留' };
    tier = loc.tier;
    slot = loc.slot;
  }
  p.reserve.push(cardId);
  if (!fromDeck) {
    fieldAt(s, tier)[slot] = null;
    refill(s, tier);
  }
  // gain a master ball if available
  let got = '';
  if (s.supply.purple > 0) {
    s.supply.purple--;
    p.tokens.purple++;
    got = ' 并获得1个大师球';
  }
  s.acted = true;
  log(s, `${p.name} 预留了一张${zhTier(tier)}宝可梦${fromDeck ? '（牌堆顶）' : ''}${got}`);
  return { ok: true, cardId };
}

// remove a just-captured card from wherever it sat (field or own reserve)
function takeFromSource(s: GameState, p: Player, loc: CardLocation, cardId: string): void {
  if (loc.where === 'reserve') {
    const i = p.reserve.indexOf(cardId);
    if (i >= 0) p.reserve.splice(i, 1);
  } else if (loc.where === 'field') {
    fieldAt(s, loc.tier)[loc.slot] = null;
    refill(s, loc.tier);
  }
}
// remove a board card out of the game (Pokémart "discard … returned to the box")
function discardFromBoard(s: GameState, p: Player, id: string): void {
  const i = p.board.indexOf(id);
  if (i >= 0) p.board.splice(i, 1);
  if (p.assoc) delete p.assoc[id];
}
// EVOLVE STONE / RARE CANDY: pick an owned card with a real bonus to copy.
function resolveCopyTarget(
  s: GameState,
  p: Player,
  targetId?: string,
): ActionResult<{ readonly color: Color }> {
  const cands = p.board.filter((id) => effBonusColor(s, p, id));
  if (!cands.length) return { ok: false, error: '进化石需要你已有一张带奖励的卡' };
  const selected = targetId ?? cands[0];
  if (!selected || cands.indexOf(selected) < 0)
    return { ok: false, error: '关联目标必须是你已有的带奖励的卡' };
  const color = effBonusColor(s, p, selected);
  if (!color) return { ok: false, error: '关联目标没有有效奖励' };
  return { ok: true, color };
}
// REPEL: choose `discardCount` owned cards of `discardColor` to discard.
function resolveDiscardBuy(
  s: GameState,
  p: Player,
  card: Card,
  chosen?: readonly string[],
): ActionResult<{ readonly discarded: string[] }> {
  const params = effectParamOf(card);
  const color = params.discardColor;
  const need = params.discardCount;
  if (!color || need == null) return { ok: false, error: '卡牌弃牌参数无效' };
  const owned = p.board.filter((id) => effBonusColor(s, p, id) === color);
  if (owned.length < need)
    return { ok: false, error: `需要弃掉${need}张${zhBall(color)}卡，但你只有${owned.length}张` };
  let discarded;
  if (chosen && chosen.length) {
    if (chosen.length !== need) return { ok: false, error: `必须弃掉${need}张` };
    for (const id of chosen)
      if (owned.indexOf(id) < 0) return { ok: false, error: '所选弃牌颜色不符或不属于你' };
    discarded = chosen.slice();
  } else {
    discarded = owned.slice(0, need);
  }
  return { ok: true, discarded };
}

// "Take a free card" effects (TM / RARE CANDY). The free card comes from the
// level below: RARE CANDY (pmL2) -> Level 1 (stage1/pmL1); TM (pmL3) -> Level 2.
function freeTiers(parentCard: Card): readonly FieldTier[] {
  if (parentCard.tier === 'pmL2') return ['stage1', 'pmL1'];
  if (parentCard.tier === 'pmL3') return ['stage2', 'pmL2'];
  return [];
}
// Is `fc` a free card the player could legally take right now (effect live + any
// required sub-choice is satisfiable)? Used to decide if the take is mandatory.
function freeTakeable(s: GameState, p: Player, fc: Card): boolean {
  if (isPokemart(fc) && fc.effect && !PM_EFFECTS_LIVE[fc.effect]) return false;
  if (isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free'))
    return p.board.some((b) => effBonusColor(s, p, b)); // needs a bonus card to copy
  return true;
}
// Validate (no mutation) the chain of free takes; returns {ok, steps:[{freeId,assoc}]}.
function planFree(
  s: GameState,
  p: Player,
  parentCard: Card,
  opts: CaptureOptions,
  depth = 0,
  seen: Readonly<Record<string, boolean>> = {},
): FreePlan {
  if (depth > 4) return { ok: false, error: '免费取卡层级过深' };
  const tiers = freeTiers(parentCard);
  const freeId = opts.freeTakeId;
  if (freeId == null) {
    const hasFreeCard = tiers.some((tier) =>
      fieldAt(s, tier).some((id) => id !== null && freeTakeable(s, p, cardById(s, id))),
    );
    return hasFreeCard
      ? { ok: false, error: '请选择要免费获得的卡（freeTakeId）' }
      : { ok: true, steps: [] };
  }
  if (seen[freeId]) return { ok: false, error: '免费取卡重复' };
  const loc = locateCard(s, freeId);
  if (loc.where !== 'field' || tiers.indexOf(loc.tier) < 0)
    return { ok: false, error: '免费卡必须是可选等级中的面朝上卡' };
  const fc = cardById(s, freeId);
  if (isPokemart(fc) && fc.effect && !PM_EFFECTS_LIVE[fc.effect])
    return { ok: false, error: `免费卡「${fc.name}」效果待实现` };
  const sub = opts.freeOpts || {};
  let assoc: Color | null = null;
  if (isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free')) {
    const r = resolveCopyTarget(s, p, sub.copyTargetId);
    if (!r.ok) return r;
    assoc = r.color;
  }
  let steps: FreeStep[] = [{ freeId, assoc }];
  if (isPokemart(fc) && (fc.effect === 'free' || fc.effect === 'copy_free')) {
    const ns: Readonly<Record<string, boolean>> = { ...seen, [freeId]: true };
    const rec = planFree(s, p, fc, sub, depth + 1, ns);
    if (!rec.ok) return rec;
    steps = steps.concat(rec.steps);
  }
  return { ok: true, steps };
}
function execFree(s: GameState, p: Player, steps: readonly FreeStep[]): void {
  for (const st of steps) {
    const loc = locateCard(s, st.freeId);
    if (loc.where === 'field') {
      fieldAt(s, loc.tier)[loc.slot] = null;
      refill(s, loc.tier);
    }
    p.board.push(st.freeId);
    if (st.assoc) {
      p.assoc = p.assoc || {};
      p.assoc[st.freeId] = st.assoc;
    }
    log(
      s,
      `${p.name} 免费获得 ${cardById(s, st.freeId).name}${st.assoc ? `（关联${zhBall(st.assoc)}）` : ''}`,
    );
  }
}

// opts (all optional, used by Pokémart effects):
//   copyTargetId  — board card id to copy a bonus from (EVOLVE STONE / RARE CANDY)
//   spendPokedex  — board POKÉDEX ids to discard, each worth 2 virtual master balls
//   discardCards  — board card ids to discard to pay for a REPEL (discard_buy)
//   freeTakeId + freeOpts — the free card to take (TM / RARE CANDY), and its own choices
function actionCapture(
  s: GameState,
  cardId: string,
  opts: CaptureOptions = {},
): ReturnType<EngineApi['actionCapture']> {
  const p = activePlayer(s);
  if (s.acted) return { ok: false, error: '本回合已行动' };
  const card = s.byId[cardId];
  if (!card) return { ok: false, error: '无此卡' };
  if (isPokemart(card) && card.effect && !PM_EFFECTS_LIVE[card.effect]) {
    return { ok: false, error: `Pokémart「${card.name}」效果待实现（后续阶段）` };
  }
  const loc = locateCard(s, cardId);
  const fromReserve = loc.where === 'reserve' && loc.owner === p.id;
  if (loc.where !== 'field' && !fromReserve)
    return { ok: false, error: '只能捕捉场上或自己预留区的宝可梦' };

  // --- REPEL (discard_buy): no token cost; discard owned cards of a colour ---
  if (isPokemart(card) && card.effect === 'discard_buy') {
    const r = resolveDiscardBuy(s, p, card, opts.discardCards);
    if (!r.ok) return r;
    takeFromSource(s, p, loc, cardId);
    for (const did of r.discarded) discardFromBoard(s, p, did);
    p.board.push(cardId);
    s.acted = true;
    const discardedColor = effectParamOf(card).discardColor;
    log(
      s,
      `${p.name} 用${card.name}获得（弃掉${r.discarded.length}张${discardedColor ? zhBall(discardedColor) : '指定颜色'}卡）`,
    );
    return { ok: true };
  }

  // --- optional: discard POKÉDEX cards as 2 virtual master balls each ---
  const spend = opts.spendPokedex ?? [];
  for (const pid of spend) {
    const pc = s.byId[pid];
    if (!pc || p.board.indexOf(pid) < 0 || !(isPokemart(pc) && pc.effect === 'colorless_master')) {
      return { ok: false, error: '无效的图鉴消耗' };
    }
  }
  const payment = computePayment(s, p, card, spend.length * 2);
  if (!payment.ok) return { ok: false, error: payment.error };

  // --- EVOLVE STONE / RARE CANDY (copy): associate with an owned bonus card ---
  let assocColor = null;
  if (isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')) {
    const r = resolveCopyTarget(s, p, opts.copyTargetId);
    if (!r.ok) return r;
    assocColor = r.color;
  }
  // --- TM / RARE CANDY (free / copy_free): plan the free take(s) up front ---
  let freeSteps = null;
  if (isPokemart(card) && (card.effect === 'free' || card.effect === 'copy_free')) {
    const fp = planFree(s, p, card, opts, 0);
    if (!fp.ok) return fp;
    freeSteps = fp.steps;
  }

  payTokens(s, p, payment.pay);
  for (const pid of spend) discardFromBoard(s, p, pid); // virtual masters consumed
  takeFromSource(s, p, loc, cardId);
  p.board.push(cardId);
  if (assocColor) {
    p.assoc = p.assoc || {};
    p.assoc[cardId] = assocColor;
  }
  s.acted = true;
  const extra = spend.length ? `，弃${spend.length}图鉴抵${spend.length * 2}万能` : '';
  const asc = assocColor ? `，关联${zhBall(assocColor)}` : '';
  log(s, `${p.name} 捕捉了 ${card.name}（${payDesc(payment.pay)}${extra}${asc}）`, {
    kind: 'capture',
    cardId,
  });
  if (freeSteps && freeSteps.length) execFree(s, p, freeSteps);
  return { ok: true };
}

// ----------------------- evolution (end of turn) -------------------
// List the legal evolutions available right now for the active player.
// Evolution is by SPECIES: a caught Pokémon evolves into ANY available
// card of its next-form species (on the field or in the player's hand).
function evolutionOptions(s: GameState, player: Player): EvolutionOption[] {
  const opts: EvolutionOption[] = [];
  if (s.evolvedThisTurn) return opts; // only one evolution per turn
  const b = bonuses(s, player);
  // available evolution targets: field cards + this player's reserve
  const avail: Array<
    | {
        readonly id: string;
        readonly where: 'field';
        readonly tier: BaseTier;
        readonly slot: number;
      }
    | { readonly id: string; readonly where: 'reserve'; readonly slot: number }
  > = [];
  for (const tier of FIELD_TIERS)
    s.field[tier].forEach((id, slot) => {
      if (id) avail.push({ id, where: 'field', tier, slot });
    });
  player.reserve.forEach((id, slot) => avail.push({ id, where: 'reserve', slot }));
  for (const id of player.board) {
    const c = cardById(s, id);
    if (!c.evolvesTo || !c.evoCost) continue;
    // Affordability: evolution is paid ONLY by the discount balls on your
    // captured cards (bonuses) — never by the balls you hold (tokens). You
    // must already own enough discounts of the required color to cover the
    // full evolution cost; nothing is spent.
    if (b[c.evoCost.color] < c.evoCost.count) continue;
    for (const a of avail) {
      if (cardById(s, a.id).name !== c.evolvesTo) continue;
      opts.push({
        fromId: id,
        toId: a.id,
        color: c.evoCost.color,
        count: c.evoCost.count,
        targetWhere: a.where,
      });
    }
  }
  return opts;
}

function actionEvolve(
  s: GameState,
  fromId: string,
  toId?: string,
): ReturnType<EngineApi['actionEvolve']> {
  const p = activePlayer(s);
  if (s.evolvedThisTurn) return { ok: false, error: '本回合已进化过' };
  const cands = evolutionOptions(s, p).filter((o) => o.fromId === fromId);
  const opt = toId != null ? cands.find((o) => o.toId === toId) : cands[0];
  if (!opt) return { ok: false, error: '不满足进化条件' };
  // No tokens are spent: evolution is paid entirely by the discounts on your
  // captured cards (affordability already verified in evolutionOptions).
  // move target out of field/reserve
  const loc = locateCard(s, opt.toId);
  if (loc.where === 'field') {
    fieldAt(s, loc.tier)[loc.slot] = null;
    refill(s, loc.tier);
  } else if (loc.where === 'reserve') {
    playerAt(s, loc.owner).reserve.splice(loc.slot, 1);
  }
  // replace on board: remove fromId -> buried; add toId
  const bi = p.board.indexOf(fromId);
  p.board.splice(bi, 1);
  p.buried.push(fromId);
  p.board.push(opt.toId);
  s.evolvedThisTurn = true;
  log(s, `${p.name} 将 ${cardById(s, fromId).name} 进化为 ${cardById(s, opt.toId).name}`);
  return { ok: true, fromId, toId: opt.toId };
}

// ----------------------- Megas expansion ---------------------------
// Main action: spend your whole turn to take one Mega token (max 1 held).
function actionTakeMega(s: GameState): ReturnType<EngineApi['actionTakeMega']> {
  const p = activePlayer(s);
  if (!s.megasEnabled) return { ok: false, error: '未启用 Megas 扩展' };
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (p.megaToken >= 1) return { ok: false, error: '已持有 Mega 代币（上限1）' };
  if ((s.supply.megaToken ?? 0) < 1) return { ok: false, error: '没有可用的 Mega 代币' };
  s.supply.megaToken = (s.supply.megaToken ?? 0) - 1;
  p.megaToken++;
  s.acted = true;
  log(s, `${p.name} 获得了 1 个 Mega 代币`);
  return { ok: true };
}

// End-of-turn Mega evolution options. Requires: you hold a Mega token, you
// have captured the base Pokémon (megaFrom) in play, and you can pay the Mega
// card's cost (balls reduced by bonuses; master ball substitutes). Counts as
// this turn's single evolution (shares evolvedThisTurn).
function megaEvolveOptions(s: GameState, player: Player): MegaEvolutionOption[] {
  const opts: MegaEvolutionOption[] = [];
  if (!s.megasEnabled || s.evolvedThisTurn || player.megaToken < 1) return opts;
  for (const megaId of s.megaOffer) {
    const mega = cardById(s, megaId);
    const fromId = player.board.find((id) => cardById(s, id).name === mega.megaFrom);
    if (!fromId) continue;
    if (!canAfford(s, player, mega)) continue;
    if (!mega.megaFrom) continue;
    opts.push({ megaId, fromId, fromName: mega.megaFrom, megaName: mega.name });
  }
  return opts;
}

function actionMegaEvolve(
  s: GameState,
  megaId: string,
  fromId?: string,
): ReturnType<EngineApi['actionMegaEvolve']> {
  const p = activePlayer(s);
  if (!s.megasEnabled) return { ok: false, error: '未启用 Megas 扩展' };
  if (s.evolvedThisTurn) return { ok: false, error: '本回合已进化过' };
  const cands = megaEvolveOptions(s, p).filter((o) => o.megaId === megaId);
  const opt = fromId != null ? cands.find((o) => o.fromId === fromId) : cands[0];
  if (!opt) return { ok: false, error: '不满足超级进化条件' };
  const mega = cardById(s, megaId);
  const payment = computePayment(s, p, mega);
  if (!payment.ok) return { ok: false, error: payment.error };
  payTokens(s, p, payment.pay);
  // consume the Mega token (returns to the shared pool)
  p.megaToken--;
  s.supply.megaToken = (s.supply.megaToken ?? 0) + 1;
  // bury the base Pokémon, take the Mega card out of the offer, place it in play
  const bi = p.board.indexOf(opt.fromId);
  p.board.splice(bi, 1);
  p.buried.push(opt.fromId);
  s.megaOffer = s.megaOffer.filter((id) => id !== megaId);
  p.board.push(megaId);
  s.evolvedThisTurn = true;
  log(
    s,
    `${p.name} 将 ${cardById(s, opt.fromId).name} 超级进化为 ${mega.name}（${payDesc(payment.pay)}）`,
  );
  return { ok: true, megaId, fromId: opt.fromId };
}

// Win trigger. Base game: 18 VP. Megas: 20 VP AND ≥1 captured card of every
// color AND ≥1 Mega in play.
function hasMegaWin(s: GameState, p: Player): boolean {
  if (scoreOf(s, p) < MEGA_WIN_SCORE) return false;
  const b = bonuses(s, p);
  if (!COLORS.every((c) => b[c] > 0)) return false;
  return p.board.some((id) => cardById(s, id).tier === 'mega');
}
function winTriggered(s: GameState, p: Player): boolean {
  return s.megasEnabled ? hasMegaWin(s, p) : scoreOf(s, p) >= (s.winScore || WIN_SCORE);
}

// --------------------------- discard -------------------------------
function needsDiscard(s: GameState, player: Player): boolean {
  return tokenTotal(player) > TOKEN_MAX;
}
function actionDiscard(s: GameState, color: TokenColor): ReturnType<EngineApi['actionDiscard']> {
  const p = activePlayer(s);
  if (!p.tokens[color]) return { ok: false, error: '没有该精灵球' };
  p.tokens[color]--;
  s.supply[color]++;
  log(s, `${p.name} 归还了1个${zhBall(color)}`);
  return { ok: true };
}

// A legitimate pass: only allowed when the player genuinely has no legal
// main action (e.g. supply drained, nothing affordable, hand full).
function actionPass(s: GameState): ReturnType<EngineApi['actionPass']> {
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (legalActions(s).length) return { ok: false, error: '尚有可执行的行动' };
  s.acted = true;
  log(s, `${activePlayer(s).name} 无法行动，跳过回合`);
  return { ok: true };
}

// --------------------------- turn flow -----------------------------
// Call after the main action. Resolves discard requirement and lets the
// caller present evolution options; then endTurn() advances.
function turnState(s: GameState): TurnState {
  const p = activePlayer(s);
  return {
    acted: s.acted,
    mustDiscard: needsDiscard(s, p) ? tokenTotal(p) - TOKEN_MAX : 0,
    evolutions: evolutionOptions(s, p),
    megaEvolutions: megaEvolveOptions(s, p),
  };
}

function endTurn(s: GameState): ReturnType<EngineApi['endTurn']> {
  const p = activePlayer(s);
  if (!s.acted) return { ok: false, error: '尚未行动' };
  if (needsDiscard(s, p)) return { ok: false, error: '请先归还多余精灵球（上限10）' };
  // check win trigger (someone reached the target this turn)
  if (winTriggered(s, p) && !s.lastRound) {
    s.lastRound = true;
    const why = s.megasEnabled
      ? `${MEGA_WIN_SCORE}分+集齐每色+1只Mega`
      : `${s.winScore || WIN_SCORE} 分`;
    log(s, `${p.name} 达成胜利条件（${why}），进入最后一轮！`);
  }
  // The game ends once the LAST player of the round finishes during the
  // final round, so every Trainer has taken an equal number of turns.
  const wasLastPlayer = s.turn === s.numPlayers - 1;
  if (s.lastRound && wasLastPlayer) {
    s.phase = 'gameover';
    s.winner = determineWinner(s);
    log(s, `游戏结束，胜者：${playerAt(s, s.winner).name}`);
    return { ok: true, gameover: true };
  }
  s.turn = (s.turn + 1) % s.numPlayers;
  if (wasLastPlayer) s.round++;
  s.acted = false;
  s.taken = [];
  s.evolvedThisTurn = false;
  return { ok: true };
}

function determineWinner(s: GameState): number {
  // most VP, then most buried (evolutions), then most board cards
  const rank = (p: Player): readonly [number, number, number] => [
    scoreOf(s, p),
    p.buried.length,
    p.board.length,
  ];
  // Eligibility: in the Megas variant only a player who actually achieves the
  // win condition (20 VP + every colour + a Mega in play) can win — a rival with
  // more raw points but no Mega/colour set does NOT. (Base game: everyone is
  // eligible; the highest score already implies they crossed the threshold.)
  let pool: number[] = [];
  for (let i = 0; i < s.numPlayers; i++) pool.push(i);
  if (s.megasEnabled) {
    const q = pool.filter((i) => hasMegaWin(s, playerAt(s, i)));
    if (q.length) pool = q; // fall back to all only in the pathological "nobody qualifies" case
  }
  let best = pool[0] ?? 0;
  for (const i of pool) {
    const a = rank(playerAt(s, i)),
      b = rank(playerAt(s, best));
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = i;
  }
  return best;
}

// ------------------- legal move enumeration (for AI) ---------------
// Auto-plan the choice parameters of an effect capture so search/AI can play
// Pokémart cards without a UI: copy targets pick the player's DEEPEST bonus
// colour (coherence), discard_buy sacrifices the least valuable owned cards,
// free-takes pick the best available card (VP, bonuses, evolvability) and
// recurse for chained effects. Returns an opts object for actionCapture.
function autoCaptureOpts(s: GameState, p: Player, card: Card): CaptureOptions {
  const opts: {
    copyTargetId?: string;
    discardCards?: string[];
    freeTakeId?: string;
    freeOpts?: CaptureOptions;
  } = {};
  const pickCopyTarget = (): string | null => {
    const cands = p.board.filter((id) => effBonusColor(s, p, id));
    if (!cands.length) return null;
    const b = bonuses(s, p);
    let best = cands[0] ?? null,
      bs = -1;
    for (const id of cands) {
      const color = effBonusColor(s, p, id);
      if (!color) continue;
      const value = b[color];
      if (value > bs) {
        bs = value;
        best = id;
      }
    }
    return best;
  };
  if (card.effect === 'copy' || card.effect === 'copy_free') {
    const t = pickCopyTarget();
    if (t) opts.copyTargetId = t;
  }
  if (card.effect === 'discard_buy') {
    const params = effectParamOf(card);
    const col = params.discardColor;
    const need = params.discardCount ?? 0;
    const owned = p.board.filter((id) => effBonusColor(s, p, id) === col);
    // sacrifice the least valuable first: low VP, not evolvable, single bonus
    owned.sort((a, c) => {
      const A = cardById(s, a),
        C = cardById(s, c);
      return (
        (A.vp || 0) * 4 +
        (A.evolvesTo ? 3 : 0) +
        (A.bonusCount || 1) -
        ((C.vp || 0) * 4 + (C.evolvesTo ? 3 : 0) + (C.bonusCount || 1))
      );
    });
    opts.discardCards = owned.slice(0, need);
  }
  if (card.effect === 'free' || card.effect === 'copy_free') {
    let best: Card | null = null,
      bs = -1e9;
    for (const t of freeTiers(card))
      for (const id of fieldAt(s, t)) {
        if (!id) continue;
        const fc = cardById(s, id);
        if (!freeTakeable(s, p, fc)) continue;
        const v = (fc.vp || 0) * 3 + (fc.bonusCount || 1) * 2 + (fc.evolvesTo ? 1 : 0);
        if (v > bs) {
          bs = v;
          best = fc;
        }
      }
    if (best) {
      opts.freeTakeId = best.id;
      const sub: { copyTargetId?: string; freeTakeId?: string; freeOpts?: CaptureOptions } = {};
      if (isPokemart(best) && (best.effect === 'copy' || best.effect === 'copy_free')) {
        const t = pickCopyTarget();
        if (t) sub.copyTargetId = t;
      }
      if (isPokemart(best) && (best.effect === 'free' || best.effect === 'copy_free')) {
        // chained free-take: plan one level deep with the same rule
        const rec = autoCaptureOpts(s, p, best);
        if (rec.freeTakeId) {
          sub.freeTakeId = rec.freeTakeId;
          sub.freeOpts = rec.freeOpts || {};
        }
      }
      opts.freeOpts = sub;
    }
    // no takeable free card → effect fizzles, capture still legal (planFree allows it)
  }
  return opts;
}

function legalActions(s: GameState): GameAction[] {
  const p = activePlayer(s);
  if (s.acted || s.phase !== 'play') return [];
  const acts: GameAction[] = [];
  // Megas: spending the whole turn on a Mega token is a real action — the AI
  // must be able to plan it (required for the 20VP+colours+Mega win).
  if (s.megasEnabled && p.megaToken < 1 && (s.supply.megaToken ?? 0) > 0 && s.megaOffer.length) {
    acts.push({ type: 'takeMega' });
  }
  // takes
  const avail = COLORS.filter((c) => s.supply[c] > 0);
  // 3 distinct
  for (let i = 0; i < avail.length; i++)
    for (let j = i + 1; j < avail.length; j++)
      for (let k = j + 1; k < avail.length; k++) {
        const first = avail[i],
          second = avail[j],
          third = avail[k];
        if (first && second && third) acts.push({ type: 'take', colors: [first, second, third] });
      }
  // fewer-than-3 distinct only if <3 colors available
  const first = avail[0],
    second = avail[1];
  if (avail.length === 2 && first && second) acts.push({ type: 'take', colors: [first, second] });
  if (avail.length === 1 && first) acts.push({ type: 'take', colors: [first] });
  // 2 same
  for (const c of COLORS) if (s.supply[c] >= 4) acts.push({ type: 'take', colors: [c, c] });
  // captures (field + own reserve). Pokémart cards with not-yet-live effects
  // are excluded so the AI never picks a capture the engine will reject.
  const capIds: string[] = [];
  for (const tier of fieldTiers(s)) for (const id of fieldAt(s, tier)) if (id) capIds.push(id);
  for (const id of p.reserve) capIds.push(id);
  for (const id of capIds) {
    const card = cardById(s, id);
    if (isPokemart(card) && card.effect) {
      if (!PM_EFFECTS_LIVE[card.effect]) continue;
      if (card.effect === 'discard_buy') {
        const params = effectParamOf(card);
        const col = params.discardColor;
        const need = params.discardCount;
        if (!col || need == null) continue;
        const owned = p.board.filter((bid) => effBonusColor(s, p, bid) === col).length;
        if (owned >= need)
          acts.push({ type: 'capture', cardId: id, opts: autoCaptureOpts(s, p, card) });
        continue;
      }
      if (card.effect === 'copy' || card.effect === 'copy_free') {
        // need an owned bonus card to copy
        if (p.board.some((bid) => effBonusColor(s, p, bid)) && canAfford(s, p, card))
          acts.push({ type: 'capture', cardId: id, opts: autoCaptureOpts(s, p, card) });
        continue;
      }
      if (card.effect === 'free' && canAfford(s, p, card)) {
        // TM: free take auto-planned
        acts.push({ type: 'capture', cardId: id, opts: autoCaptureOpts(s, p, card) });
        continue;
      }
      // double / colorless_master capture like a normal card
      if ((card.effect === 'double' || card.effect === 'colorless_master') && canAfford(s, p, card))
        acts.push({ type: 'capture', cardId: id });
      continue;
    }
    if (canAfford(s, p, card)) acts.push({ type: 'capture', cardId: id });
  }
  // reserves (base levels + Pokémart levels)
  if (p.reserve.length < HAND_MAX) {
    const reserveTiers: readonly FieldTier[] = s.pokemartEnabled
      ? [...NORMAL_TIERS, ...PM_TIERS]
      : NORMAL_TIERS;
    for (const tier of reserveTiers) {
      for (const id of fieldAt(s, tier))
        if (id) acts.push({ type: 'reserve', target: { fromField: id } });
      if (deckAt(s, tier).length) acts.push({ type: 'reserve', target: { fromDeck: tier } });
    }
  }
  return acts;
}

// Total reducer: a single validate-and-apply chokepoint for EVERY move, so
// both local clicks and network messages flow through one path. The move's
// {type,...} object is the wire format. `playerId` is an optional ownership
// guard for networked play (reject a move submitted for a seat that isn't the
// active player); local/AI callers omit it. End-of-turn steps (evolve / mega
// / discard / endTurn) are included so a turn's whole lifecycle is serialisable.
function validActionShape(a: unknown): a is GameAction {
  if (!isRecord(a) || typeof a['type'] !== 'string') return false;
  const keysAre = (allowed: readonly string[]): boolean =>
    Object.keys(a).every((k) => allowed.includes(k));
  const shortId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 64;
  const stringList = (value: unknown, max: number): value is readonly string[] =>
    Array.isArray(value) && value.length <= max && value.every(shortId);
  function validCaptureOpts(opts: unknown, depth: number): opts is CaptureOptions {
    if (opts === undefined) return true;
    if (depth > 3 || !isRecord(opts)) return false;
    const allowed = ['copyTargetId', 'spendPokedex', 'discardCards', 'freeTakeId', 'freeOpts'];
    if (!Object.keys(opts).every((k) => allowed.indexOf(k) >= 0)) return false;
    if (opts['copyTargetId'] !== undefined && !shortId(opts['copyTargetId'])) return false;
    if (opts['freeTakeId'] !== undefined && !shortId(opts['freeTakeId'])) return false;
    if (opts['spendPokedex'] !== undefined && !stringList(opts['spendPokedex'], 10)) return false;
    if (opts['discardCards'] !== undefined && !stringList(opts['discardCards'], 10)) return false;
    return opts['freeOpts'] === undefined || validCaptureOpts(opts['freeOpts'], depth + 1);
  }
  switch (a['type']) {
    case 'take':
      return (
        keysAre(['type', 'colors']) &&
        Array.isArray(a['colors']) &&
        a['colors'].length >= 1 &&
        a['colors'].length <= 3 &&
        a['colors'].every(isColor)
      );
    case 'capture':
      return (
        keysAre(['type', 'cardId', 'opts']) &&
        shortId(a['cardId']) &&
        validCaptureOpts(a['opts'], 0)
      );
    case 'reserve': {
      const target = a['target'];
      if (!keysAre(['type', 'target']) || !isRecord(target)) return false;
      if (!Object.keys(target).every((k) => k === 'fromField' || k === 'fromDeck')) return false;
      const fromField = target['fromField'];
      const fromDeck = target['fromDeck'];
      return (
        (shortId(fromField) && fromDeck === undefined) ||
        (fromField === undefined && isFieldTier(fromDeck))
      );
    }
    case 'evolve':
      return keysAre(['type', 'fromId', 'toId']) && shortId(a['fromId']) && shortId(a['toId']);
    case 'megaEvolve':
      return keysAre(['type', 'megaId', 'fromId']) && shortId(a['megaId']) && shortId(a['fromId']);
    case 'discard':
      return keysAre(['type', 'color']) && isTokenColor(a['color']);
    case 'takeMega':
    case 'pass':
    case 'endTurn':
      return keysAre(['type']);
    default:
      return false;
  }
}

function applyAction(
  s: GameState,
  a: GameAction,
  playerId?: number,
): ReturnType<EngineApi['applyAction']> {
  if (!validActionShape(a)) return { ok: false, error: '行动格式无效' };
  if (playerId != null && playerId !== s.turn) return { ok: false, error: '未轮到你' };
  switch (a.type) {
    case 'take':
      return actionTake(s, a.colors);
    case 'capture':
      return actionCapture(s, a.cardId, a.opts);
    case 'reserve':
      return actionReserve(s, a.target);
    case 'takeMega':
      return actionTakeMega(s);
    case 'evolve':
      return actionEvolve(s, a.fromId, a.toId);
    case 'megaEvolve':
      return actionMegaEvolve(s, a.megaId, a.fromId);
    case 'discard':
      return actionDiscard(s, a.color);
    case 'pass':
      return actionPass(s);
    case 'endTurn':
      return endTurn(s);
    default:
      return { ok: false, error: '未知行动' };
  }
}

// Public projection of the state for ONE viewer, safe to send over a network.
// Hides what the viewer must not see — the ordered face-down deck (every future
// draw) and other players' reserved-card identities (possibly drawn blind) —
// while preserving counts/tiers so the UI still renders pile sizes & card-backs.
// Static card refs are omitted (every client already has the full card DB).
function redactFor(s: GameState, viewerId: number): ReturnType<EngineApi['redactFor']> {
  const {
    cardDB: _cardDB,
    byId: _byId,
    megaDB: _megaDB,
    pokemartDB: _pokemartDB,
    decks: _decks,
    players: _players,
    ...dynamic
  } = s;
  const decks: RedactedGameState['decks'] = {
    stage1: s.decks.stage1.map(() => null),
    stage2: s.decks.stage2.map(() => null),
    stage3: s.decks.stage3.map(() => null),
    rare: s.decks.rare.map(() => null),
    legend: s.decks.legend.map(() => null),
  };
  if (s.decks.pmL1) decks.pmL1 = s.decks.pmL1.map(() => null);
  if (s.decks.pmL2) decks.pmL2 = s.decks.pmL2.map(() => null);
  if (s.decks.pmL3) decks.pmL3 = s.decks.pmL3.map(() => null);
  const players: RedactedGameState['players'] = s.players.map((player, index) => ({
    ...structuredClone(player),
    reserve:
      index === viewerId
        ? [...player.reserve]
        : player.reserve.map((id) => ({ hidden: true, tier: cardById(s, id).tier })),
  }));
  return { ...structuredClone(dynamic), decks, players, viewerId };
}

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

const Engine = {
  COLORS,
  MASTER,
  ALL_TOKENS,
  NORMAL_TIERS,
  FIELD_TIERS,
  FIELD_SLOTS,
  HAND_MAX,
  TOKEN_MAX,
  WIN_SCORE,
  makeRng,
  shuffle,
  supplyFor,
  createGame,
  activePlayer,
  bonusOf,
  bonuses,
  tokenTotal,
  scoreOf,
  locateCard,
  refill,
  computePayment,
  canAfford,
  paymentBreakdown,
  actionTake,
  actionReserve,
  actionCapture,
  actionEvolve,
  actionDiscard,
  actionPass,
  actionTakeMega,
  megaEvolveOptions,
  actionMegaEvolve,
  MEGA_TOKENS,
  MEGA_WIN_SCORE,
  PM_TIERS,
  PM_SLOTS,
  fieldTiers,
  isPokemart,
  effBonusColor,
  freeTiers,
  freeTakeable,
  autoCaptureOpts,
  evolutionOptions,
  needsDiscard,
  turnState,
  endTurn,
  determineWinner,
  legalActions,
  validActionShape,
  applyAction,
  redactFor,
  clone,
  zhBall,
  zhTier,
  payDesc,
};

export {
  ALL_TOKENS,
  COLORS,
  FIELD_SLOTS,
  FIELD_TIERS,
  HAND_MAX,
  MASTER,
  MEGA_TOKENS,
  MEGA_WIN_SCORE,
  NORMAL_TIERS,
  PM_SLOTS,
  PM_TIERS,
  TOKEN_MAX,
  WIN_SCORE,
  actionCapture,
  actionDiscard,
  actionEvolve,
  actionMegaEvolve,
  actionPass,
  actionReserve,
  actionTake,
  actionTakeMega,
  activePlayer,
  applyAction,
  autoCaptureOpts,
  bonusOf,
  bonuses,
  canAfford,
  clone,
  computePayment,
  createGame,
  determineWinner,
  effBonusColor,
  endTurn,
  evolutionOptions,
  fieldTiers,
  freeTakeable,
  freeTiers,
  isPokemart,
  legalActions,
  locateCard,
  makeRng,
  megaEvolveOptions,
  needsDiscard,
  payDesc,
  paymentBreakdown,
  redactFor,
  refill,
  scoreOf,
  shuffle,
  supplyFor,
  tokenTotal,
  turnState,
  validActionShape,
  zhBall,
  zhTier,
};
export default Engine;
