/* =====================================================================
 * Pokémon Splendor — AI opponent
 * ---------------------------------------------------------------------
 * Evaluation-based, evolution-aware 1-ply search.
 *
 * Public:
 *   AI.chooseTurn(state, opts)  -> { action, discards:[color], evolution:{fromId,toId}|null }
 *   AI.playTurn(state, opts)    -> applies the plan to `state` (incl. endTurn)
 * ===================================================================== */
import E from './engine.js';
import { DEFAULT_W, evaluateState, type AiWeights, cardById, playerAt } from './ai-evaluation.js';
import type { AiConfig } from './api.js';
import type { GameAction, GameState, TokenColor, TurnPlan } from './types.js';

type EvolutionPlan = NonNullable<TurnPlan['evolution']>;
type MegaEvolutionPlan = NonNullable<TurnPlan['megaEvolution']>;
type ManagementPlan = {
  discards: TokenColor[];
  evolution: EvolutionPlan | null;
  megaEvolution: MegaEvolutionPlan | null;
};

const { ALL_TOKENS } = E;

const DIFF = {
  easy: { evoBias: 0.4, noise: 6, proximity: 0.5, deny: 0 },
  normal: { evoBias: 0.8, noise: 1.5, proximity: 1.0, deny: 0 },
  hard: { evoBias: 1.0, noise: 0, proximity: 1.0, deny: 10 },
};

let weights: AiWeights = Object.assign({}, DEFAULT_W);
let noise: (() => number) | null = null;

function evalState(s: GameState, pid: number, cfg: AiConfig | null): number {
  return evaluateState(s, pid, cfg, weights, noise);
}

// ---- best end-of-turn evolution (by static eval) on a clone ----
function bestEvolution(
  s: GameState,
  pid: number,
  cfg: AiConfig | null,
): ReturnType<typeof E.evolutionOptions>[number] | null {
  const opts = E.evolutionOptions(s, playerAt(s, pid));
  if (!opts.length) return null;
  const base = evalState(s, pid, null);
  let best: ReturnType<typeof E.evolutionOptions>[number] | null = null,
    bestScore = base;
  for (const o of opts) {
    const c = E.clone(s);
    const r = E.actionEvolve(c, o.fromId, o.toId);
    if (!r.ok) continue;
    const sc = evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8; // small intrinsic bonus: free VP/action
    if (sc > bestScore) {
      bestScore = sc;
      best = o;
    }
  }
  return best;
}

// score a full line: state already has the main action applied; manage
// discards + evolution on a clone and return the resulting eval.
function scoreLine(s: GameState, pid: number, cfg: AiConfig): number {
  const c = E.clone(s);
  manage(c, cfg);
  return evalState(c, pid, cfg);
}

// ---- best end-of-turn MEGA evolution (Megas expansion; shares the one
// evolution-per-turn slot with normal evolution — manage() picks the better).
function bestMegaEvolution(
  s: GameState,
  pid: number,
  cfg: AiConfig | null,
): { readonly opt: ReturnType<typeof E.megaEvolveOptions>[number]; readonly score: number } | null {
  if (!s.megasEnabled) return null;
  const opts = E.megaEvolveOptions(s, playerAt(s, pid));
  if (!opts.length) return null;
  let best: ReturnType<typeof E.megaEvolveOptions>[number] | null = null,
    bestScore = -Infinity;
  for (const o of opts) {
    const c = E.clone(s);
    const r = E.actionMegaEvolve(c, o.megaId, o.fromId);
    if (!r.ok) continue;
    const sc = evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8;
    if (sc > bestScore) {
      bestScore = sc;
      best = o;
    }
  }
  return best ? { opt: best, score: bestScore } : null;
}

// perform end-of-turn management (discard to 10, then best evolution) on `s`.
// returns { discards:[color], evolution:{fromId,toId}|null, megaEvolution:{megaId,fromId}|null }
function manage(s: GameState, cfg: AiConfig): ManagementPlan {
  const pid = s.turn;
  const p = playerAt(s, pid);
  const plan: ManagementPlan = { discards: [], evolution: null, megaEvolution: null };
  // discard greedily, choosing the color whose removal best preserves value
  while (E.needsDiscard(s, p)) {
    let bestColor = null,
      bestScore = -Infinity;
    for (const col of ALL_TOKENS) {
      if (!p.tokens[col]) continue;
      const c = E.clone(s);
      playerAt(c, pid).tokens[col]--;
      c.supply[col]++;
      // value the resulting position *including* the evolution we could still do
      const sc = evalWithEvo(c, pid, cfg);
      if (sc > bestScore) {
        bestScore = sc;
        bestColor = col;
      }
    }
    if (bestColor == null) break;
    E.actionDiscard(s, bestColor);
    plan.discards.push(bestColor);
  }
  // one evolution per turn: normal vs MEGA. The FIRST Mega is a hard priority:
  // it is a win-condition requirement and the offer is contested — a greedy
  // per-turn eval keeps deferring it (pays balls now, buries the base) and ends
  // up out-scoring yet UNQUALIFIED. Once a Mega is owned, compare by eval.
  const evo = bestEvolution(s, pid, cfg);
  const mega = bestMegaEvolution(s, pid, cfg);
  let useMega = false;
  if (mega) {
    const ownsMega = p.board.some((id) => cardById(s, id).tier === 'mega');
    if (!ownsMega || !evo) useMega = true;
    else {
      const c = E.clone(s);
      E.actionEvolve(c, evo.fromId, evo.toId);
      useMega = mega.score > evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8;
    }
  }
  if (useMega && mega) {
    E.actionMegaEvolve(s, mega.opt.megaId, mega.opt.fromId);
    plan.megaEvolution = { megaId: mega.opt.megaId, fromId: mega.opt.fromId };
  } else if (evo) {
    E.actionEvolve(s, evo.fromId, evo.toId);
    plan.evolution = { fromId: evo.fromId, toId: evo.toId };
  }
  return plan;
}

function evalWithEvo(s: GameState, pid: number, cfg: AiConfig): number {
  const evo = bestEvolution(s, pid, cfg);
  if (!evo) return evalState(s, pid, cfg);
  const c = E.clone(s);
  E.actionEvolve(c, evo.fromId, evo.toId);
  return evalState(c, pid, cfg);
}

// ---- choose the whole turn (1-ply eval search) ----
function chooseTurn(
  s: GameState,
  opts: { readonly difficulty?: keyof typeof DIFF } = {},
): TurnPlan {
  const cfg = DIFF[opts.difficulty ?? 'hard'];
  const pid = s.turn;
  const acts = E.legalActions(s);
  if (!acts.length) return { action: null, discards: [], evolution: null, megaEvolution: null };

  // deterministic-ish noise per call (so 'easy' varies without Math.random in engine)
  let seed = (s.round * 131 + s.turn * 17 + acts.length * 7) >>> 0;
  noise = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296 - 0.5;
  };

  // Mega discipline (1-ply only; the deep search handles this via lookahead):
  // qualification is BINARY — without a Mega you cannot win at all, and the offer
  // is contested. A greedy eval always prefers "one more capture" and defers the
  // Mega forever, so the FIRST Mega is an OVERRIDE, not an eval competitor:
  // the moment a Mega we own the base of is affordable, spend the turn on the
  // token (manage() then mega-evolves the same turn). Mirrors the policy that
  // play-tested strongest; further Megas compete on eval like everything else.
  const pMe = playerAt(s, pid);
  if (s.megasEnabled && !pMe.board.some((id) => cardById(s, id).tier === 'mega')) {
    const tokenAct = acts.find((a) => a.type === 'takeMega');
    if (tokenAct) {
      for (const mid of s.megaOffer || []) {
        const m = cardById(s, mid);
        if (pMe.board.some((id) => cardById(s, id).name === m.megaFrom) && E.canAfford(s, pMe, m)) {
          noise = null;
          const c0 = E.clone(s);
          E.applyAction(c0, tokenAct);
          const mp0 = manage(c0, cfg);
          return {
            action: tokenAct,
            discards: mp0.discards,
            evolution: mp0.evolution,
            megaEvolution: mp0.megaEvolution,
          };
        }
      }
    }
  }
  let best: GameAction | null = null,
    bestScore = -Infinity;
  for (const a of acts) {
    if (a.type === 'takeMega') continue; // token-taking is handled by the override above
    const c = E.clone(s);
    const r = E.applyAction(c, a);
    if (!r.ok) continue;
    const sc = scoreLine(c, pid, cfg);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  noise = null;
  best ??= acts[0] ?? null;
  if (!best) return { action: null, discards: [], evolution: null, megaEvolution: null };

  // recompute the concrete discard + evolution plan on the real chosen line
  const c = E.clone(s);
  E.applyAction(c, best);
  const mp = manage(c, cfg);
  return {
    action: best,
    discards: mp.discards,
    evolution: mp.evolution,
    megaEvolution: mp.megaEvolution,
  };
}

// ---- apply a chosen plan to the live state (used headless; UI animates) ----
function playTurn(
  s: GameState,
  opts: { readonly difficulty?: keyof typeof DIFF } = {},
): { readonly plan: TurnPlan; readonly endTurn: ReturnType<typeof E.endTurn> } {
  const plan = chooseTurn(s, opts);
  if (plan.action) E.applyAction(s, plan.action);
  else E.actionPass(s); // no legal main action available
  for (const col of plan.discards) E.actionDiscard(s, col);
  if (plan.megaEvolution)
    E.actionMegaEvolve(s, plan.megaEvolution.megaId, plan.megaEvolution.fromId);
  else if (plan.evolution) E.actionEvolve(s, plan.evolution.fromId, plan.evolution.toId);
  const r = E.endTurn(s);
  return { plan, endTurn: r };
}

const AI = {
  chooseTurn,
  playTurn,
  evalState,
  bestEvolution,
  bestMegaEvolution,
  manage,
  DIFF,
  DEFAULT_W,
  getWeights: () => Object.assign({}, weights),
  setWeights: (w: Readonly<Record<string, number>>) => {
    weights = Object.assign({}, DEFAULT_W, w);
  },
};

export default AI;
export {
  DEFAULT_W,
  DIFF,
  bestEvolution,
  bestMegaEvolution,
  chooseTurn,
  evalState,
  manage,
  playTurn,
};
