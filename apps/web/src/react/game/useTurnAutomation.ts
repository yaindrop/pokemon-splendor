import { Engine as E } from '@pokemon-splendor/game-core';
import { useEffect } from 'react';
import { EMPTY_SELECTION } from './app-model.js';
import { chooseAiTurn } from './ai.js';
import { applyAiPlan, prepareLocalTurn } from './local-turn.js';
import { ownPlayer } from './model.js';
import { tutorialSteps } from './tutorial.js';
import type { GameRuntime } from './useGameRuntime.js';

export function useTurnAutomation(runtime: GameRuntime): void {
  useEffect(() => {
    const game = runtime.game;
    const currentPlayer = game ? ownPlayer(game, runtime.online?.seat ?? null) : null;
    if (
      !game ||
      runtime.online ||
      !currentPlayer?.isAI ||
      game.phase !== 'play' ||
      runtime.aiPendingRef.current
    )
      return undefined;
    const session = runtime.localSessionRef.current;
    if (!session) return undefined;
    runtime.aiPendingRef.current = true;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const state = session.getSnapshot().state;
      const player = state?.players[state.turn];
      if (!state || state.phase !== 'play' || !player?.isAI) {
        runtime.aiPendingRef.current = false;
        return;
      }
      const difficulty =
        player.diff === 'easy' ||
        player.diff === 'normal' ||
        player.diff === 'hard' ||
        player.diff === 'ultra'
          ? player.diff
          : 'hard';
      void chooseAiTurn(state, difficulty).then((plan) => {
        if (
          cancelled ||
          runtime.localSessionRef.current !== session ||
          session.getSnapshot().state !== state
        )
          return;
        applyAiPlan(session, plan);
        runtime.aiPendingRef.current = false;
        runtime.setPhase('main');
        runtime.setSelection(EMPTY_SELECTION);
        const next = session.getSnapshot().state;
        if (next?.phase === 'gameover') runtime.setWinOpen(true);
        else
          prepareLocalTurn(
            session,
            runtime.localConfig,
            runtime.undoStackRef.current,
            runtime.setPassSeat,
          );
      });
    }, 460);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      runtime.aiPendingRef.current = false;
    };
  }, [runtime.game, runtime.online, runtime.localConfig]);

  useEffect(() => {
    const { game, online } = runtime;
    if (!game || !online) return;
    if (game.phase !== 'play' || online.seat !== game.turn) {
      runtime.setPhase('main');
      runtime.setSelection(EMPTY_SELECTION);
      return;
    }
    const player = ownPlayer(game, online.seat);
    if (E.needsDiscard(game, player)) {
      runtime.setPhase('discard');
      runtime.setSelection(EMPTY_SELECTION);
      return;
    }
    if (!game.acted) {
      runtime.setPhase('main');
      return;
    }
    if (
      E.evolutionOptions(game, player).length ||
      (game.megasEnabled && E.megaEvolveOptions(game, player).length)
    ) {
      runtime.setPhase('evolve');
      return;
    }
    runtime.onlineSessionRef.current?.dispatch({ type: 'endTurn' });
  }, [runtime.game, runtime.online]);

  useEffect(() => {
    const { tutorial, game, online } = runtime;
    if (!tutorial || tutorial.completed || !game || online) return;
    const step = tutorialSteps(tutorial.mode)[tutorial.stepIndex];
    if (step?.complete?.(game, tutorial.baseline)) runtime.advanceTutorial();
  }, [runtime.game, runtime.online, runtime.tutorial]);
}
