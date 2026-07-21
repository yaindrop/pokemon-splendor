from __future__ import annotations

import engine


def test_initial_state_conserves_tokens() -> None:
    state = engine.new_game(num_players=2, seed=42)

    for color in engine.ALL_TOKENS:
        held = sum(player["tokens"][color] for player in state["players"])
        assert held + state["supply"][color] == engine.supply_for(2)[color]
