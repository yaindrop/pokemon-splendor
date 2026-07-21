export const NORMAL_COLORS = ['red', 'blue', 'black', 'pink', 'yellow'] as const;
export const TOKEN_COLORS = [...NORMAL_COLORS, 'purple'] as const;
export const FIELD_TIERS = ['stage1', 'stage2', 'stage3', 'rare', 'legend'] as const;
export const POKEMART_TIERS = ['pmL1', 'pmL2', 'pmL3'] as const;

export type Color = (typeof NORMAL_COLORS)[number];
export type TokenColor = (typeof TOKEN_COLORS)[number];
export type BaseTier = (typeof FIELD_TIERS)[number];
export type PokemartTier = (typeof POKEMART_TIERS)[number];
export type Tier = BaseTier | PokemartTier | 'mega';
export type GamePhase = 'play' | 'discard' | 'evolve' | 'gameover';

export type ColorCounts = Record<Color, number>;
export type TokenCounts = Record<TokenColor, number>;
export type Supply = TokenCounts & { megaToken?: number };

export interface CardEffectParam {
  readonly discardColor?: Color;
  readonly discardCount?: number;
  readonly freeFromTier?: string;
}

export type CardEffect =
  'double' | 'copy' | 'colorless_master' | 'discard_buy' | 'free' | 'copy_free';

export interface Card {
  readonly id: string;
  readonly tier: Tier;
  readonly name: string;
  readonly vp: number;
  readonly bonus: Color | 'none';
  readonly bonusCount: number;
  readonly cost: TokenCounts;
  readonly evolvesTo: string | null;
  readonly evoCost: { readonly color: Color; readonly count: number } | null;
  readonly img: string;
  readonly effect?: CardEffect | null;
  readonly effectParam?: CardEffectParam | null;
  readonly megaFrom?: string | null;
}

export interface Player {
  readonly id: number;
  name: string;
  isAI: boolean;
  tokens: TokenCounts;
  megaToken: number;
  board: string[];
  buried: string[];
  reserve: string[];
  assoc: Partial<Record<string, Color>>;
  diff?: 'easy' | 'normal' | 'hard' | 'ultra' | 'alphazero';
}

export interface GameLogEntry {
  readonly turn: number;
  readonly round: number;
  readonly msg: string;
  readonly kind?: string;
  readonly colors?: readonly TokenColor[];
  readonly cardId?: string;
  readonly pay?: TokenCounts;
}

export interface GameState {
  seed: number;
  winScore: number;
  cardDB: readonly Card[];
  byId: Record<string, Card>;
  numPlayers: number;
  supply: Supply;
  decks: Record<BaseTier, (string | null)[]> & Partial<Record<PokemartTier, (string | null)[]>>;
  field: Record<BaseTier, (string | null)[]> & Partial<Record<PokemartTier, (string | null)[]>>;
  players: Player[];
  megasEnabled: boolean;
  megaDB: readonly Card[];
  megaOffer: string[];
  pokemartEnabled: boolean;
  pokemartDB: readonly Card[];
  turn: number;
  round: number;
  phase: GamePhase;
  lastRound: boolean;
  finalTurnOf: number | null;
  winner: number | null;
  log: GameLogEntry[];
  acted: boolean;
  taken: TokenColor[];
  evolvedThisTurn: boolean;
}

export interface HiddenReservedCard {
  readonly hidden: true;
  readonly tier: Tier;
}

export type RedactedPlayer = Omit<Player, 'reserve'> & {
  reserve: Array<string | HiddenReservedCard>;
};

export type RedactedGameState = Omit<
  GameState,
  'cardDB' | 'byId' | 'megaDB' | 'pokemartDB' | 'decks' | 'players'
> & {
  decks: Record<BaseTier, null[]> & Partial<Record<PokemartTier, null[]>>;
  players: RedactedPlayer[];
  readonly viewerId: number;
};

export interface CreateGameOptions {
  readonly numPlayers?: number;
  readonly seed?: number;
  readonly winScore?: number;
  readonly names?: readonly string[];
  readonly ai?: readonly boolean[];
  readonly megas?: boolean;
  readonly megaDB?: readonly Card[];
  readonly pokemart?: boolean;
  readonly pokemartDB?: readonly Card[];
  readonly specialSets?: Partial<Record<'rare' | 'legend', readonly string[]>>;
}

export interface CaptureOptions {
  readonly copyTargetId?: string;
  readonly spendPokedex?: readonly string[];
  readonly discardCards?: readonly string[];
  readonly freeTakeId?: string;
  readonly freeOpts?: CaptureOptions;
}

export type GameAction =
  | { readonly type: 'take'; readonly colors: readonly Color[] }
  | { readonly type: 'capture'; readonly cardId: string; readonly opts?: CaptureOptions }
  | {
      readonly type: 'reserve';
      readonly target:
        { readonly fromField: string } | { readonly fromDeck: BaseTier | PokemartTier };
    }
  | { readonly type: 'evolve'; readonly fromId: string; readonly toId: string }
  | { readonly type: 'megaEvolve'; readonly megaId: string; readonly fromId: string }
  | { readonly type: 'discard'; readonly color: TokenColor }
  | { readonly type: 'takeMega' | 'pass' | 'endTurn' };

export type ActionResult<T extends object = object> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

export interface TurnPlan {
  readonly action: GameAction | null;
  readonly discards: readonly TokenColor[];
  readonly evolution: { readonly fromId: string; readonly toId: string } | null;
  readonly megaEvolution?: { readonly megaId: string; readonly fromId: string } | null;
}
