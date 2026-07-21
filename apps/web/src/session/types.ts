import type { ActionResult, GameAction, GameState } from '@pokemon-splendor/game-core';
import type { ConnectionStatus } from '../net.js';

export interface RosterPlayer {
  readonly seat: number;
  readonly name: string;
  readonly connected: boolean;
}

export interface OnlineUndoVote {
  readonly requesterSeat: number;
  readonly approvals: readonly number[];
  readonly total: number;
}

export type OnlineSessionNotice =
  | { readonly kind: 'reject'; readonly message: string }
  | { readonly kind: 'undo-result'; readonly accepted: boolean; readonly message: string };

export interface OnlineSessionState {
  readonly code: string;
  readonly name: string;
  readonly seat: number | null;
  readonly host: boolean;
  readonly status: ConnectionStatus;
  readonly started: boolean;
  readonly roster: readonly RosterPlayer[];
  readonly undoAvailable: boolean;
  readonly undoVote: OnlineUndoVote | null;
  readonly turnStartedAt: number;
  readonly serverNow: number;
  readonly turnTimeoutMs: number;
  readonly stateAt: number;
  readonly stateSequence: number;
  readonly notice: OnlineSessionNotice | null;
  readonly noticeRevision: number;
}

export type GameSessionMode = 'local' | 'online';

export interface GameSessionSnapshot {
  readonly mode: GameSessionMode;
  readonly revision: number;
  readonly state: GameState | null;
  readonly online: OnlineSessionState | null;
}

export type GameSessionDispatchResult =
  { readonly kind: 'applied'; readonly result: ActionResult } | { readonly kind: 'pending' };

export type GameSessionListener = () => void;

export interface GameSession {
  readonly mode: GameSessionMode;
  getSnapshot(): GameSessionSnapshot;
  subscribe(listener: GameSessionListener): () => void;
  dispatch(action: GameAction): GameSessionDispatchResult;
  dispose(): void;
}
