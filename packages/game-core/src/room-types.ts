import type { RoomClientMessage } from './api.js';
import type { GameState, TurnPlan } from './types.js';

export type Seat = {
  token: string | null;
  name: string;
  connId: string | null;
  connected: boolean;
};

export type UndoVote = { requesterSeat: number; approvals: number[] };
export type SerializedGameState = Omit<GameState, 'cardDB' | 'byId' | 'megaDB' | 'pokemartDB'>;
export type StartOptions = Extract<RoomClientMessage, { readonly t: 'start' }>['opts'];
export type ActionMessage = Extract<RoomClientMessage, { readonly t: 'action' }>;
export type TakeoverPlan = Pick<TurnPlan, 'action' | 'discards' | 'evolution' | 'megaEvolution'>;
export type RoomInboundMessage =
  RoomClientMessage | { readonly t: 'takeover'; readonly plan?: Partial<TakeoverPlan> };
