"""
Test per effetti delle carte (Costruzioni, Magie, Orde).
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from engine.game import create_game
from engine.effects import apply_effect, EFFECT_REGISTRY
from engine.deck import make_warrior_instance, make_building_instance, make_wall_instance
from engine.actions import play_warrior, play_building, add_wall, complete_building, ActionError
from engine.cards import CARD_REGISTRY


class TestEffettiCostruzioni:
    def _setup(self):
        state = create_game(["Player1", "Player2"])
        state.current_player_index = 0
        player = state.players[0]
        player.mana_remaining = 10
        return state, player

    def test_ariete_base(self):
        state, player = self._setup()
        result = apply_effect("ariete_effect", state, player, completed=False)
        assert result["att_bonus"] == 1

    def test_ariete_completo(self):
        state, player = self._setup()
        result = apply_effect("ariete_effect", state, player, completed=True)
        assert result["att_bonus"] == 2

    def test_catapulta_base(self):
        state, player = self._setup()
        result = apply_effect("catapulta_effect", state, player, completed=False)
        assert result["git_bonus"] == 1

    def test_saracinesca_base(self):
        state, player = self._setup()
        result = apply_effect("saracinesca_effect", state, player, completed=False)
        assert result["dif_bonus"] == 1

    def test_estrattore_completo_sempre_mana(self):
        state, player = self._setup()
        initial_mana = player.mana_remaining
        result = apply_effect("estrattore_effect", state, player, completed=True)
        assert result["mana_gained"] == 1
        assert player.mana_remaining == initial_mana + 1

    def test_cardo_passivo(self):
        """Cardo base non ha effetto (passivo), completed aggiunge effetto attivo se Decumano presente."""
        state, player = self._setup()
        result = apply_effect("cardo_effect", state, player, completed=False)
        assert result.get("passive") is True

    def test_cardo_completed_con_decumano(self):
        """Cardo completato con Decumano in gioco aggiunge effetto attivo."""
        state, player = self._setup()
        from engine.deck import make_building_instance
        decumano_inst = make_building_instance("decumano_1")
        player.field.village.buildings.append(decumano_inst)
        result = apply_effect("cardo_effect", state, player, completed=True)
        assert result.get("passive") is True
        # deve aver aggiunto un active_effect
        assert any(e.get("type") == "cardo_move" for e in player.active_effects)

    def test_decumano_passivo(self):
        """Decumano base non aggiunge muri (passivo)."""
        state, player = self._setup()
        result = apply_effect("decumano_effect", state, player, completed=False)
        assert result.get("passive") is True

    def test_scrigno_passivo(self):
        """Scrigno è passivo: _apply_scrigno_bonus gestisce il bonus direttamente dal building."""
        state, player = self._setup()
        result = apply_effect("scrigno_effect", state, player, completed=False)
        assert result.get("passive") is True


class TestEffettiMagie:
    def _setup(self):
        state = create_game(["Player1", "Player2"])
        state.current_player_index = 0
        player = state.players[0]
        opponent = state.players[1]
        return state, player, opponent

    def test_ardolancio_base(self):
        state, player, opp = self._setup()
        # Aggiungi muri all'avversario
        for i in range(10):
            opp.field.bastion_left.walls.append(make_wall_instance(f"wall_{i+1}"))
        result = apply_effect(
            "ardolancio_effect", state, player, prodigy=False,
            target_player_id=opp.id, target_bastion_side="left",
        )
        assert result.get("damage") == 2

    def test_ardolancio_prodigio(self):
        state, player, opp = self._setup()
        for i in range(10):
            opp.field.bastion_left.walls.append(make_wall_instance(f"wall_{i+1}"))
        result = apply_effect(
            "ardolancio_effect", state, player, prodigy=True,
            target_player_id=opp.id, target_bastion_side="left",
        )
        assert result.get("damage") == 4

    def test_vitalflusso_con_sorgiva(self):
        """Vitalflusso richiede una Sorgiva completa per aggiungere una Vita."""
        state, player, _ = self._setup()
        from engine.deck import make_building_instance
        sorgiva_inst = make_building_instance("sorgiva_1")
        sorgiva_inst.completed = True
        player.field.village.buildings.append(sorgiva_inst)
        player.life_cards = ["dummy_life_1"]
        result = apply_effect("vitalflusso_effect", state, player, prodigy=False)
        assert result["lives_gained"] == 1
        assert player.lives == 2
        # La Sorgiva deve essere stata rimossa
        assert not any(b.base_card_id == "sorgiva" for b in player.field.village.buildings)

    def test_vitalflusso_senza_sorgiva_fallisce(self):
        """Vitalflusso senza Sorgiva completa ritorna errore."""
        state, player, _ = self._setup()
        player.life_cards = ["dummy_life_1"]
        result = apply_effect("vitalflusso_effect", state, player, prodigy=False)
        assert "error" in result
        assert player.lives == 1  # Vita invariata

    def test_vitalflusso_prodigio_scarta_sorgive_nemici(self):
        """Vitalflusso Prodigio scarta anche le Sorgive degli avversari."""
        state, player, opp = self._setup()
        from engine.deck import make_building_instance
        # Aggiungi Sorgiva al giocatore corrente
        sorgiva_own = make_building_instance("sorgiva_1")
        sorgiva_own.completed = True
        player.field.village.buildings.append(sorgiva_own)
        # Aggiungi Sorgiva all'avversario
        sorgiva_opp = make_building_instance("sorgiva_2")
        sorgiva_opp.completed = False  # non deve importare
        opp.field.village.buildings.append(sorgiva_opp)
        player.life_cards = ["dummy_life_1"]
        result = apply_effect("vitalflusso_effect", state, player, prodigy=True)
        assert result["lives_gained"] == 1
        # La Sorgiva avversaria deve essere stata scartata
        assert not any(b.base_card_id == "sorgiva" for b in opp.field.village.buildings)

    def test_agilpesca_base(self):
        """Agilpesca base: pesca 1 carta e ottieni 1 azione aggiuntiva."""
        state, player, _ = self._setup()
        initial = len(player.hand)
        initial_actions = player.actions_remaining
        result = apply_effect("agilpesca_effect", state, player, prodigy=False)
        assert len(player.hand) == initial + 1
        assert player.actions_remaining == initial_actions + 1

    def test_agilpesca_prodigio(self):
        """Agilpesca prodigio: pesca 1+1 carte (2 totali) e scarta 1."""
        state, player, _ = self._setup()
        initial = len(player.hand)
        # Fornisci carta da scartare
        discard_iid = player.hand[0] if player.hand else None
        result = apply_effect("agilpesca_effect", state, player, prodigy=True,
                              discard_iid=discard_iid)
        # Pesca 2 carte totali: il netto è +1 (2 pescate - 1 scartata)
        if discard_iid:
            assert len(player.hand) == initial + 1
        else:
            assert result.get("needs_discard") is True

    def test_investimento_base(self):
        state, player, _ = self._setup()
        player.mana_remaining = 0
        apply_effect("investimento_effect", state, player, prodigy=False)
        assert player.mana_remaining == 2

    def test_investimento_prodigio(self):
        """Investimento prodigio: 2 Mana subito + deferred 2 al prossimo turno."""
        state, player, _ = self._setup()
        player.mana_remaining = 0
        result = apply_effect("investimento_effect", state, player, prodigy=True)
        assert player.mana_remaining == 2  # 2 Mana immediati
        assert result.get("deferred_mana") == 2  # 2 differiti al prossimo turno
        assert any(e.get("type") == "investimento_deferred" for e in player.active_effects)

    def test_malcomune_scarta_guerriero_avversario(self):
        """Malcomune: scarta un tuo Guerriero; ogni avversario scarta un Guerriero della stessa Specie."""
        state = create_game(["A", "B", "C"])
        state.current_player_index = 0
        player = state.players[0]
        opp1 = state.players[1]
        opp2 = state.players[2]
        # Metti guerrieri Elfi in campo
        from engine.deck import make_warrior_instance
        own_w = make_warrior_instance("patrizio_1")
        player.field.vanguard.append(own_w)
        opp1_w = make_warrior_instance("giulio_1")
        opp1.field.vanguard.append(opp1_w)
        opp2_w = make_warrior_instance("decimo_1")
        opp2.field.vanguard.append(opp2_w)
        result = apply_effect("malcomune_effect", state, player, prodigy=False,
                              own_warrior_iid=own_w.instance_id)
        # Il proprio guerriero deve essere scartato
        assert result.get("own_discarded") == own_w.instance_id
        assert len(player.field.vanguard) == 0
        # Gli avversari perdono un Guerriero Elfo
        assert len(result.get("enemies_discarded", [])) == 2

    def test_magiscudo_immunita_magie(self):
        """Magiscudo aggiunge immunità alle Magie (non aggiunge muri)."""
        state, player, _ = self._setup()
        result = apply_effect("magiscudo_effect", state, player, prodigy=False)
        assert result.get("spell_immune") is True
        assert any(e.get("type") == "spell_immune" for e in player.active_effects)

    def test_velocemento_gioca_costruzione(self):
        """Velocemento gioca una Costruzione dalla mano senza costo (non aggiunge azioni)."""
        state, player, _ = self._setup()
        # Trova una Costruzione in mano
        from engine.deck import get_base_card_id
        from engine.cards import get_card, BuildingCard
        building_iid = None
        for iid in player.hand:
            base_id = get_base_card_id(iid)
            try:
                card = get_card(base_id)
                if isinstance(card, BuildingCard):
                    building_iid = iid
                    break
            except KeyError:
                continue
        if building_iid is None:
            pytest.skip("Nessuna Costruzione in mano (random)")
        initial_buildings = len(player.field.village.buildings)
        result = apply_effect("velocemento_effect", state, player, prodigy=False,
                              building_instance_id=building_iid)
        assert result.get("building_played") == building_iid
        assert len(player.field.village.buildings) == initial_buildings + 1


class TestEffettiOrda:
    def _setup_with_warrior(self, species, count=3):
        state = create_game(["A", "B"])
        state.current_player_index = 0
        player = state.players[0]
        # Metti guerrieri in campo
        warrior_ids = {
            "elfo": ["patrizio", "giulio", "decimo"],
            "nano": ["reinhold", "faust", "joseph"],
            "umano": ["orfeo", "polemarco", "eracle"],
            "maga": ["araminta", "evelyn", "madeleine"],
        }
        for i, wid in enumerate(warrior_ids.get(species, [])[:count]):
            w = make_warrior_instance(f"{wid}_1")
            player.field.vanguard.append(w)
        return state, player

    def test_patrizio_horde_git_bonus(self):
        state, player = self._setup_with_warrior("elfo")
        w = player.field.vanguard[0]  # patrizio
        initial_git = w.effective_git()
        apply_effect("patrizio_horde", state, player, warrior_iid=w.instance_id)
        assert w.effective_git() == initial_git + 2

    def test_faust_horde_sopprime_biblioteche(self):
        """Faust horde: sopprime le Biblioteche avversarie (non dà Mana)."""
        state, player = self._setup_with_warrior("nano")
        initial_effects = len(player.active_effects)
        result = apply_effect("faust_horde", state, player)
        assert result.get("opponent_biblioteche_suppressed") is True
        assert len(player.active_effects) == initial_effects + 1
        assert any(e.get("type") == "faust_biblioteca_suppress" for e in player.active_effects)

    def test_giulio_horde_draw(self):
        state, player = self._setup_with_warrior("elfo")
        initial_hand = len(player.hand)
        apply_effect("giulio_horde", state, player)
        assert len(player.hand) == initial_hand + 1

    def test_check_horde_true(self):
        state, player = self._setup_with_warrior("elfo", 3)
        hordes = player.check_horde()
        assert "elfo" in hordes
        assert len(hordes["elfo"]) >= 3

    def test_check_horde_false_with_2(self):
        state = create_game(["A", "B"])
        player = state.players[0]
        player.field.vanguard.append(make_warrior_instance("patrizio_1"))
        player.field.vanguard.append(make_warrior_instance("giulio_1"))
        hordes = player.check_horde()
        assert "elfo" not in hordes


class TestAzioni:
    def _setup(self):
        state = create_game(["A", "B"])
        state.current_player_index = 0
        player = state.players[0]
        player.mana_remaining = 10
        player.actions_remaining = 2
        return state, player

    def test_play_warrior_valid(self):
        state, player = self._setup()
        # Trova una carta guerriero in mano
        from engine.deck import get_base_card_id
        from engine.cards import get_card, WarriorCard
        warrior_iid = None
        for iid in player.hand:
            card = get_card(get_base_card_id(iid))
            if isinstance(card, WarriorCard):
                warrior_iid = iid
                break
        if warrior_iid is None:
            pytest.skip("Nessun guerriero in mano (random)")
        result = play_warrior(state, player.id, warrior_iid, "vanguard")
        assert result["card"] == warrior_iid
        assert len(player.field.vanguard) == 1

    def test_play_warrior_wrong_turn(self):
        state, player = self._setup()
        state.current_player_index = 1
        from engine.deck import get_base_card_id
        from engine.cards import get_card, WarriorCard
        warrior_iid = None
        for iid in player.hand:
            card = get_card(get_base_card_id(iid))
            if isinstance(card, WarriorCard):
                warrior_iid = iid
                break
        if warrior_iid is None:
            pytest.skip("Nessun guerriero in mano")
        with pytest.raises(ActionError):
            play_warrior(state, player.id, warrior_iid, "vanguard")

    def test_add_wall(self):
        state, player = self._setup()
        c1, c2, c3 = player.hand[0], player.hand[1], player.hand[2]
        add_wall(state, player.id, [
            {"instance_id": c1, "bastion": "left"},
            {"instance_id": c2, "bastion": "right"},
            {"instance_id": c3, "bastion": "left"},
        ])
        assert len(player.field.bastion_left.walls) == 2
        assert len(player.field.bastion_right.walls) == 1
        assert c1 not in player.hand

    def test_add_wall_no_actions(self):
        state, player = self._setup()
        player.actions_remaining = 0
        with pytest.raises(ActionError):
            add_wall(state, player.id, [{"instance_id": player.hand[0], "bastion": "left"}])

    def test_all_effects_registered(self):
        """Verifica che tutti gli effect_id delle carte abbiano un handler."""
        from engine.cards import BuildingCard, SpellCard, WarriorCard
        for card in CARD_REGISTRY.values():
            if isinstance(card, (BuildingCard, SpellCard)):
                assert card.effect_id in EFFECT_REGISTRY, \
                    f"Effetto non registrato: {card.effect_id} ({card.id})"
            if isinstance(card, WarriorCard) and card.horde_effect_id:
                assert card.horde_effect_id in EFFECT_REGISTRY, \
                    f"Effetto Orda non registrato: {card.horde_effect_id} ({card.id})"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
