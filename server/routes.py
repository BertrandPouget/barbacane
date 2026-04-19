"""
Endpoint REST e WebSocket di Barbacane.
"""

from __future__ import annotations
import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from db.storage import save_game, load_game, init_db, save_player
from engine.game import (
    public_state,
    do_battle,
    end_turn,
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
    save_game(state)
    for pid in manager.connected_players(req.game_id):
        await manager.send_to_player(req.game_id, pid, {
            "type": "state_update",
            "action": req.action,
            "result": result,
            "state": public_state(state, pid),
        })

    return {"result": result, "state": public_state(state, player_id)}


def _dispatch_action(state, player_id: str, action: str, params: dict) -> dict:
    """Smista l'azione al handler appropriato."""
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
        "end_turn": lambda: _end_turn_action(state, player_id),
    }
    if action not in handlers:
        raise ActionError(f"Azione sconosciuta: {action}")
    return handlers[action]()


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

        try:
            result = _dispatch_action(state, player_id, data.get("action"), data.get("params", {}))
            save_game(state)
            # Invia a ogni giocatore connesso la propria vista personalizzata
            for pid in manager.connected_players(game_id):
                await manager.send_to_player(game_id, pid, {
                    "type": "state_update",
                    "action": data.get("action"),
                    "result": result,
                    "state": public_state(state, pid),
                })
        except ActionError as e:
            await manager.send_to_player(game_id, player_id, {
                "type": "error", "message": str(e)
            })

    elif msg_type == "ping":
        await manager.send_to_player(game_id, player_id, {"type": "pong"})
