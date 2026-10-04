#!/usr/bin/env python3
"""
lib/mini.py
Immagini per le minicarte del gioco (le carte piccole in mano e in campo).

La minicarta è disegnata dal client in HTML/CSS (frontend/cardart.js), così i
testi restano nitidi a qualsiasi dimensione. Qui se ne preparano solo le
immagini, in output/mini/ (servite come /card_images/mini/):
  - <id>.webp   l'illustrazione della carta (images/<id>.png), ridotta e con la
                trasparenza; le carte senza illustrazione usano la stessa di
                ripiego della carta intera (card.html), così le due coincidono;
  - sfondo.webp la pergamena di fondo (assets/sfondo.png), ridotta.

Le immagini dipendono solo dai file di partenza: rigenerarle dà sempre lo
stesso risultato.

Usato da 2_generate_cards.py.
"""

from pathlib import Path
from typing import Iterable, List

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent   # card_factory/
IMAGES_DIR = ROOT / "images"
ASSETS_DIR = ROOT / "assets"
MINI_DIR = ROOT / "output" / "mini"

# Illustrazione di ripiego: la stessa di ILLUS_FALLBACK in card.html
FALLBACK_ID = "patrizio"

# Larghezza in pixel: nella minicarta l'illustrazione occupa ~85% della larghezza
# di una carta in mano (~100 px CSS); 320 px restano nitidi anche sugli schermi
# ad alta densità.
WIDTH = 320
QUALITY = 85
SFONDO_WIDTH = 400


def _save_webp(src: Path, dst: Path, width: int) -> None:
    with Image.open(src) as im:
        im = im.convert("RGBA")
        height = round(im.height * width / im.width)
        im.resize((width, height), Image.LANCZOS).save(dst, "WEBP", quality=QUALITY, method=6)


def make_minis(cards: Iterable[dict], quiet: bool = False) -> List[Path]:
    """Scrive l'illustrazione ridotta di ogni carta (salvo il retro) e la pergamena."""
    MINI_DIR.mkdir(parents=True, exist_ok=True)
    written: List[Path] = []

    sfondo = MINI_DIR / "sfondo.webp"
    _save_webp(ASSETS_DIR / "sfondo.png", sfondo, SFONDO_WIDTH)
    written.append(sfondo)

    for card in cards:
        cid = card.get("id")
        if not cid or card.get("type") == "back":
            continue
        src = IMAGES_DIR / f"{cid}.png"
        if not src.exists():
            src = IMAGES_DIR / f"{FALLBACK_ID}.png"
        dst = MINI_DIR / f"{cid}.webp"
        _save_webp(src, dst, WIDTH)
        written.append(dst)
        if not quiet:
            print(f"  OK mini/{dst.name}  ({dst.stat().st_size // 1024} KB)"
                  f"{'' if src.stem == cid else '  (illustrazione di ripiego)'}")
    return written
