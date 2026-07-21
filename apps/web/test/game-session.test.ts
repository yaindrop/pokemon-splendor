import {
  cards as DB,
  megas as MEGA_DB,
  pokemart as POKEMART_DB,
} from '@pokemon-splendor/game-data';
import { Engine as E, type GameAction, type RoomClientMessage } from '@pokemon-splendor/game-core';
import { isServerMessage } from '@pokemon-splendor/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetApi, NetEventMap, RoomStartOptions } from '../src/net.js';
import { uiStore, setActiveGameSession, gameSessionSnapshotAtom } from '../src/react/uiStore.js';
import { LocalGameSession } from '../src/session/localGameSession.js';
import { OnlineGameSession } from '../src/session/onlineGameSession.js';

type NetEvent = keyof NetEventMap;

class FakeNet implements NetApi {
  private readonly handlers = new Map<NetEvent, (data: unknown) => void>();

  connection: { readonly code: string; readonly name: string } | null = null;
  readonly actions: GameAction[] = [];
  closed = false;

  connect(code: string, name: string): void {
    this.connection = { code, name };
  }

  on<K extends NetEvent>(event: K, handler: (data: NetEventMap[K]) => void): () => void {
    const wrapped = (data: unknown): void => {
      if (isFakeEventPayload(event, data)) handler(data);
    };
    this.handlers.set(event, wrapped);
    return (): void => {
      if (this.handlers.get(event) === wrapped) this.handlers.delete(event);
    };
  }

  emit<K extends NetEvent>(event: K, data: NetEventMap[K]): void {
    this.handlers.get(event)?.(data);
  }

  send(_message: RoomClientMessage): void {}

  action(move: GameAction): void {
    this.actions.push(move);
  }

  start(_options?: RoomStartOptions): void {}

  sync(): void {}

  requestUndo(): void {}

  voteUndo(_approve: boolean): void {}

  close(): void {
    this.closed = true;
  }

  leave(): void {}

  createRoom(): Promise<string> {
    return Promise.resolve('TESTROOM');
  }

  isOpen(): boolean {
    return !this.closed;
  }
}

function isFakeEventPayload<K extends NetEvent>(event: K, data: unknown): data is NetEventMap[K] {
  if (event === 'status') {
    return data === 'connecting' || data === 'connected' || data === 'disconnected';
  }
  return isServerMessage(data) && data.t === event;
}

const catalog = {
  cardDB: DB,
  byId: Object.fromEntries([...DB, ...MEGA_DB, ...POKEMART_DB].map((card) => [card.id, card])),
  megaDB: MEGA_DB,
  pokemartDB: POKEMART_DB,
};

afterEach(() => {
  setActiveGameSession(null);
});

describe('game sessions', () => {
  it('keeps local game mutations behind one subscribable session', () => {
    const session = new LocalGameSession(E.createGame(DB, { numPlayers: 2 }));
    let updates = 0;
    const unsubscribe = session.subscribe(() => {
      updates += 1;
    });
    setActiveGameSession(session);

    const dispatched = session.dispatch({ type: 'take', colors: ['red', 'blue', 'black'] });
    if (dispatched.kind !== 'applied') throw new Error('本地行动没有立即结算');

    expect(dispatched.result.ok).toBe(true);
    expect(session.getSnapshot().state?.players[0]?.tokens.red).toBe(1);
    expect(uiStore.get(gameSessionSnapshotAtom)?.revision).toBe(1);
    expect(updates).toBe(1);
    unsubscribe();
    session.dispose();
  });

  it('materializes authoritative network snapshots and never mutates them locally', () => {
    const net = new FakeNet();
    const session = new OnlineGameSession({
      net,
      code: 'ROOM42',
      name: '训练家 1',
      catalog,
      host: true,
    });
    session.connect();
    expect(net.connection).toEqual({ code: 'ROOM42', name: '训练家 1' });

    net.emit('welcome', {
      t: 'welcome',
      connId: 'connection-1',
      seat: 0,
      host: true,
      token: null,
    });
    const state = E.createGame(DB, { numPlayers: 2 });
    net.emit('state', {
      t: 'state',
      seq: 7,
      state: E.redactFor(state, 0),
      turnStartedAt: 100,
      serverNow: 200,
      turnTimeoutMs: null,
      undoAvailable: true,
    });

    const snapshot = session.getSnapshot();
    expect(snapshot.online?.seat).toBe(0);
    expect(snapshot.online?.stateSequence).toBe(7);
    expect(snapshot.state?.players[0]?.reserve).toEqual(state.players[0]?.reserve);

    const dispatched = session.dispatch({ type: 'take', colors: ['red', 'blue', 'black'] });
    expect(dispatched).toEqual({ kind: 'pending' });
    expect(net.actions).toEqual([{ type: 'take', colors: ['red', 'blue', 'black'] }]);

    net.emit('reject', { t: 'reject', reason: '不是你的回合' });
    expect(session.getSnapshot().online?.notice).toEqual({
      kind: 'reject',
      message: '不是你的回合',
    });
    session.dispose();
    expect(net.closed).toBe(true);
  });
});
