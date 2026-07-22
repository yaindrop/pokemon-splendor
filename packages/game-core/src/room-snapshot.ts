import type { RoomSnapshot } from './api.js';
import type { Card, GameState } from './types.js';
import type { Seat, SerializedGameState, UndoVote } from './room-types.js';

export function serializeG(state: GameState): SerializedGameState {
  const {
    cardDB: _cardDB,
    byId: _byId,
    megaDB: _megaDB,
    pokemartDB: _pokemartDB,
    ...dynamic
  } = state;
  return structuredClone(dynamic);
}

export function reattachG(
  dynamic: SerializedGameState,
  cardDB: GameState['cardDB'],
  megaDB: GameState['megaDB'] = [],
  pokemartDB: GameState['pokemartDB'] = [],
): GameState {
  const byId: GameState['byId'] = {};
  for (const card of [...cardDB, ...megaDB, ...pokemartDB]) byId[card.id] = card;
  return { ...structuredClone(dynamic), cardDB, megaDB, pokemartDB, byId };
}

export interface RoomSnapshotHost {
  readonly DB: readonly Card[];
  readonly megaDB: readonly Card[];
  readonly pokemartDB: readonly Card[];
  G: GameState | null;
  seq: number;
  started: boolean;
  seats: Seat[];
  conns: Record<string, number>;
  turnStartedAt: number;
  turnTimeoutMs: number | null;
  undoHistory: SerializedGameState[];
  undoVote: UndoVote | null;
}

export function snapshotRoom(room: RoomSnapshotHost): RoomSnapshot {
  return {
    seq: room.seq,
    started: room.started,
    seats: room.seats.map((seat) => ({
      token: seat.token,
      name: seat.name,
      connId: null,
      connected: false,
    })),
    turnStartedAt: room.turnStartedAt,
    turnTimeoutMs: room.turnTimeoutMs,
    g: room.G ? serializeG(room.G) : null,
    undoHistory: room.undoHistory.slice(-20),
  };
}

export function restoreRoom(
  room: RoomSnapshotHost,
  snapshot: RoomSnapshot,
  legacyTimeoutMs: number,
  validTimeout: (value: unknown) => value is number,
): void {
  room.seq = snapshot.seq || 0;
  room.started = !!snapshot.started;
  room.turnStartedAt = snapshot.turnStartedAt || 0;
  room.turnTimeoutMs = Object.prototype.hasOwnProperty.call(snapshot, 'turnTimeoutMs')
    ? validTimeout(snapshot.turnTimeoutMs)
      ? snapshot.turnTimeoutMs
      : null
    : room.started
      ? legacyTimeoutMs
      : null;
  room.seats = (snapshot.seats || []).map((seat) => ({
    token: seat.token,
    name: seat.name,
    connId: null,
    connected: false,
  }));
  room.conns = {};
  room.G = snapshot.g ? reattachG(snapshot.g, room.DB, room.megaDB, room.pokemartDB) : null;
  room.undoHistory = snapshot.undoHistory.slice(-20);
  room.undoVote = null;
}
