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
    reposition_warrior,
    activate_horde,
    evolve_warrior,
    recast_spell,
    eracle_destroy,
    discard_card,
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

    # Timer: riavvia al cambio turno, cancella se la partita è finita
    if req.action == "end_turn" or state.winner_id:
        await _start_turn_timer(req.game_id, state)

    return {"result": result, "state": public_state(state, player_id)}


_ACTION_CONSUMING = {"play_warrior", "play_spell", "play_building", "complete_building", "add_wall", "evolve"}


def _dispatch_action(state, player_id: str, action: str, params: dict) -> dict:
    """Smista l'azione al handler appropriato."""
    state.recent_events = []   # clear D10 events from previous action
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
        "discard": lambda: discard_card(
            state, player_id,
            params["instance_id"],
            params.get("source", "hand"),
        ),
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

    return result


def _end_turn_action(state, player_id: str) -> dict:
    if state.current_player.id != player_id:
        raise ActionError("Non è il tuo turno.")
    end_turn(state)
    return {"turn_ended": True}


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
            # Timer: riavvia al cambio turno, cancella se la partita è finita
            if action == "end_turn" or state.winner_id:
                await _start_turn_timer(game_id, state)
        except ActionError as e:
            await manager.send_to_player(game_id, player_id, {
                "type": "error", "message": str(e)
            })

    elif msg_type == "ping":
        await manager.send_to_player(game_id, player_id, {"type": "pong"})
