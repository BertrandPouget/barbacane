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

# Variante "completata" dell'Obelisco: stesso testo della carta ufficiale, ma con
# l'illustrazione alternativa (images/obelisco_completo.png), usata dal frontend
# come easter egg quando la costruzione viene completata in partita. Non è una
# carta giocabile a sé: non vive in cards.json (che alimenta anche il motore di
# gioco e il conteggio delle copie nel mazzo), esattamente come BACK_CARD.
OBELISCO_COMPLETO_CARD = {
    "id": "obelisco_completo",
    "name": "Obelisco",
    "type": "building",
    "cost": 1,
    "cost_type": "mana",
    "completion_cost": 2,
    "base_effect": "Dopo aver usato una Magia, lancia un D10. Se esce almeno 8, la Magia torna nella tua mano.",
    "complete_effect": "Dopo aver usato una Magia, lancia un D10. Se esce almeno 6, la Magia torna nella tua mano.",
    "effect_id": "obelisco_effect",
}

EXTRA_CARDS = [BACK_CARD, OBELISCO_COMPLETO_CARD]


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
    cards.extend(EXTRA_CARDS)
    id_to_name = {c["id"]: c["name"] for c in cards if "id" in c and "name" in c}
    return cards, id_to_name


def is_hero_card(card_id: str, json_path: Path = CARDS_JSON) -> bool:
    """Una carta è di tipo Eroe se è un Guerriero con evolves_from valorizzato."""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    for warrior in data["warriors"]:
        if warrior["id"] == card_id:
            return warrior.get("evolves_from") is not None
    return False
