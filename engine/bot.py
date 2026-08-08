"""
IA euristica di Barbacane, per la modalità "Sfida un Bot".

Nessuna ricerca multi-turno (con mano avversaria nascosta, tiri di D10 e
decine di effetti diversi, prevedere le risposte dell'avversario sarebbe uno
sforzo enorme per un guadagno dubbio). Il bot però pianifica le PROPRIE due
azioni del turno insieme, non una alla volta: valutare le azioni in modo
puramente "greedy" (la migliore, poi la migliore delle rimanenti) spreca
spesso Mana o sinergie che una coppia diversa avrebbe sfruttato meglio.

Quattro difficoltà:
- "easy":   il bot casuale storico del motore (random_bot_turn), usato
            così com'è — nessuna strategia reale.
- "normal": valuta le azioni una alla volta (greedy) con punteggio euristico,
            e sceglie con una lotteria pesata sulle 3 migliori (non sempre la
            più forte), per restare imperfetto e battibile.
- "hard":   valuta le COPPIE di azioni del turno (simulando la 1a per capire
            quale lascia la 2a migliore, tramite una copia dello stato) usando
            un punteggio statico del campo, e sceglie sempre la combinazione
            con la valutazione più alta — nessuna casualità.
- "expert": come "hard", ma la copia di simulazione prosegue fino a fine
            turno (Riposizionamento, Orda, Battaglia inclusi) prima di
            valutare: la scelta delle 2 azioni è quindi ottimizzata per il
            danno/Vite effettivamente ottenuti QUESTO turno, non per un
            punteggio statico del campo. Raggio di ricerca più ampio.
"""

from __future__ import annotations
import random
from typing import List, Optional, Tuple

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
from engine.game import end_turn, random_bot_turn, do_battle, check_fucina_after_action, _bot_try_horde

# Magie con targeting troppo specifico (assegnazione multipla, scelta di un
# Trono, scambio di Bastioni tra due giocatori) per un bundle di kwargs
# generico: il bot semplicemente non le gioca, invece di sprecarle a vuoto.
_SPELL_EFFECT_EXCLUDE = {"regicidio_effect", "telecinesi_effect", "bastioncontrario_effect"}

_ZONE_NAMES = ("vanguard", "bastion_left", "bastion_right")

# Uno "spec" è una tupla (tipo, ...parametri) che descrive un'azione in modo
# indipendente dallo stato su cui verrà eseguita: permette di generare i
# candidati una volta e poi applicarli sia allo stato reale sia a una copia
# di simulazione (per il lookahead di "hard").
ActionSpec = Tuple


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
    _maybe_fucina_bonus_action(state, player_id, difficulty)
    _reposition_for_hordes(state, player_id)
    _bot_try_horde(state, state.get_player(player_id))
    _bot_battle(state, player_id)
    end_turn(state)


def _maybe_fucina_bonus_action(state: GameState, player_id: str, difficulty: str) -> None:
    """Se una Fucina base concede un'Azione extra dopo aver esaurito le due
    normali, giocala anche lei invece di sprecarla."""
    player = state.get_player(player_id)
    result = check_fucina_after_action(state, player)
    if result and player.actions_remaining > 0:
        _play_actions(state, player_id, difficulty)


# ---------------------------------------------------------------------------
# Fase Azioni
# ---------------------------------------------------------------------------

def _play_actions(state: GameState, player_id: str, difficulty: str) -> None:
    player = state.get_player(player_id)
    while player.actions_remaining > 0:
        if difficulty in ("hard", "expert") and player.actions_remaining >= 2:
            done = _play_best_pair(state, player_id, difficulty)
        else:
            done = _play_best_single(state, player_id, difficulty)
        if not done:
            break


def _play_best_single(state: GameState, player_id: str, difficulty: str) -> bool:
    """Valuta le azioni disponibili in questo momento e tenta la migliore
    (con eventuale margine di casualità). Ritorna True se una è riuscita."""
    candidates = _generate_candidates(state, player_id, difficulty)
    if not candidates:
        return False
    candidates.sort(key=lambda c: c[0], reverse=True)
    for _, spec in _softened_order(candidates, difficulty):
        try:
            _apply_spec(state, player_id, spec)
            return True
        except ActionError:
            continue
    return False


# raggio di ricerca (candidati esaminati per la 1a e la 2a azione) per coppia
_BEAM = {"hard": (5, 3), "expert": (7, 4)}


def _play_best_pair(state: GameState, player_id: str, difficulty: str) -> bool:
    """Per 'hard'/'expert': tra le migliori azioni possibili ora, sceglie
    quella che porta al MIGLIOR ESITO dopo aver giocato anche la seconda
    azione del turno di conseguenza — non semplicemente la migliore "sul
    momento". Prova ogni combinazione su una copia dello stato, sceglie la
    coppia con la valutazione più alta, poi esegue solo la prima mossa scelta
    sullo stato reale (la seconda verrà rivalutata al giro successivo)."""
    beam_first, beam_second = _BEAM[difficulty]

    candidates = _generate_candidates(state, player_id, difficulty)
    if not candidates:
        return False
    candidates.sort(key=lambda c: c[0], reverse=True)
    top_first = candidates[:beam_first]

    best_spec, best_value = None, float("-inf")
    for _, spec1 in top_first:
        sim = state.model_copy(deep=True)
        try:
            _apply_spec(sim, player_id, spec1)
        except ActionError:
            continue

        # Valore raggiungibile con SOLO la prima azione (nel caso la seconda
        # non porti a nulla di meglio, es. mano vuota dopo aver giocato).
        best_for_this_first = _evaluate_outcome(sim, player_id, difficulty)

        second_candidates = _generate_candidates(sim, player_id, difficulty)
        second_candidates.sort(key=lambda c: c[0], reverse=True)
        for _, spec2 in second_candidates[:beam_second]:
            sim2 = sim.model_copy(deep=True)
            try:
                _apply_spec(sim2, player_id, spec2)
            except ActionError:
                continue
            best_for_this_first = max(best_for_this_first, _evaluate_outcome(sim2, player_id, difficulty))

        if best_for_this_first > best_value:
            best_value, best_spec = best_for_this_first, spec1

    if best_spec is None:
        return False
    try:
        _apply_spec(state, player_id, best_spec)
        return True
    except ActionError:
        return False


def _evaluate_outcome(sim: GameState, player_id: str, difficulty: str) -> float:
    """'hard' valuta lo stato del campo così com'è dopo le azioni. 'expert'
    prosegue la simulazione fino a fine turno (Riposizionamento, Orda,
    Battaglia) su una COPIA separata, così la scelta delle 2 azioni è
    ottimizzata per il risultato reale del turno, non per un proxy statico —
    e sottrae anche il rischio difensivo: quanto danno subirebbe al PROSSIMO
    turno dell'avversario, calcolato col suo attuale potenziale offensivo
    (informazione pubblica: Guerrieri in Avanscoperta visibili a tutti). Così
    non pianifica solo per il turno in corso, ma pesa anche il contraccolpo —
    es. preferisce rinforzare un Bastione debole invece di sovraccaricare
    l'Avanscoperta, se l'avversario è già pronto a colpire forte."""
    if difficulty != "expert":
        return _evaluate_board(sim, player_id)

    turn_sim = sim.model_copy(deep=True)
    opponent_id = _opponent(turn_sim, player_id).id
    opp_lives_before = turn_sim.get_player(opponent_id).lives

    _reposition_for_hordes(turn_sim, player_id)
    _bot_try_horde(turn_sim, turn_sim.get_player(player_id))
    _bot_battle(turn_sim, player_id)

    opp_lives_after = turn_sim.get_player(opponent_id).lives
    life_swing = opp_lives_before - opp_lives_after

    value = _evaluate_board(turn_sim, player_id) + life_swing * 10.0
    value -= _expected_incoming_damage(turn_sim, player_id, opponent_id) * 2.5
    return value


def _expected_incoming_damage(state: GameState, player_id: str, opponent_id: str) -> float:
    """Stima il danno che l'avversario infliggerebbe se attaccasse ORA il mio
    Bastione più conveniente per lui, usando il SUO attuale potenziale
    offensivo (pubblico) contro le MIE difese risultanti da questa
    simulazione. Non richiede conoscere la sua mano: è lo stesso calcolo che
    farebbe lui stesso guardando il campo (vedi _bot_battle)."""
    player = state.get_player(player_id)
    opponent = state.get_player(opponent_id)
    if not opponent.field.vanguard:
        return 0.0
    att_att, att_git = attacker_stats(opponent)
    worst = 0.0
    for side in ("left", "right"):
        def_dif, def_git = defender_stats(player, side)
        _, _, total = calculate_damage(att_att, att_git, def_dif, def_git)
        walls = len(player.field.bastion_left.walls if side == "left" else player.field.bastion_right.walls)
        unabsorbed = max(0.0, total - walls)
        worst = max(worst, unabsorbed)
    return worst


def _softened_order(candidates: List[Tuple[float, ActionSpec]], difficulty: str) -> List[Tuple[float, ActionSpec]]:
    """Sceglie la prima mossa con una lotteria pesata sulle 3 migliori, per
    non essere sempre perfettamente ottimale (usato da 'normal')."""
    if len(candidates) <= 1:
        return candidates
    top_n = min(3, len(candidates))
    pool = candidates[:top_n]
    weights = [0.6, 0.25, 0.15][:top_n]
    chosen = random.choices(pool, weights=weights, k=1)[0]
    rest = [c for c in candidates if c is not chosen]
    return [chosen] + rest


def _generate_candidates(state: GameState, player_id: str, difficulty: str = "normal") -> List[Tuple[float, ActionSpec]]:
    """Genera tutte le azioni legalmente tentabili in questo momento, con il
    loro punteggio euristico, come "spec" indipendenti dallo stato. In
    'hard'/'expert' i pesi favoriscono di più lo sviluppo del campo (Guerrieri
    via via più grossi, Orde, Evoluzioni) rispetto a 'normal', che pesa quasi
    solo l'efficienza statistiche/costo."""
    player = state.get_player(player_id)
    opponent = _opponent(state, player_id)
    hard = difficulty in ("hard", "expert")
    candidates: List[Tuple[float, ActionSpec]] = []

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
                score, region = _score_warrior(card, player, hard)
                candidates.append((score, ("play_warrior", iid, region)))
                if hard:
                    # 'hard' lascia che sia la valutazione della coppia di
                    # azioni a scegliere tra Avanscoperta (attacco) e
                    # Bastione (difesa), invece di deciderlo con una regola
                    # fissa uguale per ogni carta.
                    alt_region = _weaker_bastion_side(player) if region == "vanguard" else "vanguard"
                    if alt_region != region:
                        candidates.append((score * 0.95, ("play_warrior", iid, alt_region)))

        elif isinstance(card, BuildingCard):
            if player.mana_remaining >= card.cost:
                candidates.append((_score_building_play(card, hard), ("play_building", iid)))

        elif isinstance(card, SpellCard):
            if card.effect_id in _SPELL_EFFECT_EXCLUDE:
                continue
            mages_count = len(player.mages_in_field())
            if mages_count >= card.cost:
                score = _score_spell(card, player)
                kwargs = _default_spell_kwargs(player, opponent)
                candidates.append((score, ("play_spell", iid, kwargs)))

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
                candidates.append((14.0 if hard else 8.0, ("evolve", recruit.instance_id, iid)))

    # Completa Costruzioni incomplete già in campo
    for b in player.field.village.buildings:
        if b.completed:
            continue
        card = get_card(b.base_card_id)
        if isinstance(card, BuildingCard) and player.mana_remaining >= card.completion_cost:
            base_score = 4.0 + card.completion_cost * 0.3
            candidates.append((base_score * 1.5 if hard else base_score, ("complete_building", b.instance_id)))

    # Muri: opzione sempre disponibile se c'è qualcosa in mano — 'hard' le
    # evita quando possibile, preferendo sviluppare il campo
    if player.hand:
        ordered = sorted(player.hand, key=_raw_card_value)
        n = min(3, len(ordered))
        side = _weaker_bastion_side(player)
        walls = [{"instance_id": iid, "bastion": side} for iid in ordered[:n]]
        wall_score = _score_walls(player)
        candidates.append((wall_score * 0.5 if hard else wall_score, ("add_wall", walls)))

    return candidates


def _apply_spec(state: GameState, player_id: str, spec: ActionSpec) -> dict:
    """Esegue uno spec generato da _generate_candidates sullo stato dato
    (reale o di simulazione). Propaga ActionError se non più valido."""
    kind = spec[0]
    if kind == "play_warrior":
        _, iid, region = spec
        return play_warrior(state, player_id, iid, region)
    if kind == "play_building":
        _, iid = spec
        return play_building(state, player_id, iid)
    if kind == "play_spell":
        _, iid, kwargs = spec
        return play_spell(state, player_id, iid, **kwargs)
    if kind == "evolve":
        _, recruit_iid, hero_iid = spec
        return evolve_warrior(state, player_id, recruit_iid, hero_iid)
    if kind == "complete_building":
        _, b_iid = spec
        return complete_building(state, player_id, b_iid)
    if kind == "add_wall":
        _, walls = spec
        return add_wall(state, player_id, walls)
    raise ValueError(f"spec sconosciuto: {kind}")


# ---------------------------------------------------------------------------
# Valutazione dello stato (usata solo dal lookahead di "hard")
# ---------------------------------------------------------------------------

def _evaluate_board(state: GameState, player_id: str) -> float:
    """Punteggio complessivo di quanto sia buono lo stato per player_id in
    questo momento. Rispecchia le regole reali della Battaglia: conta solo il
    MASSIMO Attacco/Gittata in Avanscoperta e il MASSIMO Difesa/Gittata per
    Bastione (impilare più Guerrieri nella stessa Zona non aumenta la
    Battaglia, quindi non deve sembrare "gratis" anche alla valutazione)."""
    player = state.get_player(player_id)
    score = 0.0

    att_att, att_git = attacker_stats(player)
    score += att_att * 1.0 + att_git * 1.0

    for side in ("left", "right"):
        def_dif, def_git = defender_stats(player, side)
        score += def_dif * 0.8 + def_git * 0.4

    # Guerrieri oltre al massimo che conta in Battaglia hanno comunque un
    # valore residuo minore (ridondanza, materiale per le Orde)
    score += sum(w.effective_att() + w.effective_git() + w.effective_dif() for w in player.all_warriors()) * 0.08

    for b in player.field.village.buildings:
        score += 2.0 if b.completed else 1.0

    score += (len(player.field.bastion_left.walls) + len(player.field.bastion_right.walls)) * 0.4
    score += player.lives * 3.0
    score += len(player.check_horde_with_zones()) * 4.0

    # Mana avanzato e non speso è un'occasione persa
    score -= player.mana_remaining * 0.3

    # La mano residua ha comunque un valore (carte per i turni successivi)
    score += sum(_raw_card_value(iid) for iid in player.hand) * 0.3

    return score


# ---------------------------------------------------------------------------
# Valutazione carte
# ---------------------------------------------------------------------------

def _score_warrior(card: WarriorCard, player: Player, hard: bool = False) -> Tuple[float, str]:
    stat_total = card.att + card.git + card.dif
    score = stat_total / max(card.cost, 1)
    if hard:
        # 'hard' pesa anche il valore assoluto delle statistiche, non solo
        # l'efficienza per Mana: sviluppa Guerrieri via via più forti invece
        # di preferire sempre il più "economico".
        score += stat_total * 0.15
    zone, bonus = _best_horde_region(player, card.species)
    if zone:
        if hard:
            bonus *= 1.5
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


def _score_building_play(card: BuildingCard, hard: bool = False) -> float:
    base = 1.0 + card.cost * 0.2
    return base * 1.3 if hard else base


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
