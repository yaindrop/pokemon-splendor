import {
  Engine as E,
  type BaseTier,
  type GameState,
  type Player,
  type PokemartTier,
} from '@pokemon-splendor/game-core';
import type { ReactElement } from 'react';
import { GameButton, HoverTip } from '../components/primitives.js';
import {
  TIER_NAMES,
  affordInfo,
  cardFrom,
  isReservableTier,
  type AffordInfo,
  type GameSelection,
  type ReservableTier,
} from './model.js';

export function FieldArea({
  game,
  player,
  canInteract,
  selection,
  onSelectCard,
  onSelectDeck,
  onClearSelection,
}: {
  readonly game: GameState;
  readonly player: Player;
  readonly canInteract: boolean;
  readonly selection: GameSelection;
  readonly onSelectCard: (cardId: string) => void;
  readonly onSelectDeck: (tier: ReservableTier) => void;
  readonly onClearSelection: () => void;
}): ReactElement {
  return (
    <section id="field">
      {game.megasEnabled && game.megaOffer.length ? (
        <div className="tier-row tier-special tier-mega">
          <div className="tier-label">Mega</div>
          <div className="card-strip">
            {game.megaOffer.map((id) => (
              <CardTile
                key={id}
                game={game}
                cardId={id}
                selected={selection.selectedCardId === id}
                affordable={
                  canInteract &&
                  player.megaToken >= 1 &&
                  player.board.some(
                    (boardId) => cardFrom(game, boardId).name === cardFrom(game, id).megaFrom,
                  )
                }
                onSelect={onSelectCard}
                onClearSelection={onClearSelection}
              />
            ))}
          </div>
        </div>
      ) : null}
      <TierRow
        game={game}
        player={player}
        tiers={['legend', 'rare']}
        special
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      <TierRow
        game={game}
        player={player}
        tiers={['stage3']}
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      <TierRow
        game={game}
        player={player}
        tiers={['stage2']}
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      <TierRow
        game={game}
        player={player}
        tiers={['stage1']}
        canInteract={canInteract}
        selection={selection}
        onSelectCard={onSelectCard}
        onSelectDeck={onSelectDeck}
        onClearSelection={onClearSelection}
      />
      {game.pokemartEnabled ? (
        <>
          <TierRow
            game={game}
            player={player}
            tiers={['pmL3']}
            pokemart
            canInteract={canInteract}
            selection={selection}
            onSelectCard={onSelectCard}
            onSelectDeck={onSelectDeck}
            onClearSelection={onClearSelection}
          />
          <TierRow
            game={game}
            player={player}
            tiers={['pmL2']}
            pokemart
            canInteract={canInteract}
            selection={selection}
            onSelectCard={onSelectCard}
            onSelectDeck={onSelectDeck}
            onClearSelection={onClearSelection}
          />
          <TierRow
            game={game}
            player={player}
            tiers={['pmL1']}
            pokemart
            canInteract={canInteract}
            selection={selection}
            onSelectCard={onSelectCard}
            onSelectDeck={onSelectDeck}
            onClearSelection={onClearSelection}
          />
        </>
      ) : null}
    </section>
  );
}

interface TierRowProps {
  readonly game: GameState;
  readonly player: Player;
  readonly tiers: readonly BaseTierOrPokemartTier[];
  readonly special?: boolean;
  readonly pokemart?: boolean;
  readonly canInteract: boolean;
  readonly selection: GameSelection;
  readonly onSelectCard: (cardId: string) => void;
  readonly onSelectDeck: (tier: ReservableTier) => void;
  readonly onClearSelection: () => void;
}

type BaseTierOrPokemartTier = BaseTier | PokemartTier;

function TierRow({
  game,
  player,
  tiers,
  special = false,
  pokemart = false,
  canInteract,
  selection,
  onSelectCard,
  onSelectDeck,
  onClearSelection,
}: TierRowProps): ReactElement {
  return (
    <div className={`tier-row${special ? ' tier-special' : ''}${pokemart ? ' tier-pokemart' : ''}`}>
      <div className="tier-label">{tiers.map((tier) => TIER_NAMES[tier]).join('/')}</div>
      {tiers.map((tier) => {
        const cards = game.field[tier] ?? [];
        const deck = game.decks[tier] ?? [];
        const reservable =
          isReservableTier(tier) &&
          canInteract &&
          player.reserve.length < E.HAND_MAX &&
          deck.length > 0;
        return (
          <div className="tier-cluster" key={tier}>
            <DeckPile
              tier={tier}
              count={deck.length}
              reservable={reservable}
              selected={selection.selectedDeck === tier}
              onSelect={() => {
                onSelectDeck(tier);
              }}
              onClearSelection={onClearSelection}
            />
            <div className="card-strip">
              {cards.map((cardId, index) =>
                cardId ? (
                  <CardTile
                    key={cardId}
                    game={game}
                    cardId={cardId}
                    selected={selection.selectedCardId === cardId}
                    affordable={
                      canInteract ? affordInfo(game, player, cardFrom(game, cardId)) : null
                    }
                    onSelect={onSelectCard}
                    onClearSelection={onClearSelection}
                  />
                ) : (
                  <div className="card" key={`${tier}-${index}`}>
                    <div className="empty-slot">—</div>
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeckPile({
  tier,
  count,
  reservable,
  selected,
  onSelect,
  onClearSelection,
}: {
  readonly tier: BaseTierOrPokemartTier;
  readonly count: number;
  readonly reservable: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onClearSelection: () => void;
}): ReactElement {
  if (!reservable) {
    return (
      <div className="deck-pile" data-tier={tier}>
        <div className="count">{count}</div>
      </div>
    );
  }
  return (
    <GameButton
      className={`deck-pile reservable${selected ? ' selected' : ''}`}
      data-tier={tier}
      aria-label={`预留${TIER_NAMES[tier]}牌堆顶，剩余 ${count} 张`}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        if (selected) onClearSelection();
      }}
    >
      <span className="count">{count}</span>
    </GameButton>
  );
}

function CardTile({
  game,
  cardId,
  selected,
  affordable,
  onSelect,
  onClearSelection,
}: {
  readonly game: GameState;
  readonly cardId: string;
  readonly selected: boolean;
  readonly affordable: AffordInfo | null | boolean;
  readonly onSelect: (cardId: string) => void;
  readonly onClearSelection: () => void;
}): ReactElement {
  const card = cardFrom(game, cardId);
  const needsMaster =
    typeof affordable === 'object' && affordable !== null && affordable.master > 0;
  const className = `card${affordable ? (needsMaster ? ' affordable affordable-wild' : ' affordable') : ''}${selected ? ' selected' : ''}`;
  return (
    <HoverTip
      label={<img className="base-card-preview" src={card.img} alt={`${card.name} 卡牌预览`} />}
    >
      <GameButton
        className={className}
        data-card={cardId}
        aria-label={card.name}
        onClick={() => {
          onSelect(cardId);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (selected) onClearSelection();
        }}
      >
        <img src={card.img} alt={card.name} loading="lazy" />
      </GameButton>
    </HoverTip>
  );
}
