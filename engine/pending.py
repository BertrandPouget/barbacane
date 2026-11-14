"""
Risoluzione delle scelte in sospeso: `pending_search`, `pending_interactions`
e la scelta di Velocemento. Le chiamano le route (azioni `resolve_*` dei
giocatori) e i Bot (engine/bot/play.py), che così chiudono le proprie scelte anche
a metà turno e nelle simulazioni.
"""

from __future__ import annotations
from typing import Optional

from engine.actions import ActionError, reposition_warrior, _apply_spell_post_effects
from engine.game import end_turn


def resolve_search(state, player_id: str, chosen_iid: Optional[str]) -> dict:
    ps = state.pending_search
    if not ps:
        raise ActionError("Nessuna ricerca in corso.")
    if ps["player_id"] != player_id:
        raise ActionError("Non è la tua ricerca.")
    if not chosen_iid:
        import random as _random
        _random.shuffle(state.deck)
        state.pending_search = None
        return {"cancelled": True}

    if chosen_iid not in state.deck:
        raise ActionError("La carta scelta non è nel mazzo.")

    from engine.deck import get_base_card_id
    from engine.cards import CARD_REGISTRY
    from engine.models import WarriorCard

    base_id = get_base_card_id(chosen_iid)
    card = CARD_REGISTRY.get(base_id)
    condition = ps["condition"]
    ctype = condition.get("type")
    cvalue = condition.get("value")

    if ctype == "subtype":
        if not (isinstance(card, WarriorCard) and card.subtype == cvalue):
            raise ActionError("La carta scelta non soddisfa la condizione di ricerca.")
    elif ctype == "base_card_id":
        if base_id != cvalue:
            raise ActionError("La carta scelta non soddisfa la condizione di ricerca.")

    import random as _random
    state.deck.remove(chosen_iid)
    _random.shuffle(state.deck)

    player = state.get_player(player_id)
    context = ps["context"]
    result: dict = {"resolved_search": chosen_iid, "context": context}

    if context == "cercapersone_base":
        player.hand.append(chosen_iid)
        state.add_log(player_id, "search", card=chosen_iid)
        result["added_to_hand"] = chosen_iid

    elif context == "cercapersone_prodigio":
        player.hand.append(chosen_iid)
        player.ethereal_card = chosen_iid
        state.add_log(player_id, "search", card=chosen_iid)
        result["added_to_hand"] = chosen_iid
        result["ethereal"] = chosen_iid

    elif context == "giulio_horde":
        player.hand.append(chosen_iid)
        state.add_log(player_id, "search", card=chosen_iid)
        result["added_to_hand"] = chosen_iid

    state.pending_search = None
    return result


def resolve_biblioteca(state, player_id: str, params: dict) -> dict:
    if not state.pending_interactions:
        raise ActionError("Nessuna interazione Biblioteca in corso.")
    pending = state.pending_interactions[0]
    if pending["player_id"] != player_id:
        raise ActionError("Non è la tua interazione.")

    player = state.get_player(player_id)
    result: dict = {}

    if pending["type"] == "biblioteca_discard":
        discard_iid = params.get("discard_iid")
        if not discard_iid and not player.hand:
            # Mano vuota: nessuna carta da scartare, interazione risolta automaticamente
            state.pending_interactions.pop(0)
            return {"skipped": True, "reason": "mano vuota"}
        if not discard_iid:
            raise ActionError("Devi scegliere una carta da scartare.")
        if discard_iid not in player.hand:
            raise ActionError("La carta scelta non è in mano.")
        player.hand.remove(discard_iid)
        state.discard_pile.append(discard_iid)
        state.add_log(player_id, "biblioteca_discard", card=discard_iid)
        result["discarded"] = discard_iid

    elif pending["type"] == "biblioteca_wall":
        wall_card_iid = params.get("wall_card_iid")
        wall_bastion_side = params.get("wall_bastion_side")
        if not wall_card_iid and not player.hand:
            state.pending_interactions.pop(0)
            return {"skipped": True, "reason": "mano vuota"}
        if not wall_card_iid or not wall_bastion_side:
            raise ActionError("Devi scegliere una carta e un Bastione.")
        if wall_card_iid not in player.hand:
            raise ActionError("La carta scelta non è in mano.")
        if wall_bastion_side not in ("left", "right"):
            raise ActionError("Bastione non valido.")
        from engine.deck import make_wall_instance
        player.hand.remove(wall_card_iid)
        bastion = player.field.bastion_left if wall_bastion_side == "left" else player.field.bastion_right
        bastion.walls.append(make_wall_instance(wall_card_iid))
        state.add_log(player_id, "biblioteca_wall", card=wall_card_iid, bastion=wall_bastion_side)
        result["wall_added"] = wall_card_iid
        result["bastion"] = wall_bastion_side

    state.pending_interactions.pop(0)
    return result


def resolve_agilpesca(state, player_id: str, params: dict) -> dict:
    if not state.pending_interactions:
        raise ActionError("Nessuna interazione Agilpesca in corso.")
    pending = state.pending_interactions[0]
    if pending.get("type") != "agilpesca_discard":
        raise ActionError("L'interazione in attesa non è Agilpesca.")
    if pending["player_id"] != player_id:
        raise ActionError("Non è la tua interazione.")

    player = state.get_player(player_id)
    discard_iid = params.get("discard_iid")
    if not discard_iid:
        raise ActionError("Devi scegliere una carta da scartare.")
    if discard_iid not in player.hand:
        raise ActionError("La carta scelta non è in mano.")

    player.hand.remove(discard_iid)
    state.discard_pile.append(discard_iid)
    state.add_log(player_id, "agilpesca_discard", card=discard_iid)
    state.pending_interactions.pop(0)
    return {"discarded": discard_iid}


def resolve_velocemento(state, player_id: str, params: dict) -> dict:
    """Il giocatore sceglie quale Costruzione in mano rendere Eterea dopo aver giocato Velocemento."""
    player = state.get_player(player_id)
    if not player or not player.pending_velocemento_buildings:
        raise ActionError("Nessuna scelta Velocemento in attesa.")

    building_iid = params.get("building_instance_id")
    if not building_iid:
        raise ActionError("Parametro building_instance_id mancante.")
    if building_iid not in player.pending_velocemento_buildings:
        raise ActionError("Costruzione non valida per Velocemento.")
    if building_iid not in player.hand:
        raise ActionError("La carta non è più in mano.")

    player.pending_velocemento_buildings = []
    player.ethereal_card = building_iid
    if player.pending_velocemento_prodigy:
        player.ethereal_complete = building_iid
        player.pending_velocemento_prodigy = False
    state.add_log(player_id, "velocemento_ethereal", building=building_iid)
    return {"ethereal_card": building_iid, "ethereal_complete": player.ethereal_complete}


def resolve_cardo_move(state, player_id: str, params: dict) -> dict:
    if not state.pending_interactions:
        raise ActionError("Nessuna interazione Cardo in corso.")
    pending = state.pending_interactions[0]
    if pending.get("type") != "cardo_move":
        raise ActionError("L'interazione in attesa non è Cardo.")
    if pending["player_id"] != player_id:
        raise ActionError("Non è la tua interazione.")

    state.pending_interactions.pop(0)

    # Marca che il movimento Cardo è stato risolto questo turno (evita re-trigger in end_turn)
    player = state.get_player(player_id)
    player.active_effects.append({"type": "cardo_move_done", "expires": "end_of_turn"})

    warrior_iid = params.get("warrior_iid")
    destination = params.get("destination")
    result: dict = {}

    if warrior_iid and destination:
        reposition_warrior(state, player_id, warrior_iid, destination)
        result["moved"] = warrior_iid
        result["destination"] = destination
    else:
        result["skipped"] = True

    end_turn(state)
    result["turn_ended"] = True
    return result


def resolve_magiscudo_counter(state, player_id: str, params: dict) -> dict:
    if not state.pending_interactions:
        raise ActionError("Nessuna interazione Magiscudo in corso.")
    pending = state.pending_interactions[0]
    if pending.get("type") != "magiscudo_counter":
        raise ActionError("L'interazione in attesa non è Magiscudo.")
    if pending["player_id"] != player_id:
        raise ActionError("Non è la tua scelta.")

    from engine.effects import apply_effect
    from engine.deck import get_base_card_id

    state.pending_interactions.pop(0)
    accept = params.get("accept", False)
    defender = state.get_player(player_id)

    if accept:
        magiscudo_iid = next(
            (iid for iid in defender.hand if get_base_card_id(iid) == "magiscudo"),
            None,
        )
        if not magiscudo_iid:
            raise ActionError("Non hai Magiscudo in mano.")
        defender.hand.remove(magiscudo_iid)
        state.discard_pile.append(magiscudo_iid)
        apply_effect("magiscudo_effect", state, defender, prodigy=True)
        state.recent_events.append({
            "type": "magiscudo_blocked",
            "card": get_base_card_id(pending["spell_iid"]),
            "player_id": pending["caster_id"],
            "blocked_player": player_id,
        })
        state.add_log(player_id, "magiscudo_counter", spell=pending["spell_iid"])
        return {"magiscudo_used": True, "spell_blocked": pending["spell_iid"]}

    # Bersaglio declina: applica l'effetto originale della magia
    caster = state.get_player(pending["caster_id"])
    if not caster:
        return {"declined": True}
    result = apply_effect(
        pending["effect_id"], state, caster,
        prodigy=pending["prodigy"], **pending.get("kwargs", {}),
    )
    _apply_spell_post_effects(
        state, caster,
        pending["spell_cost"], pending["spell_school"],
        pending["spell_base_id"], pending["spell_iid"],
        result,
    )
    state.add_log(player_id, "magiscudo_counter_declined", spell=pending["spell_iid"])
    return {"declined": True, "effect": result}


def resolve_malcomune(state, player_id: str, params: dict) -> dict:
    if not state.pending_interactions:
        raise ActionError("Nessuna interazione Malcomune in corso.")
    pending = state.pending_interactions[0]
    if pending.get("type") != "malcomune_discard":
        raise ActionError("L'interazione in attesa non è Malcomune.")
    if pending["player_id"] != player_id:
        raise ActionError("Non è la tua scelta.")

    from engine.effects import _discard_warrior_from_player, _find_warrior_in_all
    from engine.cards import get_card, WarriorCard

    player = state.get_player(player_id)
    warrior_iid = params.get("warrior_iid")
    species = pending["species"]
    w = _find_warrior_in_all(player, warrior_iid) if warrior_iid else None
    card = get_card(w.base_card_id) if w else None
    if not w or not isinstance(card, WarriorCard) or card.species != species:
        raise ActionError("Devi scegliere un tuo Guerriero della Specie richiesta.")

    state.pending_interactions.pop(0)
    _discard_warrior_from_player(state, player, warrior_iid)
    state.recent_events.append({
        "type": "warrior_discarded", "card": "malcomune",
        "player_id": pending["caster_id"],
        "species": species,
        "enemies_discarded": [{"player": player_id, "warrior": warrior_iid}],
    })
    state.add_log(player_id, "malcomune_discard", warrior=warrior_iid)
    return {"discarded": warrior_iid}
