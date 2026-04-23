"""
Test sistematico di tutte le carte di Barbacane.
Verifica che ogni effetto (base, prodigio, completo, orda) funzioni come descritto.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from engine.game import create_game
from engine.models import (
    GameState, Player, WarriorInstance, BuildingInstance, WallInstance,
    PlayerField, Bastion, Village,
)
from engine.deck import (
    make_warrior_instance, make_building_instance, make_wall_instance,
    get_base_card_id,
)
from engine.effects import apply_effect
from engine.actions import (
    play_warrior, play_spell, play_building, complete_building,
    add_wall, evolve_warrior, activate_horde, reposition_warrior,
    arena_activate,
)
from engine.battle import resolve_battle, apply_damage_to_bastion


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_state(player_names=None) -> GameState:
    """Crea uno stato di gioco base con 2 giocatori. Il giocatore 0 è sempre di turno."""
    names = player_names or ["Test", "Nemico"]
    state = create_game(names)
    # Forza sempre il giocatore 0 come giocatore di turno
    state.current_player_index = 0
    # Mana e azioni abbondanti per i test
    for p in state.players:
        p.mana_remaining = 20
        p.actions_remaining = 10
    return state


def me(state: GameState) -> Player:
    return state.players[0]


def enemy(state: GameState) -> Player:
    return state.players[1]


def give_card(player: Player, instance_id: str) -> None:
    """Aggiunge una carta in mano al giocatore (se non c'è già)."""
    if instance_id not in player.hand:
        player.hand.append(instance_id)


def place_warrior(player: Player, base_id: str, iid: str = None, region: str = "vanguard") -> WarriorInstance:
    """Posiziona un guerriero in campo senza consumare mana/azioni."""
    iid = iid or f"{base_id}_test"
    # Usa sempre base_id esplicito per evitare errori con get_base_card_id su IDs non standard
    w = WarriorInstance(instance_id=iid, base_card_id=base_id)
    if region == "vanguard":
        player.field.vanguard.append(w)
    elif region == "bastion_left":
        player.field.bastion_left.warriors.append(w)
    elif region == "bastion_right":
        player.field.bastion_right.warriors.append(w)
    return w


def place_building(player: Player, base_id: str, iid: str = None, completed: bool = False) -> BuildingInstance:
    """Posiziona una costruzione nel Villaggio senza consumare mana/azioni."""
    iid = iid or f"{base_id}_test"
    b = BuildingInstance(instance_id=iid, base_card_id=base_id, completed=completed)
    player.field.village.buildings.append(b)
    return b


def add_walls_to_bastion(player: Player, side: str, count: int) -> list:
    """Aggiunge muri a un bastione."""
    walls = []
    bastion = player.field.bastion_left if side == "left" else player.field.bastion_right
    for i in range(count):
        w = WallInstance(instance_id=f"wall_test_{side}_{i}", base_card_id="giulio")
        bastion.walls.append(w)
        walls.append(w)
    return walls


# ---------------------------------------------------------------------------
# GUERRIERI — Horde Effects
# ---------------------------------------------------------------------------

class TestHordeEffects:

    def test_patrizio_horde_git_bonus(self):
        """patrizio_horde: +2 GIT alla carta specificata."""
        state = make_state()
        w = place_warrior(me(state), "patrizio", "patrizio_h1")
        git_before = w.effective_git()
        result = apply_effect("patrizio_horde", state, me(state), warrior_iid="patrizio_h1")
        assert w.temp_modifiers.get("git", 0) == 2
        assert w.effective_git() == git_before + 2
        assert result["git_bonus"] == 2

    def test_reinhold_horde_sorgiva_discount(self):
        """reinhold_horde: aggiunge effetto sconto 2 Mana per completare Sorgive."""
        state = make_state()
        result = apply_effect("reinhold_horde", state, me(state))
        assert result["sorgiva_completion_discount"] == 2
        assert any(e.get("type") == "reinhold_sorgiva_discount" for e in me(state).active_effects)

    def test_araminta_horde_spell_return(self):
        """araminta_horde: gli Anatemi cost 1 tornano in mano."""
        state = make_state()
        result = apply_effect("araminta_horde", state, me(state))
        assert result["spell_return"] == "anatema"
        assert any(
            e.get("type") == "araminta_spell_return" and e.get("school") == "anatema"
            for e in me(state).active_effects
        )

    def test_orfeo_horde_att_dif_bonus(self):
        """orfeo_horde: +1 ATT e +1 DIF alla carta specificata."""
        state = make_state()
        w = place_warrior(me(state), "orfeo", "orfeo_h1")
        att_before = w.effective_att()
        dif_before = w.effective_dif()
        result = apply_effect("orfeo_horde", state, me(state), warrior_iid="orfeo_h1")
        assert w.effective_att() == att_before + 1
        assert w.effective_dif() == dif_before + 1
        assert result["att_bonus"] == 1
        assert result["dif_bonus"] == 1

    def test_giulio_horde_pending_search(self):
        """giulio_horde: imposta ricerca di Giulio II nel mazzo."""
        state = make_state()
        result = apply_effect("giulio_horde", state, me(state))
        assert result["search_pending"] is True
        assert state.pending_search is not None
        assert state.pending_search["condition"]["value"] == "giulio_ii"

    def test_faust_horde_biblioteca_suppress(self):
        """faust_horde: Biblioteche avversarie soppresse fino al prossimo turno."""
        state = make_state()
        result = apply_effect("faust_horde", state, me(state))
        assert result["opponent_biblioteche_suppressed"] is True
        assert any(
            e.get("type") == "faust_biblioteca_suppress"
            for e in me(state).active_effects
        )

    def test_evelyn_horde_spell_double(self):
        """evelyn_horde: Sortilegi cost 1 vengono giocati una seconda volta."""
        state = make_state()
        result = apply_effect("evelyn_horde", state, me(state))
        assert result["spell_double"] == "sortilegio"
        assert any(
            e.get("type") == "evelyn_spell_double" and e.get("school") == "sortilegio"
            for e in me(state).active_effects
        )

    def test_polemarco_horde_att_per_umano(self):
        """polemarco_horde: +1 ATT per ogni Umano in campo."""
        state = make_state()
        # Aggiungi 2 Umani
        w1 = place_warrior(me(state), "orfeo", "orfeo_pol1")
        w2 = place_warrior(me(state), "polemarco", "polemarco_pol1")
        result = apply_effect("polemarco_horde", state, me(state), warrior_iid="polemarco_pol1")
        assert result["umani_count"] == 2
        assert result["att_bonus"] == 2

    def test_decimo_horde_anti_fossato(self):
        """decimo_horde: attiva effetto anti-Fossato."""
        state = make_state()
        result = apply_effect("decimo_horde", state, me(state), warrior_iid="decimo_test")
        assert result["decimo_anti_fossato"] is True
        assert any(
            e.get("type") == "decimo_anti_fossato"
            for e in me(state).active_effects
        )

    def test_joseph_horde_no_trono_no_effect(self):
        """joseph_horde: senza Trono assegnato, nessun effetto."""
        state = make_state()
        w = place_warrior(me(state), "joseph", "joseph_h1")
        result = apply_effect("joseph_horde", state, me(state), warrior_iid="joseph_h1")
        assert result["has_trono"] is False

    def test_joseph_horde_with_trono_discards_enemy_troni(self):
        """joseph_horde: con Trono assegnato, scarta i Troni avversari."""
        state = make_state()
        # Joseph con un Trono assegnato
        w = place_warrior(me(state), "joseph", "joseph_h2")
        w.assigned_cards.append("trono_test1")
        # Trono avversario in gioco
        enemy_trono = place_building(enemy(state), "trono", "trono_enemy1")
        result = apply_effect("joseph_horde", state, me(state), warrior_iid="joseph_h2")
        assert result["has_trono"] is True
        assert len(result["enemy_troni_discarded"]) == 1
        assert "trono_enemy1" in state.discard_pile

    def test_madeleine_horde_incantesimo_prodigy_any_school(self):
        """madeleine_horde: i Prodigi degli Incantesimi si attivano con qualsiasi Scuola."""
        state = make_state()
        result = apply_effect("madeleine_horde", state, me(state))
        assert result["incantesimo_prodigy_any_school"] is True
        assert any(
            e.get("type") == "madeleine_prodigy_any_school"
            for e in me(state).active_effects
        )

    def test_eracle_horde_destroy_building_effect(self):
        """eracle_horde: attiva possibilità di distruggere Costruzione dopo battaglia con ≥3 danni."""
        state = make_state()
        result = apply_effect("eracle_horde", state, me(state))
        assert result["eracle_destroy_on_win"] is True
        assert result["min_damage"] == 3
        assert any(
            e.get("type") == "eracle_destroy_building"
            for e in me(state).active_effects
        )


# ---------------------------------------------------------------------------
# GUERRIERI — Evoluzione
# ---------------------------------------------------------------------------

class TestWarriorEvolution:

    def test_evolve_patrizio_to_san_patrizio(self):
        """Evolvere Patrizio in San Patrizio."""
        state = make_state()
        recruit_iid = "patrizio_1"
        hero_iid = "san_patrizio_1"
        # Metti in mano/campo
        state.deck = [iid for iid in state.deck if iid not in [recruit_iid, hero_iid]]
        give_card(me(state), hero_iid)
        # Posiziona la Recluta in campo
        w = WarriorInstance(instance_id=recruit_iid, base_card_id="patrizio")
        me(state).field.vanguard.append(w)
        result = evolve_warrior(state, me(state).id, recruit_iid, hero_iid)
        assert result["hero"] == hero_iid
        # L'Eroe è in campo
        assert any(w.instance_id == hero_iid for w in me(state).field.vanguard)
        # La Recluta non è in campo
        assert not any(w.instance_id == recruit_iid for w in me(state).field.vanguard)

    def test_hero_discard_restores_recruit(self):
        """Scartare un Eroe rimette in campo la Recluta con le carte assegnate."""
        from engine.actions import discard_card
        state = make_state()
        hero_iid = "san_patrizio_1"
        recruit_iid = "patrizio_1"
        hero = WarriorInstance(
            instance_id=hero_iid,
            base_card_id="san_patrizio",
            evolved_from=recruit_iid,
            assigned_cards=["giulio_1"],
        )
        me(state).field.vanguard.append(hero)
        state.discard_pile.append(recruit_iid)  # la recluta è "sotto" l'eroe
        result = discard_card(state, me(state).id, hero_iid, "field")
        assert result["discarded"] == hero_iid
        # La Recluta torna in campo
        assert any(w.instance_id == recruit_iid for w in me(state).field.vanguard)

    def test_recruit_discard_removes_assigned_cards(self):
        """Scartare una Recluta scarta anche le carte assegnate."""
        from engine.actions import discard_card
        state = make_state()
        recruit_iid = "patrizio_1"
        assigned_iid = "giulio_1"
        recruit = WarriorInstance(
            instance_id=recruit_iid,
            base_card_id="patrizio",
            assigned_cards=[assigned_iid],
        )
        me(state).field.vanguard.append(recruit)
        result = discard_card(state, me(state).id, recruit_iid, "field")
        assert assigned_iid in state.discard_pile


# ---------------------------------------------------------------------------
# MAGIE — Effetti Base e Prodigio
# ---------------------------------------------------------------------------

class TestSpellEffects:

    # --- Ardolancio ---

    def test_ardolancio_base_2_damage(self):
        """Ardolancio base: 2 Danni a un Bastione."""
        state = make_state()
        add_walls_to_bastion(enemy(state), "left", 3)
        walls_before = len(enemy(state).field.bastion_left.walls)
        result = apply_effect(
            "ardolancio_effect", state, me(state),
            prodigy=False,
            target_player_id=enemy(state).id,
            target_bastion_side="left",
        )
        assert result["damage"] == 2
        assert enemy(state).field.bastion_left.walls.__len__() == walls_before - 2

    def test_ardolancio_prodigy_4_damage(self):
        """Ardolancio prodigio: 4 Danni a un Bastione."""
        state = make_state()
        add_walls_to_bastion(enemy(state), "right", 5)
        walls_before = len(enemy(state).field.bastion_right.walls)
        result = apply_effect(
            "ardolancio_effect", state, me(state),
            prodigy=True,
            target_player_id=enemy(state).id,
            target_bastion_side="right",
        )
        assert result["damage"] == 4
        assert len(enemy(state).field.bastion_right.walls) == walls_before - 4

    # --- Vitalflusso ---

    def test_vitalflusso_base_adds_sorgiva_to_lives(self):
        """Vitalflusso base: aggiunge una Sorgiva completa alle Vite."""
        state = make_state()
        sorgiva = place_building(me(state), "sorgiva", "sorgiva_v1", completed=True)
        lives_before = me(state).lives
        result = apply_effect("vitalflusso_effect", state, me(state), prodigy=False)
        assert result.get("lives_gained") == 1
        assert me(state).lives == lives_before + 1
        # La Sorgiva non è più nel Villaggio
        assert not any(b.instance_id == "sorgiva_v1" for b in me(state).field.village.buildings)

    def test_vitalflusso_prodigy_discards_enemy_sorgiva(self):
        """Vitalflusso prodigio: scarta anche una Sorgiva avversaria."""
        state = make_state()
        place_building(me(state), "sorgiva", "sorgiva_v1", completed=True)
        place_building(enemy(state), "sorgiva", "sorgiva_enemy1")
        result = apply_effect("vitalflusso_effect", state, me(state), prodigy=True)
        assert result.get("lives_gained") == 1
        enemy_discarded = result.get("enemy_sorgive_discarded", [])
        assert len(enemy_discarded) == 1
        assert "sorgiva_enemy1" in state.discard_pile

    def test_vitalflusso_base_no_sorgiva(self):
        """Vitalflusso senza Sorgiva completa: errore."""
        state = make_state()
        result = apply_effect("vitalflusso_effect", state, me(state), prodigy=False)
        assert "error" in result

    # --- Magiscudo ---

    def test_magiscudo_base_spell_immune(self):
        """Magiscudo base: immunità alle Magie fino al prossimo turno."""
        state = make_state()
        result = apply_effect("magiscudo_effect", state, me(state), prodigy=False)
        assert result["spell_immune"] is True
        assert result["can_counter"] is False
        assert any(e.get("type") == "spell_immune" for e in me(state).active_effects)

    def test_magiscudo_prodigy_can_counter(self):
        """Magiscudo prodigio: può essere giocato come contromossa."""
        state = make_state()
        result = apply_effect("magiscudo_effect", state, me(state), prodigy=True)
        assert result["can_counter"] is True

    # --- Equipotenza ---

    def test_equipotenza_base_equalizes_own_warrior(self):
        """Equipotenza base: ATT e DIF diventano il maggiore dei due."""
        state = make_state()
        # Orfeo: ATT=3, DIF=2 → entrambi diventano 3
        w = place_warrior(me(state), "orfeo", "orfeo_eq1")
        result = apply_effect(
            "equipotenza_effect", state, me(state),
            prodigy=False, own_warrior_iid="orfeo_eq1"
        )
        assert w.effective_att() == w.effective_dif()
        expected = max(3, 2)  # orfeo ha ATT=3, DIF=2
        assert w.effective_att() == expected

    def test_equipotenza_prodigy_equalizes_enemy_to_min(self):
        """Equipotenza prodigio: ATT e DIF del bersaglio diventano il minore dei due."""
        state = make_state()
        w = place_warrior(enemy(state), "orfeo", "orfeo_eq2")
        result = apply_effect(
            "equipotenza_effect", state, me(state),
            prodigy=True,
            own_warrior_iid=None,
            enemy_warrior_iid="orfeo_eq2"
        )
        # orfeo: ATT=3, DIF=2 → entrambi diventano 2
        assert "enemy_equalized" in result
        assert w.effective_att() == min(3, 2)
        assert w.effective_dif() == min(3, 2)

    # --- Regicidio ---

    def test_regicidio_base_discards_trono(self):
        """Regicidio base: scarta un Trono."""
        state = make_state()
        place_building(enemy(state), "trono", "trono_r1")
        result = apply_effect(
            "regicidio_effect", state, me(state),
            prodigy=False,
            target_player_id=enemy(state).id,
        )
        assert "trono_r1" in state.discard_pile
        assert not any(b.instance_id == "trono_r1" for b in enemy(state).field.village.buildings)

    def test_regicidio_prodigy_also_discards_warrior(self):
        """Regicidio prodigio: scarta anche il Guerriero a cui era assegnato il Trono."""
        state = make_state()
        w = place_warrior(enemy(state), "orfeo", "orfeo_r1")
        trono = place_building(enemy(state), "trono", "trono_r2")
        w.assigned_cards.append("trono_r2")
        result = apply_effect(
            "regicidio_effect", state, me(state),
            prodigy=True,
            target_player_id=enemy(state).id,
            target_trono_iid="trono_r2"
        )
        assert "trono_r2" in state.discard_pile
        assert result.get("warrior_discarded") == "orfeo_r1"

    # --- Agilpesca ---

    def test_agilpesca_base_draw_and_action(self):
        """Agilpesca base: pesca 1 carta e ottieni 1 Azione aggiuntiva."""
        state = make_state()
        hand_before = len(me(state).hand)
        actions_before = me(state).actions_remaining
        result = apply_effect("agilpesca_effect", state, me(state), prodigy=False)
        assert len(me(state).hand) == hand_before + 1
        assert me(state).actions_remaining == actions_before + 1

    def test_agilpesca_prodigy_draws_extra_and_discards(self):
        """Agilpesca prodigio: pesca 2 carte extra e scarta 1."""
        state = make_state()
        hand_before = len(me(state).hand)
        # Metti una carta in mano da scartare
        give_card(me(state), "giulio_1")
        result = apply_effect(
            "agilpesca_effect", state, me(state),
            prodigy=True, discard_iid="giulio_1"
        )
        # Pesca base: +1, pesca prodigio: +1, scarto: -1 → netto +1
        assert result.get("extra_action") == 1
        assert "giulio_1" in state.discard_pile

    # --- Guerremoto ---

    def test_guerremoto_base_any_target(self):
        """Guerremoto base: Battaglia contro qualsiasi Bastione questo turno."""
        state = make_state()
        result = apply_effect("guerremoto_effect", state, me(state), prodigy=False)
        assert result["any_target"] is True
        assert result["damage_bonus"] == 0
        assert any(e.get("type") == "guerremoto" for e in me(state).active_effects)

    def test_guerremoto_prodigy_plus_2_damage(self):
        """Guerremoto prodigio: +2 Danni al risultato della Battaglia."""
        state = make_state()
        result = apply_effect("guerremoto_effect", state, me(state), prodigy=True)
        assert result["damage_bonus"] == 2

    # --- Arrampicarta ---

    def test_arrampicarta_base_wall_to_warrior_git(self):
        """Arrampicarta base: assegna un Muro a un Guerriero, +1 GIT."""
        state = make_state()
        w = place_warrior(me(state), "patrizio", "patrizio_ar1")
        wall = WallInstance(instance_id="wall_ar1", base_card_id="giulio")
        me(state).field.bastion_left.walls.append(wall)
        git_before = w.effective_git()
        result = apply_effect(
            "arrampicarta_effect", state, me(state),
            prodigy=False,
            wall_instance_id="wall_ar1",
            warrior_iid="patrizio_ar1",
            bastion_side="left",
        )
        assert "wall_ar1" in w.assigned_cards
        assert w.effective_git() == git_before + 1

    def test_arrampicarta_prodigy_removes_enemy_assigned_wall(self):
        """Arrampicarta prodigio: rimuove un Muro assegnato a ogni Guerriero avversario."""
        state = make_state()
        w = place_warrior(me(state), "patrizio", "patrizio_ar2")
        wall_me = WallInstance(instance_id="wall_ar2", base_card_id="giulio")
        me(state).field.bastion_right.walls.append(wall_me)
        # Avversario con Muro assegnato a un Guerriero
        enemy_w = place_warrior(enemy(state), "orfeo", "orfeo_ar1")
        enemy_w.assigned_cards.append("wall_enemy_assigned")
        result = apply_effect(
            "arrampicarta_effect", state, me(state),
            prodigy=True,
            wall_instance_id="wall_ar2",
            warrior_iid="patrizio_ar2",
            bastion_side="right",
        )
        assert result.get("enemy_assigned_removed") is not None
        assert len(enemy_w.assigned_cards) == 0

    # --- Investimento ---

    def test_investimento_base_gains_2_mana(self):
        """Investimento base: ottieni 2 Mana."""
        state = make_state()
        mana_before = me(state).mana_remaining
        result = apply_effect("investimento_effect", state, me(state), prodigy=False)
        assert me(state).mana_remaining == mana_before + 2

    def test_investimento_prodigy_deferred_mana(self):
        """Investimento prodigio: +2 Mana il prossimo turno."""
        state = make_state()
        result = apply_effect("investimento_effect", state, me(state), prodigy=True)
        assert result.get("deferred_mana") == 2
        assert any(
            e.get("type") == "investimento_deferred" and e.get("mana") == 2
            for e in me(state).active_effects
        )

    # --- Cuordipietra ---

    def test_cuordipietra_base_moves_recruit_to_enemy_bastion(self):
        """Cuordipietra base: sposta una Recluta avversaria a un suo Bastione."""
        state = make_state()
        w = place_warrior(enemy(state), "patrizio", "patrizio_cp1", region="vanguard")
        result = apply_effect(
            "cuordipietra_effect", state, me(state),
            prodigy=False,
            target_player_id=enemy(state).id,
            target_warrior_iid="patrizio_cp1",
            dest_bastion_side="left",
        )
        # Il guerriero non è più in Avanscoperta
        assert not any(w.instance_id == "patrizio_cp1" for w in enemy(state).field.vanguard)
        # È nel Bastione sinistro dell'avversario
        assert any(w.instance_id == "patrizio_cp1" for w in enemy(state).field.bastion_left.warriors)

    def test_cuordipietra_prodigy_moves_any_warrior_to_own_bastion(self):
        """Cuordipietra prodigio: sposta qualsiasi Guerriero avversario a un mio Bastione."""
        state = make_state()
        w = place_warrior(enemy(state), "orfeus", "orfeus_cp1", region="vanguard")
        result = apply_effect(
            "cuordipietra_effect", state, me(state),
            prodigy=True,
            target_player_id=enemy(state).id,
            target_warrior_iid="orfeus_cp1",
            dest_bastion_side="right",
        )
        # Il guerriero è nel mio bastione
        assert any(w.instance_id == "orfeus_cp1" for w in me(state).field.bastion_right.warriors)

    def test_cuordipietra_base_blocks_hero(self):
        """Cuordipietra base: non può spostare un Eroe."""
        state = make_state()
        place_warrior(enemy(state), "orfeus", "orfeus_cp2", region="vanguard")
        result = apply_effect(
            "cuordipietra_effect", state, me(state),
            prodigy=False,
            target_player_id=enemy(state).id,
            target_warrior_iid="orfeus_cp2",
        )
        assert "error" in result

    # --- Bastioncontrario ---

    def test_bastioncontrario_base_swaps_own_bastions(self):
        """Bastioncontrario base: scambia i due Bastioni dello stesso giocatore."""
        state = make_state()
        add_walls_to_bastion(enemy(state), "left", 2)
        add_walls_to_bastion(enemy(state), "right", 0)
        left_walls_before = len(enemy(state).field.bastion_left.walls)
        right_walls_before = len(enemy(state).field.bastion_right.walls)
        result = apply_effect(
            "bastioncontrario_effect", state, me(state),
            prodigy=False, player1_id=enemy(state).id
        )
        assert len(enemy(state).field.bastion_left.walls) == right_walls_before
        assert len(enemy(state).field.bastion_right.walls) == left_walls_before

    def test_bastioncontrario_prodigy_swaps_any_bastions(self):
        """Bastioncontrario prodigio: scambia due Bastioni di giocatori diversi."""
        state = make_state()
        add_walls_to_bastion(me(state), "right", 3)
        add_walls_to_bastion(enemy(state), "left", 1)
        result = apply_effect(
            "bastioncontrario_effect", state, me(state),
            prodigy=True,
            player1_id=me(state).id, side1="right",
            player2_id=enemy(state).id, side2="left",
        )
        assert len(me(state).field.bastion_right.walls) == 1
        assert len(enemy(state).field.bastion_left.walls) == 3

    # --- Divinazione ---

    def test_divinazione_base_deferred_incantesimo_mana(self):
        """Divinazione base: effetto differito per Maghe di Incantesimo."""
        state = make_state()
        result = apply_effect("divinazione_effect", state, me(state), prodigy=False)
        assert any(
            e.get("type") == "divinazione_incantesimo"
            for e in me(state).active_effects
        )

    def test_divinazione_prodigy_deferred_all_mage(self):
        """Divinazione prodigio: effetto differito per tutte le Maghe."""
        state = make_state()
        result = apply_effect("divinazione_effect", state, me(state), prodigy=True)
        assert any(
            e.get("type") == "divinazione_all_mage"
            for e in me(state).active_effects
        )

    # --- Malcomune ---

    def test_malcomune_base_discards_own_and_enemy_same_species(self):
        """Malcomune base: scarta un tuo Guerriero e uno avversario della stessa specie."""
        state = make_state()
        w_me = place_warrior(me(state), "patrizio", "patrizio_mc1")
        w_enemy = place_warrior(enemy(state), "giulio", "giulio_mc1")  # entrambi elfi
        result = apply_effect(
            "malcomune_effect", state, me(state),
            prodigy=False, own_warrior_iid="patrizio_mc1"
        )
        assert "patrizio_mc1" in state.discard_pile
        assert result.get("own_discarded") == "patrizio_mc1"
        assert len(result.get("enemies_discarded", [])) == 1

    def test_malcomune_prodigy_keeps_own_warrior(self):
        """Malcomune prodigio: il tuo Guerriero non viene scartato."""
        state = make_state()
        w_me = place_warrior(me(state), "patrizio", "patrizio_mc2")
        w_enemy = place_warrior(enemy(state), "giulio", "giulio_mc2")
        result = apply_effect(
            "malcomune_effect", state, me(state),
            prodigy=True, own_warrior_iid="patrizio_mc2"
        )
        assert "own_discarded" not in result
        assert any(w.instance_id == "patrizio_mc2" for w in me(state).field.vanguard)

    # --- Telecinesi ---

    def test_telecinesi_base_moves_walls_between_own_bastions(self):
        """Telecinesi base: sposta fino a 3 Muri da un tuo Bastione all'altro."""
        state = make_state()
        add_walls_to_bastion(me(state), "left", 3)
        result = apply_effect(
            "telecinesi_effect", state, me(state),
            prodigy=False, source_side="left", dest_side="right", count=3
        )
        assert len(result["moved_walls"]) == 3
        assert len(me(state).field.bastion_left.walls) == 0
        assert len(me(state).field.bastion_right.walls) == 3

    def test_telecinesi_prodigy_moves_from_any_bastion(self):
        """Telecinesi prodigio: sposta da qualsiasi Bastione a uno adiacente."""
        state = make_state()
        add_walls_to_bastion(enemy(state), "right", 2)
        result = apply_effect(
            "telecinesi_effect", state, me(state),
            prodigy=True,
            source_player_id=enemy(state).id, source_side="right",
            dest_player_id=me(state).id, dest_side="left",
            count=2
        )
        assert len(result["moved_walls"]) == 2
        assert len(me(state).field.bastion_left.walls) == 2

    # --- Cercapersone ---

    def test_cercapersone_base_pending_search(self):
        """Cercapersone base: imposta ricerca di una Recluta nel mazzo."""
        state = make_state()
        result = apply_effect("cercapersone_effect", state, me(state), prodigy=False)
        assert result["search_pending"] is True
        assert state.pending_search["context"] == "cercapersone_base"
        assert state.pending_search["condition"]["value"] == "recruit"

    def test_cercapersone_prodigy_pending_search_play(self):
        """Cercapersone prodigio: cerca e gioca la Recluta immediatamente."""
        state = make_state()
        result = apply_effect("cercapersone_effect", state, me(state), prodigy=True)
        assert result["search_pending"] is True
        assert state.pending_search["context"] == "cercapersone_prodigio"

    # --- Incendifesa ---

    def test_incendifesa_base_damage_equals_warriors_in_bastion(self):
        """Incendifesa base: Danni pari al numero di Guerrieri nel Bastione."""
        state = make_state()
        place_warrior(enemy(state), "patrizio", "patrizio_inc1", region="bastion_left")
        place_warrior(enemy(state), "reinhold", "reinhold_inc1", region="bastion_left")
        add_walls_to_bastion(enemy(state), "left", 5)
        result = apply_effect(
            "incendifesa_effect", state, me(state),
            prodigy=False,
            target_player_id=enemy(state).id,
            target_bastion_side="left",
        )
        assert result["damage"] == 2
        assert len(enemy(state).field.bastion_left.walls) == 3

    def test_incendifesa_prodigy_damage_all_bastions(self):
        """Incendifesa prodigio: Danni pari al totale dei Guerrieri in tutti i Bastioni."""
        state = make_state()
        place_warrior(enemy(state), "patrizio", "patrizio_inc2", region="bastion_left")
        place_warrior(enemy(state), "reinhold", "reinhold_inc2", region="bastion_right")
        add_walls_to_bastion(enemy(state), "left", 5)
        result = apply_effect(
            "incendifesa_effect", state, me(state),
            prodigy=True,
            target_player_id=enemy(state).id,
            target_bastion_side="left",
        )
        assert result["damage"] == 2  # 1+1=2 guerrieri totali nei bastioni

    # --- Dazipazzi ---

    def test_dazipazzi_base_resets_enemy_scrigni(self):
        """Dazipazzi base: riporta allo stato incompleto tutti gli Scrigni avversari."""
        state = make_state()
        place_building(enemy(state), "scrigno", "scrigno_dz1", completed=True)
        result = apply_effect("dazipazzi_effect", state, me(state), prodigy=False)
        affected = result["reset_buildings"]
        assert len(affected) == 1
        scrigno_inst = next(b for b in enemy(state).field.village.buildings if b.instance_id == "scrigno_dz1")
        assert not scrigno_inst.completed

    def test_dazipazzi_prodigy_also_resets_estrattori(self):
        """Dazipazzi prodigio: reimposta anche gli Estrattori."""
        state = make_state()
        place_building(enemy(state), "scrigno", "scrigno_dz2", completed=True)
        place_building(enemy(state), "estrattore", "estrattore_dz1", completed=True)
        result = apply_effect("dazipazzi_effect", state, me(state), prodigy=True)
        affected_types = {r["type"] for r in result["reset_buildings"]}
        assert "scrigno" in affected_types
        assert "estrattore" in affected_types

    # --- Plasmattone ---

    def test_plasmattone_base_takes_random_wall(self):
        """Plasmattone base: prende un Muro casuale dal Bastione alla mano."""
        state = make_state()
        add_walls_to_bastion(me(state), "left", 2)
        hand_before = len(me(state).hand)
        walls_before = len(me(state).field.bastion_left.walls)
        result = apply_effect(
            "plasmattone_effect", state, me(state),
            prodigy=False, bastion_side="left"
        )
        assert len(me(state).hand) == hand_before + 1
        assert len(me(state).field.bastion_left.walls) == walls_before - 1

    def test_plasmattone_prodigy_takes_specific_wall(self):
        """Plasmattone prodigio: sceglie quale Muro prendere."""
        state = make_state()
        add_walls_to_bastion(me(state), "right", 2)
        wall_id = me(state).field.bastion_right.walls[0].instance_id
        result = apply_effect(
            "plasmattone_effect", state, me(state),
            prodigy=True, bastion_side="right",
            wall_instance_id=wall_id,
        )
        assert result["wall_taken"] == wall_id
        assert wall_id in me(state).hand

    # --- Cambiamente ---

    def test_cambiamente_base_discards_enemy_warrior(self):
        """Cambiamente base: scarta un Guerriero avversario."""
        state = make_state()
        place_warrior(enemy(state), "orfeo", "orfeo_cam1")
        result = apply_effect(
            "cambiamente_effect", state, me(state),
            prodigy=False,
            target_player_id=enemy(state).id,
            target_warrior_iid="orfeo_cam1",
        )
        assert result.get("warrior_discarded") == "orfeo_cam1"
        assert "orfeo_cam1" in state.discard_pile

    def test_cambiamente_prodigy_takes_enemy_warrior_to_hand(self):
        """Cambiamente prodigio: prende un Guerriero avversario nella propria mano."""
        state = make_state()
        place_warrior(enemy(state), "orfeo", "orfeo_cam2")
        result = apply_effect(
            "cambiamente_effect", state, me(state),
            prodigy=True,
            target_player_id=enemy(state).id,
            target_warrior_iid="orfeo_cam2",
        )
        assert result.get("warrior_taken") == "orfeo_cam2"
        assert "orfeo_cam2" in me(state).hand

    # --- Velocemento ---

    def test_velocemento_base_plays_building_free(self):
        """Velocemento base: gioca una Costruzione dalla mano senza costo."""
        state = make_state()
        give_card(me(state), "ariete_1")
        result = apply_effect(
            "velocemento_effect", state, me(state),
            prodigy=False, building_instance_id="ariete_1"
        )
        assert result["building_played"] == "ariete_1"
        assert not result.get("completed")
        assert any(b.instance_id == "ariete_1" for b in me(state).field.village.buildings)

    def test_velocemento_prodigy_plays_and_completes_building(self):
        """Velocemento prodigio: gioca e completa una Costruzione dalla mano."""
        state = make_state()
        give_card(me(state), "saracinesca_1")
        result = apply_effect(
            "velocemento_effect", state, me(state),
            prodigy=True, building_instance_id="saracinesca_1"
        )
        assert result["building_played"] == "saracinesca_1"
        assert result.get("completed") is True
        b = next(b for b in me(state).field.village.buildings if b.instance_id == "saracinesca_1")
        assert b.completed

    # --- Plasmarmo ---

    def test_plasmarmo_base_takes_wall_to_hand(self):
        """Plasmarmo base: prende un Muro dal Bastione alla mano."""
        state = make_state()
        add_walls_to_bastion(me(state), "left", 1)
        wall_id = me(state).field.bastion_left.walls[0].instance_id
        result = apply_effect(
            "plasmarmo_effect", state, me(state),
            prodigy=False, bastion_side="left", wall_instance_id=wall_id
        )
        assert wall_id in me(state).hand
        assert len(me(state).field.bastion_left.walls) == 0

    def test_plasmarmo_prodigy_plays_warrior_wall(self):
        """Plasmarmo prodigio: gioca immediatamente la carta recuperata."""
        state = make_state()
        wall = WallInstance(instance_id="patrizio_2", base_card_id="patrizio")
        me(state).field.bastion_right.walls.append(wall)
        result = apply_effect(
            "plasmarmo_effect", state, me(state),
            prodigy=True, bastion_side="right", wall_instance_id="patrizio_2"
        )
        assert result["wall_taken"] == "patrizio_2"
        # Il guerriero dovrebbe essere in campo o in mano
        played_as = result.get("played_as")
        assert played_as is not None


# ---------------------------------------------------------------------------
# COSTRUZIONI — Effetti Base e Completo
# ---------------------------------------------------------------------------

class TestBuildingEffects:

    # --- Estrattore ---

    def test_estrattore_base_rolls_d10(self):
        """Estrattore base: lancia un D10, se ≥6 ottieni +1 Mana."""
        state = make_state()
        import unittest.mock as mock
        # Forza il dado a dare 8
        with mock.patch("engine.effects._roll_d10", return_value=8):
            mana_before = me(state).mana_remaining
            result = apply_effect("estrattore_effect", state, me(state), completed=False)
            assert result["roll"] == 8
            assert me(state).mana_remaining == mana_before + 1

    def test_estrattore_base_no_mana_on_low_roll(self):
        """Estrattore base: se il dado < 6, nessun mana."""
        state = make_state()
        import unittest.mock as mock
        with mock.patch("engine.effects._roll_d10", return_value=3):
            mana_before = me(state).mana_remaining
            result = apply_effect("estrattore_effect", state, me(state), completed=False)
            assert result["mana_gained"] == 0
            assert me(state).mana_remaining == mana_before

    def test_estrattore_complete_always_gains_mana(self):
        """Estrattore completo: ottieni sempre +1 Mana."""
        state = make_state()
        mana_before = me(state).mana_remaining
        result = apply_effect("estrattore_effect", state, me(state), completed=True)
        assert me(state).mana_remaining == mana_before + 1

    # --- Granaio ---

    def test_granaio_base_rolls_d10_draws_on_high(self):
        """Granaio base: se D10 ≥6 pesca fino a 7 carte."""
        state = make_state()
        import unittest.mock as mock
        me(state).hand = me(state).hand[:4]  # 4 carte in mano
        with mock.patch("engine.effects._roll_d10", return_value=7):
            result = apply_effect("granaio_effect", state, me(state), completed=False)
            assert result["roll"] == 7
            assert len(me(state).hand) == 7

    def test_granaio_base_no_draw_on_low_roll(self):
        """Granaio base: se D10 < 6, non pesca."""
        state = make_state()
        import unittest.mock as mock
        me(state).hand = me(state).hand[:4]
        with mock.patch("engine.effects._roll_d10", return_value=5):
            result = apply_effect("granaio_effect", state, me(state), completed=False)
            assert len(result.get("cards_drawn", [])) == 0

    def test_granaio_complete_always_draws_to_7(self):
        """Granaio completo: pesca sempre fino a 7 carte."""
        state = make_state()
        me(state).hand = me(state).hand[:3]  # 3 carte in mano
        result = apply_effect("granaio_effect", state, me(state), completed=True)
        assert len(me(state).hand) == 7

    # --- Fucina ---

    def test_fucina_base_adds_passive_effect(self):
        """Fucina base: aggiunge un effetto passivo (possibile 3a azione con D10≥6)."""
        state = make_state()
        result = apply_effect("fucina_effect", state, me(state), completed=False)
        assert result.get("passive") is True
        assert any(e.get("type") == "fucina" for e in me(state).active_effects)

    def test_fucina_complete_adds_passive_extra_action(self):
        """Fucina completa: garantisce sempre la 3a azione."""
        state = make_state()
        result = apply_effect("fucina_effect", state, me(state), completed=True)
        assert any(
            e.get("type") == "fucina" and e.get("completed") is True
            for e in me(state).active_effects
        )

    # --- Biblioteca ---

    def test_biblioteca_base_draws_and_discards(self):
        """Biblioteca base: pesca 1 carta, poi scarta 1."""
        state = make_state()
        give_card(me(state), "giulio_1")
        hand_before = len(me(state).hand)
        result = apply_effect(
            "biblioteca_effect", state, me(state),
            completed=False, discard_iid="giulio_1"
        )
        assert "giulio_1" in state.discard_pile
        # +1 pescata -1 scartata = netto 0
        assert len(me(state).hand) == hand_before

    def test_biblioteca_complete_draws_and_adds_to_bastion(self):
        """Biblioteca completa: pesca 1 carta, poi aggiunge 1 carta a un Bastione."""
        state = make_state()
        give_card(me(state), "reinhold_1")
        hand_before = len(me(state).hand)
        result = apply_effect(
            "biblioteca_effect", state, me(state),
            completed=True,
            wall_card_iid="reinhold_1",
            wall_bastion_side="left",
        )
        assert "reinhold_1" not in me(state).hand
        assert any(w.instance_id == "reinhold_1" for w in me(state).field.bastion_left.walls)

    # --- Ariete (passivo in battaglia) ---

    def test_ariete_base_gives_plus1_att_in_battle(self):
        """Ariete base: +1 ATT quando attacchi."""
        from engine.battle import attacker_stats
        state = make_state()
        w = place_warrior(me(state), "patrizio", "patrizio_ariete")
        place_building(me(state), "ariete", "ariete_b1", completed=False)
        att, git = attacker_stats(me(state))
        # patrizio ATT=2, ariete base +1 → ATT=3
        assert att == 3  # patrizio base ATT=2 + 1 ariete

    def test_ariete_complete_gives_plus2_att_in_battle(self):
        """Ariete completo: +2 ATT quando attacchi."""
        from engine.battle import attacker_stats
        state = make_state()
        place_warrior(me(state), "patrizio", "patrizio_ariete2")
        place_building(me(state), "ariete", "ariete_b2", completed=True)
        att, git = attacker_stats(me(state))
        # patrizio ATT=2, ariete complete +2 → ATT=4
        assert att == 4

    # --- Catapulta (passivo in battaglia) ---

    def test_catapulta_base_gives_plus1_git(self):
        """Catapulta base: +1 GIT quando attacchi o difendi."""
        from engine.battle import attacker_stats, defender_stats
        state = make_state()
        place_warrior(me(state), "giulio", "giulio_cat")  # GIT=2
        place_building(me(state), "catapulta", "cat_b1", completed=False)
        _, git = attacker_stats(me(state))
        assert git == 3  # giulio GIT=2 + 1 catapulta

    def test_catapulta_complete_gives_plus2_git(self):
        """Catapulta completa: +2 GIT quando attacchi o difendi."""
        from engine.battle import attacker_stats
        state = make_state()
        place_warrior(me(state), "giulio", "giulio_cat2")  # GIT=2
        place_building(me(state), "catapulta", "cat_b2", completed=True)
        _, git = attacker_stats(me(state))
        assert git == 4

    # --- Saracinesca (passivo in difesa) ---

    def test_saracinesca_base_gives_plus1_dif(self):
        """Saracinesca base: +1 DIF quando difendi."""
        from engine.battle import defender_stats
        state = make_state()
        place_warrior(me(state), "reinhold", "reinhold_sar", region="bastion_left")  # DIF=3
        place_building(me(state), "saracinesca", "sar_b1", completed=False)
        dif, git = defender_stats(me(state), "left")
        assert dif == 4  # reinhold DIF=3 + 1 saracinesca

    def test_saracinesca_complete_gives_plus2_dif(self):
        """Saracinesca completa: +2 DIF quando difendi."""
        from engine.battle import defender_stats
        state = make_state()
        place_warrior(me(state), "reinhold", "reinhold_sar2", region="bastion_left")  # DIF=3
        place_building(me(state), "saracinesca", "sar_b2", completed=True)
        dif, git = defender_stats(me(state), "left")
        assert dif == 5

    # --- Sorgiva ---

    def test_sorgiva_no_effect_base(self):
        """Sorgiva base: nessun effetto."""
        state = make_state()
        result = apply_effect("sorgiva_effect", state, me(state), completed=False)
        assert result == {}

    def test_sorgiva_complete_usable_by_vitalflusso(self):
        """Sorgiva completa: usabile da Vitalflusso per aggiungere alle Vite."""
        state = make_state()
        sorgiva = place_building(me(state), "sorgiva", "sorgiva_test", completed=True)
        lives_before = me(state).lives
        result = apply_effect("vitalflusso_effect", state, me(state), prodigy=False)
        assert result.get("lives_gained") == 1
        assert me(state).lives == lives_before + 1

    # --- Arena ---

    def test_arena_base_discards_warrior_with_lower_stat(self):
        """Arena base: scarta il tuo Guerriero e uno avversario con almeno una stat inferiore."""
        state = make_state()
        w_me = place_warrior(me(state), "orfeus", "orfeus_1")  # ATT=6, GIT=1, DIF=4
        w_enemy = place_warrior(enemy(state), "patrizio", "patrizio_1")  # ATT=2 < 6
        result = apply_effect(
            "arena_effect", state, me(state),
            completed=False,
            own_warrior_iid="orfeus_1",
            target_warrior_iid="patrizio_1",
            target_player_id=enemy(state).id,
        )
        assert result.get("own_discarded") == "orfeus_1"
        assert result.get("target_discarded") == "patrizio_1"

    def test_arena_complete_also_discards_recruit_of_hero(self):
        """Arena completa: se il bersaglio era un Eroe, scarta anche la Recluta e le carte assegnate."""
        state = make_state()
        w_me = place_warrior(me(state), "orfeus", "orfeus_ar2")
        # Eroe avversario con recluta
        hero_e = WarriorInstance(
            instance_id="san_patrizio_ar1",
            base_card_id="san_patrizio",
            evolved_from="patrizio_ar_r1",
            assigned_cards=["giulio_ar1"],
        )
        enemy(state).field.vanguard.append(hero_e)
        result = apply_effect(
            "arena_effect", state, me(state),
            completed=True,
            own_warrior_iid="orfeus_ar2",
            target_warrior_iid="san_patrizio_ar1",
            target_player_id=enemy(state).id,
        )
        assert result.get("recruit_discarded") == "patrizio_ar_r1"
        assert "giulio_ar1" in result.get("also_discarded", [])

    # --- Fossato ---

    def test_fossato_base_blocks_zero_git_attack(self):
        """Fossato base: blocca attacchi con GIT < 1."""
        from engine.battle import _fossato_blocks
        state = make_state()
        place_building(enemy(state), "fossato", "fossato_b1", completed=False)
        # GIT=0: bloccato
        assert _fossato_blocks(enemy(state), "left", 0) is True
        # GIT=1: non bloccato
        assert _fossato_blocks(enemy(state), "left", 1) is False

    def test_fossato_complete_blocks_sub3_git(self):
        """Fossato completo: blocca attacchi con GIT < 3."""
        from engine.battle import _fossato_blocks
        state = make_state()
        place_building(enemy(state), "fossato", "fossato_b2", completed=True)
        assert _fossato_blocks(enemy(state), "left", 2) is True
        assert _fossato_blocks(enemy(state), "left", 3) is False

    # --- Scrigno ---

    def test_scrigno_base_bonus_1_on_mana_gain(self):
        """Scrigno base: quando una carta dà mana, ottieni +1 mana extra."""
        from engine.effects import _apply_scrigno_bonus
        state = make_state()
        place_building(me(state), "scrigno", "scrigno_s1", completed=False)
        mana_before = me(state).mana_remaining
        bonus = _apply_scrigno_bonus(me(state), 2)
        assert bonus == 1
        assert me(state).mana_remaining == mana_before + 1

    def test_scrigno_complete_doubles_mana_bonus(self):
        """Scrigno completo: raddoppia il bonus (ottieni altrettanto in più)."""
        from engine.effects import _apply_scrigno_bonus
        state = make_state()
        place_building(me(state), "scrigno", "scrigno_s2", completed=True)
        mana_before = me(state).mana_remaining
        bonus = _apply_scrigno_bonus(me(state), 3)
        assert bonus == 3
        assert me(state).mana_remaining == mana_before + 3

    # --- Obelisco ---

    def test_obelisco_base_returns_spell_on_high_roll(self):
        """Obelisco base: se D10 ≥8, la Magia torna in mano."""
        import unittest.mock as mock
        state = make_state()
        place_building(me(state), "obelisco", "obelisco_b1", completed=False)
        give_card(me(state), "ardolancio_1")
        add_walls_to_bastion(enemy(state), "left", 5)
        place_warrior(me(state), "araminta", "araminta_ob")
        with mock.patch("engine.actions._random.randint", return_value=9):
            result = play_spell(
                state, me(state).id, "ardolancio_1",
                target_player_id=enemy(state).id,
                target_bastion_side="left",
            )
        assert result["effect"].get("returned_to_hand") is True
        assert "ardolancio_1" in me(state).hand

    def test_obelisco_base_no_return_on_low_roll(self):
        """Obelisco base: se D10 < 8, la Magia non torna in mano."""
        import unittest.mock as mock
        state = make_state()
        place_building(me(state), "obelisco", "obelisco_b2", completed=False)
        give_card(me(state), "ardolancio_2")
        add_walls_to_bastion(enemy(state), "left", 5)
        place_warrior(me(state), "araminta", "araminta_ob2")
        with mock.patch("engine.actions._random.randint", return_value=5):
            result = play_spell(
                state, me(state).id, "ardolancio_2",
                target_player_id=enemy(state).id,
                target_bastion_side="left",
            )
        assert not result["effect"].get("returned_to_hand")

    def test_obelisco_complete_returns_on_6(self):
        """Obelisco completo: soglia abbassata a 6."""
        import unittest.mock as mock
        state = make_state()
        place_building(me(state), "obelisco", "obelisco_b3", completed=True)
        give_card(me(state), "ardolancio_3")
        add_walls_to_bastion(enemy(state), "left", 5)
        place_warrior(me(state), "araminta", "araminta_ob3")
        with mock.patch("engine.actions._random.randint", return_value=6):
            result = play_spell(
                state, me(state).id, "ardolancio_3",
                target_player_id=enemy(state).id,
                target_bastion_side="left",
            )
        assert result["effect"].get("returned_to_hand") is True

    # --- Cardo & Decumano ---

    def test_cardo_complete_adds_cardo_move_effect(self):
        """Cardo completo (con Decumano): aggiunge effetto per spostare un Guerriero a fine turno."""
        state = make_state()
        place_building(me(state), "decumano", "decumano_c1", completed=False)
        result = apply_effect("cardo_effect", state, me(state), completed=True)
        eff = next((e for e in me(state).active_effects if e.get("type") == "cardo_move"), None)
        assert eff is not None
        assert eff["has_decumano"] is True

    def test_decumano_base_with_cardo_adds_free_complete(self):
        """Decumano base (con Cardo): aggiunge effetto completamento gratuito di Cardo."""
        state = make_state()
        place_building(me(state), "cardo", "cardo_d1", completed=False)
        result = apply_effect("decumano_effect", state, me(state), completed=False)
        eff = next((e for e in me(state).active_effects if e.get("type") == "decumano_cardo_free"), None)
        assert eff is not None

    # --- Trono ---

    def test_trono_base_assigns_to_warrior(self):
        """Trono base: assegna a un Guerriero."""
        state = make_state()
        w = place_warrior(me(state), "joseph", "joseph_tr1")
        b = place_building(me(state), "trono", "trono_tr1")
        result = apply_effect(
            "trono_effect", state, me(state),
            completed=False,
            target_warrior_iid="joseph_tr1",
            building_instance_id="trono_tr1",
        )
        assert result["assigned_to"] == "joseph_tr1"
        assert "trono_tr1" in w.assigned_cards

    def test_trono_complete_horde_always_active(self):
        """Trono completo: l'effetto Orda del Guerriero assegnato è sempre attivo."""
        state = make_state()
        w = place_warrior(me(state), "joseph", "joseph_tr2")
        b = place_building(me(state), "trono", "trono_tr2")
        result = apply_effect(
            "trono_effect", state, me(state),
            completed=True,
            target_warrior_iid="joseph_tr2",
            building_instance_id="trono_tr2",
        )
        assert "horde_always_active" in result
        assert any(
            e.get("type") == "trono_horde_active" and e.get("warrior_iid") == "joseph_tr2"
            for e in me(state).active_effects
        )


# ---------------------------------------------------------------------------
# BATTAGLIA — Meccaniche Core
# ---------------------------------------------------------------------------

class TestBattle:

    def test_damage_calculation_basic(self):
        """Calcolo danni: ATT>DIF e GIT>GIT_dif."""
        from engine.battle import calculate_damage
        d_att, d_git, total = calculate_damage(5, 3, 2, 1)
        assert d_att == 3   # 5-2=3
        assert d_git == 2   # 3-1=2
        assert total == 5

    def test_damage_calculation_no_penetration(self):
        """Calcolo danni: ATT ≤ DIF e GIT ≤ GIT_dif → 0 danni."""
        from engine.battle import calculate_damage
        d_att, d_git, total = calculate_damage(2, 1, 5, 3)
        assert d_att == 0
        assert d_git == 0
        assert total == 0

    def test_apply_damage_removes_walls(self):
        """apply_damage_to_bastion: rimuove Muri pari ai danni."""
        state = make_state()
        add_walls_to_bastion(enemy(state), "left", 3)
        result = apply_damage_to_bastion(state, enemy(state), "left", 2)
        assert result["walls_destroyed"] == 2
        assert result["life_lost"] == 0
        assert len(enemy(state).field.bastion_left.walls) == 1

    def test_apply_damage_removes_life_when_no_walls(self):
        """apply_damage_to_bastion: se i Muri non bastano, il difensore perde 1 Vita."""
        state = make_state()
        add_walls_to_bastion(enemy(state), "left", 1)
        lives_before = enemy(state).lives
        result = apply_damage_to_bastion(state, enemy(state), "left", 3)
        assert result["walls_destroyed"] == 1
        assert result["life_lost"] == 1
        assert enemy(state).lives == lives_before - 1

    def test_guerremoto_allows_any_target(self):
        """Guerremoto: con l'effetto attivo, può attaccare qualsiasi Bastione."""
        from engine.battle import get_valid_attack_targets
        state = make_state()  # current_player_index = 0 garantito
        place_warrior(me(state), "orfeo", "orfeo_gm1")
        me(state).active_effects.append({"type": "guerremoto", "any_target": True, "damage_bonus": 0})
        targets = get_valid_attack_targets(state)
        # Con 2 giocatori e Guerremoto, tutti i bastioni avversari sono bersagli validi
        assert len(targets) >= 2


# ---------------------------------------------------------------------------
# EFFETTO ARAMINTA ORDA — spell_return in play_spell
# ---------------------------------------------------------------------------

class TestOrdaInPlaySpell:

    def test_araminta_horde_anatema_1_returns_to_hand(self):
        """Con Araminta Orda attiva, un Anatema cost-1 torna in mano."""
        state = make_state()
        place_warrior(me(state), "araminta", "araminta_ps1")
        give_card(me(state), "ardolancio_1")
        add_walls_to_bastion(enemy(state), "left", 5)
        # Attiva l'Orda di Araminta
        apply_effect("araminta_horde", state, me(state))
        result = play_spell(
            state, me(state).id, "ardolancio_1",
            target_player_id=enemy(state).id,
            target_bastion_side="left",
        )
        assert result["effect"].get("returned_to_hand") is True
        assert "ardolancio_1" in me(state).hand

    def test_evelyn_horde_sortilegio_1_needs_recast(self):
        """Con Evelyn Orda attiva, un Sortilegio cost-1 viene segnalato per il recast."""
        state = make_state()
        place_warrior(me(state), "evelyn", "evelyn_ps1")
        give_card(me(state), "vitalflusso_1")
        place_building(me(state), "sorgiva", "sorgiva_ev1", completed=True)
        apply_effect("evelyn_horde", state, me(state))
        result = play_spell(state, me(state).id, "vitalflusso_1")
        assert result["effect"].get("needs_recast") is True


# ---------------------------------------------------------------------------
# EFFETTI SCRIGNO — bonus mana durante Estrattore e Investimento
# ---------------------------------------------------------------------------

class TestScrignoBonus:

    def test_scrigno_bonus_during_estrattore(self):
        """Scrigno base: l'Estrattore che dà +1 mana attiva il bonus Scrigno."""
        state = make_state()
        import unittest.mock as mock
        place_building(me(state), "scrigno", "scrigno_ext1", completed=False)
        with mock.patch("engine.effects._roll_d10", return_value=9):
            mana_before = me(state).mana_remaining
            result = apply_effect("estrattore_effect", state, me(state), completed=False)
            # +1 dall'estrattore, +1 dallo Scrigno
            assert me(state).mana_remaining == mana_before + 2

    def test_scrigno_complete_doubles_during_investimento(self):
        """Scrigno completo: Investimento dà 2 mana + 2 bonus → 4 totali."""
        state = make_state()
        place_building(me(state), "scrigno", "scrigno_inv1", completed=True)
        mana_before = me(state).mana_remaining
        result = apply_effect("investimento_effect", state, me(state), prodigy=False)
        # 2 da Investimento + 2 da Scrigno completo = 4
        assert me(state).mana_remaining == mana_before + 4


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
