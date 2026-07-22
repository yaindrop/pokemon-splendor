import { Engine as E, type Color, type GameState, type Player } from '@pokemon-splendor/game-core';
import type { ReactElement } from 'react';
import type { OnlineSessionState } from '../../session/types.js';
import { GameButton, HoverTip } from '../components/primitives.js';
import {
  BALL_NAMES,
  cardFrom,
  hiddenReserveTier,
  seatAvatar,
  seatColor,
  turnStatus,
  type GameSelection,
  type GameUiPhase,
} from './model.js';

interface PlayerPanelProps {
  readonly game: GameState;
  readonly player: Player;
  readonly index: number;
  readonly online: OnlineSessionState | null;
  readonly selection: GameSelection;
  readonly phase: GameUiPhase;
  readonly busy: boolean;
  readonly onSelectCard: (cardId: string) => void;
  readonly onInspect: (cardId: string) => void;
}

export function PlayerPanel({
  game,
  player,
  index,
  online,
  selection,
  phase,
  busy,
  onSelectCard,
  onInspect,
}: PlayerPanelProps): ReactElement {
  const active = index === game.turn && game.phase === 'play';
  const mine = online ? online.seat === index : active && !player.isAI;
  const bonuses = E.bonuses(game, player);
  const total = E.tokenTotal(player);
  const status = turnStatus(
    game,
    player,
    index,
    online?.seat ?? null,
    online !== null,
    phase,
    selection,
    busy,
  );
  const revealReserve = !player.isAI && (online ? index === online.seat : active);
  const groups: ReadonlyArray<{ readonly key: Color | 'other'; readonly ids: readonly string[] }> =
    [
      ...E.COLORS.map((color) => ({
        key: color,
        ids: player.board.filter((id) => E.effBonusColor(game, player, id) === color),
      })),
      {
        key: 'other',
        ids: player.board.filter((id) => E.effBonusColor(game, player, id) === null),
      },
    ];
  return (
    <section
      className={`player${active ? ' active' : ''}${mine ? ' mine' : ''}${player.isAI ? ' ai' : ''}`}
      data-player={index}
    >
      <div className="player-head">
        <span
          className="pavatar"
          aria-hidden="true"
          style={{
            backgroundColor: seatColor(index),
            backgroundImage: `url(${seatAvatar(index)})`,
            boxShadow: `0 0 0 2px ${seatColor(index)}`,
          }}
        />
        <div className="player-heading">
          <div className="pname">
            {player.name}
            {mine ? <span className="player-me">你</span> : null}
          </div>
          {status ? <div className="player-turn-status">{status}</div> : null}
        </div>
        <div className="pscore">
          {E.scoreOf(game, player)}
          <small>/{game.winScore}</small>
        </div>
      </div>
      {player.buried.length ? (
        <div className="buried-badge">已进化 {player.buried.length}</div>
      ) : null}
      <div className="player-body">
        <div className="player-assets">
          <div className="pstats">
            <HoverTip label={`持有的精灵球总数：${total}/${E.TOKEN_MAX}`}>
              <span
                className={`ptokens${total > E.TOKEN_MAX ? ' over' : total === E.TOKEN_MAX ? ' full' : ''}`}
              >
                <span className="pt-lbl">球</span>
                <strong>{total}</strong>
                <small>/{E.TOKEN_MAX}</small>
              </span>
            </HoverTip>
            {E.COLORS.map((color) => (
              <HoverTip
                key={color}
                label={`${BALL_NAMES[color]}：持有 ${player.tokens[color]}，永久折扣 ${bonuses[color]}`}
              >
                <span className="trainer-token" data-token-color={color}>
                  <span className={`ball ${color}`} />
                  <span className="trainer-token-count">{player.tokens[color]}</span>
                  <span className="trainer-token-bonus">+{bonuses[color]}</span>
                </span>
              </HoverTip>
            ))}
            <HoverTip label={`${BALL_NAMES.purple}：持有 ${player.tokens.purple}`}>
              <span className="trainer-token" data-token-color="purple">
                <span className="ball purple" />
                <span className="trainer-token-count">{player.tokens.purple}</span>
              </span>
            </HoverTip>
            {game.megasEnabled ? (
              <HoverTip label={`Mega 代币：持有 ${player.megaToken}`}>
                <span className="trainer-token" data-token-color="mega">
                  <span className="ball mega-token" />
                  <span className="trainer-token-count">{player.megaToken}</span>
                </span>
              </HoverTip>
            ) : null}
          </div>
          <div className="pcards capture-zone" data-capture-zone>
            {groups
              .filter((group) => group.ids.length > 0)
              .map((group) => (
                <div className="color-stack" key={group.key}>
                  <div className="ministack">
                    {group.ids.map((id, cardIndex) => (
                      <MiniCard
                        key={id}
                        game={game}
                        cardId={id}
                        stacked={cardIndex > 0}
                        onInspect={onInspect}
                      />
                    ))}
                  </div>
                </div>
              ))}
            {!player.board.length ? <span className="empty-player-cards">尚无宝可梦</span> : null}
          </div>
        </div>
        {player.reserve.length ? (
          <div className="reserve-zone" data-reserve-zone>
            <div className="rz-title">预留区 ({player.reserve.length})</div>
            <div className="pcards">
              {player.reserve.map((id, slot) => {
                const hiddenTier = hiddenReserveTier(id);
                if (revealReserve && !hiddenTier) {
                  return (
                    <MiniCard
                      key={`${id}-${slot}`}
                      game={game}
                      cardId={id}
                      stacked={false}
                      selected={selection.selectedCardId === id}
                      onInspect={onInspect}
                      onSelect={onSelectCard}
                      reserve
                    />
                  );
                }
                const tier = hiddenTier ?? cardFrom(game, id).tier;
                return (
                  <div
                    className="mini-card card-back"
                    key={`${id}-${slot}`}
                    data-tier={tier}
                    data-reserved-slot={slot}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MiniCard({
  game,
  cardId,
  stacked,
  selected = false,
  reserve = false,
  onInspect,
  onSelect,
}: {
  readonly game: GameState;
  readonly cardId: string;
  readonly stacked: boolean;
  readonly selected?: boolean;
  readonly reserve?: boolean;
  readonly onInspect: (cardId: string) => void;
  readonly onSelect?: (cardId: string) => void;
}): ReactElement {
  const card = cardFrom(game, cardId);
  return (
    <HoverTip
      label={<img className="base-card-preview" src={card.img} alt={`${card.name} 卡牌预览`} />}
    >
      <GameButton
        className={`mini-card${stacked ? ' stacked' : ''}${selected ? ' selected' : ''}`}
        data-captured-card={reserve ? undefined : cardId}
        data-reserved-card={reserve ? cardId : undefined}
        aria-label={card.name}
        onClick={() => {
          if (reserve && onSelect) onSelect(cardId);
          else onInspect(cardId);
        }}
      >
        <img src={card.img} alt={card.name} loading="lazy" />
      </GameButton>
    </HoverTip>
  );
}
