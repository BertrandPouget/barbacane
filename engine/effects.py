"""
Registry degli effetti delle carte.
Ogni effetto è una funzione registrata tramite @register_effect(card_id).

Convenzioni:
- Gli effetti di Costruzione ricevono (state, player, completed: bool, **kwargs)
- Gli effetti di Magia ricevono (state, player, prodigy: bool, **kwargs) dove kwargs
  contiene eventuali parametri di targeting (target_bastion_side, target_player_id, ecc.)
- Gli effetti Orda ricevono (state, player, **kwargs)
"""

from __future__ import annotations
import random
from typing import Any, Callable, Dict, List, Optional

from engine.models import GameState, Player, BuildingInstance, WarriorInstance


EFFECT_REGISTRY: Dict[str, Callable] = {}


def register_effect(effect_id: str):
    """Decoratore per registrare un effetto nel registry."""
    def decorator(func: Callable) -> Callable:
        EFFECT_REGISTRY[effect_id] = func
        return func
    return decorator


def apply_effect(effect_id: str, state: GameState, player: Player, **kwargs) -> dict:
    """
    Applica un effetto registrato. Ritorna un dict con il risultato.
    Se l'effetto non è registrato, ritorna un messaggio di warning.
    """
    if effect_id not in EFFECT_REGISTRY:
        return {"warning": f"Effetto non implementato: {effect_id}"}
    return EFFECT_REGISTRY[effect_id](state, player, **kwargs) or {}


# ---------------------------------------------------------------------------
# Helper interni
# ---------------------------------------------------------------------------

def _roll_d10() -> int:
    return random.randint(1, 10)


def _apply_scrigno_bonus(player: Player, amount: int) -> int:
    """Applies Scrigno mana bonus when a non-Scrigno card grants mana. Returns bonus granted."""
    bonus = 0
    for b in player.field.village.buildings:
        if b.base_card_id == "scrigno":
            extra = amount if b.completed else 1
            player.mana_remaining += extra
            bonus += extra
    return bonus


def _add_walls_to_bastion(state: GameState, player: Player, side: str, count: int, durability: int = 1) -> int:
    """Aggiunge `count` Muri al Bastione `side` del giocatore usando carte dal mazzo."""
    from engine.deck import make_wall_instance
    bastion = player.field.bastion_left if side == "left" else player.field.bastion_right
    added = 0
    for _ in range(count):
        if state.deck:
            iid = state.deck.pop(0)
            wall = make_wall_instance(iid, durability=durability)
            bastion.walls.append(wall)
            added += 1
        elif state.discard_pile:
            iid = state.discard_pile.pop(0)
            wall = make_wall_instance(iid, durability=durability)
            bastion.walls.append(wall)
            added += 1
    return added


def _draw_cards(state: GameState, player: Player, count: int) -> list:
    from engine.deck import draw_cards
    return draw_cards(state, player.id, count)


def _find_warrior(player: Player, warrior_iid: Optional[str]) -> Optional[WarriorInstance]:
    """Trova un guerriero del giocatore per instance_id, o il primo disponibile."""
    warriors = player.all_warriors()
    if warrior_iid:
        for w in warriors:
            if w.instance_id == warrior_iid:
                return w
    return warriors[0] if warriors else None


def _is_hero(w: WarriorInstance) -> bool:
    from engine.cards import get_card, WarriorCard
    card = get_card(w.base_card_id)
    return isinstance(card, WarriorCard) and card.subtype == "hero"


def _discard_warrior_from_player(state: GameState, player: Player, warrior_iid: str) -> bool:
    """Rimuove un guerriero dal campo del giocatore e lo mette negli scarti.
    Se è un Eroe, la Recluta torna in campo con le carte assegnate (regola standard).
    Se è una Recluta, le carte assegnate vanno negli scarti."""
    region_names = ["vanguard", "bastion_left", "bastion_right"]
    regions = [
        player.field.vanguard,
        player.field.bastion_left.warriors,
        player.field.bastion_right.warriors,
    ]
    for region_name, region in zip(region_names, regions):
        for w in region:
            if w.instance_id == warrior_iid:
                region.remove(w)
                player.deactivate_broken_horde(w, region_name)
                if w.evolved_from:
                    from engine.deck import get_base_card_id as _get_base
                    recruit_inst = WarriorInstance(
                        instance_id=w.evolved_from,
                        base_card_id=_get_base(w.evolved_from),
                        assigned_cards=list(w.assigned_cards),
                        temp_modifiers={},
                    )
                    region.append(recruit_inst)
                else:
                    for ac_iid in w.assigned_cards:
                        state.discard_pile.append(ac_iid)
                state.discard_pile.append(w.instance_id)
                return True
    return False


def _find_warrior_in_all(player: Player, warrior_iid: str) -> Optional[WarriorInstance]:
    """Cerca un guerriero in tutto il campo (vanguard + bastioni)."""
    for w in player.all_warriors():
        if w.instance_id == warrior_iid:
            return w
    return None


# ---------------------------------------------------------------------------
# EFFETTI COSTRUZIONI
# ---------------------------------------------------------------------------

@register_effect("ariete_effect")
def ariete_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    # Passivo: gestito in battle.py tramite il controllo sulle costruzioni
    return {"passive": True, "att_bonus": 2 if completed else 1}


@register_effect("catapulta_effect")
def catapulta_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    # Passivo: gestito in battle.py
    return {"passive": True, "git_bonus": 2 if completed else 1}


@register_effect("saracinesca_effect")
def saracinesca_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    # Passivo: gestito in battle.py
    return {"passive": True, "dif_bonus": 2 if completed else 1}


@register_effect("estrattore_effect")
def estrattore_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """Base: roll D10, se ≥6 gain +1 mana. Complete: gain +1 mana automaticamente."""
    if completed:
        player.mana_remaining += 1
        bonus = _apply_scrigno_bonus(player, 1)
        total = 1 + bonus
        state.recent_events.append({
            "type": "mana", "card": "estrattore",
            "player_id": player.id,
            "mana_gained": total,
        })
        return {"mana_gained": total}
    else:
        roll = _roll_d10()
        gained = 1 if roll >= 6 else 0
        if gained:
            player.mana_remaining += gained
            bonus = _apply_scrigno_bonus(player, gained)
            total = gained + bonus
        else:
            total = 0
        state.recent_events.append({
            "type": "d10", "card": "estrattore",
            "player_id": player.id, "roll": roll,
            "mana_gained": total, "triggered": bool(gained),
        })
        return {"roll": roll, "mana_gained": total}


@register_effect("granaio_effect")
def granaio_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    # Logica gestita direttamente in game._trigger_building_end (effetto cumulativo).
    return {"passive": True}


@register_effect("fucina_effect")
def fucina_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """
    Base: dopo la 2a azione, roll D10, se ≥6 gain extra action.
    Complete: sempre gain 3a azione.
    Questo è passivo/attivo - store come active_effect sul giocatore, verificato in actions.py.
    """
    if completed:
        player.active_effects.append({"type": "fucina", "extra_action": True, "completed": True})
        state.recent_events.append({
            "type": "effect", "card": "fucina",
            "player_id": player.id, "completed": True, "extra_action": True,
        })
        return {"passive": True, "extra_action": True, "completed": True}
    else:
        player.active_effects.append({"type": "fucina", "extra_action": False, "completed": False})
        state.recent_events.append({
            "type": "effect", "card": "fucina",
            "player_id": player.id, "completed": False, "extra_action": False,
        })
        return {"passive": True, "extra_action": False, "completed": False}


@register_effect("biblioteca_effect")
def biblioteca_effect(
    state: GameState,
    player: Player,
    completed: bool = False,
    discard_iid: Optional[str] = None,
    wall_bastion_side: Optional[str] = None,
    wall_card_iid: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: pesca 1 carta, poi scarta 1 carta dalla mano.
    Complete: pesca 1 carta, poi aggiungi 1 carta a un Bastione come muro.
    """
    drawn = _draw_cards(state, player, 1)
    result: dict = {"cards_drawn": drawn}

    if not completed:
        if discard_iid and discard_iid in player.hand:
            player.hand.remove(discard_iid)
            state.discard_pile.append(discard_iid)
            result["discarded"] = discard_iid
        elif player.hand:
            result["needs_discard"] = True
    else:
        if wall_card_iid and wall_card_iid in player.hand and wall_bastion_side:
            from engine.deck import make_wall_instance
            player.hand.remove(wall_card_iid)
            bastion = player.field.bastion_left if wall_bastion_side == "left" else player.field.bastion_right
            wall = make_wall_instance(wall_card_iid)
            bastion.walls.append(wall)
            result["wall_added"] = wall_card_iid
            result["bastion"] = wall_bastion_side
        else:
            result["needs_wall_choice"] = True

    state.recent_events.append({
        "type": "draw", "card": "biblioteca",
        "player_id": player.id, "completed": completed,
        "cards_drawn": drawn,
    })
    return result


@register_effect("fossato_effect")
def fossato_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    # Passivo: gestito in battle.py (blocca attacchi con GIT insufficiente)
    return {"passive": True}


@register_effect("sorgiva_effect")
def sorgiva_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """
    Base: nessun effetto.
    Complete: usato da Vitalflusso per aggiungere alle vite.
    """
    return {}


@register_effect("arena_effect")
def arena_effect(
    state: GameState,
    player: Player,
    completed: bool = False,
    own_warrior_iid: Optional[str] = None,
    target_warrior_iid: Optional[str] = None,
    target_player_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scarta un tuo Guerriero. Scarta un Guerriero avversario con almeno una Caratteristica inferiore.
    Complete (additivo &): se il bersaglio era un Eroe, scarta anche la sua Recluta e le carte assegnate.
    """
    if not own_warrior_iid:
        return {"error": "Guerriero proprio non specificato"}

    own_w = _find_warrior_in_all(player, own_warrior_iid)
    if not own_w:
        return {"error": "Guerriero proprio non trovato"}

    _discard_warrior_from_player(state, player, own_warrior_iid)
    result: dict = {"own_discarded": own_warrior_iid}

    if target_player_id and target_warrior_iid:
        target_player = state.get_player(target_player_id)
        if target_player:
            target_w = _find_warrior_in_all(target_player, target_warrior_iid)
            if target_w:
                from engine.cards import get_card, WarriorCard
                target_card = get_card(target_w.base_card_id)
                own_card = get_card(own_w.base_card_id)

                if isinstance(target_card, WarriorCard) and isinstance(own_card, WarriorCard):
                    own_stats = [own_w.effective_att(), own_w.effective_git(), own_w.effective_dif()]
                    target_stats = [target_w.effective_att(), target_w.effective_git(), target_w.effective_dif()]
                    has_lower = any(ts < os for ts, os in zip(target_stats, own_stats))
                    if has_lower:
                        target_was_hero = target_card.subtype == "hero"
                        target_assigned = list(target_w.assigned_cards)
                        target_evolved_from = target_w.evolved_from

                        _discard_warrior_from_player(state, target_player, target_warrior_iid)
                        result["target_discarded"] = target_warrior_iid

                        # Complete additivo: se Eroe, scarta anche la Recluta tornata in campo
                        if completed and target_was_hero and target_evolved_from:
                            _discard_warrior_from_player(state, target_player, target_evolved_from)
                            result["recruit_discarded"] = target_evolved_from
                            result["also_discarded"] = target_assigned
                    else:
                        result["error"] = "Il bersaglio non ha Caratteristiche inferiori"

    state.recent_events.append({
        "type": "warrior_discarded", "card": "arena",
        "player_id": player.id,
        "own_discarded": own_warrior_iid,
        "target_discarded": result.get("target_discarded"),
    })
    return result


@register_effect("scrigno_effect")
def scrigno_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """
    Passivo: quando una carta (non Scrigno) fa ottenere Mana, ottienine 1 (base) o altrettanto (complete) in più.
    Handled directly via _apply_scrigno_bonus() at each mana-gain site.
    """
    return {"passive": True, "completed": completed}


@register_effect("obelisco_effect")
def obelisco_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """
    Passivo: dopo aver usato una Magia, roll D10. Se ≥8 (base) o ≥6 (complete), la Magia torna in mano.
    Handled directly in play_spell via building check.
    """
    return {"passive": True, "threshold": 6 if completed else 8}


@register_effect("cardo_effect")
def cardo_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """
    Base: nessun effetto.
    Complete: se hai Decumano in gioco, a fine turno puoi spostare 1 Guerriero.
    Passivo - store as active_effect se completato.
    """
    if completed:
        has_decumano = any(
            b.base_card_id == "decumano"
            for b in player.field.village.buildings
        )
        player.active_effects.append({
            "type": "cardo_move",
            "has_decumano": has_decumano,
            "expires": "end_of_turn",
        })
        state.recent_events.append({
            "type": "effect", "card": "cardo",
            "player_id": player.id, "completed": True, "has_decumano": has_decumano,
        })
    return {"passive": True, "completed": completed}


@register_effect("decumano_effect")
def decumano_effect(state: GameState, player: Player, completed: bool = False, **kwargs) -> dict:
    """
    Base: se hai Cardo in gioco, puoi completarlo in qualsiasi momento senza usare Azioni.
    Complete: nessun effetto.
    Passivo.
    """
    if not completed:
        has_cardo = any(
            b.base_card_id == "cardo"
            for b in player.field.village.buildings
        )
        if has_cardo:
            player.active_effects.append({
                "type": "decumano_cardo_free",
                "expires": "permanent",
            })
            state.recent_events.append({
                "type": "effect", "card": "decumano",
                "player_id": player.id, "completed": False, "cardo_free": True,
            })
    return {"passive": True, "completed": completed}


@register_effect("trono_effect")
def trono_effect(
    state: GameState,
    player: Player,
    completed: bool = False,
    target_warrior_iid: Optional[str] = None,
    building_instance_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: assegna questa carta a un Guerriero.
    Complete: l'effetto Orda del Guerriero assegnato è sempre attivo.
    """
    if not target_warrior_iid:
        return {"error": "Guerriero bersaglio non specificato"}

    target_w = _find_warrior_in_all(player, target_warrior_iid)
    if not target_w:
        return {"error": "Guerriero bersaglio non trovato"}

    if building_instance_id and building_instance_id not in target_w.assigned_cards:
        target_w.assigned_cards.append(building_instance_id)

    result: dict = {"assigned_to": target_warrior_iid}

    if completed:
        from engine.cards import get_card, WarriorCard
        card = get_card(target_w.base_card_id)
        if isinstance(card, WarriorCard) and card.horde_effect_id:
            player.active_effects.append({
                "type": "trono_horde_active",
                "warrior_iid": target_warrior_iid,
                "horde_effect_id": card.horde_effect_id,
                "expires": "permanent",
            })
            result["horde_always_active"] = card.horde_effect_id

    state.recent_events.append({
        "type": "effect", "card": "trono",
        "player_id": player.id, "completed": completed,
        "assigned_to": target_warrior_iid,
        "horde_always_active": result.get("horde_always_active"),
    })
    return result


# ---------------------------------------------------------------------------
# EFFETTI MAGIE
# ---------------------------------------------------------------------------

@register_effect("ardolancio_effect")
def ardolancio_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    target_player_id: Optional[str] = None,
    target_bastion_side: str = "left",
    **kwargs,
) -> dict:
    """Base: scarta fino a 2 Muri casuali da un Bastione avversario. Prodigio: fino a 4."""
    target = state.get_player(target_player_id) if target_player_id else None
    if target is None or target.id == player.id:
        return {"error": "Devi scegliere un Bastione avversario"}
    bastion = target.field.bastion_left if target_bastion_side == "left" else target.field.bastion_right
    max_walls = 4 if prodigy else 2
    walls_to_remove = random.sample(bastion.walls, min(max_walls, len(bastion.walls)))
    for wall in walls_to_remove:
        bastion.walls.remove(wall)
        state.discard_pile.append(wall.instance_id)
    walls_discarded = len(walls_to_remove)
    state.recent_events.append({
        "type": "effect", "card": "ardolancio",
        "player_id": player.id, "prodigy": prodigy,
        "target_player_id": target_player_id, "target_bastion_side": target_bastion_side,
        "walls_discarded": walls_discarded,
    })
    return {"walls_discarded": walls_discarded}


@register_effect("vitalflusso_effect")
def vitalflusso_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    """
    Base: aggiungi una tua Sorgiva completa alle tue Vite (la Sorgiva stessa diventa la carta-vita).
    Prodigio (additivo &): scarta anche una Sorgiva di ogni avversario.
    """
    result: dict = {}
    sorgiva = next(
        (b for b in player.field.village.buildings if b.base_card_id == "sorgiva" and b.completed),
        None,
    )
    if sorgiva:
        player.field.village.buildings.remove(sorgiva)
        player.life_cards.append(sorgiva.instance_id)
        result["sorgiva_consumed"] = sorgiva.instance_id
        result["lives_gained"] = 1
        result["lives_now"] = player.lives
    else:
        result["no_own_sorgiva"] = True

    if prodigy:
        discarded = []
        for p in state.players:
            if p.id == player.id or not p.is_alive:
                continue
            enemy_sorgiva = next(
                (b for b in p.field.village.buildings if b.base_card_id == "sorgiva" and b.completed),
                None,
            ) or next(
                (b for b in p.field.village.buildings if b.base_card_id == "sorgiva"),
                None,
            )
            if enemy_sorgiva:
                p.field.village.buildings.remove(enemy_sorgiva)
                state.discard_pile.append(enemy_sorgiva.instance_id)
                discarded.append({"player_id": p.id, "player_name": p.name,
                                  "sorgiva": enemy_sorgiva.instance_id})
        result["enemy_sorgive_discarded"] = discarded

    state.recent_events.append({
        "type": "life_gained", "card": "vitalflusso",
        "player_id": player.id, "prodigy": prodigy,
        "lives_gained": result.get("lives_gained", 0),
        "lives_now": result.get("lives_now"),
        "enemy_sorgive_discarded": result.get("enemy_sorgive_discarded"),
    })
    return result


@register_effect("magiscudo_effect")
def magiscudo_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    **kwargs,
) -> dict:
    """
    Base: le Magie non hanno effetto su di te fino al tuo prossimo turno.
    Prodigio (additivo &): puoi giocare questa carta durante il turno di un avversario.
    """
    player.active_effects.append({
        "type": "spell_immune",
        "expires": "next_own_turn",
        "can_counter": prodigy,
    })
    state.recent_events.append({
        "type": "effect", "card": "magiscudo",
        "player_id": player.id, "prodigy": prodigy,
        "spell_immune": True, "can_counter": prodigy,
    })
    return {"spell_immune": True, "can_counter": prodigy}


@register_effect("equipotenza_effect")
def equipotenza_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    own_warrior_iid: Optional[str] = None,
    enemy_warrior_iid: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scegli un tuo Guerriero. ATT e DIF diventano pari al maggiore dei due.
    Prodigio (additivo &): scegli un Guerriero (qualsiasi). ATT e DIF diventano pari al minore.
    """
    result: dict = {}

    if own_warrior_iid:
        own_w = _find_warrior_in_all(player, own_warrior_iid)
        if own_w:
            high = max(own_w.effective_att(), own_w.effective_dif())
            base_att = own_w.base_card_id and __import__("engine.cards", fromlist=["CARD_REGISTRY"]).CARD_REGISTRY.get(own_w.base_card_id)
            from engine.cards import CARD_REGISTRY
            base_card = CARD_REGISTRY.get(own_w.base_card_id)
            if base_card:
                own_w.temp_modifiers["att"] = high - base_card.att
                own_w.temp_modifiers["dif"] = high - base_card.dif
                player.active_effects.append({
                    "type": "equipotenza_own",
                    "warrior_iid": own_warrior_iid,
                    "att_was": own_w.temp_modifiers.get("att", 0),
                    "dif_was": own_w.temp_modifiers.get("dif", 0),
                    "expires": "start_of_next_own_turn",
                })
                result["own_equalized"] = {"warrior": own_warrior_iid, "value": high}

    if prodigy and enemy_warrior_iid:
        for p in state.players:
            enemy_w = _find_warrior_in_all(p, enemy_warrior_iid)
            if enemy_w:
                low = min(enemy_w.effective_att(), enemy_w.effective_dif())
                from engine.cards import CARD_REGISTRY
                base_card = CARD_REGISTRY.get(enemy_w.base_card_id)
                if base_card:
                    enemy_w.temp_modifiers["att"] = low - base_card.att
                    enemy_w.temp_modifiers["dif"] = low - base_card.dif
                    result["enemy_equalized"] = {"warrior": enemy_warrior_iid, "player": p.id, "value": low}
                break

    state.recent_events.append({
        "type": "effect", "card": "equipotenza",
        "player_id": player.id, "prodigy": prodigy,
        "own_equalized": result.get("own_equalized"),
        "enemy_equalized": result.get("enemy_equalized"),
    })
    return result


@register_effect("regicidio_effect")
def regicidio_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    target_player_id: Optional[str] = None,
    target_trono_iid: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scarta un Trono (da qualsiasi campo).
    Prodigio (additivo &): scarta anche il Guerriero a cui era assegnato.
    """
    target = state.get_player(target_player_id) if target_player_id else None
    if target is None:
        for p in state.players:
            trono = next(
                (b for b in p.field.village.buildings if b.base_card_id == "trono"),
                None,
            )
            if trono:
                target = p
                break

    if target is None:
        return {"error": "Nessun Trono trovato"}

    trono = None
    if target_trono_iid:
        trono = next(
            (b for b in target.field.village.buildings
             if b.base_card_id == "trono" and b.instance_id == target_trono_iid),
            None,
        )
    else:
        trono = next(
            (b for b in target.field.village.buildings if b.base_card_id == "trono"),
            None,
        )

    if trono is None:
        return {"error": "Trono non trovato"}

    assigned_warrior_iid = None
    assigned_warrior_player = None
    for p in state.players:
        for w in p.all_warriors():
            if trono.instance_id in w.assigned_cards:
                assigned_warrior_iid = w.instance_id
                assigned_warrior_player = p
                w.assigned_cards.remove(trono.instance_id)
                break
        if assigned_warrior_iid:
            break

    target.field.village.buildings.remove(trono)
    state.discard_pile.append(trono.instance_id)
    result: dict = {"trono_discarded": trono.instance_id, "from_player": target.id}

    if prodigy and assigned_warrior_iid and assigned_warrior_player:
        _discard_warrior_from_player(state, assigned_warrior_player, assigned_warrior_iid)
        result["warrior_discarded"] = assigned_warrior_iid
        result["warrior_player"] = assigned_warrior_player.id

    state.recent_events.append({
        "type": "discard", "card": "regicidio",
        "player_id": player.id, "prodigy": prodigy,
        "trono_discarded": trono.instance_id,
        "from_player": target.id,
        "warrior_discarded": result.get("warrior_discarded"),
    })
    return result


@register_effect("agilpesca_effect")
def agilpesca_effect(state: GameState, player: Player, prodigy: bool = False, discard_iid: Optional[str] = None, **kwargs) -> dict:
    """
    Base: pesca 1 carta. Ottieni 1 Azione aggiuntiva.
    Prodigio (additivo &): pesca anche 1 carta e scarta 1 carta.
    """
    drawn = _draw_cards(state, player, 1)
    player.actions_remaining += 1
    result: dict = {"cards_drawn": drawn, "extra_action": 1}

    if prodigy:
        extra_drawn = _draw_cards(state, player, 1)
        result["extra_drawn"] = extra_drawn
        if discard_iid and discard_iid in player.hand:
            player.hand.remove(discard_iid)
            state.discard_pile.append(discard_iid)
            result["discarded"] = discard_iid
        else:
            result["needs_discard"] = True

    state.recent_events.append({
        "type": "draw", "card": "agilpesca",
        "player_id": player.id, "prodigy": prodigy,
        "cards_drawn": drawn, "extra_action": 1,
    })
    return result


@register_effect("guerremoto_effect")
def guerremoto_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    **kwargs,
) -> dict:
    """
    Base: questo turno la Battaglia può essere giocata contro qualsiasi Bastione.
    Prodigio (additivo &): aggiungi +2 al risultato dei Danni.
    """
    damage_bonus = 2 if prodigy else 0
    player.active_effects.append({
        "type": "guerremoto",
        "any_target": True,
        "damage_bonus": damage_bonus,
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "effect", "card": "guerremoto",
        "player_id": player.id, "prodigy": prodigy,
        "any_target": True, "damage_bonus": damage_bonus,
    })
    return {"any_target": True, "damage_bonus": damage_bonus}


@register_effect("arrampicarta_effect")
def arrampicarta_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    wall_instance_id: Optional[str] = None,
    warrior_iid: Optional[str] = None,
    bastion_side: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scegli un tuo Muro e assegnalo a un Guerriero. Quella carta ottiene +1 GIT.
    Prodigio (additivo &): per ogni avversario, rimuovi un Muro assegnato a un suo Guerriero.
    """
    result: dict = {}

    if wall_instance_id and warrior_iid:
        wall = None
        if bastion_side:
            bastion = player.field.bastion_left if bastion_side == "left" else player.field.bastion_right
            for w_wall in bastion.walls:
                if w_wall.instance_id == wall_instance_id:
                    wall = w_wall
                    bastion.walls.remove(w_wall)
                    break
        else:
            for side_name in ["left", "right"]:
                bastion = player.field.bastion_left if side_name == "left" else player.field.bastion_right
                for w_wall in bastion.walls:
                    if w_wall.instance_id == wall_instance_id:
                        wall = w_wall
                        bastion.walls.remove(w_wall)
                        break
                if wall:
                    break

        if wall:
            target_w = _find_warrior_in_all(player, warrior_iid)
            if target_w:
                target_w.assigned_cards.append(wall.instance_id)
                target_w.temp_modifiers["git"] = target_w.temp_modifiers.get("git", 0) + 1
                result["wall_assigned"] = wall.instance_id
                result["warrior"] = warrior_iid
                result["git_bonus"] = 1
            else:
                if bastion_side:
                    bastion = player.field.bastion_left if bastion_side == "left" else player.field.bastion_right
                    bastion.walls.append(wall)
                result["error"] = "Guerriero non trovato"
        else:
            result["error"] = "Muro non trovato"
    else:
        result["needs_selection"] = True

    if prodigy:
        removed = []
        for p in state.players:
            if p.id == player.id or not p.is_alive:
                continue
            for w in p.all_warriors():
                if w.assigned_cards:
                    removed_card = w.assigned_cards.pop(0)
                    if w.temp_modifiers.get("git", 0) > 0:
                        w.temp_modifiers["git"] -= 1
                    state.discard_pile.append(removed_card)
                    removed.append({"player": p.id, "warrior": w.instance_id, "card": removed_card})
                    break
        result["enemy_assigned_removed"] = removed

    state.recent_events.append({
        "type": "wall_moved", "card": "arrampicarta",
        "player_id": player.id, "prodigy": prodigy,
        "wall_assigned": result.get("wall_assigned"),
        "warrior": result.get("warrior"),
        "git_bonus": result.get("git_bonus"),
        "enemy_assigned_removed": result.get("enemy_assigned_removed"),
    })
    return result


@register_effect("investimento_effect")
def investimento_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    """
    Base: ottieni 2 Mana.
    Prodigio (additivo &): il prossimo turno ottieni anche 2 Mana aggiuntivi.
    """
    player.mana_remaining += 2
    bonus = _apply_scrigno_bonus(player, 2)
    total = 2 + bonus
    state.recent_events.append({
        "type": "mana", "card": "investimento",
        "player_id": player.id, "prodigy": prodigy,
        "mana_gained": total,
    })
    result: dict = {"mana_gained": total}

    if prodigy:
        player.active_effects.append({
            "type": "investimento_deferred",
            "mana": 2,
            "expires": "start_of_next_own_turn",
        })
        result["deferred_mana"] = 2

    return result


@register_effect("cuordipietra_effect")
def cuordipietra_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    target_player_id: Optional[str] = None,
    target_warrior_iid: Optional[str] = None,
    dest_bastion_side: str = "left",
    **kwargs,
) -> dict:
    """
    Base: scegli una Recluta avversaria e aggiungila a un suo Bastione.
    Prodigio (sostituisce): scegli qualsiasi Guerriero avversario e aggiungilo a un tuo Bastione.
    """
    target = state.get_player(target_player_id) if target_player_id else None
    if target is None:
        return {"error": "Bersaglio non valido"}

    if not target_warrior_iid:
        return {"error": "Guerriero bersaglio non specificato"}

    warrior_to_move = None
    source_region = None

    regions = [
        ("vanguard", target.field.vanguard),
        ("bastion_left", target.field.bastion_left.warriors),
        ("bastion_right", target.field.bastion_right.warriors),
    ]
    for region_name, region_list in regions:
        for w in region_list:
            if w.instance_id == target_warrior_iid:
                warrior_to_move = w
                source_region = (region_name, region_list)
                break
        if warrior_to_move:
            break

    if not warrior_to_move:
        return {"error": "Guerriero non trovato"}

    if not prodigy:
        from engine.cards import get_card, WarriorCard
        card = get_card(warrior_to_move.base_card_id)
        if not isinstance(card, WarriorCard) or card.subtype != "recruit":
            return {"error": "Con Cuordipietra base puoi spostare solo Reclute"}

    source_region[1].remove(warrior_to_move)

    if prodigy:
        dest_bastion = player.field.bastion_left if dest_bastion_side == "left" else player.field.bastion_right
        dest_bastion.warriors.append(warrior_to_move)
        result = {"warrior_moved": warrior_to_move.instance_id, "to": f"my_{dest_bastion_side}", "from_player": target.id}
    else:
        dest_bastion = target.field.bastion_left if dest_bastion_side == "left" else target.field.bastion_right
        dest_bastion.warriors.append(warrior_to_move)
        result = {"warrior_moved": warrior_to_move.instance_id, "to": f"enemy_{dest_bastion_side}", "from_player": target.id}

    state.recent_events.append({
        "type": "warrior_moved", "card": "cuordipietra",
        "player_id": player.id, "prodigy": prodigy,
        "warrior_moved": warrior_to_move.instance_id,
        "from_player": target.id, "to": result["to"],
    })
    return result


@register_effect("bastioncontrario_effect")
def bastioncontrario_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    player1_id: Optional[str] = None,
    side1: str = "left",
    player2_id: Optional[str] = None,
    side2: str = "right",
    **kwargs,
) -> dict:
    """
    Base: scambia due Bastioni dello stesso giocatore.
    Prodigio (sostituisce): scambia due Bastioni (anche di giocatori diversi).
    """
    if not prodigy:
        target_player = state.get_player(player1_id) if player1_id else player
        if target_player is None:
            target_player = player
        bl = target_player.field.bastion_left
        br = target_player.field.bastion_right
        target_player.field.bastion_left = br
        target_player.field.bastion_right = bl
        state.recent_events.append({
            "type": "effect", "card": "bastioncontrario",
            "player_id": player.id, "prodigy": prodigy,
            "swapped_player": target_player.id, "sides": ["left", "right"],
        })
        return {"swapped": target_player.id, "sides": ["left", "right"]}
    else:
        p1 = state.get_player(player1_id) if player1_id else player
        p2 = state.get_player(player2_id) if player2_id else player
        if p1 is None or p2 is None:
            return {"error": "Giocatori non validi"}

        def get_bastion(p, side):
            return p.field.bastion_left if side == "left" else p.field.bastion_right

        def set_bastion(p, side, bastion):
            if side == "left":
                p.field.bastion_left = bastion
            else:
                p.field.bastion_right = bastion

        b1 = get_bastion(p1, side1)
        b2 = get_bastion(p2, side2)
        set_bastion(p1, side1, b2)
        set_bastion(p2, side2, b1)
        state.recent_events.append({
            "type": "effect", "card": "bastioncontrario",
            "player_id": player.id, "prodigy": prodigy,
            "swapped": [(player1_id, side1), (player2_id, side2)],
        })
        return {"swapped": [(player1_id, side1), (player2_id, side2)]}


@register_effect("divinazione_effect")
def divinazione_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    **kwargs,
) -> dict:
    """
    Base: il prossimo turno ottieni +1 Mana per ogni tua Maga di Scuola Incantesimo.
    Prodigio (sostituisce): il prossimo turno ottieni +1 Mana per ogni tua Maga.
    Deferred effect.
    """
    effect_type = "divinazione_all_mage" if prodigy else "divinazione_incantesimo"
    player.active_effects.append({
        "type": effect_type,
        "expires": "start_of_next_own_turn",
    })
    state.recent_events.append({
        "type": "effect", "card": "divinazione",
        "player_id": player.id, "prodigy": prodigy,
        "deferred_effect": effect_type,
    })
    return {"deferred_effect": effect_type}


@register_effect("malcomune_effect")
def malcomune_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    own_warrior_iid: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scarta un tuo Guerriero. Ogni avversario scarta un Guerriero della stessa Specie.
    Prodigio (sostituisce): scegli un tuo Guerriero; ogni avversario scarta un Guerriero della stessa Specie (tu tieni il tuo).
    """
    from engine.cards import get_card, WarriorCard

    if not own_warrior_iid:
        warriors = player.all_warriors()
        if not warriors:
            return {"error": "Nessun Guerriero in campo"}
        own_warrior_iid = warriors[0].instance_id

    own_w = _find_warrior_in_all(player, own_warrior_iid)
    if not own_w:
        return {"error": "Guerriero non trovato"}

    own_card = get_card(own_w.base_card_id)
    if not isinstance(own_card, WarriorCard):
        return {"error": "Carta non valida"}

    species = own_card.species
    result: dict = {"species": species}

    if not prodigy:
        _discard_warrior_from_player(state, player, own_warrior_iid)
        result["own_discarded"] = own_warrior_iid

    enemies_discarded = []
    for p in state.players:
        if p.id == player.id or not p.is_alive:
            continue
        for w in p.all_warriors():
            card = get_card(w.base_card_id)
            if isinstance(card, WarriorCard) and card.species == species:
                _discard_warrior_from_player(state, p, w.instance_id)
                enemies_discarded.append({"player": p.id, "warrior": w.instance_id})
                break
    result["enemies_discarded"] = enemies_discarded

    state.recent_events.append({
        "type": "warrior_discarded", "card": "malcomune",
        "player_id": player.id, "prodigy": prodigy,
        "species": species,
        "own_discarded": result.get("own_discarded"),
        "enemies_discarded": enemies_discarded,
    })
    return result


@register_effect("telecinesi_effect")
def telecinesi_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    source_player_id: Optional[str] = None,
    source_side: str = "left",
    dest_player_id: Optional[str] = None,
    dest_side: str = "right",
    count: int = 3,
    **kwargs,
) -> dict:
    """
    Base: sposta fino a 3 Muri da un tuo Bastione all'altro.
    Prodigio (sostituisce): sposta fino a 3 Muri da un Bastione a uno adiacente (qualsiasi giocatore).
    """
    if not prodigy:
        src = player.field.bastion_left if source_side == "left" else player.field.bastion_right
        dst = player.field.bastion_left if dest_side == "left" else player.field.bastion_right
        if src is dst:
            return {"error": "Bastioni uguali"}
        moved = []
        for _ in range(min(count, len(src.walls))):
            if src.walls:
                wall = src.walls.pop(0)
                dst.walls.append(wall)
                moved.append(wall.instance_id)
        state.recent_events.append({
            "type": "wall_moved", "card": "telecinesi",
            "player_id": player.id, "prodigy": prodigy,
            "moved_walls": moved, "from": source_side, "to": dest_side,
        })
        return {"moved_walls": moved, "from": source_side, "to": dest_side}
    else:
        source_player = state.get_player(source_player_id) if source_player_id else player
        if source_player is None:
            source_player = player
        dest_player = state.get_player(dest_player_id) if dest_player_id else source_player
        if dest_player is None:
            dest_player = source_player
        src = source_player.field.bastion_left if source_side == "left" else source_player.field.bastion_right
        dst = dest_player.field.bastion_left if dest_side == "left" else dest_player.field.bastion_right
        if src is dst:
            return {"error": "Bastioni uguali"}
        moved = []
        for _ in range(min(count, len(src.walls))):
            if src.walls:
                wall = src.walls.pop(0)
                dst.walls.append(wall)
                moved.append(wall.instance_id)
        state.recent_events.append({
            "type": "wall_moved", "card": "telecinesi",
            "player_id": player.id, "prodigy": prodigy,
            "moved_walls": moved,
            "from_player": source_player.id, "from": source_side,
            "to_player": dest_player.id, "to": dest_side,
        })
        return {
            "moved_walls": moved,
            "from_player": source_player.id, "from": source_side,
            "to_player": dest_player.id, "to": dest_side,
        }


@register_effect("cercapersone_effect")
def cercapersone_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    **kwargs,
) -> dict:
    """
    Base: il giocatore sceglie una Recluta dal mazzo e la aggiunge alla mano.
    Prodigio (sostituisce): il giocatore sceglie una Recluta e la gioca immediatamente senza costo.
    """
    state.pending_search = {
        "player_id": player.id,
        "context": "cercapersone_prodigio" if prodigy else "cercapersone_base",
        "condition": {"type": "subtype", "value": "recruit"},
    }
    state.recent_events.append({
        "type": "search", "card": "cercapersone",
        "player_id": player.id, "prodigy": prodigy,
        "search_pending": True,
    })
    return {"search_pending": True, "prodigy": prodigy}


@register_effect("incendifesa_effect")
def incendifesa_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    target_player_id: Optional[str] = None,
    target_bastion_side: str = "left",
    **kwargs,
) -> dict:
    """
    Base: danni a un Bastione pari al numero di Guerrieri presso di esso.
    Prodigio (sostituisce): danni pari al totale dei Guerrieri in tutti i Bastioni dell'avversario.
    """
    from engine.battle import apply_damage_to_bastion
    target = state.get_player(target_player_id) if target_player_id else None
    if target is None:
        return {"error": "Bersaglio non valido"}

    if prodigy:
        damage = (
            len(target.field.bastion_left.warriors) +
            len(target.field.bastion_right.warriors)
        )
    else:
        if target_bastion_side == "left":
            damage = len(target.field.bastion_left.warriors)
        else:
            damage = len(target.field.bastion_right.warriors)

    result = apply_damage_to_bastion(state, target, target_bastion_side, damage)
    state.recent_events.append({
        "type": "damage", "card": "incendifesa",
        "player_id": player.id, "prodigy": prodigy,
        "target_player_id": target_player_id, "target_bastion_side": target_bastion_side,
        "damage": damage, **result,
    })
    return {"damage": damage, **result}


@register_effect("dazipazzi_effect")
def dazipazzi_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    **kwargs,
) -> dict:
    """
    Base: riporta allo stato incompleto tutti gli Scrigni avversari.
    Prodigio (additivo &): anche tutti gli Estrattori avversari.
    """
    affected = []
    for p in state.players:
        if p.id == player.id or not p.is_alive:
            continue
        for b in p.field.village.buildings:
            if b.base_card_id == "scrigno" and b.completed:
                b.completed = False
                affected.append({"player": p.id, "building": b.instance_id, "type": "scrigno"})
            if prodigy and b.base_card_id == "estrattore" and b.completed:
                b.completed = False
                affected.append({"player": p.id, "building": b.instance_id, "type": "estrattore"})
    state.recent_events.append({
        "type": "effect", "card": "dazipazzi",
        "player_id": player.id, "prodigy": prodigy,
        "reset_buildings": affected,
    })
    return {"reset_buildings": affected}


@register_effect("plasmattone_effect")
def plasmattone_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    bastion_side: str = "left",
    wall_instance_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scegli un Bastione, prendi un Muro casuale da esso.
    Prodigio (sostituisce): scegli un Bastione, poi scegli quale Muro specifico prendere.
    """
    src = player.field.bastion_left if bastion_side == "left" else player.field.bastion_right
    if not src.walls:
        return {"error": "Nessun Muro nel Bastione"}

    wall = None
    if prodigy and wall_instance_id:
        for w in src.walls:
            if w.instance_id == wall_instance_id:
                wall = w
                src.walls.remove(w)
                break
        if wall is None:
            return {"error": "Muro non trovato"}
    else:
        import random as _random
        wall = _random.choice(src.walls)
        src.walls.remove(wall)

    player.hand.append(wall.instance_id)
    state.recent_events.append({
        "type": "wall_taken", "card": "plasmattone",
        "player_id": player.id, "prodigy": prodigy,
        "wall_taken": wall.instance_id, "from_bastion": bastion_side,
    })
    return {"wall_taken": wall.instance_id, "from_bastion": bastion_side}


@register_effect("cambiamente_effect")
def cambiamente_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    target_player_id: Optional[str] = None,
    target_warrior_iid: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scegli un Guerriero avversario e scartalo.
    Prodigio (sostituisce): scegli un Guerriero avversario e aggiungilo alla tua mano.
    """
    target = state.get_player(target_player_id) if target_player_id else None
    if target is None:
        return {"error": "Bersaglio non valido"}

    if not target_warrior_iid:
        warriors = target.all_warriors()
        if not warriors:
            return {"error": "Nessun Guerriero bersaglio"}
        target_warrior_iid = warriors[0].instance_id

    target_w = _find_warrior_in_all(target, target_warrior_iid)
    if not target_w:
        return {"error": "Guerriero non trovato"}

    _discard_warrior_from_player(state, target, target_warrior_iid)
    if target_warrior_iid in state.discard_pile:
        state.discard_pile.remove(target_warrior_iid)

    if prodigy:
        player.hand.append(target_warrior_iid)
        state.recent_events.append({
            "type": "warrior_moved", "card": "cambiamente",
            "player_id": player.id, "prodigy": prodigy,
            "warrior_taken": target_warrior_iid, "from_player": target.id,
        })
        return {"warrior_taken": target_warrior_iid, "from_player": target.id}
    else:
        state.discard_pile.append(target_warrior_iid)
        state.recent_events.append({
            "type": "warrior_discarded", "card": "cambiamente",
            "player_id": player.id, "prodigy": prodigy,
            "warrior_discarded": target_warrior_iid, "from_player": target.id,
        })
        return {"warrior_discarded": target_warrior_iid, "from_player": target.id}


@register_effect("velocemento_effect")
def velocemento_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    **kwargs,
) -> dict:
    """
    Base: elenca le Costruzioni in mano; il giocatore ne sceglie una che diventa Eterea.
    Prodigio (additivo &): TBD.
    """
    from engine.deck import get_base_card_id
    from engine.cards import get_card, BuildingCard

    building_iids = []
    for iid in player.hand:
        base_id = get_base_card_id(iid)
        try:
            card = get_card(base_id)
            if isinstance(card, BuildingCard):
                building_iids.append(iid)
        except KeyError:
            continue

    if not building_iids:
        return {"error": "Nessuna Costruzione in mano"}  # non dovrebbe mai arrivare qui (pre-validato in actions.py)

    player.pending_velocemento_buildings = building_iids
    if prodigy:
        player.pending_velocemento_prodigy = True
    state.recent_events.append({
        "type": "ethereal", "card": "velocemento",
        "player_id": player.id, "prodigy": prodigy,
        "available_buildings": building_iids, "requires_choice": True,
    })
    return {"available_buildings": building_iids, "requires_choice": True}


@register_effect("plasmarmo_effect")
def plasmarmo_effect(
    state: GameState,
    player: Player,
    prodigy: bool = False,
    bastion_side: str = "left",
    wall_instance_id: Optional[str] = None,
    **kwargs,
) -> dict:
    """
    Base: scegli un Bastione, poi scegli quale Muro specifico prendere.
    Prodigio (additivo &): la carta scelta diventa Eterea — giocabile senza costo né azione.
    """
    src = player.field.bastion_left if bastion_side == "left" else player.field.bastion_right
    if not src.walls:
        return {"error": "Nessun Muro nel Bastione"}

    wall = None
    if wall_instance_id:
        for w in src.walls:
            if w.instance_id == wall_instance_id:
                wall = w
                src.walls.remove(w)
                break
    else:
        wall = src.walls.pop(0)

    if wall is None:
        return {"error": "Muro non trovato"}

    player.hand.append(wall.instance_id)
    result: dict = {"wall_taken": wall.instance_id, "from_bastion": bastion_side}

    if prodigy:
        player.ethereal_card = wall.instance_id
        result["ethereal"] = wall.instance_id

    state.recent_events.append({
        "type": "wall_taken", "card": "plasmarmo",
        "player_id": player.id, "prodigy": prodigy,
        "wall_taken": wall.instance_id, "from_bastion": bastion_side,
        "ethereal": result.get("ethereal"),
    })
    return result


# ---------------------------------------------------------------------------
# EFFETTI ORDA
# ---------------------------------------------------------------------------

@register_effect("patrizio_horde")
def patrizio_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Questa carta ottiene +2 GIT fino al prossimo turno del giocatore."""
    w = _find_warrior(player, warrior_iid)
    if w:
        w.temp_modifiers["git"] = w.temp_modifiers.get("git", 0) + 2
        player.active_effects.append({"type": "horde_stat_bonus", "warrior_iid": w.instance_id, "git": 2})
        state.recent_events.append({
            "type": "horde", "card": "patrizio",
            "player_id": player.id, "target": w.instance_id, "git_bonus": 2,
        })
        return {"target": w.instance_id, "git_bonus": 2}
    return {}


@register_effect("reinhold_horde")
def reinhold_horde(state: GameState, player: Player, **kwargs) -> dict:
    """Il costo per completare le Sorgive è ridotto di 2 questo turno."""
    player.active_effects.append({
        "type": "reinhold_sorgiva_discount",
        "discount": 2,
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "reinhold",
        "player_id": player.id, "sorgiva_completion_discount": 2,
    })
    return {"sorgiva_completion_discount": 2}


@register_effect("araminta_horde")
def araminta_horde(state: GameState, player: Player, **kwargs) -> dict:
    """Gli Anatemi a costo 1 che giochi ti ritornano in mano questo turno."""
    player.active_effects.append({
        "type": "araminta_spell_return",
        "school": "anatema",
        "cost": 1,
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "araminta",
        "player_id": player.id, "spell_return": "anatema", "cost": 1,
    })
    return {"spell_return": "anatema", "cost": 1}


@register_effect("orfeo_horde")
def orfeo_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Questa carta ottiene +1 ATT e +1 DIF fino al prossimo turno del giocatore."""
    w = _find_warrior(player, warrior_iid)
    if w:
        w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) + 1
        w.temp_modifiers["dif"] = w.temp_modifiers.get("dif", 0) + 1
        player.active_effects.append({"type": "horde_stat_bonus", "warrior_iid": w.instance_id, "att": 1, "dif": 1})
        state.recent_events.append({
            "type": "horde", "card": "orfeo",
            "player_id": player.id, "target": w.instance_id, "att_bonus": 1, "dif_bonus": 1,
        })
        return {"target": w.instance_id, "att_bonus": 1, "dif_bonus": 1}
    return {}


@register_effect("giulio_horde")
def giulio_horde(state: GameState, player: Player, **kwargs) -> dict:
    """Il giocatore cerca Giulio II nel mazzo e lo aggiunge alla mano."""
    state.pending_search = {
        "player_id": player.id,
        "context": "giulio_horde",
        "condition": {"type": "base_card_id", "value": "giulio_ii"},
    }
    state.recent_events.append({
        "type": "search", "card": "giulio",
        "player_id": player.id, "search_pending": True,
    })
    return {"search_pending": True}


@register_effect("faust_horde")
def faust_horde(state: GameState, player: Player, **kwargs) -> dict:
    """Le Biblioteche avversarie non hanno effetto fino al prossimo turno del giocatore."""
    player.active_effects.append({
        "type": "faust_biblioteca_suppress",
        "expires": "next_own_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "faust",
        "player_id": player.id, "opponent_biblioteche_suppressed": True,
    })
    return {"opponent_biblioteche_suppressed": True}


@register_effect("evelyn_horde")
def evelyn_horde(state: GameState, player: Player, **kwargs) -> dict:
    """I Sortilegi a costo 1 che giochi questo turno vengono giocati una seconda volta."""
    player.active_effects.append({
        "type": "evelyn_spell_double",
        "school": "sortilegio",
        "cost": 1,
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "evelyn",
        "player_id": player.id, "spell_double": "sortilegio", "cost": 1,
    })
    return {"spell_double": "sortilegio", "cost": 1}


@register_effect("polemarco_horde")
def polemarco_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Questa carta (polemarco) ottiene +1 ATT per ogni Umano in campo."""
    from engine.cards import get_card, WarriorCard

    umani = sum(
        1 for w in player.all_warriors()
        if isinstance(get_card(w.base_card_id), WarriorCard)
        and getattr(get_card(w.base_card_id), "species", None) == "umano"
    )

    w = _find_warrior(player, warrior_iid)
    if w:
        w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) + umani
        player.active_effects.append({"type": "horde_stat_bonus", "warrior_iid": w.instance_id, "att": umani})
        state.recent_events.append({
            "type": "horde", "card": "polemarco",
            "player_id": player.id, "target": w.instance_id,
            "att_bonus": umani, "umani_count": umani,
        })
        return {"target": w.instance_id, "att_bonus": umani, "umani_count": umani}
    state.recent_events.append({
        "type": "horde", "card": "polemarco",
        "player_id": player.id, "umani_count": umani,
    })
    return {"umani_count": umani}


@register_effect("decimo_horde")
def decimo_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Se attacchi un avversario con un Fossato, raddoppia la GIT di quest'Orda per quella battaglia."""
    player.active_effects.append({
        "type": "decimo_anti_fossato",
        "warrior_iid": warrior_iid,
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "decimo",
        "player_id": player.id, "decimo_anti_fossato": True, "warrior": warrior_iid,
    })
    return {"decimo_anti_fossato": True, "warrior": warrior_iid}


@register_effect("joseph_horde")
def joseph_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Se questa carta ha un Trono assegnato, gli avversari non possono avere o giocare Troni. Scartali."""
    w = _find_warrior(player, warrior_iid)
    has_trono = False
    if w:
        from engine.deck import get_base_card_id
        for card_iid in w.assigned_cards:
            base_id = get_base_card_id(card_iid)
            if base_id == "trono":
                has_trono = True
                break

    if has_trono:
        player.active_effects.append({
            "type": "joseph_no_troni",
            "expires": "permanent",
        })
        discarded = []
        for p in state.players:
            if p.id == player.id:
                continue
            to_remove = [b for b in p.field.village.buildings if b.base_card_id == "trono"]
            for b in to_remove:
                p.field.village.buildings.remove(b)
                state.discard_pile.append(b.instance_id)
                discarded.append({"player": p.id, "trono": b.instance_id})
        state.recent_events.append({
            "type": "horde", "card": "joseph",
            "player_id": player.id, "has_trono": True,
            "enemy_troni_discarded": discarded,
        })
        return {"has_trono": True, "enemy_troni_discarded": discarded}

    state.recent_events.append({
        "type": "horde", "card": "joseph",
        "player_id": player.id, "has_trono": False,
    })
    return {"has_trono": False}


@register_effect("madeleine_horde")
def madeleine_horde(state: GameState, player: Player, **kwargs) -> dict:
    """I Prodigi dei tuoi Incantesimi si attivano indipendentemente dalla Scuola delle Maghe."""
    player.active_effects.append({
        "type": "madeleine_prodigy_any_school",
        "school": "incantesimo",
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "madeleine",
        "player_id": player.id, "incantesimo_prodigy_any_school": True,
    })
    return {"incantesimo_prodigy_any_school": True}


@register_effect("eracle_horde")
def eracle_horde(state: GameState, player: Player, **kwargs) -> dict:
    """Se vinci una battaglia con almeno 3 Danni, puoi distruggere una Costruzione del difensore."""
    player.active_effects.append({
        "type": "eracle_destroy_building",
        "min_damage": 3,
        "expires": "end_of_turn",
    })
    state.recent_events.append({
        "type": "horde", "card": "eracle",
        "player_id": player.id, "eracle_destroy_on_win": True, "min_damage": 3,
    })
    return {"eracle_destroy_on_win": True, "min_damage": 3}
