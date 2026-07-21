import type {
  Card,
  CardEffect,
  CardEffectParam,
  Color,
  Tier,
  TokenCounts,
} from '@pokemon-splendor/game-core';
import cardsJson from './data/cards.json' with { type: 'json' };
import megasJson from './data/megas.json' with { type: 'json' };
import pokemartJson from './data/pokemart.json' with { type: 'json' };

const COLORS = new Set<string>(['red', 'blue', 'black', 'pink', 'yellow']);
const TOKENS = new Set<string>([...COLORS, 'purple']);
const TIERS = new Set<string>([
  'stage1',
  'stage2',
  'stage3',
  'rare',
  'legend',
  'pmL1',
  'pmL2',
  'pmL3',
  'mega',
]);
const EFFECTS = new Set<string>([
  'double',
  'copy',
  'colorless_master',
  'discard_buy',
  'free',
  'copy_free',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColor(value: unknown): value is Color {
  return typeof value === 'string' && COLORS.has(value);
}

function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && TIERS.has(value);
}

function isEffect(value: unknown): value is CardEffect {
  return typeof value === 'string' && EFFECTS.has(value);
}

function isTokenCounts(value: unknown): value is TokenCounts {
  if (!isRecord(value)) return false;
  return [...TOKENS].every(
    (token) => Number.isSafeInteger(value[token]) && Number(value[token]) >= 0,
  );
}

function isEffectParam(value: unknown): value is CardEffectParam | null | undefined {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  return (
    (value['discardColor'] == null || isColor(value['discardColor'])) &&
    (value['discardCount'] == null || Number.isSafeInteger(value['discardCount'])) &&
    (value['freeFromTier'] == null || typeof value['freeFromTier'] === 'string')
  );
}

function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  const evoCost = value['evoCost'];
  const validEvolutionCost =
    evoCost == null ||
    (isRecord(evoCost) && isColor(evoCost['color']) && Number.isSafeInteger(evoCost['count']));
  return (
    typeof value['id'] === 'string' &&
    isTier(value['tier']) &&
    typeof value['name'] === 'string' &&
    Number.isSafeInteger(value['vp']) &&
    (value['bonus'] === 'none' || isColor(value['bonus'])) &&
    Number.isSafeInteger(value['bonusCount']) &&
    isTokenCounts(value['cost']) &&
    (value['evolvesTo'] == null || typeof value['evolvesTo'] === 'string') &&
    validEvolutionCost &&
    typeof value['img'] === 'string' &&
    (value['effect'] == null || isEffect(value['effect'])) &&
    isEffectParam(value['effectParam']) &&
    (value['megaFrom'] == null || typeof value['megaFrom'] === 'string')
  );
}

function parseCards(value: unknown, source: string): readonly Card[] {
  if (!Array.isArray(value) || !value.every(isCard)) {
    throw new TypeError(`Invalid card data: ${source}`);
  }
  const ids = new Set(value.map((card) => card.id));
  if (ids.size !== value.length) throw new TypeError(`Duplicate card id: ${source}`);
  return Object.freeze(value);
}

export const cards = parseCards(cardsJson, 'cards.json');
export const megas = parseCards(megasJson, 'megas.json');
export const pokemart = parseCards(pokemartJson, 'pokemart.json');
