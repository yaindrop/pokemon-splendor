const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Room, TURN_TIMEOUT_MS } = require('../js/room.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');
const MEGA_DB = require('../data/megas.json');
const POKEMART_DB = require('../data/pokemart.json');
const { FileRoomStore } = require('./file-room-store.js');
const { isRoomCode, randomRoomCode } = require('./room-code.js');

const ROOM_PATH = /^\/room\/([^/]+)\/ws$/;
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

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeName(value) {
  if (typeof value !== 'string') return '训练家';
  const name = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>\&"'`]/g, '').trim();
  return Array.from(name).slice(0, 20).join('') || '训练家';
}

function validAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') return false;
  const shortString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;
  const colors = new Set(['red', 'blue', 'black', 'pink', 'yellow', 'purple']);
  switch (action.type) {
    case 'take':
      return Array.isArray(action.colors) && action.colors.length >= 1 && action.colors.length <= 3 && action.colors.every((color) => colors.has(color));
    case 'capture':
      return shortString(action.cardId) && (action.opts == null || (typeof action.opts === 'object' && !Array.isArray(action.opts)));
    case 'reserve':
      return !!action.target && typeof action.target === 'object' && !Array.isArray(action.target) &&
        (shortString(action.target.fromField) || shortString(action.target.fromDeck));
    case 'evolve':
      return shortString(action.fromId) && shortString(action.toId);
    case 'megaEvolve':
      return shortString(action.megaId) && shortString(action.fromId);
    case 'discard':
      return colors.has(action.color);
    case 'takeMega':
    case 'pass':
    case 'endTurn':
      return true;
    default:
      return false;
  }
}

function validMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (!['ping', 'join', 'start', 'action', 'sync', 'leave'].includes(message.t)) return false;
  if (message.t === 'join') {
    return (message.name == null || typeof message.name === 'string') &&
      (message.token == null || (typeof message.token === 'string' && /^[a-f0-9]{64}$/.test(message.token)));
  }
  if (message.t === 'action') return Number.isSafeInteger(message.seq) && message.seq > 0 &&
    validAction(message.action);
  if (message.t === 'start') {
    if (message.opts == null) return true;
    if (typeof message.opts !== 'object' || Array.isArray(message.opts)) return false;
    return Object.keys(message.opts).every((key) => ['megas', 'pokemart'].includes(key)) &&
      ['megas', 'pokemart'].every((key) => message.opts[key] == null || typeof message.opts[key] === 'boolean');
  }
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

function clientIp(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '').split(',')[0].trim();
}

class RoomSession {
  constructor(code, store, envelope, options = {}) {
    this.code = code;
    this.store = store;
    this.createdAt = envelope && envelope.createdAt || Date.now();
    this.updatedAt = envelope && envelope.updatedAt || this.createdAt;
    this.sockets = new Map();
    this.work = Promise.resolve();
    this.turnTimer = null;
    this.lobbyDisconnectGraceMs = options.lobbyDisconnectGraceMs || 15000;
    this.lobbyReleaseTimers = new Map();
    this.authority = new Room({
      cardDB: DB,
      megaDB: MEGA_DB,
      pokemartDB: POKEMART_DB,
      send: (connId, message) => this.send(connId, message),
      disconnect: (connId) => this.disconnect(connId),
    });
    if (envelope && envelope.room) {
      this.authority.restore(envelope.room);
      if (!envelope.room.started) {
        for (const seat of envelope.room.seats || []) if (seat.token) this.scheduleLobbyRelease(seat.token);
      }
    }
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
      const presentedToken = message.token;
      message = {
        t: 'join',
        name: normalizeName(message.name),
        token: this.authority.resolveJoinToken(message.token, randomToken),
      };
      if (message.token === presentedToken) this.cancelLobbyRelease(message.token);
    }
    this.authority.now = Date.now();
    this.authority.onMessage(connId, message);
    if (MUTATING_MESSAGES.has(message.t)) await this.persist();
    this.scheduleTimeout();
  }

  async detached(connId) {
    this.sockets.delete(connId);
    const reconnectToken = this.authority.leave(connId);
    if (reconnectToken) this.scheduleLobbyRelease(reconnectToken);
    this.scheduleTimeout();
  }

  cancelLobbyRelease(token) {
    const timer = this.lobbyReleaseTimers.get(token);
    if (timer) clearTimeout(timer);
    this.lobbyReleaseTimers.delete(token);
  }

  scheduleLobbyRelease(token) {
    this.cancelLobbyRelease(token);
    const timer = setTimeout(() => {
      this.lobbyReleaseTimers.delete(token);
      void this.enqueue(async () => {
        if (this.authority.releaseDisconnectedSeat(token)) await this.persist();
      });
    }, this.lobbyDisconnectGraceMs);
    if (timer.unref) timer.unref();
    this.lobbyReleaseTimers.set(token, timer);
  }

  scheduleTimeout() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    const timeoutAt = this.authority.nextTimeoutAt();
    if (timeoutAt == null) return;
    const dueIn = Math.max(0, timeoutAt - Date.now());
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      void this.enqueue(async () => {
        const plan = (state) => AI.chooseTurn(state, { difficulty: 'hard' });
        if (this.authority.timeoutTurn(Date.now(), plan)) await this.persist();
        this.scheduleTimeout();
      });
    }, dueIn);
    if (this.turnTimer.unref) this.turnTimer.unref();
  }

  dispose() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    for (const timer of this.lobbyReleaseTimers.values()) clearTimeout(timer);
    this.lobbyReleaseTimers.clear();
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
  const activeConnections = new Map();
  const roomTtlMs = options.roomTtlMs || 7 * 24 * 60 * 60 * 1000;
  const sessionOptions = { lobbyDisconnectGraceMs: options.lobbyDisconnectGraceMs || 15000 };
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });

  async function sessionFor(code) {
    if (sessions.has(code)) return sessions.get(code);
    const envelope = await store.load(code);
    if (!envelope) return null;
    const session = new RoomSession(code, store, envelope, sessionOptions);
    sessions.set(code, session);
    return session;
  }

  async function createRoom() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomRoomCode();
      if (sessions.has(code) || await store.load(code)) continue;
      const session = new RoomSession(code, store, null, sessionOptions);
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
      const ip = clientIp(request);
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
      if (!match || !isRoomCode(match[1]) || !requestOriginAllowed(request, allowedOrigins)) {
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
      request.clientIp = clientIp(request);
      if ((activeConnections.get(request.clientIp) || 0) >= 20) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
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
    const ip = request.clientIp || clientIp(request);
    activeConnections.set(ip, (activeConnections.get(ip) || 0) + 1);
    session.attach(connId, socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MESSAGE_BYTES) return socket.close(1009, 'message too large');
      const now = Date.now();
      if (now - rate.startedAt >= 10000) { rate.startedAt = now; rate.count = 0; }
      if (++rate.count > 40) return socket.close(1008, 'rate limit');
      let message;
      try { message = JSON.parse(data.toString()); } catch (_) { return socket.close(1007, 'invalid json'); }
      if (!validMessage(message)) return socket.close(1008, 'invalid message');
      if (message.t === 'ping') {
        socket.send('{"t":"pong"}');
        return;
      }
      if (message.t === 'action') {
        if (message.seq <= lastActionSeq) {
          socket.send(JSON.stringify({ t: 'reject', reason: '重复或过期的操作', seq: message.seq }));
          return;
        }
        lastActionSeq = message.seq;
      }
      void session.enqueue(() => session.handle(connId, message)).catch(() => socket.close(1011, 'server error'));
    });
    socket.once('close', () => {
      const remaining = (activeConnections.get(ip) || 1) - 1;
      if (remaining > 0) activeConnections.set(ip, remaining); else activeConnections.delete(ip);
      void session.enqueue(() => session.detached(connId));
    });
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
