"""
Gestione del mazzo condiviso:
- Generazione delle 200 istanze a partire da cards.json
- Shuffle
- Pesca (con riciclo degli scarti se il mazzo finisce)
"""

from __future__ import annotations
import random
from typing import Dict, List, Optional

from engine.cards import CARD_REGISTRY, CardDef
from engine.models import (
    GameState,
    WarriorInstance,
    BuildingInstance,
    WallInstance,
)


def build_instance_registry(card_registry=None) -> Dict[str, CardDef]:
    """
    Genera il mapping instance_id → CardDef per tutte le 200 carte.
    Gli ID sono nel formato "{base_card_id}_{numero_copia}".
    Ritorna il dizionario instance_id → CardDef.
    """
    if card_registry is None:
        card_registry = CARD_REGISTRY
    instances: Dict[str, CardDef] = {}
    for card in card_registry.values():
        for i in range(1, card.copies + 1):
            iid = f"{card.id}_{i}"
            instances[iid] = card
    return instances


# Registry globale instance_id → CardDef (costruito alla prima chiamata)
_INSTANCE_REGISTRY: Optional[Dict[str, CardDef]] = None


def get_instance_registry() -> Dict[str, CardDef]:
    global _INSTANCE_REGISTRY
    if _INSTANCE_REGISTRY is None:
        _INSTANCE_REGISTRY = build_instance_registry()
    return _INSTANCE_REGISTRY


def get_base_card_id(instance_id: str) -> str:
    """Estrae il base_card_id da un instance_id (es. 'patrizio_3' → 'patrizio')."""
    parts = instance_id.rsplit("_", 1)
    return parts[0]


def build_deck() -> List[str]:
    """
    Costruisce e mescola il mazzo di 200 carte.
    Ritorna una lista di instance_ids (l'inizio della lista è la cima del mazzo).
    """
    reg = get_instance_registry()
    deck = list(reg.keys())
    random.shuffle(deck)
    return deck


def draw_cards(state: GameState, player_id: str, count: int) -> List[str]:
    """
    Pesca `count` carte dal mazzo per il giocatore `player_id`.
    Se il mazzo è vuoto, ricicla gli scarti (con shuffle).
    Ritorna la lista degli instance_ids pescati.
    """
    player = state.get_player(player_id)
    if player is None:
        raise ValueError(f"Giocatore non trovato: {player_id}")

    drawn: List[str] = []
    for _ in range(count):
        if not state.deck:
            if not state.discard_pile:
                break  # nessuna carta disponibile
            # Ricicla il mazzo
            state.deck = list(state.discard_pile)
            state.discard_pile.clear()
            random.shuffle(state.deck)

        card_id = state.deck.pop(0)
        drawn.append(card_id)
        player.hand.append(card_id)

    state.add_log(player_id, "draw", cards=drawn, count=len(drawn))
    return drawn


def draw_to_hand_limit(state: GameState, player_id: str, limit: int = 5) -> List[str]:
    """Pesca carte fino a raggiungere `limit` carte in mano (senza scartare l'eccesso)."""
    player = state.get_player(player_id)
    if player is None:
        raise ValueError(f"Giocatore non trovato: {player_id}")
    deficit = max(0, limit - len(player.hand))
    if deficit == 0:
        return []
    return draw_cards(state, player_id, deficit)




def make_warrior_instance(instance_id: str) -> WarriorInstance:
    """Crea un WarriorInstance da un instance_id."""
    return WarriorInstance(
        instance_id=instance_id,
        base_card_id=get_base_card_id(instance_id),
    )


def make_building_instance(instance_id: str) -> BuildingInstance:
    """Crea un BuildingInstance da un instance_id."""
    base_id = get_base_card_id(instance_id)
    from engine.cards import get_card, BuildingCard
    card = get_card(base_id)
    auto = getattr(card, "auto_complete", False)
    return BuildingInstance(
        instance_id=instance_id,
        base_card_id=base_id,
        completed=auto,  # Cardo/Decumano completano immediatamente
    )


def make_wall_instance(instance_id: str, durability: int = 1) -> WallInstance:
    """Crea un WallInstance da un instance_id."""
    return WallInstance(
        instance_id=instance_id,
        base_card_id=get_base_card_id(instance_id),
        durability=durability,
    )
