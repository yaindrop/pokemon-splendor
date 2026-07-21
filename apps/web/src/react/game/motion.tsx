import { atom, useAtom } from 'jotai';
import {
  Engine as E,
  type GameState,
  type Tier,
  type TokenColor,
} from '@pokemon-splendor/game-core';
import { useCallback, useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import { uiStore } from '../uiStore.js';
import { hiddenReserveTier } from './model.js';

type MotionToken = TokenColor | 'mega';
type FieldTier = keyof GameState['field'];

interface FlightPoint {
  readonly x: number;
  readonly y: number;
}

interface PendingBallFlight {
  readonly kind: 'ball';
  readonly token: MotionToken;
  readonly from: FlightPoint;
  readonly targetSelector: string;
  readonly playerSeat: number;
  readonly toPlayer: boolean;
  readonly delay: number;
}

interface PendingCardFlight {
  readonly kind: 'card';
  readonly from: FlightPoint;
  readonly targetSelector: string;
  readonly playerSeat: number;
  readonly image: string | null;
  readonly tier: Tier | null;
  readonly delay: number;
}

export type PendingFlight = PendingBallFlight | PendingCardFlight;

interface Flight extends Omit<PendingBallFlight, 'targetSelector'> {
  readonly id: number;
  readonly to: FlightPoint;
}

interface CardFlight extends Omit<PendingCardFlight, 'targetSelector'> {
  readonly id: number;
  readonly to: FlightPoint;
}

type ActiveFlight = Flight | CardFlight;

const flightsAtom = atom<readonly ActiveFlight[]>([]);
let nextFlightId = 0;

function centerOf(selector: string): FlightPoint | null {
  if (typeof document === 'undefined') return null;
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function appendBallFlights(
  flights: PendingFlight[],
  before: number,
  after: number,
  token: MotionToken,
  playerSeat: number,
  delay: { value: number },
): void {
  const delta = after - before;
  if (delta === 0) return;
  const toPlayer = delta > 0;
  const sourceSelector = toPlayer
    ? `.supply-row[data-supply-color="${token}"] .ball`
    : `.player[data-player="${playerSeat}"] .trainer-token[data-token-color="${token}"] .ball`;
  const targetSelector = toPlayer
    ? `.player[data-player="${playerSeat}"] .trainer-token[data-token-color="${token}"] .ball`
    : `.supply-row[data-supply-color="${token}"] .ball`;
  const from = centerOf(sourceSelector);
  if (!from) return;
  for (let index = 0; index < Math.abs(delta); index += 1) {
    flights.push({
      kind: 'ball',
      token,
      from,
      targetSelector,
      playerSeat,
      toPlayer,
      delay: delay.value,
    });
    delay.value += 55;
  }
}

function afterBoardIds(game: GameState): ReadonlySet<string> {
  return new Set(game.players.flatMap((player) => player.board));
}

function isFieldTier(tier: Tier): tier is FieldTier {
  return E.FIELD_TIERS.some((candidate) => candidate === tier);
}

function appendCardFlights(
  flights: PendingFlight[],
  previous: GameState,
  next: GameState,
  playerSeat: number,
  delay: { value: number },
): void {
  const beforePlayer = previous.players[playerSeat];
  const afterPlayer = next.players[playerSeat];
  if (!beforePlayer || !afterPlayer) return;

  const beforeBoard = new Set(beforePlayer.board);
  for (const cardId of afterPlayer.board) {
    if (beforeBoard.has(cardId)) continue;
    const reserveSlot = beforePlayer.reserve.findIndex((id) => id === cardId);
    const sourceSelector =
      reserveSlot >= 0
        ? `.player[data-player="${playerSeat}"] [data-reserved-card="${cardId}"]`
        : `.card[data-card="${cardId}"]`;
    const from = centerOf(sourceSelector);
    const card = next.byId[cardId];
    if (!from || !card) continue;
    flights.push({
      kind: 'card',
      from,
      targetSelector: `.player[data-player="${playerSeat}"] [data-captured-card="${cardId}"]`,
      playerSeat,
      image: card.img,
      tier: card.tier,
      delay: delay.value,
    });
    delay.value += 65;
  }

  if (afterPlayer.reserve.length <= beforePlayer.reserve.length) return;
  const boardIds = afterBoardIds(next);
  for (let slot = beforePlayer.reserve.length; slot < afterPlayer.reserve.length; slot += 1) {
    const value = afterPlayer.reserve[slot];
    if (!value) continue;
    const hiddenTier = hiddenReserveTier(value);
    const card = hiddenTier ? null : (next.byId[value] ?? null);
    const tier = card?.tier ?? hiddenTier;
    if (!tier || !isFieldTier(tier)) continue;
    const afterField = new Set(
      (next.field[tier] ?? []).filter((cardId): cardId is string => cardId !== null),
    );
    const removed = (previous.field[tier] ?? []).find(
      (cardId) => cardId !== null && !afterField.has(cardId) && !boardIds.has(cardId),
    );
    const sourceSelector = removed
      ? `.card[data-card="${removed}"]`
      : `.deck-pile[data-tier="${tier}"]`;
    const from = centerOf(sourceSelector);
    if (!from) continue;
    flights.push({
      kind: 'card',
      from,
      targetSelector: card
        ? `.player[data-player="${playerSeat}"] [data-reserved-card="${value}"]`
        : `.player[data-player="${playerSeat}"] [data-reserved-slot="${slot}"]`,
      playerSeat,
      image: card?.img ?? null,
      tier,
      delay: delay.value,
    });
    delay.value += 65;
  }
}

export function captureStateTransition(
  previous: GameState,
  next: GameState,
): readonly PendingFlight[] {
  const flights: PendingFlight[] = [];
  const delay = { value: 0 };
  const playerCount = Math.min(previous.players.length, next.players.length);
  for (let playerSeat = 0; playerSeat < playerCount; playerSeat += 1) {
    const beforePlayer = previous.players[playerSeat];
    const afterPlayer = next.players[playerSeat];
    if (!beforePlayer || !afterPlayer) continue;
    for (const token of E.ALL_TOKENS) {
      appendBallFlights(
        flights,
        beforePlayer.tokens[token],
        afterPlayer.tokens[token],
        token,
        playerSeat,
        delay,
      );
    }
    appendBallFlights(
      flights,
      beforePlayer.megaToken,
      afterPlayer.megaToken,
      'mega',
      playerSeat,
      delay,
    );
    appendCardFlights(flights, previous, next, playerSeat, delay);
  }
  return flights;
}

export function playPendingFlights(pending: readonly PendingFlight[]): void {
  if (
    pending.length === 0 ||
    typeof window === 'undefined' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return;
  }
  const flights: ActiveFlight[] = [];
  const receivingSeats = new Set<number>();
  for (const flight of pending) {
    const to = centerOf(flight.targetSelector);
    if (!to) continue;
    if (flight.kind === 'ball') {
      flights.push({ ...flight, id: ++nextFlightId, to });
      if (flight.toPlayer) receivingSeats.add(flight.playerSeat);
    } else {
      flights.push({ ...flight, id: ++nextFlightId, to });
      receivingSeats.add(flight.playerSeat);
    }
  }
  if (flights.length === 0) return;
  uiStore.set(flightsAtom, [...uiStore.get(flightsAtom), ...flights]);
  for (const playerSeat of receivingSeats) {
    const player = document.querySelector<HTMLElement>(`.player[data-player="${playerSeat}"]`);
    if (!player) continue;
    player.classList.add('receiving');
    window.setTimeout(() => {
      player.classList.remove('receiving');
    }, 520);
  }
}

function FlightNode({
  flight,
  onComplete,
}: {
  readonly flight: ActiveFlight;
  readonly onComplete: (id: number) => void;
}): ReactElement {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    const from = `translate(${(flight.from.x - (flight.kind === 'ball' ? 20 : 30)).toString()}px, ${(flight.from.y - (flight.kind === 'ball' ? 20 : 40)).toString()}px)`;
    const to = `translate(${(flight.to.x - (flight.kind === 'ball' ? 20 : 30)).toString()}px, ${(flight.to.y - (flight.kind === 'ball' ? 20 : 40)).toString()}px) scale(.62)`;
    const animation = node.animate(
      [
        { transform: from, opacity: 1 },
        { transform: to, opacity: 0.12 },
      ],
      {
        duration: 620,
        delay: flight.delay,
        easing: 'cubic-bezier(0.34, 0.7, 0.3, 1)',
        fill: 'forwards',
      },
    );
    animation.onfinish = (): void => {
      onComplete(flight.id);
    };
    return () => {
      animation.cancel();
    };
  }, [flight, onComplete]);

  const style: CSSProperties = {
    transform: `translate(${(flight.from.x - (flight.kind === 'ball' ? 20 : 30)).toString()}px, ${(flight.from.y - (flight.kind === 'ball' ? 20 : 40)).toString()}px)`,
  };
  if (flight.kind === 'ball') {
    return (
      <div className="fly" ref={nodeRef} style={style}>
        <span className={`ball ${flight.token === 'mega' ? 'mega-token' : flight.token}`} />
      </div>
    );
  }
  return (
    <div
      className="fly fly-card"
      data-tier={flight.image ? undefined : (flight.tier ?? undefined)}
      ref={nodeRef}
      style={style}
    >
      {flight.image ? <img src={flight.image} alt="" /> : null}
    </div>
  );
}

export function FlightLayer(): ReactElement {
  const [flights, setFlights] = useAtom(flightsAtom);
  const complete = useCallback(
    (id: number): void => {
      setFlights((current) => current.filter((flight) => flight.id !== id));
    },
    [setFlights],
  );
  return (
    <div id="fly-layer" aria-hidden="true">
      {flights.map((flight) => (
        <FlightNode flight={flight} key={flight.id} onComplete={complete} />
      ))}
    </div>
  );
}
