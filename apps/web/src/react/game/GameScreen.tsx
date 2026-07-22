import { Menu } from '@base-ui/react/menu';
import type { Color, GameState, TokenColor } from '@pokemon-splendor/game-core';
import type { ReactElement } from 'react';
import type { OnlineSessionState } from '../../session/types.js';
import { GameButton } from '../components/primitives.js';
import { ActionDock } from './ActionDock.js';
import { FieldArea } from './FieldArea.js';
import { LogDrawer } from './LogDrawer.js';
import { PlayerPanel } from './PlayerPanel.js';
import { SupplyPanel } from './SupplyPanel.js';
import {
  isInteractiveTurn,
  ownPlayer,
  playerFrom,
  type GameSelection,
  type GameUiPhase,
  type ReservableTier,
} from './model.js';

interface GameScreenProps {
  readonly game: GameState;
  readonly online: OnlineSessionState | null;
  readonly selection: GameSelection;
  readonly phase: GameUiPhase;
  readonly busy: boolean;
  readonly logOpen: boolean;
  readonly idleNotice: string | null;
  readonly canInteract: boolean;
  readonly localUndoAvailable: boolean;
  readonly tutorialHideEndTurn: boolean;
  readonly onOpenLog: () => void;
  readonly onCloseLog: () => void;
  readonly onOpenRules: () => void;
  readonly onLeave: () => void;
  readonly onSupplyTake: (color: Color) => void;
  readonly onSupplyReturn: (color: Color) => void;
  readonly onConfirmTake: () => void;
  readonly onClearTake: () => void;
  readonly onSelectCard: (cardId: string) => void;
  readonly onInspect: (cardId: string) => void;
  readonly onSelectDeck: (tier: ReservableTier) => void;
  readonly onReserveSelectedCard: () => void;
  readonly onReserveSelectedDeck: () => void;
  readonly onCaptureSelectedCard: () => void;
  readonly onDiscard: (color: TokenColor) => void;
  readonly onEvolve: (fromId: string, toId: string) => void;
  readonly onMegaEvolve: (megaId: string, fromId: string) => void;
  readonly onTakeMega: () => void;
  readonly onEndTurn: () => void;
  readonly onUndo: () => void;
  readonly onVoteUndo: (approve: boolean) => void;
}

export function GameScreen({
  game,
  online,
  selection,
  phase,
  busy,
  logOpen,
  idleNotice,
  canInteract,
  localUndoAvailable,
  tutorialHideEndTurn,
  onOpenLog,
  onCloseLog,
  onOpenRules,
  onLeave,
  onSupplyTake,
  onSupplyReturn,
  onConfirmTake,
  onClearTake,
  onSelectCard,
  onInspect,
  onSelectDeck,
  onReserveSelectedCard,
  onReserveSelectedDeck,
  onCaptureSelectedCard,
  onDiscard,
  onEvolve,
  onMegaEvolve,
  onTakeMega,
  onEndTurn,
  onUndo,
  onVoteUndo,
}: GameScreenProps): ReactElement {
  const ownSeat = online?.seat ?? null;
  const player = ownPlayer(game, ownSeat);
  const isMyTurn = isInteractiveTurn(game, ownSeat, online !== null);
  return (
    <main id="game" className="screen">
      <div id="game-head">
        <header id="topbar" className={topbarState(game, online)}>
          <div className="topbar-left">
            <span className="brand-mini">璀璨宝石 · 宝可梦</span>
          </div>
          <div className="topbar-right">
            {idleNotice ? (
              <span className="idle-bar">
                <span className="idle-wait">⏱ {idleNotice}</span>
              </span>
            ) : null}
            <GameButton
              className="ghost small topbar-action"
              onClick={onOpenLog}
              aria-expanded={logOpen}
            >
              <span aria-hidden="true">◷</span>
              <span>记录</span>
            </GameButton>
            <Menu.Root>
              <Menu.Trigger className="ghost small topbar-action">
                <span aria-hidden="true">☰</span>
                <span>菜单</span>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="end" sideOffset={8}>
                  <Menu.Popup className="topbar-menu">
                    <Menu.Item className="topbar-menu-item" onClick={onOpenRules}>
                      规则说明
                    </Menu.Item>
                    <Menu.Item className="topbar-menu-item" onClick={onLeave}>
                      返回主页
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </header>
      </div>
      <section id="board">
        <FieldArea
          game={game}
          player={player}
          canInteract={canInteract}
          selection={selection}
          onSelectCard={onSelectCard}
          onSelectDeck={onSelectDeck}
          onClearSelection={onClearTake}
        />
      </section>
      <div id="controls">
        <SupplyPanel
          game={game}
          canInteract={canInteract}
          selection={selection}
          onTake={onSupplyTake}
          onReturn={onSupplyReturn}
          onConfirm={onConfirmTake}
          onClear={onClearTake}
          onTakeMega={onTakeMega}
        />
        <ActionDock
          game={game}
          player={player}
          canInteract={canInteract}
          isMyTurn={isMyTurn}
          hideEndTurn={tutorialHideEndTurn}
          selection={selection}
          phase={phase}
          onCapture={onCaptureSelectedCard}
          onReserveCard={onReserveSelectedCard}
          onReserveDeck={onReserveSelectedDeck}
          onClear={onClearTake}
          onDiscard={onDiscard}
          onEvolve={onEvolve}
          onMegaEvolve={onMegaEvolve}
          onEndTurn={onEndTurn}
        />
      </div>
      <footer id="players">
        {game.players.map((trainer, index) => (
          <PlayerPanel
            key={trainer.id}
            game={game}
            player={trainer}
            index={index}
            online={online}
            selection={selection}
            phase={phase}
            busy={busy}
            onSelectCard={onSelectCard}
            onInspect={onInspect}
          />
        ))}
      </footer>
      <LogDrawer
        open={logOpen}
        game={game}
        online={online}
        localUndoAvailable={localUndoAvailable}
        onClose={onCloseLog}
        onUndo={onUndo}
        onVoteUndo={onVoteUndo}
        onInspect={onInspect}
      />
    </main>
  );
}

function topbarState(game: GameState, online: OnlineSessionState | null): string {
  if (game.phase === 'gameover') return 'turn-over';
  const current = playerFrom(game, game.turn);
  if (current.isAI) return 'turn-ai';
  if (!online || online.seat === game.turn) return 'turn-mine';
  return 'turn-wait';
}
