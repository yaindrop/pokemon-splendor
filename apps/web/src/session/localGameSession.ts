import { Engine as E, type GameAction, type GameState } from '@pokemon-splendor/game-core';
import type {
  GameSession,
  GameSessionDispatchResult,
  GameSessionListener,
  GameSessionSnapshot,
} from './types.js';

export class LocalGameSession implements GameSession {
  readonly mode = 'local';

  private readonly listeners = new Set<GameSessionListener>();
  private revision = 0;
  private snapshot: GameSessionSnapshot;

  constructor(private state: GameState) {
    this.snapshot = this.createSnapshot();
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
    const result = E.applyAction(this.state, action);
    if (result.ok) this.publish();
    return { kind: 'applied', result };
  }

  replaceState(state: GameState): void {
    this.state = state;
    this.publish();
  }

  refresh(): void {
    this.publish();
  }

  dispose(): void {
    this.listeners.clear();
  }

  private createSnapshot(): GameSessionSnapshot {
    return {
      mode: this.mode,
      revision: this.revision,
      state: this.state,
      online: null,
    };
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }
}
