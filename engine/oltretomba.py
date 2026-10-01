"""
Espansione Oltretomba: effetti delle carte e aggancio al motore di gioco.

Il mazzo Oltretomba (data/cards_oltretomba.json) si gioca con le stesse regole
del mazzo base. Qui vivono i suoi effetti, registrati in EFFECT_REGISTRY come
quelli base, e le funzioni che il motore chiama nei momenti in cui una carta
del mazzo può intervenire: inizio e fine turno, Guerriero scartato, Battaglia,
Magia giocata, evoluzione, ricerche. Ognuna controlla da sé se la carta
interessata è in gioco, quindi in una partita col mazzo base non fa nulla.

Parola chiave del mazzo — riesumare: cercare una carta nella pila degli scarti
invece che nel mazzo (state.pending_search con source="discard"). Gli scarti
non si mescolano dopo aver riesumato: l'ordine conta ("la carta in cima agli
scarti" di Ossario e Pietrombale).

Gli effetti che durano "fino al tuo prossimo turno" vanno in active_effects di
chi li ha generati con expires=TURN_START e li chiude on_turn_start; quelli
"next_own_turn" e "end_of_turn" seguono le scadenze del motore base.
"""

from __future__ import annotations
import random
from typing import Dict, List, Optional, Tuple

from engine.cards import CARD_REGISTRY, get_card, WarriorCard, SpellCard
from engine.deck import (
    get_base_card_id,
    make_wall_instance,
    make_warrior_instance,
    queue_search,
)
from engine.effects import (
    register_effect,
    _apply_scrigno_bonus,
    _discard_warrior_from_player,
    _draw_cards,
    _find_warrior,
    _find_warrior_in_all,
    _is_spell_immune,
    _unassign_building,
)
from engine.models import BuildingInstance, GameState, Player, WarriorInstance

DECK_ID = "oltretomba"

# Scadenza degli effetti che si chiudono all'inizio del prossimo turno di chi li ha generati
TURN_START = "oltretomba_turn_start"

# Contesti di state.pending_search completati da resolve_search()
SEARCH_CONTEXTS = {"riesuma", "riesuma_eterea", "rinascimento", "lumicino"}

_REGIONS = ("vanguard", "bastion_left", "bastion_right")


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _name(base_or_iid: str) -> str:
    card = CARD_REGISTRY.get(get_base_card_id(base_or_iid)) or CARD_REGISTRY.get(base_or_iid)
    return card.name if card else base_or_iid


def _bastion(player: Player, side: str):
    return player.field.bastion_left if side == "left" else player.field.bastion_right


def weakest_bastion_side(player: Player) -> str:
    """"Il tuo Bastione con meno Muri" (a parità, il sinistro)."""
    left = len(player.field.bastion_left.walls)
    right = len(player.field.bastion_right.walls)
    return "left" if left <= right else "right"


def _side_label(side: str) -> str:
    return "sinistro" if side == "left" else "destro"


def _buildings(player: Player, base_id: str) -> List[BuildingInstance]:
    return [b for b in player.field.village.buildings if b.base_card_id == base_id]


def _effects(player: Player, etype: str) -> List[dict]:
    return [e for e in player.active_effects if e.get("type") == etype]


def _opponents(state: GameState, player: Player) -> List[Player]:
    return [p for p in state.players if p.id != player.id and p.is_alive]


def _event(state: GameState, player: Player, card: str, text: str, etype: str = "effect", **extra) -> None:
    """Evento per il log dei client: `text` è già il messaggio da mostrare."""
    state.recent_events.append({"type": etype, "card": card, "player_id": player.id, "text": text, **extra})


def _roll(state: GameState, player: Player, card: str, threshold: int, success: str, failure: str) -> bool:
    roll = random.randint(1, 10)
    ok = roll >= threshold
    _event(state, player, card, f"{_name(card)}: D10={roll} — {success if ok else failure}", "d10",
           roll=roll, threshold=threshold, triggered=ok)
    return ok


def _gain_mana(state: GameState, player: Player, amount: int, card: str, label: str) -> int:
    if amount <= 0:
        return 0
    player.mana_remaining += amount
    total = amount + _apply_scrigno_bonus(player, amount)
    _event(state, player, card, f"{label}: +{total} Mana", "mana", mana_gained=total)
    return total


def _bank(player: Player, etype: str, amount: int) -> None:
    """Accumula un valore da incassare a inizio del prossimo turno (Campana, Clessidra)."""
    for eff in player.active_effects:
        if eff.get("type") == etype and eff.get("expires") == TURN_START:
            eff["count"] = eff.get("count", 0) + amount
            return
    player.active_effects.append({"type": etype, "count": amount, "expires": TURN_START})


def _matches_warrior(w: WarriorInstance, iid: Optional[str]) -> bool:
    """Un riferimento a un Guerriero vale anche per l'Eroe in cui si è evoluto."""
    return iid is not None and (w.instance_id == iid or w.evolved_from == iid)


def _discard_top_to_walls(state: GameState, player: Player, side: str, count: int) -> List[str]:
    """Le `count` carte in cima agli scarti diventano Muri del Bastione `side`."""
    moved = []
    bastion = _bastion(player, side)
    for _ in range(count):
        if not state.discard_pile:
            break
        iid = state.discard_pile.pop()
        bastion.walls.append(make_wall_instance(iid))
        moved.append(iid)
    return moved


def _discarded_to_wall(state: GameState, player: Player, iid: str) -> Optional[str]:
    """Riprende dagli scarti una carta appena scartata e la mette come Muro nel
    Bastione con meno Muri di `player`. Ritorna il lato, o None se non c'è più."""
    if iid not in state.discard_pile:
        return None
    state.discard_pile.remove(iid)
    side = weakest_bastion_side(player)
    _bastion(player, side).walls.append(make_wall_instance(iid))
    return side


def _take_deck_top(state: GameState) -> Optional[str]:
    """Prima carta del mazzo; se il mazzo è finito, prima si rimescolano gli scarti (come in draw_cards)."""
    if not state.deck and state.discard_pile:
        state.deck = list(state.discard_pile)
        state.discard_pile.clear()
        random.shuffle(state.deck)
    return state.deck.pop(0) if state.deck else None


def _riesuma(state: GameState, player: Player, card: str, title: str, condition: dict,
             context: str = "riesuma", **extra) -> bool:
    """Mette in attesa una scelta tra le carte degli scarti. False se non c'è nulla da riesumare."""
    queued = queue_search(state, {
        "player_id": player.id,
        "context": context,
        "condition": condition,
        "source": "discard",
        "card": card,
        "title": title,
        **extra,
    })
    if not queued:
        _event(state, player, card, f"{_name(card)}: nulla da riesumare")
    return queued


def _in_discard(state: GameState, condition: dict) -> bool:
    from engine.deck import card_matches_condition
    return any(card_matches_condition(iid, condition) for iid in state.discard_pile)


# ---------------------------------------------------------------------------
# Protezioni (Reliquiario, Orda di Achille)
# ---------------------------------------------------------------------------

def spell_protected(owner: Player, warrior: WarriorInstance) -> bool:
    """Reliquiario: le Magie avversarie non hanno effetto sul Guerriero a cui è assegnato."""
    return any(
        b.base_card_id == "reliquiario" and b.assigned_warrior == warrior.instance_id
        for b in owner.field.village.buildings
    )


def discard_protected(owner: Player, warrior: WarriorInstance) -> bool:
    """Orda di Achille: la carta al centro dell'Orda non può essere scartata dalle carte avversarie."""
    return any(
        e.get("type") == "achille_invulnerable" and _matches_warrior(warrior, e.get("warrior_iid"))
        for e in owner.active_effects
    )


def warrior_flags(owner: Player, warrior: WarriorInstance) -> dict:
    """Flag pubblici del Guerriero, usati dai client per escluderlo dai bersagli."""
    flags = {}
    if spell_protected(owner, warrior):
        flags["spell_protected"] = True
    if discard_protected(owner, warrior):
        flags["discard_protected"] = True
    return flags


def _discard_enemy_warrior(state: GameState, caster: Player, owner: Player, warrior_iid: str) -> bool:
    w = _find_warrior_in_all(owner, warrior_iid)
    if w is None or (owner.id != caster.id and discard_protected(owner, w)):
        return False
    return _discard_warrior_from_player(state, owner, warrior_iid)


# ---------------------------------------------------------------------------
# Modificatori a scadenza (Malocchio, Sanguisuga, Ectoplasma)
# ---------------------------------------------------------------------------

def _apply_stat_mods(caster: Player, owner: Player, warrior: WarriorInstance,
                     mods: Dict[str, int], card: str) -> Dict[str, int]:
    """Modifica le Caratteristiche fino al prossimo turno di chi lancia. Un malus
    non porta la Caratteristica sotto 0, e a scadenza si restituisce esattamente
    quanto applicato."""
    applied = {}
    for stat, delta in mods.items():
        current = getattr(warrior, f"effective_{stat}")()
        if delta < 0:
            delta = max(delta, -current)
        if delta == 0:
            continue
        warrior.stat_mods[stat] = warrior.stat_mods.get(stat, 0) + delta
        applied[stat] = delta
    if applied:
        desc = ", ".join(f"{'+' if d > 0 else ''}{d} {s.upper()}" for s, d in applied.items())
        caster.active_effects.append({
            "type": "stat_mod", "card": card, "owner_id": owner.id,
            "warrior_iid": warrior.instance_id, "mods": applied, "expires": TURN_START,
            "desc": f"{_name(warrior.base_card_id)}: {desc} fino al tuo prossimo turno.",
        })
    return applied


def _revert_stat_mods(state: GameState, caster: Player) -> None:
    for eff in _effects(caster, "stat_mod"):
        owner = state.get_player(eff.get("owner_id"))
        warrior = next((w for w in owner.all_warriors() if _matches_warrior(w, eff.get("warrior_iid"))), None) if owner else None
        if warrior is not None:
            for stat, delta in eff.get("mods", {}).items():
                warrior.stat_mods[stat] = warrior.stat_mods.get(stat, 0) - delta
        caster.active_effects.remove(eff)


def _drop_stat_mods(state: GameState, warrior: WarriorInstance) -> None:
    """Il Guerriero ha lasciato il campo: i suoi modificatori a scadenza non vanno
    più ripristinati (se tornasse in campo sarebbe un'istanza nuova)."""
    gone = {warrior.instance_id} | ({warrior.evolved_from} if warrior.evolved_from else set())
    for p in state.players:
        p.active_effects = [
            e for e in p.active_effects
            if not (e.get("type") == "stat_mod" and e.get("warrior_iid") in gone)
        ]


# ---------------------------------------------------------------------------
# Guerriero scartato (chiamato da effects._discard_warrior_from_player)
# ---------------------------------------------------------------------------

def discard_context(owner: Player, warrior: WarriorInstance) -> dict:
    """Fotografa gli effetti del proprietario che reagiscono allo scarto PRIMA che
    il Guerriero lasci il campo: se era proprio lui a tenere in piedi l'Orda di
    Lazzaro o di Viktor, l'Orda si divide con lo scarto ma l'effetto vale lo stesso
    (il Reliquiario assegnato a una Recluta finisce invece negli scarti con lei)."""
    return {
        "reliquiario": any(
            b.base_card_id == "reliquiario" and b.completed and b.assigned_warrior == warrior.instance_id
            for b in owner.field.village.buildings
        ),
        "lazzaro": bool(_effects(owner, "lazzaro_return")),
        "viktor": bool(_effects(owner, "viktor_wall")),
    }


def on_warrior_discarded(state: GameState, owner: Player, warrior: WarriorInstance, ctx: dict) -> None:
    """Il Guerriero è appena finito negli scarti. Prima gli effetti del proprietario
    (Reliquiario/Lazzaro lo riportano in mano, altrimenti Viktor ne fa un Muro), poi
    le Fosse comuni avversarie; Cripta e Campana reagiscono in ogni caso."""
    iid = warrior.instance_id
    name = _name(warrior.base_card_id)
    _drop_stat_mods(state, warrior)

    settled = iid not in state.discard_pile
    if not settled and (ctx.get("reliquiario") or ctx.get("lazzaro")):
        state.discard_pile.remove(iid)
        owner.hand.append(iid)
        card = "reliquiario" if ctx.get("reliquiario") else "lazzaro"
        label = "Reliquiario" if card == "reliquiario" else "Orda di Lazzaro"
        _event(state, owner, card, f"{label}: {name} torna in mano")
        settled = True
    elif not settled and ctx.get("viktor"):
        side = _discarded_to_wall(state, owner, iid)
        _event(state, owner, "viktor", f"Orda di Viktor: {name} diventa un Muro del Bastione {_side_label(side)}")
        settled = True

    for b in _buildings(owner, "cripta"):
        drawn = _draw_cards(state, owner, 2 if b.completed else 1)
        _event(state, owner, "cripta", f"Cripta: {len(drawn)} {'carta pescata' if len(drawn) == 1 else 'carte pescate'}", "draw")

    if not settled:
        for opp in _opponents(state, owner):
            fosse = _buildings(opp, "fossacomune")
            taken = any(b.completed for b in fosse) or any(
                _roll(state, opp, "fossacomune", 6, f"{name} finisce nella fossa", f"{name} resta negli scarti")
                for b in fosse
            )
            if taken:
                side = _discarded_to_wall(state, opp, iid)
                if side:
                    _event(state, opp, "fossacomune", f"Fossacomune: {name} diventa un Muro del Bastione {_side_label(side)}")
                break

    for p in state.players:
        if p.is_alive and _buildings(p, "campana"):
            _bank(p, "campana_rintocchi", 1)


# ---------------------------------------------------------------------------
# Inizio e fine turno (chiamati da game._begin_turn / game.end_turn)
# ---------------------------------------------------------------------------

def on_turn_start(state: GameState, player: Player) -> None:
    _revert_stat_mods(state, player)
    _dispel_fantasmagoria(state, player)

    # Valori accumulati dal turno precedente
    for eff in [e for e in player.active_effects if e.get("expires") == TURN_START]:
        etype = eff.get("type")
        if etype == "clessidra_azioni":
            player.actions_remaining += eff.get("count", 0)
            _event(state, player, "clessidra", f"Clessidra: +{eff.get('count', 0)} Azioni")
        elif etype == "campana_rintocchi":
            mana = sum(min(eff.get("count", 0), 3 if b.completed else 1) for b in _buildings(player, "campana"))
            _gain_mana(state, player, mana, "campana", f"Campana ({eff.get('count', 0)} rintocchi)")
        else:
            continue
        player.active_effects.remove(eff)

    discards = len(state.discard_pile)
    for b in _buildings(player, "mausoleo"):
        if b.completed:
            mana = 2 if discards >= 15 else 1
        else:
            mana = 1 if discards >= 15 else 0
        _gain_mana(state, player, mana, "mausoleo", "Mausoleo")

    for _ in _effects(player, "mephisto_pact"):
        _gain_mana(state, player, max(0, 3 - player.lives), "mephisto", "Orda di Mephisto")

    for b in _buildings(player, "ossario"):
        side = weakest_bastion_side(player)
        walls = _discard_top_to_walls(state, player, side, 2 if b.completed else 1)
        if walls:
            _event(state, player, "ossario",
                   f"Ossario: {len(walls)} {'Muro' if len(walls) == 1 else 'Muri'} dagli scarti al Bastione {_side_label(side)}")

    _refresh_enea(state, player)

    for _ in _effects(player, "gennaro_miracle"):
        if _roll(state, player, "gennaro", 6, "il sangue si scioglie", "il sangue resta secco"):
            _riesuma(state, player, "gennaro", "Miracolo di San Gennaro — riesuma una carta", {"type": "any"})


def offer_end_turn_move(state: GameState, player: Player) -> bool:
    """Traghetto: come il Cardo col Decumano, a fine turno offre uno spostamento di
    Guerriero prima di pescare (stessa interazione cardo_move). True se l'ha offerto."""
    traghetti = _buildings(player, "traghetto")
    if not traghetti or not player.all_warriors():
        return False
    if any(e.get("type") in ("cardo_move_done", "traghetto_checked") for e in player.active_effects):
        return False
    if any(i.get("type") == "cardo_move" for i in state.pending_interactions):
        return False
    player.active_effects.append({"type": "traghetto_checked", "expires": "end_of_turn"})
    allowed = any(b.completed for b in traghetti) or any(
        _roll(state, player, "traghetto", 6, "si salpa", "resta in porto") for _ in traghetti
    )
    if allowed:
        state.pending_interactions.append({"type": "cardo_move", "player_id": player.id, "source": "traghetto"})
    return allowed


def on_turn_end(state: GameState, player: Player) -> int:
    """Fine turno, prima della pesca. Accantona le Azioni non usate (Clessidra) e
    ritorna il bonus alla mano massima (Orda di Celestino)."""
    bonus = 0
    if not state.battle_done_this_turn:
        for _ in _effects(player, "celestino_rifiuto"):
            bonus += 2
            _event(state, player, "celestino", "Orda di Celestino: il gran rifiuto, mano massima +2")

    unused = player.actions_remaining
    if unused > 0:
        banked = sum(min(unused, 2) if b.completed else 1 for b in _buildings(player, "clessidra"))
        if banked:
            _bank(player, "clessidra_azioni", banked)
            _event(state, player, "clessidra", f"Clessidra: {banked} {'Azione messa' if banked == 1 else 'Azioni messe'} da parte")
    return bonus


# ---------------------------------------------------------------------------
# Battaglia (chiamati da engine/battle.py e game.do_battle)
# ---------------------------------------------------------------------------

def battle_forbidden(player: Player) -> bool:
    """Dormiveglia base: questo turno niente Battaglia."""
    return bool(_effects(player, "no_battle"))


def battle_bonus(player: Player) -> Dict[str, int]:
    """Bonus in Battaglia a ciascun Guerriero di `player` (si somma a quello di
    Ariete, Catapulta e Saracinesca): Carrofunebre e Fuocofatuo."""
    bonus = {"att": 0, "git": 0, "dif": 0}
    for b in _buildings(player, "carrofunebre"):
        bonus["att"] += 1
        if b.completed:
            bonus["git"] += 1
    for eff in _effects(player, "fuocofatuo"):
        bonus["att"] += eff.get("att", 0)
        bonus["git"] += eff.get("git", 0)
    return bonus


def attack_vs(attacker: Player, defender: Player, att: int, git: int) -> Tuple[int, int]:
    """ATT e GIT dell'attaccante contro questo difensore: lo Spauracchio li riduce."""
    for b in _buildings(defender, "spauracchio"):
        att -= 1
        if b.completed:
            git -= 1
    return max(0, att), max(0, git)


def attack_block_reason(state: GameState, attacker: Player, defender: Player,
                        side: str, att: Optional[int] = None) -> Optional[str]:
    """Perché `attacker` non può attaccare quel Bastione (None se può): Dormiveglia,
    Catalessi, Cancello (serve l'ATT contro il difensore) e l'obolo di Caronte."""
    if battle_forbidden(attacker):
        return "Dormiveglia: questo turno non puoi dichiarare Battaglia."
    for eff in _effects(defender, "catalessi"):
        if side in eff.get("sides", ()):
            return f"Catalessi: il Bastione {_side_label(side)} di {defender.name} non può essere attaccato fino al suo prossimo turno."
    threshold = max((5 if b.completed else 3 for b in _buildings(defender, "cancello")), default=0)
    if threshold and att is not None and att < threshold:
        return f"Il Cancello di {defender.name} blocca gli attacchi con meno di {threshold} ATT."
    if _effects(defender, "caronte_obolo") and attacker.mana_remaining < 1:
        return f"Per attaccare {defender.name} devi pagare 1 Mana a Caronte."
    return None


def pay_battle_toll(state: GameState, attacker: Player, defender: Player) -> None:
    """Orda di Caronte: chi dichiara Battaglia al difensore paga l'obolo."""
    if _effects(defender, "caronte_obolo"):
        attacker.mana_remaining = max(0, attacker.mana_remaining - 1)
        _event(state, attacker, "caronte", f"Orda di Caronte: {attacker.name} paga 1 Mana per attaccare {defender.name}")


def cenotafio_saves(state: GameState, defender: Player) -> bool:
    """Cenotafio completo: al posto dell'ultima Vita si scarta la Costruzione."""
    ceno = next((b for b in _buildings(defender, "cenotafio") if b.completed), None)
    if ceno is None:
        return False
    defender.field.village.buildings.remove(ceno)
    state.discard_pile.append(ceno.instance_id)
    _event(state, defender, "cenotafio", "Cenotafio: la tomba è vuota, l'ultima Vita è salva")
    return True


def after_battle(state: GameState, attacker: Player, defender: Player, result: dict) -> None:
    """Orda di Orlok: la Vita persa dal difensore può diventare dell'attaccante."""
    life_card = result.get("life_card")
    if not result.get("life_lost") or not life_card or not _effects(attacker, "orlok_bite"):
        return
    if _roll(state, attacker, "orlok", 6, "il morso va a segno", "il morso manca") and life_card in state.discard_pile:
        state.discard_pile.remove(life_card)
        attacker.life_cards.append(life_card)
        _event(state, attacker, "orlok", f"Orda di Orlok: una Vita di {defender.name} passa a {attacker.name}",
               "life_gained", lives_gained=1, lives_now=attacker.lives)


# ---------------------------------------------------------------------------
# Magie: costo, validazione dei bersagli, effetti dopo il lancio
# ---------------------------------------------------------------------------

def spell_discount(player: Player, card: SpellCard) -> int:
    """Orda di Lenore: gli Anatemi a costo 2 o più costano 1 Maga in meno."""
    if card.school == "anatema" and card.cost >= 2 and _effects(player, "lenore_discount"):
        return 1
    return 0


def spell_steps(card: SpellCard, prodigy: bool) -> List[dict]:
    steps = card.prodigy_targeting if (prodigy and card.prodigy_targeting is not None) else card.targeting
    return [s if isinstance(s, dict) else {"type": s} for s in (steps or [])]


def _step_error(state: GameState, player: Player, step: dict, kwargs: dict) -> Optional[str]:
    stype = step["type"]
    if stype in ("enemy_player", "enemy_bastion", "enemy_warrior", "enemy_building"):
        target = state.get_player(kwargs.get("target_player_id") or "")
        if target is None or target.id == player.id or not target.is_alive:
            return "Devi scegliere un avversario."
        if stype == "enemy_bastion" and kwargs.get("target_bastion_side") not in ("left", "right"):
            return "Devi scegliere un Bastione avversario."
        if stype == "enemy_warrior":
            w = _find_warrior_in_all(target, kwargs.get("target_warrior_iid") or "")
            if w is None:
                return "Devi scegliere un Guerriero avversario in campo."
            if "max_dif" in step and w.effective_dif() > step["max_dif"]:
                return f"Serve un Guerriero con DIF {step['max_dif']} o meno."
            if spell_protected(target, w):
                return f"Il Reliquiario protegge {_name(w.base_card_id)} dalle tue Magie."
            if step.get("discard") and discard_protected(target, w):
                return f"{_name(w.base_card_id)} non può essere scartato dalle carte avversarie."
        if stype == "enemy_building":
            b = next((b for b in target.field.village.buildings
                      if b.instance_id == kwargs.get("target_building_iid")), None)
            if b is None:
                return "Devi scegliere una Costruzione avversaria."
            if step.get("incomplete") and b.completed:
                return "Serve una Costruzione incompleta."
    elif stype == "own_bastion":
        if kwargs.get(step.get("param", "bastion_side")) not in ("left", "right"):
            return "Devi scegliere un tuo Bastione."
    elif stype == "own_warrior":
        iid = kwargs.get(step.get("param", "own_warrior_iid"))
        if step.get("optional") and not iid and not player.all_warriors():
            return None
        if not iid or _find_warrior_in_all(player, iid) is None:
            return "Devi scegliere un tuo Guerriero in campo."
    elif stype == "region":
        if kwargs.get(step.get("param", "region")) not in _REGIONS:
            return "Devi scegliere una Regione."
    return None


def spell_error(state: GameState, player: Player, card: SpellCard, prodigy: bool, kwargs: dict) -> Optional[str]:
    """Pre-validazione delle Magie Oltretomba, da fare prima che la carta lasci la
    mano: un errore ritornato dall'effetto arriverebbe a carta già consumata."""
    if card.deck != DECK_ID:
        return None
    for step in spell_steps(card, prodigy):
        err = _step_error(state, player, step, kwargs)
        if err:
            return err
    check = _PRECONDITIONS.get(card.id)
    return check(state, player, prodigy, kwargs) if check else None


def _pre_oltremuro(state, player, prodigy, kwargs):
    target = state.get_player(kwargs.get("target_player_id") or "")
    side = kwargs.get("target_bastion_side")
    if target and side in ("left", "right") and not _bastion(target, side).walls:
        return "Il Bastione scelto non ha Muri."
    return None


def _pre_mortaretto(state, player, prodigy, kwargs):
    target = state.get_player(kwargs.get("target_player_id") or "")
    if target and not (target.field.bastion_left.walls or target.field.bastion_right.walls):
        return f"{target.name} non ha Muri."
    return None


_PRECONDITIONS = {
    "pietrombale": lambda s, p, pr, kw: None if s.discard_pile else "Non ci sono carte negli scarti.",
    "oltremuro": _pre_oltremuro,
    "mortaretto": _pre_mortaretto,
    "tombarolo": lambda s, p, pr, kw: None if _in_discard(s, {"type": "card_type", "value": "building"})
        else "Non ci sono Costruzioni negli scarti.",
    "crisantemo": lambda s, p, pr, kw: None if _in_discard(s, {"type": "card_type", "value": "spell", "exclude_base_ids": ["crisantemo"]})
        else "Non ci sono Magie da riesumare negli scarti.",
    "rinascimento": lambda s, p, pr, kw: None if _in_discard(s, {"type": "subtype", "value": "recruit"})
        else "Non ci sono Reclute negli scarti.",
    "risorgimento": lambda s, p, pr, kw: None if (s.deck or s.discard_pile) else "Il mazzo è vuoto.",
}


def after_spell(state: GameState, player: Player, base_id: str, instance_id: str) -> None:
    """Dopo una Magia: Orde di Ligeia e Morella, Necromanteion."""
    card = CARD_REGISTRY.get(base_id)
    if not isinstance(card, SpellCard):
        return

    if card.school == "sortilegio" and _effects(player, "ligeia_oblio"):
        for opp in _opponents(state, player):
            if not opp.hand:
                continue
            lost = random.choice(opp.hand)
            opp.hand.remove(lost)
            state.discard_pile.append(lost)
            _event(state, player, "ligeia", f"Orda di Ligeia: {opp.name} dimentica {_name(lost)}")

    if card.school == "incantesimo":
        for _ in _effects(player, "morella_tesoro"):
            _gain_mana(state, player, 1, "morella", "Orda di Morella")

    necro = _buildings(player, "necromanteion")
    if necro:
        threshold = 6 if any(b.completed for b in necro) else 8
        if _roll(state, player, "necromanteion", threshold, "l'oracolo risponde", "l'oracolo tace"):
            _riesuma(state, player, "necromanteion", "Necromanteion — riesuma un'altra Magia",
                     {"type": "card_type", "value": "spell", "exclude_iids": [instance_id]})


# ---------------------------------------------------------------------------
# Evoluzione (Laboratorio) e Costruzioni attivabili (Pira)
# ---------------------------------------------------------------------------

def evolve_is_free(player: Player) -> bool:
    """Laboratorio completo: evolvere una Recluta non consuma Azioni."""
    return any(b.completed for b in _buildings(player, "laboratorio"))


def after_evolve(state: GameState, player: Player) -> None:
    for _ in _buildings(player, "laboratorio"):
        _draw_cards(state, player, 1)
        _event(state, player, "laboratorio", "Laboratorio: 1 carta pescata", "draw")


def activation_available(player: Player, building: BuildingInstance) -> bool:
    return not any(
        e.get("type") == "building_used" and e.get("building_instance_id") == building.instance_id
        for e in player.active_effects
    )


# ---------------------------------------------------------------------------
# Ricerche (riesumare, Lumicino): completamento dopo la scelta del giocatore
# ---------------------------------------------------------------------------

def resolve_search(state: GameState, player: Player, search: dict, chosen_iid: str, result: dict) -> Optional[dict]:
    """La carta scelta ha già lasciato la sua pila (scarti o cima del mazzo): la
    porta a destinazione. Ritorna l'eventuale ricerca successiva (seconda Recluta
    di Rinascimento, seconda carta di Lumicino)."""
    context = search["context"]
    name = _name(chosen_iid)

    if context in ("riesuma", "riesuma_eterea"):
        player.hand.append(chosen_iid)
        result["added_to_hand"] = chosen_iid
        if context == "riesuma_eterea":
            player.ethereal_card = chosen_iid
            result["ethereal"] = chosen_iid
        _event(state, player, search.get("card", ""), f"{_name(search.get('card', ''))}: riesumata {name}"
               + (" (Eterea)" if context == "riesuma_eterea" else ""), "search")
        return None

    if context == "rinascimento":
        region = search.get("region", "vanguard")
        _region_list(player, region).append(make_warrior_instance(chosen_iid))
        result["placed"] = {"card": chosen_iid, "region": region}
        _event(state, player, "rinascimento", f"Rinascimento: {name} torna in campo", "search")
        if search.get("remaining", 1) > 1:
            return {**search, "remaining": search["remaining"] - 1,
                    "title": "Rinascimento ✨ — riesuma un'altra Recluta"}
        return None

    if context == "lumicino":
        player.hand.append(chosen_iid)
        result["added_to_hand"] = chosen_iid
        rest = [iid for iid in search.get("cards", []) if iid != chosen_iid and iid in state.deck]
        if search.get("picks", 1) > 1 and rest:
            return {**search, "cards": rest, "picks": search["picks"] - 1,
                    "title": "Lumicino ✨ — scegli la seconda carta"}
        _discard_revealed(state, rest)
        _event(state, player, "lumicino", f"Lumicino: 1 carta presa, {len(rest)} negli scarti", "search")
        return None
    return None


def cancel_search(state: GameState, search: dict) -> None:
    """Rinuncia a una ricerca: le carte scoperte da Lumicino vanno comunque scartate."""
    if search.get("context") == "lumicino":
        _discard_revealed(state, [iid for iid in search.get("cards", []) if iid in state.deck])


def _discard_revealed(state: GameState, iids: List[str]) -> None:
    for iid in iids:
        state.deck.remove(iid)
        state.discard_pile.append(iid)


def _region_list(player: Player, region: str) -> List[WarriorInstance]:
    if region == "bastion_left":
        return player.field.bastion_left.warriors
    if region == "bastion_right":
        return player.field.bastion_right.warriors
    return player.field.vanguard


# ---------------------------------------------------------------------------
# Orda di Enea: bonus ricalcolato a ogni inizio turno
# ---------------------------------------------------------------------------

def _enea_bonus(state: GameState) -> int:
    humans = 0
    for iid in state.discard_pile:
        card = CARD_REGISTRY.get(get_base_card_id(iid))
        if isinstance(card, WarriorCard) and card.species == "umano":
            humans += 1
    return min(3, humans)


def _refresh_enea(state: GameState, player: Player) -> None:
    """Il numero di Umani negli scarti cambia di continuo: il bonus dell'Orda di
    Enea si aggiorna a ogni inizio turno (come un normale bonus Orda, resta
    in horde_stat_bonus e sparisce se l'Orda si divide)."""
    target = _enea_bonus(state)
    for eff in player.active_effects:
        if eff.get("type") != "horde_stat_bonus" or eff.get("dynamic") != "enea":
            continue
        w = next((w for w in player.all_warriors() if w.instance_id == eff.get("warrior_iid")), None)
        delta = target - eff.get("att", 0)
        if w is None or delta == 0:
            continue
        for stat in ("att", "dif"):
            w.temp_modifiers[stat] = max(0, w.temp_modifiers.get(stat, 0) + delta)
        eff["att"] = eff["dif"] = target


# ---------------------------------------------------------------------------
# EFFETTI COSTRUZIONI
# ---------------------------------------------------------------------------

def _passive(completed: bool) -> dict:
    return {"passive": True, "completed": completed}


# Costruzioni gestite dagli agganci sopra (inizio/fine turno, scarto, Battaglia, Magie)
for _building_id in ("ossario", "cripta", "mausoleo", "cenotafio", "campana", "fossacomune",
                     "necromanteion", "clessidra", "traghetto", "cancello", "spauracchio",
                     "carrofunebre", "laboratorio"):
    register_effect(f"{_building_id}_effect")(lambda state, player, completed=False, **kwargs: _passive(completed))


@register_effect("reliquiario_effect")
def reliquiario_effect(state: GameState, player: Player, completed: bool = False,
                       target_warrior_iid: Optional[str] = None, building_instance_id: Optional[str] = None,
                       **kwargs) -> dict:
    """Al piazzamento si assegna a un proprio Guerriero (come il Trono). La protezione
    dalle Magie e il ritorno in mano sono controllati da spell_protected / discard_context."""
    if not target_warrior_iid or not building_instance_id:
        return _passive(completed)
    target_w = _find_warrior_in_all(player, target_warrior_iid)
    b_inst = next((b for b in player.field.village.buildings if b.instance_id == building_instance_id), None)
    if not target_w or not b_inst:
        return {"error": "Guerriero o Reliquiario non trovato"}
    if building_instance_id not in target_w.assigned_cards:
        target_w.assigned_cards.append(building_instance_id)
    b_inst.assigned_warrior = target_warrior_iid
    _event(state, player, "reliquiario", f"Reliquiario: assegnato a {_name(target_w.base_card_id)}")
    return {"assigned_to": target_warrior_iid}


@register_effect("pira_effect")
def pira_effect(state: GameState, player: Player, completed: bool = False, activate: bool = False,
                own_warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Attivazione (actions.activate_building): scarta un tuo Guerriero, +2 Mana (e una carta se completa)."""
    if not activate:
        return _passive(completed)
    w = _find_warrior_in_all(player, own_warrior_iid) if own_warrior_iid else None
    if w is None:
        return {"error": "Scegli un tuo Guerriero da mettere sulla Pira."}
    name = _name(w.base_card_id)
    _discard_warrior_from_player(state, player, w.instance_id)
    _gain_mana(state, player, 2, "pira", f"Pira: {name} brucia")
    if completed:
        _draw_cards(state, player, 1)
        _event(state, player, "pira", "Pira: 1 carta pescata", "draw")
    return {"sacrificed": w.instance_id}


# ---------------------------------------------------------------------------
# EFFETTI MAGIE — Anatemi
# ---------------------------------------------------------------------------

def _blocked(state: GameState, player: Player, target: Player, card: str) -> bool:
    """Acquasanta (spell_immune): le Magie avversarie non hanno effetto sul bersaglio."""
    if target.id != player.id and _is_spell_immune(target):
        state.recent_events.append({
            "type": "magiscudo_blocked", "card": card, "player_id": player.id, "blocked_player": target.id,
            "text": f"{_name(card)} annullata: {target.name} è protetto dall'Acquasanta",
        })
        return True
    return False


def _enemy_warrior(state: GameState, kwargs: dict) -> Tuple[Optional[Player], Optional[WarriorInstance]]:
    target = state.get_player(kwargs.get("target_player_id") or "")
    w = _find_warrior_in_all(target, kwargs.get("target_warrior_iid") or "") if target else None
    return target, w


@register_effect("malocchio_effect")
def malocchio_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    target, w = _enemy_warrior(state, kwargs)
    if w is None or _blocked(state, player, target, "malocchio"):
        return {}
    mods = {"dif": -2, "att": -2} if prodigy else {"dif": -2}
    applied = _apply_stat_mods(player, target, w, mods, "malocchio")
    _event(state, player, "malocchio", f"Malocchio su {_name(w.base_card_id)} di {target.name}")
    return {"target": w.instance_id, "mods": applied}


@register_effect("fuocofatuo_effect")
def fuocofatuo_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    eff = {"type": "fuocofatuo", "card": "fuocofatuo", "git": 2, "att": 2 if prodigy else 0, "expires": "end_of_turn",
           "desc": "In Battaglia, questo turno, i tuoi Guerrieri ottengono +2 GIT" + (" e +2 ATT." if prodigy else ".")}
    player.active_effects.append(eff)
    _event(state, player, "fuocofatuo", "Fuocofatuo: +2 GIT" + (" e +2 ATT" if prodigy else "") + " in Battaglia")
    return {"git": 2, "att": eff["att"]}


@register_effect("mortaretto_effect")
def mortaretto_effect(state: GameState, player: Player, prodigy: bool = False,
                      target_player_id: Optional[str] = None, **kwargs) -> dict:
    target = state.get_player(target_player_id or "")
    if target is None or _blocked(state, player, target, "mortaretto"):
        return {}
    per_bastion = 2 if prodigy else 1
    total = 0
    for side in ("left", "right"):
        bastion = _bastion(target, side)
        for wall in random.sample(bastion.walls, min(per_bastion, len(bastion.walls))):
            bastion.walls.remove(wall)
            state.discard_pile.append(wall.instance_id)
            total += 1
    _event(state, player, "mortaretto", f"Mortaretto: {target.name} perde {total} {'Muro' if total == 1 else 'Muri'}")
    return {"walls_discarded": total}


@register_effect("lapidazione_effect")
def lapidazione_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    target, w = _enemy_warrior(state, kwargs)
    if w is None or _blocked(state, player, target, "lapidazione"):
        return {}
    name = _name(w.base_card_id)
    if _discard_enemy_warrior(state, player, target, w.instance_id):
        _event(state, player, "lapidazione", f"Lapidazione: {name} di {target.name} è scartato", "warrior_discarded")
    return {"warrior_discarded": w.instance_id}


@register_effect("sanguisuga_effect")
def sanguisuga_effect(state: GameState, player: Player, prodigy: bool = False,
                      own_warrior_iid: Optional[str] = None, **kwargs) -> dict:
    result: dict = {}
    own = _find_warrior_in_all(player, own_warrior_iid or "")
    if own is not None:
        result["own"] = _apply_stat_mods(player, player, own, {"att": 2, "dif": 2} if prodigy else {"att": 2}, "sanguisuga")
    target, w = _enemy_warrior(state, kwargs)
    if w is not None and not _blocked(state, player, target, "sanguisuga"):
        result["enemy"] = _apply_stat_mods(player, target, w, {"att": -2, "dif": -2} if prodigy else {"att": -2}, "sanguisuga")
    _event(state, player, "sanguisuga", "Sanguisuga: forza succhiata"
           + (f" a {_name(w.base_card_id)}" if w is not None else ""))
    return result


@register_effect("baraonda_effect")
def baraonda_effect(state: GameState, player: Player, prodigy: bool = False,
                    own_warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """Base: ognuno, te compreso, scarta un suo Guerriero a scelta. Prodigio: solo gli
    avversari. Chi ha più Guerrieri scartabili sceglie (interazione malcomune_discard
    senza Specie); con uno solo si scarta direttamente."""
    result: dict = {"discarded": [], "pending": []}
    if not prodigy and own_warrior_iid and _find_warrior_in_all(player, own_warrior_iid):
        _discard_warrior_from_player(state, player, own_warrior_iid)
        result["discarded"].append(own_warrior_iid)
    for opp in _opponents(state, player):
        if _blocked(state, player, opp, "baraonda"):
            continue
        choices = baraonda_choices(opp)
        if len(choices) == 1:
            _discard_warrior_from_player(state, opp, choices[0].instance_id)
            result["discarded"].append(choices[0].instance_id)
        elif choices:
            state.pending_interactions.append({
                "type": "malcomune_discard", "player_id": opp.id, "caster_id": player.id,
                "species": None, "card": "baraonda",
            })
            result["pending"].append(opp.id)
    _event(state, player, "baraonda", f"Baraonda: {len(result['discarded'])} Guerrieri scartati"
           + (f", {len(result['pending'])} in attesa di scelta" if result["pending"] else ""), "warrior_discarded")
    return result


def baraonda_choices(owner: Player) -> List[WarriorInstance]:
    """Guerrieri che `owner` può scartare per una Magia avversaria come Baraonda."""
    return [w for w in owner.all_warriors() if not spell_protected(owner, w) and not discard_protected(owner, w)]


@register_effect("trapasso_effect")
def trapasso_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    target, w = _enemy_warrior(state, kwargs)
    if w is None or _blocked(state, player, target, "trapasso"):
        return {}
    name = _name(w.base_card_id)
    recruit_iid = w.evolved_from
    result: dict = {}
    if _discard_enemy_warrior(state, player, target, w.instance_id):
        result["warrior_discarded"] = w.instance_id
        if prodigy and recruit_iid and _find_warrior_in_all(target, recruit_iid):
            _discard_warrior_from_player(state, target, recruit_iid)
            result["recruit_discarded"] = recruit_iid
    _event(state, player, "trapasso", f"Trapasso: {name} di {target.name} è scartato"
           + (" insieme alla sua Recluta" if result.get("recruit_discarded") else ""), "warrior_discarded")
    return result


# ---------------------------------------------------------------------------
# EFFETTI MAGIE — Sortilegi
# ---------------------------------------------------------------------------

@register_effect("pietrombale_effect")
def pietrombale_effect(state: GameState, player: Player, prodigy: bool = False,
                       bastion_side: str = "left", **kwargs) -> dict:
    walls = _discard_top_to_walls(state, player, bastion_side, 3 if prodigy else 2)
    _event(state, player, "pietrombale",
           f"Pietrombale: {len(walls)} {'Muro' if len(walls) == 1 else 'Muri'} dagli scarti al Bastione {_side_label(bastion_side)}")
    return {"walls_added": len(walls)}


@register_effect("oltremuro_effect")
def oltremuro_effect(state: GameState, player: Player, prodigy: bool = False,
                     target_player_id: Optional[str] = None, target_bastion_side: str = "left", **kwargs) -> dict:
    target = state.get_player(target_player_id or "")
    if target is None or _blocked(state, player, target, "oltremuro"):
        return {}
    src = _bastion(target, target_bastion_side)
    side = weakest_bastion_side(player)
    moved = random.sample(src.walls, min(3 if prodigy else 1, len(src.walls)))
    for wall in moved:
        src.walls.remove(wall)
        _bastion(player, side).walls.append(wall)
    _event(state, player, "oltremuro",
           f"Oltremuro: {len(moved)} {'Muro passa' if len(moved) == 1 else 'Muri passano'} da {target.name} "
           f"al Bastione {_side_label(side)} di {player.name}",
           "wall_moved")
    return {"walls_moved": len(moved)}


@register_effect("tombarolo_effect")
def tombarolo_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    queued = _riesuma(state, player, "tombarolo",
                      "Tombarolo — riesuma una Costruzione" + (" (diventerà Eterea)" if prodigy else ""),
                      {"type": "card_type", "value": "building"},
                      context="riesuma_eterea" if prodigy else "riesuma")
    return {"search_pending": queued}


@register_effect("carontassa_effect")
def carontassa_effect(state: GameState, player: Player, prodigy: bool = False,
                      target_player_id: Optional[str] = None, target_building_iid: Optional[str] = None,
                      **kwargs) -> dict:
    target = state.get_player(target_player_id or "")
    if target is None or _blocked(state, player, target, "carontassa"):
        return {}
    b = next((b for b in target.field.village.buildings if b.instance_id == target_building_iid), None)
    if b is None:
        return {"error": "Costruzione non trovata"}
    _unassign_building(target, b)
    target.field.village.buildings.remove(b)
    state.discard_pile.append(b.instance_id)
    _event(state, player, "carontassa", f"Carontassa: {target.name} perde {_name(b.base_card_id)}", "discard")
    return {"building_discarded": b.instance_id}


@register_effect("catalessi_effect")
def catalessi_effect(state: GameState, player: Player, prodigy: bool = False,
                     bastion_side: str = "left", **kwargs) -> dict:
    sides = ["left", "right"] if prodigy else [bastion_side]
    if prodigy:
        desc = "Fino al tuo prossimo turno i tuoi Bastioni non possono essere attaccati."
        text = f"Catalessi: i Bastioni di {player.name} non possono essere attaccati fino al suo prossimo turno"
    else:
        desc = f"Fino al tuo prossimo turno il tuo Bastione {_side_label(bastion_side)} non può essere attaccato."
        text = (f"Catalessi: il Bastione {_side_label(bastion_side)} di {player.name} "
                f"non può essere attaccato fino al suo prossimo turno")
    player.active_effects.append({
        "type": "catalessi", "card": "catalessi", "sides": sides, "expires": "next_own_turn", "desc": desc,
    })
    _event(state, player, "catalessi", text)
    return {"sides": sides}


@register_effect("fantasmagoria_effect")
def fantasmagoria_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    added = []
    for side in ("left", "right"):
        for _ in range(2):
            iid = _take_deck_top(state)
            if iid is None:
                break
            _bastion(player, side).walls.append(make_wall_instance(iid))
            added.append(iid)
    if not prodigy and added:
        player.active_effects.append({
            "type": "fantasmagoria_walls", "card": "fantasmagoria", "walls": added, "expires": TURN_START,
            "desc": f"{len(added)} Muri spettrali svaniranno all'inizio del tuo prossimo turno.",
        })
    _event(state, player, "fantasmagoria", f"Fantasmagoria: +{len(added)} Muri" + ("" if prodigy else " spettrali"))
    return {"walls_added": len(added)}


def _dispel_fantasmagoria(state: GameState, player: Player) -> None:
    for eff in _effects(player, "fantasmagoria_walls"):
        ghosts = set(eff.get("walls", []))
        gone = 0
        for bastion in (player.field.bastion_left, player.field.bastion_right):
            for wall in [w for w in bastion.walls if w.instance_id in ghosts]:
                bastion.walls.remove(wall)
                state.discard_pile.append(wall.instance_id)
                gone += 1
        player.active_effects.remove(eff)
        if gone:
            _event(state, player, "fantasmagoria", f"Fantasmagoria: {gone} Muri spettrali svaniscono")


@register_effect("risorgimento_effect")
def risorgimento_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    life = _take_deck_top(state)
    if life is not None:
        player.life_cards.append(life)
        _event(state, player, "risorgimento", "Risorgimento: +1 Vita", "life_gained", lives_gained=1, lives_now=player.lives)
    if prodigy:
        _riesuma(state, player, "risorgimento", "Risorgimento ✨ — riesuma una carta", {"type": "any"})
    return {"lives_gained": 1 if life else 0}


# ---------------------------------------------------------------------------
# EFFETTI MAGIE — Incantesimi
# ---------------------------------------------------------------------------

@register_effect("crisantemo_effect")
def crisantemo_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    queued = _riesuma(state, player, "crisantemo",
                      "Crisantemo — riesuma una Magia" + (" (diventerà Eterea)" if prodigy else ""),
                      {"type": "card_type", "value": "spell", "exclude_base_ids": ["crisantemo"]},
                      context="riesuma_eterea" if prodigy else "riesuma")
    return {"search_pending": queued}


@register_effect("dormiveglia_effect")
def dormiveglia_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    player.actions_remaining += 2
    if not prodigy:
        player.active_effects.append({
            "type": "no_battle", "card": "dormiveglia", "expires": "end_of_turn",
            "desc": "Questo turno non puoi dichiarare Battaglia.",
        })
    _event(state, player, "dormiveglia", "Dormiveglia: +2 Azioni" + ("" if prodigy else ", niente Battaglia"))
    return {"extra_actions": 2}


@register_effect("acquasanta_effect")
def acquasanta_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    player.active_effects.append({
        "type": "spell_immune", "card": "acquasanta", "expires": "next_own_turn",
        "desc": "Le Magie avversarie non hanno effetto su di te fino al tuo prossimo turno.",
    })
    if prodigy:
        _draw_cards(state, player, 1)
    _event(state, player, "acquasanta", "Acquasanta: immune alle Magie avversarie" + (", 1 carta pescata" if prodigy else ""))
    return {"spell_immune": True}


@register_effect("testamento_effect")
def testamento_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    gained = _gain_mana(state, player, 2, "testamento", "Testamento")
    if prodigy:
        _riesuma(state, player, "testamento", "Testamento ✨ — riesuma una carta", {"type": "any"})
    return {"mana_gained": gained}


@register_effect("lumicino_effect")
def lumicino_effect(state: GameState, player: Player, prodigy: bool = False, **kwargs) -> dict:
    count = 4 if prodigy else 3
    if not state.deck and state.discard_pile:
        # Come in draw_cards: a mazzo finito si rimescolano gli scarti
        state.deck = list(state.discard_pile)
        state.discard_pile.clear()
        random.shuffle(state.deck)
    revealed = list(state.deck[:count])
    queued = queue_search(state, {
        "player_id": player.id,
        "context": "lumicino",
        "condition": {"type": "any"},
        "source": "deck_top",
        "cards": revealed,
        "picks": 2 if prodigy else 1,
        "card": "lumicino",
        "title": "Lumicino — scegli una carta" + (" (poi una seconda)" if prodigy else ""),
    })
    return {"search_pending": queued, "revealed": len(revealed)}


@register_effect("ectoplasma_effect")
def ectoplasma_effect(state: GameState, player: Player, prodigy: bool = False,
                      own_warrior_iid: Optional[str] = None, **kwargs) -> dict:
    w = _find_warrior_in_all(player, own_warrior_iid or "")
    if w is None:
        return {}
    n = 3 if prodigy else 2
    applied = _apply_stat_mods(player, player, w, {"att": n, "git": n, "dif": n}, "ectoplasma")
    _event(state, player, "ectoplasma", f"Ectoplasma: {_name(w.base_card_id)} +{n}/+{n}/+{n}")
    return {"target": w.instance_id, "mods": applied}


@register_effect("rinascimento_effect")
def rinascimento_effect(state: GameState, player: Player, prodigy: bool = False,
                        region: str = "vanguard", **kwargs) -> dict:
    queued = _riesuma(state, player, "rinascimento", "Rinascimento — riesuma una Recluta",
                      {"type": "subtype", "value": "recruit"}, context="rinascimento",
                      region=region if region in _REGIONS else "vanguard", remaining=2 if prodigy else 1)
    return {"search_pending": queued}


# ---------------------------------------------------------------------------
# EFFETTI ORDA
# ---------------------------------------------------------------------------

def _horde_flag(etype: str, card: str, text: str, desc: str):
    """Orda con effetto passivo: resta finché l'Orda è attiva (from_horde_key lo
    lega all'Orda, vedi actions.activate_horde)."""
    def effect(state: GameState, player: Player, **kwargs) -> dict:
        player.active_effects.append({"type": etype, "card": card, "desc": desc})
        _event(state, player, card, text, "horde")
        return {etype: True}
    return effect


register_effect("lazzaro_horde")(_horde_flag(
    "lazzaro_return", "lazzaro", "Orda di Lazzaro: i tuoi caduti tornano in mano",
    "Quando un tuo Guerriero viene scartato, torna nella tua mano."))
register_effect("gennaro_horde")(_horde_flag(
    "gennaro_miracle", "gennaro", "Orda di Gennaro: a ogni turno si tenta il miracolo",
    "A inizio turno lancia un D10: con 6 o più riesumi una carta."))
register_effect("celestino_horde")(_horde_flag(
    "celestino_rifiuto", "celestino", "Orda di Celestino: chi rinuncia alla Battaglia pesca di più",
    "Se non dichiari Battaglia, a fine turno la mano massima aumenta di 2."))
register_effect("viktor_horde")(_horde_flag(
    "viktor_wall", "viktor", "Orda di Viktor: i tuoi caduti diventano Muri",
    "Quando un tuo Guerriero viene scartato, diventa un Muro del tuo Bastione con meno Muri."))
register_effect("orlok_horde")(_horde_flag(
    "orlok_bite", "orlok", "Orda di Orlok: le Vite tolte in Battaglia possono diventare tue",
    "Se la tua Battaglia fa perdere una Vita, con un D10 di 6 o più quella carta diventa una tua Vita."))
register_effect("mephisto_horde")(_horde_flag(
    "mephisto_pact", "mephisto", "Orda di Mephisto: il patto è firmato",
    "A inizio turno ottieni un Mana per ogni Vita che ti manca per averne 3."))
register_effect("caronte_horde")(_horde_flag(
    "caronte_obolo", "caronte", "Orda di Caronte: attaccarti costa 1 Mana",
    "Per dichiararti Battaglia, un avversario deve pagare 1 Mana."))
register_effect("lenore_horde")(_horde_flag(
    "lenore_discount", "lenore", "Orda di Lenore: Anatemi a costo 2+ scontati",
    "Gli Anatemi a costo 2 o più che giochi costano 1 Maga in meno."))
register_effect("ligeia_horde")(_horde_flag(
    "ligeia_oblio", "ligeia", "Orda di Ligeia: i Sortilegi fanno dimenticare",
    "Quando giochi un Sortilegio, ogni avversario scarta una carta casuale dalla mano."))
register_effect("morella_horde")(_horde_flag(
    "morella_tesoro", "morella", "Orda di Morella: gli Incantesimi fruttano Mana",
    "Quando giochi un Incantesimo, ottieni un Mana aggiuntivo."))


@register_effect("enea_horde")
def enea_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    """+1 ATT e +1 DIF per ogni Umano negli scarti (massimo +3), aggiornato a ogni
    inizio turno da _refresh_enea."""
    w = _find_warrior(player, warrior_iid)
    if w is None:
        return {}
    bonus = _enea_bonus(state)
    w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) + bonus
    w.temp_modifiers["dif"] = w.temp_modifiers.get("dif", 0) + bonus
    player.active_effects.append({"type": "horde_stat_bonus", "warrior_iid": w.instance_id,
                                  "att": bonus, "dif": bonus, "dynamic": "enea"})
    _event(state, player, "enea", f"Orda di Enea: {_name(w.base_card_id)} +{bonus} ATT e +{bonus} DIF", "horde")
    return {"target": w.instance_id, "bonus": bonus}


@register_effect("achille_horde")
def achille_horde(state: GameState, player: Player, warrior_iid: Optional[str] = None, **kwargs) -> dict:
    w = _find_warrior(player, warrior_iid)
    if w is None:
        return {}
    w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) + 2
    player.active_effects.append({"type": "horde_stat_bonus", "warrior_iid": w.instance_id, "att": 2})
    player.active_effects.append({"type": "achille_invulnerable", "warrior_iid": w.instance_id,
                                  "card": "achille", "desc": f"{_name(w.base_card_id)} non può essere scartato dalle carte avversarie."})
    _event(state, player, "achille", f"Orda di Achille: {_name(w.base_card_id)} +2 ATT e invulnerabile", "horde")
    return {"target": w.instance_id, "att_bonus": 2}
