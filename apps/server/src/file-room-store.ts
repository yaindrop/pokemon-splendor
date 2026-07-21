import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoomSnapshot } from '@pokemon-splendor/game-core';
import { isRoomSnapshot } from '@pokemon-splendor/protocol';
import { isRoomCode } from './room-code.js';

export interface RoomEnvelope {
  readonly version: 1;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly room: RoomSnapshot;
}

export interface RoomStore {
  ready(): Promise<void>;
  load(code: string): Promise<RoomEnvelope | null>;
  save(code: string, snapshot: RoomEnvelope): Promise<void>;
  delete(code: string): Promise<void>;
  listExpired(cutoff: number): Promise<string[]>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRoomEnvelope(value: unknown): value is RoomEnvelope {
  if (!isRecord(value) || value['version'] !== 1) return false;
  if (
    !Number.isSafeInteger(value['createdAt']) ||
    Number(value['createdAt']) < 0 ||
    !Number.isSafeInteger(value['updatedAt']) ||
    Number(value['updatedAt']) < 0
  ) {
    return false;
  }
  return isRoomSnapshot(value['room']);
}

export class FileRoomStore implements RoomStore {
  readonly #directory: string;
  #ready: Promise<string | undefined> | null = null;

  constructor(directory: string) {
    if (!directory) throw new Error('room data directory is required');
    this.#directory = path.resolve(directory);
  }

  async #init(): Promise<void> {
    this.#ready ??= mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#ready;
  }

  async ready(): Promise<void> {
    await this.#init();
  }

  #path(code: string): string {
    if (!isRoomCode(code)) throw new Error('invalid room code');
    return path.join(this.#directory, `${code}.json`);
  }

  async load(code: string): Promise<RoomEnvelope | null> {
    await this.#init();
    try {
      const value: unknown = JSON.parse(await readFile(this.#path(code), 'utf8'));
      if (!isRoomEnvelope(value)) throw new TypeError(`invalid room snapshot: ${code}`);
      return value;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(code: string, snapshot: RoomEnvelope): Promise<void> {
    await this.#init();
    const target = this.#path(code);
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async delete(code: string): Promise<void> {
    await this.#init();
    await rm(this.#path(code), { force: true });
  }

  async listExpired(cutoff: number): Promise<string[]> {
    await this.#init();
    const files = await readdir(this.#directory);
    const expired: string[] = [];
    for (const file of files) {
      const code = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!isRoomCode(code)) continue;
      try {
        const snapshot: unknown = JSON.parse(
          await readFile(path.join(this.#directory, file), 'utf8'),
        );
        if (isRoomEnvelope(snapshot) && snapshot.updatedAt < cutoff) expired.push(code);
      } catch {
        // Leave corrupt files in place for operator recovery.
      }
    }
    return expired.sort();
  }
}
