import type { GameAction, RoomServerMessage } from '@pokemon-splendor/game-core';
import { isServerMessage, type RoomClientMessage } from '@pokemon-splendor/protocol';

export interface RoomStartOptions {
  readonly megas?: boolean;
  readonly pokemart?: boolean;
  readonly turnTimeoutMs?: number | null;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type ServerEvent<T extends RoomServerMessage['t']> = Extract<RoomServerMessage, { readonly t: T }>;

export interface NetEventMap {
  readonly welcome: ServerEvent<'welcome'>;
  readonly roster: ServerEvent<'roster'>;
  readonly state: ServerEvent<'state'>;
  readonly reject: ServerEvent<'reject'>;
  readonly over: ServerEvent<'over'>;
  readonly status: ConnectionStatus;
  readonly 'undo-vote': ServerEvent<'undo-vote'>;
  readonly 'undo-result': ServerEvent<'undo-result'>;
}

type NetEvent = keyof NetEventMap;

export interface NetApi {
  connect(code: string, name: string): void;
  on<K extends NetEvent>(event: K, handler: (data: NetEventMap[K]) => void): void;
  send(message: RoomClientMessage): void;
  action(move: GameAction): void;
  start(options?: RoomStartOptions): void;
  sync(): void;
  requestUndo(): void;
  voteUndo(approve: boolean): void;
  close(): void;
  leave(): void;
  createRoom(): Promise<string>;
  isOpen(): boolean;
}

interface ConnectionConfig {
  readonly code: string;
  readonly name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roomCodeFrom(value: unknown): string | null {
  return isRecord(value) && typeof value['code'] === 'string' ? value['code'] : null;
}

const handlers = new Map<NetEvent, (data: unknown) => void>();
let socket: WebSocket | null = null;
let config: ConnectionConfig | null = null;
let heartbeat: number | null = null;
let reconnectTimer: number | null = null;
let closedByUs = false;
let sequence = 0;
let retry = 0;

function on<K extends NetEvent>(event: K, handler: (data: NetEventMap[K]) => void): void {
  handlers.set(event, (data: unknown): void => {
    if (isEventPayload(event, data)) handler(data);
  });
}

function emit<K extends NetEvent>(event: K, data: NetEventMap[K]): void {
  try {
    handlers.get(event)?.(data);
  } catch (error) {
    console.error('Net handler', event, error);
  }
}

function isEventPayload<K extends NetEvent>(event: K, data: unknown): data is NetEventMap[K] {
  if (event === 'status') {
    return data === 'connecting' || data === 'connected' || data === 'disconnected';
  }
  return isServerMessage(data) && data.t === event;
}

function token(code: string): string | null {
  try {
    return sessionStorage.getItem(`pkmn_net_token_${code}`);
  } catch {
    return null;
  }
}

function rememberToken(code: string, value: string): void {
  try {
    sessionStorage.setItem(`pkmn_net_token_${code}`, value);
  } catch {
    // Storage may be disabled; reconnect then falls back to a new seat.
  }
}

function roomUrl(code: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/room/${encodeURIComponent(code)}/ws`;
}

function connect(code: string, name: string): void {
  config = { code, name };
  closedByUs = false;
  retry = 0;
  open();
}

function open(): void {
  if (!config) return;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  emit('status', 'connecting');
  const activeConfig = config;
  socket = new WebSocket(roomUrl(activeConfig.code));
  socket.onopen = () => {
    retry = 0;
    emit('status', 'connected');
    const reconnectToken = token(activeConfig.code);
    send(
      reconnectToken
        ? { t: 'join', name: activeConfig.name, token: reconnectToken }
        : { t: 'join', name: activeConfig.name },
    );
    beat();
  };
  socket.onmessage = (event: MessageEvent<string>) => {
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isServerMessage(message)) return;
    if (message.t === 'pong') return;
    if (message.t === 'welcome' && message.token !== null) {
      rememberToken(activeConfig.code, message.token);
    }
    switch (message.t) {
      case 'welcome':
        emit('welcome', message);
        break;
      case 'roster':
        emit('roster', message);
        break;
      case 'state':
        emit('state', message);
        break;
      case 'reject':
        emit('reject', message);
        break;
      case 'over':
        emit('over', message);
        break;
      case 'undo-vote':
        emit('undo-vote', message);
        break;
      case 'undo-result':
        emit('undo-result', message);
        break;
    }
  };
  socket.onclose = () => {
    stopBeat();
    emit('status', 'disconnected');
    if (closedByUs) return;
    if (reconnectTimer != null) clearTimeout(reconnectTimer);
    const delay = Math.min(15_000, 750 * 2 ** Math.min(retry, 5)) + Math.floor(Math.random() * 400);
    retry += 1;
    reconnectTimer = window.setTimeout(() => {
      if (!closedByUs) open();
    }, delay);
  };
  socket.onerror = () => undefined;
}

function beat(): void {
  stopBeat();
  heartbeat = window.setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send('{"t":"ping"}');
  }, 25_000);
}

function stopBeat(): void {
  if (heartbeat != null) clearInterval(heartbeat);
  heartbeat = null;
}

function send(message: RoomClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function action(move: GameAction): void {
  sequence += 1;
  send({ t: 'action', seq: sequence, action: move });
}

function start(options: RoomStartOptions = {}): void {
  send({ t: 'start', opts: options });
}

function teardown(delay: number): void {
  closedByUs = true;
  if (reconnectTimer != null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopBeat();
  const leaving = socket;
  socket = null;
  const finish = (): void => {
    if (!leaving) return;
    leaving.onclose = null;
    leaving.close();
  };
  if (delay > 0) window.setTimeout(finish, delay);
  else finish();
}

async function createRoom(): Promise<string> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('无法创建房间');
  const body: unknown = await response.json();
  const code = roomCodeFrom(body);
  if (!code) throw new Error('房间响应无效');
  return code;
}

export const Net: NetApi = {
  connect,
  on,
  send,
  action,
  start,
  sync: () => {
    send({ t: 'sync' });
  },
  requestUndo: () => {
    send({ t: 'undo-request' });
  },
  voteUndo: (approve) => {
    send({ t: 'undo-vote', approve });
  },
  close: () => {
    teardown(0);
  },
  leave: () => {
    send({ t: 'leave' });
    teardown(80);
  },
  createRoom,
  isOpen: () => socket?.readyState === WebSocket.OPEN,
};
