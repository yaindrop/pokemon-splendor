import { Engine as E, type Card, type GameState } from '@pokemon-splendor/game-core';
import type { ReactElement } from 'react';
import { GameButton, Modal } from '../components/primitives.js';
import type { ChoiceRequest } from './app-model.js';
import { playerFrom, seatAvatar, seatColor } from './model.js';

export function RulesDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <Modal open={open} onOpenChange={onOpenChange} label="游戏规则">
      <h2>游戏规则</h2>
      <div className="rules-body">
        <p>
          <b>目标：</b>率先达到 <b>18 分</b>。有人达成后，本轮结束；分高者获胜。
        </p>
        <p>
          <b>精灵球：</b>精灵球、超级球、高级球、治愈球、先机球，以及可替代任意颜色的<b>大师球</b>。
        </p>
        <p>
          <b>每回合选择一项主行动：</b>
        </p>
        <ul>
          <li>
            领取 3 个<b>不同</b>颜色的精灵球；
          </li>
          <li>
            领取 2 个<b>同色</b>精灵球（该色供应至少为 4）；
          </li>
          <li>预留一张普通宝可梦或牌堆顶，并获得 1 个大师球。</li>
        </ul>
        <p>
          <b>捕捉：</b>支付卡牌成本。已捕捉宝可梦提供永久折扣；稀有与传说卡需要大师球。
        </p>
        <p>
          <b>进化：</b>在回合结束时，满足折扣条件可进化一只宝可梦。回合结束时持有精灵球不能超过 10
          个。
        </p>
      </div>
      <GameButton
        className="primary"
        onClick={() => {
          onOpenChange(false);
        }}
      >
        明白了
      </GameButton>
    </Modal>
  );
}

export function InspectDialog({
  card,
  onClose,
}: {
  readonly card: Card | null;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Modal
      open={card !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label={card ? `${card.name} 卡牌详情` : '卡牌详情'}
      className="inspect-dialog"
    >
      {card ? (
        <div id="inspect-inner">
          <img id="inspect-img" src={card.img} alt={card.name} />
          <div id="inspect-actions">
            <GameButton className="ghost" onClick={onClose}>
              关闭
            </GameButton>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export function ChoiceDialog({
  choice,
  cardById,
  onChangeSelected,
  onResolve,
}: {
  readonly choice: ChoiceRequest | null;
  readonly cardById: (id: string) => Card | null;
  readonly onChangeSelected: (selected: readonly string[]) => void;
  readonly onResolve: (value: readonly string[] | null) => void;
}): ReactElement {
  const select = (id: string): void => {
    if (!choice) return;
    if (choice.selected.includes(id)) {
      onChangeSelected(choice.selected.filter((selected) => selected !== id));
      return;
    }
    if (choice.count === 1) {
      onChangeSelected([id]);
      return;
    }
    if (choice.selected.length < choice.count) onChangeSelected([...choice.selected, id]);
  };
  return (
    <Modal
      open={choice !== null}
      onOpenChange={(open) => {
        if (!open) onResolve(null);
      }}
      label={choice?.title ?? '选择卡牌'}
      className="choice"
    >
      {choice ? (
        <>
          <div className="choice-title">{choice.title}</div>
          {choice.hint ? <div className="choice-hint">{choice.hint}</div> : null}
          <div className="choice-cards">
            {choice.candidates.map((id) => {
              const card = cardById(id);
              if (!card) return null;
              return (
                <GameButton
                  key={id}
                  className={`choice-card${choice.selected.includes(id) ? ' sel' : ''}`}
                  aria-pressed={choice.selected.includes(id)}
                  onClick={() => {
                    select(id);
                  }}
                >
                  <img src={card.img} alt={card.name} />
                  <span>{card.name}</span>
                </GameButton>
              );
            })}
          </div>
          <div className="choice-actions">
            <GameButton
              className="primary"
              disabled={choice.selected.length !== choice.count}
              onClick={() => {
                onResolve(choice.selected);
              }}
            >
              确定
            </GameButton>
            <GameButton
              className="ghost"
              onClick={() => {
                onResolve(null);
              }}
            >
              取消
            </GameButton>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

export function WinDialog({
  game,
  open,
  onLeave,
}: {
  readonly game: GameState | null;
  readonly open: boolean;
  readonly onLeave: () => void;
}): ReactElement {
  const winner = game?.winner ?? (game ? E.determineWinner(game) : null);
  const scores = game
    ? game.players
        .map((player, index) => ({
          index,
          score: E.scoreOf(game, player),
          buried: player.buried.length,
          board: player.board.length,
          name: player.name,
        }))
        .sort(
          (left, right) =>
            right.score - left.score || right.buried - left.buried || right.board - left.board,
        )
    : [];
  return (
    <Modal
      open={open && game !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onLeave();
      }}
      label="对局结果"
      className="win"
    >
      {game && winner !== null ? (
        <>
          <div className="win-trophy" aria-hidden="true">
            🏆
          </div>
          <h2>{playerFrom(game, winner).name} 获胜！</h2>
          <div className="win-scores">
            {scores.map((score) => (
              <div className={`wrow${score.index === winner ? ' winner' : ''}`} key={score.index}>
                <span>
                  {score.index === winner ? '👑 ' : ''}
                  {score.name}
                </span>
                <span>
                  {score.score} 分 · {score.board} 只 · 进化 {score.buried}
                </span>
              </div>
            ))}
          </div>
          <GameButton className="primary" onClick={onLeave}>
            再来一局
          </GameButton>
        </>
      ) : null}
    </Modal>
  );
}

export function PassDialog({
  game,
  seat,
  onReady,
}: {
  readonly game: GameState | null;
  readonly seat: number | null;
  readonly onReady: () => void;
}): ReactElement {
  const player = game && seat !== null ? game.players[seat] : null;
  return (
    <Modal
      open={player !== undefined && player !== null}
      onOpenChange={(open) => {
        if (!open) onReady();
      }}
      label="交接设备"
      className="pass-dialog"
    >
      {player && seat !== null ? (
        <div className="pass-dialog-content">
          <span
            className="pavatar pass-avatar"
            aria-hidden="true"
            style={{
              backgroundColor: seatColor(seat),
              backgroundImage: `url(${seatAvatar(seat)})`,
              boxShadow: `0 0 0 3px ${seatColor(seat)}`,
            }}
          />
          <h2>
            请将设备交给
            <br />
            {player.name}
          </h2>
          <p>其他训练家的预留区会保持隐藏。</p>
          <GameButton className="primary" onClick={onReady}>
            我准备好了
          </GameButton>
        </div>
      ) : null}
    </Modal>
  );
}

export function LeaveGameDialog({
  open,
  tutorial,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly tutorial: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
      label={tutorial ? '退出教程' : '返回主页'}
      className="leave-dialog"
    >
      <h2>{tutorial ? '退出教程？' : '返回主页？'}</h2>
      <p>{tutorial ? '当前教程进度不会保留。' : '当前对局会结束，且不会保留进度。'}</p>
      <div className="choice-actions">
        <GameButton className="primary" onClick={onConfirm}>
          {tutorial ? '退出教程' : '返回主页'}
        </GameButton>
        <GameButton className="ghost" onClick={onCancel}>
          继续对局
        </GameButton>
      </div>
    </Modal>
  );
}
