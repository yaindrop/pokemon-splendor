import type {
  ActionResult,
  BaseTier,
  CaptureOptions,
  Card,
  Color,
  ColorCounts,
  CreateGameOptions,
  GameAction,
  GameState,
  Player,
  PokemartTier,
  RedactedGameState,
  Supply,
  Tier,
  TokenColor,
  TokenCounts,
  TurnPlan,
} from './types.js';

export interface Payment {
  readonly pay: TokenCounts;
  readonly virtualMaster: number;
}

export interface EngineApi {
  readonly COLORS: readonly Color[];
  readonly MASTER: 'purple';
  readonly ALL_TOKENS: readonly TokenColor[];
  readonly NORMAL_TIERS: readonly BaseTier[];
  readonly FIELD_TIERS: readonly BaseTier[];
  readonly FIELD_SLOTS: Readonly<Record<BaseTier, number>>;
  readonly PM_TIERS: readonly PokemartTier[];
  readonly PM_SLOTS: number;
  readonly HAND_MAX: number;
  readonly TOKEN_MAX: number;
  readonly WIN_SCORE: number;
  readonly MEGA_TOKENS: number;
  readonly MEGA_WIN_SCORE: number;
  makeRng(seed: number): () => number;
  shuffle<T>(items: T[], random: () => number): T[];
  supplyFor(numPlayers: number): Supply;
  createGame(cards: readonly Card[], options?: CreateGameOptions): GameState;
  activePlayer(state: GameState): Player;
  bonusOf(state: GameState, player: Player, color: Color): number;
  bonuses(state: GameState, player: Player): ColorCounts;
  tokenTotal(player: Player): number;
  scoreOf(state: GameState, player: Player): number;
  locateCard(
    state: GameState,
    id: string,
  ):
    | { readonly where: 'field'; readonly tier: BaseTier | PokemartTier; readonly slot: number }
    | { readonly where: 'reserve'; readonly owner: number; readonly slot: number }
    | { readonly where: null };
  refill(state: GameState, tier: BaseTier | PokemartTier): void;
  computePayment(
    state: GameState,
    player: Player,
    card: Card,
    extraMaster?: number,
  ): ActionResult<Payment>;
  canAfford(state: GameState, player: Player, card: Card): boolean;
  paymentBreakdown(
    state: GameState,
    player: Player,
    card: Card,
    extraMaster?: number,
  ): {
    readonly rows: readonly {
      readonly color: Color;
      readonly required: number;
      readonly bonusCovered: number;
      readonly paidColor: number;
      readonly paidWild: number;
    }[];
    readonly mandatoryMaster: number;
    readonly master: number;
    readonly virtualMaster: number;
  } | null;
  actionTake(state: GameState, colors: readonly Color[]): ActionResult;
  actionReserve(
    state: GameState,
    target: { readonly fromField: string } | { readonly fromDeck: BaseTier | PokemartTier },
  ): ActionResult<{ readonly cardId: string }>;
  actionCapture(state: GameState, cardId: string, options?: CaptureOptions): ActionResult;
  actionEvolve(
    state: GameState,
    fromId: string,
    toId?: string,
  ): ActionResult<{ readonly fromId: string; readonly toId: string }>;
  actionDiscard(state: GameState, color: TokenColor): ActionResult;
  actionPass(state: GameState): ActionResult;
  actionTakeMega(state: GameState): ActionResult;
  megaEvolveOptions(
    state: GameState,
    player: Player,
  ): readonly {
    readonly megaId: string;
    readonly fromId: string;
    readonly fromName: string;
    readonly megaName: string;
  }[];
  actionMegaEvolve(
    state: GameState,
    megaId: string,
    fromId?: string,
  ): ActionResult<{ readonly megaId: string; readonly fromId: string }>;
  fieldTiers(state: GameState): readonly (BaseTier | PokemartTier)[];
  isPokemart(card: Card | null | undefined): boolean;
  effBonusColor(state: GameState, player: Player, id: string): Color | null;
  freeTiers(card: Card): readonly (BaseTier | PokemartTier)[];
  freeTakeable(state: GameState, player: Player, card: Card): boolean;
  autoCaptureOpts(state: GameState, player: Player, card: Card): CaptureOptions;
  evolutionOptions(
    state: GameState,
    player: Player,
  ): readonly {
    readonly fromId: string;
    readonly toId: string;
    readonly color: Color;
    readonly count: number;
    readonly targetWhere: 'field' | 'reserve';
  }[];
  needsDiscard(state: GameState, player: Player): boolean;
  turnState(state: GameState): {
    readonly acted: boolean;
    readonly mustDiscard: number;
    readonly evolutions: readonly { readonly fromId: string; readonly toId: string }[];
    readonly megaEvolutions: ReturnType<EngineApi['megaEvolveOptions']>;
  };
  endTurn(state: GameState): ActionResult<{ readonly gameover?: true }>;
  determineWinner(state: GameState): number;
  legalActions(state: GameState): GameAction[];
  validActionShape(action: unknown): action is GameAction;
  applyAction(state: GameState, action: GameAction, playerId?: number): ActionResult;
  redactFor(state: GameState, viewerId: number): RedactedGameState;
  clone(state: GameState): GameState;
  zhBall(color: TokenColor): string;
  zhTier(tier: Tier): string;
  payDesc(payment: TokenCounts): string;
}

export type RoomClientMessage =
  | { readonly t: 'ping' | 'sync' | 'leave' | 'undo-request' }
  | { readonly t: 'join'; readonly name?: string; readonly token?: string }
  | {
      readonly t: 'start';
      readonly opts?: {
        readonly megas?: boolean;
        readonly pokemart?: boolean;
        readonly turnTimeoutMs?: number | null;
      };
    }
  | { readonly t: 'action'; readonly seq: number; readonly action: GameAction }
  | { readonly t: 'undo-vote'; readonly approve: boolean };

export type RoomServerMessage =
  | { readonly t: 'pong' }
  | {
      readonly t: 'welcome';
      readonly connId: string;
      readonly seat: number;
      readonly host: boolean;
      readonly token: string | null;
    }
  | {
      readonly t: 'roster';
      readonly players: readonly {
        readonly seat: number;
        readonly name: string;
        readonly connected: boolean;
      }[];
      readonly hostSeat: number;
      readonly started: boolean;
    }
  | {
      readonly t: 'state';
      readonly seq: number;
      readonly state: RedactedGameState;
      readonly turnStartedAt: number;
      readonly serverNow: number;
      readonly turnTimeoutMs: number | null;
      readonly undoAvailable: boolean;
    }
  | { readonly t: 'reject'; readonly reason: string; readonly seq?: number }
  | { readonly t: 'over'; readonly winner: number | null }
  | {
      readonly t: 'undo-vote';
      readonly requesterSeat: number;
      readonly approvals: readonly number[];
      readonly total: number;
    }
  | { readonly t: 'undo-result'; readonly accepted: boolean; readonly reason: string };

export interface RoomOptions {
  readonly cardDB: readonly Card[];
  readonly megaDB?: readonly Card[];
  readonly pokemartDB?: readonly Card[];
  readonly maxSeats?: number;
  readonly send?: (connectionId: string, message: RoomServerMessage) => void;
  readonly disconnect?: (connectionId: string) => void;
}

export interface RoomSnapshot {
  readonly seq: number;
  readonly started: boolean;
  readonly seats: readonly {
    readonly token: string | null;
    readonly name: string;
    readonly connId: null;
    readonly connected: false;
  }[];
  readonly turnStartedAt: number;
  readonly turnTimeoutMs?: number | null;
  readonly g: Omit<GameState, 'cardDB' | 'byId' | 'megaDB' | 'pokemartDB'> | null;
  readonly undoHistory: readonly Omit<GameState, 'cardDB' | 'byId' | 'megaDB' | 'pokemartDB'>[];
}

export interface RoomAuthority {
  now: number;
  readonly started: boolean;
  readonly seats: readonly {
    readonly token: string | null;
    readonly name: string;
    readonly connected: boolean;
  }[];
  join(connectionId: string, name: string, token: string): void;
  leave(connectionId: string): string | null;
  releaseDisconnectedSeat(token: string): boolean;
  resolveJoinToken(token: string | undefined, create: () => string): string;
  onMessage(connectionId: string, message: RoomClientMessage): void;
  nextTimeoutAt(): number | null;
  timeoutTurn(now: number, plan?: TurnPlan | ((state: GameState) => TurnPlan)): boolean;
  snapshot(): RoomSnapshot;
  restore(snapshot: RoomSnapshot): void;
}

export interface RoomApi {
  readonly Room: new (options: RoomOptions) => RoomAuthority;
  readonly TURN_TIMEOUT_MS: number;
  readonly TURN_TIMEOUT_OPTIONS: readonly number[];
  isTurnTimeoutMs(value: unknown): value is number;
}

export interface AiApi {
  readonly DIFF: Readonly<Record<'easy' | 'normal' | 'hard', AiConfig>>;
  chooseTurn(
    state: GameState,
    options?: { readonly difficulty?: 'easy' | 'normal' | 'hard' },
  ): TurnPlan;
  playTurn(
    state: GameState,
    options?: { readonly difficulty?: 'easy' | 'normal' | 'hard' },
  ): unknown;
  evalState(state: GameState, playerId: number, config: AiConfig | null): number;
  getWeights(): Readonly<Record<string, number>>;
  setWeights(weights: Readonly<Record<string, number>>): void;
}

export interface AiConfig {
  readonly evoBias: number;
  readonly noise: number;
  readonly proximity: number;
  readonly deny: number;
}

export interface VSearchApi {
  chooseTurn(
    state: GameState,
    options?: {
      readonly sims?: number;
      readonly timeMs?: number;
      readonly cpuct?: number;
      readonly oppK?: number;
      readonly endgame?: boolean;
    },
  ): TurnPlan;
}

export interface VSearchOptions {
  readonly sims?: number;
  readonly timeMs?: number;
  readonly cpuct?: number;
  readonly oppK?: number;
  readonly endgame?: boolean;
}
