import { Engine as E, type Color, type GameState } from '@pokemon-splendor/game-core';
import type { ReactElement } from 'react';
import { GameButton } from '../components/primitives.js';
import { BALL_NAMES, canAddBall, takeSelectionComplete, type GameSelection } from './model.js';

interface SupplyPanelProps {
  readonly game: GameState;
  readonly canInteract: boolean;
  readonly selection: GameSelection;
  readonly onTake: (color: Color) => void;
  readonly onReturn: (color: Color) => void;
  readonly onConfirm: () => void;
  readonly onClear: () => void;
  readonly onTakeMega: () => void;
}

export function SupplyPanel({
  game,
  canInteract,
  selection,
  onTake,
  onReturn,
  onConfirm,
  onClear,
  onTakeMega,
}: SupplyPanelProps): ReactElement {
  const picked = countPicked(selection.pickedBalls);
  const selectionComplete = takeSelectionComplete(game, selection.pickedBalls);
  return (
    <section
      id="supply"
      className={`panel${selection.pickedBalls.length ? ' has-pick' : ''}`}
      aria-label="领取精灵球"
    >
      <div className="panel-title">
        <span>领取精灵球</span>
        {selection.pickedBalls.length ? (
          <span className="supply-quick-actions">
            <GameButton
              className="supply-cancel"
              aria-label="取消领取选择"
              title="取消选择"
              onClick={onClear}
            >
              ×
            </GameButton>
            <GameButton
              className="supply-confirm"
              disabled={!selectionComplete}
              aria-label="确认领取精灵球"
              title="确认领取"
              onClick={onConfirm}
            >
              ✓
            </GameButton>
          </span>
        ) : canInteract ? (
          <span className="supply-control-hints" aria-label="左键领取，右键归还">
            <span>
              <i className="mouse-key mouse-left" aria-hidden="true" />
              领取
            </span>
            <span>
              <i className="mouse-key mouse-right" aria-hidden="true" />
              归还
            </span>
          </span>
        ) : (
          <small>当前库存</small>
        )}
      </div>
      {E.ALL_TOKENS.map((color) => {
        const master = color === 'purple';
        const selectedCount = master ? 0 : (picked[color] ?? 0);
        const selectable = !master && canInteract && canAddBall(game, selection.pickedBalls, color);
        const disabled = master || (!selectable && selectedCount === 0);
        const stackCount = Math.min(3, Math.max(0, game.supply[color] - 1));
        return (
          <GameButton
            key={color}
            className={`supply-row${selectedCount ? ' picked' : ''}${disabled ? ' disabled' : ''}`}
            data-supply-color={color}
            disabled={disabled}
            aria-label={`${BALL_NAMES[color]}，库存 ${game.supply[color]}${selectedCount ? `，已选 ${selectedCount}` : ''}`}
            onClick={() => {
              if (!master) onTake(color);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!master) onReturn(color);
            }}
          >
            <span className="supply-stack" aria-hidden="true">
              {Array.from({ length: stackCount }, (_, index) => (
                <span className="supply-disc supply-stack-token" key={index}>
                  <span className={`ball ${color}`} />
                </span>
              ))}
            </span>
            <span className="supply-disc supply-main-disc">
              <span className={`ball ${color}`} />
            </span>
            {selectedCount ? <span className="picked-n">✓ {selectedCount}</span> : null}
            <span className="cnt">{game.supply[color]}</span>
          </GameButton>
        );
      })}
      {game.megasEnabled ? (
        <GameButton
          className={`supply-row mega-row${canInteract && (game.supply.megaToken ?? 0) > 0 ? '' : ' disabled'}`}
          data-supply-color="mega"
          data-take-mega="true"
          disabled={!canInteract || (game.supply.megaToken ?? 0) <= 0}
          aria-label={`Mega 代币，库存 ${game.supply.megaToken ?? 0}`}
          onClick={onTakeMega}
        >
          <span className="supply-disc supply-main-disc">
            <span className="ball mega-token" />
          </span>
          <span className="cnt">{game.supply.megaToken ?? 0}</span>
        </GameButton>
      ) : null}
    </section>
  );
}

function countPicked(colors: readonly Color[]): Partial<Record<Color, number>> {
  const counts: Partial<Record<Color, number>> = {};
  for (const color of colors) counts[color] = (counts[color] ?? 0) + 1;
  return counts;
}
