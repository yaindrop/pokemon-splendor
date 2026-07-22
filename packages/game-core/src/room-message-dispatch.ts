import type { RoomServerMessage } from './api.js';
import type { ActionMessage, RoomInboundMessage, StartOptions } from './room-types.js';

export interface RoomMessageHost {
  join(connectionId: string, name?: string, token?: string): number;
  leave(connectionId: string): string | null;
  leaveSeat(connectionId: string): boolean | string | null;
  send(connectionId: string, message: RoomServerMessage): void;
  _action(connectionId: string, message: ActionMessage): void;
  _requestUndo(connectionId: string): void;
  _start(connectionId: string, options?: StartOptions): void;
  _stateTo(connectionId: string): void;
  _takeover(
    connectionId: string,
    message: Extract<RoomInboundMessage, { readonly t: 'takeover' }>,
  ): unknown;
  _voteUndo(connectionId: string, approve: boolean): unknown;
}

export function dispatchRoomMessage(
  room: RoomMessageHost,
  connectionId: string,
  message: RoomInboundMessage,
): unknown {
  switch (message.t) {
    case 'join':
      return room.join(connectionId, message.name ?? '', message.token ?? '');
    case 'start':
      room._start(connectionId, message.opts);
      return;
    case 'action':
      room._action(connectionId, message);
      return;
    case 'undo-request':
      room._requestUndo(connectionId);
      return;
    case 'undo-vote':
      return room._voteUndo(connectionId, message.approve);
    case 'takeover':
      return room._takeover(connectionId, message);
    case 'leave':
      return room.leaveSeat(connectionId);
    case 'sync':
      room._stateTo(connectionId);
      return;
    case 'ping':
      room.send(connectionId, { t: 'pong' });
      return;
  }
}
