import {
  Engine as E,
  type CaptureOptions,
  type Card,
  type Color,
  type GameAction,
  type GameState,
  type Player,
  type TokenColor,
} from '@pokemon-splendor/game-core';
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { requestMasterBallConfirmation } from '../masterBallConfirmation.js';
import type { ChoiceRequest } from './app-model.js';
import { EMPTY_SELECTION, isNarrowViewport } from './app-model.js';
import {
  BALL_NAMES,
  affordInfo,
  canAddBall,
  cardFrom,
  isNormalTier,
  isPokemartTier,
  isInteractiveTurn,
  ownPlayer,
  playerFrom,
  takeSelectionComplete,
  type ReservableTier,
} from './model.js';
import { prepareLocalTurn } from './local-turn.js';
import type { GameRuntime } from './useGameRuntime.js';

interface CaptureOptionsDraft {
  copyTargetId?: string;
  spendPokedex?: readonly string[];
  discardCards?: readonly string[];
  freeTakeId?: string;
  freeOpts?: CaptureOptions;
}

export interface TableActions {
  readonly choice: ChoiceRequest | null;
  readonly setChoice: Dispatch<SetStateAction<ChoiceRequest | null>>;
  readonly currentPlayer: Player | null;
  readonly canInteract: boolean;
  readonly onSupplyTake: (color: Color) => void;
  readonly onSupplyReturn: (color: Color) => void;
  readonly confirmBallTake: () => void;
  readonly selectCard: (cardId: string) => void;
  readonly selectDeck: (tier: ReservableTier) => void;
  readonly reserveSelectedCard: () => void;
  readonly reserveSelectedDeck: () => void;
  readonly takeMega: () => void;
  readonly captureSelectedCard: () => Promise<void>;
  readonly discardBall: (color: TokenColor) => void;
  readonly evolve: (fromId: string, toId: string) => void;
  readonly megaEvolve: (megaId: string, fromId: string) => void;
  readonly endLocalTurn: () => void;
  readonly handleUndo: () => void;
  readonly resolveCardChoice: (value: readonly string[] | null) => void;
}

export function useTableActions(runtime: GameRuntime): TableActions {
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const choiceResolverRef = useRef<((value: readonly string[] | null) => void) | null>(null);
  const isOnline = runtime.online !== null;
  const ownSeat = runtime.online?.seat ?? null;
  const currentPlayer = runtime.game ? ownPlayer(runtime.game, ownSeat) : null;
  const canInteract =
    runtime.game !== null &&
    currentPlayer !== null &&
    runtime.phase === 'main' &&
    !runtime.game.acted &&
    !runtime.busy &&
    !runtime.online?.undoVote &&
    isInteractiveTurn(runtime.game, ownSeat, isOnline);

  const afterMainAction = (): void => {
    const session = runtime.localSessionRef.current;
    const state = session?.getSnapshot().state;
    if (!session || !state) return;
    runtime.setSelection(EMPTY_SELECTION);
    const player = playerFrom(state, state.turn);
    if (E.needsDiscard(state, player)) {
      runtime.setPhase('discard');
      return;
    }
    const evolutions = E.evolutionOptions(state, player);
    const megas = state.megasEnabled ? E.megaEvolveOptions(state, player) : [];
    if ((evolutions.length || megas.length) && !player.isAI) {
      runtime.setPhase('evolve');
      return;
    }
    endLocalTurn();
  };

  const endLocalTurn = (): void => {
    const session = runtime.localSessionRef.current;
    if (!session || !runtime.dispatchLocal({ type: 'endTurn' })) return;
    const state = session.getSnapshot().state;
    runtime.setPhase('main');
    runtime.setSelection(EMPTY_SELECTION);
    if (state?.phase === 'gameover') {
      if (!runtime.tutorial) runtime.setWinOpen(true);
      return;
    }
    prepareLocalTurn(
      session,
      runtime.localConfig,
      runtime.undoStackRef.current,
      runtime.setPassSeat,
    );
  };

  const onSupplyTake = (color: Color): void => {
    const game = runtime.game;
    if (!game || !canInteract || !canAddBall(game, runtime.selection.pickedBalls, color)) return;
    runtime.setSelection({
      pickedBalls: [...runtime.selection.pickedBalls, color],
      selectedCardId: null,
      selectedDeck: null,
    });
  };

  const onSupplyReturn = (color: Color): void => {
    if (!canInteract) return;
    const index = runtime.selection.pickedBalls.lastIndexOf(color);
    if (index < 0) return;
    runtime.setSelection({
      ...runtime.selection,
      pickedBalls: runtime.selection.pickedBalls.filter(
        (picked, pickedIndex) => pickedIndex !== index,
      ),
    });
  };

  const confirmBallTake = (): void => {
    const game = runtime.game;
    if (!game || !takeSelectionComplete(game, runtime.selection.pickedBalls)) return;
    const action: GameAction = { type: 'take', colors: runtime.selection.pickedBalls };
    if (isOnline) {
      runtime.dispatchOnline(action);
      runtime.setSelection(EMPTY_SELECTION);
    } else if (runtime.dispatchLocal(action)) afterMainAction();
  };

  const selectCard = (cardId: string): void => {
    const game = runtime.game;
    if (!game) return;
    const card = cardFrom(game, cardId);
    if (!canInteract || card.tier === 'mega' || runtime.selection.selectedCardId === cardId) {
      if (isNarrowViewport()) runtime.setInspectCardId(cardId);
      return;
    }
    runtime.setSelection({ pickedBalls: [], selectedCardId: cardId, selectedDeck: null });
  };

  const selectDeck = (tier: ReservableTier): void => {
    const game = runtime.game;
    if (!game) return;
    if (!canInteract) {
      runtime.showToast(isOnline ? '尚未轮到你' : '当前不能预留牌堆顶');
      return;
    }
    const deck = game.decks[tier];
    if (!deck?.length) {
      runtime.showToast('这个牌堆已经空了');
      return;
    }
    if (!isNormalTier(tier) && !isPokemartTier(tier)) {
      runtime.showToast('传说与稀有牌堆不能预留');
      return;
    }
    if (!currentPlayer || currentPlayer.reserve.length >= E.HAND_MAX) {
      runtime.showToast(`预留区已满（最多 ${E.HAND_MAX} 张）`);
      return;
    }
    runtime.setSelection({ pickedBalls: [], selectedCardId: null, selectedDeck: tier });
  };

  const dispatchSelected = (action: GameAction): void => {
    if (isOnline) {
      runtime.dispatchOnline(action);
      runtime.setSelection(EMPTY_SELECTION);
    } else if (runtime.dispatchLocal(action)) afterMainAction();
  };

  const reserveSelectedCard = (): void => {
    if (runtime.selection.selectedCardId) {
      dispatchSelected({
        type: 'reserve',
        target: { fromField: runtime.selection.selectedCardId },
      });
    }
  };

  const reserveSelectedDeck = (): void => {
    if (runtime.selection.selectedDeck) {
      dispatchSelected({ type: 'reserve', target: { fromDeck: runtime.selection.selectedDeck } });
    }
  };

  const takeMega = (): void => {
    if (!canInteract) return;
    if (isOnline) runtime.dispatchOnline({ type: 'takeMega' });
    else if (runtime.dispatchLocal({ type: 'takeMega' })) afterMainAction();
  };

  const resolveCardChoice = (value: readonly string[] | null): void => {
    const resolve = choiceResolverRef.current;
    choiceResolverRef.current = null;
    setChoice(null);
    resolve?.(value);
  };

  const chooseCards = (
    title: string,
    hint: string | undefined,
    candidates: readonly string[],
    count: number,
  ): Promise<readonly string[] | null> =>
    new Promise((resolve) => {
      choiceResolverRef.current = resolve;
      setChoice({ title, hint, candidates, count, selected: [] });
    });

  const gatherFreeTake = async (
    state: GameState,
    player: Player,
    parent: Card,
  ): Promise<CaptureOptions | null> => {
    const candidates = E.freeTiers(parent).flatMap((tier) =>
      (state.field[tier] ?? []).filter((id): id is string => {
        if (!id) return false;
        return E.freeTakeable(state, player, cardFrom(state, id));
      }),
    );
    if (!candidates.length) return {};
    const selected = await chooseCards(
      '免费获得一张卡',
      '立即免费获得（不付其成本），结算其效果',
      candidates,
      1,
    );
    const freeTakeId = selected?.[0];
    if (!freeTakeId) return null;
    const freeCard = cardFrom(state, freeTakeId);
    const freeOptions: CaptureOptionsDraft = {};
    if (E.isPokemart(freeCard) && (freeCard.effect === 'copy' || freeCard.effect === 'copy_free')) {
      const copied = await chooseCards(
        `关联「${freeCard.name}」`,
        '为免费获得的卡选择复制奖励的卡',
        player.board.filter((id) => E.effBonusColor(state, player, id)),
        1,
      );
      if (!copied?.[0]) return null;
      freeOptions.copyTargetId = copied[0];
    }
    if (E.isPokemart(freeCard) && (freeCard.effect === 'free' || freeCard.effect === 'copy_free')) {
      const nested = await gatherFreeTake(state, player, freeCard);
      if (nested === null) return null;
      if (nested.freeTakeId) freeOptions.freeTakeId = nested.freeTakeId;
      if (nested.freeOpts) freeOptions.freeOpts = nested.freeOpts;
    }
    return { freeTakeId, freeOpts: freeOptions };
  };

  const gatherCaptureOptions = async (
    state: GameState,
    player: Player,
    card: Card,
  ): Promise<CaptureOptions | null> => {
    const options: CaptureOptionsDraft = {};
    if (card.effect !== 'discard_buy' && !E.canAfford(state, player, card)) {
      const pokedex = player.board.filter(
        (id) =>
          E.isPokemart(cardFrom(state, id)) && cardFrom(state, id).effect === 'colorless_master',
      );
      let required = 0;
      for (let count = 1; count <= pokedex.length; count += 1) {
        if (E.computePayment(state, player, card, count * 2).ok) {
          required = count;
          break;
        }
      }
      if (required > 0) {
        const spent = await chooseCards(
          '弃用图鉴抵款',
          `弃 ${required} 张图鉴，各抵 2 个万能球以捕捉`,
          pokedex,
          required,
        );
        if (!spent) return null;
        options.spendPokedex = spent;
      }
    }
    if (card.effect === 'copy' || card.effect === 'copy_free') {
      const selected = await chooseCards(
        '关联奖励颜色',
        '选择一张卡，本卡永久视同其奖励颜色',
        player.board.filter((id) => E.effBonusColor(state, player, id)),
        1,
      );
      if (!selected?.[0]) return null;
      options.copyTargetId = selected[0];
    }
    if (card.effect === 'discard_buy') {
      const color = card.effectParam?.discardColor;
      const count = card.effectParam?.discardCount;
      if (!color || count === undefined) return null;
      const selected = await chooseCards(
        '驱虫喷雾',
        `弃掉 ${count} 张${BALL_NAMES[color]}奖励卡以获得本卡（不付精灵球）`,
        player.board.filter((id) => E.effBonusColor(state, player, id) === color),
        count,
      );
      if (!selected) return null;
      options.discardCards = selected;
    }
    if (card.effect === 'free' || card.effect === 'copy_free') {
      const free = await gatherFreeTake(state, player, card);
      if (free === null) return null;
      if (free.freeTakeId) options.freeTakeId = free.freeTakeId;
      if (free.freeOpts) options.freeOpts = free.freeOpts;
    }
    return options;
  };

  const captureSelectedCard = async (): Promise<void> => {
    const game = runtime.game;
    if (!game || !currentPlayer || !runtime.selection.selectedCardId) return;
    const card = cardFrom(game, runtime.selection.selectedCardId);
    const info = affordInfo(game, currentPlayer, card);
    if (!info) return;
    runtime.setBusy(true);
    try {
      if (info.master > 0 && !(await requestMasterBallConfirmation(info.master))) return;
      const options = await gatherCaptureOptions(game, currentPlayer, card);
      if (options === null) return;
      dispatchSelected({ type: 'capture', cardId: card.id, opts: options });
    } finally {
      runtime.setBusy(false);
    }
  };

  const discardBall = (color: TokenColor): void => {
    if (runtime.phase !== 'discard') return;
    if (isOnline) {
      runtime.dispatchOnline({ type: 'discard', color });
      return;
    }
    if (!runtime.dispatchLocal({ type: 'discard', color })) return;
    const state = runtime.localSessionRef.current?.getSnapshot().state;
    if (!state || E.needsDiscard(state, playerFrom(state, state.turn))) return;
    afterMainAction();
  };

  const evolve = (fromId: string, toId: string): void => {
    if (isOnline) runtime.dispatchOnline({ type: 'evolve', fromId, toId });
    else if (runtime.dispatchLocal({ type: 'evolve', fromId, toId })) endLocalTurn();
  };
  const megaEvolve = (megaId: string, fromId: string): void => {
    if (isOnline) runtime.dispatchOnline({ type: 'megaEvolve', megaId, fromId });
    else if (runtime.dispatchLocal({ type: 'megaEvolve', megaId, fromId })) endLocalTurn();
  };
  const handleUndo = (): void => {
    if (isOnline) return runtime.onlineSessionRef.current?.requestUndo();
    const session = runtime.localSessionRef.current;
    if (!session || runtime.undoStackRef.current.length < 2) return;
    runtime.undoStackRef.current.pop();
    const snapshot = runtime.undoStackRef.current.at(-1);
    if (!snapshot) return;
    session.replaceState(E.clone(snapshot));
    runtime.resetGameUi();
  };

  return {
    choice,
    setChoice,
    resolveCardChoice,
    currentPlayer,
    canInteract,
    onSupplyTake,
    onSupplyReturn,
    confirmBallTake,
    selectCard,
    selectDeck,
    reserveSelectedCard,
    reserveSelectedDeck,
    takeMega,
    captureSelectedCard,
    discardBall,
    evolve,
    megaEvolve,
    endLocalTurn,
    handleUndo,
  };
}
