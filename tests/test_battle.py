"""
Test per la logica di Battaglia.
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from engine.game import create_game
from engine.battle import (
    ActionError,
    calculate_damage,
    attacker_stats,
    defender_stats,
    resolve_battle,
    adjacent_bastions,
    get_valid_attack_targets,
)
from engine.deck import make_warrior_instance, make_wall_instance


class TestAdiacenza:
    def test_2_players(self):
        adj = adjacent_bastions(0, 2)
        assert adj["right_attacks"] == (1, "left")
        assert adj["left_attacks"] == (1, "right")

    def test_4_players_circolari(self):
        adj = adjacent_bastions(0, 4)
        assert adj["right_attacks"] == (1, "left")
        assert adj["left_attacks"]  == (3, "right")

        adj2 = adjacent_bastions(3, 4)
        assert adj2["right_attacks"] == (0, "left")
        assert adj2["left_attacks"]  == (2, "right")

    def test_valid_targets(self):
        state = create_game(["A", "B"])
        # Senza guerrieri in avanscoperta → nessun bersaglio valido
        assert get_valid_attack_targets(state) == []
        # Con un guerriero → 2 bersagli (bastione sinistro e destro dell'avversario)
        w = make_warrior_instance("orfeo_1")
        state.players[state.current_player_index].field.vanguard.append(w)
        assert len(get_valid_attack_targets(state)) == 2


class TestDanni:
    def test_no_damage_if_att_less_than_dif(self):
        dmg_a, dmg_g, total = calculate_damage(att_att=1, att_git=0, def_dif=5, def_git=0)
        assert dmg_a == 0
        assert total == 0

    def test_attack_damage_only(self):
        dmg_a, dmg_g, total = calculate_damage(att_att=5, att_git=0, def_dif=2, def_git=0)
        assert dmg_a == 3
        assert dmg_g == 0
        assert total == 3

    def test_ranged_damage_only(self):
        dmg_a, dmg_g, total = calculate_damage(att_att=1, att_git=4, def_dif=5, def_git=1)
        assert dmg_a == 0
        assert dmg_g == 3
        assert total == 3

    def test_combined_damage(self):
        dmg_a, dmg_g, total = calculate_damage(att_att=5, att_git=3, def_dif=2, def_git=1)
        assert dmg_a == 3
        assert dmg_g == 2
        assert total == 5


class TestBattliaCompleta:
    def _setup_battle(self, att_warriors=None, def_warriors=None, def_walls=0):
        state = create_game(["Attaccante", "Difensore"])
        state.current_player_index = 0
        attacker = state.players[0]
        defender = state.players[1]

        attacker.field.vanguard.clear()
        if att_warriors:
            for w in att_warriors:
                attacker.field.vanguard.append(w)

        defender.field.bastion_left.warriors.clear()
        defender.field.bastion_left.walls.clear()
        if def_warriors:
            for w in def_warriors:
                defender.field.bastion_left.warriors.append(w)
        for i in range(def_walls):
            wall = make_wall_instance(f"dummy_wall_{i+1}")
            defender.field.bastion_left.walls.append(wall)

        return state, attacker, defender

    def test_no_warriors_cannot_attack(self):
        state, att, deff = self._setup_battle()
        with pytest.raises(ActionError):
            resolve_battle(state, 0, 1, "left")

    def test_walls_absorb_damage(self):
        # ATT=4, DIF=0 → danno=4; con 4 muri → 0 vite perse
        att_w = make_warrior_instance("orfeo_1")
        att_w.temp_modifiers["att"] = 2  # porta att a 5
        state, att, deff = self._setup_battle([att_w], def_walls=10)
        result = resolve_battle(state, 0, 1, "left")
        assert result["life_lost"] == 0
        assert result["walls_destroyed"] > 0

    def test_insufficient_walls_lose_life(self):
        # ATT molto alto, 0 muri → perde 1 vita
        att_w = make_warrior_instance("orfeus_1")
        state, att, deff = self._setup_battle([att_w], def_walls=0)
        result = resolve_battle(state, 0, 1, "left")
        assert result["total_damage"] > 0
        assert result["life_lost"] == 1
        assert state.players[1].lives == 2

    def test_battle_log_recorded(self):
        w = make_warrior_instance("orfeo_1")
        state, att, deff = self._setup_battle([w])
        initial_log_len = len(state.log)
        resolve_battle(state, 0, 1, "left")
        assert len(state.log) > initial_log_len


class TestBuildingBattleBonus:
    def test_ariete_bonus(self):
        state = create_game(["A", "B"])
        att = state.players[0]
        # Aggiungi Ariete completato
        from engine.deck import make_building_instance
        ariete = make_building_instance("ariete_1")
        ariete.completed = True
        att.field.village.buildings.append(ariete)

        att_att, att_git = attacker_stats(att)
        # Senza guerrieri → stats = 0 + bonus 2 (ariete completo)
        # Nota: senza guerrieri att_att base = 0
        assert att_att == 2  # 0 + 2 da ariete completo

    def test_saracinesca_bonus(self):
        state = create_game(["A", "B"])
        deff = state.players[1]
        from engine.deck import make_building_instance
        saraci = make_building_instance("saracinesca_1")
        saraci.completed = False
        deff.field.village.buildings.append(saraci)

        def_dif, def_git = defender_stats(deff, "left")
        assert def_dif == 1  # 0 + 1 da saracinesca base


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
