import { Engine as E, type GameState, type TurnPlan } from '@pokemon-splendor/game-core';
import type { LocalGameSession } from '../../session/localGameSession.js';
import type { OnlineSessionState } from '../../session/types.js';
import type { LocalConfig } from './app-model.js';
import { playerFrom } from './model.js';

export function applyAiPlan(session: LocalGameSession, plan: TurnPlan): void {
  if (plan.action) session.dispatch(plan.action);
  else session.dispatch({ type: 'pass' });
  for (const color of plan.discards) session.dispatch({ type: 'discard', color });
  if (plan.megaEvolution) {
    session.dispatch({
      type: 'megaEvolve',
      megaId: plan.megaEvolution.megaId,
      fromId: plan.megaEvolution.fromId,
    });
  } else if (plan.evolution) {
    session.dispatch({ type: 'evolve', fromId: plan.evolution.fromId, toId: plan.evolution.toId });
  }
  session.dispatch({ type: 'endTurn' });
}

export function prepareLocalTurn(
  session: LocalGameSession,
  config: LocalConfig,
  undoStack: GameState[],
  setPassSeat: (seat: number | null) => void,
): void {
  const state = session.getSnapshot().state;
  if (!state || state.phase === 'gameover') return;
  const active = playerFrom(state, state.turn);
  const humanCount = config.seats.filter((seat) => !seat.ai).length;
  if (!active.isAI && humanCount === 1 && config.seats.some((seat) => seat.ai)) {
    undoStack.push(E.clone(state));
    if (undoStack.length > 60) undoStack.shift();
  }
  if (!active.isAI && humanCount >= 2) setPassSeat(state.turn);
}

export function idleMessage(
  game: GameState,
  online: OnlineSessionState,
  now: number,
): string | null {
  if (!online.turnTimeoutMs || game.phase !== 'play') return null;
  const elapsed = online.serverNow - online.turnStartedAt + (now - online.stateAt);
  const seconds = Math.max(0, Math.ceil((online.turnTimeoutMs - elapsed) / 1_000));
  const active = online.roster.find((player) => player.seat === game.turn);
  const disconnected = active ? !active.connected : false;
  if (online.seat === game.turn) return seconds < 60 ? `${seconds}s 后 AI 接管` : null;
  return disconnected || seconds < 90 ? `${seconds}s 后 AI 接管` : null;
}
