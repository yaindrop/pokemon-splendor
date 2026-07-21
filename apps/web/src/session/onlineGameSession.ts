import type {
  Card,
  GameAction,
  GameState,
  RedactedGameState,
  RoomServerMessage,
} from '@pokemon-splendor/game-core';
import type { NetApi, RoomStartOptions } from '../net.js';
import type {
  GameSession,
  GameSessionDispatchResult,
  GameSessionListener,
  GameSessionSnapshot,
  OnlineSessionNotice,
  OnlineSessionState,
} from './types.js';

export interface NetworkCardCatalog {
  readonly cardDB: readonly Card[];
  readonly byId: Record<string, Card>;
  readonly megaDB: readonly Card[];
  readonly pokemartDB: readonly Card[];
}

export interface OnlineGameSessionOptions {
  readonly net: NetApi;
  readonly code: string;
  readonly name: string;
  readonly catalog: NetworkCardCatalog;
  readonly host: boolean;
}

type StateMessage = Extract<RoomServerMessage, { readonly t: 'state' }>;

export function materializeNetworkState(
  state: RedactedGameState,
  catalog: NetworkCardCatalog,
): GameState {
  const { viewerId: _viewerId, ...dynamic } = state;
  return {
    ...dynamic,
    players: state.players.map((player) => ({
      ...player,
      reserve: player.reserve.map((card, slot) =>
        typeof card === 'string' ? card : hiddenReserveId(card.tier, slot),
      ),
    })),
    cardDB: catalog.cardDB,
    byId: catalog.byId,
    megaDB: catalog.megaDB,
    pokemartDB: catalog.pokemartDB,
  };
}

const HIDDEN_RESERVE_PREFIX = '__hidden_reserve__';

function hiddenReserveId(tier: string, slot: number): string {
  return `${HIDDEN_RESERVE_PREFIX}:${tier}:${slot}`;
}

export class OnlineGameSession implements GameSession {
  readonly mode = 'online';

  private readonly listeners = new Set<GameSessionListener>();
  private readonly unbinds: Array<() => void>;
  private state: GameState | null = null;
  private revision = 0;
  private snapshot: GameSessionSnapshot;
  private online: OnlineSessionState;

  constructor(private readonly options: OnlineGameSessionOptions) {
    this.online = {
      code: options.code,
      name: options.name,
      seat: null,
      host: options.host,
      status: 'connecting',
      started: false,
      roster: [],
      undoAvailable: false,
      undoVote: null,
      turnStartedAt: 0,
      serverNow: 0,
      turnTimeoutMs: 0,
      stateAt: Date.now(),
      stateSequence: 0,
      notice: null,
      noticeRevision: 0,
    };
    this.snapshot = this.createSnapshot();
    this.unbinds = [
      options.net.on('status', (status) => {
        this.online = { ...this.online, status };
        this.publish();
      }),
      options.net.on('welcome', (message) => {
        this.online = { ...this.online, seat: message.seat, host: message.host };
        this.publish();
      }),
      options.net.on('roster', (message) => {
        this.online = {
          ...this.online,
          roster: message.players.map((player) => ({
            seat: player.seat,
            name: player.name,
            connected: player.connected,
          })),
          started: message.started,
        };
        this.publish();
      }),
      options.net.on('state', (message) => {
        this.applyState(message);
      }),
      options.net.on('reject', (message) => {
        this.setNotice({ kind: 'reject', message: message.reason || '操作被拒绝' });
      }),
      options.net.on('undo-vote', (message) => {
        this.online = {
          ...this.online,
          undoVote: {
            requesterSeat: message.requesterSeat,
            approvals: message.approvals,
            total: message.total,
          },
        };
        this.publish();
      }),
      options.net.on('undo-result', (message) => {
        this.online = { ...this.online, undoVote: null };
        this.setNotice({
          kind: 'undo-result',
          accepted: message.accepted,
          message: message.reason || (message.accepted ? '悔棋成功' : '悔棋已取消'),
        });
      }),
    ];
  }

  connect(): void {
    this.options.net.connect(this.online.code, this.online.name);
  }

  start(options: RoomStartOptions): void {
    this.options.net.start(options);
  }

  requestUndo(): void {
    this.options.net.requestUndo();
  }

  voteUndo(approve: boolean): void {
    this.options.net.voteUndo(approve);
  }

  leave(): void {
    this.options.net.leave();
  }

  getSnapshot(): GameSessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: GameSessionListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  dispatch(action: GameAction): GameSessionDispatchResult {
    this.options.net.action(action);
    return { kind: 'pending' };
  }

  dispose(): void {
    for (const unbind of this.unbinds) unbind();
    this.options.net.close();
    this.listeners.clear();
  }

  private applyState(message: StateMessage): void {
    this.state = materializeNetworkState(message.state, this.options.catalog);
    this.online = {
      ...this.online,
      started: true,
      turnStartedAt: message.turnStartedAt,
      serverNow: message.serverNow,
      turnTimeoutMs: message.turnTimeoutMs ?? 0,
      undoAvailable: message.undoAvailable,
      stateAt: Date.now(),
      stateSequence: message.seq,
    };
    this.publish();
  }

  private setNotice(notice: OnlineSessionNotice): void {
    this.online = {
      ...this.online,
      notice,
      noticeRevision: this.online.noticeRevision + 1,
    };
    this.publish();
  }

  private createSnapshot(): GameSessionSnapshot {
    return {
      mode: this.mode,
      revision: this.revision,
      state: this.state,
      online: this.online,
    };
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }
}
