import type { EngineApi } from './api.js';
import type { CaptureOptions, GameAction, GameState, RedactedGameState } from './types.js';
import { cardById, isColor, isFieldTier, isRecord, isTokenColor } from './engine-support.js';
import { actionCapture, actionReserve, actionTake } from './engine-actions.js';
import {
  actionDiscard,
  actionEvolve,
  actionMegaEvolve,
  actionPass,
  actionTakeMega,
  endTurn,
} from './engine-turns.js';

function validActionShape(a: unknown): a is GameAction {
  if (!isRecord(a) || typeof a['type'] !== 'string') return false;
  const keysAre = (allowed: readonly string[]): boolean =>
    Object.keys(a).every((k) => allowed.includes(k));
  const shortId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 64;
  const stringList = (value: unknown, max: number): value is readonly string[] =>
    Array.isArray(value) && value.length <= max && value.every(shortId);
  function validCaptureOpts(opts: unknown, depth: number): opts is CaptureOptions {
    if (opts === undefined) return true;
    if (depth > 3 || !isRecord(opts)) return false;
    const allowed = ['copyTargetId', 'spendPokedex', 'discardCards', 'freeTakeId', 'freeOpts'];
    if (!Object.keys(opts).every((k) => allowed.indexOf(k) >= 0)) return false;
    if (opts['copyTargetId'] !== undefined && !shortId(opts['copyTargetId'])) return false;
    if (opts['freeTakeId'] !== undefined && !shortId(opts['freeTakeId'])) return false;
    if (opts['spendPokedex'] !== undefined && !stringList(opts['spendPokedex'], 10)) return false;
    if (opts['discardCards'] !== undefined && !stringList(opts['discardCards'], 10)) return false;
    return opts['freeOpts'] === undefined || validCaptureOpts(opts['freeOpts'], depth + 1);
  }
  switch (a['type']) {
    case 'take':
      return (
        keysAre(['type', 'colors']) &&
        Array.isArray(a['colors']) &&
        a['colors'].length >= 1 &&
        a['colors'].length <= 3 &&
        a['colors'].every(isColor)
      );
    case 'capture':
      return (
        keysAre(['type', 'cardId', 'opts']) &&
        shortId(a['cardId']) &&
        validCaptureOpts(a['opts'], 0)
      );
    case 'reserve': {
      const target = a['target'];
      if (!keysAre(['type', 'target']) || !isRecord(target)) return false;
      if (!Object.keys(target).every((k) => k === 'fromField' || k === 'fromDeck')) return false;
      const fromField = target['fromField'];
      const fromDeck = target['fromDeck'];
      return (
        (shortId(fromField) && fromDeck === undefined) ||
        (fromField === undefined && isFieldTier(fromDeck))
      );
    }
    case 'evolve':
      return keysAre(['type', 'fromId', 'toId']) && shortId(a['fromId']) && shortId(a['toId']);
    case 'megaEvolve':
      return keysAre(['type', 'megaId', 'fromId']) && shortId(a['megaId']) && shortId(a['fromId']);
    case 'discard':
      return keysAre(['type', 'color']) && isTokenColor(a['color']);
    case 'takeMega':
    case 'pass':
    case 'endTurn':
      return keysAre(['type']);
    default:
      return false;
  }
}

function applyAction(
  s: GameState,
  a: GameAction,
  playerId?: number,
): ReturnType<EngineApi['applyAction']> {
  if (!validActionShape(a)) return { ok: false, error: '行动格式无效' };
  if (playerId != null && playerId !== s.turn) return { ok: false, error: '未轮到你' };
  switch (a.type) {
    case 'take':
      return actionTake(s, a.colors);
    case 'capture':
      return actionCapture(s, a.cardId, a.opts);
    case 'reserve':
      return actionReserve(s, a.target);
    case 'takeMega':
      return actionTakeMega(s);
    case 'evolve':
      return actionEvolve(s, a.fromId, a.toId);
    case 'megaEvolve':
      return actionMegaEvolve(s, a.megaId, a.fromId);
    case 'discard':
      return actionDiscard(s, a.color);
    case 'pass':
      return actionPass(s);
    case 'endTurn':
      return endTurn(s);
    default:
      return { ok: false, error: '未知行动' };
  }
}

// Public projection of the state for ONE viewer, safe to send over a network.
// Hides what the viewer must not see — the ordered face-down deck (every future
// draw) and other players' reserved-card identities (possibly drawn blind) —
// while preserving counts/tiers so the UI still renders pile sizes & card-backs.
// Static card refs are omitted (every client already has the full card DB).
function redactFor(s: GameState, viewerId: number): ReturnType<EngineApi['redactFor']> {
  const {
    cardDB: _cardDB,
    byId: _byId,
    megaDB: _megaDB,
    pokemartDB: _pokemartDB,
    decks: _decks,
    players: _players,
    ...dynamic
  } = s;
  const decks: RedactedGameState['decks'] = {
    stage1: s.decks.stage1.map(() => null),
    stage2: s.decks.stage2.map(() => null),
    stage3: s.decks.stage3.map(() => null),
    rare: s.decks.rare.map(() => null),
    legend: s.decks.legend.map(() => null),
  };
  if (s.decks.pmL1) decks.pmL1 = s.decks.pmL1.map(() => null);
  if (s.decks.pmL2) decks.pmL2 = s.decks.pmL2.map(() => null);
  if (s.decks.pmL3) decks.pmL3 = s.decks.pmL3.map(() => null);
  const players: RedactedGameState['players'] = s.players.map((player, index) => ({
    ...structuredClone(player),
    reserve:
      index === viewerId
        ? [...player.reserve]
        : player.reserve.map((id) => ({ hidden: true, tier: cardById(s, id).tier })),
  }));
  return { ...structuredClone(dynamic), decks, players, viewerId };
}

export { applyAction, redactFor, validActionShape };
