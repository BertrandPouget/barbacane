"""
IA euristica di Barbacane, per la modalità "Sfida un Bot".

Nessuna ricerca multi-turno (con mano avversaria nascosta, tiri di D10 e
decine di effetti diversi, prevedere le risposte dell'avversario sarebbe uno
sforzo enorme per un guadagno dubbio). Il bot però pianifica le PROPRIE due
azioni del turno insieme, non una alla volta: valutare le azioni in modo
puramente "greedy" (la migliore, poi la migliore delle rimanenti) spreca
spesso Mana o sinergie che una coppia diversa avrebbe sfruttato meglio.

Tre difficoltà:
- "easy":   valuta le azioni una alla volta (greedy) con punteggio euristico,
            e sceglie con una lotteria pesata sulle 3 migliori (non sempre la
            più forte), per restare imperfetto e battibile.
- "normal": valuta le COPPIE di azioni del turno (simulando la 1a per capire
            quale lascia la 2a migliore, tramite una copia dello stato) usando
            un punteggio statico del campo, e sceglie sempre la combinazione
            con la valutazione più alta — nessuna casualità.
- "hard":   come "normal", ma la copia di simulazione prosegue fino a fine
            turno (Riposizionamento, Orda, Battaglia inclusi) prima di
            valutare: la scelta delle 2 azioni è quindi ottimizzata per il
            danno/Vite effettivamente ottenuti QUESTO turno, non per un
            punteggio statico del campo. Raggio di ricerca più ampio.
            In più stima la MINACCIA del prossimo turno avversario
            (_ThreatModel): conta le carte come farebbe un giocatore esperto
            (composizione del mazzo nota, meno le carte visibili) per
            campionare le mani possibili dell'avversario, e con quelle
            valuta quanto danno potrebbe subire ogni suo Bastione. Il
            Riposizionamento (_optimize_reposition) bilancia quindi attacco
            di questo turno e difesa del prossimo, invece di ammassare tutto
            in Avanscoperta.

Partite da 3–4 giocatori: ogni Bastione è esposto solo al vicino vivo da
quel lato (vedi battle.adjacent_bastions), quindi la minaccia è stimata per
vicino e per lato, la Battaglia considera solo i Bastioni adiacenti e le
Magie scelgono come bersaglio l'avversario più vicino all'eliminazione. Con
un solo avversario tutto si riduce al comportamento 1 contro 1.
"""

from __future__ import annotations
import random
import time
from collections import Counter
from itertools import combinations
from typing import Dict, List, Optional, Tuple

from engine.models import GameState, Player, WarriorInstance
from engine.cards import get_card, WarriorCard, SpellCard, BuildingCard
from engine.deck import get_base_card_id
from engine.actions import (
    ActionError,
    _madeleine_free_action,
    _prodigy_active,
    _troni_blocked,
    play_warrior,
    play_building,
    play_spell,
    complete_building,
    add_wall,
    evolve_warrior,
    reposition_warrior,
    eracle_destroy,
)
from engine.battle import (
    adjacent_bastions,
    get_valid_attack_targets,
    attacker_stats,
    defender_stats,
    calculate_damage,
    battle_building_bonus,
)
from engine.game import end_turn, do_battle, check_fucina_after_action, _bot_try_horde

# Magie con targeting troppo specifico (assegnazione multipla, scelta di un
# Trono, scambio di Bastioni tra due giocatori) per un bundle di kwargs
# generico: il bot semplicemente non le gioca, invece di sprecarle a vuoto.
_SPELL_EFFECT_EXCLUDE = {"regicidio_effect", "telecinesi_effect", "bastioncontrario_effect"}

_ZONE_NAMES = ("vanguard", "bastion_left", "bastion_right")

# Uno "spec" è una tupla (tipo, ...parametri) che descrive un'azione in modo
# indipendente dallo stato su cui verrà eseguita: permette di generare i
# candidati una volta e poi applicarli sia allo stato reale sia a una copia
# di simulazione (per il lookahead di "normal" e "hard").
ActionSpec = Tuple


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Partite salvate prima del passaggio da 4 a 3 livelli
_LEGACY_DIFFICULTY = {"expert": "hard"}


# Tempo massimo di riflessione di 'hard' per la fase Azioni di un turno. La
# ricerca esamina prima i candidati più promettenti, quindi a tempo scaduto
# gioca la migliore mossa trovata fin lì invece di far aspettare il tavolo
# (e di occupare la CPU del server, condivisa con le altre partite).
HARD_THINK_SECONDS = 4.0


def run_bot_turn(state: GameState, difficulty: str = "normal", on_step=None) -> None:
    """Gioca l'intero turno del giocatore corrente (deve essere il Bot).
    `on_step` (opzionale) viene chiamata dopo ogni mossa sullo stato reale
    (azione, riposizionamento, Orda, Battaglia), prima della fine del turno:
    serve a mostrare al tavolo il turno del Bot un passo alla volta."""
    step = on_step or (lambda: None)
    difficulty = _LEGACY_DIFFICULTY.get(difficulty, difficulty)
    player_id = state.current_player.id
    deadline = time.monotonic() + HARD_THINK_SECONDS if difficulty == "hard" else None
    threat = _ThreatModel(state, player_id) if difficulty == "hard" else None
    _play_actions(state, player_id, difficulty, threat, deadline, step)
    _maybe_fucina_bonus_action(state, player_id, difficulty, threat, deadline, step)
    if threat is not None:
        _optimize_reposition(state, player_id, threat)
    else:
        _reposition_for_hordes(state, player_id)
    step()
    _bot_try_horde(state, state.get_player(player_id))
    step()
    _bot_battle(state, player_id, smart=threat is not None)
    step()
    end_turn(state)


def _maybe_fucina_bonus_action(state: GameState, player_id: str, difficulty: str,
                               threat: Optional["_ThreatModel"] = None,
                               deadline: Optional[float] = None, step=None) -> None:
    """Se una Fucina base concede un'Azione extra dopo aver esaurito le due
    normali, giocala anche lei invece di sprecarla."""
    player = state.get_player(player_id)
    result = check_fucina_after_action(state, player)
    if result and player.actions_remaining > 0:
        _play_actions(state, player_id, difficulty, threat, deadline, step)


# ---------------------------------------------------------------------------
# Fase Azioni
# ---------------------------------------------------------------------------

def _play_actions(state: GameState, player_id: str, difficulty: str,
                  threat: Optional["_ThreatModel"] = None,
                  deadline: Optional[float] = None, step=None) -> None:
    player = state.get_player(player_id)
    _play_free_spells(state, player_id, difficulty, threat, step)
    while player.actions_remaining > 0:
        if difficulty == "hard":
            # Anche con una sola Azione rimasta la valutazione a fine turno
            # (minaccia inclusa) è più affidabile del punteggio statico.
            done = _play_best_pair(state, player_id, difficulty, threat, deadline)
        elif difficulty == "normal" and player.actions_remaining >= 2:
            done = _play_best_pair(state, player_id, difficulty)
        else:
            done = _play_best_single(state, player_id, difficulty)
        if not done:
            break
        if step:
            step()
        _play_free_spells(state, player_id, difficulty, threat, step)


def _play_free_spells(state: GameState, player_id: str, difficulty: str,
                      threat: Optional["_ThreatModel"] = None, step=None) -> None:
    """Orda di Madeleine: gli Incantesimi a costo 1 non consumano Azioni, quindi
    si giocano a parte (anche ad Azioni esaurite), senza togliere posto alle
    Azioni del turno. 'easy' li gioca sempre; 'normal'/'hard' solo se la
    simulazione non peggiora l'esito."""
    while True:
        player = state.get_player(player_id)
        free = [
            c for c in _generate_candidates(state, player_id, difficulty)
            if c[1][0] == "play_spell"
            and _madeleine_free_action(player, get_card(get_base_card_id(c[1][1])))
        ]
        if not free:
            return
        free.sort(key=lambda c: c[0], reverse=True)
        baseline = None if difficulty == "easy" else _evaluate_outcome(state, player_id, difficulty, threat)
        played = False
        for _, spec in free:
            if baseline is not None:
                sim = _sim_copy(state)
                try:
                    _apply_spec(sim, player_id, spec)
                except ActionError:
                    continue
                if _evaluate_outcome(sim, player_id, difficulty, threat) < baseline:
                    continue
            try:
                _apply_spec(state, player_id, spec)
                played = True
                break
            except ActionError:
                continue
        if not played:
            return
        if step:
            step()


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
_BEAM = {"normal": (5, 3), "hard": (10, 6)}


def _sim_copy(state: GameState) -> GameState:
    """Copia di simulazione senza il log della partita: il log cresce a ogni
    azione, alla simulazione non serve e copiarlo ogni volta domina il costo
    del lookahead."""
    log = state.log
    state.log = []
    try:
        return state.model_copy(deep=True)
    finally:
        state.log = log


def _beam(candidates: List[Tuple[float, ActionSpec]], width: int, difficulty: str) -> List[Tuple[float, ActionSpec]]:
    """Le `width` migliori per punteggio euristico. In 'hard' i Muri entrano
    sempre nel raggio: il loro valore dipende dalla minaccia avversaria, che
    il punteggio euristico non vede, quindi decide la simulazione."""
    candidates = sorted(candidates, key=lambda c: c[0], reverse=True)
    top = candidates[:width]
    if difficulty == "hard":
        top += [c for c in candidates[width:] if c[1][0] == "add_wall"]
    return top


def _play_best_pair(state: GameState, player_id: str, difficulty: str,
                    threat: Optional["_ThreatModel"] = None,
                    deadline: Optional[float] = None) -> bool:
    """Per 'normal'/'hard': tra le migliori azioni possibili ora, sceglie
    quella che porta al MIGLIOR ESITO dopo aver giocato anche la seconda
    azione del turno di conseguenza — non semplicemente la migliore "sul
    momento". Prova ogni combinazione su una copia dello stato, sceglie la
    coppia con la valutazione più alta, poi esegue solo la prima mossa scelta
    sullo stato reale (la seconda verrà rivalutata al giro successivo).
    Con `deadline` (time.monotonic) la ricerca si ferma a tempo scaduto, dopo
    aver esaminato almeno un candidato: sono in ordine di promessa."""
    beam_first, beam_second = _BEAM[difficulty]

    candidates = _generate_candidates(state, player_id, difficulty)
    if not candidates:
        return False
    top_first = _beam(candidates, beam_first, difficulty)

    best_spec, best_value = None, float("-inf")
    if difficulty == "hard":
        # 'hard' può anche non fare nulla: tenere una carta in mano è
        # meglio che sprecarla in una mossa che peggiora la posizione.
        best_value = _evaluate_outcome(state, player_id, difficulty, threat)
    evaluated = 0
    for _, spec1 in top_first:
        if deadline is not None and evaluated and time.monotonic() > deadline:
            break
        evaluated += 1
        sim = _sim_copy(state)
        try:
            _apply_spec(sim, player_id, spec1)
        except ActionError:
            continue

        # Valore raggiungibile con SOLO la prima azione (nel caso la seconda
        # non porti a nulla di meglio, es. mano vuota dopo aver giocato).
        best_for_this_first = _evaluate_outcome(sim, player_id, difficulty, threat)

        second_candidates = []
        if sim.get_player(player_id).actions_remaining > 0:
            second_candidates = _beam(_generate_candidates(sim, player_id, difficulty), beam_second, difficulty)
        for _, spec2 in second_candidates:
            if deadline is not None and time.monotonic() > deadline:
                break
            sim2 = _sim_copy(sim)
            try:
                _apply_spec(sim2, player_id, spec2)
            except ActionError:
                continue
            best_for_this_first = max(best_for_this_first, _evaluate_outcome(sim2, player_id, difficulty, threat))

        if best_for_this_first > best_value:
            best_value, best_spec = best_for_this_first, spec1

    if best_spec is None:
        return False
    try:
        _apply_spec(state, player_id, best_spec)
        return True
    except ActionError:
        return False


def _evaluate_outcome(sim: GameState, player_id: str, difficulty: str,
                      threat: Optional["_ThreatModel"] = None) -> float:
    """'normal' valuta lo stato del campo così com'è dopo le azioni. 'hard'
    prosegue la simulazione fino a fine turno (Riposizionamento, Orda,
    Battaglia) su una COPIA separata, così la scelta delle 2 azioni è
    ottimizzata per il risultato reale del turno, non per un proxy statico —
    e sottrae la perdita attesa al PROSSIMO turno dell'avversario
    (_ThreatModel), così pesa anche il contraccolpo: es. preferisce
    rinforzare un Bastione scoperto invece di sovraccaricare l'Avanscoperta,
    se l'avversario è pronto a colpire forte."""
    if difficulty != "hard":
        return _evaluate_board(sim, player_id)
    if threat is None:
        threat = _ThreatModel(sim, player_id)

    turn_sim = _sim_copy(sim)
    before = {o.id: (o.lives, _total_walls(o)) for o in _opponents(turn_sim, player_id)}

    _optimize_reposition(turn_sim, player_id, threat)
    _bot_try_horde(turn_sim, turn_sim.get_player(player_id))
    _bot_battle(turn_sim, player_id, smart=True)

    if not _opponents(turn_sim, player_id):
        return 1000.0

    value = _evaluate_board(turn_sim, player_id)
    for oid, (lives_before, walls_before) in before.items():
        opponent = turn_sim.get_player(oid)
        if not opponent.is_alive:
            value += _ELIMINATION_VALUE
        value += (lives_before - opponent.lives) * _LIFE_VALUE
        value += max(0, walls_before - _total_walls(opponent)) * _WALL_VALUE
    value -= threat.expected_loss(turn_sim, turn_sim.get_player(player_id))
    return value


def _softened_order(candidates: List[Tuple[float, ActionSpec]], difficulty: str) -> List[Tuple[float, ActionSpec]]:
    """Sceglie la prima mossa con una lotteria pesata sulle 3 migliori, per
    non essere sempre perfettamente ottimale (usato da 'easy')."""
    if len(candidates) <= 1:
        return candidates
    top_n = min(3, len(candidates))
    pool = candidates[:top_n]
    weights = [0.6, 0.25, 0.15][:top_n]
    chosen = random.choices(pool, weights=weights, k=1)[0]
    rest = [c for c in candidates if c is not chosen]
    return [chosen] + rest


def _generate_candidates(state: GameState, player_id: str, difficulty: str = "easy") -> List[Tuple[float, ActionSpec]]:
    """Genera tutte le azioni legalmente tentabili in questo momento, con il
    loro punteggio euristico, come "spec" indipendenti dallo stato. In
    'normal'/'hard' i pesi favoriscono di più lo sviluppo del campo (Guerrieri
    via via più grossi, Orde, Evoluzioni) rispetto a 'easy', che pesa quasi
    solo l'efficienza statistiche/costo."""
    player = state.get_player(player_id)
    spell_targets = _spell_target_order(state, player)
    planner = difficulty in ("normal", "hard")
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
                score, region = _score_warrior(card, player, planner)
                candidates.append((score, ("play_warrior", iid, region)))
                if planner:
                    # 'normal' lascia che sia la valutazione della coppia di
                    # azioni a scegliere tra Avanscoperta (attacco) e
                    # Bastione (difesa), invece di deciderlo con una regola
                    # fissa uguale per ogni carta.
                    alt_region = _weaker_bastion_side(player) if region == "vanguard" else "vanguard"
                    if alt_region != region:
                        candidates.append((score * 0.95, ("play_warrior", iid, alt_region)))

        elif isinstance(card, BuildingCard):
            if player.mana_remaining >= card.cost:
                # Il Trono va assegnato subito a un proprio Guerriero: senza
                # bersaglio play_building lo rifiuta, quindi o si sceglie qui
                # a chi darlo o non è una mossa disponibile.
                target_w = None
                if base_id == "trono":
                    if _troni_blocked(state, player):
                        continue  # Orda Joseph avversaria: i Troni sono vietati
                    target_w = _best_trono_target(player)
                    if target_w is None:
                        continue
                candidates.append((
                    _score_building_play(card, planner),
                    ("play_building", iid, target_w),
                ))

        elif isinstance(card, SpellCard):
            if card.effect_id in _SPELL_EFFECT_EXCLUDE:
                continue
            mages_count = len(player.mages_in_field())
            if mages_count >= card.cost and spell_targets:
                base_score = _score_spell(card, player)
                # 'easy'/'normal' puntano solo l'avversario prioritario; 'hard'
                # lascia che la simulazione valuti anche gli altri.
                for rank, target in enumerate(spell_targets if difficulty == "hard" else spell_targets[:1]):
                    score = base_score * (1 - 0.02 * rank)
                    kwargs = _default_spell_kwargs(player, target)
                    candidates.append((score, ("play_spell", iid, kwargs)))
                    if difficulty == "hard":
                        # Il Bastione bersaglio "più debole per DIF" non è sempre
                        # il migliore (es. Ardolancio conviene dove ci sono meno
                        # Muri): la simulazione prova anche l'altro.
                        other = "right" if kwargs["target_bastion_side"] == "left" else "left"
                        candidates.append((score * 0.99, ("play_spell", iid, {
                            **kwargs, "target_bastion_side": other, "dest_bastion_side": other,
                        })))

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
                candidates.append((14.0 if planner else 8.0, ("evolve", recruit.instance_id, iid)))

    # Completa Costruzioni incomplete già in campo
    for b in player.field.village.buildings:
        if b.completed:
            continue
        card = get_card(b.base_card_id)
        if isinstance(card, BuildingCard) and player.mana_remaining >= card.completion_cost:
            base_score = 4.0 + card.completion_cost * 0.3
            candidates.append((base_score * 1.5 if planner else base_score, ("complete_building", b.instance_id)))

    # Muri: opzione sempre disponibile se c'è qualcosa in mano — 'normal' le
    # evita quando possibile, preferendo sviluppare il campo
    if player.hand:
        values = _hand_values(player)
        ordered = sorted(player.hand, key=values.get)
        n = min(3, len(ordered))
        side = _weaker_bastion_side(player)
        walls = [{"instance_id": iid, "bastion": side} for iid in ordered[:n]]
        wall_score = _score_walls(player)
        candidates.append((wall_score * 0.5 if planner else wall_score, ("add_wall", walls)))
        if difficulty == "hard":
            # Lato e quantità dei Muri li sceglie la simulazione, in base alla
            # minaccia: anche un solo Muro (tenendo le altre carte in mano) o
            # tutti sull'altro Bastione.
            other = "right" if side == "left" else "left"
            variants = {(other, n), (side, 1), (other, 1)} - {(side, n)}
            for s, count in sorted(variants):
                walls_v = [{"instance_id": iid, "bastion": s} for iid in ordered[:count]]
                candidates.append((wall_score * 0.5, ("add_wall", walls_v)))

    return candidates


def _apply_spec(state: GameState, player_id: str, spec: ActionSpec) -> dict:
    """Esegue uno spec generato da _generate_candidates sullo stato dato
    (reale o di simulazione). Propaga ActionError se non più valido."""
    kind = spec[0]
    if kind == "play_warrior":
        _, iid, region = spec
        return play_warrior(state, player_id, iid, region)
    if kind == "play_building":
        _, iid, target_warrior_iid = spec
        return play_building(state, player_id, iid, target_warrior_iid)
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
# Valutazione dello stato (usata dal lookahead di "normal" e "hard")
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

    # La mano ha un valore (carte per i turni successivi), ma a fine turno si
    # pesca fino al limite: una carta spesa (es. come Muro) viene rimpiazzata
    # da una pescata, quindi ogni posto libero vale una pesca media.
    free_slots = max(0, _HAND_LIMIT - len(player.hand))
    score += (sum(_hand_values(player).values()) + free_slots * _expected_draw_value(state, player)) * 0.3

    return score


# ---------------------------------------------------------------------------
# Valutazione carte
# ---------------------------------------------------------------------------

def _score_warrior(card: WarriorCard, player: Player, planner: bool = False) -> Tuple[float, str]:
    stat_total = card.att + card.git + card.dif
    score = stat_total / max(card.cost, 1)
    if planner:
        # 'normal' pesa anche il valore assoluto delle statistiche, non solo
        # l'efficienza per Mana: sviluppa Guerrieri via via più forti invece
        # di preferire sempre il più "economico".
        score += stat_total * 0.15
    zone, bonus = _best_horde_region(player, card.species)
    if zone:
        if planner:
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


def _score_building_play(card: BuildingCard, planner: bool = False) -> float:
    base = 1.0 + card.cost * 0.2
    return base * 1.3 if planner else base


def _best_trono_target(player: Player) -> Optional[str]:
    """Guerriero a cui conviene assegnare il Trono: rende sempre attivo il suo
    effetto Orda, quindi ha senso solo su un Guerriero che un effetto Orda ce
    l'ha. A parità, il più forte (è anche quello che si vuole tenere in campo).
    Ritorna None se nessun Guerriero è idoneo."""
    best, best_value = None, float("-inf")
    for w in player.all_warriors():
        try:
            card = get_card(w.base_card_id)
        except KeyError:
            continue
        if not isinstance(card, WarriorCard) or not card.horde_effect_id:
            continue
        value = card.att + card.git + card.dif
        if value > best_value:
            best, best_value = w.instance_id, value
    return best


def _score_spell(card: SpellCard, player: Player) -> float:
    prodigy = _prodigy_active(player, card.school, card.cost)
    base = 2.0 + card.cost * 0.5
    return base * 1.6 if prodigy else base


def _score_walls(player: Player) -> float:
    my_walls = len(player.field.bastion_left.walls) + len(player.field.bastion_right.walls)
    return max(0.3, 2.0 - my_walls * 0.3)


# Una carta che oggi non si può giocare (Eroe senza la sua Recluta, Magia
# senza Maghe) vale solo una frazione del suo valore: è il primo candidato
# a diventare Muro.
_DEAD_CARD_FACTOR = 0.25
_HAND_LIMIT = 6


def _card_value(base_id: str, player: Player, hand_bases: List[str]) -> float:
    """Valore di una carta per `player`, dato il suo campo e la sua mano.
    Un Eroe conta pieno solo se la sua Recluta è in campo o in mano; una
    Magia solo se c'è almeno una Maga in campo o in mano."""
    try:
        card = get_card(base_id)
    except KeyError:
        return 0.0
    if isinstance(card, WarriorCard):
        value = (card.att + card.git + card.dif) / max(card.cost, 1)
        if card.subtype == "hero":
            recruit = card.evolves_from
            reachable = recruit in hand_bases or any(w.base_card_id == recruit for w in player.all_warriors())
            if not reachable:
                value *= _DEAD_CARD_FACTOR
        return value
    if isinstance(card, BuildingCard):
        return 1.0 + card.cost * 0.2
    if isinstance(card, SpellCard):
        value = 1.5 + card.cost * 0.3
        mages = player.mages_in_field() or any(
            isinstance(c := get_card(b), WarriorCard) and c.species == "maga" for b in hand_bases
        )
        return value if mages else value * _DEAD_CARD_FACTOR
    return 0.0


def _hand_values(player: Player) -> Dict[str, float]:
    """Valore di ogni carta in mano (instance_id -> valore)."""
    hand_bases = [get_base_card_id(iid) for iid in player.hand]
    return {iid: _card_value(b, player, hand_bases) for iid, b in zip(player.hand, hand_bases)}


def _expected_draw_value(state: GameState, player: Player) -> float:
    """Valore medio della carta che `player` pescherà a fine turno. Conta le
    carte come per la mano avversaria (_ThreatModel): la pesca arriva
    dall'insieme delle carte che il bot non vede, ciascuna valutata rispetto
    al SUO campo e alla sua mano."""
    unseen: Counter = Counter()
    for other in state.players:
        if other.id == player.id:
            continue
        unseen.update(get_base_card_id(i) for i in other.hand)
        unseen.update(get_base_card_id(i) for i in other.life_cards)
        for b in (other.field.bastion_left, other.field.bastion_right):
            unseen.update(get_base_card_id(w.instance_id) for w in b.walls)
    unseen.update(get_base_card_id(i) for i in state.deck)
    total = sum(unseen.values())
    if not total:
        return 0.0
    hand_bases = [get_base_card_id(iid) for iid in player.hand]
    return sum(_card_value(b, player, hand_bases) * n for b, n in unseen.items()) / total


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

def _spell_target_order(state: GameState, player: Player) -> List[Player]:
    """Avversari vivi in ordine di priorità come bersaglio delle Magie: prima
    chi è più vicino all'eliminazione (meno Vite, poi meno Muri), a parità
    un vicino, che il Bot può anche attaccare in Battaglia."""
    idx = next(i for i, p in enumerate(state.players) if p.id == player.id)
    neighbors = {state.players[i].id for i, _ in adjacent_bastions(idx, state.players).values()}
    return sorted(
        _opponents(state, player.id),
        key=lambda o: (o.lives, _total_walls(o), o.id not in neighbors),
    )


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
# 'hard': perdite in Battaglia, minaccia avversaria, riposizionamento
# ---------------------------------------------------------------------------

# Valori nella stessa scala di _evaluate_board
_LIFE_VALUE = 10.0
_LETHAL_VALUE = 40.0      # l'ultima Vita: perderla significa perdere la partita
_ELIMINATION_VALUE = 20.0  # eliminare un avversario quando ne restano altri (3–4 giocatori)
_WALL_VALUE = 1.0
_NEW_HORDE_VALUE = 3.0    # Orda che si forma riposizionando (attivata subito dopo)

# Carte in mano all'avversario che cambiano il suo attacco del prossimo turno
_THREAT_BUILDINGS = {"ariete": ("att", 1), "catapulta": ("git", 1)}
_THREAT_SPELLS = {"ardolancio", "guerremoto"}


def _hit_value(damage: int, durabilities: List[int], lives: int, strip: int = 0) -> float:
    """Perdita (in punti di valutazione) di un Bastione che subisce `damage`
    Danni, dopo che `strip` Muri sono stati scartati da effetti (Ardolancio,
    Guerremoto prodigio). Rispecchia apply_damage_to_bastion: i Muri
    assorbono secondo la loro durabilità, se non bastano si perde UNA Vita."""
    stripped = min(strip, len(durabilities))
    value = stripped * _WALL_VALUE
    if damage <= 0:
        return value
    remaining = damage
    for d in durabilities[stripped:]:
        if remaining <= 0:
            break
        remaining -= d
        value += _WALL_VALUE
    if remaining > 0 and lives > 0:
        value += _LETHAL_VALUE if lives == 1 else _LIFE_VALUE
    return value


def _fossato_threshold(player: Player) -> int:
    """GIT minima per poter attaccare questo giocatore (0 = nessun Fossato)."""
    threshold = 0
    for b in player.field.village.buildings:
        if b.base_card_id == "fossato":
            threshold = max(threshold, 3 if b.completed else 1)
    return threshold


def _side_defense(warriors: List[WarriorInstance], bastion, bonus: Dict[str, int]) -> Tuple[int, int, List[int]]:
    """(DIF, GIT, durabilità dei Muri) di un Bastione con i Guerrieri dati:
    stesso calcolo di defender_stats, ma su una disposizione ipotetica."""
    durabilities = [w.durability for w in bastion.walls]
    if not warriors:
        return bastion.dif_bonus, 0, durabilities
    dif = max(w.effective_dif() for w in warriors) + bastion.dif_bonus + bonus["dif"]
    git = max(w.effective_git() for w in warriors) + bonus["git"]
    return dif, git, durabilities


def _player_defense(player: Player) -> List[Tuple[int, int, List[int]]]:
    bonus = battle_building_bonus(player)
    return [
        _side_defense(player.field.bastion_left.warriors, player.field.bastion_left, bonus),
        _side_defense(player.field.bastion_right.warriors, player.field.bastion_right, bonus),
    ]


def _next_turn_mana(state: GameState, player: Player) -> int:
    """Mana di `player` al suo prossimo turno, visto dal turno corrente."""
    if player.skip_mana_next_turn:
        return 0
    n = len(state.players)
    target = next(i for i, p in enumerate(state.players) if p.id == player.id)
    # state.turn avanza quando tocca di nuovo a chi apre il round: conta se
    # tra il giocatore corrente e `player` si passa da chi apre il round.
    turn, j = state.turn, state.current_player_index
    while j != target:
        j = (j + 1) % n
        if j == state.first_player_index:
            turn += 1
    return state.mana_for_turn(turn)


class _ThreatModel:
    """Stima quanto i vicini possono farmi perdere nei loro prossimi turni.

    Ogni mio Bastione è esposto solo al vicino vivo da quel lato; con un solo
    avversario, lui minaccia entrambi. La minaccia di ogni vicino è stimata
    da un _OpponentThreat, creato alla prima richiesta, e le perdite dei due
    lati si sommano (i vicini giocano entrambi prima del mio prossimo turno).

    Le carte che il bot non vede (mazzo, mani, Muri e Vite coperti di tutti
    gli avversari) formano un unico insieme da cui è campionata la mano di
    ciascun avversario."""

    def __init__(self, state: GameState, player_id: str):
        self._state = state
        unseen = list(state.deck)
        for other in state.players:
            if other.id == player_id:
                continue
            unseen += other.hand + other.life_cards
            unseen += [w.instance_id for b in (other.field.bastion_left, other.field.bastion_right) for w in b.walls]
        self._unseen = [get_base_card_id(iid) for iid in unseen]
        self._models: Dict[str, _OpponentThreat] = {}

    def _model(self, opponent_id: str) -> "_OpponentThreat":
        model = self._models.get(opponent_id)
        if model is None:
            opponent = self._state.get_player(opponent_id)
            model = _OpponentThreat(self._unseen, len(opponent.hand), _next_turn_mana(self._state, opponent))
            self._models[opponent_id] = model
        return model

    def expected_loss(self, state: GameState, player: Player,
                      defense: Optional[List[Tuple[int, int, List[int]]]] = None) -> float:
        """Perdita attesa di `player` ai prossimi turni dei suoi vicini in
        `state`, con la difesa data (di default quella attuale del campo)."""
        if defense is None:
            defense = _player_defense(player)
        idx = next(i for i, p in enumerate(state.players) if p.id == player.id)
        adj = adjacent_bastions(idx, state.players)
        # Il vicino di sinistra minaccia il mio Bastione sinistro (defense[0]),
        # quello di destra il destro (defense[1]).
        sides_by_opponent: Dict[int, List[int]] = {}
        sides_by_opponent.setdefault(adj["left_attacks"][0], []).append(0)
        sides_by_opponent.setdefault(adj["right_attacks"][0], []).append(1)
        total = 0.0
        for opp_idx, sides in sides_by_opponent.items():
            opponent = state.players[opp_idx]
            if opp_idx == idx or not opponent.is_alive:
                continue
            total += self._model(opponent.id).expected_loss(player, opponent, [defense[s] for s in sides])
        return total


class _OpponentThreat:
    """Stima quanto UN avversario può farmi perdere nel SUO prossimo turno.

    Conta le carte come un giocatore esperto: la composizione del mazzo è
    nota, quindi le carte che il bot non vede formano un unico insieme da cui
    la mano avversaria è estratta a caso. Il bot NON guarda la mano vera: ne
    campiona SAMPLES possibili con la dimensione pubblica della mano, e per
    ognuna calcola il miglior attacco disponibile all'avversario col Mana del
    suo prossimo turno (Guerrieri o Evoluzioni da schierare, Ariete/Catapulta,
    Ardolancio/Guerremoto per scartare Muri prima della Battaglia), sapendo
    che potrà riposizionare in Avanscoperta tutti i Guerrieri che ha in campo.
    La perdita attesa è la media, sui campioni, del suo attacco migliore
    contro il più conveniente dei miei Bastioni esposti a lui."""

    SAMPLES = 100

    def __init__(self, unseen_bases: List[str], hand_size: int, mana: int):
        k = min(hand_size, len(unseen_bases))
        rng = random.Random()
        hands: Counter = Counter()
        for _ in range(self.SAMPLES):
            hand = [b for b in rng.sample(unseen_bases, k) if self._relevant(b)]
            hands[tuple(sorted(hand))] += 1
        self.hands = list(hands.items())
        self.mana = mana
        self._cache: Dict[tuple, tuple] = {}

    @staticmethod
    def _relevant(base_id: str) -> bool:
        if base_id in _THREAT_BUILDINGS or base_id in _THREAT_SPELLS:
            return True
        try:
            return isinstance(get_card(base_id), WarriorCard)
        except KeyError:
            return False

    def _options(self, opponent: Player) -> list:
        """Ritorna (attacchi, campioni): `attacchi` è la lista degli attacchi
        possibili distinti (ATT, GIT, Muri scartati), `campioni` associa a
        ogni mano campionata (con il suo peso) le posizioni dei suoi attacchi
        non dominati. ATT = -1: nessun Guerriero, nessuna Battaglia."""
        field = opponent.all_warriors()
        key = (
            tuple((w.base_card_id, w.effective_att(), w.effective_git()) for w in field),
            tuple((b.base_card_id, b.completed) for b in opponent.field.village.buildings),
            tuple(sorted(opponent.mages_by_school().items())),
        )
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        field_att = max((w.effective_att() for w in field), default=-1)
        field_git = max((w.effective_git() for w in field), default=-1)
        on_field = {w.base_card_id for w in field}
        bonus = battle_building_bonus(opponent)
        schools = opponent.mages_by_school()
        n_mages = sum(schools.values())
        anatema = schools.get("anatema", 0)

        # Molte mani campionate hanno gli stessi attacchi possibili: ogni
        # attacco distinto compare una volta sola in `index`, e i campioni
        # vi fanno riferimento per posizione (expected_loss lo valuta 1 volta).
        index: Dict[tuple, int] = {}
        result = []
        for hand, weight in self.hands:
            # (costo Mana, ATT, GIT, +ATT, +GIT, Muri scartati)
            items = []
            for base_id in hand:
                card = get_card(base_id)
                if isinstance(card, WarriorCard):
                    if card.cost > self.mana:
                        continue
                    if card.subtype == "hero" and card.evolves_from not in on_field:
                        continue
                    items.append((card.cost, card.att, card.git, 0, 0, 0))
                elif base_id in _THREAT_BUILDINGS:
                    if card.cost <= self.mana:
                        stat, amount = _THREAT_BUILDINGS[base_id]
                        items.append((card.cost, -1, -1, amount if stat == "att" else 0, amount if stat == "git" else 0, 0))
                elif base_id == "ardolancio" and n_mages >= card.cost:
                    items.append((0, -1, -1, 0, 0, 4 if anatema >= card.cost else 2))
                elif base_id == "guerremoto" and anatema >= card.cost:
                    items.append((0, -1, -1, 0, 0, 2))

            options = set()
            for r in (0, 1, 2):
                for combo in combinations(items, r):
                    if sum(i[0] for i in combo) > self.mana:
                        continue
                    att = max([field_att] + [i[1] for i in combo])
                    git = max([field_git] + [i[2] for i in combo])
                    strip = sum(i[5] for i in combo)
                    if att < 0 and git < 0:
                        options.add((-1, -1, strip))
                        continue
                    att += bonus["att"] + sum(i[3] for i in combo)
                    git += bonus["git"] + sum(i[4] for i in combo)
                    options.add((att, git, strip))
            pareto = [
                o for o in options
                if not any(p != o and p[0] >= o[0] and p[1] >= o[1] and p[2] >= o[2] for p in options)
            ]
            result.append((tuple(index.setdefault(o, len(index)) for o in pareto), weight))

        cached = (list(index), result)
        self._cache[key] = cached
        return cached

    def expected_loss(self, player: Player, opponent: Player,
                      defense: List[Tuple[int, int, List[int]]]) -> float:
        """Perdita attesa di `player` al prossimo turno di `opponent`, sui
        Bastioni esposti a lui (`defense`)."""
        fossato = _fossato_threshold(player)
        lives = player.lives
        options, samples = self._options(opponent)
        losses = []
        for att, git, strip in options:
            can_battle = att >= 0 and git >= fossato
            worst = 0.0
            for dif, dgit, durabilities in defense:
                damage = max(att - dif, 0) + max(git - dgit, 0) if can_battle else 0
                worst = max(worst, _hit_value(damage, durabilities, lives, strip))
            losses.append(worst)
        total = sum(max(losses[i] for i in idxs) * weight for idxs, weight in samples if idxs)
        return total / self.SAMPLES


def _battle_targets(state: GameState, player: Player) -> List[Tuple[Player, str]]:
    """Bastioni avversari attaccabili in Battaglia da `player`, a prescindere
    dall'Avanscoperta attuale (serve a valutare disposizioni ipotetiche):
    quelli adiacenti, o tutti con Guerremoto. Fossato escluso, dipende dalla GIT."""
    guerremoto = any(e.get("type") == "guerremoto" and e.get("any_target") for e in player.active_effects)
    if guerremoto:
        pairs = [(p, side) for p in state.players if p.id != player.id for side in ("left", "right")]
    else:
        idx = next(i for i, p in enumerate(state.players) if p.id == player.id)
        pairs = [(state.players[i], side) for i, side in adjacent_bastions(idx, state.players).values()]
    return [(p, side) for p, side in pairs
            if p.id != player.id and p.is_alive and p.turns_completed >= 1]


def _attack_value(state: GameState, player: Player, vanguard: List[WarriorInstance]) -> float:
    """Perdita che la Battaglia di questo turno infliggerebbe con questa
    Avanscoperta, sul Bastione attaccabile più conveniente."""
    if state.battles_remaining <= 0 or not vanguard:
        return 0.0
    bonus = battle_building_bonus(player)
    att = max(w.effective_att() for w in vanguard) + bonus["att"]
    git = max(w.effective_git() for w in vanguard) + bonus["git"]
    best = 0.0
    for opponent, side in _battle_targets(state, player):
        if git < _fossato_threshold(opponent):
            continue
        dif, dgit = defender_stats(opponent, side)
        _, _, damage = calculate_damage(att, git, dif, dgit)
        walls = opponent.field.bastion_left.walls if side == "left" else opponent.field.bastion_right.walls
        best = max(best, _hit_value(damage, [w.durability for w in walls], opponent.lives))
    return best


def _optimize_reposition(state: GameState, player_id: str, threat: _ThreatModel) -> None:
    """Riposizionamento di 'hard': cerca la disposizione dei Guerrieri tra
    Avanscoperta e Bastioni che massimizza (danno inflitto in questa
    Battaglia) − (perdita attesa al prossimo turno avversario) + (Orde nuove
    formate). Il riposizionamento è gratuito e la disposizione resta tale
    fino al mio prossimo turno, quindi la stessa scelta decide sia l'attacco
    di ora sia la difesa di dopo. Ricerca locale: sposta un Guerriero o
    un'intera Specie alla volta finché migliora. I Guerrieri di un'Orda già
    attiva non si toccano (spostarli la romperebbe, perdendone l'effetto)."""
    player = state.get_player(player_id)
    regions = {
        "vanguard": player.field.vanguard,
        "bastion_left": player.field.bastion_left.warriors,
        "bastion_right": player.field.bastion_right.warriors,
    }
    warriors = {w.instance_id: w for lst in regions.values() for w in lst}
    if not warriors:
        return
    current = {w.instance_id: zone for zone, lst in regions.items() for w in lst}
    species = {iid: get_card(w.base_card_id).species for iid, w in warriors.items()}
    active = set(player.hordes_activated_this_turn)
    free = [iid for iid, zone in current.items() if f"{zone}:{species[iid]}" not in active]
    if not free:
        return

    bonus = battle_building_bonus(player)
    memo: Dict[tuple, float] = {}

    def evaluate(assign: Dict[str, str]) -> float:
        key = tuple(assign[iid] for iid in current)
        if key not in memo:
            memo[key] = _evaluate_layout(assign)
        return memo[key]

    def _evaluate_layout(assign: Dict[str, str]) -> float:
        groups = {zone: [] for zone in regions}
        for iid, zone in assign.items():
            groups[zone].append(warriors[iid])
        defense = [
            _side_defense(groups["bastion_left"], player.field.bastion_left, bonus),
            _side_defense(groups["bastion_right"], player.field.bastion_right, bonus),
        ]
        value = _attack_value(state, player, groups["vanguard"])
        value -= threat.expected_loss(state, player, defense)
        for zone, lst in groups.items():
            per_species = Counter(species[w.instance_id] for w in lst)
            value += sum(_NEW_HORDE_VALUE for sp, n in per_species.items() if n >= 3 and f"{zone}:{sp}" not in active)
        return value

    def moves(assign: Dict[str, str]):
        for iid in free:
            for zone in regions:
                if zone != assign[iid]:
                    yield {**assign, iid: zone}
        for sp in {species[iid] for iid in free}:
            for zone in regions:
                moved = {iid: zone for iid in free if species[iid] == sp and assign[iid] != zone}
                if len(moved) > 1:
                    yield {**assign, **moved}

    all_vanguard = {**current, **{iid: "vanguard" for iid in free}}
    best, best_value = current, evaluate(current)
    for start in (current, all_vanguard):
        assign, value = start, evaluate(start)
        for _ in range(12):
            improved = False
            for cand in moves(assign):
                v = evaluate(cand)
                if v > value + 1e-9:
                    assign, value, improved = cand, v, True
            if not improved:
                break
        if value > best_value + 1e-9:
            best, best_value = assign, value

    for iid, zone in best.items():
        if zone != current[iid]:
            try:
                reposition_warrior(state, player_id, iid, zone)
            except ActionError:
                pass


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

def _bot_battle(state: GameState, player_id: str, smart: bool = False) -> None:
    """Con `smart` ('hard') il bersaglio è quello che fa perdere di più
    all'avversario (una Vita vale più di qualche Muro), non quello con il
    Danno più alto: 3 Danni su un Bastione senza Muri tolgono una Vita,
    5 Danni su un Bastione con 6 Muri no."""
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
        if smart:
            walls = defender.field.bastion_left.walls if t_side == "left" else defender.field.bastion_right.walls
            total = _hit_value(total, [w.durability for w in walls], defender.lives) + total * 0.01
        if total > best_dmg:
            best_dmg, best_target = total, (t_idx, t_side)

    if best_target:
        try:
            result = do_battle(state, player_id, best_target[0], best_target[1])
        except ActionError:
            return
        if result.get("eracle_destroy_triggered") and not state.winner_id:
            _bot_eracle_destroy(state, player_id, result)


# Costruzioni avversarie da distruggere con l'Orda di Eracle, dalla più
# pericolosa per il Bot: prima i bonus di Battaglia e le difese, poi l'economia.
_ERACLE_PRIORITY = (
    "catapulta", "ariete", "fossato", "saracinesca", "trono", "fucina",
    "estrattore", "scrigno", "obelisco", "biblioteca", "arena", "granaio",
    "sorgiva", "cardo", "decumano",
)


def _bot_eracle_destroy(state: GameState, player_id: str, battle_result: dict) -> None:
    """Il Bot sfrutta l'Orda di Eracle: senza questa scelta la battaglia
    segnala i bersagli ma nessuna Costruzione viene mai distrutta."""
    targets = battle_result.get("eracle_targets") or []
    if not targets:
        return
    defender = state.get_player(battle_result["defender_id"])
    completed = {b.instance_id for b in defender.field.village.buildings if b.completed}

    def rank(t: dict) -> Tuple[int, int]:
        base = t["base_card_id"]
        prio = _ERACLE_PRIORITY.index(base) if base in _ERACLE_PRIORITY else len(_ERACLE_PRIORITY)
        return (0 if t["instance_id"] in completed else 1, prio)

    choice = min(targets, key=rank)
    try:
        eracle_destroy(state, player_id, choice["instance_id"], defender.id)
    except ActionError:
        pass


def _opponents(state: GameState, player_id: str) -> List[Player]:
    return [p for p in state.players if p.id != player_id and p.is_alive]


def _total_walls(player: Player) -> int:
    return len(player.field.bastion_left.walls) + len(player.field.bastion_right.walls)
