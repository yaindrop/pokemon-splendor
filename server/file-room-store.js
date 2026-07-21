const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { isRoomCode } = require('./room-code.js');

class FileRoomStore {
  constructor(directory) {
    if (!directory) throw new Error('room data directory is required');
    this.directory = path.resolve(directory);
    this.ready = null;
  }

  async _init() {
    if (!this.ready) this.ready = fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.ready;
  }

  _path(code) {
    if (!isRoomCode(code)) throw new Error('invalid room code');
    return path.join(this.directory, code + '.json');
  }

  async load(code) {
    await this._init();
    try {
      return JSON.parse(await fs.readFile(this._path(code), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(code, snapshot) {
    await this._init();
    const target = this._path(code);
    const temporary = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async delete(code) {
    await this._init();
    await fs.rm(this._path(code), { force: true });
  }

  async listExpired(cutoff) {
    await this._init();
    const files = await fs.readdir(this.directory);
    const expired = [];
    for (const file of files) {
      const code = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!isRoomCode(code)) continue;
      try {
        const snapshot = JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'));
        if (Number(snapshot.updatedAt || 0) < cutoff) expired.push(code);
      } catch (_) { /* leave corrupt files in place for operator recovery */ }
    }
    return expired.sort();
  }
}

module.exports = { FileRoomStore };
