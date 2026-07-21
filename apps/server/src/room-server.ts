import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TLSSocket } from 'node:tls';
import {
  AI,
  Room as RoomModule,
  type RoomAuthority,
  type RoomServerMessage,
} from '@pokemon-splendor/game-core';
import {
  cards as CARD_DB,
  megas as MEGA_DB,
  pokemart as POKEMART_DB,
} from '@pokemon-splendor/game-data';
import { isClientMessage, type RoomClientMessage } from '@pokemon-splendor/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { FileRoomStore, type RoomEnvelope, type RoomStore } from './file-room-store.js';
import { isRoomCode, randomRoomCode } from './room-code.js';

const ROOM_PATH = /^\/room\/([^/]+)\/ws$/;
const MAX_CONNECTIONS_PER_ROOM = 12;
const MAX_MESSAGE_BYTES = 8192;
const MUTATING_MESSAGES = new Set<RoomClientMessage['t']>([
  'join',
  'start',
  'action',
  'leave',
  'undo-request',
  'undo-vote',
]);

interface FixedWindowBucket {
  startedAt: number;
  count: number;
}

interface RoomSessionOptions {
  readonly lobbyDisconnectGraceMs?: number;
}

export interface RoomServerOptions extends RoomSessionOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dataDir?: string;
  readonly store?: RoomStore;
  readonly allowedOrigins?: readonly string[];
  readonly roomTtlMs?: number;
}

export interface RoomServer {
  listen(): Promise<void>;
  address(): AddressInfo;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(data);
}

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return '训练家';
  const name = Array.from(value.normalize('NFKC'))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127 && !`<>&"'\``.includes(character);
    })
    .join('')
    .trim();
  return Array.from(name).slice(0, 20).join('') || '训练家';
}

export function validMessage(message: unknown): message is RoomClientMessage {
  return isClientMessage(message);
}

function requestOriginAllowed(
  request: IncomingMessage,
  configuredOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (configuredOrigins.has(origin)) return true;
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim();
  const protocol = forwardedProto ?? (request.socket instanceof TLSSocket ? 'https' : 'http');
  const host = request.headers.host;
  return typeof host === 'string' && origin === `${protocol}://${host}`;
}

function clientIp(request: IncomingMessage): string {
  return (
    String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? '')
      .split(',')[0]
      ?.trim() ?? ''
  );
}

function consumeFixedWindow(
  buckets: Map<string, FixedWindowBucket>,
  key: string,
  now: number,
  windowMs: number,
  limit: number,
): boolean {
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket.count <= limit;
}

class RoomSession {
  readonly code: string;
  readonly store: RoomStore;
  readonly sockets = new Map<string, WebSocket>();
  readonly authority: RoomAuthority;
  readonly lobbyDisconnectGraceMs: number;
  readonly lobbyReleaseTimers = new Map<string, NodeJS.Timeout>();
  readonly createdAt: number;
  updatedAt: number;
  work: Promise<unknown> = Promise.resolve();
  turnTimer: NodeJS.Timeout | null = null;

  constructor(
    code: string,
    store: RoomStore,
    envelope: RoomEnvelope | null,
    options: RoomSessionOptions = {},
  ) {
    this.code = code;
    this.store = store;
    this.createdAt = envelope?.createdAt ?? Date.now();
    this.updatedAt = envelope?.updatedAt ?? this.createdAt;
    this.lobbyDisconnectGraceMs = options.lobbyDisconnectGraceMs ?? 15_000;
    this.authority = new RoomModule.Room({
      cardDB: CARD_DB,
      megaDB: MEGA_DB,
      pokemartDB: POKEMART_DB,
      send: (connectionId, message) => {
        this.send(connectionId, message);
      },
      disconnect: (connectionId) => {
        this.disconnect(connectionId);
      },
    });
    if (envelope) {
      this.authority.restore(envelope.room);
      if (!envelope.room.started) {
        for (const seat of envelope.room.seats) {
          if (seat.token) this.scheduleLobbyRelease(seat.token);
        }
      }
    }
  }

  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.work.then(task, task);
    this.work = next.catch(() => undefined);
    return next;
  }

  attach(connectionId: string, socket: WebSocket): void {
    this.sockets.set(connectionId, socket);
  }

  send(connectionId: string, message: RoomServerMessage): void {
    const socket = this.sockets.get(connectionId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  disconnect(connectionId: string): void {
    const socket = this.sockets.get(connectionId);
    this.sockets.delete(connectionId);
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(4001, 'seat resumed elsewhere');
    }
  }

  async handle(connectionId: string, incoming: RoomClientMessage): Promise<void> {
    let message = incoming;
    if (message.t === 'join') {
      const presentedToken = message.token;
      message = {
        t: 'join',
        name: normalizeName(message.name),
        token: this.authority.resolveJoinToken(message.token, randomToken),
      };
      if (presentedToken && message.token === presentedToken)
        this.cancelLobbyRelease(presentedToken);
    }
    this.authority.now = Date.now();
    this.authority.onMessage(connectionId, message);
    if (MUTATING_MESSAGES.has(message.t)) await this.persist();
    this.scheduleTimeout();
  }

  detached(connectionId: string): void {
    this.sockets.delete(connectionId);
    const reconnectToken = this.authority.leave(connectionId);
    if (reconnectToken) this.scheduleLobbyRelease(reconnectToken);
    this.scheduleTimeout();
  }

  cancelLobbyRelease(token: string): void {
    const timer = this.lobbyReleaseTimers.get(token);
    if (timer) clearTimeout(timer);
    this.lobbyReleaseTimers.delete(token);
  }

  scheduleLobbyRelease(token: string): void {
    this.cancelLobbyRelease(token);
    const timer = setTimeout(() => {
      this.lobbyReleaseTimers.delete(token);
      void this.enqueue(async () => {
        if (this.authority.releaseDisconnectedSeat(token)) await this.persist();
      });
    }, this.lobbyDisconnectGraceMs);
    timer.unref();
    this.lobbyReleaseTimers.set(token, timer);
  }

  scheduleTimeout(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    const timeoutAt = this.authority.nextTimeoutAt();
    if (timeoutAt == null) return;
    this.turnTimer = setTimeout(
      () => {
        this.turnTimer = null;
        void this.enqueue(async () => {
          if (
            this.authority.timeoutTurn(Date.now(), (state) =>
              AI.chooseTurn(state, { difficulty: 'hard' }),
            )
          ) {
            await this.persist();
          }
          this.scheduleTimeout();
        });
      },
      Math.max(0, timeoutAt - Date.now()),
    );
    this.turnTimer.unref();
  }

  dispose(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    for (const timer of this.lobbyReleaseTimers.values()) clearTimeout(timer);
    this.lobbyReleaseTimers.clear();
  }

  async persist(): Promise<void> {
    this.updatedAt = Date.now();
    await this.store.save(this.code, {
      version: 1,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      room: this.authority.snapshot(),
    });
  }
}

export function createRoomServer(options: RoomServerOptions = {}): RoomServer {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 3000;
  const store = options.store ?? new FileRoomStore(options.dataDir ?? './data/rooms');
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const sessions = new Map<string, RoomSession>();
  const roomCreates = new Map<string, FixedWindowBucket>();
  const activeConnections = new Map<string, number>();
  const connectionAttempts = new Map<string, FixedWindowBucket>();
  const ipMessageRates = new Map<string, FixedWindowBucket>();
  const roomTtlMs = options.roomTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const sessionOptions: RoomSessionOptions = {
    lobbyDisconnectGraceMs: options.lobbyDisconnectGraceMs ?? 15_000,
  };
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const upgradeSessions = new WeakMap<IncomingMessage, RoomSession>();
  const requestIps = new WeakMap<IncomingMessage, string>();

  async function sessionFor(code: string): Promise<RoomSession | null> {
    const active = sessions.get(code);
    if (active) return active;
    const envelope = await store.load(code);
    if (!envelope) return null;
    const session = new RoomSession(code, store, envelope, sessionOptions);
    sessions.set(code, session);
    return session;
  }

  async function createRoom(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomRoomCode();
      if (sessions.has(code) || (await store.load(code))) continue;
      const session = new RoomSession(code, store, null, sessionOptions);
      sessions.set(code, session);
      await session.persist();
      return code;
    }
    throw new Error('unable to allocate a room code');
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (!requestOriginAllowed(request, allowedOrigins)) {
        json(response, 403, { error: 'forbidden origin' });
        return;
      }
      const ip = clientIp(request);
      if (!consumeFixedWindow(roomCreates, ip, Date.now(), 60 * 60 * 1000, 20)) {
        json(response, 429, { error: '创建房间过于频繁' });
        return;
      }
      void createRoom()
        .then((code) => {
          json(response, 201, { code });
        })
        .catch(() => {
          json(response, 503, { error: '暂时无法创建房间' });
        });
      return;
    }
    json(response, 404, { error: 'not found' });
  });

  const cleanupTimer = setInterval(
    () => {
      void store
        .listExpired(Date.now() - roomTtlMs)
        .then(async (codes) => {
          for (const code of codes) {
            const session = sessions.get(code);
            if (session?.sockets.size) continue;
            session?.dispose();
            sessions.delete(code);
            await store.delete(code);
          }
        })
        .catch(() => undefined);
      const now = Date.now();
      for (const [ip, bucket] of roomCreates)
        if (now - bucket.startedAt >= 3_600_000) roomCreates.delete(ip);
      for (const [ip, bucket] of connectionAttempts)
        if (now - bucket.startedAt >= 60_000) connectionAttempts.delete(ip);
      for (const [ip, bucket] of ipMessageRates)
        if (now - bucket.startedAt >= 10_000) ipMessageRates.delete(ip);
    },
    Math.min(roomTtlMs, 60 * 60 * 1000),
  );
  cleanupTimer.unref();

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const match = ROOM_PATH.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
      const code = match?.[1];
      if (!isRoomCode(code) || !requestOriginAllowed(request, allowedOrigins)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const session = await sessionFor(code);
      if (!session) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      if (session.sockets.size >= MAX_CONNECTIONS_PER_ROOM) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      const ip = clientIp(request);
      if (!consumeFixedWindow(connectionAttempts, ip, Date.now(), 60_000, 60)) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        return;
      }
      if ((activeConnections.get(ip) ?? 0) >= 20) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        return;
      }
      upgradeSessions.set(request, session);
      requestIps.set(request, ip);
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
      });
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (socket, request) => {
    const session = upgradeSessions.get(request);
    if (!session) {
      socket.close(1011, 'missing room session');
      return;
    }
    upgradeSessions.delete(request);
    const connectionId = randomUUID();
    const rate: FixedWindowBucket = { startedAt: Date.now(), count: 0 };
    let lastActionSeq = 0;
    const ip = requestIps.get(request) ?? clientIp(request);
    requestIps.delete(request);
    activeConnections.set(ip, (activeConnections.get(ip) ?? 0) + 1);
    session.attach(connectionId, socket);
    socket.on('message', (data, isBinary) => {
      const messageBytes = Array.isArray(data)
        ? data.reduce((total, part) => total + part.byteLength, 0)
        : data.byteLength;
      if (isBinary || messageBytes > MAX_MESSAGE_BYTES) {
        socket.close(1009, 'message too large');
        return;
      }
      const now = Date.now();
      if (now - rate.startedAt >= 10_000) {
        rate.startedAt = now;
        rate.count = 0;
      }
      rate.count += 1;
      if (rate.count > 40) {
        socket.close(1008, 'rate limit');
        return;
      }
      if (!consumeFixedWindow(ipMessageRates, ip, now, 10_000, 200)) {
        socket.close(1008, 'ip rate limit');
        return;
      }
      let message: unknown;
      try {
        const json = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8');
        message = JSON.parse(json);
      } catch {
        socket.close(1007, 'invalid json');
        return;
      }
      if (!validMessage(message)) {
        socket.close(1008, 'invalid message');
        return;
      }
      if (message.t === 'ping') {
        socket.send('{"t":"pong"}');
        return;
      }
      if (message.t === 'action') {
        if (message.seq <= lastActionSeq) {
          socket.send(
            JSON.stringify({ t: 'reject', reason: '重复或过期的操作', seq: message.seq }),
          );
          return;
        }
        lastActionSeq = message.seq;
      }
      void session
        .enqueue(() => session.handle(connectionId, message))
        .catch(() => {
          socket.close(1011, 'server error');
        });
    });
    socket.once('close', () => {
      const remaining = (activeConnections.get(ip) ?? 1) - 1;
      if (remaining > 0) activeConnections.set(ip, remaining);
      else activeConnections.delete(ip);
      void session.enqueue(() => {
        session.detached(connectionId);
      });
    });
  });

  return {
    listen: async () => {
      await store.ready();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    address: () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server is not listening');
      return address;
    },
    close: async () => {
      clearInterval(cleanupTimer);
      for (const client of wss.clients) client.terminate();
      for (const session of sessions.values()) session.dispose();
      await Promise.all(Array.from(sessions.values(), (session) => session.work));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
