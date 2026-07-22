import type { EngineApi } from './api.js';
import type {
  ActionResult,
  BaseTier,
  Card,
  CardEffect,
  CardEffectParam,
  Color,
  ColorCounts,
  CreateGameOptions,
  GameState,
  Player,
  PokemartTier,
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

export {
  ALL_TOKENS,
  CANON_SPECIAL,
  COLORS,
  FIELD_SLOTS,
  FIELD_TIERS,
  HAND_MAX,
  MASTER,
  MEGA_TOKENS,
  MEGA_WIN_SCORE,
  NORMAL_TIERS,
  PM_EFFECTS_LIVE,
  PM_SLOTS,
  PM_TIERS,
  SPECIAL_TIERS,
  TOKEN_MAX,
  WIN_SCORE,
  buildIndex,
  cardById,
  createGame,
  deckAt,
  effectParamOf,
  emptyColors,
  emptyTokens,
  fieldAt,
  fieldTiers,
  isBaseTier,
  isColor,
  isFieldTier,
  isPokemart,
  isPokemartTier,
  isRecord,
  isReservableTier,
  isTokenColor,
  makeRng,
  playerAt,
  shuffle,
  slotCount,
  supplyFor,
};
export type {
  CardLocation,
  EvolutionOption,
  FieldTier,
  FreePlan,
  FreeStep,
  MegaEvolutionOption,
  PaymentBreakdown,
  ReserveTarget,
  TurnState,
};
