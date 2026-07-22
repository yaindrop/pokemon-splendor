import { Engine as E, type GameAction, type GameState } from '@pokemon-splendor/game-core';
import {
  cards as CARD_DB,
  megas as MEGA_DB,
  pokemart as POKEMART_DB,
} from '@pokemon-splendor/game-data';
import { useEffect, useRef, useState } from 'react';
import { Net } from '../../net.js';
import { LocalGameSession } from '../../session/localGameSession.js';
import { OnlineGameSession } from '../../session/onlineGameSession.js';
import type { OnlineSessionState } from '../../session/types.js';
import {
  CARD_CATALOG,
  EMPTY_SELECTION,
  type LocalConfig,
  type OnlineConfig,
  type Screen,
  createInitialLocalConfig,
  createInitialOnlineConfig,
  initialSeats,
  roomCodeFromLocation,
  sanitizedRoomCode,
} from './app-model.js';
import { prepareLocalTurn } from './local-turn.js';
import { captureStateTransition, playPendingFlights, type PendingFlight } from './motion.js';
import type { GameSelection, GameUiPhase } from './model.js';
import {
  createTutorialGame,
  snapshotTutorial,
  tutorialSteps,
  type TutorialMode,
} from './tutorial.js';
import { setActiveGameSession } from '../uiStore.js';

export type GameRuntime = ReturnType<typeof useGameRuntime>;

// The exported ReturnType keeps the hook contract synchronized without a duplicate 40-field interface.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useGameRuntime() {
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
  const [inspectCardId, setInspectCardId] = useState<string | null>(null);
  const [winOpen, setWinOpen] = useState(false);
  const [passSeat, setPassSeat] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tutorial, setTutorial] = useState<{
    readonly mode: TutorialMode;
    readonly stepIndex: number;
    readonly baseline: ReturnType<typeof snapshotTutorial>;
    readonly completed: boolean;
  } | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const localSessionRef = useRef<LocalGameSession | null>(null);
  const onlineSessionRef = useRef<OnlineGameSession | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const undoStackRef = useRef<GameState[]>([]);
  const aiPendingRef = useRef(false);
  const handledNoticeRevisionRef = useRef(0);
  const openedRoomFromLocationRef = useRef(false);
  const gameRef = useRef<GameState | null>(null);
  const motionRef = useRef<PendingFlight[]>([]);

  const showToast = (message: string): void => {
    setToast(message);
  };

  const resetGameUi = (): void => {
    setSelection(EMPTY_SELECTION);
    setPhase('main');
    setBusy(false);
    setInspectCardId(null);
    setPassSeat(null);
    setWinOpen(false);
    setLogOpen(false);
    setLeaveConfirmOpen(false);
  };

  const releaseSession = (leaveOnline: boolean): void => {
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
  };

  const attachLocalSession = (session: LocalGameSession): void => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = session.subscribe(() => {
      const snapshot = session.getSnapshot();
      gameRef.current = snapshot.state;
      setGame(snapshot.state);
    });
    setActiveGameSession(session);
  };

  const attachOnlineSession = (session: OnlineGameSession): void => {
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
      const notice = snapshot.online?.notice;
      if (notice && snapshot.online.noticeRevision > handledNoticeRevisionRef.current) {
        handledNoticeRevisionRef.current = snapshot.online.noticeRevision;
        showToast(notice.message);
      }
    });
    setActiveGameSession(session);
  };

  const setTutorialStep = (mode: TutorialMode, stepIndex: number, state: GameState): void => {
    const step = tutorialSteps(mode)[stepIndex];
    if (!step) {
      setTutorial({ mode, stepIndex, baseline: snapshotTutorial(state), completed: true });
      return;
    }
    const arranged = E.clone(state);
    step.arrange?.(arranged);
    localSessionRef.current?.replaceState(arranged);
    gameRef.current = arranged;
    setGame(arranged);
    setSelection(EMPTY_SELECTION);
    setPhase('main');
    setTutorial({ mode, stepIndex, baseline: snapshotTutorial(arranged), completed: false });
  };

  const startTutorial = (mode: TutorialMode): void => {
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
  };

  const advanceTutorial = (): void => {
    if (!tutorial || tutorial.completed) return;
    const state = localSessionRef.current?.getSnapshot().state;
    if (state) setTutorialStep(tutorial.mode, tutorial.stepIndex + 1, state);
  };

  const startLocalGame = (): void => {
    releaseSession(false);
    setTutorial(null);
    const gameState = E.createGame(CARD_DB, {
      numPlayers: localConfig.seats.length,
      names: localConfig.seats.map((seat) => seat.name.trim() || '训练家'),
      ai: localConfig.seats.map((seat) => seat.ai),
      megas: localConfig.megas && MEGA_DB.length > 0,
      megaDB: MEGA_DB,
      pokemart: localConfig.pokemart && POKEMART_DB.length > 0,
      pokemartDB: POKEMART_DB,
    });
    gameState.players.forEach((player, index) => {
      player.diff = localConfig.seats[index]?.difficulty ?? 'hard';
    });
    const session = new LocalGameSession(gameState);
    localSessionRef.current = session;
    attachLocalSession(session);
    undoStackRef.current = [];
    gameRef.current = gameState;
    setGame(gameState);
    resetGameUi();
    setScreen('game');
    prepareLocalTurn(session, localConfig, undoStackRef.current, setPassSeat);
  };

  const openOnlineRoom = (code: string, host: boolean): void => {
    const cleanCode = sanitizedRoomCode(code);
    if (!cleanCode) {
      showToast('请输入有效房间码');
      return;
    }
    releaseSession(false);
    setTutorial(null);
    const session = new OnlineGameSession({
      net: Net,
      code: cleanCode,
      name: onlineConfig.name.trim() || '训练家',
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
  };

  const createOnlineRoom = async (): Promise<void> => {
    setCreatingRoom(true);
    try {
      openOnlineRoom(await Net.createRoom(), true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法创建房间');
    } finally {
      setCreatingRoom(false);
    }
  };

  const leaveToHome = (): void => {
    releaseSession(online !== null);
    setTutorial(null);
    resetGameUi();
    setGame(null);
    setScreen('home');
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      // URL rewriting is optional in restricted embedded browsers.
    }
  };

  const updateSeat = (index: number, update: Partial<LocalConfig['seats'][number]>): void => {
    setLocalConfig((config) => ({
      ...config,
      seats: config.seats.map((seat, seatIndex) =>
        seatIndex === index ? { ...seat, ...update } : seat,
      ),
    }));
  };

  const selectPlayerCount = (count: number): void => {
    setLocalConfig((config) => ({ ...config, seats: initialSeats(count, config.seats) }));
  };

  const dispatchLocal = (action: GameAction): boolean => {
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
    if (result.kind === 'applied' && result.result.ok) motionRef.current.push(...pending);
    return true;
  };

  const dispatchOnline = (action: GameAction): void => {
    onlineSessionRef.current?.dispatch(action);
  };

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
    const code = roomCodeFromLocation();
    if (!code) return;
    openedRoomFromLocationRef.current = true;
    openOnlineRoom(code, false);
  }, []);

  useEffect(() => {
    if (online?.undoVote) setLogOpen(true);
  }, [online?.undoVote]);

  useEffect(() => {
    if (motionRef.current.length === 0) return;
    const pending = motionRef.current;
    motionRef.current = [];
    playPendingFlights(pending);
  }, [game]);

  return {
    screen,
    setScreen,
    localConfig,
    setLocalConfig,
    onlineConfig,
    setOnlineConfig,
    game,
    setGame,
    online,
    selection,
    setSelection,
    phase,
    setPhase,
    busy,
    setBusy,
    rulesOpen,
    setRulesOpen,
    logOpen,
    setLogOpen,
    inspectCardId,
    setInspectCardId,
    winOpen,
    setWinOpen,
    passSeat,
    setPassSeat,
    toast,
    now,
    tutorial,
    leaveConfirmOpen,
    setLeaveConfirmOpen,
    creatingRoom,
    localSessionRef,
    onlineSessionRef,
    undoStackRef,
    aiPendingRef,
    dispatchLocal,
    dispatchOnline,
    resetGameUi,
    startTutorial,
    advanceTutorial,
    startLocalGame,
    openOnlineRoom,
    createOnlineRoom,
    leaveToHome,
    updateSeat,
    selectPlayerCount,
    showToast,
  };
}
