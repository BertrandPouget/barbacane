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
  - sfondo.webp la pergamena di fondo (assets/sfondo.png), ridotta;
  - retro.webp  il dorso (output/full/retro.png) con la cornice della minicarta,
                per i mazzi coperti del gioco (Muri, Vite, Carte Attive).

Le immagini dipendono solo dai file di partenza: rigenerarle dà sempre lo
stesso risultato.

Usato da 2_generate_cards.py.
"""

from pathlib import Path
from typing import Iterable, List

from PIL import Image, ImageDraw

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

# Dorso in formato minicarta: progetto 280×400 con cornice di 13 e angoli come in
# frontend (.card-art: raggio 5.7% della larghezza; pergamena: 2.9%). Nel gioco
# il mazzo è largo ~100 px CSS: 280 px restano nitidi anche ad alta densità.
FULL_DIR = ROOT / "output" / "full"
BACK_SIZE = (280, 400)
BACK_FRAME = 13
BACK_RADIUS_OUT = 16
BACK_RADIUS_IN = 8
BACK_FRAME_PX = 20            # spessore della cornice in retro.png (744 px di larghezza)
BACK_COLOR = (98, 55, 10, 255)  # colore della cornice di retro.png


def _save_webp(src: Path, dst: Path, width: int) -> None:
    with Image.open(src) as im:
        im = im.convert("RGBA")
        height = round(im.height * width / im.width)
        im.resize((width, height), Image.LANCZOS).save(dst, "WEBP", quality=QUALITY, method=6)


def make_mini_back(quiet: bool = False) -> Path:
    """Dorso con la cornice della minicarta: la pergamena di retro.png (senza la
    sua cornice, più sottile) dentro una cornice dello spessore delle minicarte."""
    MINI_DIR.mkdir(parents=True, exist_ok=True)
    w, h = BACK_SIZE
    with Image.open(FULL_DIR / "retro.png") as full:
        full = full.convert("RGBA")
        f = BACK_FRAME_PX
        inner = full.crop((f, f, full.width - f, full.height - f))
    iw, ih = w - 2 * BACK_FRAME, h - 2 * BACK_FRAME
    # Ritaglio centrato con le proporzioni dello spazio interno (la scritta resta al centro)
    scale = max(iw / inner.width, ih / inner.height)
    inner = inner.resize((round(inner.width * scale), round(inner.height * scale)), Image.LANCZOS)
    left, top = (inner.width - iw) // 2, (inner.height - ih) // 2
    inner = inner.crop((left, top, left + iw, top + ih))

    out = Image.new("RGBA", BACK_SIZE, (0, 0, 0, 0))
    ImageDraw.Draw(out).rounded_rectangle((0, 0, w - 1, h - 1), BACK_RADIUS_OUT, fill=BACK_COLOR)
    mask = Image.new("L", (iw, ih), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, iw - 1, ih - 1), BACK_RADIUS_IN, fill=255)
    out.paste(inner, (BACK_FRAME, BACK_FRAME), mask)

    dst = MINI_DIR / "retro.webp"
    out.save(dst, "WEBP", quality=QUALITY, method=6)
    if not quiet:
        print(f"  OK mini/{dst.name}  ({dst.stat().st_size // 1024} KB)")
    return dst


def make_minis(cards: Iterable[dict], quiet: bool = False) -> List[Path]:
    """Scrive l'illustrazione ridotta di ogni carta (salvo il retro) e la pergamena."""
    MINI_DIR.mkdir(parents=True, exist_ok=True)
    written: List[Path] = []

    sfondo = MINI_DIR / "sfondo.webp"
    _save_webp(ASSETS_DIR / "sfondo.png", sfondo, SFONDO_WIDTH)
    written.append(sfondo)
    written.append(make_mini_back(quiet))

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
