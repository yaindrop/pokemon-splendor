import type { EngineApi } from './api.js';
import type {
  BaseTier,
  CaptureOptions,
  Card,
  GameAction,
  GameState,
  Player,
  TokenColor,
} from './types.js';
import {
  COLORS,
  FIELD_TIERS,
  HAND_MAX,
  MEGA_WIN_SCORE,
  NORMAL_TIERS,
  PM_EFFECTS_LIVE,
  PM_TIERS,
  TOKEN_MAX,
  WIN_SCORE,
  cardById,
  deckAt,
  effectParamOf,
  fieldAt,
  fieldTiers,
  isPokemart,
  playerAt,
  type EvolutionOption,
  type FieldTier,
  type MegaEvolutionOption,
  type TurnState,
} from './engine-support.js';
import {
  activePlayer,
  bonuses,
  canAfford,
  computePayment,
  effBonusColor,
  locateCard,
  log,
  payDesc,
  payTokens,
  refill,
  scoreOf,
  tokenTotal,
  zhBall,
} from './engine-state.js';
import { freeTakeable, freeTiers } from './engine-actions.js';

function evolutionOptions(s: GameState, player: Player): EvolutionOption[] {
  const opts: EvolutionOption[] = [];
  if (s.evolvedThisTurn) return opts; // only one evolution per turn
  const b = bonuses(s, player);
  // available evolution targets: field cards + this player's reserve
  const avail: Array<
    | {
        readonly id: string;
        readonly where: 'field';
        readonly tier: BaseTier;
        readonly slot: number;
      }
    | { readonly id: string; readonly where: 'reserve'; readonly slot: number }
  > = [];
  for (const tier of FIELD_TIERS)
    s.field[tier].forEach((id, slot) => {
      if (id) avail.push({ id, where: 'field', tier, slot });
    });
  player.reserve.forEach((id, slot) => avail.push({ id, where: 'reserve', slot }));
  for (const id of player.board) {
    const c = cardById(s, id);
    if (!c.evolvesTo || !c.evoCost) continue;
    // Affordability: evolution is paid ONLY by the discount balls on your
    // captured cards (bonuses) — never by the balls you hold (tokens). You
    // must already own enough discounts of the required color to cover the
    // full evolution cost; nothing is spent.
    if (b[c.evoCost.color] < c.evoCost.count) continue;
    for (const a of avail) {
      if (cardById(s, a.id).name !== c.evolvesTo) continue;
      opts.push({
        fromId: id,
        toId: a.id,
        color: c.evoCost.color,
        count: c.evoCost.count,
        targetWhere: a.where,
      });
    }
  }
  return opts;
}

function actionEvolve(
  s: GameState,
  fromId: string,
  toId?: string,
): ReturnType<EngineApi['actionEvolve']> {
  const p = activePlayer(s);
  if (s.evolvedThisTurn) return { ok: false, error: '本回合已进化过' };
  const cands = evolutionOptions(s, p).filter((o) => o.fromId === fromId);
  const opt = toId != null ? cands.find((o) => o.toId === toId) : cands[0];
  if (!opt) return { ok: false, error: '不满足进化条件' };
  // No tokens are spent: evolution is paid entirely by the discounts on your
  // captured cards (affordability already verified in evolutionOptions).
  // move target out of field/reserve
  const loc = locateCard(s, opt.toId);
  if (loc.where === 'field') {
    fieldAt(s, loc.tier)[loc.slot] = null;
    refill(s, loc.tier);
  } else if (loc.where === 'reserve') {
    playerAt(s, loc.owner).reserve.splice(loc.slot, 1);
  }
  // replace on board: remove fromId -> buried; add toId
  const bi = p.board.indexOf(fromId);
  p.board.splice(bi, 1);
  p.buried.push(fromId);
  p.board.push(opt.toId);
  s.evolvedThisTurn = true;
  log(s, `${p.name} 将 ${cardById(s, fromId).name} 进化为 ${cardById(s, opt.toId).name}`);
  return { ok: true, fromId, toId: opt.toId };
}

// ----------------------- Megas expansion ---------------------------
// Main action: spend your whole turn to take one Mega token (max 1 held).
function actionTakeMega(s: GameState): ReturnType<EngineApi['actionTakeMega']> {
  const p = activePlayer(s);
  if (!s.megasEnabled) return { ok: false, error: '未启用 Megas 扩展' };
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (p.megaToken >= 1) return { ok: false, error: '已持有 Mega 代币（上限1）' };
  if ((s.supply.megaToken ?? 0) < 1) return { ok: false, error: '没有可用的 Mega 代币' };
  s.supply.megaToken = (s.supply.megaToken ?? 0) - 1;
  p.megaToken++;
  s.acted = true;
  log(s, `${p.name} 获得了 1 个 Mega 代币`);
  return { ok: true };
}

// End-of-turn Mega evolution options. Requires: you hold a Mega token, you
// have captured the base Pokémon (megaFrom) in play, and you can pay the Mega
// card's cost (balls reduced by bonuses; master ball substitutes). Counts as
// this turn's single evolution (shares evolvedThisTurn).
function megaEvolveOptions(s: GameState, player: Player): MegaEvolutionOption[] {
  const opts: MegaEvolutionOption[] = [];
  if (!s.megasEnabled || s.evolvedThisTurn || player.megaToken < 1) return opts;
  for (const megaId of s.megaOffer) {
    const mega = cardById(s, megaId);
    const fromId = player.board.find((id) => cardById(s, id).name === mega.megaFrom);
    if (!fromId) continue;
    if (!canAfford(s, player, mega)) continue;
    if (!mega.megaFrom) continue;
    opts.push({ megaId, fromId, fromName: mega.megaFrom, megaName: mega.name });
  }
  return opts;
}

function actionMegaEvolve(
  s: GameState,
  megaId: string,
  fromId?: string,
): ReturnType<EngineApi['actionMegaEvolve']> {
  const p = activePlayer(s);
  if (!s.megasEnabled) return { ok: false, error: '未启用 Megas 扩展' };
  if (s.evolvedThisTurn) return { ok: false, error: '本回合已进化过' };
  const cands = megaEvolveOptions(s, p).filter((o) => o.megaId === megaId);
  const opt = fromId != null ? cands.find((o) => o.fromId === fromId) : cands[0];
  if (!opt) return { ok: false, error: '不满足超级进化条件' };
  const mega = cardById(s, megaId);
  const payment = computePayment(s, p, mega);
  if (!payment.ok) return { ok: false, error: payment.error };
  payTokens(s, p, payment.pay);
  // consume the Mega token (returns to the shared pool)
  p.megaToken--;
  s.supply.megaToken = (s.supply.megaToken ?? 0) + 1;
  // bury the base Pokémon, take the Mega card out of the offer, place it in play
  const bi = p.board.indexOf(opt.fromId);
  p.board.splice(bi, 1);
  p.buried.push(opt.fromId);
  s.megaOffer = s.megaOffer.filter((id) => id !== megaId);
  p.board.push(megaId);
  s.evolvedThisTurn = true;
  log(
    s,
    `${p.name} 将 ${cardById(s, opt.fromId).name} 超级进化为 ${mega.name}（${payDesc(payment.pay)}）`,
  );
  return { ok: true, megaId, fromId: opt.fromId };
}

// Win trigger. Base game: 18 VP. Megas: 20 VP AND ≥1 captured card of every
// color AND ≥1 Mega in play.
function hasMegaWin(s: GameState, p: Player): boolean {
  if (scoreOf(s, p) < MEGA_WIN_SCORE) return false;
  const b = bonuses(s, p);
  if (!COLORS.every((c) => b[c] > 0)) return false;
  return p.board.some((id) => cardById(s, id).tier === 'mega');
}
function winTriggered(s: GameState, p: Player): boolean {
  return s.megasEnabled ? hasMegaWin(s, p) : scoreOf(s, p) >= (s.winScore || WIN_SCORE);
}

// --------------------------- discard -------------------------------
function needsDiscard(s: GameState, player: Player): boolean {
  return tokenTotal(player) > TOKEN_MAX;
}
function actionDiscard(s: GameState, color: TokenColor): ReturnType<EngineApi['actionDiscard']> {
  const p = activePlayer(s);
  if (!p.tokens[color]) return { ok: false, error: '没有该精灵球' };
  p.tokens[color]--;
  s.supply[color]++;
  log(s, `${p.name} 归还了1个${zhBall(color)}`);
  return { ok: true };
}

// A legitimate pass: only allowed when the player genuinely has no legal
// main action (e.g. supply drained, nothing affordable, hand full).
function actionPass(s: GameState): ReturnType<EngineApi['actionPass']> {
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (legalActions(s).length) return { ok: false, error: '尚有可执行的行动' };
  s.acted = true;
  log(s, `${activePlayer(s).name} 无法行动，跳过回合`);
  return { ok: true };
}

// --------------------------- turn flow -----------------------------
// Call after the main action. Resolves discard requirement and lets the
// caller present evolution options; then endTurn() advances.
function turnState(s: GameState): TurnState {
  const p = activePlayer(s);
  return {
    acted: s.acted,
    mustDiscard: needsDiscard(s, p) ? tokenTotal(p) - TOKEN_MAX : 0,
    evolutions: evolutionOptions(s, p),
    megaEvolutions: megaEvolveOptions(s, p),
  };
}

function endTurn(s: GameState): ReturnType<EngineApi['endTurn']> {
  const p = activePlayer(s);
  if (!s.acted) return { ok: false, error: '尚未行动' };
  if (needsDiscard(s, p)) return { ok: false, error: '请先归还多余精灵球（上限10）' };
  // check win trigger (someone reached the target this turn)
  if (winTriggered(s, p) && !s.lastRound) {
    s.lastRound = true;
    const why = s.megasEnabled
      ? `${MEGA_WIN_SCORE}分+集齐每色+1只Mega`
      : `${s.winScore || WIN_SCORE} 分`;
    log(s, `${p.name} 达成胜利条件（${why}），进入最后一轮！`);
  }
  // The game ends once the LAST player of the round finishes during the
  // final round, so every Trainer has taken an equal number of turns.
  const wasLastPlayer = s.turn === s.numPlayers - 1;
  if (s.lastRound && wasLastPlayer) {
    s.phase = 'gameover';
    s.winner = determineWinner(s);
    log(s, `游戏结束，胜者：${playerAt(s, s.winner).name}`);
    return { ok: true, gameover: true };
  }
  s.turn = (s.turn + 1) % s.numPlayers;
  if (wasLastPlayer) s.round++;
  s.acted = false;
  s.taken = [];
  s.evolvedThisTurn = false;
  return { ok: true };
}

function determineWinner(s: GameState): number {
  // most VP, then most buried (evolutions), then most board cards
  const rank = (p: Player): readonly [number, number, number] => [
    scoreOf(s, p),
    p.buried.length,
    p.board.length,
  ];
  // Eligibility: in the Megas variant only a player who actually achieves the
  // win condition (20 VP + every colour + a Mega in play) can win — a rival with
  // more raw points but no Mega/colour set does NOT. (Base game: everyone is
  // eligible; the highest score already implies they crossed the threshold.)
  let pool: number[] = [];
  for (let i = 0; i < s.numPlayers; i++) pool.push(i);
  if (s.megasEnabled) {
    const q = pool.filter((i) => hasMegaWin(s, playerAt(s, i)));
    if (q.length) pool = q; // fall back to all only in the pathological "nobody qualifies" case
  }
  let best = pool[0] ?? 0;
  for (const i of pool) {
    const a = rank(playerAt(s, i)),
      b = rank(playerAt(s, best));
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = i;
  }
  return best;
}

// ------------------- legal move enumeration (for AI) ---------------
// Auto-plan the choice parameters of an effect capture so search/AI can play
// Pokémart cards without a UI: copy targets pick the player's DEEPEST bonus
// colour (coherence), discard_buy sacrifices the least valuable owned cards,
// free-takes pick the best available card (VP, bonuses, evolvability) and
// recurse for chained effects. Returns an opts object for actionCapture.
function autoCaptureOpts(s: GameState, p: Player, card: Card): CaptureOptions {
  const opts: {
    copyTargetId?: string;
    discardCards?: string[];
    freeTakeId?: string;
    freeOpts?: CaptureOptions;
  } = {};
  const pickCopyTarget = (): string | null => {
    const cands = p.board.filter((id) => effBonusColor(s, p, id));
    if (!cands.length) return null;
    const b = bonuses(s, p);
    let best = cands[0] ?? null,
      bs = -1;
    for (const id of cands) {
      const color = effBonusColor(s, p, id);
      if (!color) continue;
      const value = b[color];
      if (value > bs) {
        bs = value;
        best = id;
      }
    }
    return best;
  };
  if (card.effect === 'copy' || card.effect === 'copy_free') {
    const t = pickCopyTarget();
    if (t) opts.copyTargetId = t;
  }
  if (card.effect === 'discard_buy') {
    const params = effectParamOf(card);
    const col = params.discardColor;
    const need = params.discardCount ?? 0;
    const owned = p.board.filter((id) => effBonusColor(s, p, id) === col);
    // sacrifice the least valuable first: low VP, not evolvable, single bonus
    owned.sort((a, c) => {
      const A = cardById(s, a),
        C = cardById(s, c);
      return (
        (A.vp || 0) * 4 +
        (A.evolvesTo ? 3 : 0) +
        (A.bonusCount || 1) -
        ((C.vp || 0) * 4 + (C.evolvesTo ? 3 : 0) + (C.bonusCount || 1))
      );
    });
    opts.discardCards = owned.slice(0, need);
  }
  if (card.effect === 'free' || card.effect === 'copy_free') {
    let best: Card | null = null,
      bs = -1e9;
    for (const t of freeTiers(card))
      for (const id of fieldAt(s, t)) {
        if (!id) continue;
        const fc = cardById(s, id);
        if (!freeTakeable(s, p, fc)) continue;
        const v = (fc.vp || 0) * 3 + (fc.bonusCount || 1) * 2 + (fc.evolvesTo ? 1 : 0);
        if (v > bs) {
          bs = v;
          best = fc;
        }
      }
    if (best) {
      opts.freeTakeId = best.id;
      const sub: { copyTargetId?: string; freeTakeId?: string; freeOpts?: CaptureOptions } = {};
      if (isPokemart(best) && (best.effect === 'copy' || best.effect === 'copy_free')) {
        const t = pickCopyTarget();
        if (t) sub.copyTargetId = t;
      }
      if (isPokemart(best) && (best.effect === 'free' || best.effect === 'copy_free')) {
        // chained free-take: plan one level deep with the same rule
        const rec = autoCaptureOpts(s, p, best);
        if (rec.freeTakeId) {
          sub.freeTakeId = rec.freeTakeId;
          sub.freeOpts = rec.freeOpts || {};
        }
      }
      opts.freeOpts = sub;
    }
    // no takeable free card → effect fizzles, capture still legal (planFree allows it)
  }
  return opts;
}

function legalActions(s: GameState): GameAction[] {
  const p = activePlayer(s);
  if (s.acted || s.phase !== 'play') return [];
  const acts: GameAction[] = [];
  // Megas: spending the whole turn on a Mega token is a real action — the AI
  // must be able to plan it (required for the 20VP+colours+Mega win).
  if (s.megasEnabled && p.megaToken < 1 && (s.supply.megaToken ?? 0) > 0 && s.megaOffer.length) {
    acts.push({ type: 'takeMega' });
  }
  // takes
  const avail = COLORS.filter((c) => s.supply[c] > 0);
  // 3 distinct
  for (let i = 0; i < avail.length; i++)
    for (let j = i + 1; j < avail.length; j++)
      for (let k = j + 1; k < avail.length; k++) {
        const first = avail[i],
          second = avail[j],
          third = avail[k];
        if (first && second && third) acts.push({ type: 'take', colors: [first, second, third] });
      }
  // fewer-than-3 distinct only if <3 colors available
  const first = avail[0],
    second = avail[1];
  if (avail.length === 2 && first && second) acts.push({ type: 'take', colors: [first, second] });
  if (avail.length === 1 && first) acts.push({ type: 'take', colors: [first] });
  // 2 same
  for (const c of COLORS) if (s.supply[c] >= 4) acts.push({ type: 'take', colors: [c, c] });
  // captures (field + own reserve). Pokémart cards with not-yet-live effects
  // are excluded so the AI never picks a capture the engine will reject.
  const capIds: string[] = [];
  for (const tier of fieldTiers(s)) for (const id of fieldAt(s, tier)) if (id) capIds.push(id);
  for (const id of p.reserve) capIds.push(id);
  for (const id of capIds) {
    const card = cardById(s, id);
    if (isPokemart(card) && card.effect) {
      if (!PM_EFFECTS_LIVE[card.effect]) continue;
      if (card.effect === 'discard_buy') {
        const params = effectParamOf(card);
        const col = params.discardColor;
        const need = params.discardCount;
        if (!col || need == null) continue;
        const owned = p.board.filter((bid) => effBonusColor(s, p, bid) === col).length;
        if (owned >= need)
          acts.push({ type: 'capture', cardId: id, opts: autoCaptureOpts(s, p, card) });
        continue;
      }
      if (card.effect === 'copy' || card.effect === 'copy_free') {
        // need an owned bonus card to copy
        if (p.board.some((bid) => effBonusColor(s, p, bid)) && canAfford(s, p, card))
          acts.push({ type: 'capture', cardId: id, opts: autoCaptureOpts(s, p, card) });
        continue;
      }
      if (card.effect === 'free' && canAfford(s, p, card)) {
        // TM: free take auto-planned
        acts.push({ type: 'capture', cardId: id, opts: autoCaptureOpts(s, p, card) });
        continue;
      }
      // double / colorless_master capture like a normal card
      if ((card.effect === 'double' || card.effect === 'colorless_master') && canAfford(s, p, card))
        acts.push({ type: 'capture', cardId: id });
      continue;
    }
    if (canAfford(s, p, card)) acts.push({ type: 'capture', cardId: id });
  }
  // reserves (base levels + Pokémart levels)
  if (p.reserve.length < HAND_MAX) {
    const reserveTiers: readonly FieldTier[] = s.pokemartEnabled
      ? [...NORMAL_TIERS, ...PM_TIERS]
      : NORMAL_TIERS;
    for (const tier of reserveTiers) {
      for (const id of fieldAt(s, tier))
        if (id) acts.push({ type: 'reserve', target: { fromField: id } });
      if (deckAt(s, tier).length) acts.push({ type: 'reserve', target: { fromDeck: tier } });
    }
  }
  return acts;
}

export {
  actionDiscard,
  actionEvolve,
  actionMegaEvolve,
  actionPass,
  actionTakeMega,
  autoCaptureOpts,
  determineWinner,
  endTurn,
  evolutionOptions,
  legalActions,
  megaEvolveOptions,
  needsDiscard,
  turnState,
};
