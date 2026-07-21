/* ===================== Pokémon Splendor — UI ===================== */
(function () {
  'use strict';
  const E = window.Engine, AI = window.AI, DB = window.CARD_DB;
  const MEGA_DB = window.MEGA_DB || [];
  const POKEMART_DB = window.POKEMART_DB || [];
  // 究极 difficulty: single-tree determinized MCTS (vsearch v2), TIME-based budget.
  // The web worker + the AI "thinking" pause hide the latency completely, so we
  // spend real time: ~900ms ≈ 2500-3000 sims on desktop (auto-scales down on
  // slower phones — same latency, fewer sims, still ≥ the old 200-sim budget).
  // Validated: v2 at equal wall-clock beats the old 200/3 config 61.7% (37/60,
  // p<.05); budget scaling adds more (2000-vs-600 sims: 58%). 3-4p still falls
  // back to the heuristic: even with oppK pruning the search measured 29.4% at
  // 3p / 15.6% at 4p (fair 33.3%/25%) — the multiplayer lever is an eval refit,
  // not more search (see test/vsearch_mp.js).
  const ULTRA_CFG = { timeMs: 900 };

  // --- AI web worker: heavy searches run OFF the main thread (no UI freeze). ---
  // ui posts a static-stripped state; the worker (js/ai.worker.js) loads the same
  // engine/AI files, reattaches the card DBs, and returns the plan. Any failure
  // (no Worker support, load error, crash) falls back to the old synchronous path.
  let aiWorker = null, aiJobSeq = 0;
  const aiJobs = {};
  function getAIWorker() {
    if (aiWorker !== null) return aiWorker;               // Worker | false (known-unavailable)
    try {
      aiWorker = new Worker('js/ai.worker.js');
      aiWorker.onmessage = (e) => {
        const m = e.data || {}, j = aiJobs[m.id];
        if (!j) return;
        delete aiJobs[m.id];
        if (m.error || !m.plan) j.fail(); else j.ok(m.plan);
      };
      aiWorker.onerror = () => {                          // worker died → fail all pending, disable
        for (const id in aiJobs) { aiJobs[id].fail(); delete aiJobs[id]; }
        try { aiWorker.terminate(); } catch (e) { }
        aiWorker = false;
      };
    } catch (e) { aiWorker = false; }
    return aiWorker;
  }
  // Promise<plan> for a turn: kind = 'ultra' (VSearch+opts) or a heuristic difficulty.
  // `state` defaults to the live G.
  function aiComputeAsync(kind, opts, state) {
    const s = state || G;
    const sync = () => (kind === 'ultra' && window.VSearch)
      ? VSearch.chooseTurn(s, opts || ULTRA_CFG)
      : AI.chooseTurn(s, { difficulty: kind || 'hard' });
    const w = getAIWorker();
    if (!w) return Promise.resolve(sync());
    const { cardDB, byId: _b, megaDB, pokemartDB, _byName, log, ...dyn } = s;  // strip statics/caches
    const id = ++aiJobSeq;
    return new Promise((resolve) => {
      aiJobs[id] = { ok: resolve, fail: () => resolve(sync()) };
      try { w.postMessage({ id, kind, g: dyn, opts }); }
      catch (e) { delete aiJobs[id]; resolve(sync()); }
    });
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const escapeHTML = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
  const BALL_NAMES = { red: '精灵球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '先机球', purple: '大师球' };
  const TIER_NAMES = { legend: '传说', rare: '稀有', stage3: '三阶', stage2: '二阶', stage1: '一阶', mega: 'Mega', pmL1: '商店Ⅰ', pmL2: '商店Ⅱ', pmL3: '商店Ⅲ' };
  const SEAT_COLORS = ['#e3350d', '#2f6fd6', '#46d17a', '#f4c025'];
  // per-seat trainer avatars (head/bust crops of the TTS trainer figurines)
  const SEAT_AVATARS = ['ash', 'misty', 'brock', 'rocket'];
  const seatAvatar = (i) => `assets/avatars/${SEAT_AVATARS[i % 4]}.png`;
  const byId = {}; DB.forEach(c => byId[c.id] = c); MEGA_DB.forEach(c => byId[c.id] = c); POKEMART_DB.forEach(c => byId[c.id] = c);

  let G = null;
  let UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: 0 };

  // ---------------------------------------------------------------- setup
  function showSetupMode(mode) {
    const home = $('#mode-home'), local = $('#local-config'), online = $('#online-config');
    if (home) home.classList.toggle('hidden', mode !== 'home');
    if (local) local.classList.toggle('hidden', mode !== 'local');
    if (online) online.classList.toggle('hidden', mode !== 'online');
    const hub = $('.setup-hub'); if (hub) hub.classList.toggle('config-open', mode !== 'home');
  }

  function buildSeats(n) {
    const seats = $('#seats');
    seats.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const def = i === 0 ? 'human' : (n === 2 ? 'ai' : (i === 1 ? 'ai' : 'human'));
      const div = document.createElement('div');
      div.className = 'seat';
      div.innerHTML =
        `<div class="pid" style="background-color:${SEAT_COLORS[i]};background-image:url(${seatAvatar(i)})" title="${SEAT_AVATARS[i]}"></div>
         <input type="text" value="训练家 ${i + 1}" maxlength="10" data-name="${i}">
         <select data-kind="${i}">
           <option value="human">真人</option>
           <option value="ai">电脑</option>
         </select>
         <select data-diff="${i}">
           <option value="hard">高手</option>
           <option value="ultra">究极(最强·搜索)</option>
           <option value="normal">普通</option>
           <option value="easy">新手</option>
           <option value="alphazero">AlphaZero(实验)</option>
         </select>`;
      seats.appendChild(div);
      $(`[data-kind="${i}"]`, div).value = def;
      const syncDiff = () => { $(`[data-diff="${i}"]`, div).style.display = $(`[data-kind="${i}"]`, div).value === 'ai' ? '' : 'none'; };
      $(`[data-kind="${i}"]`, div).addEventListener('change', syncDiff); syncDiff();
    }
  }

  function readConfig() {
    const n = +$('#player-count .active').dataset.n;
    const names = [], ai = [], diff = [];
    for (let i = 0; i < n; i++) {
      names.push($(`[data-name="${i}"]`).value.trim() || ('训练家 ' + (i + 1)));
      const isAI = $(`[data-kind="${i}"]`).value === 'ai';
      ai.push(isAI);
      diff.push($(`[data-diff="${i}"]`).value);
    }
    return { numPlayers: n, names, ai, diff };
  }

  // shared entry: drop into the game screen for a prebuilt game state `g`.
  function enterGame(g, opts) {
    opts = opts || {};
    G = g; gameEpoch++;                                 // invalidate any timers from a prior game
    UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: (opts.humans != null ? opts.humans : 1), hasAI: !!opts.hasAI };
    undoStack = [];
    $('#setup').classList.add('hidden');
    if ($('#rules-modal')) $('#rules-modal').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#win-modal').classList.add('hidden');
    render();
    beginTurn();
  }
  function backToSetup() {
    gameEpoch++; UI.busy = false;
    $('#game').classList.add('hidden');
    $('#win-modal').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    showSetupMode('home');
  }

  // ============================ online multiplayer ============================
  function openOnline(code, asHost) {
    code = (code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    if (!code || !window.Net) return;
    if (window.Tutorial && Tutorial.stop) Tutorial.stop();
    const name = (($('#online-name') && $('#online-name').value.trim()) || ($('[data-name="0"]') && $('[data-name="0"]').value.trim()) || '训练家');
    gameEpoch++;
    UI = { pick: [], selCard: null, selDeck: null, phase: 'main', busy: false, humans: 0, hasAI: false,
           net: { code, name, seat: null, host: !!asHost, status: 'connecting', started: false, roster: [], undoAvailable: false, undoVote: null } };
    try { history.replaceState(null, '', location.pathname + '?room=' + code); } catch (e) { }
    $('#setup').classList.add('hidden'); $('#game').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    $('#lobby-code').textContent = code;
    bindNet();
    Net.connect(code, name);
    renderLobby();
  }
  function bindNet() {
    Net.on('status', (s) => { if (UI.net) { UI.net.status = s; renderLobby(); } });
    Net.on('welcome', (m) => { if (UI.net) { UI.net.seat = m.seat; UI.net.host = m.host; renderLobby(); } });
    Net.on('roster', (m) => { if (UI.net) { UI.net.roster = m.players || []; UI.net.started = m.started; renderLobby(); } });
    Net.on('state', onNetState);
    Net.on('reject', (m) => { flashHint((m && m.reason) || '操作被拒绝'); });
    Net.on('undo-vote', (m) => {
      if (!UI.net) return;
      UI.net.undoVote = m;
      renderUndoVote(); updateUndoBtn();
      setLogOpen(true);
    });
    Net.on('undo-result', (m) => {
      if (!UI.net) return;
      UI.net.undoVote = null;
      renderUndoVote(); updateUndoBtn();
      flashHint((m && m.reason) || (m && m.accepted ? '悔棋成功' : '悔棋已取消'));
    });
    Net.on('over', () => { });
  }
  function renderLobby() {
    if (!UI.net) return;
    const statusZh = { connecting: '连接中…', connected: '已连接', disconnected: '已断开，重连中…' };
    const seatTxt = UI.net.seat == null ? '' : (UI.net.seat < 0 ? '（观战）' : `（你是 ${UI.net.seat + 1} 号位${UI.net.host ? ' · 房主' : ''}）`);
    const st = $('#lobby-status'); if (st) st.textContent = '状态：' + (statusZh[UI.net.status] || UI.net.status) + ' ' + seatTxt;
    const r = UI.net.roster || [];
    const rr = $('#lobby-roster');
    if (rr) rr.innerHTML = r.length
      ? r.map(p => `<div class="lr-row"><span class="lr-dot ${p.connected ? 'on' : 'off'}"></span>${p.seat + 1}. ${escapeHTML(p.name)}${p.seat === 0 ? ' 👑' : ''}${p.seat === UI.net.seat ? '（你）' : ''}</div>`).join('')
      : '<div class="muted">等待玩家加入…</div>';
    const start = $('#lobby-start');
    if (start) { start.style.display = UI.net.host ? '' : 'none'; start.disabled = !(r.length >= 2); }
    const mb = $('#lobby-megas'), pb = $('#lobby-pokemart');
    if (mb) mb.disabled = !UI.net.host;
    if (pb) pb.disabled = !UI.net.host;
    const te = $('#lobby-timeout-enabled'), tm = $('#lobby-timeout-ms');
    if (te) te.disabled = !UI.net.host;
    if (tm) tm.disabled = !UI.net.host || !te || !te.checked;
  }
  function leaveOnline() {
    stopIdleTimer();
    if (window.Net) Net.leave();
    UI.net = null; gameEpoch++;
    try { history.replaceState(null, '', location.pathname); } catch (e) { }
    $('#lobby').classList.add('hidden'); $('#game').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    showSetupMode('home');
  }
  // Apply an authoritative redacted snapshot from the server (server drives turns).
  function onNetState(m) {
    if (!m || !m.state || !UI.net) return;
    const st = m.state;
    const tokenMoves = UI.net.started ? captureNetworkTokenMoves(G, st) : [];
    const cardMoves = UI.net.started ? captureNetworkCardMoves(G, st) : [];
    st.cardDB = DB; st.byId = byId; st.megaDB = MEGA_DB; st.pokemartDB = POKEMART_DB; // reattach static refs
    if (!Array.isArray(st.log)) st.log = [];
    G = st; gameEpoch++;
    UI.net.started = true; UI.humans = G.numPlayers; UI.hasAI = false;
    // Idle-timeout clock: the server, not a browser, owns takeover.
    UI.net.turnStartedAt = m.turnStartedAt || 0;
    UI.net.serverNow = m.serverNow || 0;
    UI.net.turnTimeoutMs = Number.isFinite(m.turnTimeoutMs) && m.turnTimeoutMs > 0 ? m.turnTimeoutMs : 0;
    UI.net.undoAvailable = !!m.undoAvailable;
    UI.net.stateAt = Date.now();
    $('#setup').classList.add('hidden'); $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
    recomputeOnlinePhase();
    render();
    playNetworkTokenMoves(tokenMoves);
    playNetworkCardMoves(cardMoves);
    if (UI.net.turnTimeoutMs) startIdleTimer(); else stopIdleTimer();
    if (G.phase === 'gameover') showWin();
  }

  // ----- idle / disconnect → server AI takeover -----
  let idleTimer = null;
  function startIdleTimer() { if (!idleTimer) idleTimer = setInterval(idleTick, 1000); }
  function stopIdleTimer() { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } const ib = $('#idle-bar'); if (ib) ib.innerHTML = ''; }
  function idleMsLeft() {
    if (!UI.net || !UI.net.turnTimeoutMs) return Infinity;
    const idle = (UI.net.serverNow - UI.net.turnStartedAt) + (Date.now() - UI.net.stateAt);
    return UI.net.turnTimeoutMs - idle;
  }
  function activeConnected() {
    const r = (UI.net && UI.net.roster || []).find(p => p.seat === G.turn);
    return r ? r.connected : true;
  }
  function idleTick() {
    if (!isOnline() || !G || G.phase !== 'play') { stopIdleTimer(); return; }
    const ib = $('#idle-bar'); if (!ib) return;
    const msLeft = idleMsLeft();
    const secs = Math.max(0, Math.ceil(msLeft / 1000));
    const offline = !activeConnected();
    if (!myTurn()) {
      const visible = offline || msLeft < 90000;
      ib.innerHTML = visible ? `<span class="idle-wait" title="${offline ? '当前玩家已断线；' : ''}${secs} 秒后服务器 AI 将自动完成该回合">${offline ? '⚠' : '⏱'} ${secs}s 后 AI 接管</span>` : '';
    } else {
      ib.innerHTML = msLeft < 60000 ? `<span class="idle-warn" title="若未及时行动，服务器 AI 将自动完成你的回合">⏱ ${secs}s 后 AI 代打</span>` : '';
    }
  }
  // Derive the local UI phase from a snapshot. The board renders for everyone, but
  // you can only act on your own turn (interactable() also gates on myTurn()).
  function recomputeOnlinePhase() {
    UI.busy = false; UI.pick = []; UI.selCard = UI.selDeck = null;
    if (G.phase !== 'play' || !myTurn()) { UI.phase = 'main'; return; }
    if (E.needsDiscard(G, me())) { UI.phase = 'discard'; return; }
    if (!G.acted) { UI.phase = 'main'; return; }
    const ev = E.evolutionOptions(G, me());
    const mev = G.megasEnabled ? E.megaEvolveOptions(G, me()) : [];
    if (ev.length || mev.length) { UI.phase = 'evolve'; return; }
    UI.phase = 'main';
    Net.action({ type: 'endTurn' });   // acted with nothing left to resolve → end the turn
  }
  function startGame() {
    const cfg = readConfig();
    const megas = !!($('#opt-megas') && $('#opt-megas').checked) && MEGA_DB.length > 0;
    const pokemart = !!($('#opt-pokemart') && $('#opt-pokemart').checked) && POKEMART_DB.length > 0;
    const g = E.createGame(DB, { numPlayers: cfg.numPlayers, names: cfg.names, ai: cfg.ai, megas, megaDB: MEGA_DB, pokemart, pokemartDB: POKEMART_DB });
    g.players.forEach((p, i) => { p.diff = cfg.diff[i]; });
    if (cfg.diff.indexOf('alphazero') >= 0) loadPolicy();
    enterGame(g, { humans: cfg.ai.filter(x => !x).length, hasAI: cfg.ai.some(x => x) });
  }

  // ---------- local autosave: survive a refresh / re-open (single device) ----------
  // The whole game lives in the JSON-serializable G (players carry name/isAI/diff),
  // so we snapshot G to localStorage at each turn boundary and offer to resume it on
  // the next load. Static card refs are dropped here and re-attached on restore.
  // Saved at beginTurn() only (acted===false) so a resume always lands on a clean
  // turn start, never a half-finished action. Cleared on game-over / quit-to-menu.
  const SAVE_KEY = 'pkmn_splendor_save_v1';
  const inTutorial = () => !!(window.Tutorial && Tutorial.active && Tutorial.active());
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
    const b = document.getElementById('resume-banner'); if (b) b.remove(); // drop a now-stale banner
  }
  function autosave() {
    try {
      if (!G || inTutorial() || G.phase !== 'play') return;
      const { cardDB, byId: _b, megaDB, pokemartDB, ...dyn } = G; // drop shared static refs
      localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, ts: Date.now(), g: dyn }));
    } catch (e) { /* storage full/disabled → game still works, just no resume */ }
  }
  function loadSave() {
    try { const o = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return (o && o.v === 1 && o.g) ? o : null; }
    catch (e) { return null; }
  }
  function resumeSaved() {
    const o = loadSave(); if (!o) return false;
    const g = Object.assign({}, o.g);
    g.cardDB = DB; g.byId = byId; g.megaDB = MEGA_DB; g.pokemartDB = POKEMART_DB; // re-attach statics
    if (!Array.isArray(g.log)) g.log = [];
    enterGame(g, { humans: g.players.filter(p => !p.isAI).length, hasAI: g.players.some(p => p.isAI) });
    return true;
  }
  // On the setup screen, surface a "continue last game" banner when a save exists.
  function offerResume() {
    const o = loadSave(); if (!o) return;
    if ($('#resume-banner')) return;
    const g = o.g, seat = (g.players && g.players[g.turn]) ? g.players[g.turn].name : '';
    const vp = (g.players || []).map(p => p.name + ' ' + (p.board || []).reduce((a, id) => a + ((byId[id] && byId[id].vp) || 0), 0) + '分').join(' · ');
    const when = o.ts ? new Date(o.ts).toLocaleString('zh-CN', { hour12: false }) : '';
    const div = document.createElement('div');
    div.id = 'resume-banner'; div.className = 'resume-banner';
    div.innerHTML = `<div class="rb-text">发现未完成的对局${seat ? `，轮到 <b>${escapeHTML(seat)}</b>` : ''}` +
      `${vp ? `<br><small>${escapeHTML(vp)}</small>` : ''}${when ? `<br><small class="rb-when">${escapeHTML(when)}</small>` : ''}</div>` +
      `<div class="rb-btns"><button id="resume-btn" class="primary">▶ 继续上一局</button>` +
      `<button id="resume-discard" class="ghost">放弃</button></div>`;
    const card = $('.setup-card'), tagline = card && card.querySelector('.tagline');
    if (tagline) card.insertBefore(div, tagline.nextSibling);
    else if (card) card.insertBefore(div, card.firstChild);
    else $('#setup').appendChild(div);
    $('#resume-btn').addEventListener('click', resumeSaved);
    $('#resume-discard').addEventListener('click', () => { clearSave(); div.remove(); });
  }

  // ---------------------------------------------------------------- helpers
  // online play: when in a network game, "me" is the local SEAT (which may not be
  // the active player), and you can only act on your own turn. Local play unchanged.
  function isOnline() { return !!(UI && UI.net); }
  function onlineSeat() { return (UI && UI.net && UI.net.seat != null) ? UI.net.seat : -1; }
  function myTurn() { return !!(G && G.turn === onlineSeat()); }
  const me = () => G.players[(isOnline() && UI.net.seat >= 0) ? UI.net.seat : G.turn];
  const isHuman = (pid) => !G.players[pid].isAI;
  const ball = (color, cls, label) =>
    `<div class="ball ${color} ${cls || ''}" title="${BALL_NAMES[color]}">${label != null ? '' : ''}</div>`;

  // opts.aff: null | { master } from affordInfo(). master>0 still gets a
  // distinct affordable outline; the exact Master Ball cost belongs in the
  // transaction dock, not on top of the card art.
  function cardHTML(id, opts) {
    opts = opts || {};
    const c = byId[id];
    if (!c) return `<div class="card"><div class="empty-slot">—</div></div>`;
    const aff = opts.aff;
    let cls = '';
    if (aff) {
      cls = aff.master > 0 ? ' affordable affordable-wild' : ' affordable';
    }
    const sel = (UI.selCard === id) ? ' selected' : '';
    return `<div class="card${cls}${sel}" data-card="${id}" data-zoom="${c.img}">
              <img src="${c.img}" alt="${c.name}" loading="lazy">
            </div>`;
  }

  // ---------------------------------------------------------------- render
  function render() {
    renderBanner(); renderField(); renderSupply(); renderActionBar(); renderPlayers(); renderLog();
    updateUndoBtn();   // keep 悔棋 button consistent with phase/turn on every state change
    evalRotateHint();  // show/hide the portrait "rotate" hint
    if (G && G.phase === 'gameover') clearSave();   // finished game → nothing to resume
    if (window.Tutorial && Tutorial.onRender) { try { Tutorial.onRender(G, UI); } catch (e) { } } // drive the tutorial coach
  }

  function renderBanner() {
    const p = isOnline() ? G.players[G.turn] : me();
    let state = 'turn-wait';
    if (G.phase === 'gameover') {
      state = 'turn-over';
    } else if (p.isAI) {
      state = 'turn-ai';
    } else if (isOnline() && myTurn()) {
      state = 'turn-mine';
    } else if (!isOnline()) {
      state = 'turn-mine';
    }
    $('#topbar').className = state;
  }

  function renderField() {
    const wrap = $('#field');
    wrap.innerHTML = '';
    const human = (isOnline() ? myTurn() : isHuman(G.turn)) && G.phase === 'play';
    // Megas expansion: a face-up "Mega 卡" row (zoom only; you mega-evolve at end of turn)
    if (G.megasEnabled && G.megaOffer.length) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tier-row tier-special tier-mega';
      let inner = `<div class="tier-label">Mega</div><div class="card-strip">`;
      const canMega = human && UI.phase === 'main' && me().megaToken >= 1;
      for (const id of G.megaOffer) {
        const c = byId[id];
        const canBuy = canMega && me().board.some(b => byId[b].name === c.megaFrom);
        inner += cardHTML(id, { aff: canBuy ? affordInfo(c) : null });
      }
      inner += '</div>';
      rowEl.innerHTML = inner;
      wrap.appendChild(rowEl);
    }
    const rows = [
      { tiers: ['legend', 'rare'], special: true },
      { tiers: ['stage3'] }, { tiers: ['stage2'] }, { tiers: ['stage1'] },
    ];
    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tier-row' + (row.special ? ' tier-special' : '');
      let inner = `<div class="tier-label">${row.tiers.map(t => TIER_NAMES[t]).join('/')}</div>`;
      for (const tier of row.tiers) {
        const deckN = G.decks[tier].length;
        const canReserveDeck = human && UI.phase === 'main' && E.NORMAL_TIERS.includes(tier) && deckN > 0 && me().reserve.length < E.HAND_MAX && !G.acted;
        inner += `<div class="deck-pile ${canReserveDeck ? 'reservable' : ''}" data-tier="${tier}" ${canReserveDeck ? `data-deck="${tier}"` : ''}>
                    <div class="count">${deckN}</div><div class="deck-tag">${TIER_NAMES[tier]}牌堆</div></div>`;
        inner += '<div class="card-strip">';
        for (const id of G.field[tier]) {
          if (!id) { inner += `<div class="card"><div class="empty-slot">—</div></div>`; continue; }
          const c = byId[id];
          const aff = (human && UI.phase === 'main' && !G.acted) ? affordInfo(c) : null;
          const canReserve = human && UI.phase === 'main' && !G.acted && E.NORMAL_TIERS.includes(tier) && me().reserve.length < E.HAND_MAX;
          inner += cardHTML(id, { aff, canReserve });
        }
        inner += '</div>';
      }
      rowEl.innerHTML = inner;
      wrap.appendChild(rowEl);
    }
    // Pokémart expansion: 2 shop cards per level, shown high→low like the base rows.
    if (G.pokemartEnabled) {
      for (const tier of ['pmL3', 'pmL2', 'pmL1']) {
        const rowEl = document.createElement('div');
        rowEl.className = 'tier-row tier-pokemart';
        const deckN = G.decks[tier].length;
        const canReserveDeck = human && UI.phase === 'main' && deckN > 0 && me().reserve.length < E.HAND_MAX && !G.acted;
        let inner = `<div class="tier-label">${TIER_NAMES[tier]}</div>`;
        inner += `<div class="deck-pile ${canReserveDeck ? 'reservable' : ''}" data-tier="${tier}" ${canReserveDeck ? `data-deck="${tier}"` : ''}>
                    <div class="count">${deckN}</div><div class="deck-tag">商店牌堆</div></div>`;
        inner += '<div class="card-strip">';
        for (const id of G.field[tier]) {
          if (!id) { inner += `<div class="card"><div class="empty-slot">—</div></div>`; continue; }
          const c = byId[id];
          const aff = (human && UI.phase === 'main' && !G.acted) ? affordInfo(c) : null;
          const canReserve = human && UI.phase === 'main' && !G.acted && me().reserve.length < E.HAND_MAX;
          inner += cardHTML(id, { aff, canReserve });
        }
        inner += '</div>';
        rowEl.innerHTML = inner;
        wrap.appendChild(rowEl);
      }
    }
  }

  // Can the active human acquire this card right now (effect-aware)? Returns null if
  // not acquirable, else { master } where master = how many Master Balls (百搭) the
  // purchase would actually spend (0 = buyable with coloured balls alone). Drives both
  // the 捕捉 button and the green (free) vs purple (needs-wildcard) highlight.
  function affordInfo(card) {
    const p = me();
    if (E.isPokemart(card) && card.effect === 'discard_buy') {
      const col = card.effectParam.discardColor, n = card.effectParam.discardCount;
      return p.board.filter(id => E.effBonusColor(G, p, id) === col).length >= n ? { master: 0 } : null;
    }
    if (E.isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')) {
      if (!p.board.some(id => E.effBonusColor(G, p, id))) return null; // needs a bonus card to copy
    }
    const pay = E.computePayment(G, p, card);
    if (pay.ok) return { master: pay.pay.purple };
    // otherwise see if discarding owned POKÉDEX (2 virtual master each) would cover it
    const dex = p.board.filter(id => E.isPokemart(byId[id]) && byId[id].effect === 'colorless_master').length;
    for (let k = 1; k <= dex; k++) { const pp = E.computePayment(G, p, card, k * 2); if (pp.ok) return { master: pp.pay.purple, pokedex: k }; }
    return null;
  }
  const captureAffordable = (card) => !!affordInfo(card);

  // Compact capture trade. Each printed colour becomes one round token:
  // lower-left = printed/discounted, lower-right = balance after the trade,
  // upper-right = real Master Balls substituted for this colour.
  function purchaseLedgerHTML(card, info) {
    // Repel (discard_buy) is captured by discarding cards, not balls.
    if (E.isPokemart(card) && card.effect === 'discard_buy') return '';
    const p = me();
    const b = E.bonuses(G, p);
    const virtual = info && info.pokedex ? info.pokedex * 2 : 0;
    const mandatory = card.cost.purple || 0;
    let virtualLeft = virtual;
    let realMasterLeft = p.tokens.purple;
    let realMasterSpent = 0;
    const tokens = [];

    const coverWithMaster = (amount) => {
      const virtualUsed = Math.min(amount, virtualLeft);
      virtualLeft -= virtualUsed;
      amount -= virtualUsed;
      const realUsed = Math.min(amount, realMasterLeft);
      realMasterLeft -= realUsed;
      realMasterSpent += realUsed;
      return { realUsed, uncovered: amount - realUsed };
    };

    const mandatoryCover = coverWithMaster(mandatory);

    for (const c of E.COLORS) {
      const required = card.cost[c] || 0;
      if (!required) continue;
      const due = Math.max(0, required - b[c]);
      const paidColor = Math.min(due, p.tokens[c]);
      const master = coverWithMaster(due - paidColor);
      const uncovered = master.uncovered;
      const after = p.tokens[c] - paidColor - uncovered;
      tokens.push({ color: c, required, due, after, paidWild: master.realUsed });
    }
    if (!tokens.length && !mandatory) return '';

    if (mandatory) {
      tokens.push({
        color: 'purple', required: mandatory, due: mandatory,
        after: p.tokens.purple - realMasterSpent - mandatoryCover.uncovered,
        paidWild: mandatoryCover.realUsed,
      });
    }

    const tokenHTML = (r) => {
      const name = BALL_NAMES[r.color];
      const neg = r.after < 0;
      const assist = r.paidWild ? `<span class="pay-token-master">★${r.paidWild}</span>` : '';
      return `<div class="pay-token ${r.color}${neg ? ' negative' : ''}" aria-label="${name}，原需 ${r.required}，折后 ${r.due}，交易后剩余 ${r.after}${r.paidWild ? `，使用 ${r.paidWild} 个大师球` : ''}">
          <span class="pay-token-art"><span class="ball ${r.color}"></span></span>
          <span class="pay-metric pay-cost"><b>${r.required}</b><i>/</i><b>${r.due}</b></span>
          <span class="pay-metric pay-after${neg ? ' negative' : ''}"><small>余</small><b>${r.after}</b></span>
          ${assist}<span class="pay-token-tooltip">${name}</span>
        </div>`;
    };

    return `<div class="pay-ledger${info ? '' : ' unafford'}"><div class="pay-token-list">${tokens.map(tokenHTML).join('')}</div></div>`;
  }

  function renderSupply() {
    const counts = {}; UI.pick.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const human = (isOnline() ? myTurn() : isHuman(G.turn)) && G.phase === 'play' && UI.phase === 'main' && !G.acted;
    const quickActions = UI.pick.length
      ? `<span class="supply-quick-actions"><button type="button" class="supply-cancel" data-supply-clear aria-label="取消选择" title="取消选择">×</button><button type="button" class="supply-confirm" data-supply-confirm aria-label="确认领取" title="确认领取" ${takeSelectionComplete() ? '' : 'disabled'}>✓</button></span>`
      : human
        ? '<span class="supply-control-hints" aria-label="左键领取，右键归还"><span><i class="mouse-key mouse-left" aria-hidden="true"></i>领取</span><span><i class="mouse-key mouse-right" aria-hidden="true"></i>归还</span></span>'
        : '<small>当前库存</small>';
    let html = `<div class="panel-title"><span>领取精灵球</span>${quickActions}</div>`;
    for (const color of E.ALL_TOKENS) {
      const isMaster = color === 'purple';
      const pick = counts[color] || 0;
      const selectable = human && !isMaster && canAddBall(color);
      const dis = (!human || isMaster || (!selectable && !pick)) ? ' disabled' : '';
      const stack = Array.from({ length: Math.min(3, Math.max(0, G.supply[color] - 1)) }, () => `<span class="supply-disc supply-stack-token"><span class="ball ${color}"></span></span>`).join('');
      html += `<button type="button" class="supply-row${pick ? ' picked' : ''}${dis}" data-supply-color="${color}" ${(!isMaster) ? `data-color="${color}"` : ''} ${(!selectable && !pick) ? 'disabled' : ''} aria-label="${BALL_NAMES[color]}，库存 ${G.supply[color]}${pick ? `，已选 ${pick}` : ''}">
                 <span class="supply-stack" aria-hidden="true">${stack}</span>
                 <span class="supply-disc supply-main-disc">${ball(color, '')}</span>
                 <span class="supply-tooltip" role="tooltip">${BALL_NAMES[color]}${pick ? ' · 右键归还' : ''}</span>
                 ${pick ? `<span class="picked-n">✓ ${pick}</span>` : ''}
                 <span class="cnt">${G.supply[color]}</span>
               </button>`;
    }
    if (G.megasEnabled) {
      const canTake = human && me().megaToken < 1 && G.supply.megaToken > 0;
      const held = me().megaToken;
      html += `<button type="button" class="supply-row mega-row${canTake ? '' : ' disabled'}" data-supply-color="mega" ${canTake ? 'data-take-mega="1"' : 'disabled'} aria-label="Mega 代币，库存 ${G.supply.megaToken}；花费整个回合获得 1 个">
                 <span class="supply-disc supply-main-disc"><span class="ball mega-token"></span></span>
                 <span class="supply-tooltip" role="tooltip">Mega 代币${held ? '（已持有）' : ''}</span>
                 <span class="cnt">${G.supply.megaToken}</span>
               </button>`;
    }
    const supply = $('#supply');
    supply.classList.toggle('has-pick', UI.pick.length > 0);
    supply.innerHTML = html;
  }

  function canAddBall(color) {
    if (G.supply[color] <= 0) return false;
    const counts = {}; UI.pick.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const distinct = Object.keys(counts);
    if (UI.pick.length === 0) return true;
    if (distinct.length === 1 && counts[distinct[0]] === 2) return false;     // already a pair
    if (distinct.length === 1 && counts[distinct[0]] === 1) {
      if (color === distinct[0]) return G.supply[color] >= 4;                 // make a pair
      return UI.pick.length < 3 && G.supply[color] > 0;                       // add distinct
    }
    return UI.pick.length < 3 && !counts[color] && G.supply[color] > 0;       // add 3rd distinct
  }

  function takeSelectionComplete() {
    if (!G || !UI.pick.length) return false;
    const distinct = new Set(UI.pick);
    if (UI.pick.length === 2 && distinct.size === 1) return G.supply[UI.pick[0]] >= 4;
    const available = E.COLORS.filter(color => G.supply[color] > 0).length;
    return distinct.size === UI.pick.length && UI.pick.length === Math.min(3, available);
  }

  function captureBlockedReason(card) {
    const p = me();
    if (E.isPokemart(card) && card.effect === 'discard_buy') {
      const color = card.effectParam.discardColor;
      const need = card.effectParam.discardCount;
      const owned = p.board.filter(id => E.effBonusColor(G, p, id) === color).length;
      return `需要弃掉 ${need} 张${BALL_NAMES[color]}奖励卡，当前只有 ${owned} 张`;
    }
    if (E.isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')
      && !p.board.some(id => E.effBonusColor(G, p, id))) {
      return '需要先捕捉至少一只带奖励颜色的宝可梦';
    }
    const bonuses = E.bonuses(G, p);
    const deficits = E.COLORS.map(color => ({
      color,
      count: Math.max(0, (card.cost[color] || 0) - bonuses[color] - p.tokens[color]),
    })).filter(item => item.count > 0);
    const mandatory = card.cost.purple || 0;
    const dex = p.board.filter(id => E.isPokemart(byId[id]) && byId[id].effect === 'colorless_master').length;
    const availableMaster = p.tokens.purple + dex * 2;
    const masterNeed = mandatory + deficits.reduce((sum, item) => sum + item.count, 0);
    if (mandatory > availableMaster) return `需要 ${mandatory} 个大师球，当前可用 ${availableMaster} 个`;
    if (masterNeed > availableMaster) {
      const missing = deficits.map(item => `${item.count} 个${BALL_NAMES[item.color]}`).join('、');
      return `缺少 ${missing}，大师球也不足以替代`;
    }
    return '当前不满足这张卡的捕捉条件';
  }

  function reserveBlockedReason(card, loc, player) {
    if (loc.where === 'reserve') return '这只宝可梦已经在预留区';
    if (!(loc.where === 'field' && (E.NORMAL_TIERS.includes(loc.tier) || E.PM_TIERS.includes(loc.tier)))) {
      return `${TIER_NAMES[card.tier] || '这类'}宝可梦不能预留`;
    }
    if (player.reserve.length >= E.HAND_MAX) return `预留区已满（最多 ${E.HAND_MAX} 张）`;
    return '当前不能预留这只宝可梦';
  }

  function renderActionBar() {
    const bar = $('#action-bar');
    const idle = () => { bar.innerHTML = ''; bar.classList.add('action-idle'); };
    bar.classList.remove('action-idle', 'action-card');
    if (G.phase === 'gameover') { idle(); return; }
    const p = me();
    if (p.isAI) { idle(); return; }
    if (isOnline() && !myTurn()) { idle(); return; }

    if (UI.phase === 'discard') {
      const over = E.tokenTotal(p) - E.TOKEN_MAX;
      let tray = E.ALL_TOKENS.filter(c => p.tokens[c] > 0)
        .map(c => `<button type="button" class="discard-token ${c}" data-discard="${c}" aria-label="归还一个${BALL_NAMES[c]}，当前持有 ${p.tokens[c]}">
            <span class="discard-token-art">${ball(c, '')}</span>
            <span class="discard-token-count">${p.tokens[c]}</span>
            <span class="discard-token-minus">−1</span>
            <span class="discard-token-tooltip">${BALL_NAMES[c]}</span>
          </button>`).join('');
      bar.innerHTML = `<div class="discard-head">
          <span class="discard-mark" aria-hidden="true">↙</span>
          <span class="discard-copy"><small>精灵球达到上限</small><strong>归还 ${over} 个</strong></span>
          <span class="discard-total">${E.tokenTotal(p)}<small>/${E.TOKEN_MAX}</small></span>
        </div><div class="discard-token-list">${tray}</div>`;
      return;
    }
    if (UI.phase === 'evolve') {
      const opts = dedupeEvo(E.evolutionOptions(G, p));
      let html = '<div class="act-hint">回合结束 · 可进化一只宝可梦（可选，每回合至多1次）：</div>';
      for (const o of opts) {
        const from = byId[o.fromId], to = byId[o.toId];
        html += `<button class="evo-option" data-evo-from="${o.fromId}" data-evo-to="${o.toId}">
                   <b>${from.name}</b> → <b>${to.name}</b>（+${to.vp - from.vp}分，需 ${o.count} 个${BALL_NAMES[o.color]}折扣）
                 </button>`;
      }
      const mopts = G.megasEnabled ? E.megaEvolveOptions(G, p) : [];
      for (const o of mopts) {
        const from = byId[o.fromId], mega = byId[o.megaId];
        const costStr = E.ALL_TOKENS.filter(k => mega.cost[k] > 0).map(k => `${mega.cost[k]}${BALL_NAMES[k]}`).join('+');
        html += `<button class="evo-option mega-evo" data-mega="${o.megaId}" data-mega-from="${o.fromId}">
                   ⚡<b>${from.name}</b> → <b>${mega.name}</b>（+${mega.vp - from.vp}分，付 ${costStr}，耗1 Mega代币）
                 </button>`;
      }
      html += `<div class="act-buttons"><button class="primary" data-act="end-turn">不进化，结束回合</button></div>`;
      bar.innerHTML = html;
      return;
    }
    // main phase
    if (UI.pick.length) { idle(); return; }
    if (UI.selCard) {
      bar.classList.add('action-card');
      const c = byId[UI.selCard];
      const info = affordInfo(c);
      const aff = !!info;
      const loc = E.locateCard(G, UI.selCard);
      const reserveTier = (loc.where === 'field') && (E.NORMAL_TIERS.includes(loc.tier) || E.PM_TIERS.includes(loc.tier));
      const canReserve = reserveTier && p.reserve.length < E.HAND_MAX;
      let ledger = purchaseLedgerHTML(c, info);
      const captureReason = aff ? '' : captureBlockedReason(c);
      const reserveReason = canReserve ? '' : reserveBlockedReason(c, loc, p);
      let html = `${ledger}<div class="act-buttons capture-actions">
        <span class="action-control${captureReason ? ' has-reason' : ''}" ${captureReason ? `data-tip="${escapeHTML(captureReason)}" tabindex="0" aria-label="无法捕捉：${escapeHTML(captureReason)}"` : ''}><button class="primary" data-act="capture" ${aff ? '' : 'disabled'}>捕捉</button></span>
        <span class="action-control${reserveReason ? ' has-reason' : ''}" ${reserveReason ? `data-tip="${escapeHTML(reserveReason)}" tabindex="0" aria-label="无法预留：${escapeHTML(reserveReason)}"` : ''}><button class="reserve-action" data-act="reserve-card" ${canReserve ? '' : 'disabled'}><span aria-hidden="true">◇</span> 预留</button></span>
        <span class="action-control"><button class="ghost" data-act="clear-sel">取消</button></span>
      </div>`;
      bar.innerHTML = html;
      return;
    }
    if (UI.selDeck) {
      bar.innerHTML = `<div class="act-hint">预留 <b>${TIER_NAMES[UI.selDeck]}</b> 牌堆顶的宝可梦（获得1个大师球）？</div>
        <div class="act-buttons"><button class="reserve-action" data-act="reserve-deck"><span aria-hidden="true">◇</span> 预留牌堆顶</button><button class="ghost" data-act="clear-sel">取消</button></div>`;
      return;
    }
    idle();
  }

  function dedupeEvo(opts) {
    // collapse to best target per fromId (highest VP target) for a tidy list
    const best = {};
    for (const o of opts) {
      const v = byId[o.toId].vp;
      if (!best[o.fromId] || v > byId[best[o.fromId].toId].vp) best[o.fromId] = o;
    }
    return Object.values(best);
  }

  function renderPlayers() {
    const wrap = $('#players');
    wrap.innerHTML = '';
    for (let i = 0; i < G.numPlayers; i++) {
      const p = G.players[i];
      const b = E.bonuses(G, p);
      const tot = E.tokenTotal(p);                // total Poké Balls held (10 max at turn end)
      const active = (i === G.turn && G.phase === 'play');
      const mine = isOnline() ? i === onlineSeat() : active && !p.isAI;
      let turnStatus = '';
      if (active) {
        if (p.isAI) turnStatus = '思考中…';
        else if (!mine && isOnline()) turnStatus = '正在行动';
        else if (UI.phase === 'discard') turnStatus = '正在归还精灵球';
        else if (UI.phase === 'evolve') turnStatus = '正在进化';
        else if (UI.pick.length) turnStatus = '正在领取精灵球';
        else if (UI.selDeck) turnStatus = '正在预留牌堆';
        else if (UI.selCard) turnStatus = '正在处理宝可梦';
        else if (G.acted) turnStatus = '正在结算回合';
        else turnStatus = mine ? '你的回合' : '当前回合';
        if (G.lastRound) turnStatus += ' · 最后一轮';
      }
      const el = document.createElement('div');
      el.className = 'player' + (active ? ' active' : '') + (mine ? ' mine' : '') + (p.isAI ? ' ai' : '');
      el.dataset.player = i;
      // bonus + token chips
      let chips = `<div class="ptokens${tot > E.TOKEN_MAX ? ' over' : tot === E.TOKEN_MAX ? ' full' : ''}" title="持有的精灵球总数（回合结束上限 ${E.TOKEN_MAX} 个）" aria-label="共持有 ${tot} 个精灵球，上限 ${E.TOKEN_MAX} 个"><span class="pt-lbl">球</span><strong>${tot}</strong><small>/${E.TOKEN_MAX}</small></div>`;
      for (const c of E.COLORS) {
        chips += `<div class="trainer-token" data-token-color="${c}" title="${BALL_NAMES[c]}：持有 ${p.tokens[c]}，永久折扣 ${b[c]}" aria-label="${BALL_NAMES[c]}，持有 ${p.tokens[c]}，永久折扣 ${b[c]}">${ball(c, '')}<span class="trainer-token-count">${p.tokens[c]}</span><span class="trainer-token-bonus">+${b[c]}</span></div>`;
      }
      chips += `<div class="trainer-token" data-token-color="purple" title="${BALL_NAMES.purple}：持有 ${p.tokens.purple}" aria-label="${BALL_NAMES.purple}，持有 ${p.tokens.purple}">${ball('purple', '')}<span class="trainer-token-count">${p.tokens.purple}</span></div>`;
      // captured cards grouped by effective bonus color (Pokémart copy cards take
      // their associated colour; effect cards with no colour go in a final group).
      let stacks = '';
      const groups = E.COLORS.map(c => ({ key: c, ids: p.board.filter(id => E.effBonusColor(G, p, id) === c) }));
      groups.push({ key: null, ids: p.board.filter(id => E.effBonusColor(G, p, id) === null) });
      for (const g of groups) {
        if (!g.ids.length) continue;
        let st = '';
        g.ids.forEach((id, idx) => {
          st += `<div class="mini-card${idx ? ' stacked' : ''}" data-captured-card="${id}" data-zoom="${byId[id].img}"><img src="${byId[id].img}" alt=""></div>`;
        });
        stacks += `<div class="color-stack"><div class="ministack">${st}</div></div>`;
      }
      // reserve: revealed only for YOUR OWN hand; others show card-backs.
      // (online, opponents' reserves arrive as {hidden,tier} stubs, never real ids.)
      const revealReserve = !p.isAI && (isOnline() ? (i === onlineSeat()) : active);
      let rz = '';
      if (p.reserve.length) {
        const cards = p.reserve.map((rid, slot) => {
          const stub = (rid && typeof rid === 'object');
          const realId = stub ? null : rid;
          const tier = stub ? rid.tier : byId[realId].tier;
          if (revealReserve && !stub) return `<div class="mini-card${UI.selCard === realId ? ' selected' : ''}" data-reserved-slot="${slot}" data-reserved-card="${realId}" data-zoom="${byId[realId].img}" data-reserve-capture="${realId}"><img src="${byId[realId].img}"></div>`;
          return `<div class="mini-card card-back" data-reserved-slot="${slot}" data-tier="${tier}"></div>`;
        }).join('');
        rz = `<div class="reserve-zone" data-reserve-zone><div class="rz-title">预留区 (${p.reserve.length})</div><div class="pcards">${cards}</div></div>`;
      }
      el.innerHTML =
        `<div class="player-head">
           <div class="pavatar" style="background-color:${SEAT_COLORS[i]};background-image:url(${seatAvatar(i)});box-shadow:0 0 0 2px ${SEAT_COLORS[i]}"></div>
           <div class="player-heading"><div class="pname">${escapeHTML(p.name)}${mine ? '<span class="player-me">你</span>' : ''}</div>${turnStatus ? `<div class="player-turn-status">${escapeHTML(turnStatus)}</div>` : ''}</div>
           <div class="pscore">${E.scoreOf(G, p)}<small>/${G.megasEnabled ? E.MEGA_WIN_SCORE : E.WIN_SCORE}</small></div>
         </div>
         ${p.buried.length ? `<div class="buried-badge">已进化 ${p.buried.length}</div>` : ''}
         <div class="player-body">
           <div class="player-assets">
             <div class="pstats">${chips}</div>
             <div class="pcards capture-zone" data-capture-zone>${stacks || '<span style="color:var(--muted);font-size:12px">尚无宝可梦</span>'}</div>
           </div>
           ${rz}
         </div>`;
      wrap.appendChild(el);
    }
  }

  function renderLog() {
    const lines = G.log.slice(-40).map(l => {
      // Normalize older saves so the activity feed uses the current vocabulary too.
      const message = String(l.msg || '')
        .replaceAll('保留区', '预留区').replaceAll('签约区', '预留区')
        .replaceAll('保留', '预留').replaceAll('签约', '预留')
        .replaceAll('拿取', '领取');

      if (l.kind === 'take' && Array.isArray(l.colors)) {
        const marker = '领取';
        const markerAt = message.indexOf(marker);
        const lead = markerAt >= 0 ? message.slice(0, markerAt + marker.length) : message;
        const icons = l.colors.filter(c => E.ALL_TOKENS.includes(c)).map((color, index) =>
          `${index ? '<span class="log-icon-sep">、</span>' : ''}<span class="log-thumb ball-thumb ball ${color}" title="${BALL_NAMES[color]}" aria-label="${BALL_NAMES[color]}"></span>`
        ).join('');
        return `<div class="ln log-inline"><span>${escapeHTML(lead)}</span><span class="log-thumbs">${icons}</span></div>`;
      }

      if (l.kind === 'capture' && byId[l.cardId]) {
        const card = byId[l.cardId];
        const nameAt = message.indexOf(card.name);
        if (nameAt >= 0) {
          const lead = message.slice(0, nameAt);
          const tail = message.slice(nameAt + card.name.length);
          return `<div class="ln log-inline"><span>${escapeHTML(lead)}</span><span class="log-thumbs"><img class="log-thumb" src="${card.img}" alt="" title="${escapeHTML(card.name)}" data-zoom="${card.img}"></span><span>${escapeHTML(tail)}</span></div>`;
        }
      }

      return `<div class="ln"><span>${escapeHTML(message)}</span></div>`;
    }).join('');
    const box = $('#log-lines'); box.innerHTML = lines || '<div class="log-empty">行动后，记录会出现在这里。</div>'; box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- interactions
  function onSupplyClick(color) {
    if (!interactable()) return;
    if (canAddBall(color)) { UI.pick.push(color); UI.selCard = UI.selDeck = null; render(); }
  }
  function onSupplyReturn(color) {
    if (!interactable()) return;
    const index = UI.pick.lastIndexOf(color);
    if (index < 0) return;
    UI.pick.splice(index, 1);
    render();
  }
  function onCardClick(id) {
    if (!interactable()) return;
    if (byId[id] && byId[id].tier === 'mega') return; // Mega cards: zoom only; evolve at end of turn
    if (UI.selCard === id) { openInspect(byId[id].img); return; }
    const hadBallSelection = UI.pick.length > 0;
    UI.pick = []; UI.selCard = id; UI.selDeck = null;
    if (hadBallSelection) render(); else { renderField(); renderActionBar(); renderPlayers(); }
  }
  function onDeckClick(tier) {
    if (!G || !G.decks || !Array.isArray(G.decks[tier])) return;
    if (!E.NORMAL_TIERS.includes(tier)) { flashHint('传说与稀有牌堆不能预留'); return; }
    if (!G.decks[tier].length) { flashHint('这个牌堆已经空了'); return; }
    if (me().reserve.length >= E.HAND_MAX) { flashHint(`预留区已满（最多 ${E.HAND_MAX} 张）`); return; }
    if (!interactable()) {
      if (isOnline() && !myTurn()) flashHint('尚未轮到你');
      else if (G.acted) flashHint('本回合已经行动');
      else flashHint('当前不能预留牌堆顶');
      return;
    }
    UI.pick = []; UI.selDeck = tier; UI.selCard = null; render();
  }
  function interactable() { return G && G.phase === 'play' && UI.phase === 'main' && !G.acted && !me().isAI && !UI.busy && (!isOnline() || (myTurn() && !UI.net.undoVote)); }

  // ---------------------------------------------------------------- animations
  const ANIM_MS = 620;
  function captureNetworkCardMoves(previous, next) {
    if (!previous || !next || !Array.isArray(previous.players) || !Array.isArray(next.players)) return [];
    const pid = previous.turn;
    const before = previous.players[pid], after = next.players[pid];
    if (!before || !after) return [];
    const moves = [];
    const beforeBoard = new Set(before.board || []);
    const addedBoard = (after.board || []).filter(id => !beforeBoard.has(id));
    for (const cardId of addedBoard) {
      const reserveSlot = (before.reserve || []).findIndex(id => id === cardId);
      const source = reserveSlot >= 0
        ? $(`.player[data-player="${pid}"] [data-reserved-slot="${reserveSlot}"]`)
        : $(`.card[data-card="${cardId}"]`);
      const card = byId[cardId];
      moves.push({ type: 'capture', pid, cardId, img: card ? card.img : null, tier: card ? card.tier : null, rect: source ? source.getBoundingClientRect() : null });
    }
    const beforeReserveN = (before.reserve || []).length;
    const afterReserve = after.reserve || [];
    if (afterReserve.length > beforeReserveN) {
      const allBoards = new Set(next.players.flatMap(p => p.board || []));
      for (let slot = beforeReserveN; slot < afterReserve.length; slot++) {
        const value = afterReserve[slot];
        const cardId = value && typeof value === 'object' ? null : value;
        const card = cardId ? byId[cardId] : null;
        const tier = card ? card.tier : value && value.tier;
        let source = cardId ? $(`.card[data-card="${cardId}"]`) : null;
        if (!source && tier && previous.field && next.field) {
          const nextTier = new Set((next.field[tier] || []).filter(Boolean));
          const removed = (previous.field[tier] || []).find(id => id && !nextTier.has(id) && !allBoards.has(id));
          if (removed) source = $(`.card[data-card="${removed}"]`);
        }
        if (!source && tier) source = $(`.deck-pile[data-tier="${tier}"]`);
        moves.push({ type: 'reserve', pid, cardId, reserveSlot: slot, img: card ? card.img : null, tier, rect: source ? source.getBoundingClientRect() : null });
      }
    }
    return moves;
  }
  function playNetworkCardMoves(moves) {
    const touched = new Set();
    (moves || []).forEach((move, index) => {
      const panel = $(`.player[data-player="${move.pid}"]`);
      if (!panel) return;
      let target = move.type === 'capture' && move.cardId
        ? panel.querySelector(`[data-captured-card="${move.cardId}"]`)
        : move.cardId ? panel.querySelector(`[data-reserved-card="${move.cardId}"]`) : null;
      if (!target && move.type === 'reserve') target = panel.querySelector(`[data-reserved-slot="${move.reserveSlot}"]`);
      target = target || panel.querySelector(move.type === 'reserve' ? '[data-reserve-zone]' : '[data-capture-zone]') || panel;
      flyCard(move.img, move.rect, target.getBoundingClientRect(), move.tier, index * 65);
      touched.add(move.pid);
    });
    touched.forEach((pid) => {
      const panel = $(`.player[data-player="${pid}"]`);
      if (panel) { panel.classList.add('receiving'); setTimeout(() => panel.classList.remove('receiving'), 520); }
    });
  }
  function captureNetworkTokenMoves(previous, next) {
    const moves = [];
    if (!previous || !next || !Array.isArray(previous.players) || !Array.isArray(next.players)) return moves;
    for (let pid = 0; pid < Math.min(previous.players.length, next.players.length); pid++) {
      for (const color of E.ALL_TOKENS) {
        const before = previous.players[pid].tokens[color] || 0;
        const after = next.players[pid].tokens[color] || 0;
        const delta = after - before;
        const source = delta > 0
          ? $(`.supply-row[data-supply-color="${color}"] .ball`)
          : $(`.player[data-player="${pid}"] .trainer-token[data-token-color="${color}"] .ball`);
        for (let n = 0; n < Math.abs(delta); n++) moves.push({ pid, color, direction: delta > 0 ? 'in' : 'out', rect: source ? source.getBoundingClientRect() : null });
      }
    }
    return moves;
  }
  function playNetworkTokenMoves(moves) {
    const touched = new Set();
    (moves || []).forEach((move, index) => {
      const target = move.direction === 'in'
        ? $(`.player[data-player="${move.pid}"] .trainer-token[data-token-color="${move.color}"] .ball`)
        : $(`.supply-row[data-supply-color="${move.color}"] .ball`);
      flyBall(move.color, move.rect, target ? target.getBoundingClientRect() : null, index * 55);
      if (move.direction === 'in') touched.add(move.pid);
    });
    touched.forEach((pid) => {
      const panel = $(`.player[data-player="${pid}"]`);
      if (panel) { panel.classList.add('receiving'); setTimeout(() => panel.classList.remove('receiving'), 520); }
    });
  }
  function flyNode(n, fx, fy, tx, ty, delay) {
    n.style.transform = `translate(${fx}px,${fy}px)`;
    document.body.appendChild(n);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      n.style.transform = `translate(${tx}px,${ty}px) scale(.62)`;
      n.style.opacity = '0.12';
    }));
    setTimeout(() => n.remove(), ANIM_MS + (delay || 0) + 90);
  }
  function flyBall(color, fromRect, toRect, delay) {
    if (!fromRect || !toRect) return;
    const n = document.createElement('div'); n.className = 'fly'; n.innerHTML = `<div class="ball ${color}"></div>`;
    if (delay) n.style.transitionDelay = delay + 'ms';
    const size = 40;
    flyNode(n,
      fromRect.left + fromRect.width / 2 - size / 2,
      fromRect.top + fromRect.height / 2 - size / 2,
      toRect.left + toRect.width / 2 - size / 2,
      toRect.top + toRect.height / 2 - size / 2,
      delay);
  }
  function flyCard(img, fromRect, toRect, tier, delay) {
    if (!toRect) return;
    const n = document.createElement('div'); n.className = 'fly fly-card';
    if (img) n.innerHTML = `<img src="${img}">`;
    else if (tier) n.setAttribute('data-tier', tier);          // blind deck reserve → tier-correct back
    else n.style.background = 'linear-gradient(135deg,#3a2a6e,#221a4a)';
    if (delay) n.style.transitionDelay = delay + 'ms';
    const fx = fromRect ? fromRect.left + fromRect.width / 2 : toRect.left + toRect.width / 2;
    const fy = fromRect ? fromRect.top + fromRect.height / 2 : toRect.top + toRect.height / 2;
    const tx = toRect.left + toRect.width / 2, ty = toRect.top + toRect.height / 2;
    flyNode(n, fx - 30, fy - 40, tx - 30, ty - 40, delay);
  }
  function captureSrc(dec) {
    const src = [];
    if (!dec) return src;
    if (dec.type === 'take') {
      for (const c of (dec.colors || [])) { const el = $(`.supply-row[data-color="${c}"] .ball`); src.push({ kind: 'ball-in', color: c, rect: el ? el.getBoundingClientRect() : null }); }
    }
    if (dec.cardId) {
      let el = $(`.card[data-card="${dec.cardId}"]`) || $(`[data-reserve-capture="${dec.cardId}"]`);
      const card = G.byId[dec.cardId];
      src.push({ kind: 'card', cardId: dec.cardId, reserveSlot: G.players[G.turn].reserve.length, rect: el ? el.getBoundingClientRect() : null, img: card ? card.img : null });
      if (dec.type === 'capture' && card && !(E.isPokemart(card) && card.effect === 'discard_buy')) {
        const extraMaster = ((dec.opts && dec.opts.spendPokedex) || []).length * 2;
        const payment = E.computePayment(G, G.players[G.turn], card, extraMaster);
        if (payment.ok) for (const color of E.ALL_TOKENS) {
          const token = $(`.player[data-player="${G.turn}"] .trainer-token[data-token-color="${color}"] .ball`);
          for (let n = 0; n < (payment.pay[color] || 0); n++) src.push({ kind: 'ball-out', color, rect: token ? token.getBoundingClientRect() : null });
        }
      }
    } else if (dec.type === 'reserve' && dec.deck) {
      const el = $(`.deck-pile[data-tier="${dec.deck}"]`);   // blind deck reserve: fly a face-down card from the pile
      src.push({ kind: 'card', reserveSlot: G.players[G.turn].reserve.length, rect: el ? el.getBoundingClientRect() : null, img: null, tier: dec.deck });
    } else if (dec.type === 'discard' && dec.color) {
      const token = $(`.player[data-player="${G.turn}"] .trainer-token[data-token-color="${dec.color}"] .ball`);
      src.push({ kind: 'ball-out', color: dec.color, rect: token ? token.getBoundingClientRect() : null });
    }
    return src;
  }
  function playGhosts(src, dec, pid) {
    const panel = $(`.player[data-player="${pid}"]`);
    if (!panel) return;
    if (dec.type !== 'discard') { panel.classList.add('receiving'); setTimeout(() => panel.classList.remove('receiving'), 520); }
    let ballIndex = 0;
    for (const it of (src || [])) {
      if (it.kind === 'ball-in') {
        const target = $(`.player[data-player="${pid}"] .trainer-token[data-token-color="${it.color}"] .ball`);
        flyBall(it.color, it.rect, target ? target.getBoundingClientRect() : null, ballIndex++ * 65);
      } else if (it.kind === 'ball-out') {
        const target = $(`.supply-row[data-supply-color="${it.color}"] .ball`);
        flyBall(it.color, it.rect, target ? target.getBoundingClientRect() : null, ballIndex++ * 65);
      } else if (it.kind === 'card') {
        let target = null;
        if (dec.type === 'capture' && it.cardId) target = panel.querySelector(`[data-captured-card="${it.cardId}"]`);
        else if (dec.type === 'reserve' && it.cardId) target = panel.querySelector(`[data-reserved-card="${it.cardId}"]`);
        else if (dec.type === 'reserve') target = panel.querySelector(`[data-reserved-slot="${it.reserveSlot}"]`);
        target = target || panel.querySelector(dec.type === 'reserve' ? '[data-reserve-zone]' : '[data-capture-zone]') || panel;
        flyCard(it.img, it.rect, target.getBoundingClientRect(), it.tier);
      }
    }
  }
  // capture source rects, apply mutation, render, animate ghosts to the player, then continue
  function applyAnimated(dec, pid, mutate, after) {
    const src = captureSrc(dec);
    const r = mutate();
    if (r && r.ok === false) { flashHint(r.error); return; }
    const epoch = gameEpoch;
    render(); playGhosts(src, dec, pid);
    setTimeout(() => { if (epoch === gameEpoch) after(); }, ANIM_MS);   // skip if game changed (undo/new game)
  }

  function doTake() {
    if (!takeSelectionComplete()) return;
    const colors = UI.pick.slice(); const pid = G.turn;
    if (isOnline()) { Net.action({ type: 'take', colors }); UI.pick = []; render(); return; }
    applyAnimated({ type: 'take', colors }, pid, () => { const r = E.actionTake(G, colors); if (r.ok) UI.pick = []; return r; }, afterMainAction);
  }
  function commitCapture(cid, opts) {
    const pid = G.turn;
    if (isOnline()) { Net.action({ type: 'capture', cardId: cid, opts }); UI.selCard = null; render(); return; }
    applyAnimated({ type: 'capture', cardId: cid, opts }, pid, () => { const r = E.actionCapture(G, cid, opts); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  async function doCapture() {
    const cid = UI.selCard, card = byId[cid];
    const info = card && affordInfo(card);
    if (!card || !info) return;
    // Cards needing player choices (Pokémart effects, or spending POKÉDEX) collect
    // them via a modal first; everything else captures immediately.
    UI.busy = true; updateUndoBtn();
    if (info.master > 0 && !(await confirmMasterUse(info.master))) {
      UI.busy = false; render(); return;
    }
    const opts = await gatherCaptureOpts(card);
    UI.busy = false;
    if (opts === null) { render(); return; } // cancelled
    commitCapture(cid, opts);
  }

  function confirmMasterUse(count) {
    return new Promise((resolve) => {
      const modal = $('#master-confirm-modal');
      const ok = $('#master-confirm-ok'), cancel = $('#master-confirm-cancel');
      $('#master-confirm-count').textContent = count;
      $('#master-confirm-badge').textContent = `×${count}`;
      const close = (answer) => {
        modal.classList.add('hidden');
        ok.removeEventListener('click', yes);
        cancel.removeEventListener('click', no);
        modal.removeEventListener('click', backdrop);
        document.removeEventListener('keydown', escape);
        resolve(answer);
      };
      const yes = () => close(true);
      const no = () => close(false);
      const backdrop = (event) => { if (event.target === modal) close(false); };
      const escape = (event) => { if (event.key === 'Escape') close(false); };
      ok.addEventListener('click', yes);
      cancel.addEventListener('click', no);
      modal.addEventListener('click', backdrop);
      document.addEventListener('keydown', escape);
      modal.classList.remove('hidden');
      ok.focus();
    });
  }

  // ---- Pokémart effect choice collection (returns a Promise<opts|null>) ----
  function pickCards(o) {
    return new Promise((resolve) => {
      const modal = $('#choice-modal'), confirm = $('#choice-confirm'), cancel = $('#choice-cancel');
      $('#choice-title').textContent = o.title;
      $('#choice-hint').textContent = o.hint || '';
      const wrap = $('#choice-cards'); wrap.innerHTML = '';
      const count = o.count, sel = [];
      (o.candidates || []).forEach((id) => {
        const c = byId[id];
        const el = document.createElement('div');
        el.className = 'choice-card'; el.dataset.id = id; el.dataset.zoom = c.img;
        el.innerHTML = `<img src="${c.img}" alt="${c.name}"><span>${c.name}</span>`;
        el.addEventListener('click', () => {
          const i = sel.indexOf(id);
          if (i >= 0) { sel.splice(i, 1); el.classList.remove('sel'); }
          else {
            if (count === 1) { sel.length = 0; wrap.querySelectorAll('.choice-card').forEach(x => x.classList.remove('sel')); }
            else if (sel.length >= count) return;
            sel.push(id); el.classList.add('sel');
          }
          confirm.disabled = sel.length !== count;
        });
        wrap.appendChild(el);
      });
      confirm.disabled = sel.length !== count;
      const close = (val) => { modal.classList.add('hidden'); confirm.removeEventListener('click', ok); cancel.removeEventListener('click', no); resolve(val); };
      const ok = () => { if (sel.length === count) close(sel.slice()); };
      const no = () => close(null);
      confirm.addEventListener('click', ok); cancel.addEventListener('click', no);
      modal.classList.remove('hidden');
    });
  }
  async function gatherCaptureOpts(card) {
    const p = me(); const opts = {};
    // 1) spend POKÉDEX as virtual master balls if needed to afford it (not for REPEL)
    if (card.effect !== 'discard_buy' && !E.canAfford(G, p, card)) {
      const dex = p.board.filter(id => E.isPokemart(byId[id]) && byId[id].effect === 'colorless_master');
      let need = -1;
      for (let k = 0; k <= dex.length; k++) if (E.computePayment(G, p, card, k * 2).ok) { need = k; break; }
      if (need > 0) {
        const sel = await pickCards({ title: '弃用图鉴抵款', hint: `弃 ${need} 张图鉴，各抵 2 个万能球以捕捉`, candidates: dex, count: need });
        if (!sel) return null;
        opts.spendPokedex = sel;
      }
    }
    // 2) copy association (EVOLVE STONE / RARE CANDY)
    if (card.effect === 'copy' || card.effect === 'copy_free') {
      const cands = p.board.filter(id => E.effBonusColor(G, p, id));
      const sel = await pickCards({ title: '关联（进化石/神奇糖果）', hint: '选择一张卡，本卡永久视同其奖励颜色', candidates: cands, count: 1 });
      if (!sel) return null;
      opts.copyTargetId = sel[0];
    }
    // 3) REPEL: discard N owned cards of its colour
    if (card.effect === 'discard_buy') {
      const col = card.effectParam.discardColor, n = card.effectParam.discardCount;
      const cands = p.board.filter(id => E.effBonusColor(G, p, id) === col);
      const sel = await pickCards({ title: '驱虫喷雾', hint: `弃掉 ${n} 张${BALL_NAMES[col]}卡以获得本卡（不付精灵球）`, candidates: cands, count: n });
      if (!sel) return null;
      opts.discardCards = sel;
    }
    // 4) take a free card (TM / RARE CANDY), possibly recursive
    if (card.effect === 'free' || card.effect === 'copy_free') {
      const fo = await gatherFreeTake(card);
      if (fo === null) return null;
      Object.assign(opts, fo);
    }
    return opts;
  }
  async function gatherFreeTake(parentCard) {
    const p = me();
    const cands = [];
    for (const t of E.freeTiers(parentCard)) for (const id of (G.field[t] || [])) if (id && E.freeTakeable(G, p, byId[id])) cands.push(id);
    if (!cands.length) return { freeTakeId: undefined }; // nothing eligible — effect fizzles
    const sel = await pickCards({ title: '免费获得一张卡', hint: '立即免费获得（不付其成本），结算其效果', candidates: cands, count: 1 });
    if (!sel) return null;
    const freeId = sel[0], fc = byId[freeId], freeOpts = {};
    if (E.isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free')) {
      const cc = p.board.filter(id => E.effBonusColor(G, p, id));
      const cp = await pickCards({ title: `关联「${fc.name}」`, hint: '为免费获得的卡选择复制奖励的卡', candidates: cc, count: 1 });
      if (!cp) return null;
      freeOpts.copyTargetId = cp[0];
    }
    if (E.isPokemart(fc) && (fc.effect === 'free' || fc.effect === 'copy_free')) {
      const sub = await gatherFreeTake(fc);
      if (sub === null) return null;
      Object.assign(freeOpts, sub);
    }
    return { freeTakeId: freeId, freeOpts };
  }
  function doReserveCard() {
    const cid = UI.selCard, pid = G.turn;
    if (isOnline()) { Net.action({ type: 'reserve', target: { fromField: cid } }); UI.selCard = null; render(); return; }
    applyAnimated({ type: 'reserve', cardId: cid }, pid, () => { const r = E.actionReserve(G, { fromField: cid }); if (r.ok) UI.selCard = null; return r; }, afterMainAction);
  }
  function doReserveDeck() {
    const tier = UI.selDeck, pid = G.turn;
    if (isOnline()) { Net.action({ type: 'reserve', target: { fromDeck: tier } }); UI.selDeck = null; render(); return; }
    applyAnimated({ type: 'reserve', deck: tier }, pid, () => { const r = E.actionReserve(G, { fromDeck: tier }); if (r.ok) UI.selDeck = null; return r; }, afterMainAction);
  }
  function decodePlan(plan) {
    const a = plan && plan.action; if (!a) return { type: 'pass' };
    if (a.type === 'take') return { type: 'take', colors: a.colors };
    if (a.type === 'capture') return { type: 'capture', cardId: a.cardId };
    if (a.type === 'reserve') return { type: 'reserve', cardId: (a.target && a.target.fromField) || null, deck: (a.target && a.target.fromDeck) || null };
    return { type: 'pass' };
  }

  // ---------------------------------------------------------------- undo (悔棋, vs AI)
  let undoStack = [];
  // bumped whenever G is reassigned (new game / undo / leave game); pending timers
  // capture the epoch and bail if it changed, so a stale timer can't mutate a fresh game.
  let gameEpoch = 0;
  function pushUndo() { undoStack.push({ s: E.clone(G), log: G.log.slice() }); if (undoStack.length > 60) undoStack.shift(); }
  function doUndo() {
    if (UI.busy || undoStack.length < 2) return;
    undoStack.pop();                                   // drop current turn's snapshot
    const snap = undoStack[undoStack.length - 1];      // back to previous human-turn start
    G = E.clone(snap.s); G.log = snap.log.slice(); gameEpoch++;   // cancel any in-flight timers
    UI.phase = 'main'; UI.pick = []; UI.selCard = UI.selDeck = null; UI.busy = false;
    render(); updateUndoBtn();
  }
  function updateUndoBtn() {
    const btn = $('#undo-btn'); if (!btn) return;
    const show = isOnline()
      ? !!(G && G.phase === 'play' && UI.net.seat >= 0 && UI.net.undoAvailable && !UI.net.undoVote)
      : !!(UI.hasAI && UI.humans === 1 && G && G.phase === 'play' && UI.phase === 'main' && !me().isAI && !UI.busy && undoStack.length >= 2);
    btn.classList.toggle('hidden', !show);
    renderUndoVote();
  }
  function renderUndoVote() {
    const box = $('#undo-vote'); if (!box) return;
    const vote = isOnline() && UI.net.undoVote;
    box.classList.toggle('hidden', !vote);
    if (!vote) { box.innerHTML = ''; return; }
    const requester = (UI.net.roster || []).find(p => p.seat === vote.requesterSeat);
    const mine = UI.net.seat;
    const approved = Array.isArray(vote.approvals) && vote.approvals.includes(mine);
    const progress = `${(vote.approvals || []).length}/${vote.total || G.numPlayers} 已同意`;
    box.innerHTML = `<div><b>${escapeHTML(requester ? requester.name : `玩家 ${vote.requesterSeat + 1}`)}</b> 发起悔棋</div>
      <div class="vote-progress">${progress} · 需要全员同意</div>
      ${approved ? '<div class="vote-waiting">你已同意，等待其他玩家…</div>' : '<div class="vote-actions"><button class="primary" data-undo-vote="yes">同意</button><button class="ghost" data-undo-vote="no">拒绝</button></div>'}`;
  }
  function doDiscard(color) {
    if (UI.phase !== 'discard') return;
    if (isOnline()) { Net.action({ type: 'discard', color }); return; }
    const pid = G.turn;
    applyAnimated({ type: 'discard', color }, pid, () => E.actionDiscard(G, color), () => {
      if (!E.needsDiscard(G, me())) toEvolveOrEnd();
      else render();
    });
  }
  function doEvolve(fromId, toId) {
    if (isOnline()) { Net.action({ type: 'evolve', fromId, toId }); return; }
    const r = E.actionEvolve(G, fromId, toId);
    if (!r.ok) { flashHint(r.error); return; }
    endTurn();
  }
  function doMegaEvolve(megaId, fromId) {
    if (isOnline()) { Net.action({ type: 'megaEvolve', megaId, fromId }); return; }
    const r = E.actionMegaEvolve(G, megaId, fromId);
    if (!r.ok) { flashHint(r.error); return; }
    endTurn();
  }
  function doTakeMega() {
    if (!interactable()) return;
    if (isOnline()) { Net.action({ type: 'takeMega' }); return; }
    const r = E.actionTakeMega(G);
    if (!r.ok) { flashHint(r.error); return; }
    afterMainAction();
  }

  function afterMainAction() {
    UI.selCard = UI.selDeck = null; UI.pick = [];
    if (E.needsDiscard(G, me())) { UI.phase = 'discard'; render(); return; }
    toEvolveOrEnd();
  }
  function toEvolveOrEnd() {
    const opts = E.evolutionOptions(G, me());
    const mopts = G.megasEnabled ? E.megaEvolveOptions(G, me()) : [];
    if ((opts.length || mopts.length) && !me().isAI) { UI.phase = 'evolve'; render(); return; }
    endTurn();
  }
  function endTurn() {
    if (isOnline()) { Net.action({ type: 'endTurn' }); return; }
    const r = E.endTurn(G);
    UI.phase = 'main'; UI.pick = []; UI.selCard = UI.selDeck = null;
    if (G.phase === 'gameover') { render(); showWin(); return; }
    render();
    beginTurn();
  }

  // ---------------------------------------------------------------- turn control
  function beginTurn() {
    if (G.phase === 'gameover') { updateUndoBtn(); return; }
    autosave();                               // snapshot the clean turn start (resume point)
    const p = me();
    if (p.isAI) { render(); updateUndoBtn(); const e = gameEpoch; setTimeout(() => { if (e === gameEpoch) aiPlay(); }, 120); return; }
    if (UI.hasAI && UI.humans === 1) pushUndo(); // snapshot each human turn start (undo target; 1-human-vs-AI only)
    // hotseat: hide previous player's hidden info before a human's turn
    if (UI.humans >= 2) { showPassOverlay(p); }
    else render();
    updateUndoBtn();
  }

  function showPassOverlay(p) {
    let ov = $('#pass-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'pass-overlay'; document.body.appendChild(ov); }
    ov.innerHTML = `<div class="po-inner"><div class="pavatar" style="margin:0 auto 14px;width:56px;height:56px;background-color:${SEAT_COLORS[G.turn]};background-image:url(${seatAvatar(G.turn)});box-shadow:0 0 0 3px ${SEAT_COLORS[G.turn]}"></div>
      <h2>请将设备交给<br>${escapeHTML(p.name)}</h2><p>（其他玩家的预留区将被隐藏）</p>
      <button class="primary" id="ready-btn" style="margin-top:16px;padding:12px 30px">我准备好了</button></div>`;
    ov.classList.remove('hidden');
    $('#ready-btn').onclick = () => { ov.classList.add('hidden'); render(); };
    renderBanner();
  }

  let policyLoaded = false;
  function loadPolicy() {
    if (policyLoaded || !window.AZAI) return;
    fetch('assets/policy.json').then(r => (r.ok ? r.json() : null)).then(j => {
      if (j && j.weights) { AZAI.setWeights(j); policyLoaded = true; }
    }).catch(() => {});
  }

  function aiPlay() {
    if (G.phase === 'gameover') return;
    const p = me(), pid = G.turn, epoch = gameEpoch;
    UI.busy = true; updateUndoBtn();
    // 究极 runs a real determinized MCTS (validated ~58% vs 高手 in 2p). It only helps HEAD-TO-HEAD:
    // measured worse than 高手 at 3-4p (multiplayer search is misled by opponent/kingmaking noise),
    // so above 2 players 究极 falls back to the heuristic. The search itself IS the "thinking" time,
    // so use a short artificial pacing for it instead of the full 1.7–3.2s.
    const isUltra = p.diff === 'ultra' && window.VSearch && G.numPlayers === 2;
    const think = isUltra ? (250 + Math.random() * 250) : (1700 + Math.random() * 1500);
    // Start the heavy search NOW, in the worker, so it runs DURING the "thinking"
    // pause instead of freezing the UI after it. AZ seats keep their own sync path.
    const fallbackDiff = (p.diff === 'alphazero' || p.diff === 'ultra') ? 'hard' : (p.diff || 'hard');
    const planPromise = (p.diff === 'alphazero' && window.AZAI && AZAI.hasWeights())
      ? null
      : aiComputeAsync(isUltra ? 'ultra' : fallbackDiff, isUltra ? ULTRA_CFG : undefined);
    setTimeout(async () => {
      if (epoch !== gameEpoch) return;                // game was replaced/undone mid-think — drop this timer
      if (!G || G.phase === 'gameover') { UI.busy = false; return; }
      let dec = null, applyFn = null;
      // AlphaZero seat: net-guided MCTS; fall back to heuristic if the net move fails
      if (p.diff === 'alphazero' && window.AZAI && AZAI.hasWeights()) {
        let a = null; try { a = AZAI.mctsMove(G, 100); } catch (e) { a = null; }
        if (a != null) {
          dec = AZAI.decodeAction ? AZAI.decodeAction(G, a) : { type: 'pass' };
          applyFn = () => { try { AZAI.stepAuto(G, a); } catch (e) { } };
        }
      }
      if (!applyFn) {                                  // heuristic / 究极-search (default seat, or AZ fallback)
        const plan = planPromise ? await planPromise
          : AI.chooseTurn(G, { difficulty: fallbackDiff });   // AZ seat whose net move failed
        if (epoch !== gameEpoch) return;               // undo/new-game while the worker searched
        if (!G || G.phase === 'gameover') { UI.busy = false; return; }
        // Megas moves (takeMega action, mega evolution) now come from the plan
        // itself: legalActions enumerates takeMega and AI.manage weighs mega vs
        // normal evolution — no UI bolt-ons, so search and reality stay in sync.
        dec = decodePlan(plan);
        applyFn = () => {
          if (plan.action) E.applyAction(G, plan.action); else E.actionPass(G);
          for (const c of plan.discards) E.actionDiscard(G, c);
          if (plan.megaEvolution && !G.evolvedThisTurn) E.actionMegaEvolve(G, plan.megaEvolution.megaId, plan.megaEvolution.fromId);
          else if (plan.evolution && !G.evolvedThisTurn) E.actionEvolve(G, plan.evolution.fromId, plan.evolution.toId);
          E.endTurn(G);
        };
      }
      const src = captureSrc(dec);     // capture pre-move source positions
      applyFn();                       // mutate G (incl. endTurn)
      UI.busy = false; UI.phase = 'main';
      render(); playGhosts(src, dec, pid);
      if (G.phase === 'gameover') { setTimeout(showWin, ANIM_MS); return; }
      setTimeout(() => { if (epoch === gameEpoch) beginTurn(); }, ANIM_MS);
    }, think);
  }

  // ---------------------------------------------------------------- win
  function showWin() {
    const scores = G.players.map((p, i) => ({ i, s: E.scoreOf(G, p), bur: p.buried.length, brd: p.board.length, name: p.name }));
    const w = G.winner;
    let rows = scores.slice().sort((a, b) => b.s - a.s || b.bur - a.bur || b.brd - a.brd)
      .map(r => `<div class="wrow${r.i === w ? ' winner' : ''}"><span>${r.i === w ? '👑 ' : ''}${escapeHTML(r.name)}</span><span>${r.s} 分 · ${r.brd} 只 · 进化 ${r.bur}</span></div>`).join('');
    $('#win-content').innerHTML = `<div class="win-trophy">🏆</div><h2>${escapeHTML(G.players[w].name)} 获胜！</h2><div class="win-scores">${rows}</div>`;
    $('#win-modal').classList.remove('hidden');
  }

  function flashHint(msg) {
    const bar = $('#action-bar');
    bar.classList.remove('action-idle');
    const note = document.createElement('div');
    note.className = 'act-hint'; note.style.color = 'var(--bad)'; note.textContent = msg;
    bar.prepend(note);
    setTimeout(() => {
      const stillShown = note.isConnected;
      note.remove();
      if (stillShown) renderActionBar();
    }, 1600);
  }

  // ---------------------------------------------------------------- zoom preview
  function setupZoom() {
    const z = $('#zoom'), img = $('#zoom-img');
    document.addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-zoom]');
      if (!t) { z.classList.add('hidden'); return; }
      img.src = t.dataset.zoom;
      z.classList.remove('hidden');
      const pad = 16, w = 260, h = 347;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > innerWidth) x = e.clientX - w - pad;
      if (y + h > innerHeight) y = innerHeight - h - 6;
      z.style.left = x + 'px'; z.style.top = Math.max(6, y) + 'px';
    });
  }

  // ------------------------------------------------------- tap-to-inspect (touch)
  // On touch there is no hover; tapping a card opens a large, readable overlay.
  function openInspect(src, actionsHtml) {
    if (matchMedia('(min-width:1281px)').matches) return;
    const ov = $('#inspect'); if (!ov || !src) return;
    $('#inspect-img').src = src;
    $('#inspect-actions').innerHTML = (actionsHtml || '') + `<button class="ghost" data-inspect-close>关闭</button>`;
    ov.classList.remove('hidden');
  }
  function closeInspect() { const ov = $('#inspect'); if (ov) ov.classList.add('hidden'); }
  // gentle, dismissible "rotate to landscape" hint for phones in portrait (never forced)
  let rotateDismissed = false;
  function evalRotateHint() {
    const hint = $('#rotate-hint'); if (!hint) return;
    const gameOn = !$('#game').classList.contains('hidden');
    const narrowPortrait = matchMedia('(max-width:640px) and (orientation:portrait)').matches;
    hint.classList.toggle('hidden', !(gameOn && narrowPortrait && !rotateDismissed));
  }
  function setupRotateHint() {
    try { rotateDismissed = sessionStorage.getItem('ps-rotate-dismissed') === '1'; } catch (e) { }
    const dz = $('#rotate-dismiss');
    if (dz) dz.addEventListener('click', () => { rotateDismissed = true; try { sessionStorage.setItem('ps-rotate-dismissed', '1'); } catch (e) { } evalRotateHint(); });
    window.addEventListener('resize', evalRotateHint, { passive: true });
    window.addEventListener('orientationchange', evalRotateHint);
    evalRotateHint();
  }

  // ---------------------------------------------------------------- events
  function bind() {
    // The game uses right-click as a secondary board action; suppress the
    // browser menu everywhere so the interaction remains consistent.
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    // setup
    if ($('#choose-online')) $('#choose-online').addEventListener('click', () => showSetupMode('online'));
    if ($('#choose-local')) $('#choose-local').addEventListener('click', () => showSetupMode('local'));
    $$('.setup-back').forEach((button) => button.addEventListener('click', () => showSetupMode('home')));
    $('#player-count').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#player-count button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); buildSeats(+b.dataset.n);
    });
    $('#start-btn').addEventListener('click', startGame);
    // online lobby
    const syncOnlineTimeout = () => {
      const enabled = !!($('#online-timeout-enabled') && $('#online-timeout-enabled').checked);
      if ($('#online-timeout-ms')) $('#online-timeout-ms').disabled = !enabled;
      if ($('#online-timeout-field')) $('#online-timeout-field').classList.toggle('disabled', !enabled);
    };
    if ($('#online-timeout-enabled')) $('#online-timeout-enabled').addEventListener('change', syncOnlineTimeout);
    syncOnlineTimeout();
    if ($('#online-create')) $('#online-create').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const oldText = button.textContent;
      button.textContent = '创建中…';
      try {
        const enabled = !!$('#online-timeout-enabled').checked;
        $('#lobby-timeout-enabled').checked = enabled;
        $('#lobby-timeout-ms').value = $('#online-timeout-ms').value;
        openOnline(await Net.createRoom(), true);
      }
      catch (error) { alert((error && error.message) || '无法创建房间'); }
      finally { button.disabled = false; button.textContent = oldText; }
    });
    const joinOnline = () => { const c = ($('#online-room-code').value || '').trim(); if (c) openOnline(c, false); else flashHint('请输入房间码'); };
    if ($('#online-join')) $('#online-join').addEventListener('click', joinOnline);
    if ($('#online-room-code')) $('#online-room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinOnline(); });
    if ($('#lobby-timeout-enabled')) $('#lobby-timeout-enabled').addEventListener('change', () => { $('#lobby-timeout-ms').disabled = !UI.net || !UI.net.host || !$('#lobby-timeout-enabled').checked; });
    if ($('#lobby-start')) $('#lobby-start').addEventListener('click', () => {
      if (!window.Net) return;
      const timeoutEnabled = !!($('#lobby-timeout-enabled') && $('#lobby-timeout-enabled').checked);
      Net.start({
        megas: !!($('#lobby-megas') && $('#lobby-megas').checked),
        pokemart: !!($('#lobby-pokemart') && $('#lobby-pokemart').checked),
        turnTimeoutMs: timeoutEnabled ? Number($('#lobby-timeout-ms').value) : null,
      });
    });
    if ($('#lobby-leave')) $('#lobby-leave').addEventListener('click', leaveOnline);
    if ($('#lobby-copy')) $('#lobby-copy').addEventListener('click', () => { try { navigator.clipboard.writeText(location.href); flashHint('邀请链接已复制'); } catch (e) { flashHint(location.href); } });
    if ($('#tutorial-btn')) $('#tutorial-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('base'); });
    if ($('#tutorial-mega-btn')) $('#tutorial-mega-btn').addEventListener('click', () => { if (window.Tutorial) Tutorial.start('megas'); });
    $('#undo-btn').addEventListener('click', () => { if (isOnline()) Net.requestUndo(); else doUndo(); });
    $('#undo-vote').addEventListener('click', (e) => {
      const b = e.target.closest('[data-undo-vote]');
      if (b && isOnline()) Net.voteUndo(b.dataset.undoVote === 'yes');
    });
    $('#rules-btn').addEventListener('click', () => $('#rules-modal').classList.remove('hidden'));
    $('#rules-modal').addEventListener('click', (e) => { if (e.target.id === 'rules-modal' || e.target.classList.contains('close-rules')) $('#rules-modal').classList.add('hidden'); });
    $('#menu-btn').addEventListener('click', () => {
      const inTut = window.Tutorial && Tutorial.active && Tutorial.active();
      if (confirm(inTut ? '退出教程，返回主菜单？' : '返回主菜单？当前对局将丢失。')) {
        if (isOnline()) { leaveOnline(); return; }
        if (!inTut) clearSave();              // explicit quit of a real game = abandon its autosave
        if (window.Tutorial && Tutorial.stop) Tutorial.stop();
        backToSetup();
      }
    });
    $('#play-again').addEventListener('click', () => { if (window.Tutorial && Tutorial.stop) Tutorial.stop(); if (isOnline()) leaveOnline(); else backToSetup(); });

    // delegated game clicks
    $('#supply').addEventListener('click', (e) => {
      if (e.target.closest('[data-supply-confirm]')) { doTake(); return; }
      if (e.target.closest('[data-supply-clear]')) { UI.pick = []; render(); return; }
      if (e.target.closest('[data-take-mega]')) { doTakeMega(); return; }
      const r = e.target.closest('[data-color]'); if (r) onSupplyClick(r.dataset.color);
    });
    $('#supply').addEventListener('contextmenu', (e) => {
      const r = e.target.closest('[data-color]'); if (!r) return;
      e.preventDefault();
      onSupplyReturn(r.dataset.color);
    });
    $('#field').addEventListener('click', (e) => {
      const dk = e.target.closest('.deck-pile[data-tier]'); if (dk) { onDeckClick(dk.dataset.tier); return; }
      const cd = e.target.closest('[data-card]');
      if (cd) {
        const id = cd.dataset.card;
        const isMega = byId[id] && byId[id].tier === 'mega';
        // Mega cards (zoom-only) and any tap when it's not your turn → just enlarge for reading.
        if (isMega || !interactable()) { openInspect(cd.dataset.zoom || (byId[id] && byId[id].img)); return; }
        onCardClick(id);
      }
    });
    $('#field').addEventListener('contextmenu', (e) => {
      const card = e.target.closest('[data-card]');
      const deck = e.target.closest('.deck-pile[data-tier]');
      if (!card && !deck) return;
      e.preventDefault();
      if ((card && UI.selCard === card.dataset.card) || (deck && UI.selDeck === deck.dataset.tier)) {
        UI.selCard = UI.selDeck = null;
        renderField();
        renderActionBar();
        renderPlayers();
      }
    });
    // tap the enlarged card thumbnail in the dock to open the full-screen reader (+ act)
    $('#inspect').addEventListener('click', (e) => {
      const ia = e.target.closest('[data-inspect-act]');
      if (ia) { const a = ia.dataset.inspectAct; closeInspect(); if (a === 'capture') doCapture(); else if (a === 'reserve-card') doReserveCard(); return; }
      if (e.target.id === 'inspect' || e.target.closest('[data-inspect-close]')) closeInspect();
    });
    const setLogOpen = (open) => {
      $('#log').classList.toggle('open', open);
      $('#log').setAttribute('aria-hidden', String(!open));
      $('#log-btn').setAttribute('aria-expanded', String(open));
    };
    $('#log-btn').addEventListener('click', () => setLogOpen(!$('#log').classList.contains('open')));
    $('#log-close').addEventListener('click', () => setLogOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setLogOpen(false); });
    $('#action-bar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act],[data-discard],[data-evo-from],[data-mega]'); if (!b) return;
      if (b.dataset.act === 'confirm-take') doTake();
      else if (b.dataset.act === 'clear-take') { UI.pick = []; render(); }
      else if (b.dataset.act === 'clear-sel') { UI.selCard = UI.selDeck = null; render(); }
      else if (b.dataset.act === 'capture') doCapture();
      else if (b.dataset.act === 'reserve-card') doReserveCard();
      else if (b.dataset.act === 'reserve-deck') doReserveDeck();
      else if (b.dataset.act === 'end-turn') endTurn();
      else if (b.dataset.discard) doDiscard(b.dataset.discard);
      else if (b.dataset.mega) doMegaEvolve(b.dataset.mega, b.dataset.megaFrom);
      else if (b.dataset.evoFrom) doEvolve(b.dataset.evoFrom, b.dataset.evoTo);
    });
    // own-reserve capture: clicking a revealed reserve mini-card selects it
    $('#players').addEventListener('click', (e) => {
      const mc = e.target.closest('[data-reserve-capture]');
      if (mc && interactable()) {
        const id = mc.dataset.reserveCapture;
        if (UI.selCard === id) openInspect(byId[id].img);
        else { UI.selCard = id; UI.selDeck = null; UI.pick = []; render(); }
        return;
      }
      // any other captured/opponent card: tap to enlarge & read
      const z = e.target.closest('[data-zoom]');
      if (z && z.dataset.zoom) openInspect(z.dataset.zoom);
    });
  }

  buildSeats(2);
  showSetupMode('home');
  bind();
  setupZoom();
  setupRotateHint();
  offerResume();   // if a previous game was left unfinished, offer to continue it
  // deep-link: ?room=CODE → jump straight into that online lobby
  try { const rc = new URLSearchParams(location.search).get('room'); if (rc && window.Net) openOnline(rc, false); } catch (e) { }

  // lightweight debug hook (harmless in production): inspect/drive from console
  window.PSDebug = {
    get G() { return G; }, get UI() { return UI; }, E, AI, byId, render,
    afterMainAction, beginTurn, endTurn, showWin,
  };

  // public surface used by the tutorial (js/tutorial.js)
  window.PSGame = {
    E, AI, byId, MEGA_DB,
    get DB() { return DB; },
    get G() { return G; },
    get UI() { return UI; },
    render, enterGame, backToSetup, endTurn,
    setPhase(ph) { UI.phase = ph; },
  };

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
})();
