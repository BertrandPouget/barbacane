#!/usr/bin/env python3
"""
2_generate_cards.py
Genera le carte Barbacane finali (versione gioco) dal renderer HTML unico
(assets/card.html). Legge i dati da ../data/cards.json e le illustrazioni da
images/<id>.png (assenti = carta con sola cornice, senza illustrazione).

render_cards() (lib/render.py) è riutilizzato anche da 3_make_print_pdf.py, che
rigenera le carte a risoluzione più alta apposta per la stampa senza toccare i
PNG in output/.

Utilizzo:
    python 2_generate_cards.py                   # tutte le carte
    python 2_generate_cards.py faust joseph      # solo le carte indicate
    python 2_generate_cards.py --scale 2         # 2x risoluzione (default 1 = 300 DPI)
"""

import argparse
import sys
from pathlib import Path

from lib.cards_data import CARDS_JSON, load_cards
from lib.render import render_cards

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "output"


def main():
    parser = argparse.ArgumentParser(
        description="Genera le carte Barbacane dal renderer HTML (card.html)."
    )
    parser.add_argument(
        "ids",
        nargs="*",
        help="Id delle carte da generare (es. faust joseph reinhold). "
             "Se omesso, genera tutte le carte del JSON.",
    )
    parser.add_argument(
        "--scale", type=float, default=1.0,
        help="Moltiplicatore di risoluzione (1 = 744x1039px, ~300 DPI). Default 1.",
    )
    parser.add_argument(
        "--debug-borders", action="store_true",
        help="Disegna i bordi colorati dei contenitori flex (per verificare centratura/spaziatura).",
    )
    args = parser.parse_args()

    cards, id_to_name = load_cards(CARDS_JSON)

    if args.ids:
        wanted = set(args.ids)
        missing = wanted - {c.get("id") for c in cards}
        if missing:
            print(f"Attenzione: id non trovati nel JSON: {', '.join(sorted(missing))}", file=sys.stderr)
        cards = [c for c in cards if c.get("id") in wanted]

    print(f"Carte da generare: {len(cards)}  (scala {args.scale}x)\n")
    render_cards(cards, id_to_name, OUT_DIR, scale=args.scale, debug=args.debug_borders)
    print(f"\nFatto — output in '{OUT_DIR}'")


if __name__ == "__main__":
    main()
