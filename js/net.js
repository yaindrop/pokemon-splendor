/* =====================================================================
 * 璀璨宝石：宝可梦  —  online client transport (window.Net)
 * ---------------------------------------------------------------------
 * One WebSocket to the self-hosted Node room server. Handles the
 * wire protocol, a stable per-room identity token (so a refresh reclaims the
 * same seat + hidden hand), a heartbeat the server auto-answers without waking
 * the DO, and auto-reconnect. It is transport only — it knows no game rules;
 * ui.js subscribes to events and drives the UI.
 *
 *   Net.connect(code, name)       open/join a room
 *   Net.on(event, fn)             welcome | roster | state | reject | over | status
 *   Net.start(opts)               host starts the game
 *   Net.action(move)              send a move ({type,...} engine action)
 *   Net.sync() / Net.close()
 * ===================================================================== */
(function () {
  'use strict';
  let ws = null, cfg = null, hb = null, reconnect = null, closedByUs = false, seq = 0, retry = 0;
  const handlers = {};

  function on(ev, fn) { handlers[ev] = fn; }
  function emit(ev, data) { if (handlers[ev]) { try { handlers[ev](data); } catch (e) { console.error('Net handler', ev, e); } } }

  // A room identity belongs to one browser tab. sessionStorage survives a
  // refresh, but unlike localStorage it is not shared by another tab/window —
  // otherwise two players on one device continually steal the same seat.
  function token(code) {
    const k = 'pkmn_net_token_' + code;
    try { return sessionStorage.getItem(k); } catch (e) { return null; }
  }
  function rememberToken(code, value) {
    if (!value) return;
    try { sessionStorage.setItem('pkmn_net_token_' + code, value); } catch (e) { }
  }
  function url(code) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/room/' + encodeURIComponent(code) + '/ws';
  }

  function connect(code, name) { cfg = { code, name }; closedByUs = false; retry = 0; open(); }
  function open() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { } }
    emit('status', 'connecting');
    ws = new WebSocket(url(cfg.code));
    ws.onopen = () => { retry = 0; emit('status', 'connected'); send({ t: 'join', name: cfg.name, token: token(cfg.code) }); beat(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || m.t === 'pong') return;
      if (m.t === 'welcome' && m.token) rememberToken(cfg.code, m.token);
      emit(m.t, m);
    };
    ws.onclose = () => {
      stopBeat(); emit('status', 'disconnected');
      if (!closedByUs) {
        clearTimeout(reconnect);
        const delay = Math.min(15000, 750 * (2 ** Math.min(retry++, 5))) + Math.floor(Math.random() * 400);
        reconnect = setTimeout(() => { if (!closedByUs) open(); }, delay);
      }
    };
    ws.onerror = () => { /* onclose handles retry */ };
  }
  function beat() { stopBeat(); hb = setInterval(() => { try { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); } catch (e) { } }, 25000); }
  function stopBeat() { if (hb) { clearInterval(hb); hb = null; } }

  function send(msg) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (e) { } }
  function action(move) { send({ t: 'action', seq: ++seq, action: move }); }
  function start(opts) { send({ t: 'start', opts: opts || {} }); }
  function sync() { send({ t: 'sync' }); }
  function requestUndo() { send({ t: 'undo-request' }); }
  function voteUndo(approve) { send({ t: 'undo-vote', approve: !!approve }); }
  function teardown(delay) {
    closedByUs = true; clearTimeout(reconnect); stopBeat();
    const leaving = ws; ws = null;
    const finish = () => { if (leaving) { try { leaving.onclose = null; leaving.close(); } catch (e) { } } };
    if (delay) setTimeout(finish, delay); else finish();
  }
  function close() { teardown(0); }
  function leave() { send({ t: 'leave' }); teardown(80); }
  async function createRoom() {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('无法创建房间');
    const body = await response.json();
    if (!body || typeof body.code !== 'string') throw new Error('房间响应无效');
    return body.code;
  }

  window.Net = { connect, on, send, action, start, sync, requestUndo, voteUndo, close, leave, createRoom, isOpen: () => !!(ws && ws.readyState === 1) };
})();
