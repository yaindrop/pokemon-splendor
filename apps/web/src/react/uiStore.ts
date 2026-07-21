import { atom, createStore } from 'jotai/vanilla';
import type { GameSession, GameSessionSnapshot } from '../session/types.js';

export interface PendingMasterBallConfirmation {
  readonly count: number;
  readonly resolve: (approved: boolean) => void;
}

export const uiStore = createStore();
export const masterBallConfirmationAtom = atom<PendingMasterBallConfirmation | null>(null);
export const activeGameSessionAtom = atom<GameSession | null>(null);
export const gameSessionSnapshotAtom = atom<GameSessionSnapshot | null>(null);

let unsubscribeFromActiveSession: (() => void) | null = null;

export function setActiveGameSession(session: GameSession | null): void {
  unsubscribeFromActiveSession?.();
  unsubscribeFromActiveSession = null;
  uiStore.set(activeGameSessionAtom, session);
  uiStore.set(gameSessionSnapshotAtom, session?.getSnapshot() ?? null);
  if (!session) return;

  unsubscribeFromActiveSession = session.subscribe(() => {
    if (uiStore.get(activeGameSessionAtom) === session) {
      uiStore.set(gameSessionSnapshotAtom, session.getSnapshot());
    }
  });
}
