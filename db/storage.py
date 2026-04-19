"""
Persistenza SQLite per Barbacane.
Salva e carica lo stato delle partite.
"""

from __future__ import annotations
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Optional

from engine.models import GameState

DB_PATH = os.environ.get("BARBACANE_DB", os.path.join(os.path.dirname(__file__), "..", "barbacane.db"))


def get_db_path() -> str:
    return DB_PATH


@contextmanager
def get_conn():
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Crea le tabelle se non esistono."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS games (
                game_id     TEXT PRIMARY KEY,
                lobby_code  TEXT UNIQUE,
                state       TEXT NOT NULL,
                status      TEXT DEFAULT 'lobby',
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS players (
                player_id     TEXT PRIMARY KEY,
                game_id       TEXT REFERENCES games(game_id),
                name          TEXT NOT NULL,
                session_token TEXT UNIQUE,
                connected     INTEGER DEFAULT 1
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_games_lobby ON games(lobby_code)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id)")


def save_game(state: GameState, lobby_code: Optional[str] = None, status: str = "playing") -> None:
    """Serializza e salva lo stato di gioco in SQLite."""
    state_json = state.model_dump_json()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT game_id FROM games WHERE game_id = ?", (state.game_id,)
        ).fetchone()

        if existing:
            conn.execute(
                "UPDATE games SET state = ?, status = ?, updated_at = datetime('now') WHERE game_id = ?",
                (state_json, status, state.game_id),
            )
        else:
            conn.execute(
                "INSERT INTO games (game_id, lobby_code, state, status) VALUES (?, ?, ?, ?)",
                (state.game_id, lobby_code, state_json, status),
            )


def load_game(game_id: str) -> Optional[GameState]:
    """Carica e deserializza uno stato di gioco dal database."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT state FROM games WHERE game_id = ?", (game_id,)
        ).fetchone()
        if row is None:
            return None
        return GameState.model_validate_json(row["state"])


def load_game_by_lobby(lobby_code: str) -> Optional[GameState]:
    """Carica uno stato tramite codice lobby."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT state FROM games WHERE lobby_code = ?", (lobby_code,)
        ).fetchone()
        if row is None:
            return None
        return GameState.model_validate_json(row["state"])


def get_game_status(game_id: str) -> Optional[str]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT status FROM games WHERE game_id = ?", (game_id,)
        ).fetchone()
        return row["status"] if row else None


def set_game_status(game_id: str, status: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE games SET status = ?, updated_at = datetime('now') WHERE game_id = ?",
            (status, game_id),
        )


def save_player(game_id: str, player_id: str, name: str, session_token: str) -> None:
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT player_id FROM players WHERE player_id = ?", (player_id,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE players SET connected = 1 WHERE player_id = ?", (player_id,)
            )
        else:
            conn.execute(
                "INSERT INTO players (player_id, game_id, name, session_token) VALUES (?, ?, ?, ?)",
                (player_id, game_id, name, session_token),
            )


def get_player_by_token(session_token: str) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM players WHERE session_token = ?", (session_token,)
        ).fetchone()
        return dict(row) if row else None


def set_player_connected(player_id: str, connected: bool) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE players SET connected = ? WHERE player_id = ?",
            (1 if connected else 0, player_id),
        )


def get_players_for_game(game_id: str) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM players WHERE game_id = ?", (game_id,)
        ).fetchall()
        return [dict(r) for r in rows]
