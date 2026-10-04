#!/usr/bin/env python3
"""
4_make_previews.py
Crea le anteprime (output/preview/<id>.webp, la carta intera rimpicciolita)
a partire dai PNG finali in output/full/, per catalogo e anteprima del gioco.

Rifà solo le anteprime mancanti o più vecchie del loro PNG: si può rilanciare
in qualunque momento. 2_generate_cards.py lo fa già da solo per le carte che
genera; questo script serve per ricrearle tutte o per sistemare a mano.

Utilizzo:
    python 4_make_previews.py                 # tutte le carte in output/full/
    python 4_make_previews.py faust joseph    # solo quelle indicate
    python 4_make_previews.py --force         # rigenera anche quelle aggiornate
"""

import argparse

from lib.preview import PREVIEW_DIR, QUALITY, WIDTH, make_previews


def main():
    parser = argparse.ArgumentParser(description="Crea le anteprime WebP delle carte in output/preview/.")
    parser.add_argument("ids", nargs="*", help="Id delle carte (es. faust joseph). Se omesso, tutte.")
    parser.add_argument("--force", action="store_true", help="Rigenera anche le anteprime già aggiornate.")
    parser.add_argument("--width", type=int, default=WIDTH, help=f"Larghezza in pixel (default {WIDTH}).")
    parser.add_argument("--quality", type=int, default=QUALITY, help=f"Qualità WebP 0-100 (default {QUALITY}).")
    args = parser.parse_args()

    written = make_previews(args.ids or None, force=args.force, width=args.width, quality=args.quality)
    print(f"\nFatto — {len(written)} anteprime aggiornate in '{PREVIEW_DIR}'")


if __name__ == "__main__":
    main()
