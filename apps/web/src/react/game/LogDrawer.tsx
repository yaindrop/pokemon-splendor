import { Drawer } from '@base-ui/react/drawer';
import type { GameLogEntry, GameState } from '@pokemon-splendor/game-core';
import type { ReactElement } from 'react';
import type { OnlineSessionState } from '../../session/types.js';
import { GameButton, HoverTip } from '../components/primitives.js';
import { BALL_NAMES, cardFrom } from './model.js';

interface LogDrawerProps {
  readonly open: boolean;
  readonly game: GameState;
  readonly online: OnlineSessionState | null;
  readonly localUndoAvailable: boolean;
  readonly onClose: () => void;
  readonly onUndo: () => void;
  readonly onVoteUndo: (approve: boolean) => void;
  readonly onInspect: (cardId: string) => void;
}

export function LogDrawer({
  open,
  game,
  online,
  localUndoAvailable,
  onClose,
  onUndo,
  onVoteUndo,
  onInspect,
}: LogDrawerProps): ReactElement {
  const vote = online?.undoVote ?? null;
  const requester = vote
    ? online?.roster.find((player) => player.seat === vote.requesterSeat)
    : null;
  const alreadyVoted = Boolean(
    vote && online && online.seat !== null && vote.approvals.includes(online.seat),
  );
  const canUndo = online
    ? game.phase === 'play' && (online.seat ?? -1) >= 0 && online.undoAvailable && !vote
    : game.phase === 'play' && localUndoAvailable;
  return (
    <Drawer.Root
      open={open}
      modal={false}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      swipeDirection="right"
    >
      <Drawer.Portal>
        <Drawer.Viewport className="base-drawer-viewport">
          <Drawer.Popup className="panel log-drawer" aria-label="游戏记录">
            <div className="panel-title">
              <span>
                <span aria-hidden="true">◷</span> 游戏记录
              </span>
              <GameButton className="ghost small" aria-label="关闭游戏记录" onClick={onClose}>
                ×
              </GameButton>
            </div>
            <div className="log-lines">
              {game.log.length ? (
                game.log
                  .slice(-40)
                  .map((entry, index) => (
                    <LogLine
                      entry={entry}
                      game={game}
                      key={`${entry.round}-${entry.turn}-${index}`}
                      onInspect={onInspect}
                    />
                  ))
              ) : (
                <div className="log-empty">行动后，记录会出现在这里。</div>
              )}
            </div>
            <div className="log-tools">
              <div className="log-tools-title">对局功能</div>
              {canUndo ? (
                <GameButton className="ghost log-undo" onClick={onUndo}>
                  <span aria-hidden="true">↶</span>悔棋
                </GameButton>
              ) : null}
              {vote ? (
                <div className="undo-vote">
                  <div>
                    <b>{requester?.name ?? `玩家 ${vote.requesterSeat + 1}`}</b> 发起悔棋
                  </div>
                  <div className="vote-progress">
                    {vote.approvals.length}/{vote.total || game.numPlayers} 已同意 · 需要全员同意
                  </div>
                  {alreadyVoted ? (
                    <div className="vote-waiting">你已同意，等待其他玩家…</div>
                  ) : (
                    <div className="vote-actions">
                      <GameButton
                        className="primary"
                        onClick={() => {
                          onVoteUndo(true);
                        }}
                      >
                        同意
                      </GameButton>
                      <GameButton
                        className="ghost"
                        onClick={() => {
                          onVoteUndo(false);
                        }}
                      >
                        拒绝
                      </GameButton>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function LogLine({
  entry,
  game,
  onInspect,
}: {
  readonly entry: GameLogEntry;
  readonly game: GameState;
  readonly onInspect: (cardId: string) => void;
}): ReactElement {
  const message = entry.msg
    .replaceAll('保留区', '预留区')
    .replaceAll('签约区', '预留区')
    .replaceAll('保留', '预留')
    .replaceAll('签约', '预留')
    .replaceAll('拿取', '领取');
  if (entry.kind === 'take' && entry.colors) {
    const marker = '领取';
    const position = message.indexOf(marker);
    const lead = position >= 0 ? message.slice(0, position + marker.length) : message;
    return (
      <div className="ln log-inline">
        <span>{lead}</span>
        <span className="log-thumbs">
          {entry.colors.map((color, index) => (
            <HoverTip key={`${color}-${index}`} label={BALL_NAMES[color]}>
              <span className="log-thumb ball-thumb">
                <span className={`ball ${color}`} />
              </span>
            </HoverTip>
          ))}
        </span>
      </div>
    );
  }
  if (entry.kind === 'capture' && entry.cardId && game.byId[entry.cardId]) {
    const card = cardFrom(game, entry.cardId);
    const position = message.indexOf(card.name);
    if (position >= 0) {
      return (
        <div className="ln log-inline">
          <span>{message.slice(0, position)}</span>
          <HoverTip
            label={
              <img className="base-card-preview" src={card.img} alt={`${card.name} 卡牌预览`} />
            }
          >
            <GameButton
              className="log-thumb"
              onClick={() => {
                onInspect(card.id);
              }}
            >
              <img src={card.img} alt={card.name} />
            </GameButton>
          </HoverTip>
          <span>{message.slice(position + card.name.length)}</span>
        </div>
      );
    }
  }
  return (
    <div className="ln">
      <span>{message}</span>
    </div>
  );
}
