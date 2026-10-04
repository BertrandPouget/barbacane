#!/usr/bin/env python3
"""
2_generate_cards.py
Genera le carte Barbacane finali (versione gioco) dal renderer HTML unico
(assets/card.html). Legge i dati da ../data/cards.json e le illustrazioni da
images/<id>.png (assenti = carta con sola cornice, senza illustrazione).

render_cards() (lib/render.py) è riutilizzato anche da 3_make_print_pdf.py, che
rigenera le carte a risoluzione più alta apposta per la stampa senza toccare i
PNG in output/full/.

In coda aggiorna anche le anteprime delle carte generate
(output/preview/<id>.webp: la carta intera rimpicciolita, per catalogo e anteprima,
vedi 4_make_previews.py) e le immagini delle loro minicarte (output/mini/:
illustrazione ridotta e pergamena, vedi lib/mini.py; la minicarta vera e propria
la disegna il gioco in HTML/CSS).

Utilizzo:
    python 2_generate_cards.py                   # tutte le carte
    python 2_generate_cards.py faust joseph      # solo le carte indicate
    python 2_generate_cards.py --scale 2         # 2x risoluzione (default 1 = 300 DPI)
    python 2_generate_cards.py --mini-only       # solo le immagini delle minicarte
"""

import argparse
import sys
from pathlib import Path

from lib.cards_data import CARDS_JSON, load_cards
from lib.preview import make_previews
from lib.mini import make_minis
from lib.render import render_cards

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "output"
FULL_DIR = OUT_DIR / "full"


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
    parser.add_argument(
        "--mini-only", action="store_true",
        help="Rigenera solo le immagini delle minicarte (output/mini/), senza toccare le carte intere.",
    )
    args = parser.parse_args()

    cards, id_to_name = load_cards(CARDS_JSON)

    if args.ids:
        wanted = set(args.ids)
        missing = wanted - {c.get("id") for c in cards}
        if missing:
            print(f"Attenzione: id non trovati nel JSON: {', '.join(sorted(missing))}", file=sys.stderr)
        cards = [c for c in cards if c.get("id") in wanted]

    if not args.mini_only:
        print(f"Carte da generare: {len(cards)}  (scala {args.scale}x)\n")
        render_cards(cards, id_to_name, FULL_DIR, scale=args.scale, debug=args.debug_borders)

        print("\nAnteprime (catalogo e passaggio del mouse):")
        make_previews([c.get("id") for c in cards])

    print("\nImmagini delle minicarte (mano e campo):")
    make_minis(cards)
    print(f"\nFatto — output in '{OUT_DIR}'")


if __name__ == "__main__":
    main()
