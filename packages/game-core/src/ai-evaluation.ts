import E from './engine.js';
import type { AiConfig } from './api.js';
import type { Card, GameState, Player } from './types.js';

const { COLORS, FIELD_TIERS } = E;

// Eval weights — SPSA-tuned via self-play (test/tune.js). The tuned set beats the original hand-set
// weights at EVERY player count (2p 62%, 3p 40.7% vs 33.3 fair, 4p 31.7% vs 25 fair) and still
// crushes greedy (88%). VP scale fixed at 100 (anchor); the rest relative. test/tune.js re-tunes vs
// whatever is here. (Original hand values: vpEnd45 lastRound70 cards16 rl14 bonus4 coh5/3 distinct3
// overstack3 tok1.0/.35/1.6 purple2 reserve.5 prox11/.4 proxBonus1.5 proxEvo.7 rlProx6/3 gapDiv1.4 evo6 deny1.)
export const DEFAULT_W = {
  vpEnd: 41.475,
  lastRound: 66.966,
  cards: 17.529,
  rl: 13.512,
  bonus: 4.436,
  coh1: 5.053,
  coh2: 3.138,
  distinct: 3.225,
  overstack: 3.276,
  tok1: 0.92,
  tok2: 0.357,
  tokPen: 1.514,
  purple: 1.969,
  reserve: 0.572,
  prox: 8.617,
  prox2: 0.435,
  proxBonus: 1.418,
  proxEvo: 0.586,
  rlProxE: 5.655,
  rlProxL: 3.161,
  gapDiv: 1.417,
  evo: 6.211,
  denyMul: 1.023,
  // --- expansion terms (hand-set, A/B-validated; only active when the expansion is on) ---
  megaTok: 14, // holding the Mega token (max 1; required for the Megas win)
  megaCover: 5, // per colour with ≥1 bonus (the win needs ALL five colours)
  megaOwn: 18, // owning ≥1 Mega in play (win requirement, beyond its VP)
  megaProx: 9, // proximity to an achievable Mega on offer (base owned)
  pokedex: 3, // each held POKÉDEX ≈ 2 bankable wildcard balls
};

export type AiWeights = Record<keyof typeof DEFAULT_W, number>;

const speciesCache = new WeakMap<GameState, ReadonlyMap<string, Card>>();

export function playerAt(state: GameState, index: number): Player {
  const player = state.players[index];
  if (!player) throw new Error(`未知训练家席位：${index}`);
  return player;
}

export function cardById(state: GameState, id: string): Card {
  const card = state.byId[id];
  if (!card) throw new Error(`未知卡牌：${id}`);
  return card;
}

function fieldCards(
  state: GameState,
  tier: Parameters<typeof E.refill>[1],
): readonly (string | null)[] {
  return state.field[tier] ?? [];
}

// ---- static position evaluation from player `pid`'s perspective ----
export function evaluateState(
  s: GameState,
  pid: number,
  cfg: AiConfig | null,
  weights: AiWeights,
  random: (() => number) | null,
): number {
  const p = playerAt(s, pid);
  const b = E.bonuses(s, p);
  const vp = E.scoreOf(s, p);
  let score = 0;

  score += vp * 100; // VP is king (fixed anchor scale)
  const winVP = s.megasEnabled ? 20 : s.winScore || 18;
  if (vp >= winVP - 7) score += (vp - (winVP - 7)) * weights.vpEnd; // endgame push, relative to the real target
  if (s.lastRound) score += vp * weights.lastRound; // race hard once final round is on

  // engine: owned bonus cards + total discount power are highly valued so
  // the AI keeps capturing rather than hoarding tokens.
  const cards = p.board.length;
  score += cards * weights.cards;
  // 神兽/稀有 (rare/legend) anchor a colour high-score flow: 2 same-colour discounts
  // (+2VP for legend). Owning them is worth extra beyond a normal card.
  let rlOwned = 0;
  for (const id of p.board) {
    const t = cardById(s, id).tier;
    if (t === 'rare' || t === 'legend') rlOwned++;
  }
  score += rlOwned * weights.rl; // specials anchor a colour flow (2 same-colour discounts, can't be blocked)
  let totalBonus = 0;
  const bvals: number[] = [];
  for (const c of COLORS) {
    totalBonus += b[c];
    bvals.push(b[c]);
  }
  score += totalBonus * weights.bonus;
  // colour COHERENCE (高分流): a deep primary + a moderate secondary colour are what
  // unlock the expensive same-colour high-VP cards. Reward concentration over a flat
  // 1-of-each spread, but keep ≥2 colours (2-colour high cards) and lightly punish hoarding.
  bvals.sort((x, y) => y - x);
  score += Math.min(bvals[0] ?? 0, 4) * weights.coh1 + Math.min(bvals[1] ?? 0, 3) * weights.coh2;
  const distinct = bvals.filter((v) => v > 0).length;
  score += Math.min(distinct, 2) * weights.distinct;
  if ((bvals[0] ?? 0) > 5) score -= ((bvals[0] ?? 0) - 5) * weights.overstack; // mild anti-overstack

  // tokens: concave value with a real anti-hoard penalty past 8 so the AI
  // converts tokens into cards instead of sitting at the 10 limit.
  const toks = E.tokenTotal(p);
  score += Math.min(toks, 5) * weights.tok1 + Math.max(0, Math.min(toks, 8) - 5) * weights.tok2;
  score -= Math.max(0, toks - 8) * weights.tokPen;
  score += p.tokens.purple * weights.purple; // master balls are flexible
  // Reserving is a tempo cost: keep its value low so the AI only reserves when
  // the search proves it sets up a strong capture (or grabs a master when stuck).
  score += p.reserve.length * weights.reserve;

  // proximity: reward being close to capturing the single most attractive
  // scoring card (field or hand). Weighted highly so the AI takes the RIGHT
  // balls toward a high-VP target instead of grabbing 0-VP junk.
  const early = s.round <= 6;
  const targets: string[] = [];
  for (const tier of E.fieldTiers(s))
    for (const id of fieldCards(s, tier)) if (id) targets.push(id); // incl. Pokémart rows
  for (const id of p.reserve) targets.push(id);
  let bestProx = 0,
    prox2 = 0;
  for (const id of targets) {
    const card = cardById(s, id);
    // evolved potential: a cheap card (御五家 3-2) that evolves into VP is worth reaching for
    let evoVP = 0;
    if (card.evolvesTo) {
      const t = DBfind(s, card.evolvesTo);
      if (t) evoVP = Math.max(0, t.vp - (card.vp || 0));
    }
    // Pokémart effect worth (the card's ability, beyond VP/bonus)
    let effW = 0;
    if (E.isPokemart(card) && card.effect) {
      if (card.effect === 'discard_buy') continue; // paid with cards, not balls — not a token target
      effW =
        card.effect === 'colorless_master'
          ? 2 * weights.purple // 图鉴 = 2 bankable wildcards
          : card.effect === 'free'
            ? 2 // 技能机 free take
            : card.effect === 'copy_free'
              ? 2.5 // 神奇糖果 assoc + free take
              : card.effect === 'copy'
                ? 1
                : 1; // 进化石 / 药水
    }
    if (!card.vp && card.tier !== 'rare' && evoVP <= 0 && effW <= 0) continue;
    let gap = card.cost.purple || 0;
    for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - b[c] - p.tokens[c]);
    let worth =
      (card.vp || 0) + (card.bonusCount || 1) * weights.proxBonus + evoVP * weights.proxEvo + effW;
    if (card.tier === 'rare' || card.tier === 'legend')
      worth += early ? weights.rlProxE : weights.rlProxL; // engine anchor, esp. early
    const v = worth / (1 + gap * weights.gapDiv);
    if (v > bestProx) {
      prox2 = bestProx;
      bestProx = v;
    } else if (v > prox2) prox2 = v;
  }
  score += (bestProx + prox2 * weights.prox2) * weights.prox * (cfg ? cfg.proximity : 1); // top-2 → coherent multi-card lineup

  // opponent denial: lines that cut the strongest opponent's proximity to a big card
  // (e.g. capturing/reserving the card they were about to buy) are rewarded. Encodes the
  // "slow other players down / reserve what they need" principle in a 1-ply eval.
  if (cfg && cfg.deny) {
    let oppMax = 0;
    for (let q = 0; q < s.numPlayers; q++) {
      if (q === pid) continue;
      const op = playerAt(s, q),
        ob = E.bonuses(s, op);
      let oprox = 0;
      for (const tier of FIELD_TIERS)
        for (const id of s.field[tier]) {
          if (!id) continue;
          const card = cardById(s, id);
          const rl = card.tier === 'rare' || card.tier === 'legend';
          if ((card.vp || 0) < 2 && !rl) continue;
          let gap = card.cost.purple || 0;
          for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - ob[c] - op.tokens[c]);
          const v = ((card.vp || 0) + (rl ? 3 : 0)) / (1 + gap * 1.4);
          if (v > oprox) oprox = v;
        }
      if (oprox > oppMax) oppMax = oprox;
    }
    score -= oppMax * cfg.deny * weights.denyMul;
  }

  // evolution potential: a caught Pokémon whose next form is available and
  // roughly affordable is nearly-free VP next turn — reward keeping such chains.
  for (const id of p.board) {
    const card = cardById(s, id);
    if (!card.evolvesTo || !card.evoCost) continue;
    let avail = false;
    for (const tier of FIELD_TIERS)
      for (const fid of s.field[tier])
        if (fid && cardById(s, fid).name === card.evolvesTo) avail = true;
    for (const rid of p.reserve) if (cardById(s, rid).name === card.evolvesTo) avail = true;
    if (!avail) continue;
    // Evolution is paid only by discounts (bonuses), not tokens: reward chains
    // whose evo color is already (nearly) covered by owned discounts.
    const need = Math.max(0, card.evoCost.count - b[card.evoCost.color]);
    const tgt = DBfind(s, card.evolvesTo);
    const gain = tgt ? Math.max(0, tgt.vp - card.vp) : 1;
    score += (gain * weights.evo) / (1 + need);
  }

  // --- Pokémart: held POKÉDEX cards are 2 bankable wildcards each ---
  if (s.pokemartEnabled) {
    let dex = 0;
    for (const id of p.board) {
      const c = cardById(s, id);
      if (E.isPokemart(c) && c.effect === 'colorless_master') dex++;
    }
    score += dex * weights.pokedex;
  }

  // --- Megas: the WIN CONDITION changes (20 VP + ≥1 bonus of EVERY colour +
  // ≥1 Mega in play; unqualified players cannot win at all). Value the pieces. ---
  if (s.megasEnabled) {
    const ownMega = p.board.some((id) => cardById(s, id).tier === 'mega');
    let covered = 0;
    for (const c of COLORS) if (b[c] > 0) covered++;
    score += (p.megaToken || 0) * weights.megaTok;
    score += covered * weights.megaCover;
    if (ownMega) score += weights.megaOwn;
    // proximity to an achievable Mega on offer (we own its base Pokémon)
    let mp = 0;
    for (const mid of s.megaOffer || []) {
      const m = cardById(s, mid);
      let baseVp = -1;
      for (const id of p.board) {
        const c = cardById(s, id);
        if (c.name === m.megaFrom) {
          baseVp = c.vp || 0;
          break;
        }
      }
      if (baseVp < 0) continue;
      let gap = 0;
      for (const c of COLORS) gap += Math.max(0, (m.cost[c] || 0) - b[c] - p.tokens[c]);
      if (p.megaToken < 1) gap += 2; // still need the token ≈ a full turn away
      const worth = Math.max(0, (m.vp || 0) - baseVp) + (m.bonusCount || 1) + 4; // +4: win-critical piece
      const v = worth / (1 + gap * weights.gapDiv);
      if (v > mp) mp = v;
    }
    score += mp * weights.megaProx;
    // last-round reality check: only a QUALIFIED player can win under Megas
    if (s.lastRound && vp >= 20 && covered === 5 && ownMega) score += weights.lastRound * 6;
  }

  if (cfg?.noise) score += (random?.() ?? 0) * cfg.noise;
  return score;
}

// best (highest-VP) card of a given species among all cards — for estimating
// evolution VP gain. Cached per state.
function DBfind(s: GameState, name: string): Card | null {
  let byName = speciesCache.get(s);
  if (!byName) {
    const index = new Map<string, Card>();
    for (const card of Object.values(s.byId)) {
      const current = index.get(card.name);
      if (!current || card.vp > current.vp) index.set(card.name, card);
    }
    byName = index;
    speciesCache.set(s, byName);
  }
  return byName.get(name) ?? null;
}
