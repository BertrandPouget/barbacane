"""
Endpoint REST e WebSocket di Barbacane.
"""

from __future__ import annotations
import asyncio
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from db.storage import save_game, load_game, init_db, save_player
from engine.game import (
    public_state,
    do_battle,
    end_turn,
    check_fucina_after_action,
)
from engine.actions import (
    ActionError,
    play_warrior,
    play_building,
    play_spell,
    complete_building,
    add_wall,
    retrieve_wall,
    discard_wall,
    reposition_warrior,
    activate_horde,
    evolve_warrior,
    recast_spell,
    eracle_destroy,
    discard_card,
    arena_activate,
    _apply_spell_post_effects,
)
from server.lobby import (
    create_lobby,
    join_lobby,
    get_lobby,
    start_game,
    authenticate_player,
)
from server.ws_manager import manager

router = APIRouter()


# ---------------------------------------------------------------------------
# Timer helpers
# ---------------------------------------------------------------------------

async def _on_turn_expire(game_id: str, player_id: str) -> None:
    """Forza la fine del turno allo scadere del timer (120s senza azioni)."""
    state = load_game(game_id)
    if state is None or state.winner_id or state.phase == "end":
        return
    if state.current_player.id != player_id:
        return  # turno già passato

    try:
        end_turn(state)
        status = "finished" if state.winner_id else "playing"
        save_game(state, status=status)

        connected = list(manager.connected_players(game_id))
        for pid in connected:
            await manager.send_to_player(game_id, pid, {
                "type": "state_update",
                "action": "end_turn",
                "result": {"turn_ended": True, "auto": True},
                "state": public_state(state, pid),
            })

        if not state.winner_id:
            await _start_turn_timer(game_id, state)
    except Exception as e:
        logger.error("[timer] Errore nel forzare fine turno %s: %s", game_id, e)


async def _start_turn_timer(game_id: str, state) -> None:
    """Avvia il timer del turno corrente se abilitato."""
    if state.winner_id or state.turn_timer <= 0:
        manager.cancel_turn_timer(game_id)
        return
    await manager.broadcast(game_id, {
        "type": "turn_started",
        "player_id": state.current_player.id,
        "seconds": state.turn_timer,
    })
    await manager.start_turn_timer(
        game_id,
        state.current_player.id,
        seconds=state.turn_timer,
        on_expire_callback=_on_turn_expire,
    )

# ---------------------------------------------------------------------------
# Modelli richiesta
# ---------------------------------------------------------------------------

class CreateLobbyRequest(BaseModel):
    player_name: str
    turn_timer: int = 120


class JoinLobbyRequest(BaseModel):
    lobby_code: str
    player_name: str


class StartGameRequest(BaseModel):
    lobby_code: str
    session_token: str


class GameActionRequest(BaseModel):
    game_id: str
    session_token: str
    action: str  # play_warrior | play_spell | play_building | complete_building | add_wall | reposition | horde | evolve | battle | end_turn
    params: Dict[str, Any] = {}


# ---------------------------------------------------------------------------
# REST: Lobby
# ---------------------------------------------------------------------------

@router.post("/lobby/create")
async def api_create_lobby(req: CreateLobbyRequest):
    result = create_lobby(req.player_name, req.turn_timer)
    return result


@router.post("/lobby/join")
async def api_join_lobby(req: JoinLobbyRequest):
    try:
        result = join_lobby(req.lobby_code, req.player_name)
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/lobby/{lobby_code}")
async def api_get_lobby(lobby_code: str):
    lobby = get_lobby(lobby_code)
    if lobby is None:
        raise HTTPException(404, "Lobby non trovata")
    return lobby.to_dict()


@router.post("/lobby/start")
async def api_start_game(req: StartGameRequest):
    auth = authenticate_player(req.session_token)
    if auth is None:
        raise HTTPException(401, "Token non valido")
    _, player_id = auth

    try:
        state = start_game(req.lobby_code, player_id)
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))

    # Salva nel DB
    lobby = get_lobby(req.lobby_code)
    save_game(state, lobby_code=req.lobby_code, status="playing")

    # Salva i giocatori nel DB per la riconnessione
    lobby = get_lobby(req.lobby_code)
    if lobby:
        for lp in lobby.players:
            save_player(state.game_id, lp.player_id, lp.name, lp.session_token)

    # Invia a ogni giocatore connesso la propria vista personalizzata
    for pid in manager.connected_players(state.game_id):
        await manager.send_to_player(state.game_id, pid, {
            "type": "game_started",
            "state": public_state(state, pid),
        })

    # Avvia il timer per il primo turno
    await _start_turn_timer(state.game_id, state)

    return {"game_id": state.game_id, "state": public_state(state, player_id)}


# ---------------------------------------------------------------------------
# REST: Stato partita
# ---------------------------------------------------------------------------

@router.get("/game/{game_id}")
async def api_get_game(game_id: str, session_token: Optional[str] = None):
    state = load_game(game_id)
    if state is None:
        raise HTTPException(404, "Partita non trovata")

    viewer_id = None
    if session_token:
        auth = authenticate_player(session_token)
        if auth:
            _, viewer_id = auth

    return public_state(state, viewer_id)


# ---------------------------------------------------------------------------
# REST: Azione di gioco
# ---------------------------------------------------------------------------

@router.post("/game/action")
async def api_game_action(req: GameActionRequest):
    state = load_game(req.game_id)
    if state is None:
        raise HTTPException(404, "Partita non trovata")

    auth = authenticate_player(req.session_token)
    if auth is None:
        raise HTTPException(401, "Token non valido")
    _, player_id = auth

    try:
        result = _dispatch_action(state, player_id, req.action, req.params)
    except ActionError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Errore interno: {e}")

    # Salva e invia a ogni giocatore la propria vista personalizzata
    status = "finished" if state.winner_id else "playing"
    save_game(state, status=status)
    for pid in manager.connected_players(req.game_id):
        await manager.send_to_player(req.game_id, pid, {
            "type": "state_update",
            "action": req.action,
            "result": result,
            "state": public_state(state, pid),
        })

    # Timer: riavvia quando il turno cambia davvero (non se cardo_move è in attesa)
    if result.get("turn_ended") or result.get("auto_end_turn") or state.winner_id:
        await _start_turn_timer(req.game_id, state)

    return {"result": result, "state": public_state(state, player_id)}


_ACTION_CONSUMING = {"play_warrior", "play_spell", "play_building", "complete_building", "add_wall", "evolve"}

# Mappa delle fasi richieste per le azioni principali
_PHASE_REQUIRED = {
    "play_warrior":       "action",
    "play_spell":         "action",
    "play_building":      "action",
    "complete_building":  "action",
    "add_wall":           "action",
    "evolve":             "action",
    "reposition":         "schieramento",
    "horde":              "schieramento",
    "battle":             "battaglia",
}


def _dispatch_action(state, player_id: str, action: str, params: dict) -> dict:
    """Smista l'azione al handler appropriato."""
    state.recent_events = []

    # Azzera carta eterea se il giocatore consuma un'azione senza giocarla
    _ETHEREAL_BREAKING = {
        "play_warrior", "play_spell", "play_building",
        "complete_building", "add_wall", "evolve",
        "battle", "end_turn", "next_phase",
    }
    _player = state.get_player(player_id)
    if _player and _player.ethereal_card and action in _ETHEREAL_BREAKING:
        _playing_ethereal = (
            action in ("play_warrior", "play_spell", "play_building")
            and params.get("instance_id") == _player.ethereal_card
        )
        if not _playing_ethereal:
            _player.ethereal_card = None

    # Azzera ethereal_complete se il giocatore fa altro invece di completare quella costruzione.
    # Esenzioni: complete_building sulla costruzione corretta (passo finale),
    #            play_building sulla stessa carta (passo intermedio: la carta viene piazzata prima di poter essere completata).
    if _player and _player.ethereal_complete and action in _ETHEREAL_BREAKING:
        _completing_ethereal = (
            action == "complete_building"
            and params.get("building_instance_id") == _player.ethereal_complete
        )
        _playing_to_complete = (
            action == "play_building"
            and params.get("instance_id") == _player.ethereal_complete
        )
        if not _completing_ethereal and not _playing_to_complete:
            _player.ethereal_complete = None

    if state.pending_search and action != "resolve_search":
        raise ActionError("C'è una ricerca in attesa di risoluzione.")

    if state.pending_interactions:
        _pending_type = state.pending_interactions[0].get("type", "")
        _allowed = {
            "biblioteca_discard": "resolve_biblioteca",
            "biblioteca_wall": "resolve_biblioteca",
            "cardo_move": "resolve_cardo_move",
            "agilpesca_discard": "resolve_agilpesca",
            "magiscudo_counter": "resolve_magiscudo_counter",
        }.get(_pending_type)
        if _allowed and action != _allowed:
            if _pending_type in ("biblioteca_discard", "biblioteca_wall"):
                raise ActionError("C'è un'interazione Biblioteca in attesa di risoluzione.")
            elif _pending_type == "agilpesca_discard":
                raise ActionError("Devi scegliere una carta da scartare (Agilpesca).")
            elif _pending_type == "magiscudo_counter":
                raise ActionError("In attesa della risposta di Magiscudo del bersaglio.")
            else:
                raise ActionError("C'è un'interazione Cardo in attesa di risoluzione.")

    if _player and _player.pending_velocemento_buildings and action != "resolve_velocemento":
        raise ActionError("Devi scegliere una Costruzione da rendere Eterea (Velocemento).")

    # Verifica che l'azione sia disponibile nella fase corrente del turno
    _required_phase = _PHASE_REQUIRED.get(action)
    if _required_phase and state.phase != _required_phase:
        _phase_names = {"action": "Azioni", "schieramento": "Schieramento", "battaglia": "Battaglia"}
        raise ActionError(
            f"Azione non disponibile in fase {_phase_names.get(state.phase, state.phase)}. "
            f"Richiesta fase: {_phase_names.get(_required_phase, _required_phase)}."
        )

    handlers = {
        "play_warrior": lambda: play_warrior(
            state, player_id,
            params["instance_id"],
            params.get("region", "vanguard"),
        ),
        "play_spell": lambda: play_spell(
            state, player_id,
            params["instance_id"],
            **{k: v for k, v in params.items() if k != "instance_id"},
        ),
        "play_building": lambda: play_building(
            state, player_id,
            params["instance_id"],
        ),
        "complete_building": lambda: complete_building(
            state, player_id,
            params["building_instance_id"],
        ),
        "add_wall": lambda: add_wall(
            state, player_id,
            params["walls"],
        ),
        "reposition": lambda: reposition_warrior(
            state, player_id,
            params["warrior_instance_id"],
            params["destination"],
        ),
        "horde": lambda: activate_horde(
            state, player_id,
            params["horde_card_id"],
            params.get("warrior_instance_id"),
            **{k: v for k, v in params.items()
               if k not in ("horde_card_id", "warrior_instance_id")},
        ),
        "evolve": lambda: evolve_warrior(
            state, player_id,
            params["recruit_instance_id"],
            params["hero_instance_id"],
        ),
        "battle": lambda: do_battle(
            state, player_id,
            params["defender_player_index"],
            params.get("defender_bastion_side", "left"),
        ),
        "recast_spell": lambda: recast_spell(
            state, player_id,
            params["base_card_id"],
            **{k: v for k, v in params.items() if k != "base_card_id"},
        ),
        "eracle_destroy": lambda: eracle_destroy(
            state, player_id,
            params["building_instance_id"],
            params["target_player_id"],
        ),
        "retrieve_wall": lambda: retrieve_wall(
            state, player_id,
            params["instance_id"],
            params.get("bastion_side", "left"),
        ),
        "discard_wall": lambda: discard_wall(
            state, player_id,
            params["instance_id"],
            params.get("bastion_side", "left"),
        ),
        "discard": lambda: discard_card(
            state, player_id,
            params["instance_id"],
            params.get("source", "hand"),
        ),
        "resolve_search": lambda: _resolve_search_action(
            state, player_id, params.get("chosen_iid"),
        ),
        "resolve_biblioteca": lambda: _resolve_biblioteca_action(
            state, player_id, params,
        ),
        "resolve_velocemento": lambda: _resolve_velocemento_action(
            state, player_id, params,
        ),
        "resolve_agilpesca": lambda: _resolve_agilpesca_action(
            state, player_id, params,
        ),
        "arena_activate": lambda: arena_activate(
            state, player_id,
            params["building_instance_id"],
            params["own_warrior_iid"],
            params["target_warrior_iid"],
            params["target_player_id"],
        ),
        "resolve_cardo_move": lambda: _resolve_cardo_move_action(
            state, player_id, params,
        ),
        "resolve_magiscudo_counter": lambda: _resolve_magiscudo_counter_action(
            state, player_id, params,
        ),
        "next_phase": lambda: _next_phase_action(state, player_id),
        "end_turn": lambda: _end_turn_action(state, player_id),
    }
    if action not in handlers:
        raise ActionError(f"Azione sconosciuta: {action}")
    result = handlers[action]()

    # Fucina base: after 2nd action used, roll D10 for possible 3rd action
    if action in _ACTION_CONSUMING:
        player = state.get_player(player_id)
        if player and state.current_player.id == player_id:
            fucina_res = check_fucina_after_action(state, player)
            if fucina_res:
                result["fucina"] = fucina_res

    # Dopo la battaglia (o eracle_destroy), fine turno automatica se non ci sono
    # più battaglie disponibili e nessun eracle_destroy in attesa di scelta.
    if action in ("battle", "eracle_destroy") and not state.winner_id:
        eracle_pending = action == "battle" and result.get("eracle_destroy_triggered", False)
        if state.battles_remaining <= 0 and not eracle_pending:
            end_turn(state)
            # Se end_turn ha aggiunto cardo_move, il turno non è ancora cambiato
            cardo_move_added = any(i.get("type") == "cardo_move" for i in state.pending_interactions)
            if not cardo_move_added:
                result["auto_end_turn"] = True

    return result


def _resolve_search_action(state, player_id: str, chosen_iid: Optional[str]) -> dict:
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


def _resolve_biblioteca_action(state, player_id: str, params: dict) -> dict:
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


def _resolve_agilpesca_action(state, player_id: str, params: dict) -> dict:
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


def _resolve_velocemento_action(state, player_id: str, params: dict) -> dict:
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


def _next_phase_action(state, player_id: str) -> dict:
    if state.current_player.id != player_id:
        raise ActionError("Non è il tuo turno.")
    if state.phase == "action":
        state.phase = "schieramento"
        return {"phase": "schieramento"}
    elif state.phase == "schieramento":
        state.phase = "battaglia"
        return {"phase": "battaglia"}
    raise ActionError("Non puoi avanzare la fase da questa posizione.")


def _end_turn_action(state, player_id: str) -> dict:
    if state.current_player.id != player_id:
        raise ActionError("Non è il tuo turno.")
    end_turn(state)
    if any(i.get("type") == "cardo_move" for i in state.pending_interactions):
        return {"cardo_move_pending": True}
    return {"turn_ended": True}


def _resolve_cardo_move_action(state, player_id: str, params: dict) -> dict:
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


def _resolve_magiscudo_counter_action(state, player_id: str, params: dict) -> dict:
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


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@router.websocket("/ws/{game_id}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str, player_id: str):
    await manager.connect(game_id, player_id, websocket)

    # Avvisa gli altri della connessione
    await manager.broadcast(game_id, {
        "type": "player_connected",
        "player_id": player_id,
    })

    # Invia lo stato corrente al giocatore appena connesso
    state = load_game(game_id)
    if state:
        await manager.send_to_player(game_id, player_id, {
            "type": "state_update",
            "state": public_state(state, player_id),
        })

    try:
        while True:
            data = await websocket.receive_json()
            await _handle_ws_message(game_id, player_id, data)
    except WebSocketDisconnect:
        manager.disconnect(game_id, player_id)
        await manager.broadcast(game_id, {
            "type": "player_disconnected",
            "player_id": player_id,
        })


async def _handle_ws_message(game_id: str, player_id: str, data: dict) -> None:
    """Processa i messaggi ricevuti via WebSocket."""
    msg_type = data.get("type")

    if msg_type == "action":
        state = load_game(game_id)
        if state is None:
            await manager.send_to_player(game_id, player_id, {
                "type": "error", "message": "Partita non trovata"
            })
            return

        action = data.get("action")
        try:
            result = _dispatch_action(state, player_id, action, data.get("params", {}))
            status = "finished" if state.winner_id else "playing"
            save_game(state, status=status)
            # Invia a ogni giocatore connesso la propria vista personalizzata
            for pid in manager.connected_players(game_id):
                await manager.send_to_player(game_id, pid, {
                    "type": "state_update",
                    "action": action,
                    "result": result,
                    "state": public_state(state, pid),
                })
            # Timer: riavvia quando il turno cambia davvero (non se cardo_move è in attesa)
            if result.get("turn_ended") or result.get("auto_end_turn") or state.winner_id:
                await _start_turn_timer(game_id, state)
        except ActionError as e:
            await manager.send_to_player(game_id, player_id, {
                "type": "error", "message": str(e)
            })
        except Exception as e:
            logger.error("[ws] Errore interno action=%s game=%s: %s", action, game_id, e)
            await manager.send_to_player(game_id, player_id, {
                "type": "error", "message": f"Errore interno: {e}"
            })

    elif msg_type == "ping":
        await manager.send_to_player(game_id, player_id, {"type": "pong"})
