import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE = /^[A-Z2-9]{8}$/;

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE.test(value);
}

export function randomRoomCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += ALPHABET.charAt(byte % ALPHABET.length);
  return code;
}
