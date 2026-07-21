import assert from 'node:assert/strict';
import type { ConnectionStatus, NetApi, NetEventMap } from '../src/net.js';
import { afterEach, test, vi } from 'vitest';

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): SessionStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

class FakeWebSocket {
  static readonly OPEN = 1;

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveRaw(message: string): void {
    this.onmessage?.({ data: message });
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }
}

interface LoadedTab {
  readonly Net: NetApi;
  readonly sockets: FakeWebSocket[];
}

function browser(session: SessionStore): FakeWebSocket[] {
  const sockets: FakeWebSocket[] = [];
  class BrowserWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  vi.stubGlobal('location', { protocol: 'http:', host: 'game.example' });
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('WebSocket', BrowserWebSocket);
  vi.stubGlobal('window', { setInterval: () => 1, setTimeout: () => 1 });
  vi.stubGlobal('clearInterval', () => undefined);
  vi.stubGlobal('clearTimeout', () => undefined);
  return sockets;
}

async function loadTab(session: SessionStore): Promise<LoadedTab> {
  vi.resetModules();
  const sockets = browser(session);
  const { Net } = await import('../src/net.js');
  return { Net, sockets };
}

function socketAt(tab: LoadedTab, index = 0): FakeWebSocket {
  const socket = tab.sockets[index];
  if (!socket) throw new Error(`缺少测试 WebSocket：${index}`);
  return socket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sentMessage(socket: FakeWebSocket, index: number): Record<string, unknown> {
  const raw = socket.sent[index];
  if (raw === undefined) throw new Error(`缺少已发送消息：${index}`);
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error('已发送消息不是对象');
  }
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('separate tabs get separate identities while refresh preserves a seat', async () => {
  const firstSession = storage();
  const firstTab = await loadTab(firstSession);
  firstTab.Net.connect('ROOM2345', 'Alice');
  socketAt(firstTab).open();
  assert.equal(sentMessage(socketAt(firstTab), 0)['token'], undefined);
  socketAt(firstTab).receive({
    t: 'welcome',
    connId: 'connection-1',
    token: 'a'.repeat(64),
    seat: 0,
    host: true,
  });

  const secondTab = await loadTab(storage());
  secondTab.Net.connect('ROOM2345', 'Bob');
  socketAt(secondTab).open();
  assert.equal(sentMessage(socketAt(secondTab), 0)['token'], undefined);

  const refreshedFirstTab = await loadTab(firstSession);
  refreshedFirstTab.Net.connect('ROOM2345', 'Alice');
  socketAt(refreshedFirstTab).open();
  assert.equal(sentMessage(socketAt(refreshedFirstTab), 0)['token'], 'a'.repeat(64));
});

test('typed handlers receive valid events and ignore malformed server input', async () => {
  const tab = await loadTab(storage());
  const statuses: ConnectionStatus[] = [];
  const rejects: NetEventMap['reject'][] = [];
  const undoResults: NetEventMap['undo-result'][] = [];
  tab.Net.on('status', (status) => statuses.push(status));
  tab.Net.on('reject', (message) => rejects.push(message));
  tab.Net.on('undo-result', (message) => undoResults.push(message));

  tab.Net.connect('ROOM2345', 'Alice');
  const socket = socketAt(tab);
  socket.open();
  socket.receiveRaw('{broken');
  socket.receive({ t: 'reject', reason: 4 });
  socket.receive({ t: 'pong' });
  socket.receive({ t: 'reject', reason: '尚未轮到你', seq: 2 });
  socket.receive({ t: 'undo-result', accepted: true, reason: '全员同意' });

  assert.deepEqual(statuses, ['connecting', 'connected']);
  assert.deepEqual(rejects, [{ t: 'reject', reason: '尚未轮到你', seq: 2 }]);
  assert.deepEqual(undoResults, [{ t: 'undo-result', accepted: true, reason: '全员同意' }]);
});

test('commands are sequenced and serialized only while connected', async () => {
  const tab = await loadTab(storage());
  tab.Net.connect('ROOM2345', 'Alice');
  const socket = socketAt(tab);
  tab.Net.sync();
  assert.equal(socket.sent.length, 0);

  socket.open();
  tab.Net.action({ type: 'pass' });
  tab.Net.start({ megas: true, turnTimeoutMs: null });
  tab.Net.sync();
  tab.Net.requestUndo();
  tab.Net.voteUndo(false);
  assert.equal(tab.Net.isOpen(), true);
  assert.deepEqual(
    socket.sent.slice(1).map((_, index) => sentMessage(socket, index + 1)),
    [
      { t: 'action', seq: 1, action: { type: 'pass' } },
      { t: 'start', opts: { megas: true, turnTimeoutMs: null } },
      { t: 'sync' },
      { t: 'undo-request' },
      { t: 'undo-vote', approve: false },
    ],
  );
  tab.Net.close();
  assert.equal(tab.Net.isOpen(), false);
});

test('room creation validates HTTP status and response shape', async () => {
  const tab = await loadTab(storage());
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{"code":"ROOM2345"}', { status: 201 }))),
  );
  assert.equal(await tab.Net.createRoom(), 'ROOM2345');

  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}', { status: 201 }))),
  );
  await assert.rejects(tab.Net.createRoom(), /房间响应无效/);

  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}', { status: 503 }))),
  );
  await assert.rejects(tab.Net.createRoom(), /无法创建房间/);
});
