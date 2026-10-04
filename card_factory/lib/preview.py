#!/usr/bin/env python3
"""
lib/preview.py
Anteprime: la carta intera rimpicciolita, per l'interfaccia di gioco.

Le carte finali in output/full/<id>.png sono a ~300 DPI (744×1040, ~1,2 MB l'una):
perfette per la vista ingrandita e per la stampa, troppo pesanti dove la carta
intera si vede piccola (Catalogo Carte, anteprima al passaggio del mouse).
Qui se ne ricava una versione ridotta in WebP, in output/preview/<id>.webp
(~30 KB), servita al frontend come
/card_images/preview/<id>.webp.

Un'anteprima viene rigenerata solo se manca o se il PNG di origine è più
recente: rilanciare lo script dopo aver aggiunto o modificato carte aggiorna
solo quelle toccate.

Usato da 4_make_previews.py e, in coda alla generazione, da 2_generate_cards.py.
"""

from pathlib import Path
from typing import Iterable, List, Optional

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent   # card_factory/
OUTPUT_DIR = ROOT / "output"
FULL_DIR = OUTPUT_DIR / "full"
PREVIEW_DIR = OUTPUT_DIR / "preview"

# Larghezza in pixel: l'anteprima al passaggio del mouse è larga 230 px CSS;
# 360 px restano nitidi anche sugli schermi ad alta densità.
WIDTH = 360
QUALITY = 82


def preview_path(card_id: str) -> Path:
    return PREVIEW_DIR / f"{card_id}.webp"


def make_previews(ids: Optional[Iterable[str]] = None, force: bool = False,
                  width: int = WIDTH, quality: int = QUALITY, quiet: bool = False) -> List[Path]:
    """Crea le anteprime delle carte in output/full/ (tutte, o solo gli `ids` indicati).

    Salta quelle già aggiornate, salvo `force`. Ritorna i file scritti.
    """
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    if ids is None:
        sources = sorted(FULL_DIR.glob("*.png"))
    else:
        sources = [FULL_DIR / f"{cid}.png" for cid in ids]

    written: List[Path] = []
    for src in sources:
        if not src.exists():
            if not quiet:
                print(f"  -- {src.name}: carta non ancora generata in output/full/, salto")
            continue
        dst = preview_path(src.stem)
        if not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        with Image.open(src) as im:
            im = im.convert("RGB")
            height = round(im.height * width / im.width)
            im.resize((width, height), Image.LANCZOS).save(dst, "WEBP", quality=quality, method=6)
        written.append(dst)
        if not quiet:
            print(f"  OK preview/{dst.name}  ({dst.stat().st_size // 1024} KB)")
    return written
