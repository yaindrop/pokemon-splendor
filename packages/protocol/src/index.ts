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
  return isRecord(value) && TOKEN_COLORS.every((color) => isNonNegativeInteger(value[color]));
}

function isSupply(value: unknown): boolean {
  return (
    isTokenCounts(value) &&
    isRecord(value) &&
    (value['megaToken'] == null || isNonNegativeInteger(value['megaToken']))
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
    (value['diff'] == null ||
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
    FIELD_TIERS.every((tier) => validDeck(value[tier])) &&
    POKEMART_TIERS.every((tier) => value[tier] == null || validDeck(value[tier]))
  );
}

function isField(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const validCards = (cards: unknown): boolean =>
    Array.isArray(cards) && cards.every(isCardIdOrNull);
  return (
    FIELD_TIERS.every((tier) => validCards(value[tier])) &&
    POKEMART_TIERS.every((tier) => value[tier] == null || validCards(value[tier]))
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
        typeof message['connId'] === 'string' &&
        isInteger(message['seat']) &&
        typeof message['host'] === 'boolean' &&
        (message['token'] === null || typeof message['token'] === 'string')
      );
    case 'roster':
      return (
        isRosterPlayers(message['players']) &&
        isNonNegativeInteger(message['hostSeat']) &&
        typeof message['started'] === 'boolean'
      );
    case 'state':
      return (
        isNonNegativeInteger(message['seq']) &&
        isRedactedGameState(message['state']) &&
        isNonNegativeInteger(message['turnStartedAt']) &&
        isNonNegativeInteger(message['serverNow']) &&
        (message['turnTimeoutMs'] === null || isNonNegativeInteger(message['turnTimeoutMs'])) &&
        typeof message['undoAvailable'] === 'boolean'
      );
    case 'reject':
      return (
        typeof message['reason'] === 'string' &&
        (message['seq'] == null || isNonNegativeInteger(message['seq']))
      );
    case 'over':
      return isNullableInteger(message['winner']);
    case 'undo-vote':
      return (
        isNonNegativeInteger(message['requesterSeat']) &&
        isIntegerArray(message['approvals']) &&
        isNonNegativeInteger(message['total'])
      );
    case 'undo-result':
      return typeof message['accepted'] === 'boolean' && typeof message['reason'] === 'string';
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
        (message['name'] == null || typeof message['name'] === 'string') &&
        (message['token'] == null ||
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
      if (message['opts'] == null) return true;
      if (!isRecord(message['opts'])) return false;
      const options = message['opts'];
      return (
        hasOnlyKeys(options, ['megas', 'pokemart', 'turnTimeoutMs']) &&
        ['megas', 'pokemart'].every(
          (key) => options[key] == null || typeof options[key] === 'boolean',
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
        isNonNegativeInteger(entry['turn']) &&
        isNonNegativeInteger(entry['round']) &&
        typeof entry['msg'] === 'string' &&
        (entry['kind'] == null || typeof entry['kind'] === 'string') &&
        (entry['cardId'] == null || typeof entry['cardId'] === 'string') &&
        (entry['colors'] == null ||
          (Array.isArray(entry['colors']) &&
            entry['colors'].every((color) =>
              TOKEN_COLORS.some((candidate) => candidate === color),
            ))) &&
        (entry['pay'] == null || isTokenCounts(entry['pay']))
      );
    })
  );
}
