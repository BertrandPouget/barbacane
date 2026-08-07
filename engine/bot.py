"""
IA euristica di Barbacane, per la modalità "Sfida un Bot".

Nessuna ricerca in profondità (minimax/lookahead): con mano avversaria
nascosta, tiri di D10 e decine di effetti diversi, una ricerca vera sarebbe
uno sforzo enorme per un guadagno dubbio. Il bot invece valuta le mosse
legalmente disponibili ad ogni decisione con una funzione di punteggio
("greedy" per fase di turno) e sceglie la migliore — con un margine di
casualità in difficoltà "easy"/"normal" per non essere robotico e per
restare battibile.

Tre difficoltà:
- "easy":   il bot casuale storico del motore (random_bot_turn), usato
            così com'è — nessuna strategia reale.
- "normal": motore euristico sotto, con selezione "soft-greedy" (la mossa
            migliore non è sempre quella scelta).
- "hard":   stesso motore euristico, ma sceglie sempre la mossa con il
            punteggio più alto (nessuna esplorazione).
"""

from __future__ import annotations
import random
from typing import Callable, List, Optional, Tuple

from engine.models import GameState, Player, WarriorInstance
from engine.cards import get_card, WarriorCard, SpellCard, BuildingCard
from engine.deck import get_base_card_id
from engine.actions import (
    ActionError,
    play_warrior,
    play_building,
    play_spell,
    complete_building,
    add_wall,
    evolve_warrior,
    reposition_warrior,
)
from engine.battle import (
    get_valid_attack_targets,
    attacker_stats,
    defender_stats,
    calculate_damage,
)
from engine.game import end_turn, random_bot_turn, do_battle, _bot_try_horde

# Magie con targeting troppo specifico (assegnazione multipla, scelta di un
# Trono, scambio di Bastioni tra due giocatori) per un bundle di kwargs
# generico: il bot semplicemente non le gioca, invece di sprecarle a vuoto.
_SPELL_EFFECT_EXCLUDE = {"regicidio_effect", "telecinesi_effect", "bastioncontrario_effect"}

_ZONE_NAMES = ("vanguard", "bastion_left", "bastion_right")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_bot_turn(state: GameState, difficulty: str = "normal") -> None:
    """Gioca l'intero turno del giocatore corrente (deve essere il Bot)."""
    if difficulty == "easy":
        random_bot_turn(state)
        return

    player_id = state.current_player.id
    _play_actions(state, player_id, difficulty)
    _reposition_for_hordes(state, player_id)
    _bot_try_horde(state, state.get_player(player_id))
    _bot_battle(state, player_id)
    end_turn(state)


# ---------------------------------------------------------------------------
# Fase Azioni
# ---------------------------------------------------------------------------

def _play_actions(state: GameState, player_id: str, difficulty: str) -> None:
    player = state.get_player(player_id)
    while player.actions_remaining > 0:
        if not _play_best_action(state, player_id, difficulty):
            break


def _play_best_action(state: GameState, player_id: str, difficulty: str) -> bool:
    """Valuta tutte le azioni disponibili in questo momento e tenta la migliore
    (con eventuale margine di casualità). Ritorna True se una è riuscita."""
    player = state.get_player(player_id)
    opponent = _opponent(state, player_id)

    candidates: List[Tuple[float, Callable[[], dict]]] = []

    for iid in player.hand:
        base_id = get_base_card_id(iid)
        try:
            card = get_card(base_id)
        except KeyError:
            continue

        if isinstance(card, WarriorCard):
            if card.subtype == "hero":
                continue  # gestito sotto, come evoluzione
            if player.mana_remaining >= card.cost:
                score, region = _score_warrior(card, player)
                candidates.append((
                    score,
                    lambda iid=iid, region=region: play_warrior(state, player_id, iid, region),
                ))

        elif isinstance(card, BuildingCard):
            if player.mana_remaining >= card.cost:
                candidates.append((
                    _score_building_play(card),
                    lambda iid=iid: play_building(state, player_id, iid),
                ))

        elif isinstance(card, SpellCard):
            if card.effect_id in _SPELL_EFFECT_EXCLUDE:
                continue
            mages_count = len(player.mages_in_field())
            if mages_count >= card.cost:
                score = _score_spell(card, player)
                kwargs = _default_spell_kwargs(player, opponent)
                candidates.append((
                    score,
                    lambda iid=iid, kwargs=kwargs: play_spell(state, player_id, iid, **kwargs),
                ))

    # Evolvi: Recluta già in campo + il suo Eroe in mano
    for iid in player.hand:
        base_id = get_base_card_id(iid)
        try:
            card = get_card(base_id)
        except KeyError:
            continue
        if isinstance(card, WarriorCard) and card.subtype == "hero" and player.mana_remaining >= card.cost:
            recruit = _find_evolvable_recruit(player, card)
            if recruit:
                candidates.append((
                    8.0,
                    lambda iid=iid, recruit_iid=recruit.instance_id: evolve_warrior(state, player_id, recruit_iid, iid),
                ))

    # Completa Costruzioni incomplete già in campo
    for b in player.field.village.buildings:
        if b.completed:
            continue
        card = get_card(b.base_card_id)
        if isinstance(card, BuildingCard) and player.mana_remaining >= card.completion_cost:
            candidates.append((
                4.0 + card.completion_cost * 0.3,
                lambda b_iid=b.instance_id: complete_building(state, player_id, b_iid),
            ))

    # Muri: opzione sempre disponibile se c'è qualcosa in mano
    if player.hand:
        candidates.append((_score_walls(player), lambda: _play_walls(state, player_id)))

    if not candidates:
        return False

    candidates.sort(key=lambda c: c[0], reverse=True)
    for _, fn in _softened_order(candidates, difficulty):
        try:
            fn()
            return True
        except ActionError:
            continue
    return False


def _softened_order(candidates: List[Tuple[float, Callable]], difficulty: str) -> List[Tuple[float, Callable]]:
    """In difficoltà 'hard' ritorna l'ordine così com'è (sempre il migliore).
    Altrimenti sceglie la prima mossa con una lotteria pesata sulle 3 migliori,
    per non essere sempre perfettamente ottimale."""
    if difficulty == "hard" or len(candidates) <= 1:
        return candidates
    top_n = min(3, len(candidates))
    pool = candidates[:top_n]
    weights = [0.6, 0.25, 0.15][:top_n]
    chosen = random.choices(pool, weights=weights, k=1)[0]
    rest = [c for c in candidates if c is not chosen]
    return [chosen] + rest


# ---------------------------------------------------------------------------
# Valutazione carte
# ---------------------------------------------------------------------------

def _score_warrior(card: WarriorCard, player: Player) -> Tuple[float, str]:
    stat_total = card.att + card.git + card.dif
    score = stat_total / max(card.cost, 1)
    zone, bonus = _best_horde_region(player, card.species)
    if zone:
        return score + bonus, zone
    region = "vanguard" if (card.att + card.git) >= card.dif else _weaker_bastion_side(player)
    return score, region


def _best_horde_region(player: Player, species: str) -> Tuple[Optional[str], float]:
    """Se schierare un Guerriero di questa Specie in una Zona completa o
    avvicina un'Orda, ritorna (zona, bonus)."""
    zone_lists = {
        "vanguard": player.field.vanguard,
        "bastion_left": player.field.bastion_left.warriors,
        "bastion_right": player.field.bastion_right.warriors,
    }
    best_zone, best_bonus = None, 0.0
    for zone, lst in zone_lists.items():
        count = sum(1 for w in lst if get_card(w.base_card_id).species == species)
        if count == 2:
            bonus = 6.0
        elif count == 1:
            bonus = 2.0
        else:
            continue
        if bonus > best_bonus:
            best_zone, best_bonus = zone, bonus
    return best_zone, best_bonus


def _score_building_play(card: BuildingCard) -> float:
    return 1.0 + card.cost * 0.2


def _score_spell(card: SpellCard, player: Player) -> float:
    same_school = player.mages_by_school().get(card.school, 0)
    prodigy = same_school >= card.cost
    base = 2.0 + card.cost * 0.5
    return base * 1.6 if prodigy else base


def _score_walls(player: Player) -> float:
    my_walls = len(player.field.bastion_left.walls) + len(player.field.bastion_right.walls)
    return max(0.3, 2.0 - my_walls * 0.3)


def _raw_card_value(iid: str) -> float:
    """Valore 'grezzo' di una carta in mano, usato solo per scegliere quali
    carte convenga sacrificare come Muri (le più deboli per primo)."""
    base_id = get_base_card_id(iid)
    try:
        card = get_card(base_id)
    except KeyError:
        return 0.0
    if isinstance(card, WarriorCard):
        return (card.att + card.git + card.dif) / max(card.cost, 1)
    if isinstance(card, BuildingCard):
        return 1.0 + card.cost * 0.2
    if isinstance(card, SpellCard):
        return 1.5 + card.cost * 0.3
    return 0.0


# ---------------------------------------------------------------------------
# Evolvi
# ---------------------------------------------------------------------------

def _find_evolvable_recruit(player: Player, hero_card: WarriorCard) -> Optional[WarriorInstance]:
    for w in player.all_warriors():
        rcard = get_card(w.base_card_id)
        if isinstance(rcard, WarriorCard) and rcard.evolves_into == hero_card.id:
            return w
    return None


# ---------------------------------------------------------------------------
# Muri
# ---------------------------------------------------------------------------

def _play_walls(state: GameState, player_id: str) -> dict:
    player = state.get_player(player_id)
    ordered = sorted(player.hand, key=_raw_card_value)
    n = min(3, len(ordered))
    chosen = ordered[:n]
    side = _weaker_bastion_side(player)
    walls = [{"instance_id": iid, "bastion": side} for iid in chosen]
    return add_wall(state, player_id, walls)


def _weaker_bastion_side(player: Player) -> str:
    left = len(player.field.bastion_left.warriors) + len(player.field.bastion_left.walls)
    right = len(player.field.bastion_right.warriors) + len(player.field.bastion_right.walls)
    return "left" if left <= right else "right"


# ---------------------------------------------------------------------------
# Magie: bundle di kwargs "ragionevoli" per il targeting più comune
# ---------------------------------------------------------------------------

def _default_spell_kwargs(player: Player, opponent: Player) -> dict:
    weak_side = _weaker_enemy_bastion_side(opponent)
    kwargs: dict = {
        "target_player_id": opponent.id,
        "target_bastion_side": weak_side,
        "dest_bastion_side": weak_side,
    }

    strongest_own = _strongest_warrior(player)
    if strongest_own:
        kwargs["own_warrior_iid"] = strongest_own.instance_id

    strongest_enemy = _strongest_warrior(opponent)
    if strongest_enemy:
        kwargs["target_warrior_iid"] = strongest_enemy.instance_id
        kwargs["enemy_warrior_iid"] = strongest_enemy.instance_id

    own_side, own_wall = _own_bastion_with_wall(player)
    if own_wall:
        kwargs["bastion_side"] = own_side
        kwargs["wall_instance_id"] = own_wall.instance_id
        kwargs["warrior_iid"] = strongest_own.instance_id if strongest_own else None

    return kwargs


def _strongest_warrior(player: Player) -> Optional[WarriorInstance]:
    warriors = player.all_warriors()
    if not warriors:
        return None
    return max(warriors, key=lambda w: w.effective_att() + w.effective_git() + w.effective_dif())


def _own_bastion_with_wall(player: Player):
    if player.field.bastion_left.walls:
        return "left", player.field.bastion_left.walls[0]
    if player.field.bastion_right.walls:
        return "right", player.field.bastion_right.walls[0]
    return None, None


def _weaker_enemy_bastion_side(opponent: Player) -> str:
    dif_left, _ = defender_stats(opponent, "left")
    dif_right, _ = defender_stats(opponent, "right")
    if dif_left != dif_right:
        return "left" if dif_left < dif_right else "right"
    return "left" if len(opponent.field.bastion_left.walls) <= len(opponent.field.bastion_right.walls) else "right"


# ---------------------------------------------------------------------------
# Riposizionamento: solo per consolidare Orde
# ---------------------------------------------------------------------------

def _reposition_for_hordes(state: GameState, player_id: str) -> None:
    player = state.get_player(player_id)
    zones = {
        "vanguard": player.field.vanguard,
        "bastion_left": player.field.bastion_left.warriors,
        "bastion_right": player.field.bastion_right.warriors,
    }

    counts: dict = {}
    for zone, lst in zones.items():
        for w in lst:
            sp = get_card(w.base_card_id).species
            counts.setdefault(sp, {})[zone] = counts.get(sp, {}).get(zone, 0) + 1

    active_horde_keys = {f"{h['zone']}:{h['species']}" for h in player.check_horde_with_zones()}

    for zone, lst in list(zones.items()):
        for w in list(lst):
            sp = get_card(w.base_card_id).species
            per_zone = counts.get(sp, {})
            here = per_zone.get(zone, 0)
            if here >= 3 or f"{zone}:{sp}" in active_horde_keys:
                continue  # Orda già formata/attiva qui: non toccare

            target_zone = max(
                (z for z in _ZONE_NAMES if z != zone),
                key=lambda z: per_zone.get(z, 0),
                default=None,
            )
            if target_zone and per_zone.get(target_zone, 0) >= 2 and per_zone.get(target_zone, 0) > here:
                try:
                    reposition_warrior(state, player_id, w.instance_id, target_zone)
                    counts[sp][zone] = counts[sp].get(zone, 0) - 1
                    counts[sp][target_zone] = counts[sp].get(target_zone, 0) + 1
                except ActionError:
                    pass


# ---------------------------------------------------------------------------
# Battaglia: attacca sempre il Bastione con danno atteso più alto
# ---------------------------------------------------------------------------

def _bot_battle(state: GameState, player_id: str) -> None:
    player = state.get_player(player_id)
    if state.battles_remaining <= 0 or not player.field.vanguard:
        return
    targets = get_valid_attack_targets(state)
    if not targets:
        return

    att_att, att_git = attacker_stats(player)
    best_target, best_dmg = None, -1
    for t_idx, t_side in targets:
        defender = state.players[t_idx]
        def_dif, def_git = defender_stats(defender, t_side)
        _, _, total = calculate_damage(att_att, att_git, def_dif, def_git)
        if total > best_dmg:
            best_dmg, best_target = total, (t_idx, t_side)

    if best_target:
        try:
            do_battle(state, player_id, best_target[0], best_target[1])
        except ActionError:
            pass


def _opponent(state: GameState, player_id: str) -> Player:
    return next(p for p in state.players if p.id != player_id)
