"""
Persistenza per Barbacane.
Salva e carica lo stato delle partite.

Backend:
- Postgres (Neon) se la variabile d'ambiente DATABASE_URL è impostata.
- SQLite locale altrimenti (sviluppo).

Tutte le query usano il placeholder '?' e vengono convertite a '%s' per
Postgres. I timestamp sono generati lato Python (ISO 8601 UTC) così il SQL
resta identico sui due backend.
"""

from __future__ import annotations
import json
import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

from engine.models import GameState

logger = logging.getLogger("barbacane")

DATABASE_URL = os.environ.get("DATABASE_URL")
IS_POSTGRES = bool(DATABASE_URL)

DB_PATH = os.environ.get("BARBACANE_DB", os.path.join(os.path.dirname(__file__), "..", "barbacane.db"))

if IS_POSTGRES:
    import psycopg
    from psycopg.rows import dict_row


def get_db_path() -> str:
    return DB_PATH


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _q(sql: str) -> str:
    """Adatta il placeholder '?' a '%s' per Postgres."""
    return sql.replace("?", "%s") if IS_POSTGRES else sql


@contextmanager
def get_conn():
    if IS_POSTGRES:
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    else:
        conn = sqlite3.connect(get_db_path(), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        # SQLite ignora le foreign key se non le si abilita esplicitamente,
        # Postgres le applica sempre: senza questo PRAGMA una violazione di
        # vincolo passa inosservata in sviluppo e rompe solo in produzione.
        conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _legacy_players_pk(conn) -> bool:
    """
    True se la tabella `players` esiste ancora con la vecchia chiave primaria
    sul solo `player_id`. Gli id ("player_1"..."player_4") sono riassegnati
    identici a ogni partita, quindi quella chiave permetteva una sola riga per
    id in tutto il database: ogni nuova partita rubava la riga (e il token) a
    quella precedente.
    """
    if IS_POSTGRES:
        row = conn.execute("""
            SELECT count(*) AS n
              FROM information_schema.table_constraints t
              JOIN information_schema.key_column_usage k
                ON k.constraint_name = t.constraint_name
               AND k.table_schema = t.table_schema
             WHERE t.table_name = 'players'
               AND t.table_schema = current_schema()
               AND t.constraint_type = 'PRIMARY KEY'
        """).fetchone()
        return bool(row) and row["n"] == 1
    rows = conn.execute("PRAGMA table_info(players)").fetchall()
    return len([r for r in rows if r["pk"]]) == 1


def _migrate_players_pk(conn) -> None:
    """
    Porta `players` alla chiave primaria (game_id, player_id).

    La tabella viene ricreata invece che alterata: il rename in-place non è
    portabile, perché su Postgres i vincoli (`players_pkey`, l'unique sul
    token) restano legati alla tabella rinominata e vanno in conflitto con
    quelli della nuova. Le righe sono al massimo una manciata, quindi si
    leggono, si ricrea la tabella e si reinseriscono.
    """
    if not _legacy_players_pk(conn):
        return
    # Il JOIN scarta le righe orfane (partita gia' cancellata). Con la vecchia
    # SQLite senza foreign key attive potevano essercene; reinserirle ora
    # violerebbe il vincolo e farebbe fallire l'avvio.
    rows = conn.execute("""
        SELECT p.player_id, p.game_id, p.name, p.session_token, p.connected
          FROM players p
          JOIN games g ON g.game_id = p.game_id
    """).fetchall()
    conn.execute("DROP TABLE players")
    conn.execute("""
        CREATE TABLE players (
            player_id     TEXT NOT NULL,
            game_id       TEXT NOT NULL REFERENCES games(game_id),
            name          TEXT NOT NULL,
            session_token TEXT UNIQUE,
            connected     INTEGER DEFAULT 1,
            PRIMARY KEY (game_id, player_id)
        )
    """)
    for r in rows:
        if not r["game_id"]:
            continue  # riga orfana: senza partita non serve a nessuno
        conn.execute(
            _q("INSERT INTO players (player_id, game_id, name, session_token, connected)"
               " VALUES (?, ?, ?, ?, ?)"),
            (r["player_id"], r["game_id"], r["name"], r["session_token"], r["connected"]),
        )


def init_db() -> None:
    """Crea le tabelle se non esistono."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS games (
                game_id     TEXT PRIMARY KEY,
                lobby_code  TEXT UNIQUE,
                state       TEXT NOT NULL,
                status      TEXT DEFAULT 'lobby',
                created_at  TEXT,
                updated_at  TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS players (
                player_id     TEXT NOT NULL,
                game_id       TEXT NOT NULL REFERENCES games(game_id),
                name          TEXT NOT NULL,
                session_token TEXT UNIQUE,
                connected     INTEGER DEFAULT 1,
                PRIMARY KEY (game_id, player_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_games_lobby ON games(lobby_code)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id)")

    # La migrazione gira in una transazione separata e i suoi errori non sono
    # fatali: se fallisce si resta sullo schema vecchio (che funziona, solo con
    # il limite di una riga per player_id) invece di impedire l'avvio del
    # servizio. Il CREATE qui sopra e' un no-op quando la tabella esiste gia'.
    try:
        with get_conn() as conn:
            _migrate_players_pk(conn)
    except Exception as e:
        logger.error("[db] Migrazione della chiave di players fallita: %s", e)


def save_game(state: GameState, lobby_code: Optional[str] = None, status: str = "playing") -> None:
    """Serializza e salva lo stato di gioco."""
    state_json = state.model_dump_json()
    now = _now()
    with get_conn() as conn:
        existing = conn.execute(
            _q("SELECT game_id FROM games WHERE game_id = ?"), (state.game_id,)
        ).fetchone()

        if existing:
            conn.execute(
                _q("UPDATE games SET state = ?, status = ?, updated_at = ? WHERE game_id = ?"),
                (state_json, status, now, state.game_id),
            )
        else:
            conn.execute(
                _q("INSERT INTO games (game_id, lobby_code, state, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
                (state.game_id, lobby_code, state_json, status, now, now),
            )


def load_game(game_id: str) -> Optional[GameState]:
    """Carica e deserializza uno stato di gioco dal database."""
    with get_conn() as conn:
        row = conn.execute(
            _q("SELECT state FROM games WHERE game_id = ?"), (game_id,)
        ).fetchone()
        if row is None:
            return None
        return GameState.model_validate_json(row["state"])


def load_game_by_lobby(lobby_code: str) -> Optional[GameState]:
    """Carica uno stato tramite codice lobby."""
    with get_conn() as conn:
        row = conn.execute(
            _q("SELECT state FROM games WHERE lobby_code = ?"), (lobby_code,)
        ).fetchone()
        if row is None:
            return None
        return GameState.model_validate_json(row["state"])


def get_game_status(game_id: str) -> Optional[str]:
    with get_conn() as conn:
        row = conn.execute(
            _q("SELECT status FROM games WHERE game_id = ?"), (game_id,)
        ).fetchone()
        return row["status"] if row else None


def set_game_status(game_id: str, status: str) -> None:
    with get_conn() as conn:
        conn.execute(
            _q("UPDATE games SET status = ?, updated_at = ? WHERE game_id = ?"),
            (status, _now(), game_id),
        )


def delete_game(game_id: str) -> None:
    """Elimina una partita e i suoi giocatori."""
    with get_conn() as conn:
        conn.execute(_q("DELETE FROM players WHERE game_id = ?"), (game_id,))
        conn.execute(_q("DELETE FROM games WHERE game_id = ?"), (game_id,))


def cleanup_games(finished_grace_minutes: int = 5, stale_hours: float = 1) -> int:
    """
    Elimina le partite concluse da più di `finished_grace_minutes` e quelle
    abbandonate (nessun aggiornamento da `stale_hours` ore).
    Ritorna il numero di partite eliminate.
    I timestamp ISO 8601 UTC si confrontano correttamente come stringhe.
    """
    now = datetime.now(timezone.utc)
    finished_cutoff = (now - timedelta(minutes=finished_grace_minutes)).isoformat()
    stale_cutoff = (now - timedelta(hours=stale_hours)).isoformat()
    with get_conn() as conn:
        rows = conn.execute(
            _q("""
                SELECT game_id FROM games
                WHERE (status = 'finished' AND updated_at < ?)
                   OR updated_at < ?
                   OR updated_at IS NULL
            """),
            (finished_cutoff, stale_cutoff),
        ).fetchall()
        game_ids = [r["game_id"] for r in rows]
        for gid in game_ids:
            conn.execute(_q("DELETE FROM players WHERE game_id = ?"), (gid,))
            conn.execute(_q("DELETE FROM games WHERE game_id = ?"), (gid,))
        return len(game_ids)


def save_player(game_id: str, player_id: str, name: str, session_token: str) -> None:
    """
    Salva/aggiorna la riga del giocatore.

    `player_id` (es. "player_1") NON identifica un giocatore: ogni lobby,
    tutorial o partita contro il Bot riassegna gli stessi id in base all'ordine
    di ingresso. La riga è quindi identificata dalla coppia (game_id,
    player_id), e ogni partita ha le proprie: due partite in corso nello stesso
    momento non si sovrascrivono più il token a vicenda.
    """
    with get_conn() as conn:
        existing = conn.execute(
            _q("SELECT player_id FROM players WHERE game_id = ? AND player_id = ?"),
            (game_id, player_id),
        ).fetchone()
        if existing:
            conn.execute(
                _q("UPDATE players SET name = ?, session_token = ?, connected = 1"
                   " WHERE game_id = ? AND player_id = ?"),
                (name, session_token, game_id, player_id),
            )
        else:
            conn.execute(
                _q("INSERT INTO players (player_id, game_id, name, session_token) VALUES (?, ?, ?, ?)"),
                (player_id, game_id, name, session_token),
            )


def get_player_by_token(session_token: str) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute(
            _q("SELECT * FROM players WHERE session_token = ?"), (session_token,)
        ).fetchone()
        return dict(row) if row else None


def set_player_connected(game_id: str, player_id: str, connected: bool) -> None:
    # `player_id` da solo non è univoco tra partite: serve anche il game_id.
    with get_conn() as conn:
        conn.execute(
            _q("UPDATE players SET connected = ? WHERE game_id = ? AND player_id = ?"),
            (1 if connected else 0, game_id, player_id),
        )


def get_players_for_game(game_id: str) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            _q("SELECT * FROM players WHERE game_id = ?"), (game_id,)
        ).fetchall()
        return [dict(r) for r in rows]
