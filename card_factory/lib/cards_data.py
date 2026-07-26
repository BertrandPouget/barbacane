#!/usr/bin/env python3
"""
lib/cards_data.py
Accesso condiviso a ../data/cards.json (fonte diretta anche per il motore di gioco).
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # card_factory/
CARDS_JSON = ROOT.parent / "data" / "cards.json"    # barbacane/data/cards.json

# Il retro non è una carta da gioco: non vive in cards.json, si genera comunque con
# card.html (case "back" in renderCard) per restare l'unica fonte di verità grafica.
BACK_CARD = {"id": "retro", "name": "Retro", "type": "back"}


def load_cards(json_path: Path = CARDS_JSON):
    """Accetta sia una lista piatta sia un dict {categoria: [carte...]}."""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        cards = data
    else:
        cards = []
        for v in data.values():
            if isinstance(v, list):
                cards.extend(v)
    cards.append(BACK_CARD)
    id_to_name = {c["id"]: c["name"] for c in cards if "id" in c and "name" in c}
    return cards, id_to_name


def is_hero_card(card_id: str, json_path: Path = CARDS_JSON) -> bool:
    """Una carta è di tipo Eroe se è un Guerriero con evolves_from valorizzato."""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    for warrior in data["warriors"]:
        if warrior["id"] == card_id:
            return warrior.get("evolves_from") is not None
    return False
