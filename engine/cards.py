"""
Caricamento e registro delle carte.
CARD_REGISTRY mappa base_card_id → oggetto carta, per le carte di TUTTI i mazzi
elencati in data/decks.json (gli id sono unici tra i mazzi); DECKS descrive i
mazzi e quali carte contengono. Una partita usa un solo mazzo (GameState.deck_id).
"""

from __future__ import annotations
import json
import os
from typing import Dict, List, Optional, Union

from engine.models import WarriorCard, SpellCard, BuildingCard

CardDef = Union[WarriorCard, SpellCard, BuildingCard]

CARD_REGISTRY: Dict[str, CardDef] = {}

# deck_id → {"id", "name", "tagline", "file", "cards": [base_card_id, ...]}
DECKS: Dict[str, dict] = {}
DEFAULT_DECK = "base"

_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
_DATA_PATH = os.path.join(_DATA_DIR, "cards.json")
_DECKS_PATH = os.path.join(_DATA_DIR, "decks.json")


def _deck_manifest() -> List[dict]:
    """Elenco dei mazzi da data/decks.json; senza manifest, il solo mazzo base."""
    try:
        with open(_DECKS_PATH, encoding="utf-8") as f:
            return json.load(f)["decks"]
    except FileNotFoundError:
        return [{"id": DEFAULT_DECK, "name": "Barbacane", "file": "cards.json"}]


def _load_deck_file(path: str, deck_id: str, registry: Dict[str, CardDef]) -> List[str]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    ids: List[str] = []
    for key, model in (("warriors", WarriorCard), ("spells", SpellCard), ("buildings", BuildingCard)):
        for raw in data.get(key, []):
            card = model(**{**raw, "deck": deck_id})
            if card.id in registry:
                raise ValueError(f"Id carta duplicato tra i mazzi: {card.id}")
            registry[card.id] = card
            ids.append(card.id)
    return ids


def load_cards(path: Optional[str] = None) -> Dict[str, CardDef]:
    """Carica le carte e popola CARD_REGISTRY e DECKS. Con `path` carica solo quel
    file come mazzo base; senza, tutti i mazzi di data/decks.json.
    I due dizionari sono aggiornati sul posto: gli altri moduli li importano per nome."""
    registry: Dict[str, CardDef] = {}
    decks: Dict[str, dict] = {}
    if path:
        manifest = [{"id": DEFAULT_DECK, "name": "Barbacane", "file": os.path.basename(path)}]
        paths = [path]
    else:
        manifest = _deck_manifest()
        paths = [os.path.join(_DATA_DIR, entry["file"]) for entry in manifest]
    for entry, file_path in zip(manifest, paths):
        ids = _load_deck_file(file_path, entry["id"], registry)
        decks[entry["id"]] = {**entry, "cards": ids}

    CARD_REGISTRY.clear()
    CARD_REGISTRY.update(registry)
    DECKS.clear()
    DECKS.update(decks)
    return CARD_REGISTRY


def get_card(card_id: str) -> CardDef:
    if not CARD_REGISTRY:
        load_cards()
    if card_id not in CARD_REGISTRY:
        raise KeyError(f"Carta non trovata: {card_id}")
    return CARD_REGISTRY[card_id]


def deck_card_ids(deck_id: str) -> List[str]:
    """base_card_id delle carte del mazzo; ValueError se il mazzo non esiste."""
    if not DECKS:
        load_cards()
    if deck_id not in DECKS:
        raise ValueError(f"Mazzo sconosciuto: {deck_id}")
    return list(DECKS[deck_id]["cards"])


def decks_meta() -> List[dict]:
    """Mazzi disponibili per lobby e client: id, nome, descrizione, numero di carte."""
    if not DECKS:
        load_cards()
    return [
        {
            "id": d["id"],
            "name": d["name"],
            "tagline": d.get("tagline", ""),
            "file": d["file"],
            "card_count": sum(CARD_REGISTRY[c].copies for c in d["cards"]),
        }
        for d in DECKS.values()
    ]


# Carica al momento dell'import
load_cards()
