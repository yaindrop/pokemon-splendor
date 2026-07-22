import {
  Engine as E,
  type Card,
  type GameState,
  type Player,
  type TokenColor,
} from '@pokemon-splendor/game-core';
import type { ReactElement, ReactNode } from 'react';
import { GameButton, HoverTip } from '../components/primitives.js';
import {
  BALL_NAMES,
  TIER_NAMES,
  affordInfo,
  captureBlockedReason,
  cardFrom,
  dedupeEvolutionOptions,
  isNormalTier,
  isPokemartTier,
  paymentRows,
  reserveBlockedReason,
  type AffordInfo,
  type GameSelection,
  type GameUiPhase,
} from './model.js';

interface ActionDockProps {
  readonly game: GameState;
  readonly player: Player;
  readonly canInteract: boolean;
  readonly isMyTurn: boolean;
  readonly hideEndTurn: boolean;
  readonly selection: GameSelection;
  readonly phase: GameUiPhase;
  readonly onCapture: () => void;
  readonly onReserveCard: () => void;
  readonly onReserveDeck: () => void;
  readonly onClear: () => void;
  readonly onDiscard: (color: TokenColor) => void;
  readonly onEvolve: (fromId: string, toId: string) => void;
  readonly onMegaEvolve: (megaId: string, fromId: string) => void;
  readonly onEndTurn: () => void;
}

export function ActionDock({
  game,
  player,
  canInteract,
  isMyTurn,
  hideEndTurn,
  selection,
  phase,
  onCapture,
  onReserveCard,
  onReserveDeck,
  onClear,
  onDiscard,
  onEvolve,
  onMegaEvolve,
  onEndTurn,
}: ActionDockProps): ReactElement {
  if (game.phase === 'gameover' || player.isAI || !isMyTurn) {
    return <section id="action-bar" className="panel action-idle" aria-label="行动区" />;
  }
  if (phase === 'discard') {
    const total = E.tokenTotal(player);
    return (
      <section id="action-bar" className="panel" aria-label="归还精灵球">
        <div className="discard-head">
          <span className="discard-mark" aria-hidden="true">
            ↙
          </span>
          <span className="discard-copy">
            <small>精灵球达到上限</small>
            <strong>归还 {total - E.TOKEN_MAX} 个</strong>
          </span>
          <span className="discard-total">
            {total}
            <small>/{E.TOKEN_MAX}</small>
          </span>
        </div>
        <div className="discard-token-list">
          {E.ALL_TOKENS.filter((color) => player.tokens[color] > 0).map((color) => (
            <HoverTip key={color} label={BALL_NAMES[color]}>
              <GameButton
                className={`discard-token ${color}`}
                onClick={() => {
                  onDiscard(color);
                }}
                aria-label={`归还一个${BALL_NAMES[color]}`}
              >
                <span className="discard-token-art">
                  <span className={`ball ${color}`} />
                </span>
                <span className="discard-token-count">{player.tokens[color]}</span>
                <span className="discard-token-minus">−1</span>
              </GameButton>
            </HoverTip>
          ))}
        </div>
      </section>
    );
  }
  if (phase === 'evolve') {
    const options = dedupeEvolutionOptions(game, E.evolutionOptions(game, player));
    const megaOptions = game.megasEnabled ? E.megaEvolveOptions(game, player) : [];
    return (
      <section id="action-bar" className="panel" aria-label="回合结算">
        <div className="act-hint">回合结束 · 可进化一只宝可梦（可选，每回合至多 1 次）</div>
        {options.map((option) => {
          const from = cardFrom(game, option.fromId);
          const to = cardFrom(game, option.toId);
          return (
            <GameButton
              className="evo-option"
              key={`${option.fromId}-${option.toId}`}
              onClick={() => {
                onEvolve(option.fromId, option.toId);
              }}
            >
              <b>{from.name}</b> → <b>{to.name}</b>（+{to.vp - from.vp} 分，需 {option.count} 个
              {BALL_NAMES[option.color]}折扣）
            </GameButton>
          );
        })}
        {megaOptions.map((option) => {
          const from = cardFrom(game, option.fromId);
          const mega = cardFrom(game, option.megaId);
          const cost = E.ALL_TOKENS.filter((color) => mega.cost[color] > 0)
            .map((color) => `${mega.cost[color]}${BALL_NAMES[color]}`)
            .join('+');
          return (
            <GameButton
              className="evo-option mega-evo"
              key={`${option.megaId}-${option.fromId}`}
              onClick={() => {
                onMegaEvolve(option.megaId, option.fromId);
              }}
            >
              ⚡<b>{from.name}</b> → <b>{mega.name}</b>（+{mega.vp - from.vp} 分，付 {cost}，耗 1
              Mega 代币）
            </GameButton>
          );
        })}
        {hideEndTurn ? null : (
          <div className="act-buttons">
            <GameButton className="primary" onClick={onEndTurn}>
              不进化，结束回合
            </GameButton>
          </div>
        )}
      </section>
    );
  }
  if (selection.selectedCardId) {
    const card = cardFrom(game, selection.selectedCardId);
    const info = affordInfo(game, player, card);
    const captureReason = info ? null : captureBlockedReason(game, player, card);
    const location = E.locateCard(game, card.id);
    const canReserve =
      location.where === 'field' &&
      (isNormalTier(location.tier) || isPokemartTier(location.tier)) &&
      player.reserve.length < E.HAND_MAX;
    const reserveReason = canReserve ? null : reserveBlockedReason(game, player, card.id);
    return (
      <section id="action-bar" className="panel action-card" aria-label="捕捉交易">
        <PaymentLedger game={game} player={player} card={card} info={info} />
        <div className="act-buttons capture-actions">
          <ActionControl reason={captureReason}>
            <GameButton className="primary" disabled={!info || !canInteract} onClick={onCapture}>
              捕捉
            </GameButton>
          </ActionControl>
          <ActionControl reason={reserveReason}>
            <GameButton
              className="reserve-action"
              disabled={!canReserve || !canInteract}
              onClick={onReserveCard}
            >
              <span aria-hidden="true">◇</span>预留
            </GameButton>
          </ActionControl>
          <ActionControl>
            <GameButton className="ghost" onClick={onClear}>
              取消
            </GameButton>
          </ActionControl>
        </div>
      </section>
    );
  }
  if (selection.selectedDeck) {
    return (
      <section id="action-bar" className="panel" aria-label="预留牌堆顶">
        <div className="act-hint">
          预留 <b>{TIER_NAMES[selection.selectedDeck]}</b> 牌堆顶的宝可梦（获得 1 个大师球）？
        </div>
        <div className="act-buttons">
          <GameButton className="reserve-action" disabled={!canInteract} onClick={onReserveDeck}>
            <span aria-hidden="true">◇</span>预留牌堆顶
          </GameButton>
          <GameButton className="ghost" onClick={onClear}>
            取消
          </GameButton>
        </div>
      </section>
    );
  }
  return <section id="action-bar" className="panel action-idle" aria-label="行动区" />;
}

function ActionControl({
  reason,
  children,
}: {
  readonly reason?: string | null;
  readonly children: ReactNode;
}): ReactElement {
  const control = (
    <span className={`action-control${reason ? ' has-reason' : ''}`}>{children}</span>
  );
  return reason ? <HoverTip label={reason}>{control}</HoverTip> : control;
}

function PaymentLedger({
  game,
  player,
  card,
  info,
}: {
  readonly game: GameState;
  readonly player: Player;
  readonly card: Card;
  readonly info: AffordInfo | null;
}): ReactElement | null {
  const rows = paymentRows(game, player, card, info);
  if (!rows.length) return null;
  return (
    <div className={`pay-ledger${info ? '' : ' unafford'}`}>
      <div className="pay-token-list">
        {rows.map((row) => (
          <HoverTip
            block
            key={row.color}
            label={`${BALL_NAMES[row.color]}：原需 ${row.required}，折后 ${row.due}，交易后剩余 ${row.after}`}
          >
            <div className={`pay-token ${row.color}${row.after < 0 ? ' negative' : ''}`}>
              <span className="pay-token-art">
                <span className={`ball ${row.color}`} />
              </span>
              <span className="pay-metric pay-cost">
                <b>{row.required}</b>
                <i>/</i>
                <b>{row.due}</b>
              </span>
              <span className={`pay-metric pay-after${row.after < 0 ? ' negative' : ''}`}>
                <small>余</small>
                <b>{row.after}</b>
              </span>
              {row.paidWild ? <span className="pay-token-master">★{row.paidWild}</span> : null}
            </div>
          </HoverTip>
        ))}
      </div>
    </div>
  );
}
