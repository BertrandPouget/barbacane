"""
WebSocket Connection Manager per Barbacane.
Gestisce le connessioni attive e il broadcast degli aggiornamenti di stato.
"""

from __future__ import annotations
import asyncio
import json
from typing import Dict, List, Optional, Set

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # game_id → {player_id: WebSocket}
        self._connections: Dict[str, Dict[str, WebSocket]] = {}
        # game_id → asyncio.Task (turn timer)
        self._turn_timers: Dict[str, asyncio.Task] = {}

    async def connect(self, game_id: str, player_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        if game_id not in self._connections:
            self._connections[game_id] = {}
        self._connections[game_id][player_id] = websocket

    def disconnect(self, game_id: str, player_id: str) -> None:
        if game_id in self._connections:
            self._connections[game_id].pop(player_id, None)
            if not self._connections[game_id]:
                del self._connections[game_id]

    async def broadcast(self, game_id: str, message: dict) -> None:
        """Invia un messaggio a tutti i giocatori connessi nella partita."""
        if game_id not in self._connections:
            return
        dead = []
        for player_id, ws in self._connections[game_id].items():
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(player_id)
        for pid in dead:
            self.disconnect(game_id, pid)

    async def send_to_player(self, game_id: str, player_id: str, message: dict) -> None:
        """Invia un messaggio a un singolo giocatore."""
        ws = self._connections.get(game_id, {}).get(player_id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(game_id, player_id)

    def connected_players(self, game_id: str) -> Set[str]:
        return set(self._connections.get(game_id, {}).keys())

    def is_connected(self, game_id: str, player_id: str) -> bool:
        return player_id in self._connections.get(game_id, {})

    # -----------------------------------------------------------------------
    # Turn Timer
    # -----------------------------------------------------------------------

    async def start_turn_timer(
        self,
        game_id: str,
        player_id: str,
        seconds: int = 120,
        on_expire_callback=None,
    ) -> None:
        """
        Avvia il timer per il turno. Allo scadere chiama on_expire_callback(game_id, player_id).
        """
        self.cancel_turn_timer(game_id)

        async def _timer():
            # Avvisa a 15 secondi
            if seconds > 15:
                await asyncio.sleep(seconds - 15)
                await self.broadcast(game_id, {
                    "type": "turn_warning",
                    "player_id": player_id,
                    "seconds_left": 15,
                })
                await asyncio.sleep(15)
            else:
                await asyncio.sleep(seconds)

            if on_expire_callback:
                await on_expire_callback(game_id, player_id)

        task = asyncio.create_task(_timer())
        self._turn_timers[game_id] = task

    def cancel_turn_timer(self, game_id: str) -> None:
        task = self._turn_timers.pop(game_id, None)
        if task and not task.done():
            task.cancel()


# Istanza globale
manager = ConnectionManager()
