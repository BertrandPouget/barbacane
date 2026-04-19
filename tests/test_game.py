"""
Test unitari per il motore di gioco di Barbacane.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from engine.game import create_game, end_turn, simulate_game
from engine.cards import CARD_REGISTRY


class TestSetup:
    def test_card_registry_loaded(self):
        assert len(CARD_REGISTRY) > 0
        assert "patrizio" in CARD_REGISTRY
        assert "ardolancio" in CARD_REGISTRY
        assert "ariete" in CARD_REGISTRY

    def test_deck_size(self):
        from engine.deck import build_deck
        deck = build_deck()
        assert len(deck) == 200

    def test_create_game_2_players(self):
        state = create_game(["Alice", "Bob"])
        assert len(state.players) == 2
        assert state.turn == 1
        assert state.game_id is not None
        # Ogni giocatore ha 5 carte
        for p in state.players:
            assert len(p.hand) == 5
            assert p.lives == 3

    def test_create_game_4_players(self):
        state = create_game(["A", "B", "C", "D"])
        assert len(state.players) == 4
        for p in state.players:
            assert len(p.hand) == 5

    def test_create_game_invalid_players(self):
        with pytest.raises(ValueError):
            create_game(["Solo"])
        with pytest.raises(ValueError):
            create_game(["A", "B", "C", "D", "E"])

    def test_initial_mana(self):
        state = create_game(["Alice", "Bob"])
        # Turno 1: 1 mana
        assert state.current_player.mana_remaining == 1

    def test_mana_schedule(self):
        state = create_game(["Alice", "Bob"])
        assert state.mana_for_turn(1) == 1
        assert state.mana_for_turn(2) == 1
        assert state.mana_for_turn(3) == 2
        assert state.mana_for_turn(5) == 3
        assert state.mana_for_turn(7) == 4
        assert state.mana_for_turn(10) == 5


class TestDeck:
    def test_draw_cards(self):
        from engine.deck import draw_cards
        state = create_game(["Alice", "Bob"])
        player = state.players[0]
        initial_hand = len(player.hand)
        initial_deck = len(state.deck)
        drawn = draw_cards(state, player.id, 3)
        assert len(drawn) == 3
        assert len(player.hand) == initial_hand + 3
        assert len(state.deck) == initial_deck - 3

    def test_deck_recycles_discard(self):
        from engine.deck import draw_cards
        state = create_game(["Alice", "Bob"])
        player = state.players[0]
        # Svuota il mazzo mettendo tutto negli scarti
        state.discard_pile.extend(state.deck)
        state.deck.clear()
        drawn = draw_cards(state, player.id, 5)
        assert len(drawn) == 5  # Il mazzo è stato riciclato

    def test_instance_ids_unique(self):
        from engine.deck import build_deck
        deck = build_deck()
        assert len(set(deck)) == len(deck), "Instance IDs non univoci!"

    def test_get_base_card_id(self):
        from engine.deck import get_base_card_id
        assert get_base_card_id("patrizio_1") == "patrizio"
        assert get_base_card_id("san_patrizio_2") == "san_patrizio"
        assert get_base_card_id("ariete_4") == "ariete"


class TestTurn:
    def test_end_turn_passes_player(self):
        state = create_game(["Alice", "Bob"])
        first_idx = state.current_player_index
        end_turn(state)
        assert state.current_player_index != first_idx

    def test_end_turn_draws_to_5(self):
        state = create_game(["Alice", "Bob"])
        player = state.current_player
        # Usa tutte le carte
        player.hand = player.hand[:2]
        end_turn(state)
        # Il giocatore successivo ha 5 carte (il precedente ha pescato)
        # Dopo end_turn il giocatore precedente dovrebbe avere 5 carte
        # (nota: il giocatore 0 pesca prima che tocchi al 1)

    def test_actions_reset_on_new_turn(self):
        state = create_game(["Alice", "Bob"])
        player = state.current_player
        player.actions_remaining = 0
        end_turn(state)
        end_turn(state)  # torna al primo giocatore
        assert state.current_player.actions_remaining == 2

    def test_mana_increases_with_turns(self):
        state = create_game(["Alice", "Bob"])
        # Turno 1
        assert state.mana_for_turn(1) == 1
        # Avanza al turno 3
        state.turn = 3
        assert state.mana_for_turn(3) == 2


class TestCards:
    def test_total_cards_200(self):
        total = sum(c.copies for c in CARD_REGISTRY.values())
        assert total == 200, f"Totale carte: {total}, atteso 200"

    def test_warrior_count(self):
        from engine.cards import WarriorCard
        warriors = [c for c in CARD_REGISTRY.values() if isinstance(c, WarriorCard)]
        total = sum(c.copies for c in warriors)
        assert total == 72, f"Guerrieri: {total}, atteso 72"

    def test_spell_count(self):
        from engine.cards import SpellCard
        spells = [c for c in CARD_REGISTRY.values() if isinstance(c, SpellCard)]
        total = sum(c.copies for c in spells)
        assert total == 68, f"Magie: {total}, atteso 68"

    def test_building_count(self):
        from engine.cards import BuildingCard
        buildings = [c for c in CARD_REGISTRY.values() if isinstance(c, BuildingCard)]
        total = sum(c.copies for c in buildings)
        assert total == 60, f"Costruzioni: {total}, atteso 60"

    def test_evolution_chains(self):
        from engine.cards import WarriorCard
        for card in CARD_REGISTRY.values():
            if isinstance(card, WarriorCard):
                if card.evolves_into:
                    assert card.evolves_into in CARD_REGISTRY, \
                        f"{card.id} evolve in {card.evolves_into} che non esiste"


class TestSimulation:
    def test_simulate_2_players(self):
        winner = simulate_game(["Bot1", "Bot2"], verbose=False)
        assert winner in ("Bot1", "Bot2")

    def test_simulate_4_players(self):
        winner = simulate_game(["A", "B", "C", "D"], verbose=False)
        assert winner in ("A", "B", "C", "D")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
