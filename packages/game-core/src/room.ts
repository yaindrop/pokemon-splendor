/* =====================================================================
 * 璀璨宝石：宝可梦  —  online Room authority (pure, transport-agnostic)
 * ---------------------------------------------------------------------
 * Holds the canonical game state for ONE online room and turns inbound
 * player messages into outbound (per-player) messages. The SAME class runs
 * behind the Node WebSocket adapter and in headless tests — only the transport
 * differs. No WebSocket / DOM / storage code lives here, so it is unit-testable
 * through the same interface used in production (test/room.test.js).
 *
 * It injects a `send(connId, msg)` callback (the transport) and never reaches
 * out itself. Server-authoritative: every move is validated with the engine's
 * applyAction (ownership-guarded by seat) and each client only ever receives
 * `redactFor(G, seat)` — so hidden info (deck order, opponents' reserves) never
 * leaves the authority.
 *
 * Identity model (so reconnection works): a live transport connection is a
 * `connId` (ephemeral — a new WebSocket gets a new one). A PLAYER is a stable
 * `token` the client stores locally; a seat is bound to a token, so a new
 * connection presenting the same token reclaims its seat (and hidden hand).
 * Host = seat 0 (the first to join) — reconnect-safe, no connId tracking.
 *
 * Wire protocol (JSON):
 *   client → room:  {t:'join', name, token}      join / reclaim a seat by token
 *                   {t:'start', opts}            host (seat 0) starts the game
 *                   {t:'action', seq, action}    a move (action = engine {type,...})
 *                   {t:'sync'}                   resend my current redacted state
 *   room → client:  {t:'welcome', connId, seat, host}
 *                   {t:'roster', players:[{seat,name,connected}], hostSeat, started}
 *                   {t:'state', seq, state}      redacted snapshot for this viewer
 *                   {t:'reject', reason, seq}
 *                   {t:'over', winner}
 * ===================================================================== */
import E from './engine.js';
import type { RoomClientMessage, RoomOptions, RoomServerMessage, RoomSnapshot } from './api.js';
import type { Card, GameAction, GameState, TurnPlan } from './types.js';

type Seat = {
  token: string | null;
  name: string;
  connId: string | null;
  connected: boolean;
};

type UndoVote = { requesterSeat: number; approvals: number[] };
type SerializedGameState = Omit<GameState, 'cardDB' | 'byId' | 'megaDB' | 'pokemartDB'>;
type StartOptions = Extract<RoomClientMessage, { readonly t: 'start' }>['opts'];
type ActionMessage = Extract<RoomClientMessage, { readonly t: 'action' }>;
type TakeoverPlan = Pick<TurnPlan, 'action' | 'discards' | 'evolution' | 'megaEvolution'>;
type RoomInboundMessage =
  RoomClientMessage | { readonly t: 'takeover'; readonly plan?: Partial<TakeoverPlan> };

// Optional idle/disconnect takeover. New rooms default to OFF; these bounded
// choices keep room timers predictable and match the creation UI.
const TURN_TIMEOUT_MS = 180000; // legacy default for snapshots made before this setting existed
const TURN_TIMEOUT_OPTIONS = [60000, 180000, 300000, 600000] as const;
const isTurnTimeoutMs = (value: unknown): value is number =>
  typeof value === 'number' && TURN_TIMEOUT_OPTIONS.some((option) => option === value);

// strip the shared static card refs so a room state is pure data we can persist
function serializeG(s: GameState): SerializedGameState {
  const { cardDB: _cardDB, byId: _byId, megaDB: _megaDB, pokemartDB: _pokemartDB, ...dyn } = s;
  return structuredClone(dyn);
}
function reattachG(
  dyn: SerializedGameState,
  DB: GameState['cardDB'],
  megaDB: GameState['megaDB'] = [],
  pokemartDB: GameState['pokemartDB'] = [],
): GameState {
  const byId: GameState['byId'] = {};
  for (const card of [...DB, ...megaDB, ...pokemartDB]) byId[card.id] = card;
  return { ...structuredClone(dyn), cardDB: DB, megaDB, pokemartDB, byId };
}

class Room {
  readonly DB: readonly Card[];
  readonly megaDB: readonly Card[];
  readonly pokemartDB: readonly Card[];
  readonly maxSeats: number;
  readonly send: (connectionId: string, message: RoomServerMessage) => void;
  readonly disconnect: (connectionId: string) => void;
  G: GameState | null;
  seq: number;
  started: boolean;
  seats: Seat[];
  conns: Record<string, number>;
  turnStartedAt: number;
  turnTimeoutMs: number | null;
  now: number;
  undoHistory: SerializedGameState[];
  undoVote: UndoVote | null;

  constructor(opts: RoomOptions) {
    this.DB = opts.cardDB;
    this.megaDB = opts.megaDB ?? [];
    this.pokemartDB = opts.pokemartDB ?? [];
    this.maxSeats = opts.maxSeats ?? 4;
    this.send = opts.send ?? (() => undefined); // (connId, msgObj) => void
    this.disconnect = opts.disconnect ?? (() => undefined); // revoke a superseded live connection
    this.G = null;
    this.seq = 0;
    this.started = false;
    this.seats = []; // seats[i] = { token, name, connId|null, connected }
    this.conns = {}; // live connId -> seat index (>=0 seated, -1 spectator)
    this.turnStartedAt = 0; // server ms when the current turn began (idle-timeout base)
    this.turnTimeoutMs = null; // null = no automatic AI takeover
    this.now = 0; // current server ms, injected by the DO before each handler
    this.undoHistory = []; // authoritative snapshots at the start of each turn
    this.undoVote = null; // ephemeral unanimous vote; never survives a restart
  }

  // ----------------------------- connections -----------------------------
  join(connId: string, name = '', token = ''): number {
    // reconnect: a seat already bound to this stable token
    let seat = token != null ? this.seats.findIndex((s) => s.token === token) : -1;
    if (seat < 0) {
      // a new player
      if (this.started)
        seat = -1; // can't take a seat mid-game → spectator
      else {
        seat = this.seats.findIndex((s) => s.token == null); // a freed seat
        if (seat < 0 && this.seats.length < this.maxSeats) {
          // else open a new one
          seat = this.seats.length;
          this.seats.push({ token: null, name: '', connId: null, connected: false });
        }
      }
    }
    if (seat >= 0) {
      const st = this.seats[seat];
      if (!st) throw new Error(`未知房间席位：${seat}`);
      const oldConnId = st.connId;
      if (oldConnId && oldConnId !== connId) {
        delete this.conns[oldConnId];
        this.disconnect(oldConnId);
      }
      st.token = token || st.token || 'seat' + seat;
      st.connId = connId;
      st.name = name || st.name || '训练家 ' + (seat + 1);
      st.connected = true;
      this.conns[connId] = seat;
    } else {
      this.conns[connId] = -1; // spectator
    }
    this._welcome(connId);
    this._roster();
    if (this.started) this._stateTo(connId); // reconnect → resend snapshot
    return this.conns[connId];
  }

  resolveJoinToken(presentedToken: string | undefined, mintToken: () => string): string {
    if (
      typeof presentedToken === 'string' &&
      this.seats.some((seat) => seat.token === presentedToken)
    ) {
      return presentedToken;
    }
    return mintToken();
  }

  leave(connId: string): string | null {
    const seat = this.conns[connId];
    let reconnectToken = null;
    const playerSeat = seat == null || seat < 0 ? undefined : this.seats[seat];
    if (playerSeat) {
      if (!this.started) reconnectToken = playerSeat.token;
      playerSeat.connected = false;
      playerSeat.connId = null; // keep token → seat reclaimable
    }
    delete this.conns[connId];
    if (this.undoVote) this._cancelUndo('有玩家离线，悔棋已取消');
    this._roster();
    return reconnectToken;
  }

  leaveSeat(connId: string): boolean | string | null {
    const seat = this.conns[connId];
    if (seat == null || seat < 0) {
      delete this.conns[connId];
      return false;
    }
    if (this.started) return this.leave(connId);
    this.seats.splice(seat, 1);
    delete this.conns[connId];
    this._reindexConnections();
    this._roster();
    return true;
  }

  releaseDisconnectedSeat(token: string): boolean {
    if (this.started) return false;
    const seat = this.seats.findIndex(
      (candidate) => candidate.token === token && !candidate.connected,
    );
    if (seat < 0) return false;
    this.seats.splice(seat, 1);
    this._reindexConnections();
    this._roster();
    return true;
  }

  _welcome(connId: string): void {
    const seat = this.conns[connId];
    this.send(connId, {
      t: 'welcome',
      connId,
      seat: seat ?? -1,
      host: seat === 0,
      token: seat != null && seat >= 0 ? (this.seats[seat]?.token ?? null) : null,
    });
  }

  _reindexConnections(): void {
    this.conns = {};
    this.seats.forEach((seat, index) => {
      if (!seat.connId) return;
      this.conns[seat.connId] = index;
      this._welcome(seat.connId);
    });
  }

  // Quiet transport re-attach after the DO hibernates: restore a connId→seat
  // mapping by token ONLY — no welcome/roster/state side-effects (those happen
  // when the client itself re-sends join/sync on a real reconnect). Works even
  // before the game has started, so a lobby that hibernated isn't bricked.
  rebind(connId: string, token: string | undefined): number {
    const seat = token != null ? this.seats.findIndex((s) => s.token === token) : -1;
    const playerSeat = seat >= 0 ? this.seats[seat] : undefined;
    if (playerSeat) {
      playerSeat.connId = connId;
      playerSeat.connected = true;
      this.conns[connId] = seat;
    } else this.conns[connId] = -1;
    return this.conns[connId];
  }

  // ------------------------------- messages ------------------------------
  onMessage(connId: string, msg: RoomInboundMessage): unknown {
    switch (msg.t) {
      case 'join':
        return this.join(connId, msg.name ?? '', msg.token ?? '');
      case 'start': {
        this._start(connId, msg.opts);
        return;
      }
      case 'action': {
        this._action(connId, msg);
        return;
      }
      case 'undo-request': {
        this._requestUndo(connId);
        return;
      }
      case 'undo-vote':
        return this._voteUndo(connId, msg.approve);
      case 'takeover':
        return this._takeover(connId, msg);
      case 'leave':
        return this.leaveSeat(connId);
      case 'sync': {
        this._stateTo(connId);
        return;
      }
      case 'ping': {
        this.send(connId, { t: 'pong' });
        return;
      }
    }
  }

  _start(connId: string, opts: StartOptions = {}): void {
    if (this.conns[connId] !== 0) {
      this.send(connId, { t: 'reject', reason: '只有房主可以开始游戏' });
      return;
    }
    if (this.started) {
      this._stateTo(connId);
      return;
    }
    const connectedSeats = this.seats.filter((s) => s.connected && s.connId);
    if (connectedSeats.length < 2) {
      this.send(connId, { t: 'reject', reason: '至少需要 2 名在线玩家' });
      return;
    }
    if (connectedSeats.length !== this.seats.length) {
      this.seats = connectedSeats;
      this._reindexConnections();
    }
    this.turnTimeoutMs = isTurnTimeoutMs(opts.turnTimeoutMs) ? opts.turnTimeoutMs : null;
    const names = this.seats.map((s, i) => s.name || '训练家 ' + (i + 1));
    // server-authoritative RNG: NEVER trust a client-supplied seed — it would let
    // the host precompute the entire deck order. Mint it here; fall back to the
    // engine's own random seed if Web Crypto is somehow unavailable.
    const seed = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
    const gameOptions = {
      numPlayers: this.seats.length,
      names,
      ai: this.seats.map(() => false), // all-human online
      megas: !!opts.megas,
      megaDB: this.megaDB,
      pokemart: !!opts.pokemart,
      pokemartDB: this.pokemartDB,
      ...(seed == null ? {} : { seed: seed >>> 0 }),
    };
    this.G = E.createGame(this.DB, gameOptions);
    this.started = true;
    this.turnStartedAt = this.now;
    this.undoHistory = [serializeG(this.G)];
    this.seq++;
    this._roster();
    this._broadcastState();
  }

  _action(connId: string, msg: ActionMessage): void {
    const seat = this.conns[connId];
    if (!this.started || seat == null || seat < 0) {
      this.send(connId, { t: 'reject', reason: '未入座或对局未开始', seq: msg && msg.seq });
      return;
    }
    if (this.undoVote) {
      this.send(connId, { t: 'reject', reason: '悔棋投票中，请先完成投票', seq: msg.seq });
      return;
    }
    const game = this.G;
    if (!game) {
      this.send(connId, { t: 'reject', reason: '对局状态不存在', seq: msg.seq });
      return;
    }
    const prevTurn = game.turn;
    const r = E.applyAction(game, msg.action, seat); // seat = ownership guard
    if (!r.ok) {
      this.send(connId, { t: 'reject', reason: r.error, seq: msg.seq });
      return;
    }
    if (game.turn !== prevTurn) {
      this.turnStartedAt = this.now; // turn advanced → reset idle clock
      this._rememberTurnStart();
    }
    this.seq++;
    this._broadcastState();
    if (game.phase === 'gameover') this._broadcast({ t: 'over', winner: game.winner });
  }

  // The host's AI takes over a timed-out active seat. The host computes the move
  // from PUBLIC info only (it never sees the timed-out player's hidden hand) and
  // sends the plan here; the server validates host + that the configured timeout has
  // truly elapsed (anti-cheat), then runs the whole turn for the active seat.
  _takeover(connId: string, msg: Extract<RoomInboundMessage, { readonly t: 'takeover' }>): unknown {
    if (this.conns[connId] !== 0) {
      this.send(connId, { t: 'reject', reason: '只有房主可以代打' });
      return;
    }
    if (!this.started || !this.G || this.G.phase !== 'play') return false;
    if (!this.turnTimeoutMs) {
      this.send(connId, { t: 'reject', reason: '本房间未启用超时接管' });
      return;
    }
    if (this.now - this.turnStartedAt < this.turnTimeoutMs) {
      this.send(connId, { t: 'reject', reason: '尚未超时' });
      return false;
    }
    return this._performTakeover((msg && msg.plan) || {});
  }

  // Production servers call this directly from their own timer, so progress no
  // longer depends on the host browser staying online and submitting an AI plan.
  timeoutTurn(
    now: number,
    planOrFactory: Partial<TakeoverPlan> | ((state: GameState) => Partial<TakeoverPlan>) = {},
  ): boolean {
    this.now = now;
    if (!this.turnTimeoutMs || !this.started || !this.G || this.G.phase !== 'play' || this.undoVote)
      return false;
    if (this.now - this.turnStartedAt < this.turnTimeoutMs) return false;
    let plan: Partial<TakeoverPlan> = typeof planOrFactory === 'function' ? {} : planOrFactory;
    if (typeof planOrFactory === 'function') {
      try {
        plan = planOrFactory(this.G);
      } catch {
        plan = {};
      }
    }
    return this._performTakeover(plan);
  }

  nextTimeoutAt(): number | null {
    if (!this.turnTimeoutMs || !this.started || !this.G || this.G.phase !== 'play' || this.undoVote)
      return null;
    if (!this.seats.some((seat) => seat.connected)) return null;
    return this.turnStartedAt + this.turnTimeoutMs;
  }

  _performTakeover(plan: Partial<TakeoverPlan>): boolean {
    const game = this.G;
    if (!game) return false;
    const seat = game.turn;
    const player = game.players[seat];
    if (!player) return false;
    game.log.push({
      turn: game.turn,
      round: game.round,
      msg: `⏱️ ${player.name} 超时，服务器AI代打`,
    });
    // main action (AI's pick, else any legal action, else a legitimate pass) — always acts
    let acted = false;
    try {
      if (plan.action) acted = E.applyAction(game, plan.action, seat).ok;
    } catch {
      /* fall back below */
    }
    if (!acted) {
      let legal: GameAction[] = [];
      try {
        legal = E.legalActions(game);
      } catch {
        /* use pass fallback */
      }
      const fallback = legal[0];
      if (fallback) {
        try {
          acted = E.applyAction(game, fallback, seat).ok;
        } catch {
          /* use pass fallback */
        }
      }
      if (!acted) {
        try {
          E.actionPass(game);
        } catch {
          /* endTurn will validate */
        }
      }
    }
    // discards (AI plan, then a forced fallback if still over the cap)
    if (plan.discards)
      for (const col of plan.discards) {
        try {
          E.actionDiscard(game, col);
        } catch {
          /* forced fallback follows */
        }
      }
    let guard = 0;
    while (E.needsDiscard(game, player) && guard++ < 20) {
      const tok = E.ALL_TOKENS.find((c) => player.tokens[c] > 0);
      if (!tok) break;
      try {
        E.actionDiscard(game, tok);
      } catch {
        break;
      }
    }
    if (plan.megaEvolution) {
      try {
        E.actionMegaEvolve(game, plan.megaEvolution.megaId, plan.megaEvolution.fromId);
      } catch {
        /* optional */
      }
    } else if (plan.evolution) {
      try {
        E.actionEvolve(game, plan.evolution.fromId, plan.evolution.toId);
      } catch {
        /* optional */
      }
    }
    try {
      E.endTurn(game);
    } catch {
      /* state broadcast exposes failure */
    }
    this.turnStartedAt = this.now;
    this._rememberTurnStart();
    this.seq++;
    this._broadcastState();
    if (game.phase === 'gameover') this._broadcast({ t: 'over', winner: game.winner });
    return true;
  }

  // --------------------------- unanimous undo ---------------------------
  _rememberTurnStart(): void {
    if (!this.G) return;
    this.undoHistory.push(serializeG(this.G));
    if (this.undoHistory.length > 20) this.undoHistory.shift();
  }

  _undoAvailable(): boolean {
    if (!this.started || !this.G || this.G.phase !== 'play') return false;
    return !!this.G.acted || this.undoHistory.length > 1;
  }

  _requestUndo(connId: string): void {
    const seat = this.conns[connId];
    if (seat == null || seat < 0) {
      this.send(connId, { t: 'reject', reason: '只有入座玩家可以发起悔棋' });
      return;
    }
    if (this.undoVote) {
      this.send(connId, { t: 'reject', reason: '已有悔棋投票进行中' });
      return;
    }
    if (!this._undoAvailable()) {
      this.send(connId, { t: 'reject', reason: '当前没有可撤销的行动' });
      return;
    }
    if (this.seats.some((s) => !s.connected || !s.connId)) {
      this.send(connId, { t: 'reject', reason: '所有玩家在线时才能悔棋' });
      return;
    }
    this.undoVote = { requesterSeat: seat, approvals: [seat] };
    this._broadcastUndoVote();
  }

  _voteUndo(connId: string, approve: boolean): unknown {
    const seat = this.conns[connId];
    if (!this.undoVote || seat == null || seat < 0) {
      this.send(connId, { t: 'reject', reason: '当前没有待处理的悔棋投票' });
      return;
    }
    const votingSeat = this.seats[seat];
    if (!votingSeat) {
      this.send(connId, { t: 'reject', reason: '席位不存在' });
      return;
    }
    if (!approve) return this._cancelUndo(`${votingSeat.name} 拒绝了悔棋`);
    if (!this.undoVote.approvals.includes(seat)) this.undoVote.approvals.push(seat);
    if (this.undoVote.approvals.length < this.seats.length) {
      this._broadcastUndoVote();
      return;
    }

    const currentGame = this.G;
    if (!currentGame) return this._cancelUndo('对局状态不存在');
    const midTurn = currentGame.acted;
    if (!midTurn) this.undoHistory.pop();
    const snap = this.undoHistory[this.undoHistory.length - 1];
    if (!snap) return this._cancelUndo('没有可恢复的回合');
    this.G = reattachG(snap, this.DB, this.megaDB, this.pokemartDB);
    this.G.log.push({
      turn: this.G.turn,
      round: this.G.round,
      msg: '↩️ 全员同意，已撤销上一回合',
      kind: 'undo',
    });
    this.undoHistory[this.undoHistory.length - 1] = serializeG(this.G);
    this.undoVote = null;
    this.turnStartedAt = this.now;
    this.seq++;
    this._broadcast({ t: 'undo-result', accepted: true, reason: '全员同意，悔棋成功' });
    this._broadcastState();
    return true;
  }

  _broadcastUndoVote(): void {
    const vote = this.undoVote;
    if (!vote) return;
    this._broadcast({
      t: 'undo-vote',
      requesterSeat: vote.requesterSeat,
      approvals: vote.approvals.slice(),
      total: this.seats.length,
    });
  }

  _cancelUndo(reason: string): boolean {
    if (!this.undoVote) return false;
    this.undoVote = null;
    this._broadcast({ t: 'undo-result', accepted: false, reason: reason || '悔棋已取消' });
    return false;
  }

  // ------------------------------- outbound ------------------------------
  _broadcastState(): void {
    for (const cid in this.conns) this._stateTo(cid);
  }
  _stateTo(connId: string): void {
    if (!this.started || !this.G) return;
    const seat = this.conns[connId];
    const view = seat != null && seat >= 0 ? seat : -1; // spectators: -1 matches no seat → everything stays redacted
    this.send(connId, {
      t: 'state',
      seq: this.seq,
      state: E.redactFor(this.G, view),
      turnStartedAt: this.turnStartedAt,
      serverNow: this.now,
      turnTimeoutMs: this.turnTimeoutMs,
      undoAvailable: this._undoAvailable(),
    });
  }
  _roster(): void {
    const players = this.seats.map((s, i) => ({ seat: i, name: s.name, connected: s.connected }));
    this._broadcast({ t: 'roster', players, hostSeat: 0, started: this.started });
  }
  _broadcast(msg: RoomServerMessage): void {
    for (const cid in this.conns) this.send(cid, msg);
  }

  // ----------------------- persistence (for the DO) ----------------------
  // The DO snapshots this to durable storage and restores it on wake, so a
  // room survives eviction/restart. Live connections (conns) are NOT persisted
  // — clients reconnect with their token and re-sync. Seats keep their token,
  // so reconnecting players reclaim their seat and hidden hand.
  snapshot(): RoomSnapshot {
    const seats: RoomSnapshot['seats'] = this.seats.map((s) => ({
      token: s.token,
      name: s.name,
      connId: null,
      connected: false,
    }));
    return {
      seq: this.seq,
      started: this.started,
      seats,
      turnStartedAt: this.turnStartedAt,
      turnTimeoutMs: this.turnTimeoutMs,
      g: this.G ? serializeG(this.G) : null,
      undoHistory: this.undoHistory.slice(-20),
    };
  }
  restore(snap: RoomSnapshot): void {
    this.seq = snap.seq || 0;
    this.started = !!snap.started;
    this.turnStartedAt = snap.turnStartedAt || 0;
    // Old persisted games had an implicit 3-minute timer and no field; preserve
    // their live rule while all newly-created rooms default to no timeout.
    this.turnTimeoutMs = Object.prototype.hasOwnProperty.call(snap, 'turnTimeoutMs')
      ? isTurnTimeoutMs(snap.turnTimeoutMs)
        ? snap.turnTimeoutMs
        : null
      : this.started
        ? TURN_TIMEOUT_MS
        : null;
    this.seats = (snap.seats || []).map((s) => ({
      token: s.token,
      name: s.name,
      connId: null,
      connected: false,
    }));
    this.conns = {};
    this.G = snap.g ? reattachG(snap.g, this.DB, this.megaDB, this.pokemartDB) : null;
    this.undoHistory = snap.undoHistory.slice(-20);
    this.undoVote = null;
  }
}

const RoomApi = {
  Room,
  serializeG,
  reattachG,
  TURN_TIMEOUT_MS,
  TURN_TIMEOUT_OPTIONS,
  isTurnTimeoutMs,
};

export { Room, TURN_TIMEOUT_MS, TURN_TIMEOUT_OPTIONS, isTurnTimeoutMs, reattachG, serializeG };
export default RoomApi;
