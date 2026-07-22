import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { isClientMessage, type RoomClientMessage } from '@pokemon-splendor/protocol';

export interface FixedWindowBucket {
  startedAt: number;
  count: number;
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(data);
}

export function randomToken(): string {
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

export function requestOriginAllowed(
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

export function clientIp(request: IncomingMessage): string {
  return (
    String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? '')
      .split(',')[0]
      ?.trim() ?? ''
  );
}

export function consumeFixedWindow(
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
