import {
  Engine,
  Room,
  FIELD_TIERS,
  POKEMART_TIERS,
  TOKEN_COLORS,
  type Color,
  type GameState,
  type RedactedGameState,
  type RoomClientMessage,
  type RoomServerMessage,
  type RoomSnapshot,
  type Tier,
} from '@pokemon-splendor/game-core';

export type { RoomClientMessage, RoomServerMessage };
export type GameStateSnapshot = Omit<GameState, 'cardDB' | 'byId' | 'megaDB' | 'pokemartDB'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const TOKEN_COUNT_KEYS = TOKEN_COLORS;
const SUPPLY_KEYS = [...TOKEN_COLORS, 'megaToken'];
const PLAYER_KEYS = [
  'id',
  'name',
  'isAI',
  'tokens',
  'megaToken',
  'board',
  'buried',
  'reserve',
  'assoc',
  'diff',
];
const GAME_STATE_KEYS = [
  'seed',
  'winScore',
  'numPlayers',
  'supply',
  'decks',
  'field',
  'players',
  'megasEnabled',
  'megaOffer',
  'pokemartEnabled',
  'turn',
  'round',
  'phase',
  'lastRound',
  'finalTurnOf',
  'winner',
  'log',
  'acted',
  'taken',
  'evolvedThisTurn',
];

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTier(value: unknown): value is Tier {
  return (
    value === 'mega' ||
    FIELD_TIERS.some((tier) => tier === value) ||
    POKEMART_TIERS.some((tier) => tier === value)
  );
}

function isColor(value: unknown): value is Color {
  return Engine.COLORS.some((color) => color === value);
}

function isTokenCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, TOKEN_COUNT_KEYS) &&
    TOKEN_COLORS.every((color) => isNonNegativeInteger(value[color]))
  );
}

function isSupply(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, SUPPLY_KEYS) &&
    TOKEN_COLORS.every((color) => isNonNegativeInteger(value[color])) &&
    (value['megaToken'] === undefined || isNonNegativeInteger(value['megaToken']))
  );
}

function isAssoc(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((color) => isColor(color));
}

function isHiddenReserve(value: unknown): boolean {
  return (
    isRecord(value) &&
    value['hidden'] === true &&
    isTier(value['tier']) &&
    hasOnlyKeys(value, ['hidden', 'tier'])
  );
}

function isPlayer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, PLAYER_KEYS) &&
    isNonNegativeInteger(value['id']) &&
    typeof value['name'] === 'string' &&
    typeof value['isAI'] === 'boolean' &&
    isTokenCounts(value['tokens']) &&
    isNonNegativeInteger(value['megaToken']) &&
    isStringArray(value['board']) &&
    isStringArray(value['buried']) &&
    Array.isArray(value['reserve']) &&
    value['reserve'].every((item) => typeof item === 'string' || isHiddenReserve(item)) &&
    isAssoc(value['assoc']) &&
    (value['diff'] === undefined ||
      value['diff'] === 'easy' ||
      value['diff'] === 'normal' ||
      value['diff'] === 'hard' ||
      value['diff'] === 'ultra' ||
      value['diff'] === 'alphazero')
  );
}

function isCardIdOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isDecks(value: unknown, redacted: boolean): boolean {
  if (!isRecord(value)) return false;
  const validDeck = (deck: unknown): boolean =>
    Array.isArray(deck) && deck.every((item) => (redacted ? item === null : isCardIdOrNull(item)));
  return (
    hasOnlyKeys(value, [...FIELD_TIERS, ...POKEMART_TIERS]) &&
    FIELD_TIERS.every((tier) => validDeck(value[tier])) &&
    POKEMART_TIERS.every((tier) => value[tier] === undefined || validDeck(value[tier]))
  );
}

function isField(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const validCards = (cards: unknown): boolean =>
    Array.isArray(cards) && cards.every(isCardIdOrNull);
  return (
    hasOnlyKeys(value, [...FIELD_TIERS, ...POKEMART_TIERS]) &&
    FIELD_TIERS.every((tier) => validCards(value[tier])) &&
    POKEMART_TIERS.every((tier) => value[tier] === undefined || validCards(value[tier]))
  );
}

function isGameStateShape(
  value: unknown,
  playerGuard: (player: unknown) => boolean,
  redacted: boolean,
): boolean {
  if (!isRecord(value)) return false;
  const playerCount = value['numPlayers'];
  const players = value['players'];
  return (
    hasOnlyKeys(value, redacted ? [...GAME_STATE_KEYS, 'viewerId'] : GAME_STATE_KEYS) &&
    isInteger(value['seed']) &&
    isNonNegativeInteger(value['winScore']) &&
    isInteger(playerCount) &&
    playerCount >= 2 &&
    playerCount <= 4 &&
    isSupply(value['supply']) &&
    isDecks(value['decks'], redacted) &&
    isField(value['field']) &&
    Array.isArray(players) &&
    players.length === playerCount &&
    players.every(playerGuard) &&
    typeof value['megasEnabled'] === 'boolean' &&
    isStringArray(value['megaOffer']) &&
    typeof value['pokemartEnabled'] === 'boolean' &&
    isNonNegativeInteger(value['turn']) &&
    value['turn'] < playerCount &&
    isNonNegativeInteger(value['round']) &&
    (value['phase'] === 'play' ||
      value['phase'] === 'discard' ||
      value['phase'] === 'evolve' ||
      value['phase'] === 'gameover') &&
    typeof value['lastRound'] === 'boolean' &&
    isNullableInteger(value['finalTurnOf']) &&
    isNullableInteger(value['winner']) &&
    isLog(value['log']) &&
    typeof value['acted'] === 'boolean' &&
    Array.isArray(value['taken']) &&
    value['taken'].every((color) => TOKEN_COLORS.some((candidate) => candidate === color)) &&
    typeof value['evolvedThisTurn'] === 'boolean'
  );
}

function isRedactedGameState(value: unknown): value is RedactedGameState {
  return isGameStateShape(value, isPlayer, true) && isRecord(value) && isInteger(value['viewerId']);
}

function isSnapshotPlayer(value: unknown): boolean {
  return isPlayer(value) && isRecord(value) && isStringArray(value['reserve']);
}

export function isGameStateSnapshot(value: unknown): value is GameStateSnapshot {
  return isGameStateShape(value, isSnapshotPlayer, false);
}

function isSnapshotSeat(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const token = value['token'];
  return (
    hasOnlyKeys(value, ['token', 'name', 'connId', 'connected']) &&
    (token === null || (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token))) &&
    typeof value['name'] === 'string' &&
    value['connId'] === null &&
    value['connected'] === false
  );
}

export function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  if (!isRecord(value)) return false;
  const game = value['g'];
  const history = value['undoHistory'];
  const seats = value['seats'];
  return (
    hasOnlyKeys(value, [
      'seq',
      'started',
      'seats',
      'turnStartedAt',
      'turnTimeoutMs',
      'g',
      'undoHistory',
    ]) &&
    isNonNegativeInteger(value['seq']) &&
    typeof value['started'] === 'boolean' &&
    Array.isArray(seats) &&
    seats.length <= 4 &&
    seats.every(isSnapshotSeat) &&
    isNonNegativeInteger(value['turnStartedAt']) &&
    (value['turnTimeoutMs'] == null || Room.isTurnTimeoutMs(value['turnTimeoutMs'])) &&
    (game === null || isGameStateSnapshot(game)) &&
    Array.isArray(history) &&
    history.length <= 20 &&
    history.every(isGameStateSnapshot) &&
    (!value['started'] ||
      (isGameStateSnapshot(game) && game.numPlayers === seats.length && seats.length >= 2))
  );
}

function isRosterPlayers(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (player) =>
        isRecord(player) &&
        hasOnlyKeys(player, ['seat', 'name', 'connected']) &&
        isNonNegativeInteger(player['seat']) &&
        typeof player['name'] === 'string' &&
        typeof player['connected'] === 'boolean',
    )
  );
}

function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNonNegativeInteger);
}

export function isServerMessage(message: unknown): message is RoomServerMessage {
  if (!isRecord(message) || typeof message['t'] !== 'string') return false;
  switch (message['t']) {
    case 'pong':
      return hasOnlyKeys(message, ['t']);
    case 'welcome':
      return (
        hasOnlyKeys(message, ['t', 'connId', 'seat', 'host', 'token']) &&
        typeof message['connId'] === 'string' &&
        isInteger(message['seat']) &&
        typeof message['host'] === 'boolean' &&
        (message['token'] === null || typeof message['token'] === 'string')
      );
    case 'roster':
      return (
        hasOnlyKeys(message, ['t', 'players', 'hostSeat', 'started']) &&
        isRosterPlayers(message['players']) &&
        isNonNegativeInteger(message['hostSeat']) &&
        typeof message['started'] === 'boolean'
      );
    case 'state':
      return (
        hasOnlyKeys(message, [
          't',
          'seq',
          'state',
          'turnStartedAt',
          'serverNow',
          'turnTimeoutMs',
          'undoAvailable',
        ]) &&
        isNonNegativeInteger(message['seq']) &&
        isRedactedGameState(message['state']) &&
        isNonNegativeInteger(message['turnStartedAt']) &&
        isNonNegativeInteger(message['serverNow']) &&
        (message['turnTimeoutMs'] === null || Room.isTurnTimeoutMs(message['turnTimeoutMs'])) &&
        typeof message['undoAvailable'] === 'boolean'
      );
    case 'reject':
      return (
        hasOnlyKeys(message, ['t', 'reason', 'seq']) &&
        typeof message['reason'] === 'string' &&
        (message['seq'] === undefined || isNonNegativeInteger(message['seq']))
      );
    case 'over':
      return hasOnlyKeys(message, ['t', 'winner']) && isNullableInteger(message['winner']);
    case 'undo-vote':
      return (
        hasOnlyKeys(message, ['t', 'requesterSeat', 'approvals', 'total']) &&
        isNonNegativeInteger(message['requesterSeat']) &&
        isIntegerArray(message['approvals']) &&
        isNonNegativeInteger(message['total'])
      );
    case 'undo-result':
      return (
        hasOnlyKeys(message, ['t', 'accepted', 'reason']) &&
        typeof message['accepted'] === 'boolean' &&
        typeof message['reason'] === 'string'
      );
    default:
      return false;
  }
}

export function isClientMessage(message: unknown): message is RoomClientMessage {
  if (!isRecord(message) || typeof message['t'] !== 'string') return false;
  switch (message['t']) {
    case 'ping':
    case 'sync':
    case 'leave':
    case 'undo-request':
      return hasOnlyKeys(message, ['t']);
    case 'join':
      return (
        hasOnlyKeys(message, ['t', 'name', 'token']) &&
        (message['name'] === undefined || typeof message['name'] === 'string') &&
        (message['token'] === undefined ||
          (typeof message['token'] === 'string' && /^[a-f0-9]{64}$/.test(message['token'])))
      );
    case 'action':
      return (
        hasOnlyKeys(message, ['t', 'seq', 'action']) &&
        Number.isSafeInteger(message['seq']) &&
        Number(message['seq']) > 0 &&
        Engine.validActionShape(message['action'])
      );
    case 'undo-vote':
      return hasOnlyKeys(message, ['t', 'approve']) && typeof message['approve'] === 'boolean';
    case 'start': {
      if (!hasOnlyKeys(message, ['t', 'opts'])) return false;
      if (message['opts'] === undefined) return true;
      if (!isRecord(message['opts'])) return false;
      const options = message['opts'];
      return (
        hasOnlyKeys(options, ['megas', 'pokemart', 'turnTimeoutMs']) &&
        ['megas', 'pokemart'].every(
          (key) => options[key] === undefined || typeof options[key] === 'boolean',
        ) &&
        (options['turnTimeoutMs'] == null || Room.isTurnTimeoutMs(options['turnTimeoutMs']))
      );
    }
    default:
      return false;
  }
}

function isLog(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!isRecord(entry)) return false;
      return (
        hasOnlyKeys(entry, ['turn', 'round', 'msg', 'kind', 'cardId', 'colors', 'pay']) &&
        isNonNegativeInteger(entry['turn']) &&
        isNonNegativeInteger(entry['round']) &&
        typeof entry['msg'] === 'string' &&
        (entry['kind'] === undefined || typeof entry['kind'] === 'string') &&
        (entry['cardId'] === undefined || typeof entry['cardId'] === 'string') &&
        (entry['colors'] === undefined ||
          (Array.isArray(entry['colors']) &&
            entry['colors'].every((color) =>
              TOKEN_COLORS.some((candidate) => candidate === color),
            ))) &&
        (entry['pay'] === undefined || isTokenCounts(entry['pay']))
      );
    })
  );
}
