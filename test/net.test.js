/* Browser-transport regression tests — run: node test/net.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../js/net.js'), 'utf8');

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadTab(localStorage, sessionStorage) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
  }

  const window = {};
  vm.runInNewContext(source, {
    window,
    location: { protocol: 'http:', host: 'game.example' },
    localStorage,
    sessionStorage,
    WebSocket: FakeWebSocket,
    fetch: async () => ({ ok: true, json: async () => ({ code: 'ROOM2345' }) }),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
  });
  return { Net: window.Net, sockets };
}

const sharedLocalStorage = storage();
const firstSession = storage();
const firstTab = loadTab(sharedLocalStorage, firstSession);
firstTab.Net.connect('ROOM2345', 'Alice');
firstTab.sockets[0].open();
assert.strictEqual(firstTab.sockets[0].sent[0].token, null);
firstTab.sockets[0].receive({ t: 'welcome', token: 'a'.repeat(64), seat: 0 });

const secondTab = loadTab(sharedLocalStorage, storage());
secondTab.Net.connect('ROOM2345', 'Bob');
secondTab.sockets[0].open();
assert.strictEqual(secondTab.sockets[0].sent[0].token, null,
  'a separate tab must join as a new player instead of stealing the first tab seat');

const refreshedFirstTab = loadTab(sharedLocalStorage, firstSession);
refreshedFirstTab.Net.connect('ROOM2345', 'Alice');
refreshedFirstTab.sockets[0].open();
assert.strictEqual(refreshedFirstTab.sockets[0].sent[0].token, 'a'.repeat(64),
  'refreshing the same tab must reclaim its existing seat');

console.log('  ✓ separate tabs get separate room identities and refresh preserves a seat');
