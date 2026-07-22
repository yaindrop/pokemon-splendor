import {
  cards as CARD_DB,
  megas as MEGA_DB,
  pokemart as POKEMART_DB,
} from '@pokemon-splendor/game-data';
import type { GameSelectOption } from '../components/primitives.js';
import type { GameSelection } from './model.js';
import type { TutorialMode, TutorialSnapshot } from './tutorial.js';

export type Screen = 'home' | 'local-config' | 'online-config' | 'lobby' | 'game';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'ultra';
export type SeatKind = 'human' | 'ai';
export type TimeoutChoice = '60000' | '180000' | '300000' | '600000';

export interface LocalSeatConfig {
  readonly name: string;
  readonly ai: boolean;
  readonly difficulty: Difficulty;
}

export interface LocalConfig {
  readonly seats: readonly LocalSeatConfig[];
  readonly megas: boolean;
  readonly pokemart: boolean;
}

export interface OnlineConfig {
  readonly name: string;
  readonly roomCode: string;
  readonly timeoutEnabled: boolean;
  readonly timeoutMs: number;
}

export interface ChoiceRequest {
  readonly title: string;
  readonly hint: string | undefined;
  readonly candidates: readonly string[];
  readonly count: number;
  readonly selected: readonly string[];
}

export interface InspectCard {
  readonly id: string;
}

export interface TutorialRun {
  readonly mode: TutorialMode;
  readonly stepIndex: number;
  readonly baseline: TutorialSnapshot;
  readonly completed: boolean;
}

export const CARD_CATALOG = {
  cardDB: CARD_DB,
  byId: Object.fromEntries([...CARD_DB, ...MEGA_DB, ...POKEMART_DB].map((card) => [card.id, card])),
  megaDB: MEGA_DB,
  pokemartDB: POKEMART_DB,
};

export const SEAT_KIND_OPTIONS: readonly GameSelectOption<SeatKind>[] = [
  { value: 'human', label: '真人' },
  { value: 'ai', label: '电脑' },
];

export const DIFFICULTY_OPTIONS: readonly GameSelectOption<Difficulty>[] = [
  { value: 'hard', label: '高手' },
  { value: 'ultra', label: '究极（最强·搜索）' },
  { value: 'normal', label: '普通' },
  { value: 'easy', label: '新手' },
];

export const TIMEOUT_OPTIONS: readonly GameSelectOption<TimeoutChoice>[] = [
  { value: '60000', label: '1 分钟' },
  { value: '180000', label: '3 分钟' },
  { value: '300000', label: '5 分钟' },
  { value: '600000', label: '10 分钟' },
];

export const EMPTY_SELECTION: GameSelection = {
  pickedBalls: [],
  selectedCardId: null,
  selectedDeck: null,
};

export function initialSeats(
  count: number,
  existing: readonly LocalSeatConfig[] = [],
): readonly LocalSeatConfig[] {
  return Array.from({ length: count }, (_, index) => {
    const prior = existing[index];
    if (prior) return prior;
    return { name: `训练家 ${index + 1}`, ai: index > 0, difficulty: 'hard' };
  });
}

export function createInitialLocalConfig(): LocalConfig {
  return { seats: initialSeats(2), megas: false, pokemart: false };
}

export function createInitialOnlineConfig(): OnlineConfig {
  return { name: '训练家 1', roomCode: '', timeoutEnabled: false, timeoutMs: 180_000 };
}

export function sanitizedRoomCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

export function roomCodeFromLocation(): string | null {
  try {
    return sanitizedRoomCode(new URLSearchParams(location.search).get('room') ?? '') || null;
  } catch {
    return null;
  }
}

export function timeoutChoice(timeoutMs: number): TimeoutChoice {
  if (timeoutMs === 60_000) return '60000';
  if (timeoutMs === 300_000) return '300000';
  if (timeoutMs === 600_000) return '600000';
  return '180000';
}

export function timeoutMsFromChoice(value: TimeoutChoice): number {
  if (value === '60000') return 60_000;
  if (value === '300000') return 300_000;
  if (value === '600000') return 600_000;
  return 180_000;
}

export function isNarrowViewport(): boolean {
  return window.matchMedia('(max-width: 1280px)').matches;
}
