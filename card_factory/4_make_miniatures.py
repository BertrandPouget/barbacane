#!/usr/bin/env python3
"""
4_make_miniatures.py
Crea le miniature leggere delle carte (output/miniature/<id>.webp) a partire
dai PNG finali in output/, per le carte piccole dell'interfaccia di gioco.

Rifà solo le miniature mancanti o più vecchie del loro PNG: si può rilanciare
in qualunque momento. 2_generate_cards.py lo fa già da solo per le carte che
genera; questo script serve per ricrearle tutte o per sistemare a mano.

Utilizzo:
    python 4_make_miniatures.py                 # tutte le carte in output/
    python 4_make_miniatures.py faust joseph    # solo quelle indicate
    python 4_make_miniatures.py --force         # rigenera anche quelle aggiornate
"""

import argparse

from lib.miniature import MINIATURE_DIR, QUALITY, WIDTH, make_miniatures


def main():
    parser = argparse.ArgumentParser(description="Crea le miniature WebP delle carte in output/miniature/.")
    parser.add_argument("ids", nargs="*", help="Id delle carte (es. faust joseph). Se omesso, tutte.")
    parser.add_argument("--force", action="store_true", help="Rigenera anche le miniature già aggiornate.")
    parser.add_argument("--width", type=int, default=WIDTH, help=f"Larghezza in pixel (default {WIDTH}).")
    parser.add_argument("--quality", type=int, default=QUALITY, help=f"Qualità WebP 0-100 (default {QUALITY}).")
    args = parser.parse_args()

    written = make_miniatures(args.ids or None, force=args.force, width=args.width, quality=args.quality)
    print(f"\nFatto — {len(written)} miniature aggiornate in '{MINIATURE_DIR}'")


if __name__ == "__main__":
    main()
