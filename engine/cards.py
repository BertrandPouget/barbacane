"""
Caricamento e registro delle carte da cards.json.
CARD_REGISTRY mappa base_card_id → oggetto carta.
"""

from __future__ import annotations
import json
import os
from typing import Dict, Union

from engine.models import WarriorCard, SpellCard, BuildingCard

CardDef = Union[WarriorCard, SpellCard, BuildingCard]

CARD_REGISTRY: Dict[str, CardDef] = {}

_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "cards.json")


def load_cards(path: str = _DATA_PATH) -> Dict[str, CardDef]:
    """Carica tutte le carte dal JSON e popola CARD_REGISTRY."""
    global CARD_REGISTRY
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    registry: Dict[str, CardDef] = {}
    for raw in data.get("warriors", []):
        card = WarriorCard(**raw)
        registry[card.id] = card
    for raw in data.get("spells", []):
        card = SpellCard(**raw)
        registry[card.id] = card
    for raw in data.get("buildings", []):
        card = BuildingCard(**raw)
        registry[card.id] = card

    CARD_REGISTRY = registry
    return registry


def get_card(card_id: str) -> CardDef:
    if not CARD_REGISTRY:
        load_cards()
    if card_id not in CARD_REGISTRY:
        raise KeyError(f"Carta non trovata: {card_id}")
    return CARD_REGISTRY[card_id]


# Carica al momento dell'import
load_cards()
