import assert from 'node:assert/strict';
import { Engine, type RoomServerMessage } from '@pokemon-splendor/game-core';
import { cards } from '../../game-data/src/index.js';
import {
  isClientMessage,
  isGameStateSnapshot,
  isRoomSnapshot,
  isServerMessage,
} from '../src/index.js';
import { test } from 'vitest';

test('client protocol accepts every supported command and rejects malformed input', () => {
  const validMessages: readonly unknown[] = [
    { t: 'ping' },
    { t: 'sync' },
    { t: 'leave' },
    { t: 'undo-request' },
    { t: 'join', name: '小智' },
    { t: 'join', token: 'a'.repeat(64) },
    { t: 'action', seq: 1, action: { type: 'take', colors: ['red', 'blue', 'black'] } },
    { t: 'undo-vote', approve: true },
    { t: 'start' },
    { t: 'start', opts: { megas: true, pokemart: false, turnTimeoutMs: 60_000 } },
  ];
  for (const message of validMessages) assert.equal(isClientMessage(message), true);

  const invalidMessages: readonly unknown[] = [
    null,
    [],
    {},
    { t: 'unknown' },
    { t: 'ping', extra: true },
    { t: 'join', token: 'short' },
    { t: 'join', name: null },
    { t: 'join', name: 1 },
    { t: 'action', seq: 0, action: { type: 'pass' } },
    { t: 'action', seq: 1, action: { type: 'take', colors: ['purple'] } },
    { t: 'undo-vote', approve: 'yes' },
    { t: 'start', opts: [] },
    { t: 'start', opts: null },
    { t: 'start', opts: { megas: null } },
    { t: 'start', opts: { turnTimeoutMs: 1 } },
    { t: 'start', opts: { unknown: true } },
  ];
  for (const message of invalidMessages) assert.equal(isClientMessage(message), false);
});

test('server protocol validates state and control message variants', () => {
  const game = Engine.createGame(cards, { numPlayers: 2, seed: 42 });
  const state = Engine.redactFor(game, 0);
  const stateMessage: RoomServerMessage = {
    t: 'state',
    seq: 1,
    state,
    turnStartedAt: 100,
    serverNow: 110,
    turnTimeoutMs: null,
    undoAvailable: false,
  };
  const validMessages: readonly RoomServerMessage[] = [
    { t: 'pong' },
    { t: 'welcome', connId: 'connection-1', seat: 0, host: true, token: null },
    {
      t: 'roster',
      players: [{ seat: 0, name: '小智', connected: true }],
      hostSeat: 0,
      started: false,
    },
    stateMessage,
    { t: 'reject', reason: '非法操作', seq: 1 },
    { t: 'over', winner: null },
    { t: 'undo-vote', requesterSeat: 0, approvals: [0], total: 2 },
    { t: 'undo-result', accepted: false, reason: '被拒绝' },
  ];
  for (const message of validMessages) assert.equal(isServerMessage(message), true);
  for (const message of validMessages) {
    assert.equal(isServerMessage({ ...message, unexpected: true }), false);
  }

  const invalidMessages: readonly unknown[] = [
    null,
    { t: 'pong', extra: true },
    { t: 'welcome', connId: 1, seat: 0, host: true, token: null },
    { t: 'roster', players: [{ seat: -1, name: 'x', connected: true }], hostSeat: 0 },
    {
      t: 'roster',
      players: [{ seat: 0, name: 'x', connected: true, unexpected: true }],
      hostSeat: 0,
      started: false,
    },
    { t: 'state', seq: 1, state: { ...state, phase: 'invalid' } },
    { ...stateMessage, turnTimeoutMs: 1 },
    {
      ...stateMessage,
      state: { ...state, decks: { ...state.decks, stage1: ['s1_01'] } },
    },
    { t: 'reject', reason: 1 },
    { t: 'reject', reason: '非法操作', seq: null },
    { t: 'over', winner: 'zero' },
    { t: 'undo-vote', requesterSeat: 0, approvals: [-1], total: 2 },
    { t: 'undo-result', accepted: 'yes', reason: '' },
  ];
  for (const message of invalidMessages) assert.equal(isServerMessage(message), false);
});

test('persisted game snapshots require visible reserves and complete state fields', () => {
  const game = Engine.createGame(cards, { numPlayers: 2, seed: 7 });
  const {
    cardDB: _cardDB,
    byId: _byId,
    megaDB: _megaDB,
    pokemartDB: _pokemartDB,
    ...snapshot
  } = game;
  assert.equal(isGameStateSnapshot(snapshot), true);
  assert.equal(isGameStateSnapshot({ ...snapshot, players: [] }), false);
  assert.equal(isGameStateSnapshot({ ...snapshot, decks: {} }), false);
  assert.equal(isGameStateSnapshot({ ...snapshot, field: {} }), false);
  assert.equal(isGameStateSnapshot({ ...snapshot, supply: { red: -1 } }), false);
  assert.equal(isGameStateSnapshot({ ...snapshot, unexpected: true }), false);
  assert.equal(
    isGameStateSnapshot({ ...snapshot, players: [{ ...snapshot.players[0], unexpected: true }] }),
    false,
  );
  assert.equal(
    isGameStateSnapshot({ ...snapshot, supply: { ...snapshot.supply, unexpected: 1 } }),
    false,
  );
  const redacted = Engine.redactFor(game, 1);
  redacted.players[0]?.reserve.push({ hidden: true, tier: 'stage1' });
  assert.equal(isGameStateSnapshot(redacted), false);
});

test('room snapshots deeply validate seats, games, and undo history', () => {
  const room = {
    seq: 0,
    started: false,
    seats: [],
    turnStartedAt: 0,
    turnTimeoutMs: null,
    g: null,
    undoHistory: [],
  };
  assert.equal(isRoomSnapshot(room), true);
  assert.equal(isRoomSnapshot({ ...room, seats: [{ name: '小智' }] }), false);
  assert.equal(isRoomSnapshot({ ...room, undoHistory: [{}] }), false);
  assert.equal(isRoomSnapshot({ ...room, turnTimeoutMs: 1 }), false);
  assert.equal(isRoomSnapshot({ ...room, started: true }), false);
  assert.equal(isRoomSnapshot({ ...room, unexpected: true }), false);
});
