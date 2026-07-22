import type { RoomServerMessage } from './api.js';
import type { Seat } from './room-types.js';

export interface RoomConnectionHost {
  readonly maxSeats: number;
  readonly send: (connectionId: string, message: RoomServerMessage) => void;
  readonly disconnect: (connectionId: string) => void;
  started: boolean;
  seats: Seat[];
  conns: Record<string, number>;
  _reindexConnections(): void;
  _roster(): void;
  _stateTo(connectionId: string): void;
  _welcome(connectionId: string): void;
  leave(connectionId: string): string | null;
}

export function joinRoom(
  room: RoomConnectionHost,
  connectionId: string,
  name = '',
  token = '',
): number {
  let seat = token !== '' ? room.seats.findIndex((candidate) => candidate.token === token) : -1;
  if (seat < 0) {
    if (room.started) seat = -1;
    else {
      seat = room.seats.findIndex((candidate) => candidate.token === null);
      if (seat < 0 && room.seats.length < room.maxSeats) {
        seat = room.seats.length;
        room.seats.push({ token: null, name: '', connId: null, connected: false });
      }
    }
  }
  if (seat >= 0) {
    const playerSeat = room.seats[seat];
    if (!playerSeat) throw new Error(`未知房间席位：${seat}`);
    const oldConnectionId = playerSeat.connId;
    if (oldConnectionId && oldConnectionId !== connectionId) {
      delete room.conns[oldConnectionId];
      room.disconnect(oldConnectionId);
    }
    playerSeat.token = token || playerSeat.token || `seat${seat}`;
    playerSeat.connId = connectionId;
    playerSeat.name = name || playerSeat.name || `训练家 ${seat + 1}`;
    playerSeat.connected = true;
    room.conns[connectionId] = seat;
  } else {
    room.conns[connectionId] = -1;
  }
  room._welcome(connectionId);
  room._roster();
  if (room.started) room._stateTo(connectionId);
  return room.conns[connectionId] ?? -1;
}

export function resolveJoinToken(
  room: Pick<RoomConnectionHost, 'seats'>,
  presentedToken: string | undefined,
  mintToken: () => string,
): string {
  if (
    typeof presentedToken === 'string' &&
    room.seats.some((seat) => seat.token === presentedToken)
  ) {
    return presentedToken;
  }
  return mintToken();
}

export function leaveSeat(room: RoomConnectionHost, connectionId: string): boolean | string | null {
  const seat = room.conns[connectionId];
  if (seat == null || seat < 0) {
    delete room.conns[connectionId];
    return false;
  }
  if (room.started) return room.leave(connectionId);
  room.seats.splice(seat, 1);
  delete room.conns[connectionId];
  room._reindexConnections();
  room._roster();
  return true;
}

export function releaseDisconnectedSeat(room: RoomConnectionHost, token: string): boolean {
  if (room.started) return false;
  const seat = room.seats.findIndex(
    (candidate) => candidate.token === token && !candidate.connected,
  );
  if (seat < 0) return false;
  room.seats.splice(seat, 1);
  room._reindexConnections();
  room._roster();
  return true;
}

export function rebindConnection(
  room: Pick<RoomConnectionHost, 'conns' | 'seats'>,
  connectionId: string,
  token: string | undefined,
): number {
  const seat =
    token !== undefined ? room.seats.findIndex((candidate) => candidate.token === token) : -1;
  const playerSeat = seat >= 0 ? room.seats[seat] : undefined;
  if (playerSeat) {
    playerSeat.connId = connectionId;
    playerSeat.connected = true;
    room.conns[connectionId] = seat;
  } else {
    room.conns[connectionId] = -1;
  }
  return room.conns[connectionId] ?? -1;
}
