"""
Motore di gioco principale di Barbacane.

Gestisce:
- Inizializzazione partita
- Flusso del turno (mana, azioni, riposizionamento, Orda, Battaglia, Pesca)
- Trigger di effetti a inizio/fine turno
- Condizione di vittoria
- Bot casuale per test
"""

from __future__ import annotations
import random
import uuid
from typing import Any, Dict, List, Optional

from engine.models import (
    GameState,
    Player,
    PlayerField,
    Bastion,
    Village,
    WarriorInstance,
    BuildingInstance,
)
from engine.cards import CARD_REGISTRY, get_card, WarriorCard, SpellCard, BuildingCard
from engine.deck import build_deck, draw_cards, get_base_card_id
from engine.effects import apply_effect
from engine.battle import resolve_battle, get_valid_attack_targets
from engine.actions import (
    ActionError,
    play_warrior,
    play_building,
    play_spell,
    complete_building,
    add_wall,
    reposition_warrior,
    activate_horde,
    evolve_warrior,
)
from engine.effects import _apply_scrigno_bonus


# ---------------------------------------------------------------------------
# Inizializzazione partita
# ---------------------------------------------------------------------------

def create_game(player_names: List[str], game_id: Optional[str] = None) -> GameState:
    """
    Crea e inizializza una nuova partita.
    - Mescola il mazzo
    - Distribuisce 5 carte a ogni giocatore
    - Sceglie casualmente il primo giocatore
    """
    if not 2 <= len(player_names) <= 4:
        raise ValueError("Barbacane richiede da 2 a 4 giocatori.")

    if game_id is None:
        game_id = str(uuid.uuid4())[:8]

    players = [
        Player(
            id=f"player_{i+1}",
            name=name,
            mana=0,
            mana_remaining=0,
            actions_remaining=2,
        )
        for i, name in enumerate(player_names)
    ]

    deck = build_deck()
    first_player = random.randint(0, len(players) - 1)

    state = GameState(
        game_id=game_id,
        turn=1,
        current_player_index=first_player,
        phase="action",
        players=players,
        deck=deck,
        battles_remaining=1,
    )

    # Distribuisce 3 carte-vita a ogni giocatore (pescate dal mazzo)
    for player in players:
        for _ in range(3):
            if state.deck:
                player.life_cards.append(state.deck.pop(0))

    # Distribuisce 6 carte in mano a ogni giocatore
    for player in players:
        draw_cards(state, player.id, 6)

    # Assegna il Mana iniziale al primo giocatore
    _begin_turn(state)

    return state


# ---------------------------------------------------------------------------
# Inizio/Fine turno
# ---------------------------------------------------------------------------

def _begin_turn(state: GameState) -> None:
    """
    Inizia il turno del giocatore corrente:
    1. Assegna Mana
    2. Attiva effetti di Costruzioni a inizio turno
    3. Reset azioni
    """
    player = state.current_player

    # Reset stato turno
    player.actions_remaining = 2
    player.hordes_activated_this_turn = []
    # Pulisce flag horde_active da turni precedenti
    for w in player.all_warriors():
        w.horde_active = False
    state.phase = "action"
    state.battle_done_this_turn = False
    state.battles_remaining = 1 + player.extra_battles
    player.extra_battles = 0

    # Rimuovi i bonus stat da effetti Orda del turno precedente
    _clear_horde_stat_effects(player)
    # Pulisce modificatori temporanei da effetti "end_of_turn" precedenti
    _clear_turn_expired_effects(player)

    # Assegna Mana
    mana = state.mana_for_turn(state.turn)
    if player.skip_mana_next_turn:
        mana = 0
        player.skip_mana_next_turn = False
        state.add_log(player.id, "skip_mana")
    player.mana_remaining = mana
    state.add_log(player.id, "receive_mana", amount=mana)

    # Effetti Costruzioni a inizio turno (estrattore, biblioteca, fucina completata)
    _trigger_building_start(state, player)

    # Effetti differiti dal turno precedente (investimento prodigio, divinazione)
    _process_deferred_effects(state, player)


def _trigger_building_start(state: GameState, player: Player) -> None:
    """Attiva gli effetti di Costruzione che si attivano a inizio turno."""
    for b_inst in player.field.village.buildings:
        base_id = b_inst.base_card_id
        card = get_card(base_id)
        if not isinstance(card, BuildingCard):
            continue
        if base_id in ("estrattore", "biblioteca", "sorgiva"):
            apply_effect(card.effect_id, state, player, completed=b_inst.completed, trigger="start")
        elif base_id == "fucina" and b_inst.completed:
            # Fucina completata: 3a Azione garantita ogni turno
            player.actions_remaining += 1


def _trigger_building_end(state: GameState, player: Player) -> None:
    """Attiva gli effetti di Costruzione che si attivano a fine turno."""
    for b_inst in player.field.village.buildings:
        base_id = b_inst.base_card_id
        card = get_card(base_id)
        if not isinstance(card, BuildingCard):
            continue
        if base_id in ("granaio",):
            apply_effect(card.effect_id, state, player, completed=b_inst.completed, trigger="end")


def _clear_horde_stat_effects(player: Player) -> None:
    """Rimuove i bonus stat applicati dall'effetto Orda del turno precedente."""
    to_remove = []
    for eff in player.active_effects:
        if eff.get("type") == "horde_stat_bonus":
            for w in player.all_warriors():
                if w.instance_id == eff.get("warrior_iid"):
                    for stat in ("att", "git", "dif"):
                        bonus = eff.get(stat, 0)
                        if bonus:
                            w.temp_modifiers[stat] = max(0, w.temp_modifiers.get(stat, 0) - bonus)
            to_remove.append(eff)
    for eff in to_remove:
        player.active_effects.remove(eff)


def _process_deferred_effects(state: GameState, player: Player) -> None:
    """Processa effetti con expires='start_of_next_own_turn' (Investimento prodigio, Divinazione)."""
    to_remove = []
    for eff in player.active_effects:
        if eff.get("expires") != "start_of_next_own_turn":
            continue
        etype = eff.get("type")
        if etype == "investimento_deferred":
            mana = eff.get("mana", 2)
            player.mana_remaining += mana
            _apply_scrigno_bonus(player, mana)
        elif etype == "divinazione_incantesimo":
            count = sum(
                1 for w in player.mages_in_field()
                if CARD_REGISTRY.get(w.base_card_id) and
                getattr(CARD_REGISTRY[w.base_card_id], "school", None) == "incantesimo"
            )
            if count > 0:
                player.mana_remaining += count
                _apply_scrigno_bonus(player, count)
        elif etype == "divinazione_all_mage":
            count = len(player.mages_in_field())
            if count > 0:
                player.mana_remaining += count
                _apply_scrigno_bonus(player, count)
        to_remove.append(eff)
    for eff in to_remove:
        player.active_effects.remove(eff)


def check_fucina_after_action(state: GameState, player: Player) -> Optional[dict]:
    """
    Controlla se la Fucina base deve concedere una 3a Azione (dopo la 2a usata).
    Deve essere chiamata dopo ogni azione che consuma un'azione.
    """
    if player.actions_remaining != 0:
        return None
    if any(e.get("type") == "fucina_base_triggered" for e in player.active_effects):
        return None
    has_base_fucina = any(
        b.base_card_id == "fucina" and not b.completed
        for b in player.field.village.buildings
    )
    if not has_base_fucina:
        return None
    roll = random.randint(1, 10)
    extra = roll >= 6
    player.active_effects.append({"type": "fucina_base_triggered", "expires": "end_of_turn"})
    if extra:
        player.actions_remaining += 1
    state.recent_events.append({
        "type": "d10", "card": "fucina",
        "player_id": player.id, "roll": roll, "extra_action": extra,
    })
    return {"fucina_roll": roll, "extra_action": extra}


def _clear_turn_expired_effects(player: Player) -> None:
    """Rimuove effetti temporanei scaduti a fine turno."""
    to_remove = []
    for eff in player.active_effects:
        if eff.get("expires") == "end_of_turn":
            # Rimuovi modificatori
            if eff.get("type") == "plasmarmo":
                for w in player.all_warriors():
                    if w.instance_id == eff.get("target"):
                        w.temp_modifiers["att"] = max(0, w.temp_modifiers.get("att", 0) - eff.get("att", 0))
                        w.temp_modifiers["dif"] = max(0, w.temp_modifiers.get("dif", 0) - eff.get("dif", 0))
                        w.temp_modifiers["git"] = max(0, w.temp_modifiers.get("git", 0) - eff.get("git", 0))
            elif eff.get("type") == "spell_discount":
                school = eff.get("school")
                if school in player.spell_cost_reductions:
                    player.spell_cost_reductions[school] = max(
                        0, player.spell_cost_reductions[school] - eff.get("discount", 1)
                    )
            to_remove.append(eff)
    for eff in to_remove:
        player.active_effects.remove(eff)

    # Reset battle ATT bonus "next_battle"
    for eff in player.active_effects:
        if eff.get("expires") == "next_battle":
            pass  # verranno rimossi dopo la battaglia


def end_turn(state: GameState) -> GameState:
    """
    Termina il turno del giocatore corrente e passa al successivo.
    """
    player = state.current_player

    # Fase finale: effetti costruzioni a fine turno
    _trigger_building_end(state, player)

    # Pesca fino al limite (6 carte di default)
    from engine.deck import draw_to_hand_limit
    draw_to_hand_limit(state, player.id, limit=6)

    # Pulisci effetti scaduti a fine turno
    _clear_turn_expired_effects(player)

    # Verifica condizione di vittoria prima di passare
    winner = _check_winner(state)
    if winner:
        state.phase = "end"
        state.winner_id = winner.id
        state.add_log(winner.id, "game_over", winner=winner.name)
        return state

    # Passa al prossimo giocatore vivo
    num = len(state.players)
    next_idx = (state.current_player_index + 1) % num
    while not state.players[next_idx].is_alive:
        next_idx = (next_idx + 1) % num

    # Se abbiamo completato un giro, incrementa il turno
    if next_idx <= state.current_player_index:
        state.turn += 1

    state.current_player_index = next_idx
    state.add_log(state.players[next_idx].id, "start_turn", turn=state.turn)

    # Inizia il prossimo turno
    _begin_turn(state)

    return state


# ---------------------------------------------------------------------------
# Condizione di vittoria
# ---------------------------------------------------------------------------

def _check_winner(state: GameState) -> Optional[Player]:
    alive = state.alive_players()
    if len(alive) == 1:
        return alive[0]
    if len(alive) == 0:
        return state.players[0]  # fallback improbabile
    return None


# ---------------------------------------------------------------------------
# Fase di Battaglia
# ---------------------------------------------------------------------------

def do_battle(
    state: GameState,
    attacker_player_id: str,
    defender_player_index: int,
    defender_bastion_side: str,
) -> dict:
    """
    Esegue la fase di Battaglia.
    """
    player = state.current_player
    if player.id != attacker_player_id:
        raise ActionError("Non è il tuo turno.")

    if state.battles_remaining <= 0:
        raise ActionError("Hai già effettuato tutte le Battaglie disponibili questo turno.")

    # Verifica adiacenza
    valid_targets = get_valid_attack_targets(state)
    target_key = (defender_player_index, defender_bastion_side)
    if target_key not in valid_targets:
        raise ActionError(f"Bersaglio non valido: giocatore {defender_player_index} bastione {defender_bastion_side}.")

    # Applica bonus ATT da effetti "next_battle"
    _apply_battle_bonuses(player)

    result = resolve_battle(
        state,
        attacker_player_index=state.current_player_index,
        defender_player_index=defender_player_index,
        defender_bastion_side=defender_bastion_side,
    )

    state.battles_remaining -= 1
    state.battle_done_this_turn = True

    # Pulisci effetti "next_battle"
    _clear_battle_effects(player)

    # Controlla vittoria
    if _check_winner(state):
        state.phase = "end"
        winner = _check_winner(state)
        state.winner_id = winner.id if winner else None

    return result


def _apply_battle_bonuses(player: Player) -> None:
    for eff in player.active_effects:
        if eff.get("expires") == "next_battle":
            target_iid = eff.get("target")
            att_bonus = eff.get("att", 0)
            for w in player.all_warriors():
                if w.instance_id == target_iid:
                    w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) + att_bonus


def _clear_battle_effects(player: Player) -> None:
    to_remove = [e for e in player.active_effects if e.get("expires") == "next_battle"]
    for e in to_remove:
        # Rimuovi i modificatori aggiunti
        target_iid = e.get("target")
        att_bonus = e.get("att", 0)
        for w in player.all_warriors():
            if w.instance_id == target_iid:
                w.temp_modifiers["att"] = max(0, w.temp_modifiers.get("att", 0) - att_bonus)
        player.active_effects.remove(e)


# ---------------------------------------------------------------------------
# Stato pubblico (per broadcast ai client)
# ---------------------------------------------------------------------------

def public_state(state: GameState, viewer_player_id: Optional[str] = None) -> dict:
    """
    Ritorna una vista dello stato di gioco sicura per il broadcast.
    Le informazioni private (mano, identità dei Muri avversari) vengono oscurate.
    """
    players_view = []
    for p in state.players:
        p_view = {
            "id": p.id,
            "name": p.name,
            "lives": p.lives,
            "life_cards": p.life_cards if p.id == viewer_player_id else None,
            "mana_remaining": p.mana_remaining if p.id == viewer_player_id else None,
            "actions_remaining": p.actions_remaining if p.id == viewer_player_id else None,
            "hordes_activated_this_turn": p.hordes_activated_this_turn if p.id == viewer_player_id else None,
            "available_hordes": _available_hordes(p) if p.id == viewer_player_id else None,
            "hand_count": len(p.hand),
            "hand": p.hand if p.id == viewer_player_id else None,
            "field": {
                "vanguard": [_warrior_view(w) for w in p.field.vanguard],
                "bastion_left": {
                    "wall_count": len(p.field.bastion_left.walls),
                    "walls": (
                        [w.instance_id for w in p.field.bastion_left.walls]
                        if p.id == viewer_player_id else None
                    ),
                    "warriors": [_warrior_view(w) for w in p.field.bastion_left.warriors],
                },
                "bastion_right": {
                    "wall_count": len(p.field.bastion_right.walls),
                    "walls": (
                        [w.instance_id for w in p.field.bastion_right.walls]
                        if p.id == viewer_player_id else None
                    ),
                    "warriors": [_warrior_view(w) for w in p.field.bastion_right.warriors],
                },
                "village": {
                    "buildings": [_building_view(b) for b in p.field.village.buildings],
                },
            },
        }
        players_view.append(p_view)

    return {
        "game_id": state.game_id,
        "turn": state.turn,
        "current_player_id": state.current_player.id,
        "phase": state.phase,
        "players": players_view,
        "deck_count": len(state.deck),
        "discard_count": len(state.discard_pile),
        "winner_id": state.winner_id,
        "battles_remaining": state.battles_remaining,
        "recent_events": list(state.recent_events),
    }


def _available_hordes(player: Player) -> list:
    """Ritorna le Orde disponibili per il giocatore con info sugli effetti."""
    result = []
    for horde in player.check_horde_with_zones():
        warrior_data = []
        seen_effects: set = set()
        for w in horde["warriors"]:
            card = get_card(w.base_card_id)
            if not isinstance(card, WarriorCard):
                continue
            if card.horde_effect_id and card.horde_effect_id not in seen_effects:
                seen_effects.add(card.horde_effect_id)
                warrior_data.append({
                    "instance_id": w.instance_id,
                    "base_card_id": w.base_card_id,
                    "name": card.name,
                    "horde_effect": card.horde_effect,
                })
        horde_key = f"{horde['zone']}:{horde['species']}"
        if warrior_data:
            result.append({
                "species": horde["species"],
                "zone": horde["zone"],
                "warriors": warrior_data,
                "already_activated": horde_key in player.hordes_activated_this_turn,
            })
    return result


def _warrior_view(w: WarriorInstance) -> dict:
    card = get_card(w.base_card_id)
    return {
        "instance_id": w.instance_id,
        "base_card_id": w.base_card_id,
        "name": card.name if isinstance(card, WarriorCard) else w.base_card_id,
        "att": w.effective_att(),
        "git": w.effective_git(),
        "dif": w.effective_dif(),
        "species": card.species if isinstance(card, WarriorCard) else None,
        "subtype": card.subtype if isinstance(card, WarriorCard) else None,
        "horde_active": w.horde_active,
    }


def _building_view(b: BuildingInstance) -> dict:
    card = get_card(b.base_card_id)
    return {
        "instance_id": b.instance_id,
        "base_card_id": b.base_card_id,
        "name": card.name if isinstance(card, BuildingCard) else b.base_card_id,
        "completed": b.completed,
        "effect": card.complete_effect if b.completed else card.base_effect
        if isinstance(card, BuildingCard) else "",
    }


# ---------------------------------------------------------------------------
# Bot casuale (per test — Fase 1 milestone)
# ---------------------------------------------------------------------------

def random_bot_turn(state: GameState) -> None:
    """
    Esegue un turno casuale per il giocatore corrente.
    Usato per la simulazione console della Fase 1.
    """
    player = state.current_player

    # Fase Azioni: prova a giocare carte
    for _ in range(player.actions_remaining):
        if not player.hand or player.actions_remaining <= 0:
            break
        _bot_try_action(state, player)

    # Fase Riposizionamento: sposta casualmente qualche guerriero
    _bot_reposition(state, player)

    # Fase Orda: attiva se disponibile
    _bot_try_horde(state, player)

    # Fase Battaglia: attacca se possibile
    targets = get_valid_attack_targets(state)
    if targets and state.battles_remaining > 0 and player.field.vanguard:
        t_idx, t_side = random.choice(targets)
        try:
            do_battle(state, player.id, t_idx, t_side)
        except ActionError:
            pass

    # Fine turno
    end_turn(state)


def _bot_try_action(state: GameState, player: Player) -> None:
    """Prova a eseguire un'azione casuale."""
    if not player.hand:
        return

    random.shuffle(player.hand)
    for iid in list(player.hand):
        base_id = get_base_card_id(iid)
        try:
            card = get_card(base_id)
        except KeyError:
            continue

        if isinstance(card, WarriorCard):
            if player.mana_remaining >= card.cost:
                region = random.choice(["vanguard", "bastion_left", "bastion_right"])
                try:
                    play_warrior(state, player.id, iid, region)
                    return
                except ActionError:
                    continue

        elif isinstance(card, BuildingCard):
            if player.mana_remaining >= card.cost:
                try:
                    play_building(state, player.id, iid)
                    return
                except ActionError:
                    continue

        elif isinstance(card, SpellCard):
            mages = player.mages_in_field()
            if len(mages) >= card.cost:
                # Scegli un target casuale per le magie che lo richiedono
                targets = [p for p in state.players if p.id != player.id and p.is_alive]
                kwargs: Dict[str, Any] = {}
                if targets:
                    t = random.choice(targets)
                    kwargs["target_player_id"] = t.id
                    kwargs["target_bastion_side"] = random.choice(["left", "right"])
                    kwargs["target_warrior_iid"] = None
                try:
                    play_spell(state, player.id, iid, **kwargs)
                    return
                except ActionError:
                    continue

    # Se non ha potuto giocare carte, prova a completare costruzioni
    for b in player.field.village.buildings:
        if not b.completed:
            base_id = b.base_card_id
            card = get_card(base_id)
            if isinstance(card, BuildingCard) and player.mana_remaining >= card.completion_cost:
                try:
                    complete_building(state, player.id, b.instance_id)
                    return
                except ActionError:
                    continue

    # Ultimo resort: aggiungi fino a 3 muri
    if player.hand:
        n = min(3, len(player.hand))
        chosen = random.sample(player.hand, n)
        walls = [{"instance_id": iid, "bastion": random.choice(["left", "right"])} for iid in chosen]
        try:
            add_wall(state, player.id, walls)
        except ActionError:
            pass


def _bot_reposition(state: GameState, player: Player) -> None:
    """Riposiziona casualmente qualche guerriero."""
    all_warriors = player.all_warriors()
    if not all_warriors:
        return
    w = random.choice(all_warriors)
    dest = random.choice(["vanguard", "bastion_left", "bastion_right"])
    try:
        reposition_warrior(state, player.id, w.instance_id, dest)
    except ActionError:
        pass


def _bot_try_horde(state: GameState, player: Player) -> None:
    """Attiva tutte le Orde disponibili (una per zona+specie)."""
    hordes = player.check_horde_with_zones()
    for horde in hordes:
        zone = horde["zone"]
        species = horde["species"]
        if f"{zone}:{species}" in player.hordes_activated_this_turn:
            continue
        for w in horde["warriors"]:
            card = get_card(w.base_card_id)
            if isinstance(card, WarriorCard) and card.horde_effect_id:
                try:
                    activate_horde(state, player.id, w.base_card_id, w.instance_id, zone=zone)
                    break
                except ActionError:
                    continue


# ---------------------------------------------------------------------------
# Simulazione console (milestone Fase 1)
# ---------------------------------------------------------------------------

def simulate_game(player_names: List[str], verbose: bool = True) -> str:
    """
    Simula una partita completa tra bot casuali.
    Ritorna il nome del vincitore.
    """
    state = create_game(player_names)

    if verbose:
        print(f"\n=== BARBACANE — Partita {state.game_id} ===")
        print(f"Giocatori: {', '.join(p.name for p in state.players)}")
        print(f"Primo giocatore: {state.current_player.name}\n")

    max_turns = 500  # sicurezza anti-loop infinito
    turn_count = 0

    while state.phase != "end" and turn_count < max_turns:
        turn_count += 1
        current = state.current_player
        if verbose:
            print(f"--- Turno {state.turn} | {current.name} | "
                  f"Vite: {[f'{p.name}:{p.lives}' for p in state.players]} ---")

        random_bot_turn(state)

        if state.winner_id:
            break

    winner = state.get_player(state.winner_id) if state.winner_id else None
    # Fallback: se al limite di turni, vince chi ha più vite
    if winner is None:
        alive = state.alive_players()
        if alive:
            winner = max(alive, key=lambda p: p.lives)
    winner_name = winner.name if winner else "Nessuno (pareggio)"

    if verbose:
        print(f"\n=== FINE PARTITA (turno {state.turn}) ===")
        print(f"Vincitore: {winner_name}")
        for p in state.players:
            print(f"  {p.name}: {p.lives} Vite")

    return winner_name


if __name__ == "__main__":
    simulate_game(["Alice", "Bob"], verbose=True)
