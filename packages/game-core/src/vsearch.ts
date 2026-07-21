/* =====================================================================
 * VSearch v2 — single-tree determinized MCTS for the "究极" AI difficulty.
 *
 * v1 split the budget across `dets` INDEPENDENT trees (200 sims / 3 trees
 * ≈ 67 sims each — far too shallow to out-think the 1-ply heuristic) and
 * paid a full |A|×(clone+eval) prior expansion for every new leaf.
 * v2 restructures per the research evidence (Cowling et al.: one deep tree
 * ≫ many shallow trees; SO-ISMCTS-lite):
 *   - ONE tree over information sets: nodes keyed by the action path, no
 *     stored states; each iteration clones the real state, RE-SHUFFLES the
 *     unseen decks (fresh determinization), and replays down the tree.
 *   - Lazy expansion: a new leaf costs only a cheap eval (≈5 evalStates);
 *     the expensive softmax prior is computed on the 2nd visit. Most leaves
 *     are never revisited → ~5-10× more sims per second.
 *   - Budget: cfg.sims (iterations) or cfg.timeMs (anytime, early-stops
 *     when the leader is mathematically unassailable).
 *   - Per-seat max^n value vectors (kept from v1 — correct for 3-4p) and
 *     optional cfg.oppK pruning at opponent nodes so multiplayer budgets
 *     concentrate on OUR replies instead of predicting everyone deeply.
 *
 * Public: VSearch.chooseTurn(G, {sims,timeMs,cpuct,oppK,endgame})
 *         -> {action, discards, evolution}   (same shape as AI.chooseTurn)
 * ===================================================================== */
import AI from './ai.js';
import E from './engine.js';
import type { AiConfig, VSearchOptions } from './api.js';
import type { Card, GameAction, GameState, Player, TurnPlan } from './types.js';
type TreeNode = {
  readonly turn: number;
  seen: number;
  expanded: boolean;
  acts: GameAction[] | null;
  P: Float64Array | null;
  N: Float64Array | null;
  W: Float64Array | null;
  keys: string[] | null;
  readonly children: Record<string, TreeNode>;
};
type ExpandedTreeNode = TreeNode & {
  expanded: true;
  acts: GameAction[];
  P: Float64Array;
  N: Float64Array;
  W: Float64Array;
  keys: string[];
};
type SearchPath = Array<readonly [node: TreeNode, index: number]>;

function isExpanded(node: TreeNode): node is ExpandedTreeNode {
  return (
    node.expanded &&
    node.acts !== null &&
    node.P !== null &&
    node.N !== null &&
    node.W !== null &&
    node.keys !== null
  );
}

function floatAt(values: Float64Array, index: number): number {
  return values[index] ?? 0;
}
const FIELD_TIERS = E.FIELD_TIERS;
const DEFAULT_CPUCT = 1.4,
  PRIOR_T = 90,
  VAL_SCALE = 650,
  EXPAND_AT = 2;
// Use the STRONGEST heuristic config (denial on, full proximity) for the search's
// prior + leaf — same reasoning as v1: a weaker model desyncs from the real opponent.
const HARD: AiConfig = AI.DIFF.hard;

function playerAt(state: GameState, index: number): Player {
  const player = state.players[index];
  if (!player) throw new Error(`未知训练家席位：${index}`);
  return player;
}

function cardById(state: GameState, id: string): Card {
  const card = state.byId[id];
  if (!card) throw new Error(`未知卡牌：${id}`);
  return card;
}

// Resolve end-of-turn discard + evolution the SAME way the heuristic plays its
// turns (consistent opponent model is what makes the lookahead valid).
function resolveTurn(s: GameState): void {
  AI.manage(s, HARD);
}
function autoStep(s: GameState, a: GameAction | null): void {
  if (a) E.applyAction(s, a);
  else E.actionPass(s);
  resolveTurn(s);
  E.endTurn(s);
}

function actionKey(a: GameAction): string {
  if (a.type === 'take') return 't' + a.colors.slice().sort().join('');
  if (a.type === 'capture') return 'c' + a.cardId;
  if (a.type === 'reserve')
    return 'r' + ('fromField' in a.target ? a.target.fromField : 'd' + a.target.fromDeck);
  if (a.type === 'takeMega') return 'm'; // must not collide with pass ('p')
  return 'p';
}

// fresh determinization: re-shuffle every unseen deck so the tree averages
// over plausible futures instead of peeking at the real order
function determinize(s: GameState): void {
  for (const t of FIELD_TIERS) {
    const d = s.decks[t];
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const left = d[i],
        right = d[j];
      if (left === undefined || right === undefined) continue;
      d[i] = right;
      d[j] = left;
    }
  }
}

// PER-SEAT value vector v[p] ∈ [-1,1] — each player's eval margin vs their
// best opponent (max^n backup; for np==2 it's exactly a sign flip).
function terminalVec(s: GameState): Float64Array {
  const v = new Float64Array(s.numPlayers);
  for (let p = 0; p < s.numPlayers; p++) v[p] = p === s.winner ? 1 : -1;
  return v;
}
function leafVec(s: GameState): Float64Array {
  const np = s.numPlayers,
    ev = new Float64Array(np),
    v = new Float64Array(np);
  for (let p = 0; p < np; p++) ev[p] = AI.evalState(s, p, HARD);
  for (let p = 0; p < np; p++) {
    let opp = -1e18;
    for (let q = 0; q < np; q++) if (q !== p && floatAt(ev, q) > opp) opp = floatAt(ev, q);
    v[p] = Math.tanh((floatAt(ev, p) - opp) / VAL_SCALE);
  }
  return v;
}
// Final-round exact-ish value: the last round is short and deck draws can't
// change who wins it — play the heuristic line out and return the TRUE result.
function endgameVec(s: GameState): Float64Array {
  const c = E.clone(s);
  let guard = 0;
  while (c.phase !== 'gameover' && guard++ < 16) {
    const acts = E.legalActions(c);
    if (!acts.length) {
      autoStep(c, null);
      continue;
    }
    const meNow = c.turn;
    let best: GameAction | null = acts[0] ?? null,
      bs = -1e18;
    for (const action of acts) {
      const cc = E.clone(c);
      autoStep(cc, action);
      const v = AI.evalState(cc, meNow, HARD);
      if (v > bs) {
        bs = v;
        best = action;
      }
    }
    autoStep(c, best);
  }
  return terminalVec(c);
}

// ------------------------- tree (information sets) -------------------------
// A node stores STATS ONLY (no game state): the working state is rebuilt each
// iteration by replaying the selected path on a fresh determinization.
function mkNode(turn: number): TreeNode {
  return {
    turn,
    seen: 0,
    expanded: false,
    acts: null,
    P: null,
    N: null,
    W: null,
    keys: null,
    children: {},
  };
}

// full expansion (the expensive |A|×(clone+step+eval) softmax prior) — paid
// only when a node is revisited (EXPAND_AT), not for every one-shot leaf.
function expandNode(n: TreeNode, s: GameState, rootTurn: number, oppK: number): void {
  let acts = E.legalActions(s);
  const me = s.turn,
    np = s.numPlayers;
  const ev = new Float64Array(acts.length);
  let mx = -1e18;
  for (let i = 0; i < acts.length; i++) {
    const action = acts[i];
    if (!action) continue;
    const c = E.clone(s);
    autoStep(c, action);
    ev[i] = AI.evalState(c, me, HARD);
    if (floatAt(ev, i) > mx) mx = floatAt(ev, i);
  }
  // opponent k-best pruning (3-4p): at opponent nodes keep only their top-K
  // plausible replies so the budget deepens OUR line instead of fanning out.
  if (oppK > 0 && me !== rootTurn && np >= 3 && acts.length > oppK) {
    const idx = Array.from(ev.keys())
      .sort((a, b) => floatAt(ev, b) - floatAt(ev, a))
      .slice(0, oppK);
    const selected: GameAction[] = [];
    for (const index of idx) {
      const action = acts[index];
      if (action) selected.push(action);
    }
    acts = selected;
    const ev2 = new Float64Array(oppK);
    for (let i = 0; i < oppK; i++) {
      const index = idx[i];
      if (index != null) ev2[i] = floatAt(ev, index);
    }
    mx = floatAt(ev2, 0);
    n.P = softmax(ev2, mx);
  } else {
    n.P = softmax(ev, mx);
  }
  n.acts = acts;
  n.keys = acts.map(actionKey);
  n.N = new Float64Array(acts.length);
  n.W = new Float64Array(acts.length);
  n.expanded = true;
}
function softmax(ev: Float64Array, mx: number): Float64Array {
  const P = new Float64Array(ev.length);
  let sum = 0;
  for (let i = 0; i < ev.length; i++) {
    P[i] = Math.exp((floatAt(ev, i) - mx) / PRIOR_T);
    sum += floatAt(P, i);
  }
  for (let i = 0; i < ev.length; i++) P[i] = floatAt(P, i) / sum;
  return P;
}

function select(n: ExpandedTreeNode, cpuct: number, mask: Uint8Array | null): number {
  let tot = 0;
  for (let i = 0; i < n.N.length; i++) tot += floatAt(n.N, i);
  const sq = Math.sqrt(tot) + 1e-8;
  let best = -1e18,
    bi = -1;
  for (let i = 0; i < n.acts.length; i++) {
    if (mask && mask[i]) continue;
    const visits = floatAt(n.N, i);
    const q = visits > 0 ? floatAt(n.W, i) / visits : 0;
    const u = (cpuct * floatAt(n.P, i) * sq) / (1 + visits);
    if (q + u > best) {
      best = q + u;
      bi = i;
    }
  }
  return bi;
}

// one iteration: fresh determinization → replay/descend → cheap leaf (or
// expand on revisit) → back up the per-seat value vector along the path
function simulate(root: TreeNode, G: GameState, cfg: VSearchOptions): void {
  const working = E.clone(G);
  determinize(working);
  const cpuct = cfg.cpuct != null ? cfg.cpuct : DEFAULT_CPUCT;
  const path: SearchPath = [];
  let n = root,
    vVec: Float64Array | null = null;
  while (true) {
    if (working.phase === 'gameover') {
      vVec = terminalVec(working);
      break;
    }
    if (!n.expanded) {
      n.seen++;
      if (n.seen < EXPAND_AT) {
        // one-shot leaf: cheap eval only
        vVec = cfg.endgame && working.lastRound ? endgameVec(working) : leafVec(working);
        break;
      }
      expandNode(n, working, G.turn, cfg.oppK || 0);
      if (!isExpanded(n) || !n.acts.length) {
        vVec = leafVec(working);
        break;
      }
    }
    if (!isExpanded(n)) {
      vVec = leafVec(working);
      break;
    }
    // select an action that is legal in THIS determinization (a capture/reserve
    // below a refill may reference a card that isn't there in this shuffle)
    let bi = -1,
      mask: Uint8Array | null = null;
    for (let tries = 0; tries < n.acts.length; tries++) {
      bi = select(n, cpuct, mask);
      if (bi < 0) break;
      const action = n.acts[bi];
      if (!action) {
        bi = -1;
        break;
      }
      const r = E.applyAction(working, action);
      if (r.ok) break;
      if (!mask) mask = new Uint8Array(n.acts.length);
      mask[bi] = 1;
      bi = -1;
    }
    if (bi < 0) {
      vVec = leafVec(working);
      break;
    } // nothing applicable here
    resolveTurn(working);
    E.endTurn(working);
    path.push([n, bi]);
    const key = n.keys[bi];
    if (!key) {
      vVec = leafVec(working);
      break;
    }
    let ch = n.children[key];
    if (!ch) {
      ch = mkNode(working.turn);
      n.children[key] = ch;
    }
    n = ch;
  }
  if (!vVec) return;
  for (const [nn, i] of path) {
    if (!isExpanded(nn)) continue;
    nn.N[i] = floatAt(nn.N, i) + 1;
    nn.W[i] = floatAt(nn.W, i) + floatAt(vVec, nn.turn);
  }
}

// returns the best engine action (or null).
// cfg = { sims, timeMs, cpuct, oppK, endgame }  — timeMs takes precedence.
function move(G: GameState, cfg: VSearchOptions = {}): GameAction | null {
  const sims = cfg.sims || 200;
  const deadline = cfg.timeMs ? Date.now() + cfg.timeMs : 0;
  const root = mkNode(G.turn);
  root.seen = EXPAND_AT; // root always expands immediately
  expandNode(root, G, G.turn, 0); // never prune OUR own actions
  if (!isExpanded(root) || !root.acts.length) return null;
  if (root.acts.length === 1) return root.acts[0] ?? null;
  let done = 0;
  const t0 = Date.now();
  while (true) {
    for (let b = 0; b < 16; b++) {
      simulate(root, G, cfg);
      done++;
    }
    // budget check
    let remaining;
    if (deadline) {
      const spent = Date.now() - t0;
      if (Date.now() >= deadline) break;
      remaining = Math.max(1, ((deadline - Date.now()) / Math.max(1, spent)) * done);
    } else {
      if (done >= sims) break;
      remaining = sims - done;
    }
    // early stop: the runner-up can no longer catch the leader
    let n1 = -1,
      n2 = -1;
    for (let i = 0; i < root.N.length; i++) {
      const visits = floatAt(root.N, i);
      if (visits > n1) {
        n2 = n1;
        n1 = visits;
      } else if (visits > n2) n2 = visits;
    }
    if (n1 - n2 > remaining) break;
  }
  let bi = 0,
    bn = -1;
  for (let i = 0; i < root.N.length; i++) {
    const visits = floatAt(root.N, i);
    if (visits > bn) {
      bn = visits;
      bi = i;
    }
  }
  return root.acts[bi] ?? null;
}

// chooseTurn-compatible plan: search picks the main action, then discard/evolution
// are resolved on the REAL state with the heuristic's own manager (matches the model).
function chooseTurn(G: GameState, opts: VSearchOptions = {}): TurnPlan {
  // First-Mega override (same discipline as AI.chooseTurn): qualification is
  // binary and the offer is contested — when our base's Mega is affordable and
  // we own none, spend the turn on the token; manage() megas the same turn.
  // The tree's leaf eval can't price the binary qualification, so don't let
  // "one more capture" lines outvote it.
  if (G.megasEnabled) {
    const p = playerAt(G, G.turn);
    const ownsMega = p.board.some((id) => cardById(G, id).tier === 'mega');
    if (!ownsMega && p.megaToken < 1 && (G.supply.megaToken ?? 0) > 0) {
      for (const mid of G.megaOffer || []) {
        const m = cardById(G, mid);
        if (p.board.some((id) => cardById(G, id).name === m.megaFrom) && E.canAfford(G, p, m)) {
          const c0 = E.clone(G);
          E.applyAction(c0, { type: 'takeMega' });
          const mp0 = AI.manage(c0, HARD);
          return {
            action: { type: 'takeMega' },
            discards: mp0.discards,
            evolution: mp0.evolution,
            megaEvolution: mp0.megaEvolution,
          };
        }
      }
    }
  }
  const a = move(G, opts);
  if (!a) return { action: null, discards: [], evolution: null, megaEvolution: null };
  const c = E.clone(G);
  E.applyAction(c, a);
  const plan = AI.manage(c, HARD);
  return {
    action: a,
    discards: plan.discards,
    evolution: plan.evolution,
    megaEvolution: plan.megaEvolution,
  };
}

const VSearch = { move, chooseTurn, autoStep };

export default VSearch;
export { autoStep, chooseTurn, move };
