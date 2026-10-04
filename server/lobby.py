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
    def __init__(self, player_id: str, name: str, session_token: Optional[str], is_bot: bool = False):
        self.player_id = player_id
        self.name = name
        self.session_token = session_token  # None per i Bot
        self.is_bot = is_bot
        self.ready = False
        self.seat_hint: Optional[int] = None  # rivincita: posto occupato nella partita precedente

    def to_dict(self) -> dict:
        return {
            "player_id": self.player_id,
            "name": self.name,
            "ready": self.ready,
            "is_bot": self.is_bot,
        }


class LobbyInfo:
    def __init__(self, lobby_code: str, creator_id: str, turn_timer: int = 0):
        self.lobby_code = lobby_code
        self.creator_id = creator_id
        self.turn_timer = turn_timer  # secondi; 0 = disattivato
        self.players: List[LobbyPlayer] = []  # in ordine di posto al tavolo
        self.game_id: Optional[str] = None
        self.bot_difficulty = "normal"  # uguale per tutti i Bot della lobby

    def to_dict(self) -> dict:
        return {
            "lobby_code": self.lobby_code,
            "creator_id": self.creator_id,
            "turn_timer": self.turn_timer,
            "players": [p.to_dict() for p in self.players],
            "game_id": self.game_id,
            "can_start": self.can_start(),
            "bot_difficulty": self.bot_difficulty,
        }

    def can_start(self) -> bool:
        return 2 <= len(self.players) <= 4

    def get_player(self, player_id: str) -> Optional[LobbyPlayer]:
        return next((p for p in self.players if p.player_id == player_id), None)

    def get_player_by_token(self, token: str) -> Optional[LobbyPlayer]:
        return next((p for p in self.players if p.session_token == token), None)

    def next_player_id(self) -> str:
        """Primo id "player_N" libero: con i Bot rimossi, len(players) + 1
        potrebbe già essere in uso."""
        used = {p.player_id for p in self.players}
        n = 1
        while f"player_{n}" in used:
            n += 1
        return f"player_{n}"


def generate_lobby_code() -> str:
    """Genera un codice lobby tipo BARB-7X3K."""
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(random.choices(chars, k=4))
    return f"BARB-{suffix}"


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def create_lobby(creator_name: str, turn_timer: int = 0) -> dict:
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

    player_id = lobby.next_player_id()
    session_token = generate_session_token()
    player = LobbyPlayer(player_id=player_id, name=player_name, session_token=session_token)
    lobby.players.append(player)
    _sort_by_seat_hint(lobby)

    # Un Bot con lo stesso nome del nuovo arrivato viene ribattezzato
    for bot in lobby.players:
        if bot.is_bot and _same_name(bot.name, player_name):
            bot.name = _pick_bot_name(lobby, exclude=bot)

    return {
        "lobby_code": lobby_code,
        "player_id": player_id,
        "session_token": session_token,
        "lobby": lobby.to_dict(),
    }


def get_lobby(lobby_code: str) -> Optional[LobbyInfo]:
    return _lobbies.get(lobby_code)


# ---------------------------------------------------------------------------
# Bot e ordine dei posti (solo il creatore, prima dell'avvio)
# ---------------------------------------------------------------------------

BOT_DIFFICULTIES = ("easy", "normal", "hard")


def _same_name(a: str, b: str) -> bool:
    return a.strip().casefold() == b.strip().casefold()


def _recruit_names() -> List[str]:
    """Nomi dei Bot: ogni Recluta col prefisso "Mecha-" (es. Mecha-Araminta)."""
    from engine import cards
    if not cards.CARD_REGISTRY:
        cards.load_cards()
    return [f"Mecha-{c.name}" for c in cards.CARD_REGISTRY.values()
            if c.type == "warrior" and getattr(c, "subtype", None) == "recruit"]


def _pick_bot_name(lobby: LobbyInfo, exclude: Optional[LobbyPlayer] = None) -> str:
    """Nome casuale tra le Reclute, diverso da quello di ogni altro giocatore
    della lobby (umano o Bot)."""
    taken = [p.name for p in lobby.players if p is not exclude]
    free = [n for n in _recruit_names() if not any(_same_name(n, t) for t in taken)]
    return random.choice(free) if free else f"Bot {len(lobby.players)}"


def _lobby_for_creator(lobby_code: str, requester_id: str) -> LobbyInfo:
    lobby = _lobbies.get(lobby_code)
    if lobby is None:
        raise ValueError(f"Lobby {lobby_code} non trovata.")
    if requester_id != lobby.creator_id:
        raise PermissionError("Solo il creatore della lobby può farlo.")
    if lobby.game_id is not None:
        raise ValueError("La partita è già iniziata.")
    return lobby


def add_bot(lobby_code: str, requester_id: str) -> LobbyInfo:
    lobby = _lobby_for_creator(lobby_code, requester_id)
    if len(lobby.players) >= 4:
        raise ValueError("Lobby piena (massimo 4 giocatori).")
    bot = LobbyPlayer(player_id=lobby.next_player_id(), name=_pick_bot_name(lobby),
                      session_token=None, is_bot=True)
    lobby.players.append(bot)
    return lobby


def remove_bot(lobby_code: str, requester_id: str, bot_id: str) -> LobbyInfo:
    lobby = _lobby_for_creator(lobby_code, requester_id)
    bot = lobby.get_player(bot_id)
    if bot is None or not bot.is_bot:
        raise ValueError("Bot non trovato.")
    lobby.players.remove(bot)
    return lobby


def reorder_players(lobby_code: str, requester_id: str, order: List[str]) -> LobbyInfo:
    """Riordina i posti al tavolo: `order` è la lista completa dei player_id."""
    lobby = _lobby_for_creator(lobby_code, requester_id)
    by_id = {p.player_id: p for p in lobby.players}
    if len(order) != len(by_id) or set(order) != set(by_id):
        # Qualcuno è entrato/uscito nel frattempo: il client ricarica la lista
        raise ValueError("La lista dei giocatori è cambiata, riprova.")
    lobby.players = [by_id[pid] for pid in order]
    return lobby


def set_bot_difficulty(lobby_code: str, requester_id: str, difficulty: str) -> LobbyInfo:
    lobby = _lobby_for_creator(lobby_code, requester_id)
    if difficulty not in BOT_DIFFICULTIES:
        raise ValueError("Difficoltà non valida.")
    lobby.bot_difficulty = difficulty
    return lobby


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
    # Gli id della lobby vanno passati subito: la distribuzione iniziale e il
    # primo inizio turno scrivono già nel log usando gli id dei giocatori.
    state = create_game(player_names, game_id=game_id,
                        player_ids=[lp.player_id for lp in lobby.players])
    state.turn_timer = lobby.turn_timer

    state.bot_player_ids = [lp.player_id for lp in lobby.players if lp.is_bot]
    if state.bot_player_ids:
        state.bot_difficulty = lobby.bot_difficulty
    state.mode = "lobby"

    lobby.game_id = game_id
    return state


def remove_lobby(lobby_code: str) -> None:
    _lobbies.pop(lobby_code, None)


# ---------------------------------------------------------------------------
# Rivincita (partite multigiocatore)
# ---------------------------------------------------------------------------

# game_id della partita finita -> {"lobby_code": str, "members": {vecchio player_id: dati di accesso}}
_rematches: Dict[str, dict] = {}


def _sort_by_seat_hint(lobby: LobbyInfo) -> None:
    """In una sala di rivincita i giocatori riprendono i posti della partita
    precedente, in qualunque ordine rientrino (sort stabile: chi non ha un
    posto noto resta in fondo)."""
    if any(p.seat_hint is not None for p in lobby.players):
        lobby.players.sort(key=lambda p: 99 if p.seat_hint is None else p.seat_hint)


def rematch(state: "GameState", requester_id: str) -> dict:
    """Rivincita di una partita multigiocatore finita.

    Il primo che la chiede crea una nuova sala d'attesa (e ne diventa il
    creatore) con le stesse impostazioni: timer, difficoltà e nomi dei Bot,
    posti al tavolo. Gli altri, chiedendola, entrano nella stessa sala.
    Ritorna i dati di accesso come create_lobby/join_lobby, più `created`.
    """
    if not state.winner_id:
        raise ValueError("La partita non è ancora finita.")
    me = state.get_player(requester_id)
    if me is None:
        raise ValueError("Giocatore non trovato.")
    seat = {p.id: i for i, p in enumerate(state.players)}

    entry = _rematches.get(state.game_id)
    lobby = _lobbies.get(entry["lobby_code"]) if entry else None
    if lobby is not None:
        known = entry["members"].get(requester_id)
        if known:
            return {**known, "lobby": lobby.to_dict(), "created": False}
        if lobby.game_id is not None:
            raise ValueError("La rivincita è già cominciata.")
        joined = join_lobby(lobby.lobby_code, me.name)
        lobby.get_player(joined["player_id"]).seat_hint = seat[requester_id]
        _sort_by_seat_hint(lobby)
        creds = {"lobby_code": lobby.lobby_code, "player_id": joined["player_id"],
                 "session_token": joined["session_token"], "is_creator": False}
        entry["members"][requester_id] = creds
        return {**creds, "lobby": lobby.to_dict(), "created": False}

    created = create_lobby(me.name, state.turn_timer)
    lobby = _lobbies[created["lobby_code"]]
    lobby.players[0].seat_hint = seat[requester_id]
    lobby.bot_difficulty = state.bot_difficulty or "normal"
    for p in state.players:
        if state.is_bot(p.id):
            bot = LobbyPlayer(player_id=lobby.next_player_id(), name=p.name,
                              session_token=None, is_bot=True)
            bot.seat_hint = seat[p.id]
            lobby.players.append(bot)
    _sort_by_seat_hint(lobby)
    creds = {"lobby_code": lobby.lobby_code, "player_id": created["player_id"],
             "session_token": created["session_token"], "is_creator": True}
    _rematches[state.game_id] = {"lobby_code": lobby.lobby_code, "members": {requester_id: creds}}
    return {**creds, "lobby": lobby.to_dict(), "created": True}


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
