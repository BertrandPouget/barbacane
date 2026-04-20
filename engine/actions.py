"""
Validazione e applicazione delle azioni del giocatore.

Azioni disponibili per turno (fino a 2):
1. play_card      – Gioca una carta dalla mano
2. complete_building – Completa una Costruzione nel Villaggio
3. add_wall       – Aggiungi una carta dalla mano come Muro a un Bastione

Altre operazioni (non consumano azione):
- reposition      – Sposta Guerrieri tra Avanscoperta e Bastioni
- activate_horde  – Attiva un effetto Orda
- battle          – Attacca un Bastione avversario
"""

from __future__ import annotations
from typing import Any, Dict, Optional

from engine.models import (
    GameState,
    Player,
    WarriorInstance,
    BuildingInstance,
)
from engine.cards import get_card, CARD_REGISTRY, WarriorCard, SpellCard, BuildingCard
from engine.deck import (
    make_warrior_instance,
    make_building_instance,
    make_wall_instance,
    get_base_card_id,
)
from engine.effects import apply_effect, EFFECT_REGISTRY
import random as _random


# ---------------------------------------------------------------------------
# Errori di validazione
# ---------------------------------------------------------------------------

class ActionError(Exception):
    """Azione non valida."""
    pass


# ---------------------------------------------------------------------------
# Validazioni comuni
# ---------------------------------------------------------------------------

def _require_current_player(state: GameState, player_id: str) -> Player:
    if state.current_player.id != player_id:
        raise ActionError("Non è il tuo turno.")
    return state.current_player


def _require_actions(player: Player, count: int = 1) -> None:
    if player.actions_remaining < count:
        raise ActionError(f"Azioni rimanenti insufficienti: {player.actions_remaining}.")


def _require_in_hand(player: Player, instance_id: str) -> None:
    if instance_id not in player.hand:
        raise ActionError(f"La carta {instance_id} non è nella tua mano.")


# ---------------------------------------------------------------------------
# 1. Gioca Guerriero
# ---------------------------------------------------------------------------

def play_warrior(
    state: GameState,
    player_id: str,
    instance_id: str,
    region: str,  # "vanguard" | "bastion_left" | "bastion_right"
) -> dict:
    """
    Gioca un Guerriero dalla mano nel campo.
    - region: dove posizionarlo (Avanscoperta o Bastione).
    - Costo: Mana pari al costo della carta.
    - Consuma 1 Azione.
    """
    player = _require_current_player(state, player_id)
    _require_actions(player)
    _require_in_hand(player, instance_id)

    base_id = get_base_card_id(instance_id)
    card = get_card(base_id)
    if not isinstance(card, WarriorCard):
        raise ActionError(f"{instance_id} non è un Guerriero.")

    if region not in ("vanguard", "bastion_left", "bastion_right"):
        raise ActionError(f"Regione non valida: {region}.")

    # Costo Mana
    cost = card.cost
    if player.mana_remaining < cost:
        raise ActionError(f"Mana insufficiente: {player.mana_remaining}/{cost}.")

    # Pagamento e rimozione dalla mano
    player.mana_remaining -= cost
    player.hand.remove(instance_id)
    player.actions_remaining -= 1

    # Crea l'istanza e posiziona
    w_inst = make_warrior_instance(instance_id)
    _place_warrior_in_region(player, w_inst, region)

    state.add_log(player_id, "play_warrior", card=instance_id, region=region)
    return {"card": instance_id, "region": region, "mana_spent": cost}


def _place_warrior_in_region(player: Player, warrior: WarriorInstance, region: str) -> None:
    if region == "vanguard":
        player.field.vanguard.append(warrior)
    elif region == "bastion_left":
        player.field.bastion_left.warriors.append(warrior)
    elif region == "bastion_right":
        player.field.bastion_right.warriors.append(warrior)


# ---------------------------------------------------------------------------
# 2. Evolvi Guerriero (da Recluta a Eroe)
# ---------------------------------------------------------------------------

def evolve_warrior(
    state: GameState,
    player_id: str,
    recruit_instance_id: str,  # Recluta in campo
    hero_instance_id: str,      # Eroe in mano
) -> dict:
    """
    Evolve una Recluta in campo in un Eroe.
    L'Eroe viene posizionato sopra la Recluta, ereditandone Orda e carte assegnate.
    Costo: il costo dell'Eroe in Mana. Consuma 1 Azione.
    """
    player = _require_current_player(state, player_id)
    _require_actions(player)
    _require_in_hand(player, hero_instance_id)

    hero_base_id = get_base_card_id(hero_instance_id)
    hero_card = get_card(hero_base_id)
    if not isinstance(hero_card, WarriorCard) or hero_card.subtype != "hero":
        raise ActionError(f"{hero_instance_id} non è un Eroe.")

    # Trova la Recluta in campo
    recruit = None
    recruit_region = None
    for region_name, region_list in _warrior_regions(player):
        for w in region_list:
            if w.instance_id == recruit_instance_id:
                recruit = w
                recruit_region = region_name
                break
        if recruit:
            break

    if recruit is None:
        raise ActionError(f"Recluta {recruit_instance_id} non trovata in campo.")

    recruit_base_id = get_base_card_id(recruit_instance_id)
    recruit_card = get_card(recruit_base_id)
    if not isinstance(recruit_card, WarriorCard):
        raise ActionError("La carta in campo non è un Guerriero.")
    if recruit_card.evolves_into != hero_base_id:
        raise ActionError(f"{hero_base_id} non è l'evoluzione di {recruit_base_id}.")

    # Costo
    cost = hero_card.cost
    if player.mana_remaining < cost:
        raise ActionError(f"Mana insufficiente: {player.mana_remaining}/{cost}.")

    player.mana_remaining -= cost
    player.hand.remove(hero_instance_id)
    player.actions_remaining -= 1

    # Crea l'Eroe ereditando le proprietà della Recluta
    hero_inst = WarriorInstance(
        instance_id=hero_instance_id,
        base_card_id=hero_base_id,
        evolved_from=recruit_instance_id,
        assigned_cards=list(recruit.assigned_cards),
        temp_modifiers=dict(recruit.temp_modifiers),
    )

    # Sostituisce la Recluta nella stessa regione
    for region_name, region_list in _warrior_regions(player):
        if region_name == recruit_region:
            idx = region_list.index(recruit)
            region_list[idx] = hero_inst
            break

    # La Recluta non va negli scarti (rimane "sotto" l'Eroe — gestita come evolved_from)
    state.discard_pile.append(recruit_instance_id)

    state.add_log(player_id, "evolve_warrior",
                  recruit=recruit_instance_id, hero=hero_instance_id, region=recruit_region)
    return {"recruit": recruit_instance_id, "hero": hero_instance_id, "region": recruit_region}


def _warrior_regions(player: Player):
    yield "vanguard", player.field.vanguard
    yield "bastion_left", player.field.bastion_left.warriors
    yield "bastion_right", player.field.bastion_right.warriors


# ---------------------------------------------------------------------------
# 3. Gioca Magia
# ---------------------------------------------------------------------------

def play_spell(
    state: GameState,
    player_id: str,
    instance_id: str,
    **kwargs: Any,  # parametri extra per l'effetto (target, ecc.)
) -> dict:
    """
    Gioca una Magia dalla mano.
    Costo: numero di Maghe in campo del costo della Magia.
    Prodigio: attivo se le Maghe in campo sono tutte della stessa scuola della Magia.
    Consuma 1 Azione.
    """
    player = _require_current_player(state, player_id)
    _require_actions(player)
    _require_in_hand(player, instance_id)

    base_id = get_base_card_id(instance_id)
    card = get_card(base_id)
    if not isinstance(card, SpellCard):
        raise ActionError(f"{instance_id} non è una Magia.")

    # Conta Maghe in campo e verifica il costo
    mages = player.mages_in_field()
    mages_count = len(mages)

    # Applica sconti da Orde o effetti attivi
    cost = card.cost
    school = card.school

    # Controlla effetti "spell_free" (da Araminta, Madeleine ordes)
    free_effect = None
    for eff in player.active_effects:
        if eff.get("type") == "spell_free" and eff.get("school") == school and eff.get("uses", 0) > 0:
            free_effect = eff
            break

    if free_effect:
        # Magia gratuita
        cost_to_pay = 0
        free_effect["uses"] -= 1
        if free_effect["uses"] <= 0:
            player.active_effects.remove(free_effect)
    else:
        # Applica sconti normali
        discount = player.spell_cost_reductions.get(school, 0)
        cost_to_pay = max(0, cost - discount)
        if mages_count < cost_to_pay:
            raise ActionError(f"Maghe insufficienti: {mages_count} disponibili, {cost_to_pay} richieste.")

    # Verifica Prodigio: tutte le Maghe in campo sono della stessa scuola della Magia
    prodigy = False
    if mages_count >= cost_to_pay and mages_count > 0:
        mages_by_school = player.mages_by_school()
        same_school_count = mages_by_school.get(school, 0)
        # Madeleine horde: incantesimo prodigy triggers with any mage school
        madeleine_active = any(
            e.get("type") == "madeleine_prodigy_any_school"
            for e in player.active_effects
        )
        if madeleine_active and school == "incantesimo":
            prodigy = (mages_count >= cost_to_pay) and (cost_to_pay > 0 or free_effect)
        else:
            prodigy = (same_school_count >= cost_to_pay) and (cost_to_pay > 0 or free_effect)

    # Rimuovi dalla mano e consuma azione
    player.hand.remove(instance_id)
    player.actions_remaining -= 1

    # Applica effetto
    result = apply_effect(card.effect_id, state, player, prodigy=prodigy, **kwargs)

    # Scarta la Magia
    state.discard_pile.append(instance_id)

    # Araminta horde: anatema cost-1 spells return to hand
    araminta_eff = next(
        (e for e in player.active_effects
         if e.get("type") == "araminta_spell_return"
         and e.get("school") == school
         and card.cost <= e.get("cost", 1)),
        None,
    )
    if araminta_eff:
        if instance_id in state.discard_pile:
            state.discard_pile.remove(instance_id)
        player.hand.append(instance_id)
        result["returned_to_hand"] = True

    # Obelisco: after playing a spell, roll D10 and maybe return to hand
    if not result.get("returned_to_hand"):
        for b_inst in player.field.village.buildings:
            if b_inst.base_card_id == "obelisco":
                roll = _random.randint(1, 10)
                threshold = 6 if b_inst.completed else 8
                returned = roll >= threshold
                if returned:
                    if instance_id in state.discard_pile:
                        state.discard_pile.remove(instance_id)
                    player.hand.append(instance_id)
                    result["returned_to_hand"] = True
                state.recent_events.append({
                    "type": "d10", "card": "obelisco",
                    "player_id": player.id, "roll": roll,
                    "threshold": threshold, "returned": returned,
                })
                break

    # Evelyn horde: sortilegio cost-1 spells are cast a second time
    evelyn_eff = next(
        (e for e in player.active_effects
         if e.get("type") == "evelyn_spell_double"
         and e.get("school") == school
         and card.cost <= e.get("cost", 1)),
        None,
    )
    if evelyn_eff and not result.get("returned_to_hand"):
        result["needs_recast"] = True
        result["recast_base_id"] = base_id

    state.add_log(player_id, "play_spell", card=instance_id, prodigy=prodigy)
    return {"card": instance_id, "prodigy": prodigy, "effect": result}


# ---------------------------------------------------------------------------
# 4. Gioca Costruzione
# ---------------------------------------------------------------------------

def play_building(
    state: GameState,
    player_id: str,
    instance_id: str,
) -> dict:
    """
    Piazza una Costruzione nel Villaggio (incompleta).
    Costo: Mana pari al costo. Consuma 1 Azione.
    Cardo/Decumano si completano automaticamente (completion_cost = 0).
    """
    player = _require_current_player(state, player_id)
    _require_actions(player)
    _require_in_hand(player, instance_id)

    base_id = get_base_card_id(instance_id)
    card = get_card(base_id)
    if not isinstance(card, BuildingCard):
        raise ActionError(f"{instance_id} non è una Costruzione.")

    cost = card.cost
    if player.mana_remaining < cost:
        raise ActionError(f"Mana insufficiente: {player.mana_remaining}/{cost}.")

    player.mana_remaining -= cost
    player.hand.remove(instance_id)
    player.actions_remaining -= 1

    b_inst = _place_building(state, player, instance_id)
    state.add_log(player_id, "play_building", card=instance_id, completed=b_inst.completed)
    return {"card": instance_id, "completed": b_inst.completed}


def _place_building(
    state: GameState,
    player: Player,
    instance_id: str,
    free: bool = False,
) -> BuildingInstance:
    """Posiziona una Costruzione nel Villaggio. Se free=True salta il costo Mana."""
    base_id = get_base_card_id(instance_id)
    card = get_card(base_id)
    if not isinstance(card, BuildingCard):
        raise ActionError(f"{instance_id} non è una Costruzione.")

    if not free:
        pass  # Il costo è già stato sottratto dal chiamante

    b_inst = make_building_instance(instance_id)
    player.field.village.buildings.append(b_inst)

    # Se auto_complete (Cardo, Decumano): applica subito l'effetto completo
    if card.auto_complete:
        b_inst.completed = True
        apply_effect(card.effect_id, state, player, completed=True)
    else:
        # Effetto base attivo (passivo, verrà applicato nei trigger appropriati)
        pass

    return b_inst


# ---------------------------------------------------------------------------
# 5. Completa Costruzione
# ---------------------------------------------------------------------------

def complete_building(
    state: GameState,
    player_id: str,
    building_instance_id: str,
) -> dict:
    """
    Completa una Costruzione nel Villaggio.
    Costo: Mana di completamento. Consuma 1 Azione.
    """
    player = _require_current_player(state, player_id)
    _require_actions(player)

    # Trova la costruzione
    b_inst = None
    for b in player.field.village.buildings:
        if b.instance_id == building_instance_id:
            b_inst = b
            break
    if b_inst is None:
        raise ActionError(f"Costruzione {building_instance_id} non trovata nel Villaggio.")
    if b_inst.completed:
        raise ActionError(f"Costruzione {building_instance_id} già completata.")

    base_id = get_base_card_id(building_instance_id)
    card = get_card(base_id)
    if not isinstance(card, BuildingCard):
        raise ActionError("Carta non valida.")

    cost = card.completion_cost
    if player.mana_remaining < cost:
        raise ActionError(f"Mana insufficiente per completamento: {player.mana_remaining}/{cost}.")

    player.mana_remaining -= cost
    player.actions_remaining -= 1
    b_inst.completed = True

    state.add_log(player_id, "complete_building", card=building_instance_id, mana_spent=cost)
    return {"card": building_instance_id, "mana_spent": cost}


# ---------------------------------------------------------------------------
# 6. Aggiungi Muri (fino a 3 con una singola azione)
# ---------------------------------------------------------------------------

def add_wall(
    state: GameState,
    player_id: str,
    walls: list,  # [{"instance_id": str, "bastion": "left"|"right"}, ...]  1–3 elementi
) -> dict:
    """
    Converte fino a 3 carte dalla mano in Muri, distribuibili tra i due Bastioni
    in qualsiasi combinazione. Consuma 1 Azione. Nessun costo Mana.
    """
    player = _require_current_player(state, player_id)
    _require_actions(player)

    if not walls or len(walls) > 3:
        raise ActionError("Devi specificare da 1 a 3 carte da convertire in Muro.")

    for entry in walls:
        if entry.get("bastion") not in ("left", "right"):
            raise ActionError(f"Lato Bastione non valido: {entry.get('bastion')}.")
        _require_in_hand(player, entry["instance_id"])

    # Verifica che non ci siano duplicati
    ids = [e["instance_id"] for e in walls]
    if len(ids) != len(set(ids)):
        raise ActionError("Non puoi usare la stessa carta due volte.")

    player.actions_remaining -= 1

    placed = []
    for entry in walls:
        iid = entry["instance_id"]
        side = entry["bastion"]
        player.hand.remove(iid)
        wall = make_wall_instance(iid)
        if side == "left":
            player.field.bastion_left.walls.append(wall)
        else:
            player.field.bastion_right.walls.append(wall)
        placed.append({"card": iid, "bastion": side})

    state.add_log(player_id, "add_wall", walls=placed)
    return {"walls": placed}


# ---------------------------------------------------------------------------
# 7. Riposiziona Guerrieri
# ---------------------------------------------------------------------------

def reposition_warrior(
    state: GameState,
    player_id: str,
    warrior_instance_id: str,
    destination: str,  # "vanguard" | "bastion_left" | "bastion_right"
) -> dict:
    """
    Sposta un Guerriero tra Avanscoperta e Bastioni.
    Disponibile nella fase 'reposition', senza costo.
    """
    if state.phase not in ("reposition", "action"):
        raise ActionError("Riposizionamento non disponibile in questa fase.")

    player = _require_current_player(state, player_id)
    if destination not in ("vanguard", "bastion_left", "bastion_right"):
        raise ActionError(f"Destinazione non valida: {destination}.")

    # Trova il guerriero
    warrior = None
    source_region = None
    for region_name, region_list in _warrior_regions(player):
        for w in region_list:
            if w.instance_id == warrior_instance_id:
                warrior = w
                source_region = region_name
                break
        if warrior:
            break

    if warrior is None:
        raise ActionError(f"Guerriero {warrior_instance_id} non trovato in campo.")
    if source_region == destination:
        raise ActionError("Il guerriero è già nella destinazione.")

    # Rimuovi dalla sorgente
    _get_region(player, source_region).remove(warrior)
    # Aggiungi alla destinazione
    _get_region(player, destination).append(warrior)

    state.add_log(player_id, "reposition", warrior=warrior_instance_id,
                  from_region=source_region, to_region=destination)
    return {"warrior": warrior_instance_id, "from": source_region, "to": destination}


def _get_region(player: Player, region: str):
    if region == "vanguard":
        return player.field.vanguard
    elif region == "bastion_left":
        return player.field.bastion_left.warriors
    elif region == "bastion_right":
        return player.field.bastion_right.warriors
    raise ActionError(f"Regione non valida: {region}")


# ---------------------------------------------------------------------------
# 8. Attiva Orda
# ---------------------------------------------------------------------------

def activate_horde(
    state: GameState,
    player_id: str,
    horde_card_id: str,  # base_card_id della carta al centro dell'Orda
    warrior_instance_id: Optional[str] = None,
    **kwargs: Any,
) -> dict:
    """
    Attiva un effetto Orda.
    Richiede che esista un'Orda (≥3 Guerrieri stessa Specie) in campo.
    Il giocatore sceglie quale effetto attivare (quale carta usare come centro).
    """
    if state.phase not in ("horde", "action"):
        raise ActionError("Attivazione Orda non disponibile in questa fase.")

    player = _require_current_player(state, player_id)

    if player.horde_used_this_turn:
        raise ActionError("Hai già attivato un'Orda questo turno.")

    hordes = player.check_horde()

    # Trova la Specie della carta Orda selezionata
    card = get_card(horde_card_id)
    if not isinstance(card, WarriorCard):
        raise ActionError(f"{horde_card_id} non è un Guerriero.")

    species = card.species
    if species not in hordes:
        raise ActionError(f"Nessuna Orda attiva per la specie {species}.")

    horde_effect_id = card.horde_effect_id
    if not horde_effect_id:
        raise ActionError(f"La carta {horde_card_id} non ha effetto Orda.")

    # Segna visivamente la carta al centro dell'Orda
    for w in hordes[species]:
        w.horde_active = (w.base_card_id == horde_card_id)

    result = apply_effect(horde_effect_id, state, player,
                          warrior_iid=warrior_instance_id, **kwargs)

    player.horde_used_this_turn = True
    state.add_log(player_id, "activate_horde", species=species,
                  horde_card=horde_card_id, effect=horde_effect_id, result=result)
    return {"species": species, "horde_card": horde_card_id, "effect": result}


# ---------------------------------------------------------------------------
# Helper per effetti che piazzano costruzioni gratis
# ---------------------------------------------------------------------------

def place_building_free(state: GameState, player: Player, instance_id: str) -> BuildingInstance:
    """Piazza una Costruzione senza costo Mana (usato da Cercapersone + Prodigio)."""
    return _place_building(state, player, instance_id, free=True)


# ---------------------------------------------------------------------------
# 9. Recast Magia (Orda Evelyn)
# ---------------------------------------------------------------------------

def recast_spell(
    state: GameState,
    player_id: str,
    base_card_id: str,
    **kwargs: Any,
) -> dict:
    """
    Rigioca una Magia per la seconda volta (Orda Evelyn).
    Nessun costo Azione o Maghe — l'effetto viene applicato con nuovi parametri di targeting.
    """
    player = _require_current_player(state, player_id)

    evelyn_eff = next(
        (e for e in player.active_effects if e.get("type") == "evelyn_spell_double"),
        None,
    )
    if evelyn_eff is None:
        raise ActionError("Effetto Evelyn Orda non attivo.")

    card = get_card(base_card_id)
    if not isinstance(card, SpellCard):
        raise ActionError(f"{base_card_id} non è una Magia.")

    # Prodigio: stessa logica della prima giocata
    mages_count = len(player.mages_in_field())
    prodigy = False
    if mages_count > 0 and card.cost > 0:
        mages_by_school = player.mages_by_school()
        prodigy = mages_by_school.get(card.school, 0) >= card.cost

    result = apply_effect(card.effect_id, state, player, prodigy=prodigy, **kwargs)

    state.add_log(player_id, "recast_spell", card=base_card_id, prodigy=prodigy)
    return {"card": base_card_id, "prodigy": prodigy, "effect": result, "recast": True}


# ---------------------------------------------------------------------------
# 10. Distruggi Costruzione (Orda Eracle)
# ---------------------------------------------------------------------------

def eracle_destroy(
    state: GameState,
    player_id: str,
    building_instance_id: str,
    target_player_id: str,
) -> dict:
    """
    Distrugge una Costruzione avversaria dopo una vittoria in battaglia (Orda Eracle).
    Consuma l'effetto Eracle attivo.
    """
    player = _require_current_player(state, player_id)

    eracle_eff = next(
        (e for e in player.active_effects if e.get("type") == "eracle_destroy_building"),
        None,
    )
    if eracle_eff is None:
        raise ActionError("Effetto Eracle Orda non attivo.")

    target = state.get_player(target_player_id)
    if target is None:
        raise ActionError("Giocatore bersaglio non trovato.")

    b = next(
        (b for b in target.field.village.buildings if b.instance_id == building_instance_id),
        None,
    )
    if b is None:
        raise ActionError("Costruzione non trovata nel Villaggio avversario.")

    target.field.village.buildings.remove(b)
    state.discard_pile.append(b.instance_id)
    player.active_effects.remove(eracle_eff)

    state.add_log(player_id, "eracle_destroy",
                  building=building_instance_id, from_player=target_player_id)
    return {"destroyed": building_instance_id, "from_player": target_player_id}
