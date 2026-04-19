"""
Gestione Lobby di Barbacane.
Creazione partita, join, gestione sessioni.
"""

from __future__ import annotations
import random
import secrets
import string
import uuid
from typing import Dict, List, Optional


# In-memory store per le lobby in attesa (prima che la partita inizi)
# {lobby_code: LobbyInfo}
_lobbies: Dict[str, "LobbyInfo"] = {}


class LobbyPlayer:
    def __init__(self, player_id: str, name: str, session_token: str):
        self.player_id = player_id
        self.name = name
        self.session_token = session_token
        self.ready = False

    def to_dict(self) -> dict:
        return {
            "player_id": self.player_id,
            "name": self.name,
            "ready": self.ready,
        }


class LobbyInfo:
    def __init__(self, lobby_code: str, creator_id: str, turn_timer: int = 120):
        self.lobby_code = lobby_code
        self.creator_id = creator_id
        self.turn_timer = turn_timer  # secondi; 0 = disattivato
        self.players: List[LobbyPlayer] = []
        self.game_id: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "lobby_code": self.lobby_code,
            "creator_id": self.creator_id,
            "turn_timer": self.turn_timer,
            "players": [p.to_dict() for p in self.players],
            "game_id": self.game_id,
            "can_start": self.can_start(),
        }

    def can_start(self) -> bool:
        return 2 <= len(self.players) <= 4

    def get_player(self, player_id: str) -> Optional[LobbyPlayer]:
        return next((p for p in self.players if p.player_id == player_id), None)

    def get_player_by_token(self, token: str) -> Optional[LobbyPlayer]:
        return next((p for p in self.players if p.session_token == token), None)


def generate_lobby_code() -> str:
    """Genera un codice lobby tipo BARB-7X3K."""
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(random.choices(chars, k=4))
    return f"BARB-{suffix}"


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def create_lobby(creator_name: str, turn_timer: int = 120) -> dict:
    """
    Crea una nuova lobby.
    Ritorna {lobby_code, player_id, session_token}.
    """
    for _ in range(10):
        code = generate_lobby_code()
        if code not in _lobbies:
            break

    player_id = f"player_1"
    session_token = generate_session_token()

    lobby = LobbyInfo(lobby_code=code, creator_id=player_id, turn_timer=turn_timer)
    creator = LobbyPlayer(player_id=player_id, name=creator_name, session_token=session_token)
    lobby.players.append(creator)
    _lobbies[code] = lobby

    return {
        "lobby_code": code,
        "player_id": player_id,
        "session_token": session_token,
        "lobby": lobby.to_dict(),
    }


def join_lobby(lobby_code: str, player_name: str) -> dict:
    """
    Unisci un giocatore alla lobby.
    Ritorna {player_id, session_token}.
    """
    lobby = _lobbies.get(lobby_code)
    if lobby is None:
        raise ValueError(f"Lobby {lobby_code} non trovata.")
    if len(lobby.players) >= 4:
        raise ValueError("Lobby piena (massimo 4 giocatori).")
    if lobby.game_id is not None:
        raise ValueError("La partita è già iniziata.")

    player_id = f"player_{len(lobby.players) + 1}"
    session_token = generate_session_token()
    player = LobbyPlayer(player_id=player_id, name=player_name, session_token=session_token)
    lobby.players.append(player)

    return {
        "lobby_code": lobby_code,
        "player_id": player_id,
        "session_token": session_token,
        "lobby": lobby.to_dict(),
    }


def get_lobby(lobby_code: str) -> Optional[LobbyInfo]:
    return _lobbies.get(lobby_code)


def start_game(lobby_code: str, requester_id: str) -> "GameState":
    """
    Avvia la partita dalla lobby.
    Solo il creatore può avviarla.
    """
    from engine.game import create_game

    lobby = _lobbies.get(lobby_code)
    if lobby is None:
        raise ValueError(f"Lobby {lobby_code} non trovata.")
    if requester_id != lobby.creator_id:
        raise PermissionError("Solo il creatore può avviare la partita.")
    if not lobby.can_start():
        raise ValueError(f"Servono almeno 2 giocatori (attuale: {len(lobby.players)}).")
    if lobby.game_id is not None:
        raise ValueError("La partita è già iniziata.")

    player_names = [p.name for p in lobby.players]
    game_id = str(uuid.uuid4())[:8]
    state = create_game(player_names, game_id=game_id)

    # Allinea i player_id dello stato con quelli della lobby
    for i, lp in enumerate(lobby.players):
        state.players[i].id = lp.player_id

    lobby.game_id = game_id
    return state


def remove_lobby(lobby_code: str) -> None:
    _lobbies.pop(lobby_code, None)


def authenticate_player(session_token: str) -> Optional[tuple]:
    """
    Ritorna (lobby_code, player_id) se il token è valido, None altrimenti.
    Prima cerca nelle lobby in memoria, poi nel DB.
    """
    for code, lobby in _lobbies.items():
        p = lobby.get_player_by_token(session_token)
        if p:
            return code, p.player_id
    # Fallback: cerca nel DB (per partite già in corso dopo riconnessione)
    from db.storage import get_player_by_token
    row = get_player_by_token(session_token)
    if row:
        return None, row["player_id"]  # lobby_code non disponibile da DB
    return None
