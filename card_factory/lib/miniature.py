#!/usr/bin/env python3
"""
lib/miniature.py
Miniature leggere delle carte per l'interfaccia di gioco.

Le carte finali in output/<id>.png sono a ~300 DPI (744×1040, ~1,2 MB l'una):
perfette per la vista ingrandita e per la stampa, troppo pesanti per le carte
piccole in mano. Qui se ne ricava una versione ridotta in WebP, in
output/miniature/<id>.webp (~30 KB), servita al frontend come
/card_images/miniature/<id>.webp.

Una miniatura viene rigenerata solo se manca o se il PNG di origine è più
recente: rilanciare lo script dopo aver aggiunto o modificato carte aggiorna
solo quelle toccate.

Usato da 4_make_miniatures.py e, in coda alla generazione, da 2_generate_cards.py.
"""

from pathlib import Path
from typing import Iterable, List, Optional

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent   # card_factory/
OUTPUT_DIR = ROOT / "output"
MINIATURE_DIR = OUTPUT_DIR / "miniature"

# Larghezza in pixel: le carte in mano sono larghe ~90–100 px CSS e su desktop
# si ingrandiscono al passaggio del mouse; 360 px restano nitide anche sugli
# schermi ad alta densità.
WIDTH = 360
QUALITY = 82


def miniature_path(card_id: str) -> Path:
    return MINIATURE_DIR / f"{card_id}.webp"


def make_miniatures(ids: Optional[Iterable[str]] = None, force: bool = False,
                    width: int = WIDTH, quality: int = QUALITY, quiet: bool = False) -> List[Path]:
    """Crea le miniature delle carte in output/ (tutte, o solo gli `ids` indicati).

    Salta quelle già aggiornate, salvo `force`. Ritorna i file scritti.
    """
    MINIATURE_DIR.mkdir(parents=True, exist_ok=True)
    if ids is None:
        sources = sorted(OUTPUT_DIR.glob("*.png"))
    else:
        sources = [OUTPUT_DIR / f"{cid}.png" for cid in ids]

    written: List[Path] = []
    for src in sources:
        if not src.exists():
            if not quiet:
                print(f"  -- {src.name}: carta non ancora generata in output/, salto")
            continue
        dst = miniature_path(src.stem)
        if not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        with Image.open(src) as im:
            im = im.convert("RGB")
            height = round(im.height * width / im.width)
            im.resize((width, height), Image.LANCZOS).save(dst, "WEBP", quality=quality, method=6)
        written.append(dst)
        if not quiet:
            print(f"  OK miniature/{dst.name}  ({dst.stat().st_size // 1024} KB)")
    return written
