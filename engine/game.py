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
from engine.cards import CARD_REGISTRY, DEFAULT_DECK, get_card, WarriorCard, SpellCard, BuildingCard
from engine.deck import (
    build_deck,
    draw_cards,
    get_base_card_id,
    card_matches_condition,
    search_source_cards,
    advance_search_queue,
)
from engine.effects import apply_effect
from engine.battle import (
    resolve_battle,
    get_valid_attack_targets,
    battle_building_bonus,
    attack_block_reason,
)
from engine import oltretomba
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

def create_game(player_names: List[str], game_id: Optional[str] = None,
                player_ids: Optional[List[str]] = None, deck_id: str = DEFAULT_DECK) -> GameState:
    """
    Crea e inizializza una nuova partita.
    - Mescola il mazzo `deck_id` (data/decks.json: "base" o un'espansione)
    - Distribuisce 5 carte a ogni giocatore
    - Sceglie casualmente il primo giocatore
    `player_ids` (opzionale) fissa gli id dei giocatori prima della distribuzione,
    così il log delle pescate iniziali usa gli id definitivi (es. quelli della lobby).
    """
    if not 2 <= len(player_names) <= 4:
        raise ValueError("Barbacane richiede da 2 a 4 giocatori.")
    if player_ids is None:
        player_ids = [f"player_{i+1}" for i in range(len(player_names))]
    if len(player_ids) != len(player_names):
        raise ValueError("player_ids e player_names devono avere la stessa lunghezza.")

    if game_id is None:
        game_id = str(uuid.uuid4())[:8]

    players = [
        Player(
            id=player_ids[i],
            name=name,
            mana=0,
            mana_remaining=0,
            actions_remaining=2,
        )
        for i, name in enumerate(player_names)
    ]

    deck = build_deck(deck_id)
    first_player = random.randint(0, len(players) - 1)

    state = GameState(
        game_id=game_id,
        turn=1,
        current_player_index=first_player,
        first_player_index=first_player,
        phase="action",
        players=players,
        deck=deck,
        deck_id=deck_id,
        battles_remaining=1,
    )

    # Distribuisce 3 carte-vita a ogni giocatore (pescate dal mazzo)
    for player in players:
        for _ in range(3):
            if state.deck:
                player.life_cards.append(state.deck.pop(0))

    # Distribuisce 6 carte in mano a ogni giocatore
    # Se un giocatore si chiama "Test", le prime carte pescate sono quelle di test_cards.json
    _test_cards = _load_test_card_ids(deck_id)
    for player in players:
        if player.name in ("Test", "Test2") and _test_cards:
            _move_to_front(state.deck, _test_cards)
        draw_cards(state, player.id, 6)

    # Assegna il Mana iniziale al primo giocatore
    _begin_turn(state)

    return state


def create_practice_game(player_name: str, difficulty: str = "normal", game_id: Optional[str] = None,
                         num_bots: int = 1, deck_id: str = DEFAULT_DECK) -> GameState:
    """
    Crea una partita di pratica in solitaria contro 1–3 Bot (regole e mazzo
    reali, non scriptati), tutti della stessa difficoltà. Il giocatore umano
    parte sempre per primo, per un'esperienza più diretta subito dopo i tutorial.
    """
    if difficulty not in ("easy", "normal", "hard"):
        difficulty = "normal"
    num_bots = max(1, min(3, num_bots))
    if game_id is None:
        game_id = f"vs-{uuid.uuid4().hex[:8]}"

    bot_names = ["Bot"] if num_bots == 1 else [f"Bot {i + 1}" for i in range(num_bots)]
    state = create_game([player_name or "Tu", *bot_names], game_id=game_id, deck_id=deck_id)

    if state.current_player_index != 0:
        # create_game ha scelto a caso un Bot come primo giocatore: annulla il
        # suo inizio turno e rifallo per il giocatore umano.
        bot = state.current_player
        bot.mana_remaining = 0
        bot.actions_remaining = 2
        state.current_player_index = 0
        _begin_turn(state)
    state.first_player_index = 0
    state.turn_timer = 0
    state.bot_player_ids = [p.id for p in state.players[1:]]
    state.bot_difficulty = difficulty
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
    player.ethereal_card = None
    player.ethereal_complete = None
    player.pending_velocemento_buildings = []
    player.pending_velocemento_prodigy = False
    state.phase = "action"
    state.battle_done_this_turn = False
    state.battles_remaining = 1 + player.extra_battles
    player.extra_battles = 0

    # Nota: le Orde attivate NON si disattivano a inizio turno. Un'Orda resta attiva
    # finché non si divide (riposizionamento/scarto, vedi deactivate_broken_horde) o
    # finché il giocatore non sceglie un altro effetto Orda per lo stesso gruppo
    # (deactivate_horde_for_switch). Fa eccezione l'Orda del Trono, sempre riattivata
    # qui sotto in _trigger_building_start.

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

    # Modalità test: mana e azioni illimitate per il giocatore "Test"
    if player.name in ("Test", "Test2"):
        player.mana_remaining = 10
        player.actions_remaining = 5

    # Effetti Costruzioni a inizio turno (estrattore, biblioteca, fucina completata)
    _trigger_building_start(state, player)

    # Rimuovi effetti "next_own_turn" ora che le costruzioni hanno verificato i vincoli
    _clear_next_own_turn_effects(player)

    # Effetti differiti dal turno precedente (investimento prodigio, divinazione)
    _process_deferred_effects(state, player)

    # Oltretomba: Ossario, Mausoleo, Campana, Clessidra, Orde di Gennaro/Mephisto/Enea,
    # scadenza di Malocchio, Sanguisuga, Ectoplasma e Fantasmagoria
    oltretomba.on_turn_start(state, player)

    # Orda di Giulio già attiva: cerca Giulio II e aggiungilo alla mano
    _trigger_giulio_horde_start(state, player)


def _trigger_giulio_horde_start(state: GameState, player: Player) -> None:
    """Se l'Orda di Giulio è già attiva (attivata in un turno precedente), a inizio
    turno cerca Giulio II nel mazzo e lo aggiunge alla mano (state.pending_search)."""
    if state.pending_search is not None:
        return
    for w in player.all_warriors():
        if not w.horde_active:
            continue
        card = get_card(w.base_card_id)
        if isinstance(card, WarriorCard) and card.horde_effect_id == "giulio_horde":
            state.pending_search = {
                "player_id": player.id,
                "context": "giulio_horde",
                "condition": {"type": "base_card_id", "value": "giulio_ii"},
            }
            state.recent_events.append({
                "type": "search", "card": "giulio",
                "player_id": player.id, "search_pending": True,
            })
            break


def _is_biblioteca_suppressed(state: GameState, player: Player) -> bool:
    """Controlla se un avversario ha attivo faust_biblioteca_suppress contro questo giocatore."""
    for opp in state.players:
        if opp.id == player.id:
            continue
        if any(e.get("type") == "faust_biblioteca_suppress" for e in opp.active_effects):
            return True
    return False


def _trigger_building_start(state: GameState, player: Player) -> None:
    """Attiva gli effetti di Costruzione che si attivano a inizio turno."""
    for b_inst in player.field.village.buildings:
        base_id = b_inst.base_card_id
        card = get_card(base_id)
        if not isinstance(card, BuildingCard):
            continue
        if base_id in ("estrattore", "biblioteca", "sorgiva"):
            if base_id == "biblioteca":
                if _is_biblioteca_suppressed(state, player):
                    state.add_log(player.id, "biblioteca_suppressed")
                    continue
                result = apply_effect(card.effect_id, state, player, completed=b_inst.completed, trigger="start")
                if result.get("needs_discard") or result.get("needs_wall_choice"):
                    state.pending_interactions.append({
                        "type": "biblioteca_wall" if b_inst.completed else "biblioteca_discard",
                        "player_id": player.id,
                    })
            else:
                apply_effect(card.effect_id, state, player, completed=b_inst.completed, trigger="start")
        elif base_id == "fucina" and b_inst.completed:
            # Fucina completata: 3a Azione garantita ogni turno
            player.actions_remaining += 1
        elif base_id == "trono" and b_inst.completed and b_inst.assigned_warrior:
            # Trono completo: l'effetto Orda del Guerriero assegnato è sempre
            # attivo, si ri-attiva automaticamente a ogni inizio turno (indipendente
            # dalla persistenza normale delle Orde: qui si pulisce e riapplica sempre,
            # per evitare che i bonus si accumulino turno dopo turno).
            target_w = next(
                (w for w in player.all_warriors() if w.instance_id == b_inst.assigned_warrior),
                None,
            )
            if target_w:
                w_card = get_card(target_w.base_card_id)
                if isinstance(w_card, WarriorCard) and w_card.horde_effect_id:
                    _clear_trono_horde_effects(player, target_w.instance_id)
                    target_w.horde_active = True
                    effects_count_before = len(player.active_effects)
                    apply_effect(w_card.horde_effect_id, state, player, warrior_iid=target_w.instance_id)
                    for eff in player.active_effects[effects_count_before:]:
                        eff["trono_warrior"] = target_w.instance_id


def _trigger_building_end(state: GameState, player: Player) -> int:
    """Attiva gli effetti di Costruzione a fine turno. Ritorna il bonus al limite di mano da Granai."""
    complete_granai = [b for b in player.field.village.buildings
                       if b.base_card_id == "granaio" and b.completed]
    base_granai = [b for b in player.field.village.buildings
                   if b.base_card_id == "granaio" and not b.completed]

    bonus = len(complete_granai)
    for _ in base_granai:
        roll = random.randint(1, 10)
        triggered = roll >= 6
        if triggered:
            bonus += 1
        state.recent_events.append({
            "type": "d10", "card": "granaio",
            "player_id": player.id, "roll": roll, "triggered": triggered,
        })
    return bonus


def _clear_trono_horde_effects(player: Player, warrior_iid: str) -> None:
    """Rimuove gli effetti Orda generati dal Trono per questo Guerriero nel turno
    precedente, prima di riapplicarli: l'effetto Orda del Trono si ri-attiva ogni
    inizio turno (a differenza delle Orde normali, che restano attive finché non
    si dividono o il giocatore ne sceglie un'altra), quindi va pulito e riapplicato
    per evitare che i bonus si accumulino."""
    to_remove = []
    for eff in player.active_effects:
        if eff.get("trono_warrior") != warrior_iid:
            continue
        if eff.get("type") == "horde_stat_bonus":
            for w in player.all_warriors():
                if w.instance_id == warrior_iid:
                    for stat in ("att", "git", "dif"):
                        bonus = eff.get(stat, 0)
                        if bonus:
                            w.temp_modifiers[stat] = max(0, w.temp_modifiers.get(stat, 0) - bonus)
                    break
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
        elif etype == "equipotenza_own":
            warrior_iid = eff.get("warrior_iid")
            for w in player.all_warriors():
                if w.instance_id == warrior_iid:
                    w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) - eff.get("att_delta", 0)
                    w.temp_modifiers["dif"] = w.temp_modifiers.get("dif", 0) - eff.get("dif_delta", 0)
                    break
        elif etype == "equipotenza_enemy":
            warrior_iid = eff.get("warrior_iid")
            target_player = state.get_player(eff.get("target_player_id"))
            if target_player:
                for w in target_player.all_warriors():
                    if w.instance_id == warrior_iid:
                        w.temp_modifiers["att"] = w.temp_modifiers.get("att", 0) - eff.get("att_delta", 0)
                        w.temp_modifiers["dif"] = w.temp_modifiers.get("dif", 0) - eff.get("dif_delta", 0)
                        break
        to_remove.append(eff)
    for eff in to_remove:
        player.active_effects.remove(eff)


def check_fucina_after_action(state: GameState, player: Player) -> Optional[dict]:
    """
    Controlla se le Fucine base devono concedere Azioni aggiuntive (dopo aver esaurito le azioni).
    Ogni Fucina base in campo fa un roll indipendente. Chiamata dopo ogni azione che consuma un'azione.
    """
    if player.actions_remaining != 0:
        return None
    if any(e.get("type") == "fucina_base_triggered" for e in player.active_effects):
        return None
    base_fucine = [b for b in player.field.village.buildings
                   if b.base_card_id == "fucina" and not b.completed]
    if not base_fucine:
        return None
    player.active_effects.append({"type": "fucina_base_triggered", "expires": "end_of_turn"})
    rolls = []
    for _ in base_fucine:
        roll = random.randint(1, 10)
        extra = roll >= 6
        if extra:
            player.actions_remaining += 1
        state.recent_events.append({
            "type": "d10", "card": "fucina",
            "player_id": player.id, "roll": roll, "extra_action": extra,
        })
        rolls.append({"roll": roll, "extra_action": extra})
    return {"fucina_rolls": rolls}


def _clear_next_own_turn_effects(player: Player) -> None:
    """Rimuove effetti con expires='next_own_turn' all'inizio del turno del giocatore."""
    to_remove = [e for e in player.active_effects if e.get("expires") == "next_own_turn"]
    for eff in to_remove:
        player.active_effects.remove(eff)


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
    Se Cardo completato + Decumano in villaggio, aggiunge una pending_interaction
    cardo_move e ritorna early (il turno riprende dopo resolve_cardo_move).
    """
    player = state.current_player

    # Cardo completato + Decumano → offri spostamento guerriero prima di pescare
    has_cardo_complete = any(
        b.base_card_id == "cardo" and b.completed
        for b in player.field.village.buildings
    )
    has_decumano = any(
        b.base_card_id == "decumano"
        for b in player.field.village.buildings
    )
    cardo_move_pending = any(i.get("type") == "cardo_move" for i in state.pending_interactions)
    cardo_move_done = any(e.get("type") == "cardo_move_done" for e in player.active_effects)
    if has_cardo_complete and has_decumano and not cardo_move_pending and not cardo_move_done:
        state.pending_interactions.append({"type": "cardo_move", "player_id": player.id})
        return state
    # Traghetto (Oltretomba): stesso spostamento del Cardo, stessa interazione
    if oltretomba.offer_end_turn_move(state, player):
        return state

    # Fase finale: effetti costruzioni a fine turno
    granaio_bonus = _trigger_building_end(state, player)
    # Oltretomba: Orda di Celestino (mano massima), Clessidra (Azioni non usate)
    dlc_hand_bonus = oltretomba.on_turn_end(state, player)

    # Pesca fino al limite (6 + bonus Granai)
    from engine.deck import draw_to_hand_limit
    draw_to_hand_limit(state, player.id, limit=6 + granaio_bonus + dlc_hand_bonus)

    # Pulisci effetti scaduti a fine turno e interazioni pendenti. Uno scarto
    # imposto agli avversari (Malcomune, Baraonda) ancora senza risposta non va
    # perso: accade se il turno finisce senza passare dal dispatcher (Bot, timer).
    _clear_turn_expired_effects(player)
    _settle_forced_discards(state)
    state.pending_interactions.clear()
    _drop_searches_of(state, player.id)

    # Registra che il giocatore ha completato un turno
    player.turns_completed += 1

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

    # Trova il primo giocatore vivo che apre ogni round (first_player_index potrebbe essere eliminato)
    round_opener = state.first_player_index
    while not state.players[round_opener].is_alive:
        round_opener = (round_opener + 1) % num
    if next_idx == round_opener:
        state.turn += 1

    state.current_player_index = next_idx
    state.add_log(state.players[next_idx].id, "start_turn", turn=state.turn)

    # Inizia il prossimo turno
    _begin_turn(state)

    return state


def _settle_forced_discards(state: GameState) -> None:
    """Risolve con la scelta più prudente (il Guerriero più debole) gli scarti
    imposti agli avversari da Malcomune o Baraonda rimasti senza risposta."""
    from engine.effects import _discard_warrior_from_player
    for pending in [i for i in state.pending_interactions if i.get("type") == "malcomune_discard"]:
        victim = state.get_player(pending.get("player_id"))
        choices = forced_discard_choices(victim, pending) if victim else []
        if choices:
            weakest = min(choices, key=lambda w: w.effective_att() + w.effective_git() + w.effective_dif())
            _discard_warrior_from_player(state, victim, weakest.instance_id)


def forced_discard_choices(player: Player, pending: dict) -> List[WarriorInstance]:
    """Guerrieri tra cui `player` sceglie per un'interazione malcomune_discard:
    quelli della Specie indicata (Malcomune) o, senza Specie, quelli che una
    Magia avversaria può scartare (Baraonda)."""
    species = pending.get("species")
    if species is None:
        return oltretomba.baraonda_choices(player)
    return [w for w in player.all_warriors()
            if isinstance(get_card(w.base_card_id), WarriorCard) and get_card(w.base_card_id).species == species]


def _drop_searches_of(state: GameState, player_id: str) -> None:
    """Annulla le ricerche rimaste in sospeso di un giocatore (fine turno forzata, abbandono)."""
    state.search_queue = [s for s in state.search_queue if s.get("player_id") != player_id]
    ps = state.pending_search
    if ps and ps.get("player_id") == player_id:
        oltretomba.cancel_search(state, ps)
        if ps.get("source", "deck") == "deck":
            random.shuffle(state.deck)
        advance_search_queue(state)


def resolve_search(state: GameState, player_id: str, chosen_iid: Optional[str]) -> dict:
    """
    Risolve la ricerca in attesa (state.pending_search) con la carta scelta dal
    giocatore, o la annulla se chosen_iid è vuoto. Le carte si scelgono dal mazzo
    (cercare), dagli scarti (riesumare) o tra quelle scoperte in cima al mazzo
    (Lumicino), secondo pending_search["source"]. Poi passa alla ricerca
    successiva in coda (state.search_queue), se ce n'è una.
    """
    ps = state.pending_search
    if not ps:
        raise ActionError("Nessuna ricerca in corso.")
    if ps["player_id"] != player_id:
        raise ActionError("Non è la tua ricerca.")
    source = ps.get("source", "deck")

    if not chosen_iid:
        oltretomba.cancel_search(state, ps)
        if source == "deck":
            random.shuffle(state.deck)
        advance_search_queue(state)
        return {"cancelled": True}

    if chosen_iid not in search_source_cards(state, ps):
        raise ActionError("La carta scelta non è disponibile.")
    if not card_matches_condition(chosen_iid, ps["condition"]):
        raise ActionError("La carta scelta non soddisfa la condizione di ricerca.")

    # La carta lascia la sua pila. Dopo aver cercato nel mazzo lo si mescola;
    # gli scarti no, e nemmeno il mazzo sotto le carte scoperte da Lumicino.
    if source == "discard":
        state.discard_pile.remove(chosen_iid)
    else:
        state.deck.remove(chosen_iid)
        if source == "deck":
            random.shuffle(state.deck)

    player = state.get_player(player_id)
    context = ps["context"]
    result: dict = {"resolved_search": chosen_iid, "context": context}
    follow_up = None

    if context == "cercapersone_base":
        player.hand.append(chosen_iid)
        result["added_to_hand"] = chosen_iid

    elif context == "cercapersone_prodigio":
        player.hand.append(chosen_iid)
        player.ethereal_card = chosen_iid
        result["added_to_hand"] = chosen_iid
        result["ethereal"] = chosen_iid

    elif context == "giulio_horde":
        player.hand.append(chosen_iid)
        result["added_to_hand"] = chosen_iid

    elif context in oltretomba.SEARCH_CONTEXTS:
        follow_up = oltretomba.resolve_search(state, player, ps, chosen_iid, result)

    state.add_log(player_id, "search", card=chosen_iid, source=source)
    if follow_up:
        state.pending_search = follow_up
    else:
        advance_search_queue(state)
    return result


def abandon_game(state: GameState, player_id: str) -> dict:
    """
    Il giocatore abbandona la partita: tutte le sue carte (mano, vite, campo)
    vanno negli scarti e viene eliminato. Se resta un solo giocatore vivo,
    questi vince a tavolino. Se era il turno di chi abbandona, il turno passa
    al prossimo giocatore vivo.
    """
    player = state.get_player(player_id)
    if player is None:
        raise ActionError("Giocatore non trovato.")
    if state.winner_id or state.phase == "end":
        raise ActionError("La partita è già finita.")
    if not player.is_alive:
        raise ActionError("Sei già stato eliminato.")

    was_current = state.current_player.id == player_id

    # Tutte le carte del giocatore tornano nella pila degli scarti,
    # così il mazzo comune non si impoverisce quando gli scarti vengono rimescolati.
    discarded: List[str] = []
    discarded += player.hand
    player.hand = []
    discarded += player.life_cards
    player.life_cards = []
    for w in player.all_warriors():
        discarded.append(w.instance_id)
        if w.evolved_from:
            discarded.append(w.evolved_from)
        discarded += w.assigned_cards
    player.field.vanguard = []
    for bastion in (player.field.bastion_left, player.field.bastion_right):
        discarded += [wall.instance_id for wall in bastion.walls]
        bastion.walls = []
        bastion.warriors = []
    discarded += [b.instance_id for b in player.field.village.buildings]
    player.field.village.buildings = []
    state.discard_pile.extend(discarded)

    player.active_effects = []
    player.ethereal_card = None
    player.ethereal_complete = None
    player.pending_velocemento_buildings = []
    player.pending_velocemento_prodigy = False

    # Interazioni in sospeso di chi abbandona non hanno più senso
    _drop_searches_of(state, player_id)
    state.pending_interactions = [
        i for i in state.pending_interactions if i.get("player_id") != player_id
    ]

    state.recent_events.append({"type": "abandon", "player_id": player_id})
    state.add_log(player_id, "abandon")

    result: dict = {"abandoned": player_id}

    winner = _check_winner(state)
    if winner:
        state.phase = "end"
        state.winner_id = winner.id
        state.add_log(winner.id, "game_over", winner=winner.name)
        result["winner_id"] = winner.id
        return result

    # Se era il suo turno, passa al prossimo giocatore vivo (stessa logica di end_turn)
    if was_current:
        num = len(state.players)
        next_idx = (state.current_player_index + 1) % num
        while not state.players[next_idx].is_alive:
            next_idx = (next_idx + 1) % num
        round_opener = state.first_player_index
        while not state.players[round_opener].is_alive:
            round_opener = (round_opener + 1) % num
        if next_idx == round_opener:
            state.turn += 1
        state.current_player_index = next_idx
        state.add_log(state.players[next_idx].id, "start_turn", turn=state.turn)
        _begin_turn(state)
        result["turn_ended"] = True

    return result


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
        reason = None
        if 0 <= defender_player_index < len(state.players) and defender_player_index != state.current_player_index:
            reason = attack_block_reason(state, defender_player_index, defender_bastion_side)
        raise ActionError(reason or f"Bersaglio non valido: giocatore {defender_player_index} bastione {defender_bastion_side}.")

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

def _tutorial_view(state: GameState) -> Optional[dict]:
    # Import locale: engine.tutorial importa a sua volta moduli del motore.
    from engine.tutorial import public_view
    return public_view(state)


def public_state(state: GameState, viewer_player_id: Optional[str] = None) -> dict:
    """
    Ritorna una vista dello stato di gioco sicura per il broadcast.
    Le informazioni private (mano, identità dei Muri avversari) vengono oscurate.
    """
    players_view = []
    for p in state.players:
        # In fase di Battaglia i Guerrieri mostrano già il bonus delle Costruzioni
        # (Ariete, Catapulta, Saracinesca), come nel calcolo del Danno.
        bb = battle_building_bonus(p) if state.phase == "battaglia" else None
        p_view = {
            "id": p.id,
            "name": p.name,
            "lives": p.lives,
            "life_cards": p.life_cards if p.id == viewer_player_id else None,
            "mana_remaining": p.mana_remaining if p.id == viewer_player_id else None,
            "actions_remaining": p.actions_remaining if p.id == viewer_player_id else None,
            "hordes_activated_this_turn": p.hordes_activated_this_turn if p.id == viewer_player_id else None,
            "available_hordes": _available_hordes(p) if p.id == viewer_player_id else None,
            "active_effects": p.active_effects if p.id == viewer_player_id else [
                e for e in p.active_effects
                if e.get("type") in {
                    "spell_immune", "guerremoto", "investimento_deferred",
                    "divinazione_incantesimo", "divinazione_all_mage", "equipotenza_own",
                    # Oltretomba: chi attacca deve sapere dei Bastioni intoccabili e dell'obolo
                    "catalessi", "caronte_obolo",
                }
            ],
            "spell_immune": any(e.get("type") == "spell_immune" for e in p.active_effects),
            "ethereal_card": p.ethereal_card if p.id == viewer_player_id else None,
            "ethereal_complete": p.ethereal_complete if p.id == viewer_player_id else None,
            "pending_velocemento_buildings": p.pending_velocemento_buildings if p.id == viewer_player_id else [],
            "hand_count": len(p.hand),
            "hand": p.hand if p.id == viewer_player_id else None,
            "field": {
                "vanguard": [_warrior_view(w, p, viewer_player_id, bb) for w in p.field.vanguard],
                "bastion_left": {
                    "wall_count": len(p.field.bastion_left.walls),
                    "walls": (
                        [w.instance_id for w in p.field.bastion_left.walls]
                        if p.id == viewer_player_id else None
                    ),
                    "warriors": [_warrior_view(w, p, viewer_player_id, bb) for w in p.field.bastion_left.warriors],
                },
                "bastion_right": {
                    "wall_count": len(p.field.bastion_right.walls),
                    "walls": (
                        [w.instance_id for w in p.field.bastion_right.walls]
                        if p.id == viewer_player_id else None
                    ),
                    "warriors": [_warrior_view(w, p, viewer_player_id, bb) for w in p.field.bastion_right.warriors],
                },
                "village": {
                    "buildings": [_building_view(b, p if p.id == viewer_player_id else None) for b in p.field.village.buildings],
                },
            },
        }
        players_view.append(p_view)

    ps = state.pending_search
    search_deck = (
        _search_deck_view(state, ps)
        if ps and ps.get("player_id") == viewer_player_id
        else None
    )

    return {
        "game_id": state.game_id,
        "deck_id": state.deck_id,
        "turn": state.turn,
        "current_player_id": state.current_player.id,
        "phase": state.phase,
        "players": players_view,
        "deck_count": len(state.deck),
        "discard_count": len(state.discard_pile),
        # La pila degli scarti è a faccia in su: la carta in cima è pubblica
        # (Ossario e Pietrombale la trasformano in Muro)
        "discard_top": get_base_card_id(state.discard_pile[-1]) if state.discard_pile else None,
        "winner_id": state.winner_id,
        "battles_remaining": state.battles_remaining,
        "recent_events": list(state.recent_events),
        "pending_search": ps,
        "search_deck": search_deck,
        "pending_interactions": state.pending_interactions,
        "tutorial": _tutorial_view(state),
        "bot_player_ids": list(state.bot_player_ids),
        "bot_difficulty": state.bot_difficulty if state.bot_player_ids else None,
    }


def _load_test_card_ids(deck_id: str = DEFAULT_DECK) -> list:
    """Carica la lista di base_card_id da data/test_cards.json, o [] se assente/invalido.
    Il file è una lista (valida per ogni mazzo: le carte assenti dal mazzo vengono
    ignorate) oppure un oggetto {deck_id: [base_card_id, ...]}."""
    import json, os
    path = os.path.join(os.path.dirname(__file__), "..", "data", "test_cards.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data = data.get(deck_id, [])
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _move_to_front(deck: list, base_card_ids: list) -> None:
    """Sposta in cima al mazzo la prima istanza di ciascun base_card_id richiesto."""
    from engine.deck import get_base_card_id
    insert_pos = 0
    for base_id in base_card_ids:
        for i in range(insert_pos, len(deck)):
            if get_base_card_id(deck[i]) == base_id:
                deck.insert(insert_pos, deck.pop(i))
                insert_pos += 1
                break


def _search_deck_view(state: GameState, search: dict) -> list:
    """Ritorna le carte tra cui si cerca (mazzo, scarti o cima del mazzo, vedi
    search_source_cards) con flag 'matches', ordinate: matching prima."""
    result = []
    for iid in search_source_cards(state, search):
        base_id = get_base_card_id(iid)
        card = CARD_REGISTRY.get(base_id)
        if card is None:
            continue
        matches = card_matches_condition(iid, search["condition"])
        result.append({
            "instance_id": iid,
            "base_card_id": base_id,
            "name": card.name,
            "type": card.type,
            "subtype": getattr(card, "subtype", None),
            "matches": matches,
        })
    result.sort(key=lambda x: 0 if x["matches"] else 1)
    return result


def _available_hordes(player: Player) -> list:
    """Ritorna le Orde disponibili per il giocatore con info sugli effetti.

    Un'opzione per ciascun Guerriero dell'Orda, senza deduplicare per
    horde_effect_id: effetti come quello di Patrizio ("+2 GIT a QUESTA
    carta") si applicano a un Guerriero specifico, quindi ogni copia è una
    scelta diversa anche se il testo dell'effetto è identico."""
    result = []
    for horde in player.check_horde_with_zones():
        warrior_data = []
        for w in horde["warriors"]:
            card = get_card(w.base_card_id)
            if not isinstance(card, WarriorCard):
                continue
            if player.has_active_trono(w.instance_id):
                # Effetto Orda già sempre attivo grazie al Trono: non riproponibile manualmente
                continue
            if card.horde_effect_id:
                warrior_data.append({
                    "instance_id": w.instance_id,
                    "base_card_id": w.base_card_id,
                    "name": card.name,
                    "horde_effect": card.horde_effect,
                    "active": w.horde_active,
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


def _warrior_view(
    w: WarriorInstance,
    player: Optional[Player] = None,
    viewer_player_id: Optional[str] = None,
    battle_bonus: Optional[Dict[str, int]] = None,
) -> dict:
    card = get_card(w.base_card_id)
    bb = battle_bonus or {}
    return {
        "instance_id": w.instance_id,
        "base_card_id": w.base_card_id,
        "name": card.name if isinstance(card, WarriorCard) else w.base_card_id,
        "att": w.effective_att() + bb.get("att", 0),
        "git": w.effective_git() + bb.get("git", 0),
        "dif": w.effective_dif() + bb.get("dif", 0),
        "species": card.species if isinstance(card, WarriorCard) else None,
        "subtype": card.subtype if isinstance(card, WarriorCard) else None,
        "horde_active": w.horde_active,
        # L'Eroe conserva l'effetto Orda della Recluta sotto di lui: il client
        # mostra la Recluta (pubblica) su richiesta, propria o avversaria.
        "evolved_from": w.evolved_from,
        "assigned_cards": (
            [_assigned_card_view(iid, player, viewer_player_id) for iid in w.assigned_cards]
            if player is not None else []
        ),
        # Oltretomba: spell_protected (Reliquiario) / discard_protected (Orda di Achille)
        **(oltretomba.warrior_flags(player, w) if player is not None else {}),
    }


def _assigned_card_view(iid: str, player: Player, viewer_player_id: Optional[str] = None) -> dict:
    """
    Vista pubblica di una carta assegnata a un Guerriero.
    Due casi: Costruzione assegnata (es. Trono, sempre pubblica) oppure Muro
    assegnato (es. Arrampicarta, identità nascosta a chi non è il proprietario,
    come i Muri nei Bastioni).
    """
    from engine.deck import get_base_card_id
    base_id = get_base_card_id(iid)
    card = get_card(base_id)

    if isinstance(card, BuildingCard):
        b_inst = next((b for b in player.field.village.buildings if b.instance_id == iid), None)
        if b_inst is not None:
            return {
                "instance_id": iid,
                "base_card_id": base_id,
                "name": card.name,
                "type": card.type,
                "completed": b_inst.completed,
                "effect": card.complete_effect if b_inst.completed else card.base_effect,
            }

    # Muro assegnato: identità visibile solo al proprietario
    if player.id == viewer_player_id:
        return {
            "instance_id": iid,
            "base_card_id": base_id,
            "name": card.name if card else base_id,
            "type": "wall",
        }
    # Nascosto agli avversari: nessun instance_id, così non se ne può risalire
    # l'identità (come i Muri nel Bastione, esposti solo come wall_count)
    return {
        "instance_id": None,
        "base_card_id": None,
        "name": None,
        "type": "wall",
    }


def _building_view(b: BuildingInstance, player=None) -> dict:
    card = get_card(b.base_card_id)
    result = {
        "instance_id": b.instance_id,
        "base_card_id": b.base_card_id,
        "name": card.name if isinstance(card, BuildingCard) else b.base_card_id,
        "completed": b.completed,
        "effect": card.complete_effect if b.completed else card.base_effect
        if isinstance(card, BuildingCard) else "",
        "assigned_warrior": b.assigned_warrior,
    }
    if b.base_card_id == "arena" and player is not None:
        result["arena_available"] = not any(
            e.get("type") == "arena_used" and e.get("building_instance_id") == b.instance_id
            for e in player.active_effects
        )
    if isinstance(card, BuildingCard) and card.activation and player is not None:
        result["activation_available"] = oltretomba.activation_available(player, b)
    return result


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
