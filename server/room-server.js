const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Room, TURN_TIMEOUT_MS } = require('../js/room.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');
const MEGA_DB = require('../data/megas.json');
const POKEMART_DB = require('../data/pokemart.json');
const { FileRoomStore } = require('./file-room-store.js');

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_PATH = /^\/room\/([A-Z2-9]{8})\/ws$/;
const MAX_CONNECTIONS_PER_ROOM = 12;
const MAX_MESSAGE_BYTES = 8192;
const MUTATING_MESSAGES = new Set(['join', 'start', 'action', 'leave']);

function json(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(data);
}

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return code;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeName(value) {
  if (typeof value !== 'string') return '训练家';
  const name = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>\&"'`]/g, '').trim();
  return Array.from(name).slice(0, 20).join('') || '训练家';
}

function validMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (!['join', 'start', 'action', 'sync', 'leave'].includes(message.t)) return false;
  if (message.t === 'join') {
    return (message.name == null || typeof message.name === 'string') &&
      (message.token == null || (typeof message.token === 'string' && message.token.length <= 128));
  }
  if (message.t === 'action') return Number.isSafeInteger(message.seq) && message.seq > 0 &&
    !!message.action && typeof message.action === 'object' && typeof message.action.type === 'string';
  if (message.t === 'start') return message.opts == null || (typeof message.opts === 'object' && !Array.isArray(message.opts));
  return true;
}

function requestOriginAllowed(request, configuredOrigins) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (configuredOrigins.has(origin)) return true;
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
  return origin === `${protocol}://${request.headers.host}`;
}

class RoomSession {
  constructor(code, store, envelope) {
    this.code = code;
    this.store = store;
    this.createdAt = envelope && envelope.createdAt || Date.now();
    this.updatedAt = envelope && envelope.updatedAt || this.createdAt;
    this.sockets = new Map();
    this.work = Promise.resolve();
    this.turnTimer = null;
    this.authority = new Room({
      cardDB: DB,
      megaDB: MEGA_DB,
      pokemartDB: POKEMART_DB,
      send: (connId, message) => this.send(connId, message),
      disconnect: (connId) => this.disconnect(connId),
    });
    if (envelope && envelope.room) this.authority.restore(envelope.room);
  }

  enqueue(task) {
    const next = this.work.then(task, task);
    this.work = next.catch(() => {});
    return next;
  }

  attach(connId, socket) {
    this.sockets.set(connId, socket);
  }

  send(connId, message) {
    const socket = this.sockets.get(connId);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  disconnect(connId) {
    const socket = this.sockets.get(connId);
    this.sockets.delete(connId);
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(4001, 'seat resumed elsewhere');
  }

  async handle(connId, message) {
    if (message.t === 'join') {
      const knownToken = typeof message.token === 'string' && this.authority.seats.some((seat) => seat.token === message.token);
      message = {
        t: 'join',
        name: normalizeName(message.name),
        token: knownToken ? message.token : randomToken(),
      };
    }
    this.authority.now = Date.now();
    this.authority.onMessage(connId, message);
    if (MUTATING_MESSAGES.has(message.t)) await this.persist();
    this.scheduleTimeout();
  }

  async detached(connId) {
    this.sockets.delete(connId);
    const lobbyChanged = !this.authority.started && this.authority.conns[connId] != null;
    this.authority.leave(connId);
    if (lobbyChanged) await this.persist();
    this.scheduleTimeout();
  }

  scheduleTimeout() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (!this.authority.started || !this.authority.G || this.authority.G.phase !== 'play') return;
    if (!this.authority.seats.some((seat) => seat.connected)) return;
    const dueIn = Math.max(0, this.authority.turnStartedAt + TURN_TIMEOUT_MS - Date.now());
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      void this.enqueue(async () => {
        let plan = {};
        try { plan = AI.chooseTurn(this.authority.G, { difficulty: 'hard' }) || {}; } catch (_) { }
        if (this.authority.timeoutTurn(Date.now(), plan)) await this.persist();
        this.scheduleTimeout();
      });
    }, dueIn);
    if (this.turnTimer.unref) this.turnTimer.unref();
  }

  dispose() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  async persist() {
    this.updatedAt = Date.now();
    await this.store.save(this.code, {
      version: 1,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      room: this.authority.snapshot(),
    });
  }
}

function createRoomServer(options = {}) {
  const host = options.host || '0.0.0.0';
  const port = options.port == null ? 3000 : options.port;
  const store = options.store || new FileRoomStore(options.dataDir || './data/rooms');
  const allowedOrigins = new Set(options.allowedOrigins || []);
  const sessions = new Map();
  const roomCreates = new Map();
  const roomTtlMs = options.roomTtlMs || 7 * 24 * 60 * 60 * 1000;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });

  async function sessionFor(code) {
    if (sessions.has(code)) return sessions.get(code);
    const envelope = await store.load(code);
    if (!envelope) return null;
    const session = new RoomSession(code, store, envelope);
    sessions.set(code, session);
    return session;
  }

  async function createRoom() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomCode();
      if (sessions.has(code) || await store.load(code)) continue;
      const session = new RoomSession(code, store, null);
      sessions.set(code, session);
      await session.persist();
      return code;
    }
    throw new Error('unable to allocate a room code');
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/readyz') return json(response, 200, { ok: true });
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (!requestOriginAllowed(request, allowedOrigins)) return json(response, 403, { error: 'forbidden origin' });
      const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      let quota = roomCreates.get(ip);
      if (!quota || now - quota.startedAt >= 60 * 60 * 1000) quota = { startedAt: now, count: 0 };
      roomCreates.set(ip, quota);
      if (++quota.count > 20) return json(response, 429, { error: '创建房间过于频繁' });
      return void createRoom()
        .then((code) => json(response, 201, { code }))
        .catch(() => json(response, 503, { error: '暂时无法创建房间' }));
    }
    json(response, 404, { error: 'not found' });
  });

  const cleanupTimer = setInterval(() => {
    void store.listExpired(Date.now() - roomTtlMs).then(async (codes) => {
      for (const code of codes) {
        const session = sessions.get(code);
        if (session && session.sockets.size) continue;
        if (session) session.dispose();
        sessions.delete(code);
        await store.delete(code);
      }
    }).catch(() => {});
  }, Math.min(roomTtlMs, 60 * 60 * 1000));
  if (cleanupTimer.unref) cleanupTimer.unref();

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const match = pathname.match(ROOM_PATH);
      if (!match || !requestOriginAllowed(request, allowedOrigins)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const session = await sessionFor(match[1]);
      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (session.sockets.size >= MAX_CONNECTIONS_PER_ROOM) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, session));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (socket, request, session) => {
    const connId = crypto.randomUUID();
    const rate = { startedAt: Date.now(), count: 0 };
    let lastActionSeq = 0;
    session.attach(connId, socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MESSAGE_BYTES) return socket.close(1009, 'message too large');
      const now = Date.now();
      if (now - rate.startedAt >= 10000) { rate.startedAt = now; rate.count = 0; }
      if (++rate.count > 40) return socket.close(1008, 'rate limit');
      let message;
      try { message = JSON.parse(data.toString()); } catch (_) { return socket.close(1007, 'invalid json'); }
      if (!validMessage(message)) return socket.close(1008, 'invalid message');
      if (message.t === 'action') {
        if (message.seq <= lastActionSeq) {
          socket.send(JSON.stringify({ t: 'reject', reason: '重复或过期的操作', seq: message.seq }));
          return;
        }
        lastActionSeq = message.seq;
      }
      void session.enqueue(() => session.handle(connId, message)).catch(() => socket.close(1011, 'server error'));
    });
    socket.once('close', () => { void session.enqueue(() => session.detached(connId)); });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
    },
    address() { return server.address(); },
    async close() {
      clearInterval(cleanupTimer);
      for (const client of wss.clients) client.terminate();
      for (const session of sessions.values()) session.dispose();
      await Promise.all(Array.from(sessions.values(), (session) => session.work));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createRoomServer, normalizeName, validMessage };
