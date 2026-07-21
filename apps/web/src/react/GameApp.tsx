import { Drawer } from '@base-ui/react/drawer';
import { Menu } from '@base-ui/react/menu';
import {
  Engine as E,
  type BaseTier,
  type CaptureOptions,
  type Card,
  type Color,
  type GameAction,
  type GameLogEntry,
  type GameState,
  type Player,
  type PokemartTier,
  type TokenColor,
  type TurnPlan,
} from '@pokemon-splendor/game-core';
import {
  cards as CARD_DB,
  megas as MEGA_DB,
  pokemart as POKEMART_DB,
} from '@pokemon-splendor/game-data';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Net, type RoomStartOptions } from '../net.js';
import { LocalGameSession } from '../session/localGameSession.js';
import { OnlineGameSession } from '../session/onlineGameSession.js';
import type { OnlineSessionState } from '../session/types.js';
import {
  GameButton,
  GameInput,
  GameSelect,
  GameSwitch,
  HoverTip,
  Modal,
  type GameSelectOption,
} from './components/primitives.js';
import {
  BALL_NAMES,
  TIER_NAMES,
  affordInfo,
  canAddBall,
  cardFrom,
  captureBlockedReason,
  dedupeEvolutionOptions,
  hiddenReserveTier,
  isInteractiveTurn,
  isNormalTier,
  isPokemartTier,
  isReservableTier,
  ownPlayer,
  paymentRows,
  reserveBlockedReason,
  seatAvatar,
  seatColor,
  takeSelectionComplete,
  turnStatus,
  type AffordInfo,
  type GameSelection,
  type GameUiPhase,
  type ReservableTier,
} from './game/model.js';
import { chooseAiTurn } from './game/ai.js';
import {
  createTutorialGame,
  snapshotTutorial,
  tutorialCompletion,
  tutorialSteps,
  type TutorialMode,
  type TutorialSnapshot,
} from './game/tutorial.js';
import { captureStateTransition, playPendingFlights, type PendingFlight } from './game/motion.js';
import { requestMasterBallConfirmation } from './masterBallConfirmation.js';
import { setActiveGameSession } from './uiStore.js';

type Screen = 'home' | 'local-config' | 'online-config' | 'lobby' | 'game';
type Difficulty = 'easy' | 'normal' | 'hard' | 'ultra';
type SeatKind = 'human' | 'ai';
type TimeoutChoice = '60000' | '180000' | '300000' | '600000';

interface LocalSeatConfig {
  readonly name: string;
  readonly ai: boolean;
  readonly difficulty: Difficulty;
}

interface LocalConfig {
  readonly seats: readonly LocalSeatConfig[];
  readonly megas: boolean;
  readonly pokemart: boolean;
}

interface OnlineConfig {
  readonly name: string;
  readonly roomCode: string;
  readonly timeoutEnabled: boolean;
  readonly timeoutMs: number;
}

interface ChoiceRequest {
  readonly title: string;
  readonly hint: string | undefined;
  readonly candidates: readonly string[];
  readonly count: number;
  readonly selected: readonly string[];
}

interface InspectCard {
  readonly id: string;
}

interface TutorialRun {
  readonly mode: TutorialMode;
  readonly stepIndex: number;
  readonly baseline: TutorialSnapshot;
  readonly completed: boolean;
}

interface CaptureOptionsDraft {
  copyTargetId?: string;
  spendPokedex?: readonly string[];
  discardCards?: readonly string[];
  freeTakeId?: string;
  freeOpts?: CaptureOptions;
}

const CARD_CATALOG = {
  cardDB: CARD_DB,
  byId: Object.fromEntries([...CARD_DB, ...MEGA_DB, ...POKEMART_DB].map((card) => [card.id, card])),
  megaDB: MEGA_DB,
  pokemartDB: POKEMART_DB,
};

const SEAT_KIND_OPTIONS: readonly GameSelectOption<SeatKind>[] = [
  { value: 'human', label: '真人' },
  { value: 'ai', label: '电脑' },
];

const DIFFICULTY_OPTIONS: readonly GameSelectOption<Difficulty>[] = [
  { value: 'hard', label: '高手' },
  { value: 'ultra', label: '究极（最强·搜索）' },
  { value: 'normal', label: '普通' },
  { value: 'easy', label: '新手' },
];

const TIMEOUT_OPTIONS: readonly GameSelectOption<TimeoutChoice>[] = [
  { value: '60000', label: '1 分钟' },
  { value: '180000', label: '3 分钟' },
  { value: '300000', label: '5 分钟' },
  { value: '600000', label: '10 分钟' },
];

const EMPTY_SELECTION: GameSelection = {
  pickedBalls: [],
  selectedCardId: null,
  selectedDeck: null,
};

function initialSeats(
  count: number,
  existing: readonly LocalSeatConfig[] = [],
): readonly LocalSeatConfig[] {
  return Array.from({ length: count }, (_, index) => {
    const prior = existing[index];
    if (prior) return prior;
    return {
      name: `训练家 ${index + 1}`,
      ai: index > 0,
      difficulty: 'hard',
    };
  });
}

function createInitialLocalConfig(): LocalConfig {
  return { seats: initialSeats(2), megas: false, pokemart: false };
}

function createInitialOnlineConfig(): OnlineConfig {
  return { name: '训练家 1', roomCode: '', timeoutEnabled: false, timeoutMs: 180_000 };
}

function sanitizedRoomCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

function roomCodeFromLocation(): string | null {
  try {
    return sanitizedRoomCode(new URLSearchParams(location.search).get('room') ?? '') || null;
  } catch {
    return null;
  }
}

function timeoutChoice(timeoutMs: number): TimeoutChoice {
  if (timeoutMs === 60_000) return '60000';
  if (timeoutMs === 300_000) return '300000';
  if (timeoutMs === 600_000) return '600000';
  return '180000';
}

function timeoutMsFromChoice(value: TimeoutChoice): number {
  if (value === '60000') return 60_000;
  if (value === '300000') return 300_000;
  if (value === '600000') return 600_000;
  return 180_000;
}

function isNarrowViewport(): boolean {
  return window.matchMedia('(max-width: 1280px)').matches;
}

export function GameApp(): ReactElement {
  const [screen, setScreen] = useState<Screen>('home');
  const [localConfig, setLocalConfig] = useState<LocalConfig>(createInitialLocalConfig);
  const [onlineConfig, setOnlineConfig] = useState<OnlineConfig>(createInitialOnlineConfig);
  const [game, setGame] = useState<GameState | null>(null);
  const [online, setOnline] = useState<OnlineSessionState | null>(null);
  const [selection, setSelection] = useState<GameSelection>(EMPTY_SELECTION);
  const [phase, setPhase] = useState<GameUiPhase>('main');
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [inspectCard, setInspectCard] = useState<InspectCard | null>(null);
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const [winOpen, setWinOpen] = useState(false);
  const [passSeat, setPassSeat] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tutorial, setTutorial] = useState<TutorialRun | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const localSessionRef = useRef<LocalGameSession | null>(null);
  const onlineSessionRef = useRef<OnlineGameSession | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const choiceResolverRef = useRef<((value: readonly string[] | null) => void) | null>(null);
  const undoStackRef = useRef<GameState[]>([]);
  const aiPendingRef = useRef(false);
  const handledNoticeRevisionRef = useRef(0);
  const openedRoomFromLocationRef = useRef(false);
  const gameRef = useRef<GameState | null>(null);
  const motionRef = useRef<PendingFlight[]>([]);

  const isOnline = online !== null;
  const ownSeat = online?.seat ?? null;
  const currentPlayer = game ? ownPlayer(game, ownSeat) : null;
  const canInteract =
    game !== null &&
    currentPlayer !== null &&
    phase === 'main' &&
    !game.acted &&
    !busy &&
    !online?.undoVote &&
    isInteractiveTurn(game, ownSeat, isOnline);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => {
      setToast(null);
    }, 2_400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toast]);

  useEffect(() => {
    if (!online?.turnTimeoutMs) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [online?.turnTimeoutMs]);

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      onlineSessionRef.current?.dispose();
      localSessionRef.current?.dispose();
      setActiveGameSession(null);
    };
  }, []);

  useEffect(() => {
    if (openedRoomFromLocationRef.current) return;
    const roomCode = roomCodeFromLocation();
    if (!roomCode) return;
    openedRoomFromLocationRef.current = true;
    openOnlineRoom(roomCode, false);
  }, []);

  useEffect(() => {
    if (online?.undoVote) setLogOpen(true);
  }, [online?.undoVote]);

  useEffect(() => {
    if (
      !game ||
      isOnline ||
      !currentPlayer?.isAI ||
      game.phase !== 'play' ||
      aiPendingRef.current
    ) {
      return undefined;
    }
    const session = localSessionRef.current;
    if (!session) return undefined;
    aiPendingRef.current = true;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const state = session.getSnapshot().state;
      if (!state || state.phase !== 'play' || !state.players[state.turn]?.isAI) {
        aiPendingRef.current = false;
        return;
      }
      const player = state.players[state.turn];
      if (!player) {
        aiPendingRef.current = false;
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
          localSessionRef.current !== session ||
          session.getSnapshot().state !== state
        ) {
          return;
        }
        applyAiPlan(session, plan);
        aiPendingRef.current = false;
        setPhase('main');
        setSelection(EMPTY_SELECTION);
        const next = session.getSnapshot().state;
        if (next?.phase === 'gameover') setWinOpen(true);
        else prepareLocalTurn(session, localConfig, undoStackRef, setPassSeat);
      });
    }, 460);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      aiPendingRef.current = false;
    };
  }, [currentPlayer?.isAI, game, isOnline, localConfig]);

  useEffect(() => {
    if (!game || !online) return;
    if (game.phase !== 'play' || online.seat !== game.turn) {
      setPhase('main');
      setSelection(EMPTY_SELECTION);
      return;
    }
    const player = ownPlayer(game, online.seat);
    if (E.needsDiscard(game, player)) {
      setPhase('discard');
      setSelection(EMPTY_SELECTION);
      return;
    }
    if (!game.acted) {
      setPhase('main');
      return;
    }
    const evolutions = E.evolutionOptions(game, player);
    const megas = game.megasEnabled ? E.megaEvolveOptions(game, player) : [];
    if (evolutions.length || megas.length) {
      setPhase('evolve');
      return;
    }
    onlineSessionRef.current?.dispatch({ type: 'endTurn' });
  }, [game, online]);

  useEffect(() => {
    if (!tutorial || tutorial.completed || !game || isOnline) return;
    const step = tutorialSteps(tutorial.mode)[tutorial.stepIndex];
    if (!step?.complete || !step.complete(game, tutorial.baseline)) return;
    advanceTutorial();
  }, [game, isOnline, tutorial]);

  useEffect(() => {
    if (motionRef.current.length === 0) return;
    const pending = motionRef.current;
    motionRef.current = [];
    playPendingFlights(pending);
  }, [game]);

  function releaseSession(leaveOnline: boolean): void {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const currentOnline = onlineSessionRef.current;
    if (currentOnline) {
      if (leaveOnline) currentOnline.leave();
      currentOnline.dispose();
      onlineSessionRef.current = null;
    }
    localSessionRef.current?.dispose();
    localSessionRef.current = null;
    gameRef.current = null;
    motionRef.current = [];
    setActiveGameSession(null);
    setOnline(null);
  }

  function resetGameUi(): void {
    setSelection(EMPTY_SELECTION);
    setPhase('main');
    setBusy(false);
    setInspectCard(null);
    setChoice(null);
    setPassSeat(null);
    setWinOpen(false);
    setLogOpen(false);
    setLeaveConfirmOpen(false);
  }

  function setTutorialStep(mode: TutorialMode, stepIndex: number, state: GameState): void {
    const steps = tutorialSteps(mode);
    const step = steps[stepIndex];
    if (!step) {
      setTutorial({
        mode,
        stepIndex,
        baseline: snapshotTutorial(state),
        completed: true,
      });
      return;
    }
    const arranged = E.clone(state);
    step.arrange?.(arranged);
    localSessionRef.current?.replaceState(arranged);
    gameRef.current = arranged;
    setGame(arranged);
    setSelection(EMPTY_SELECTION);
    setPhase('main');
    setTutorial({
      mode,
      stepIndex,
      baseline: snapshotTutorial(arranged),
      completed: false,
    });
  }

  function startTutorial(mode: TutorialMode): void {
    releaseSession(false);
    const gameState = createTutorialGame(mode, { cards: CARD_DB, megaCards: MEGA_DB });
    const session = new LocalGameSession(gameState);
    localSessionRef.current = session;
    attachLocalSession(session);
    gameRef.current = gameState;
    undoStackRef.current = [];
    resetGameUi();
    setScreen('game');
    setTutorialStep(mode, 0, gameState);
  }

  function advanceTutorial(): void {
    if (!tutorial || tutorial.completed) return;
    const state = localSessionRef.current?.getSnapshot().state;
    if (!state) return;
    setTutorialStep(tutorial.mode, tutorial.stepIndex + 1, state);
  }

  function showToast(message: string): void {
    setToast(message);
  }

  function attachLocalSession(session: LocalGameSession): void {
    unsubscribeRef.current?.();
    unsubscribeRef.current = session.subscribe(() => {
      const snapshot = session.getSnapshot();
      gameRef.current = snapshot.state;
      setGame(snapshot.state);
    });
    setActiveGameSession(session);
  }

  function attachOnlineSession(session: OnlineGameSession): void {
    unsubscribeRef.current?.();
    handledNoticeRevisionRef.current = 0;
    unsubscribeRef.current = session.subscribe(() => {
      const snapshot = session.getSnapshot();
      const previous = gameRef.current;
      if (previous && snapshot.state && snapshot.online?.started) {
        motionRef.current.push(...captureStateTransition(previous, snapshot.state));
      }
      gameRef.current = snapshot.state;
      setGame(snapshot.state);
      setOnline(snapshot.online);
      if (snapshot.state) setScreen('game');
      if (
        snapshot.online?.notice &&
        snapshot.online.noticeRevision > handledNoticeRevisionRef.current
      ) {
        handledNoticeRevisionRef.current = snapshot.online.noticeRevision;
        showToast(snapshot.online.notice.message);
      }
    });
    setActiveGameSession(session);
  }

  function startLocalGame(): void {
    releaseSession(false);
    setTutorial(null);
    const config = localConfig;
    const gameState = E.createGame(CARD_DB, {
      numPlayers: config.seats.length,
      names: config.seats.map((seat) => seat.name.trim() || '训练家'),
      ai: config.seats.map((seat) => seat.ai),
      megas: config.megas && MEGA_DB.length > 0,
      megaDB: MEGA_DB,
      pokemart: config.pokemart && POKEMART_DB.length > 0,
      pokemartDB: POKEMART_DB,
    });
    gameState.players.forEach((player, index) => {
      player.diff = config.seats[index]?.difficulty ?? 'hard';
    });
    const session = new LocalGameSession(gameState);
    localSessionRef.current = session;
    attachLocalSession(session);
    undoStackRef.current = [];
    gameRef.current = gameState;
    setGame(gameState);
    resetGameUi();
    setScreen('game');
    prepareLocalTurn(session, config, undoStackRef, setPassSeat);
  }

  function openOnlineRoom(code: string, host: boolean): void {
    const cleanCode = sanitizedRoomCode(code);
    if (!cleanCode) {
      showToast('请输入有效房间码');
      return;
    }
    releaseSession(false);
    setTutorial(null);
    const name = onlineConfig.name.trim() || '训练家';
    const session = new OnlineGameSession({
      net: Net,
      code: cleanCode,
      name,
      catalog: CARD_CATALOG,
      host,
    });
    onlineSessionRef.current = session;
    attachOnlineSession(session);
    resetGameUi();
    setScreen('lobby');
    try {
      history.replaceState(null, '', `${location.pathname}?room=${cleanCode}`);
    } catch {
      // URL rewriting is optional in restricted embedded browsers.
    }
    session.connect();
  }

  async function createOnlineRoom(): Promise<void> {
    setCreatingRoom(true);
    try {
      openOnlineRoom(await Net.createRoom(), true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法创建房间');
    } finally {
      setCreatingRoom(false);
    }
  }

  function leaveToHome(): void {
    releaseSession(isOnline);
    setTutorial(null);
    resetGameUi();
    setGame(null);
    setScreen('home');
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      // URL rewriting is optional in restricted embedded browsers.
    }
  }

  function confirmLeaveGame(): void {
    setLeaveConfirmOpen(false);
    leaveToHome();
  }

  function updateSeat(index: number, update: Partial<LocalSeatConfig>): void {
    setLocalConfig((config) => ({
      ...config,
      seats: config.seats.map((seat, seatIndex) =>
        seatIndex === index ? { ...seat, ...update } : seat,
      ),
    }));
  }

  function selectPlayerCount(count: number): void {
    setLocalConfig((config) => ({ ...config, seats: initialSeats(count, config.seats) }));
  }

  function dispatchLocal(action: GameAction): boolean {
    const session = localSessionRef.current;
    if (!session) return false;
    const state = session.getSnapshot().state;
    const predicted = state ? E.clone(state) : null;
    const pending =
      state && predicted && E.applyAction(predicted, action).ok
        ? captureStateTransition(state, predicted)
        : [];
    const result = session.dispatch(action);
    if (result.kind === 'applied' && !result.result.ok) {
      showToast(result.result.error);
      return false;
    }
    if (result.kind === 'applied' && result.result.ok) {
      motionRef.current.push(...pending);
    }
    return true;
  }

  function dispatchOnline(action: GameAction): void {
    onlineSessionRef.current?.dispatch(action);
  }

  function afterMainAction(): void {
    const session = localSessionRef.current;
    const state = session?.getSnapshot().state;
    if (!session || !state) return;
    setSelection(EMPTY_SELECTION);
    const player = playerFromState(state, state.turn);
    if (E.needsDiscard(state, player)) {
      setPhase('discard');
      return;
    }
    const evolutionOptions = E.evolutionOptions(state, player);
    const megaOptions = state.megasEnabled ? E.megaEvolveOptions(state, player) : [];
    if ((evolutionOptions.length || megaOptions.length) && !player.isAI) {
      setPhase('evolve');
      return;
    }
    endLocalTurn();
  }

  function endLocalTurn(): void {
    const session = localSessionRef.current;
    if (!session || !dispatchLocal({ type: 'endTurn' })) return;
    const state = session.getSnapshot().state;
    setPhase('main');
    setSelection(EMPTY_SELECTION);
    if (state?.phase === 'gameover') {
      if (!tutorial) setWinOpen(true);
      return;
    }
    prepareLocalTurn(session, localConfig, undoStackRef, setPassSeat);
  }

  function onSupplyTake(color: Color): void {
    if (!game || !canInteract || !canAddBall(game, selection.pickedBalls, color)) return;
    setSelection({
      pickedBalls: [...selection.pickedBalls, color],
      selectedCardId: null,
      selectedDeck: null,
    });
  }

  function onSupplyReturn(color: Color): void {
    if (!canInteract) return;
    const index = selection.pickedBalls.lastIndexOf(color);
    if (index < 0) return;
    setSelection({
      ...selection,
      pickedBalls: selection.pickedBalls.filter((picked, pickedIndex) => pickedIndex !== index),
    });
  }

  function confirmBallTake(): void {
    if (!game || !takeSelectionComplete(game, selection.pickedBalls)) return;
    const action: GameAction = { type: 'take', colors: selection.pickedBalls };
    if (isOnline) {
      dispatchOnline(action);
      setSelection(EMPTY_SELECTION);
      return;
    }
    if (dispatchLocal(action)) afterMainAction();
  }

  function selectCard(cardId: string): void {
    if (!game) return;
    const card = cardFrom(game, cardId);
    if (!canInteract || card.tier === 'mega') {
      if (isNarrowViewport()) setInspectCard({ id: cardId });
      return;
    }
    if (selection.selectedCardId === cardId) {
      if (isNarrowViewport()) setInspectCard({ id: cardId });
      return;
    }
    setSelection({ pickedBalls: [], selectedCardId: cardId, selectedDeck: null });
  }

  function selectDeck(tier: ReservableTier): void {
    if (!game) return;
    if (!canInteract) {
      showToast(isOnline ? '尚未轮到你' : '当前不能预留牌堆顶');
      return;
    }
    const deck = game.decks[tier];
    if (!deck?.length) {
      showToast('这个牌堆已经空了');
      return;
    }
    if (!isNormalTier(tier) && !isPokemartTier(tier)) {
      showToast('传说与稀有牌堆不能预留');
      return;
    }
    if (!currentPlayer || currentPlayer.reserve.length >= E.HAND_MAX) {
      showToast(`预留区已满（最多 ${E.HAND_MAX} 张）`);
      return;
    }
    setSelection({ pickedBalls: [], selectedCardId: null, selectedDeck: tier });
  }

  function reserveSelectedCard(): void {
    const cardId = selection.selectedCardId;
    if (!cardId) return;
    const action: GameAction = { type: 'reserve', target: { fromField: cardId } };
    if (isOnline) {
      dispatchOnline(action);
      setSelection(EMPTY_SELECTION);
      return;
    }
    if (dispatchLocal(action)) afterMainAction();
  }

  function reserveSelectedDeck(): void {
    const tier = selection.selectedDeck;
    if (!tier) return;
    const action: GameAction = { type: 'reserve', target: { fromDeck: tier } };
    if (isOnline) {
      dispatchOnline(action);
      setSelection(EMPTY_SELECTION);
      return;
    }
    if (dispatchLocal(action)) afterMainAction();
  }

  function takeMega(): void {
    if (!canInteract) return;
    if (isOnline) {
      dispatchOnline({ type: 'takeMega' });
      return;
    }
    if (dispatchLocal({ type: 'takeMega' })) afterMainAction();
  }

  function resolveCardChoice(value: readonly string[] | null): void {
    const resolve = choiceResolverRef.current;
    choiceResolverRef.current = null;
    setChoice(null);
    resolve?.(value);
  }

  function chooseCards(
    title: string,
    hint: string | undefined,
    candidates: readonly string[],
    count: number,
  ): Promise<readonly string[] | null> {
    return new Promise((resolve) => {
      choiceResolverRef.current = resolve;
      setChoice({ title, hint, candidates, count, selected: [] });
    });
  }

  async function gatherFreeTake(
    state: GameState,
    player: Player,
    parent: Card,
  ): Promise<CaptureOptions | null> {
    const candidates: string[] = [];
    for (const tier of E.freeTiers(parent)) {
      for (const id of state.field[tier] ?? []) {
        if (id && E.freeTakeable(state, player, cardFrom(state, id))) candidates.push(id);
      }
    }
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
      const copyCandidates = player.board.filter((id) => E.effBonusColor(state, player, id));
      const copied = await chooseCards(
        `关联「${freeCard.name}」`,
        '为免费获得的卡选择复制奖励的卡',
        copyCandidates,
        1,
      );
      const copyTargetId = copied?.[0];
      if (!copyTargetId) return null;
      freeOptions.copyTargetId = copyTargetId;
    }
    if (E.isPokemart(freeCard) && (freeCard.effect === 'free' || freeCard.effect === 'copy_free')) {
      const nested = await gatherFreeTake(state, player, freeCard);
      if (nested === null) return null;
      if (nested.freeTakeId) freeOptions.freeTakeId = nested.freeTakeId;
      if (nested.freeOpts) freeOptions.freeOpts = nested.freeOpts;
    }
    return { freeTakeId, freeOpts: freeOptions };
  }

  async function gatherCaptureOptions(
    state: GameState,
    player: Player,
    card: Card,
  ): Promise<CaptureOptions | null> {
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
      const candidates = player.board.filter((id) => E.effBonusColor(state, player, id));
      const selected = await chooseCards(
        '关联奖励颜色',
        '选择一张卡，本卡永久视同其奖励颜色',
        candidates,
        1,
      );
      const copyTargetId = selected?.[0];
      if (!copyTargetId) return null;
      options.copyTargetId = copyTargetId;
    }
    if (card.effect === 'discard_buy') {
      const color = card.effectParam?.discardColor;
      const count = card.effectParam?.discardCount;
      if (!color || count === undefined) return null;
      const candidates = player.board.filter((id) => E.effBonusColor(state, player, id) === color);
      const selected = await chooseCards(
        '驱虫喷雾',
        `弃掉 ${count} 张${BALL_NAMES[color]}奖励卡以获得本卡（不付精灵球）`,
        candidates,
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
  }

  async function captureSelectedCard(): Promise<void> {
    if (!game || !currentPlayer || !selection.selectedCardId) return;
    const card = cardFrom(game, selection.selectedCardId);
    const info = affordInfo(game, currentPlayer, card);
    if (!info) return;
    setBusy(true);
    try {
      if (info.master > 0 && !(await requestMasterBallConfirmation(info.master))) return;
      const options = await gatherCaptureOptions(game, currentPlayer, card);
      if (options === null) return;
      const action: GameAction = { type: 'capture', cardId: card.id, opts: options };
      if (isOnline) {
        dispatchOnline(action);
        setSelection(EMPTY_SELECTION);
      } else if (dispatchLocal(action)) {
        afterMainAction();
      }
    } finally {
      setBusy(false);
    }
  }

  function discardBall(color: TokenColor): void {
    if (phase !== 'discard') return;
    if (isOnline) {
      dispatchOnline({ type: 'discard', color });
      return;
    }
    if (!dispatchLocal({ type: 'discard', color })) return;
    const state = localSessionRef.current?.getSnapshot().state;
    if (!state) return;
    const player = playerFromState(state, state.turn);
    if (E.needsDiscard(state, player)) return;
    afterMainAction();
  }

  function evolve(fromId: string, toId: string): void {
    const action: GameAction = { type: 'evolve', fromId, toId };
    if (isOnline) {
      dispatchOnline(action);
      return;
    }
    if (dispatchLocal(action)) endLocalTurn();
  }

  function megaEvolve(megaId: string, fromId: string): void {
    const action: GameAction = { type: 'megaEvolve', megaId, fromId };
    if (isOnline) {
      dispatchOnline(action);
      return;
    }
    if (dispatchLocal(action)) endLocalTurn();
  }

  function handleUndo(): void {
    if (isOnline) {
      onlineSessionRef.current?.requestUndo();
      return;
    }
    const session = localSessionRef.current;
    if (!session || undoStackRef.current.length < 2) return;
    undoStackRef.current.pop();
    const snapshot = undoStackRef.current.at(-1);
    if (!snapshot) return;
    session.replaceState(E.clone(snapshot));
    resetGameUi();
  }

  const idleNotice = game && online ? idleMessage(game, online, now) : null;

  return (
    <>
      {screen === 'home' ? (
        <HomeScreen
          onChooseLocal={() => {
            setScreen('local-config');
          }}
          onChooseOnline={() => {
            setScreen('online-config');
          }}
          onOpenRules={() => {
            setRulesOpen(true);
          }}
          onStartTutorial={startTutorial}
        />
      ) : null}
      {screen === 'local-config' ? (
        <LocalSetup
          config={localConfig}
          onBack={() => {
            setScreen('home');
          }}
          onSelectPlayerCount={selectPlayerCount}
          onUpdateSeat={updateSeat}
          onChangeMegas={(megas) => {
            setLocalConfig((config) => ({ ...config, megas }));
          }}
          onChangePokemart={(pokemart) => {
            setLocalConfig((config) => ({ ...config, pokemart }));
          }}
          onStart={startLocalGame}
        />
      ) : null}
      {screen === 'online-config' ? (
        <OnlineSetup
          config={onlineConfig}
          creatingRoom={creatingRoom}
          onBack={() => {
            setScreen('home');
          }}
          onChange={setOnlineConfig}
          onCreate={() => void createOnlineRoom()}
          onJoin={() => {
            openOnlineRoom(onlineConfig.roomCode, false);
          }}
        />
      ) : null}
      {screen === 'lobby' && online ? (
        <LobbyScreen
          online={online}
          config={onlineConfig}
          onStart={(options) => onlineSessionRef.current?.start(options)}
          onLeave={leaveToHome}
          onCopy={() => void copyInviteLink(showToast)}
        />
      ) : null}
      {screen === 'game' && game ? (
        <GameScreen
          game={game}
          online={online}
          selection={selection}
          phase={phase}
          busy={busy}
          logOpen={logOpen}
          idleNotice={idleNotice}
          canInteract={canInteract}
          localUndoAvailable={undoStackRef.current.length >= 2}
          tutorialHideEndTurn={
            tutorial !== null &&
            !tutorial.completed &&
            tutorialSteps(tutorial.mode)[tutorial.stepIndex]?.hideEndTurn === true
          }
          onOpenLog={() => {
            setLogOpen(true);
          }}
          onCloseLog={() => {
            setLogOpen(false);
          }}
          onOpenRules={() => {
            setRulesOpen(true);
          }}
          onLeave={() => {
            setLeaveConfirmOpen(true);
          }}
          onSupplyTake={onSupplyTake}
          onSupplyReturn={onSupplyReturn}
          onConfirmTake={confirmBallTake}
          onClearTake={() => {
            setSelection(EMPTY_SELECTION);
          }}
          onSelectCard={selectCard}
          onInspect={(id) => {
            if (isNarrowViewport()) setInspectCard({ id });
          }}
          onSelectDeck={selectDeck}
          onReserveSelectedCard={reserveSelectedCard}
          onReserveSelectedDeck={reserveSelectedDeck}
          onCaptureSelectedCard={() => void captureSelectedCard()}
          onDiscard={discardBall}
          onEvolve={evolve}
          onMegaEvolve={megaEvolve}
          onTakeMega={takeMega}
          onEndTurn={() => {
            if (isOnline) dispatchOnline({ type: 'endTurn' });
            else endLocalTurn();
          }}
          onUndo={handleUndo}
          onVoteUndo={(approve) => onlineSessionRef.current?.voteUndo(approve)}
        />
      ) : null}
      <RulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />
      <InspectDialog
        card={inspectCard && game ? cardFrom(game, inspectCard.id) : null}
        onClose={() => {
          setInspectCard(null);
        }}
      />
      <ChoiceDialog
        choice={choice}
        cardById={(id) => (game ? cardFrom(game, id) : null)}
        onChangeSelected={(selected) => {
          setChoice((request) => (request ? { ...request, selected } : request));
        }}
        onResolve={resolveCardChoice}
      />
      <WinDialog game={game} open={winOpen && !tutorial} onLeave={leaveToHome} />
      <PassDialog
        game={game}
        seat={passSeat}
        onReady={() => {
          setPassSeat(null);
        }}
      />
      <LeaveGameDialog
        open={leaveConfirmOpen}
        tutorial={tutorial !== null && !tutorial.completed}
        onCancel={() => {
          setLeaveConfirmOpen(false);
        }}
        onConfirm={confirmLeaveGame}
      />
      <TutorialCoach
        tutorial={tutorial}
        onNext={advanceTutorial}
        onExit={() => {
          if (tutorial?.completed) leaveToHome();
          else setLeaveConfirmOpen(true);
        }}
      />
      {toast ? (
        <div className="app-toast" role="status">
          {toast}
        </div>
      ) : null}
    </>
  );
}

function playerFromState(state: GameState, index: number): Player {
  const player = state.players[index];
  if (!player) throw new Error(`训练家席位不存在：${index}`);
  return player;
}

function applyAiPlan(session: LocalGameSession, plan: TurnPlan): void {
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

function prepareLocalTurn(
  session: LocalGameSession,
  config: LocalConfig,
  undoStackRef: { current: GameState[] },
  setPassSeat: (seat: number | null) => void,
): void {
  const state = session.getSnapshot().state;
  if (!state || state.phase === 'gameover') return;
  const active = playerFromState(state, state.turn);
  const humanCount = config.seats.filter((seat) => !seat.ai).length;
  if (!active.isAI && humanCount === 1 && config.seats.some((seat) => seat.ai)) {
    undoStackRef.current.push(E.clone(state));
    if (undoStackRef.current.length > 60) undoStackRef.current.shift();
  }
  if (!active.isAI && humanCount >= 2) setPassSeat(state.turn);
}

function idleMessage(game: GameState, online: OnlineSessionState, now: number): string | null {
  if (!online.turnTimeoutMs || game.phase !== 'play') return null;
  const elapsed = online.serverNow - online.turnStartedAt + (now - online.stateAt);
  const seconds = Math.max(0, Math.ceil((online.turnTimeoutMs - elapsed) / 1_000));
  const active = online.roster.find((player) => player.seat === game.turn);
  const disconnected = active ? !active.connected : false;
  if (online.seat === game.turn) return seconds < 60 ? `${seconds}s 后 AI 接管` : null;
  return disconnected || seconds < 90 ? `${seconds}s 后 AI 接管` : null;
}

async function copyInviteLink(onDone: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    onDone('邀请链接已复制');
  } catch {
    onDone(location.href);
  }
}

interface HomeScreenProps {
  readonly onChooseLocal: () => void;
  readonly onChooseOnline: () => void;
  readonly onOpenRules: () => void;
  readonly onStartTutorial: (mode: TutorialMode) => void;
}

function HomeScreen({
  onChooseLocal,
  onChooseOnline,
  onOpenRules,
  onStartTutorial,
}: HomeScreenProps): ReactElement {
  return (
    <main className="screen">
      <section className="setup-card setup-hub">
        <h1 className="brand">
          <span className="brand-splendor">璀璨宝石</span>
          <span className="brand-dot">·</span>
          <span className="brand-pkmn">宝可梦</span>
        </h1>
        <p className="tagline">收集精灵球，捕捉并进化宝可梦，率先达到 18 分成为冠军训练家！</p>
        <div className="mode-grid" aria-label="选择游戏模式">
          <GameButton className="mode-card mode-online" onClick={onChooseOnline}>
            <span className="mode-icon" aria-hidden="true">
              ◎
            </span>
            <span className="mode-eyebrow">ONLINE ROOM</span>
            <strong>和朋友联机</strong>
            <small>创建房间，分享链接，跨设备一起玩</small>
            <span className="mode-enter">进入联机大厅 →</span>
          </GameButton>
          <GameButton className="mode-card mode-local" onClick={onChooseLocal}>
            <span className="mode-icon" aria-hidden="true">
              ⌁
            </span>
            <span className="mode-eyebrow">SOLO TABLE</span>
            <strong>单机对战</strong>
            <small>同屏多人，或与电脑训练家立即开局</small>
            <span className="mode-enter">设置本地对局 →</span>
          </GameButton>
        </div>
        <div className="setup-actions home-extras">
          <GameButton className="ghost" onClick={onOpenRules}>
            规则说明
          </GameButton>
          <GameButton
            className="ghost"
            onClick={() => {
              onStartTutorial('base');
            }}
          >
            🎓 新手教程
          </GameButton>
          <GameButton
            className="ghost"
            onClick={() => {
              onStartTutorial('megas');
            }}
          >
            ⚡ 超级进化教程
          </GameButton>
        </div>
        <div className="credit">素材源自 TTS 模组「璀璨宝石：宝可梦」 · 卡牌数据由原始卡面提取</div>
      </section>
    </main>
  );
}

interface LocalSetupProps {
  readonly config: LocalConfig;
  readonly onBack: () => void;
  readonly onSelectPlayerCount: (count: number) => void;
  readonly onUpdateSeat: (index: number, update: Partial<LocalSeatConfig>) => void;
  readonly onChangeMegas: (enabled: boolean) => void;
  readonly onChangePokemart: (enabled: boolean) => void;
  readonly onStart: () => void;
}

function LocalSetup({
  config,
  onBack,
  onSelectPlayerCount,
  onUpdateSeat,
  onChangeMegas,
  onChangePokemart,
  onStart,
}: LocalSetupProps): ReactElement {
  return (
    <main className="screen">
      <section className="setup-card setup-hub config-open">
        <div className="config-head">
          <GameButton className="ghost small" onClick={onBack}>
            ← 返回
          </GameButton>
          <strong>单机对战设置</strong>
          <span aria-hidden="true" />
        </div>
        <div className="setup-row">
          <label>玩家人数</label>
          <div className="seg" aria-label="玩家人数">
            {[2, 3, 4].map((count) => (
              <GameButton
                key={count}
                className={config.seats.length === count ? 'active' : ''}
                aria-pressed={config.seats.length === count}
                onClick={() => {
                  onSelectPlayerCount(count);
                }}
              >
                {count}
              </GameButton>
            ))}
          </div>
        </div>
        <div className="seats">
          {config.seats.map((seat, index) => (
            <div className="seat" key={index}>
              <span
                className="pid"
                aria-hidden="true"
                style={{
                  backgroundColor: seatColor(index),
                  backgroundImage: `url(${seatAvatar(index)})`,
                }}
              />
              <GameInput
                className="seat-input"
                type="text"
                value={seat.name}
                maxLength={10}
                aria-label={`${index + 1} 号训练家名字`}
                onValueChange={(value) => {
                  onUpdateSeat(index, { name: value });
                }}
              />
              <GameSelect
                className="seat-select"
                value={seat.ai ? 'ai' : 'human'}
                options={SEAT_KIND_OPTIONS}
                ariaLabel={`${seat.name || `训练家 ${index + 1}`} 类型`}
                onValueChange={(value) => {
                  onUpdateSeat(index, { ai: value === 'ai' });
                }}
              />
              <GameSelect
                className="seat-select"
                value={seat.difficulty}
                disabled={!seat.ai}
                options={DIFFICULTY_OPTIONS}
                ariaLabel={`${seat.name || `训练家 ${index + 1}`} 难度`}
                onValueChange={(value) => {
                  onUpdateSeat(index, { difficulty: value });
                }}
              />
            </div>
          ))}
        </div>
        <div className="setup-row">
          <label>扩展</label>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用超级进化扩展"
            checked={config.megas}
            onCheckedChange={onChangeMegas}
          >
            超级进化（Megas）：第 4 级 Mega 卡 + Mega 代币
          </GameSwitch>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用 Pokémart 扩展"
            checked={config.pokemart}
            onCheckedChange={onChangePokemart}
          >
            Pokémart：药水、进化石、图鉴、糖果与驱虫喷雾
          </GameSwitch>
        </div>
        <div className="setup-actions">
          <GameButton className="primary" onClick={onStart}>
            开始单机对战
          </GameButton>
        </div>
      </section>
    </main>
  );
}

interface OnlineSetupProps {
  readonly config: OnlineConfig;
  readonly creatingRoom: boolean;
  readonly onBack: () => void;
  readonly onChange: (config: OnlineConfig) => void;
  readonly onCreate: () => void;
  readonly onJoin: () => void;
}

function OnlineSetup({
  config,
  creatingRoom,
  onBack,
  onChange,
  onCreate,
  onJoin,
}: OnlineSetupProps): ReactElement {
  return (
    <main className="screen">
      <section className="setup-card setup-hub config-open">
        <div className="config-head">
          <GameButton className="ghost small" onClick={onBack}>
            ← 返回
          </GameButton>
          <strong>联机房间</strong>
          <span aria-hidden="true" />
        </div>
        <label className="field-label" htmlFor="online-name">
          训练家名字
        </label>
        <GameInput
          id="online-name"
          className="setup-input"
          type="text"
          maxLength={20}
          autoComplete="nickname"
          value={config.name}
          onValueChange={(value) => {
            onChange({ ...config, name: value });
          }}
        />
        <div className="online-create-box">
          <div className="online-section-title">
            <span>创建新房间</span>
            <small>房主设置</small>
          </div>
          <GameSwitch
            className="timeout-toggle"
            ariaLabel="启用超时 AI 接管"
            checked={config.timeoutEnabled}
            onCheckedChange={(enabled) => {
              onChange({ ...config, timeoutEnabled: enabled });
            }}
          >
            <span>
              <strong>启用超时 AI 接管</strong>
              <small>默认关闭；玩家超时后由服务器完成本回合</small>
            </span>
          </GameSwitch>
          <label className={`timeout-duration${config.timeoutEnabled ? '' : ' disabled'}`}>
            <span>等待时间</span>
            <GameSelect
              className="timeout-select"
              value={timeoutChoice(config.timeoutMs)}
              options={TIMEOUT_OPTIONS}
              disabled={!config.timeoutEnabled}
              ariaLabel="超时等待时间"
              onValueChange={(value) => {
                onChange({ ...config, timeoutMs: timeoutMsFromChoice(value) });
              }}
            />
          </label>
          <GameButton className="primary wide" disabled={creatingRoom} onClick={onCreate}>
            {creatingRoom ? '创建中…' : '创建联机房间'}
          </GameButton>
        </div>
        <div className="online-join-box">
          <div className="online-section-title">
            <span>加入朋友的房间</span>
          </div>
          <div className="join-row">
            <GameInput
              className="setup-input"
              type="text"
              maxLength={32}
              placeholder="输入房间码"
              autoComplete="off"
              autoCapitalize="characters"
              value={config.roomCode}
              onValueChange={(value) => {
                onChange({ ...config, roomCode: sanitizedRoomCode(value) });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onJoin();
              }}
            />
            <GameButton className="ghost" onClick={onJoin}>
              加入
            </GameButton>
          </div>
        </div>
      </section>
    </main>
  );
}

interface LobbyScreenProps {
  readonly online: OnlineSessionState;
  readonly config: OnlineConfig;
  readonly onStart: (options: RoomStartOptions) => void;
  readonly onLeave: () => void;
  readonly onCopy: () => void;
}

function LobbyScreen({ online, config, onStart, onLeave, onCopy }: LobbyScreenProps): ReactElement {
  const [megas, setMegas] = useState(false);
  const [pokemart, setPokemart] = useState(false);
  const [timeoutEnabled, setTimeoutEnabled] = useState(config.timeoutEnabled);
  const [timeoutMs, setTimeoutMs] = useState(config.timeoutMs);
  const status =
    online.status === 'connecting'
      ? '连接中…'
      : online.status === 'connected'
        ? '已连接'
        : '已断开，重连中…';
  const hostCanStart = online.host && online.roster.length >= 2;
  return (
    <main className="screen">
      <section className="setup-card lobby-card">
        <h1 className="brand">
          <span className="brand-splendor">联机房间</span>
        </h1>
        <div className="lobby-code">
          房间码 <b>{online.code}</b>
          <GameButton className="ghost small" onClick={onCopy}>
            复制邀请链接
          </GameButton>
        </div>
        <div className="lobby-status">
          状态：{status}
          {online.seat === null
            ? ''
            : online.seat < 0
              ? '（观战）'
              : `（你是 ${online.seat + 1} 号位${online.host ? ' · 房主' : ''}）`}
        </div>
        <div className="lobby-roster">
          {online.roster.length ? (
            online.roster.map((player) => (
              <div className="lr-row" key={player.seat}>
                <span className={`lr-dot ${player.connected ? 'on' : 'off'}`} />
                {player.seat + 1}. {player.name}
                {player.seat === 0 ? ' 👑' : ''}
                {player.seat === online.seat ? '（你）' : ''}
              </div>
            ))
          ) : (
            <div className="muted">等待玩家加入…</div>
          )}
        </div>
        <div className="setup-row lobby-exp">
          <label>扩展</label>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用超级进化扩展"
            checked={megas}
            disabled={!online.host}
            onCheckedChange={setMegas}
          >
            超级进化（Megas）
          </GameSwitch>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用 Pokémart 扩展"
            checked={pokemart}
            disabled={!online.host}
            onCheckedChange={setPokemart}
          >
            Pokémart
          </GameSwitch>
        </div>
        <div className="setup-row lobby-timeout">
          <label>超时接管</label>
          <GameSwitch
            className="timeout-toggle compact"
            ariaLabel="启用超时 AI 接管"
            checked={timeoutEnabled}
            disabled={!online.host}
            onCheckedChange={setTimeoutEnabled}
          >
            <span>
              <strong>启用</strong>
              <small>默认关闭</small>
            </span>
          </GameSwitch>
          <GameSelect
            className="setup-select"
            value={timeoutChoice(timeoutMs)}
            options={TIMEOUT_OPTIONS}
            disabled={!online.host || !timeoutEnabled}
            ariaLabel="超时等待时间"
            onValueChange={(value) => {
              setTimeoutMs(timeoutMsFromChoice(value));
            }}
          />
        </div>
        <div className="setup-actions">
          {online.host ? (
            <GameButton
              className="primary"
              disabled={!hostCanStart}
              onClick={() => {
                onStart({ megas, pokemart, turnTimeoutMs: timeoutEnabled ? timeoutMs : null });
              }}
            >
              开始游戏
            </GameButton>
          ) : null}
          <GameButton className="ghost" onClick={onLeave}>
            离开房间
          </GameButton>
        </div>
        <div className="lobby-hint">
          把邀请链接发给朋友；等他们加入后，房主点「开始游戏」。刷新或断线会自动使用同一座位重连。
        </div>
      </section>
    </main>
  );
}

interface GameScreenProps {
  readonly game: GameState;
  readonly online: OnlineSessionState | null;
  readonly selection: GameSelection;
  readonly phase: GameUiPhase;
  readonly busy: boolean;
  readonly logOpen: boolean;
  readonly idleNotice: string | null;
  readonly canInteract: boolean;
  readonly localUndoAvailable: boolean;
  readonly tutorialHideEndTurn: boolean;
  readonly onOpenLog: () => void;
  readonly onCloseLog: () => void;
  readonly onOpenRules: () => void;
  readonly onLeave: () => void;
  readonly onSupplyTake: (color: Color) => void;
  readonly onSupplyReturn: (color: Color) => void;
  readonly onConfirmTake: () => void;
  readonly onClearTake: () => void;
  readonly onSelectCard: (cardId: string) => void;
  readonly onInspect: (cardId: string) => void;
  readonly onSelectDeck: (tier: ReservableTier) => void;
  readonly onReserveSelectedCard: () => void;
  readonly onReserveSelectedDeck: () => void;
  readonly onCaptureSelectedCard: () => void;
  readonly onDiscard: (color: TokenColor) => void;
  readonly onEvolve: (fromId: string, toId: string) => void;
  readonly onMegaEvolve: (megaId: string, fromId: string) => void;
  readonly onTakeMega: () => void;
  readonly onEndTurn: () => void;
  readonly onUndo: () => void;
  readonly onVoteUndo: (approve: boolean) => void;
}

function GameScreen({
  game,
  online,
  selection,
  phase,
  busy,
  logOpen,
  idleNotice,
  canInteract,
  localUndoAvailable,
  tutorialHideEndTurn,
  onOpenLog,
  onCloseLog,
  onOpenRules,
  onLeave,
  onSupplyTake,
  onSupplyReturn,
  onConfirmTake,
  onClearTake,
  onSelectCard,
  onInspect,
  onSelectDeck,
  onReserveSelectedCard,
  onReserveSelectedDeck,
  onCaptureSelectedCard,
  onDiscard,
  onEvolve,
  onMegaEvolve,
  onTakeMega,
  onEndTurn,
  onUndo,
  onVoteUndo,
}: GameScreenProps): ReactElement {
  const ownSeat = online?.seat ?? null;
  const player = ownPlayer(game, ownSeat);
  const isMyTurn = isInteractiveTurn(game, ownSeat, online !== null);
  return (
    <main id="game" className="screen">
      <div id="game-head">
        <header id="topbar" className={topbarState(game, online)}>
          <div className="topbar-left">
            <span className="brand-mini">璀璨宝石 · 宝可梦</span>
          </div>
          <div className="topbar-right">
            {idleNotice ? (
              <span className="idle-bar">
                <span className="idle-wait">⏱ {idleNotice}</span>
              </span>
            ) : null}
            <GameButton
              className="ghost small topbar-action"
              onClick={onOpenLog}
              aria-expanded={logOpen}
            >
              <span aria-hidden="true">◷</span>
              <span>记录</span>
            </GameButton>
            <Menu.Root>
              <Menu.Trigger className="ghost small topbar-action">
                <span aria-hidden="true">☰</span>
                <span>菜单</span>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="end" sideOffset={8}>
                  <Menu.Popup className="topbar-menu">
                    <Menu.Item className="topbar-menu-item" onClick={onOpenRules}>
                      规则说明
                    </Menu.Item>
                    <Menu.Item className="topbar-menu-item" onClick={onLeave}>
                      返回主页
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </header>
      </div>
      <section id="board">
        <FieldArea
          game={game}
          player={player}
          canInteract={canInteract}
          selection={selection}
          onSelectCard={onSelectCard}
          onSelectDeck={onSelectDeck}
          onClearSelection={onClearTake}
        />
      </section>
      <div id="controls">
        <SupplyPanel
          game={game}
          canInteract={canInteract}
          selection={selection}
          onTake={onSupplyTake}
          onReturn={onSupplyReturn}
          onConfirm={onConfirmTake}
          onClear={onClearTake}
          onTakeMega={onTakeMega}
        />
        <ActionDock
          game={game}
          player={player}
          canInteract={canInteract}
          isMyTurn={isMyTurn}
          hideEndTurn={tutorialHideEndTurn}
          selection={selection}
          phase={phase}
          onCapture={onCaptureSelectedCard}
          onReserveCard={onReserveSelectedCard}
          onReserveDeck={onReserveSelectedDeck}
          onClear={onClearTake}
          onDiscard={onDiscard}
          onEvolve={onEvolve}
          onMegaEvolve={onMegaEvolve}
          onEndTurn={onEndTurn}
        />
      </div>
      <footer id="players">
        {game.players.map((trainer, index) => (
          <PlayerPanel
            key={trainer.id}
            game={game}
            player={trainer}
            index={index}
            online={online}
            selection={selection}
            phase={phase}
            busy={busy}
            onSelectCard={onSelectCard}
            onInspect={onInspect}
          />
        ))}
      </footer>
      <LogDrawer
        open={logOpen}
        game={game}
        online={online}
        localUndoAvailable={localUndoAvailable}
        onClose={onCloseLog}
        onUndo={onUndo}
        onVoteUndo={onVoteUndo}
        onInspect={onInspect}
      />
    </main>
  );
}

function topbarState(game: GameState, online: OnlineSessionState | null): string {
  if (game.phase === 'gameover') return 'turn-over';
  const current = playerFromState(game, game.turn);
  if (current.isAI) return 'turn-ai';
  if (!online || online.seat === game.turn) return 'turn-mine';
  return 'turn-wait';
}

function FieldArea({
  game,
  player,
  canInteract,
  selection,
  onSelectCard,
  onSelectDeck,
  onClearSelection,
}: {
  readonly game: GameState;
  readonly player: Player;
  readonly canInteract: boolean;
  readonly selection: GameSelection;
  readonly onSelectCard: (cardId: string) => void;
  readonly onSelectDeck: (tier: ReservableTier) => void;
  readonly onClearSelection: () => void;
}): ReactElement {
  return (
    <section id="field">
      {game.megasEnabled && game.megaOffer.length ? (
        <div className="tier-row tier-special tier-mega">
          <div className="tier-label">Mega</div>
          <div className="card-strip">
            {game.megaOffer.map((id) => (
              <CardTile
                key={id}
                game={game}
                cardId={id}
                selected={selection.selectedCardId === id}
                affordable={
                  canInteract &&
                  player.megaToken >= 1 &&
                  player.board.some(
                    (boardId) => cardFrom(game, boardId).name === cardFrom(game, id).megaFrom,
                  )
                }
                onSelect={onSelectCard}
                onClearSelection={onClearSelection}
              />
            ))}
          </div>
        </div>
      ) : null}
      <TierRow
        game={game}
        player={player}
        tiers={['legend', 'rare']}
        special
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      <TierRow
        game={game}
        player={player}
        tiers={['stage3']}
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      <TierRow
        game={game}
        player={player}
        tiers={['stage2']}
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      <TierRow
        game={game}
        player={player}
        tiers={['stage1']}
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      {game.pokemartEnabled ? (
        <>
          <TierRow
            game={game}
            player={player}
            tiers={['pmL3']}
            pokemart
            canInteract={canInteract}
            selection={selection}
            onSelectCard={onSelectCard}
            onSelectDeck={onSelectDeck}
            onClearSelection={onClearSelection}
          />
          <TierRow
            game={game}
            player={player}
            tiers={['pmL2']}
            pokemart
            canInteract={canInteract}
            selection={selection}
            onSelectCard={onSelectCard}
            onSelectDeck={onSelectDeck}
            onClearSelection={onClearSelection}
          />
          <TierRow
            game={game}
            player={player}
            tiers={['pmL1']}
            pokemart
            canInteract={canInteract}
            selection={selection}
            onSelectCard={onSelectCard}
            onSelectDeck={onSelectDeck}
            onClearSelection={onClearSelection}
          />
        </>
      ) : null}
    </section>
  );
}

interface TierRowProps {
  readonly game: GameState;
  readonly player: Player;
  readonly tiers: readonly BaseTierOrPokemartTier[];
  readonly special?: boolean;
  readonly pokemart?: boolean;
  readonly canInteract: boolean;
  readonly selection: GameSelection;
  readonly onSelectCard: (cardId: string) => void;
  readonly onSelectDeck: (tier: ReservableTier) => void;
  readonly onClearSelection: () => void;
}

type BaseTierOrPokemartTier = BaseTier | PokemartTier;

function TierRow({
  game,
  player,
  tiers,
  special = false,
  pokemart = false,
  canInteract,
  selection,
  onSelectCard,
  onSelectDeck,
  onClearSelection,
}: TierRowProps): ReactElement {
  return (
    <div className={`tier-row${special ? ' tier-special' : ''}${pokemart ? ' tier-pokemart' : ''}`}>
      <div className="tier-label">{tiers.map((tier) => TIER_NAMES[tier]).join('/')}</div>
      {tiers.map((tier) => {
        const cards = game.field[tier] ?? [];
        const deck = game.decks[tier] ?? [];
        const reservable =
          isReservableTier(tier) &&
          canInteract &&
          player.reserve.length < E.HAND_MAX &&
          deck.length > 0;
        return (
          <div className="tier-cluster" key={tier}>
            <DeckPile
              tier={tier}
              count={deck.length}
              reservable={reservable}
              selected={selection.selectedDeck === tier}
              onSelect={() => {
                onSelectDeck(tier);
              }}
              onClearSelection={onClearSelection}
            />
            <div className="card-strip">
              {cards.map((cardId, index) =>
                cardId ? (
                  <CardTile
                    key={cardId}
                    game={game}
                    cardId={cardId}
                    selected={selection.selectedCardId === cardId}
                    affordable={
                      canInteract ? affordInfo(game, player, cardFrom(game, cardId)) : null
                    }
                    onSelect={onSelectCard}
                    onClearSelection={onClearSelection}
                  />
                ) : (
                  <div className="card" key={`${tier}-${index}`}>
                    <div className="empty-slot">—</div>
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeckPile({
  tier,
  count,
  reservable,
  selected,
  onSelect,
  onClearSelection,
}: {
  readonly tier: BaseTierOrPokemartTier;
  readonly count: number;
  readonly reservable: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onClearSelection: () => void;
}): ReactElement {
  if (!reservable) {
    return (
      <div className="deck-pile" data-tier={tier}>
        <div className="count">{count}</div>
      </div>
    );
  }
  return (
    <GameButton
      className={`deck-pile reservable${selected ? ' selected' : ''}`}
      data-tier={tier}
      aria-label={`预留${TIER_NAMES[tier]}牌堆顶，剩余 ${count} 张`}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        if (selected) onClearSelection();
      }}
    >
      <span className="count">{count}</span>
    </GameButton>
  );
}

function CardTile({
  game,
  cardId,
  selected,
  affordable,
  onSelect,
  onClearSelection,
}: {
  readonly game: GameState;
  readonly cardId: string;
  readonly selected: boolean;
  readonly affordable: AffordInfo | null | boolean;
  readonly onSelect: (cardId: string) => void;
  readonly onClearSelection: () => void;
}): ReactElement {
  const card = cardFrom(game, cardId);
  const needsMaster =
    typeof affordable === 'object' && affordable !== null && affordable.master > 0;
  const className = `card${affordable ? (needsMaster ? ' affordable affordable-wild' : ' affordable') : ''}${selected ? ' selected' : ''}`;
  return (
    <HoverTip
      label={<img className="base-card-preview" src={card.img} alt={`${card.name} 卡牌预览`} />}
    >
      <GameButton
        className={className}
        data-card={cardId}
        aria-label={card.name}
        onClick={() => {
          onSelect(cardId);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (selected) onClearSelection();
        }}
      >
        <img src={card.img} alt={card.name} loading="lazy" />
      </GameButton>
    </HoverTip>
  );
}

interface SupplyPanelProps {
  readonly game: GameState;
  readonly canInteract: boolean;
  readonly selection: GameSelection;
  readonly onTake: (color: Color) => void;
  readonly onReturn: (color: Color) => void;
  readonly onConfirm: () => void;
  readonly onClear: () => void;
  readonly onTakeMega: () => void;
}

function SupplyPanel({
  game,
  canInteract,
  selection,
  onTake,
  onReturn,
  onConfirm,
  onClear,
  onTakeMega,
}: SupplyPanelProps): ReactElement {
  const picked = countPicked(selection.pickedBalls);
  const selectionComplete = takeSelectionComplete(game, selection.pickedBalls);
  return (
    <section
      id="supply"
      className={`panel${selection.pickedBalls.length ? ' has-pick' : ''}`}
      aria-label="领取精灵球"
    >
      <div className="panel-title">
        <span>领取精灵球</span>
        {selection.pickedBalls.length ? (
          <span className="supply-quick-actions">
            <GameButton
              className="supply-cancel"
              aria-label="取消领取选择"
              title="取消选择"
              onClick={onClear}
            >
              ×
            </GameButton>
            <GameButton
              className="supply-confirm"
              disabled={!selectionComplete}
              aria-label="确认领取精灵球"
              title="确认领取"
              onClick={onConfirm}
            >
              ✓
            </GameButton>
          </span>
        ) : canInteract ? (
          <span className="supply-control-hints" aria-label="左键领取，右键归还">
            <span>
              <i className="mouse-key mouse-left" aria-hidden="true" />
              领取
            </span>
            <span>
              <i className="mouse-key mouse-right" aria-hidden="true" />
              归还
            </span>
          </span>
        ) : (
          <small>当前库存</small>
        )}
      </div>
      {E.ALL_TOKENS.map((color) => {
        const master = color === 'purple';
        const selectedCount = master ? 0 : (picked[color] ?? 0);
        const selectable = !master && canInteract && canAddBall(game, selection.pickedBalls, color);
        const disabled = master || (!selectable && selectedCount === 0);
        const stackCount = Math.min(3, Math.max(0, game.supply[color] - 1));
        return (
          <GameButton
            key={color}
            className={`supply-row${selectedCount ? ' picked' : ''}${disabled ? ' disabled' : ''}`}
            data-supply-color={color}
            disabled={disabled}
            aria-label={`${BALL_NAMES[color]}，库存 ${game.supply[color]}${selectedCount ? `，已选 ${selectedCount}` : ''}`}
            onClick={() => {
              if (!master) onTake(color);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!master) onReturn(color);
            }}
          >
            <span className="supply-stack" aria-hidden="true">
              {Array.from({ length: stackCount }, (_, index) => (
                <span className="supply-disc supply-stack-token" key={index}>
                  <span className={`ball ${color}`} />
                </span>
              ))}
            </span>
            <span className="supply-disc supply-main-disc">
              <span className={`ball ${color}`} />
            </span>
            {selectedCount ? <span className="picked-n">✓ {selectedCount}</span> : null}
            <span className="cnt">{game.supply[color]}</span>
          </GameButton>
        );
      })}
      {game.megasEnabled ? (
        <GameButton
          className={`supply-row mega-row${canInteract && (game.supply.megaToken ?? 0) > 0 ? '' : ' disabled'}`}
          data-supply-color="mega"
          data-take-mega="true"
          disabled={!canInteract || (game.supply.megaToken ?? 0) <= 0}
          aria-label={`Mega 代币，库存 ${game.supply.megaToken ?? 0}`}
          onClick={onTakeMega}
        >
          <span className="supply-disc supply-main-disc">
            <span className="ball mega-token" />
          </span>
          <span className="cnt">{game.supply.megaToken ?? 0}</span>
        </GameButton>
      ) : null}
    </section>
  );
}

function countPicked(colors: readonly Color[]): Partial<Record<Color, number>> {
  const counts: Partial<Record<Color, number>> = {};
  for (const color of colors) counts[color] = (counts[color] ?? 0) + 1;
  return counts;
}

interface ActionDockProps {
  readonly game: GameState;
  readonly player: Player;
  readonly canInteract: boolean;
  readonly isMyTurn: boolean;
  readonly hideEndTurn: boolean;
  readonly selection: GameSelection;
  readonly phase: GameUiPhase;
  readonly onCapture: () => void;
  readonly onReserveCard: () => void;
  readonly onReserveDeck: () => void;
  readonly onClear: () => void;
  readonly onDiscard: (color: TokenColor) => void;
  readonly onEvolve: (fromId: string, toId: string) => void;
  readonly onMegaEvolve: (megaId: string, fromId: string) => void;
  readonly onEndTurn: () => void;
}

function ActionDock({
  game,
  player,
  canInteract,
  isMyTurn,
  hideEndTurn,
  selection,
  phase,
  onCapture,
  onReserveCard,
  onReserveDeck,
  onClear,
  onDiscard,
  onEvolve,
  onMegaEvolve,
  onEndTurn,
}: ActionDockProps): ReactElement {
  if (game.phase === 'gameover' || player.isAI || !isMyTurn) {
    return <section id="action-bar" className="panel action-idle" aria-label="行动区" />;
  }
  if (phase === 'discard') {
    const total = E.tokenTotal(player);
    return (
      <section id="action-bar" className="panel" aria-label="归还精灵球">
        <div className="discard-head">
          <span className="discard-mark" aria-hidden="true">
            ↙
          </span>
          <span className="discard-copy">
            <small>精灵球达到上限</small>
            <strong>归还 {total - E.TOKEN_MAX} 个</strong>
          </span>
          <span className="discard-total">
            {total}
            <small>/{E.TOKEN_MAX}</small>
          </span>
        </div>
        <div className="discard-token-list">
          {E.ALL_TOKENS.filter((color) => player.tokens[color] > 0).map((color) => (
            <HoverTip key={color} label={BALL_NAMES[color]}>
              <GameButton
                className={`discard-token ${color}`}
                onClick={() => {
                  onDiscard(color);
                }}
                aria-label={`归还一个${BALL_NAMES[color]}`}
              >
                <span className="discard-token-art">
                  <span className={`ball ${color}`} />
                </span>
                <span className="discard-token-count">{player.tokens[color]}</span>
                <span className="discard-token-minus">−1</span>
              </GameButton>
            </HoverTip>
          ))}
        </div>
      </section>
    );
  }
  if (phase === 'evolve') {
    const options = dedupeEvolutionOptions(game, E.evolutionOptions(game, player));
    const megaOptions = game.megasEnabled ? E.megaEvolveOptions(game, player) : [];
    return (
      <section id="action-bar" className="panel" aria-label="回合结算">
        <div className="act-hint">回合结束 · 可进化一只宝可梦（可选，每回合至多 1 次）</div>
        {options.map((option) => {
          const from = cardFrom(game, option.fromId);
          const to = cardFrom(game, option.toId);
          return (
            <GameButton
              className="evo-option"
              key={`${option.fromId}-${option.toId}`}
              onClick={() => {
                onEvolve(option.fromId, option.toId);
              }}
            >
              <b>{from.name}</b> → <b>{to.name}</b>（+{to.vp - from.vp} 分，需 {option.count} 个
              {BALL_NAMES[option.color]}折扣）
            </GameButton>
          );
        })}
        {megaOptions.map((option) => {
          const from = cardFrom(game, option.fromId);
          const mega = cardFrom(game, option.megaId);
          const cost = E.ALL_TOKENS.filter((color) => mega.cost[color] > 0)
            .map((color) => `${mega.cost[color]}${BALL_NAMES[color]}`)
            .join('+');
          return (
            <GameButton
              className="evo-option mega-evo"
              key={`${option.megaId}-${option.fromId}`}
              onClick={() => {
                onMegaEvolve(option.megaId, option.fromId);
              }}
            >
              ⚡<b>{from.name}</b> → <b>{mega.name}</b>（+{mega.vp - from.vp} 分，付 {cost}，耗 1
              Mega 代币）
            </GameButton>
          );
        })}
        {hideEndTurn ? null : (
          <div className="act-buttons">
            <GameButton className="primary" onClick={onEndTurn}>
              不进化，结束回合
            </GameButton>
          </div>
        )}
      </section>
    );
  }
  if (selection.selectedCardId) {
    const card = cardFrom(game, selection.selectedCardId);
    const info = affordInfo(game, player, card);
    const captureReason = info ? null : captureBlockedReason(game, player, card);
    const location = E.locateCard(game, card.id);
    const canReserve =
      location.where === 'field' &&
      (isNormalTier(location.tier) || isPokemartTier(location.tier)) &&
      player.reserve.length < E.HAND_MAX;
    const reserveReason = canReserve ? null : reserveBlockedReason(game, player, card.id);
    return (
      <section id="action-bar" className="panel action-card" aria-label="捕捉交易">
        <PaymentLedger game={game} player={player} card={card} info={info} />
        <div className="act-buttons capture-actions">
          <ActionControl reason={captureReason}>
            <GameButton className="primary" disabled={!info || !canInteract} onClick={onCapture}>
              捕捉
            </GameButton>
          </ActionControl>
          <ActionControl reason={reserveReason}>
            <GameButton
              className="reserve-action"
              disabled={!canReserve || !canInteract}
              onClick={onReserveCard}
            >
              <span aria-hidden="true">◇</span>预留
            </GameButton>
          </ActionControl>
          <ActionControl>
            <GameButton className="ghost" onClick={onClear}>
              取消
            </GameButton>
          </ActionControl>
        </div>
      </section>
    );
  }
  if (selection.selectedDeck) {
    return (
      <section id="action-bar" className="panel" aria-label="预留牌堆顶">
        <div className="act-hint">
          预留 <b>{TIER_NAMES[selection.selectedDeck]}</b> 牌堆顶的宝可梦（获得 1 个大师球）？
        </div>
        <div className="act-buttons">
          <GameButton className="reserve-action" disabled={!canInteract} onClick={onReserveDeck}>
            <span aria-hidden="true">◇</span>预留牌堆顶
          </GameButton>
          <GameButton className="ghost" onClick={onClear}>
            取消
          </GameButton>
        </div>
      </section>
    );
  }
  return <section id="action-bar" className="panel action-idle" aria-label="行动区" />;
}

function ActionControl({
  reason,
  children,
}: {
  readonly reason?: string | null;
  readonly children: ReactNode;
}): ReactElement {
  const control = (
    <span className={`action-control${reason ? ' has-reason' : ''}`}>{children}</span>
  );
  return reason ? <HoverTip label={reason}>{control}</HoverTip> : control;
}

function PaymentLedger({
  game,
  player,
  card,
  info,
}: {
  readonly game: GameState;
  readonly player: Player;
  readonly card: Card;
  readonly info: AffordInfo | null;
}): ReactElement | null {
  const rows = paymentRows(game, player, card, info);
  if (!rows.length) return null;
  return (
    <div className={`pay-ledger${info ? '' : ' unafford'}`}>
      <div className="pay-token-list">
        {rows.map((row) => (
          <HoverTip
            block
            key={row.color}
            label={`${BALL_NAMES[row.color]}：原需 ${row.required}，折后 ${row.due}，交易后剩余 ${row.after}`}
          >
            <div className={`pay-token ${row.color}${row.after < 0 ? ' negative' : ''}`}>
              <span className="pay-token-art">
                <span className={`ball ${row.color}`} />
              </span>
              <span className="pay-metric pay-cost">
                <b>{row.required}</b>
                <i>/</i>
                <b>{row.due}</b>
              </span>
              <span className={`pay-metric pay-after${row.after < 0 ? ' negative' : ''}`}>
                <small>余</small>
                <b>{row.after}</b>
              </span>
              {row.paidWild ? <span className="pay-token-master">★{row.paidWild}</span> : null}
            </div>
          </HoverTip>
        ))}
      </div>
    </div>
  );
}

interface PlayerPanelProps {
  readonly game: GameState;
  readonly player: Player;
  readonly index: number;
  readonly online: OnlineSessionState | null;
  readonly selection: GameSelection;
  readonly phase: GameUiPhase;
  readonly busy: boolean;
  readonly onSelectCard: (cardId: string) => void;
  readonly onInspect: (cardId: string) => void;
}

function PlayerPanel({
  game,
  player,
  index,
  online,
  selection,
  phase,
  busy,
  onSelectCard,
  onInspect,
}: PlayerPanelProps): ReactElement {
  const active = index === game.turn && game.phase === 'play';
  const mine = online ? online.seat === index : active && !player.isAI;
  const bonuses = E.bonuses(game, player);
  const total = E.tokenTotal(player);
  const status = turnStatus(
    game,
    player,
    index,
    online?.seat ?? null,
    online !== null,
    phase,
    selection,
    busy,
  );
  const revealReserve = !player.isAI && (online ? index === online.seat : active);
  const groups: ReadonlyArray<{ readonly key: Color | 'other'; readonly ids: readonly string[] }> =
    [
      ...E.COLORS.map((color) => ({
        key: color,
        ids: player.board.filter((id) => E.effBonusColor(game, player, id) === color),
      })),
      {
        key: 'other',
        ids: player.board.filter((id) => E.effBonusColor(game, player, id) === null),
      },
    ];
  return (
    <section
      className={`player${active ? ' active' : ''}${mine ? ' mine' : ''}${player.isAI ? ' ai' : ''}`}
      data-player={index}
    >
      <div className="player-head">
        <span
          className="pavatar"
          aria-hidden="true"
          style={{
            backgroundColor: seatColor(index),
            backgroundImage: `url(${seatAvatar(index)})`,
            boxShadow: `0 0 0 2px ${seatColor(index)}`,
          }}
        />
        <div className="player-heading">
          <div className="pname">
            {player.name}
            {mine ? <span className="player-me">你</span> : null}
          </div>
          {status ? <div className="player-turn-status">{status}</div> : null}
        </div>
        <div className="pscore">
          {E.scoreOf(game, player)}
          <small>/{game.winScore}</small>
        </div>
      </div>
      {player.buried.length ? (
        <div className="buried-badge">已进化 {player.buried.length}</div>
      ) : null}
      <div className="player-body">
        <div className="player-assets">
          <div className="pstats">
            <HoverTip label={`持有的精灵球总数：${total}/${E.TOKEN_MAX}`}>
              <span
                className={`ptokens${total > E.TOKEN_MAX ? ' over' : total === E.TOKEN_MAX ? ' full' : ''}`}
              >
                <span className="pt-lbl">球</span>
                <strong>{total}</strong>
                <small>/{E.TOKEN_MAX}</small>
              </span>
            </HoverTip>
            {E.COLORS.map((color) => (
              <HoverTip
                key={color}
                label={`${BALL_NAMES[color]}：持有 ${player.tokens[color]}，永久折扣 ${bonuses[color]}`}
              >
                <span className="trainer-token" data-token-color={color}>
                  <span className={`ball ${color}`} />
                  <span className="trainer-token-count">{player.tokens[color]}</span>
                  <span className="trainer-token-bonus">+{bonuses[color]}</span>
                </span>
              </HoverTip>
            ))}
            <HoverTip label={`${BALL_NAMES.purple}：持有 ${player.tokens.purple}`}>
              <span className="trainer-token" data-token-color="purple">
                <span className="ball purple" />
                <span className="trainer-token-count">{player.tokens.purple}</span>
              </span>
            </HoverTip>
            {game.megasEnabled ? (
              <HoverTip label={`Mega 代币：持有 ${player.megaToken}`}>
                <span className="trainer-token" data-token-color="mega">
                  <span className="ball mega-token" />
                  <span className="trainer-token-count">{player.megaToken}</span>
                </span>
              </HoverTip>
            ) : null}
          </div>
          <div className="pcards capture-zone" data-capture-zone>
            {groups
              .filter((group) => group.ids.length > 0)
              .map((group) => (
                <div className="color-stack" key={group.key}>
                  <div className="ministack">
                    {group.ids.map((id, cardIndex) => (
                      <MiniCard
                        key={id}
                        game={game}
                        cardId={id}
                        stacked={cardIndex > 0}
                        onInspect={onInspect}
                      />
                    ))}
                  </div>
                </div>
              ))}
            {!player.board.length ? <span className="empty-player-cards">尚无宝可梦</span> : null}
          </div>
        </div>
        {player.reserve.length ? (
          <div className="reserve-zone" data-reserve-zone>
            <div className="rz-title">预留区 ({player.reserve.length})</div>
            <div className="pcards">
              {player.reserve.map((id, slot) => {
                const hiddenTier = hiddenReserveTier(id);
                if (revealReserve && !hiddenTier) {
                  return (
                    <MiniCard
                      key={`${id}-${slot}`}
                      game={game}
                      cardId={id}
                      stacked={false}
                      selected={selection.selectedCardId === id}
                      onInspect={onInspect}
                      onSelect={onSelectCard}
                      reserve
                    />
                  );
                }
                const tier = hiddenTier ?? cardFrom(game, id).tier;
                return (
                  <div
                    className="mini-card card-back"
                    key={`${id}-${slot}`}
                    data-tier={tier}
                    data-reserved-slot={slot}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MiniCard({
  game,
  cardId,
  stacked,
  selected = false,
  reserve = false,
  onInspect,
  onSelect,
}: {
  readonly game: GameState;
  readonly cardId: string;
  readonly stacked: boolean;
  readonly selected?: boolean;
  readonly reserve?: boolean;
  readonly onInspect: (cardId: string) => void;
  readonly onSelect?: (cardId: string) => void;
}): ReactElement {
  const card = cardFrom(game, cardId);
  return (
    <HoverTip
      label={<img className="base-card-preview" src={card.img} alt={`${card.name} 卡牌预览`} />}
    >
      <GameButton
        className={`mini-card${stacked ? ' stacked' : ''}${selected ? ' selected' : ''}`}
        data-captured-card={reserve ? undefined : cardId}
        data-reserved-card={reserve ? cardId : undefined}
        aria-label={card.name}
        onClick={() => {
          if (reserve && onSelect) onSelect(cardId);
          else onInspect(cardId);
        }}
      >
        <img src={card.img} alt={card.name} loading="lazy" />
      </GameButton>
    </HoverTip>
  );
}

interface LogDrawerProps {
  readonly open: boolean;
  readonly game: GameState;
  readonly online: OnlineSessionState | null;
  readonly localUndoAvailable: boolean;
  readonly onClose: () => void;
  readonly onUndo: () => void;
  readonly onVoteUndo: (approve: boolean) => void;
  readonly onInspect: (cardId: string) => void;
}

function LogDrawer({
  open,
  game,
  online,
  localUndoAvailable,
  onClose,
  onUndo,
  onVoteUndo,
  onInspect,
}: LogDrawerProps): ReactElement {
  const vote = online?.undoVote ?? null;
  const requester = vote
    ? online?.roster.find((player) => player.seat === vote.requesterSeat)
    : null;
  const alreadyVoted = Boolean(
    vote && online && online.seat !== null && vote.approvals.includes(online.seat),
  );
  const canUndo = online
    ? game.phase === 'play' && (online.seat ?? -1) >= 0 && online.undoAvailable && !vote
    : game.phase === 'play' && localUndoAvailable;
  return (
    <Drawer.Root
      open={open}
      modal={false}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      swipeDirection="right"
    >
      <Drawer.Portal>
        <Drawer.Viewport className="base-drawer-viewport">
          <Drawer.Popup className="panel log-drawer" aria-label="游戏记录">
            <div className="panel-title">
              <span>
                <span aria-hidden="true">◷</span> 游戏记录
              </span>
              <GameButton className="ghost small" aria-label="关闭游戏记录" onClick={onClose}>
                ×
              </GameButton>
            </div>
            <div className="log-lines">
              {game.log.length ? (
                game.log
                  .slice(-40)
                  .map((entry, index) => (
                    <LogLine
                      entry={entry}
                      game={game}
                      key={`${entry.round}-${entry.turn}-${index}`}
                      onInspect={onInspect}
                    />
                  ))
              ) : (
                <div className="log-empty">行动后，记录会出现在这里。</div>
              )}
            </div>
            <div className="log-tools">
              <div className="log-tools-title">对局功能</div>
              {canUndo ? (
                <GameButton className="ghost log-undo" onClick={onUndo}>
                  <span aria-hidden="true">↶</span>悔棋
                </GameButton>
              ) : null}
              {vote ? (
                <div className="undo-vote">
                  <div>
                    <b>{requester?.name ?? `玩家 ${vote.requesterSeat + 1}`}</b> 发起悔棋
                  </div>
                  <div className="vote-progress">
                    {vote.approvals.length}/{vote.total || game.numPlayers} 已同意 · 需要全员同意
                  </div>
                  {alreadyVoted ? (
                    <div className="vote-waiting">你已同意，等待其他玩家…</div>
                  ) : (
                    <div className="vote-actions">
                      <GameButton
                        className="primary"
                        onClick={() => {
                          onVoteUndo(true);
                        }}
                      >
                        同意
                      </GameButton>
                      <GameButton
                        className="ghost"
                        onClick={() => {
                          onVoteUndo(false);
                        }}
                      >
                        拒绝
                      </GameButton>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function LogLine({
  entry,
  game,
  onInspect,
}: {
  readonly entry: GameLogEntry;
  readonly game: GameState;
  readonly onInspect: (cardId: string) => void;
}): ReactElement {
  const message = entry.msg
    .replaceAll('保留区', '预留区')
    .replaceAll('签约区', '预留区')
    .replaceAll('保留', '预留')
    .replaceAll('签约', '预留')
    .replaceAll('拿取', '领取');
  if (entry.kind === 'take' && entry.colors) {
    const marker = '领取';
    const position = message.indexOf(marker);
    const lead = position >= 0 ? message.slice(0, position + marker.length) : message;
    return (
      <div className="ln log-inline">
        <span>{lead}</span>
        <span className="log-thumbs">
          {entry.colors.map((color, index) => (
            <HoverTip key={`${color}-${index}`} label={BALL_NAMES[color]}>
              <span className="log-thumb ball-thumb">
                <span className={`ball ${color}`} />
              </span>
            </HoverTip>
          ))}
        </span>
      </div>
    );
  }
  if (entry.kind === 'capture' && entry.cardId && game.byId[entry.cardId]) {
    const card = cardFrom(game, entry.cardId);
    const position = message.indexOf(card.name);
    if (position >= 0) {
      return (
        <div className="ln log-inline">
          <span>{message.slice(0, position)}</span>
          <HoverTip
            label={
              <img className="base-card-preview" src={card.img} alt={`${card.name} 卡牌预览`} />
            }
          >
            <GameButton
              className="log-thumb"
              onClick={() => {
                onInspect(card.id);
              }}
            >
              <img src={card.img} alt={card.name} />
            </GameButton>
          </HoverTip>
          <span>{message.slice(position + card.name.length)}</span>
        </div>
      );
    }
  }
  return (
    <div className="ln">
      <span>{message}</span>
    </div>
  );
}

function RulesDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <Modal open={open} onOpenChange={onOpenChange} label="游戏规则">
      <h2>游戏规则</h2>
      <div className="rules-body">
        <p>
          <b>目标：</b>率先达到 <b>18 分</b>。有人达成后，本轮结束；分高者获胜。
        </p>
        <p>
          <b>精灵球：</b>精灵球、超级球、高级球、治愈球、先机球，以及可替代任意颜色的<b>大师球</b>。
        </p>
        <p>
          <b>每回合选择一项主行动：</b>
        </p>
        <ul>
          <li>
            领取 3 个<b>不同</b>颜色的精灵球；
          </li>
          <li>
            领取 2 个<b>同色</b>精灵球（该色供应至少为 4）；
          </li>
          <li>预留一张普通宝可梦或牌堆顶，并获得 1 个大师球。</li>
        </ul>
        <p>
          <b>捕捉：</b>支付卡牌成本。已捕捉宝可梦提供永久折扣；稀有与传说卡需要大师球。
        </p>
        <p>
          <b>进化：</b>在回合结束时，满足折扣条件可进化一只宝可梦。回合结束时持有精灵球不能超过 10
          个。
        </p>
      </div>
      <GameButton
        className="primary"
        onClick={() => {
          onOpenChange(false);
        }}
      >
        明白了
      </GameButton>
    </Modal>
  );
}

function InspectDialog({
  card,
  onClose,
}: {
  readonly card: Card | null;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Modal
      open={card !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label={card ? `${card.name} 卡牌详情` : '卡牌详情'}
      className="inspect-dialog"
    >
      {card ? (
        <div id="inspect-inner">
          <img id="inspect-img" src={card.img} alt={card.name} />
          <div id="inspect-actions">
            <GameButton className="ghost" onClick={onClose}>
              关闭
            </GameButton>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ChoiceDialog({
  choice,
  cardById,
  onChangeSelected,
  onResolve,
}: {
  readonly choice: ChoiceRequest | null;
  readonly cardById: (id: string) => Card | null;
  readonly onChangeSelected: (selected: readonly string[]) => void;
  readonly onResolve: (value: readonly string[] | null) => void;
}): ReactElement {
  const select = (id: string): void => {
    if (!choice) return;
    if (choice.selected.includes(id)) {
      onChangeSelected(choice.selected.filter((selected) => selected !== id));
      return;
    }
    if (choice.count === 1) {
      onChangeSelected([id]);
      return;
    }
    if (choice.selected.length < choice.count) onChangeSelected([...choice.selected, id]);
  };
  return (
    <Modal
      open={choice !== null}
      onOpenChange={(open) => {
        if (!open) onResolve(null);
      }}
      label={choice?.title ?? '选择卡牌'}
      className="choice"
    >
      {choice ? (
        <>
          <div className="choice-title">{choice.title}</div>
          {choice.hint ? <div className="choice-hint">{choice.hint}</div> : null}
          <div className="choice-cards">
            {choice.candidates.map((id) => {
              const card = cardById(id);
              if (!card) return null;
              return (
                <GameButton
                  key={id}
                  className={`choice-card${choice.selected.includes(id) ? ' sel' : ''}`}
                  aria-pressed={choice.selected.includes(id)}
                  onClick={() => {
                    select(id);
                  }}
                >
                  <img src={card.img} alt={card.name} />
                  <span>{card.name}</span>
                </GameButton>
              );
            })}
          </div>
          <div className="choice-actions">
            <GameButton
              className="primary"
              disabled={choice.selected.length !== choice.count}
              onClick={() => {
                onResolve(choice.selected);
              }}
            >
              确定
            </GameButton>
            <GameButton
              className="ghost"
              onClick={() => {
                onResolve(null);
              }}
            >
              取消
            </GameButton>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function WinDialog({
  game,
  open,
  onLeave,
}: {
  readonly game: GameState | null;
  readonly open: boolean;
  readonly onLeave: () => void;
}): ReactElement {
  const winner = game?.winner ?? (game ? E.determineWinner(game) : null);
  const scores = game
    ? game.players
        .map((player, index) => ({
          index,
          score: E.scoreOf(game, player),
          buried: player.buried.length,
          board: player.board.length,
          name: player.name,
        }))
        .sort(
          (left, right) =>
            right.score - left.score || right.buried - left.buried || right.board - left.board,
        )
    : [];
  return (
    <Modal
      open={open && game !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onLeave();
      }}
      label="对局结果"
      className="win"
    >
      {game && winner !== null ? (
        <>
          <div className="win-trophy" aria-hidden="true">
            🏆
          </div>
          <h2>{playerFromState(game, winner).name} 获胜！</h2>
          <div className="win-scores">
            {scores.map((score) => (
              <div className={`wrow${score.index === winner ? ' winner' : ''}`} key={score.index}>
                <span>
                  {score.index === winner ? '👑 ' : ''}
                  {score.name}
                </span>
                <span>
                  {score.score} 分 · {score.board} 只 · 进化 {score.buried}
                </span>
              </div>
            ))}
          </div>
          <GameButton className="primary" onClick={onLeave}>
            再来一局
          </GameButton>
        </>
      ) : null}
    </Modal>
  );
}

function PassDialog({
  game,
  seat,
  onReady,
}: {
  readonly game: GameState | null;
  readonly seat: number | null;
  readonly onReady: () => void;
}): ReactElement {
  const player = game && seat !== null ? game.players[seat] : null;
  return (
    <Modal
      open={player !== undefined && player !== null}
      onOpenChange={(open) => {
        if (!open) onReady();
      }}
      label="交接设备"
      className="pass-dialog"
    >
      {player && seat !== null ? (
        <div className="pass-dialog-content">
          <span
            className="pavatar pass-avatar"
            aria-hidden="true"
            style={{
              backgroundColor: seatColor(seat),
              backgroundImage: `url(${seatAvatar(seat)})`,
              boxShadow: `0 0 0 3px ${seatColor(seat)}`,
            }}
          />
          <h2>
            请将设备交给
            <br />
            {player.name}
          </h2>
          <p>其他训练家的预留区会保持隐藏。</p>
          <GameButton className="primary" onClick={onReady}>
            我准备好了
          </GameButton>
        </div>
      ) : null}
    </Modal>
  );
}

function LeaveGameDialog({
  open,
  tutorial,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly tutorial: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
      label={tutorial ? '退出教程' : '返回主页'}
      className="leave-dialog"
    >
      <h2>{tutorial ? '退出教程？' : '返回主页？'}</h2>
      <p>{tutorial ? '当前教程进度不会保留。' : '当前对局会结束，且不会保留进度。'}</p>
      <div className="choice-actions">
        <GameButton className="primary" onClick={onConfirm}>
          {tutorial ? '退出教程' : '返回主页'}
        </GameButton>
        <GameButton className="ghost" onClick={onCancel}>
          继续对局
        </GameButton>
      </div>
    </Modal>
  );
}

function TutorialCoach({
  tutorial,
  onNext,
  onExit,
}: {
  readonly tutorial: TutorialRun | null;
  readonly onNext: () => void;
  readonly onExit: () => void;
}): ReactElement | null {
  const [spotlight, setSpotlight] = useState<DOMRect | null>(null);
  const step =
    tutorial && !tutorial.completed ? tutorialSteps(tutorial.mode)[tutorial.stepIndex] : null;

  useEffect(() => {
    if (!step?.target) {
      setSpotlight(null);
      return undefined;
    }
    const updateSpotlight = (): void => {
      const target = document.querySelector<HTMLElement>(step.target ?? '');
      if (!target) {
        setSpotlight(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setSpotlight(null);
        return;
      }
      setSpotlight(rect);
    };
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(step.target ?? '');
      target?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      updateSpotlight();
    });
    window.addEventListener('resize', updateSpotlight);
    window.addEventListener('scroll', updateSpotlight, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateSpotlight);
      window.removeEventListener('scroll', updateSpotlight, true);
    };
  }, [step]);

  if (!tutorial) return null;
  const complete = tutorial.completed;
  const copy = complete ? tutorialCompletion(tutorial.mode) : (step?.copy ?? []);
  const title = complete
    ? tutorial.mode === 'megas'
      ? '⚡ 学会超级进化！'
      : '🏆 恭喜通关！'
    : step?.title;
  return (
    <>
      {spotlight ? (
        <div
          className="tutorial-spotlight"
          aria-hidden="true"
          style={{
            left: spotlight.left - 8,
            top: spotlight.top - 8,
            width: spotlight.width + 16,
            height: spotlight.height + 16,
          }}
        />
      ) : null}
      <aside className="tutorial-coach" aria-live="polite" aria-label="新手教程">
        <div className="tutorial-step">
          {complete
            ? '教程完成'
            : `第 ${(tutorial.stepIndex + 1).toString()} / ${tutorialSteps(tutorial.mode).length.toString()} 步`}
        </div>
        <h2>{title}</h2>
        <div className="tutorial-copy">
          {copy.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="tutorial-actions">
          {complete ? (
            <GameButton className="primary" onClick={onExit}>
              开始一局对局
            </GameButton>
          ) : step?.next ? (
            <GameButton className="primary" onClick={onNext}>
              下一步 ▶
            </GameButton>
          ) : (
            <>
              <span className="tutorial-hint">按上面的提示操作…</span>
              <GameButton className="ghost small" onClick={onNext}>
                跳过此步
              </GameButton>
            </>
          )}
          <GameButton className="ghost small" onClick={onExit}>
            {complete ? '返回主页' : '退出教程'}
          </GameButton>
        </div>
      </aside>
    </>
  );
}
