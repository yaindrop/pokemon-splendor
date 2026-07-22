import type { EngineApi } from './api.js';
import type { ActionResult, CaptureOptions, Card, Color, GameState, Player } from './types.js';
import {
  COLORS,
  HAND_MAX,
  PM_EFFECTS_LIVE,
  cardById,
  deckAt,
  effectParamOf,
  fieldAt,
  isPokemart,
  isReservableTier,
  type CardLocation,
  type FieldTier,
  type FreePlan,
  type FreeStep,
  type ReserveTarget,
} from './engine-support.js';
import {
  activePlayer,
  computePayment,
  effBonusColor,
  locateCard,
  log,
  payDesc,
  payTokens,
  refill,
  zhBall,
  zhTier,
} from './engine-state.js';

function actionTake(s: GameState, colors: readonly Color[]): ReturnType<EngineApi['actionTake']> {
  const p = activePlayer(s);
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (colors.length === 0) return { ok: false, error: '未选择精灵球' };
  if (colors.length > 6) return { ok: false, error: '非法的领取' }; // bound input before allocating a Set
  for (const c of colors) {
    if (!COLORS.includes(c)) return { ok: false, error: '不能领取大师球' };
  }
  const uniq = new Set(colors);
  let mode;
  if (colors.length === 2 && uniq.size === 1) {
    mode = 'double';
    const c = colors[0];
    if (!c) return { ok: false, error: '未选择精灵球' };
    if (s.supply[c] < 4) return { ok: false, error: '该颜色少于4个，不能领取两个' };
  } else if (uniq.size === colors.length && colors.length <= 3) {
    mode = 'distinct';
    // Official rule: take 3 tokens of different types. Only when fewer than 3
    // colors remain available in the supply may you take fewer (2, or even 1).
    const availDistinct = COLORS.filter((col) => s.supply[col] > 0).length;
    if (availDistinct >= 3 && colors.length !== 3) {
      return { ok: false, error: '必须领取3种不同颜色的精灵球' };
    }
  } else {
    return { ok: false, error: '只能领取3种不同颜色，或领取2个同色' };
  }
  for (const c of uniq)
    if (s.supply[c] < (mode === 'double' ? 2 : 1)) return { ok: false, error: '供应不足' };
  // apply
  for (const c of colors) {
    s.supply[c]--;
    p.tokens[c]++;
  }
  s.acted = true;
  s.taken = colors.slice();
  log(s, `${p.name} 领取 ${colors.map(zhBall).join('、')}`, {
    kind: 'take',
    colors: colors.slice(),
  });
  return { ok: true };
}

function actionReserve(
  s: GameState,
  target: ReserveTarget,
): ReturnType<EngineApi['actionReserve']> {
  // target: {fromField:id} or {fromDeck:tier}
  const p = activePlayer(s);
  if (s.acted) return { ok: false, error: '本回合已行动' };
  if (p.reserve.length >= HAND_MAX) return { ok: false, error: '预留区已满（最多3张）' };
  let cardId: string;
  let tier: FieldTier;
  let slot = -1;
  let fromDeck = false;
  if ('fromDeck' in target) {
    tier = target.fromDeck;
    if (!isReservableTier(s, tier)) return { ok: false, error: '稀有/传说不可预留' };
    const deck = deckAt(s, tier);
    if (!deck.length) return { ok: false, error: '牌堆已空' };
    const nextCard = deck.pop();
    if (!nextCard) return { ok: false, error: '牌堆已空' };
    cardId = nextCard;
    fromDeck = true;
  } else {
    cardId = target.fromField;
    const loc = locateCard(s, cardId);
    if (loc.where !== 'field') return { ok: false, error: '该卡不在场上' };
    if (!isReservableTier(s, loc.tier)) return { ok: false, error: '稀有/传说不可预留' };
    tier = loc.tier;
    slot = loc.slot;
  }
  p.reserve.push(cardId);
  if (!fromDeck) {
    fieldAt(s, tier)[slot] = null;
    refill(s, tier);
  }
  // gain a master ball if available
  let got = '';
  if (s.supply.purple > 0) {
    s.supply.purple--;
    p.tokens.purple++;
    got = ' 并获得1个大师球';
  }
  s.acted = true;
  log(s, `${p.name} 预留了一张${zhTier(tier)}宝可梦${fromDeck ? '（牌堆顶）' : ''}${got}`);
  return { ok: true, cardId };
}

// remove a just-captured card from wherever it sat (field or own reserve)
function takeFromSource(s: GameState, p: Player, loc: CardLocation, cardId: string): void {
  if (loc.where === 'reserve') {
    const i = p.reserve.indexOf(cardId);
    if (i >= 0) p.reserve.splice(i, 1);
  } else if (loc.where === 'field') {
    fieldAt(s, loc.tier)[loc.slot] = null;
    refill(s, loc.tier);
  }
}
// remove a board card out of the game (Pokémart "discard … returned to the box")
function discardFromBoard(s: GameState, p: Player, id: string): void {
  const i = p.board.indexOf(id);
  if (i >= 0) p.board.splice(i, 1);
  if (p.assoc) delete p.assoc[id];
}
// EVOLVE STONE / RARE CANDY: pick an owned card with a real bonus to copy.
function resolveCopyTarget(
  s: GameState,
  p: Player,
  targetId?: string,
): ActionResult<{ readonly color: Color }> {
  const cands = p.board.filter((id) => effBonusColor(s, p, id));
  if (!cands.length) return { ok: false, error: '进化石需要你已有一张带奖励的卡' };
  const selected = targetId ?? cands[0];
  if (!selected || cands.indexOf(selected) < 0)
    return { ok: false, error: '关联目标必须是你已有的带奖励的卡' };
  const color = effBonusColor(s, p, selected);
  if (!color) return { ok: false, error: '关联目标没有有效奖励' };
  return { ok: true, color };
}
// REPEL: choose `discardCount` owned cards of `discardColor` to discard.
function resolveDiscardBuy(
  s: GameState,
  p: Player,
  card: Card,
  chosen?: readonly string[],
): ActionResult<{ readonly discarded: string[] }> {
  const params = effectParamOf(card);
  const color = params.discardColor;
  const need = params.discardCount;
  if (!color || need == null) return { ok: false, error: '卡牌弃牌参数无效' };
  const owned = p.board.filter((id) => effBonusColor(s, p, id) === color);
  if (owned.length < need)
    return { ok: false, error: `需要弃掉${need}张${zhBall(color)}卡，但你只有${owned.length}张` };
  let discarded;
  if (chosen && chosen.length) {
    if (chosen.length !== need) return { ok: false, error: `必须弃掉${need}张` };
    for (const id of chosen)
      if (owned.indexOf(id) < 0) return { ok: false, error: '所选弃牌颜色不符或不属于你' };
    discarded = chosen.slice();
  } else {
    discarded = owned.slice(0, need);
  }
  return { ok: true, discarded };
}

// "Take a free card" effects (TM / RARE CANDY). The free card comes from the
// level below: RARE CANDY (pmL2) -> Level 1 (stage1/pmL1); TM (pmL3) -> Level 2.
function freeTiers(parentCard: Card): readonly FieldTier[] {
  if (parentCard.tier === 'pmL2') return ['stage1', 'pmL1'];
  if (parentCard.tier === 'pmL3') return ['stage2', 'pmL2'];
  return [];
}
// Is `fc` a free card the player could legally take right now (effect live + any
// required sub-choice is satisfiable)? Used to decide if the take is mandatory.
function freeTakeable(s: GameState, p: Player, fc: Card): boolean {
  if (isPokemart(fc) && fc.effect && !PM_EFFECTS_LIVE[fc.effect]) return false;
  if (isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free'))
    return p.board.some((b) => effBonusColor(s, p, b)); // needs a bonus card to copy
  return true;
}
// Validate (no mutation) the chain of free takes; returns {ok, steps:[{freeId,assoc}]}.
function planFree(
  s: GameState,
  p: Player,
  parentCard: Card,
  opts: CaptureOptions,
  depth = 0,
  seen: Readonly<Record<string, boolean>> = {},
): FreePlan {
  if (depth > 4) return { ok: false, error: '免费取卡层级过深' };
  const tiers = freeTiers(parentCard);
  const freeId = opts.freeTakeId;
  if (freeId == null) {
    const hasFreeCard = tiers.some((tier) =>
      fieldAt(s, tier).some((id) => id !== null && freeTakeable(s, p, cardById(s, id))),
    );
    return hasFreeCard
      ? { ok: false, error: '请选择要免费获得的卡（freeTakeId）' }
      : { ok: true, steps: [] };
  }
  if (seen[freeId]) return { ok: false, error: '免费取卡重复' };
  const loc = locateCard(s, freeId);
  if (loc.where !== 'field' || tiers.indexOf(loc.tier) < 0)
    return { ok: false, error: '免费卡必须是可选等级中的面朝上卡' };
  const fc = cardById(s, freeId);
  if (isPokemart(fc) && fc.effect && !PM_EFFECTS_LIVE[fc.effect])
    return { ok: false, error: `免费卡「${fc.name}」效果待实现` };
  const sub = opts.freeOpts || {};
  let assoc: Color | null = null;
  if (isPokemart(fc) && (fc.effect === 'copy' || fc.effect === 'copy_free')) {
    const r = resolveCopyTarget(s, p, sub.copyTargetId);
    if (!r.ok) return r;
    assoc = r.color;
  }
  let steps: FreeStep[] = [{ freeId, assoc }];
  if (isPokemart(fc) && (fc.effect === 'free' || fc.effect === 'copy_free')) {
    const ns: Readonly<Record<string, boolean>> = { ...seen, [freeId]: true };
    const rec = planFree(s, p, fc, sub, depth + 1, ns);
    if (!rec.ok) return rec;
    steps = steps.concat(rec.steps);
  }
  return { ok: true, steps };
}
function execFree(s: GameState, p: Player, steps: readonly FreeStep[]): void {
  for (const st of steps) {
    const loc = locateCard(s, st.freeId);
    if (loc.where === 'field') {
      fieldAt(s, loc.tier)[loc.slot] = null;
      refill(s, loc.tier);
    }
    p.board.push(st.freeId);
    if (st.assoc) {
      p.assoc = p.assoc || {};
      p.assoc[st.freeId] = st.assoc;
    }
    log(
      s,
      `${p.name} 免费获得 ${cardById(s, st.freeId).name}${st.assoc ? `（关联${zhBall(st.assoc)}）` : ''}`,
    );
  }
}

// opts (all optional, used by Pokémart effects):
//   copyTargetId  — board card id to copy a bonus from (EVOLVE STONE / RARE CANDY)
//   spendPokedex  — board POKÉDEX ids to discard, each worth 2 virtual master balls
//   discardCards  — board card ids to discard to pay for a REPEL (discard_buy)
//   freeTakeId + freeOpts — the free card to take (TM / RARE CANDY), and its own choices
function actionCapture(
  s: GameState,
  cardId: string,
  opts: CaptureOptions = {},
): ReturnType<EngineApi['actionCapture']> {
  const p = activePlayer(s);
  if (s.acted) return { ok: false, error: '本回合已行动' };
  const card = s.byId[cardId];
  if (!card) return { ok: false, error: '无此卡' };
  if (isPokemart(card) && card.effect && !PM_EFFECTS_LIVE[card.effect]) {
    return { ok: false, error: `Pokémart「${card.name}」效果待实现（后续阶段）` };
  }
  const loc = locateCard(s, cardId);
  const fromReserve = loc.where === 'reserve' && loc.owner === p.id;
  if (loc.where !== 'field' && !fromReserve)
    return { ok: false, error: '只能捕捉场上或自己预留区的宝可梦' };

  // --- REPEL (discard_buy): no token cost; discard owned cards of a colour ---
  if (isPokemart(card) && card.effect === 'discard_buy') {
    const r = resolveDiscardBuy(s, p, card, opts.discardCards);
    if (!r.ok) return r;
    takeFromSource(s, p, loc, cardId);
    for (const did of r.discarded) discardFromBoard(s, p, did);
    p.board.push(cardId);
    s.acted = true;
    const discardedColor = effectParamOf(card).discardColor;
    log(
      s,
      `${p.name} 用${card.name}获得（弃掉${r.discarded.length}张${discardedColor ? zhBall(discardedColor) : '指定颜色'}卡）`,
    );
    return { ok: true };
  }

  // --- optional: discard POKÉDEX cards as 2 virtual master balls each ---
  const spend = opts.spendPokedex ?? [];
  for (const pid of spend) {
    const pc = s.byId[pid];
    if (!pc || p.board.indexOf(pid) < 0 || !(isPokemart(pc) && pc.effect === 'colorless_master')) {
      return { ok: false, error: '无效的图鉴消耗' };
    }
  }
  const payment = computePayment(s, p, card, spend.length * 2);
  if (!payment.ok) return { ok: false, error: payment.error };

  // --- EVOLVE STONE / RARE CANDY (copy): associate with an owned bonus card ---
  let assocColor = null;
  if (isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free')) {
    const r = resolveCopyTarget(s, p, opts.copyTargetId);
    if (!r.ok) return r;
    assocColor = r.color;
  }
  // --- TM / RARE CANDY (free / copy_free): plan the free take(s) up front ---
  let freeSteps = null;
  if (isPokemart(card) && (card.effect === 'free' || card.effect === 'copy_free')) {
    const fp = planFree(s, p, card, opts, 0);
    if (!fp.ok) return fp;
    freeSteps = fp.steps;
  }

  payTokens(s, p, payment.pay);
  for (const pid of spend) discardFromBoard(s, p, pid); // virtual masters consumed
  takeFromSource(s, p, loc, cardId);
  p.board.push(cardId);
  if (assocColor) {
    p.assoc = p.assoc || {};
    p.assoc[cardId] = assocColor;
  }
  s.acted = true;
  const extra = spend.length ? `，弃${spend.length}图鉴抵${spend.length * 2}万能` : '';
  const asc = assocColor ? `，关联${zhBall(assocColor)}` : '';
  log(s, `${p.name} 捕捉了 ${card.name}（${payDesc(payment.pay)}${extra}${asc}）`, {
    kind: 'capture',
    cardId,
  });
  if (freeSteps && freeSteps.length) execFree(s, p, freeSteps);
  return { ok: true };
}

// ----------------------- evolution (end of turn) -------------------
// List the legal evolutions available right now for the active player.
// Evolution is by SPECIES: a caught Pokémon evolves into ANY available
// card of its next-form species (on the field or in the player's hand).

export { actionCapture, actionReserve, actionTake, freeTakeable, freeTiers };
