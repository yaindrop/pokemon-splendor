/* Integration tests for the self-hosted room server — run: node test/server.test.js */
const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' + (error.stack || error.message));
  }
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pokemon-splendor-'));
  try { return await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function messageOfType(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for ' + type)), 2000);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.t !== type) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

(async () => {
  await test('player names are bounded and cannot carry HTML markup', async () => {
    const { normalizeName, validMessage } = require('../server/room-server.js');
    const normalized = normalizeName('<img src=x onerror="alert(1)">超长名字超长名字超长名字超长名字');
    assert.ok(!/[<>"']/.test(normalized));
    assert.ok(Array.from(normalized).length <= 20);
    assert.strictEqual(validMessage({ t: 'start', opts: { megas: 'yes' } }), false);
    assert.strictEqual(validMessage({ t: 'action', seq: 1, action: { type: 'take', colors: ['red', 'blue', 'black', 'pink'] } }), false);
    assert.strictEqual(validMessage({ t: 'action', seq: 1, action: { type: 'capture', cardId: 's1_01', opts: { injected: true } } }), false);
    assert.strictEqual(validMessage({ t: 'action', seq: 1, action: { type: 'endTurn', injected: true } }), false);
    assert.strictEqual(validMessage({ t: 'action', seq: 1, action: { type: 'endTurn' } }), true);
  });

  await test('FileRoomStore persists, reloads, and deletes a room snapshot', async () => {
    const { FileRoomStore } = require('../server/file-room-store.js');
    await withTempDir(async (dir) => {
      const store = new FileRoomStore(dir);
      const snapshot = { version: 1, seq: 7, updatedAt: 1234, seats: [{ name: 'A' }] };
      await store.save('ABCD2345', snapshot);
      assert.deepStrictEqual(await store.load('ABCD2345'), snapshot);

      const restartedStore = new FileRoomStore(dir);
      assert.deepStrictEqual(await restartedStore.load('ABCD2345'), snapshot);
      await restartedStore.save('EFGH6789', { version: 1, updatedAt: 9999 });
      assert.deepStrictEqual(await restartedStore.listExpired(5000), ['ABCD2345']);
      await restartedStore.delete('ABCD2345');
      assert.strictEqual(await restartedStore.load('ABCD2345'), null);
    });
  });

  await test('RoomServer creates rooms and hosts an authoritative WebSocket game', async () => {
    const { createRoomServer } = require('../server/room-server.js');
    await withTempDir(async (dir) => {
      const app = createRoomServer({ dataDir: dir, host: '127.0.0.1', port: 0 });
      await app.listen();
      try {
        const base = `http://127.0.0.1:${app.address().port}`;
        const health = await fetch(base + '/healthz');
        assert.strictEqual(health.status, 200);

        const crossSite = await fetch(base + '/api/rooms', {
          method: 'POST',
          headers: { origin: 'https://attacker.example' },
        });
        assert.strictEqual(crossSite.status, 403);

        const created = await fetch(base + '/api/rooms', { method: 'POST' });
        assert.strictEqual(created.status, 201);
        const { code } = await created.json();
        assert.match(code, /^[A-Z2-9]{8}$/);

        const wsUrl = base.replace('http:', 'ws:') + `/room/${code}/ws`;
        let a = new WebSocket(wsUrl);
        const b = new WebSocket(wsUrl);
        await Promise.all([
          new Promise((resolve) => a.once('open', resolve)),
          new Promise((resolve) => b.once('open', resolve)),
        ]);

        const pong = messageOfType(a, 'pong');
        a.send(JSON.stringify({ t: 'ping' }));
        await pong;

        const welcomeA = messageOfType(a, 'welcome');
        a.send(JSON.stringify({ t: 'join', name: 'Alice' }));
        const wa = await welcomeA;
        assert.strictEqual(wa.seat, 0);
        assert.match(wa.token, /^[a-f0-9]{64}$/);

        a.terminate();
        a = new WebSocket(wsUrl);
        await new Promise((resolve) => a.once('open', resolve));
        const resumedA = messageOfType(a, 'welcome');
        a.send(JSON.stringify({ t: 'join', name: 'Alice', token: wa.token }));
        assert.strictEqual((await resumedA).seat, 0, 'brief lobby disconnect keeps the seat');

        const welcomeB = messageOfType(b, 'welcome');
        b.send(JSON.stringify({ t: 'join', name: 'Bob' }));
        const wb = await welcomeB;
        assert.strictEqual(wb.seat, 1);
        assert.match(wb.token, /^[a-f0-9]{64}$/);

        const stateA = messageOfType(a, 'state');
        a.send(JSON.stringify({ t: 'start', opts: {} }));
        const state = await stateA;
        assert.strictEqual(state.state.numPlayers, 2);
        assert.ok(state.state.decks.stage1.every((card) => card === null));
        a.close();
        b.close();
      } finally {
        await app.close();
      }
    });
  });

  await test('a room survives a server restart and a token reclaims its hidden seat', async () => {
    const { createRoomServer } = require('../server/room-server.js');
    await withTempDir(async (dir) => {
      let app = createRoomServer({ dataDir: dir, host: '127.0.0.1', port: 0 });
      await app.listen();
      const firstBase = `http://127.0.0.1:${app.address().port}`;
      const { code } = await (await fetch(firstBase + '/api/rooms', { method: 'POST' })).json();
      const firstWsUrl = firstBase.replace('http:', 'ws:') + `/room/${code}/ws`;
      const a = new WebSocket(firstWsUrl);
      const b = new WebSocket(firstWsUrl);
      await Promise.all([
        new Promise((resolve) => a.once('open', resolve)),
        new Promise((resolve) => b.once('open', resolve)),
      ]);
      const welcomeA = messageOfType(a, 'welcome');
      a.send(JSON.stringify({ t: 'join', name: 'Alice' }));
      const tokenA = (await welcomeA).token;
      const welcomeB = messageOfType(b, 'welcome');
      b.send(JSON.stringify({ t: 'join', name: 'Bob' }));
      await welcomeB;
      const started = messageOfType(a, 'state');
      a.send(JSON.stringify({ t: 'start', opts: {} }));
      await started;
      const moved = messageOfType(a, 'state');
      a.send(JSON.stringify({ t: 'action', seq: 1, action: { type: 'take', colors: ['red', 'blue', 'black'] } }));
      assert.strictEqual((await moved).state.players[0].tokens.red, 1);
      const duplicate = messageOfType(a, 'reject');
      a.send(JSON.stringify({ t: 'action', seq: 1, action: { type: 'endTurn' } }));
      assert.match((await duplicate).reason, /重复|过期/);
      a.terminate();
      b.terminate();
      await app.close();

      app = createRoomServer({ dataDir: dir, host: '127.0.0.1', port: 0 });
      await app.listen();
      try {
        const secondBase = `http://127.0.0.1:${app.address().port}`;
        const resumed = new WebSocket(secondBase.replace('http:', 'ws:') + `/room/${code}/ws`);
        await new Promise((resolve) => resumed.once('open', resolve));
        const welcome = messageOfType(resumed, 'welcome');
        const state = messageOfType(resumed, 'state');
        resumed.send(JSON.stringify({ t: 'join', name: 'Alice', token: tokenA }));
        assert.strictEqual((await welcome).seat, 0);
        const restored = await state;
        assert.strictEqual(restored.state.players[0].tokens.red, 1);
        resumed.close();
      } finally {
        await app.close();
      }
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
