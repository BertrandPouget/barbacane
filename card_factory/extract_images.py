#!/usr/bin/env python3
"""
extract_cards.py
Estrae l'illustrazione da ogni pagina di un PDF di carte Barbacane.

Tipi di carta:
  - Standard (Recluta/altri): finestra illustrazione contenuta nel frame interno
  - Eroe:                     illustrazione che "sfora" sopra il frame interno

Utilizzo:
    python extract_cards.py input.pdf [--dpi 300] [--out ./images]
    python extract_cards.py input.pdf --dpi 300 --out ./images

Output: un PNG per pagina, sfondo bianco puro reso trasparente.
"""

import argparse
import sys
from pathlib import Path

import fitz  # PyMuPDF
import numpy as np
from PIL import Image


# ---------------------------------------------------------------------------
# Costanti di layout (derivate dall'analisi del PDF a 6× zoom = 36 px/pt)
# Tutti i valori sono espressi in PUNTI PDF (pt), validi per pagine 178.5×249.8 pt.
# ---------------------------------------------------------------------------

# Finestra illustrazione standard (Recluta ecc.)
# x leggermente stretto per escludere il bordo del frame; y1 appena sopra il banner nome
STANDARD_BOX_PT = (20.0, 25.8, 159.0, 105.5)   # x0, y0, x1, y1

# Finestra illustrazione eroe (stessa y0 dello standard — "subito sotto il rettangolo")
# La differenza è solo nel y1 più basso: l'illustrazione eroe è più alta.
HERO_BOX_PT    = (20.0, 25.8, 159.0, 158.5)

# Soglia cromaticità: differenza massima tra canali R/G/B per considerare un pixel "colorato"
COLOR_DIFF_THRESHOLD = 15

# Margine sotto l'area basic: 5mm in pt. Se esiste un pixel colorato oltre questa soglia → eroe.
HERO_MARGIN_PT = 5 * 72 / 25.4   # ≈ 14.2 pt

# ---------------------------------------------------------------------------
# Costanti per la rimozione dell'ottagono (badge costo) in alto a destra.
#
# L'ottagono è un badge ottagonale con corner in alto a sinistra formato da due diagonali:
#   [/] diagonale superiore: x_page + y_page = OCTAGON_SLASH_SUM  (130.4 pt)
#   [\] diagonale inferiore: x_page - y_page = OCTAGON_BACK_DIFF  (125.7 pt)
# Il corner si trova all'intersezione: page_x=143.45pt, page_y=17.55pt
#
# La maschera viene applicata in coordinate di PAGINA (pt), indipendentemente dal DPI.
# Questo gestisce correttamente sia le carte standard (crop y0=25.8pt, vedono solo [\])
# che le carte eroe (crop y0=10.8pt, vedono sia [/] che [\]).
# ---------------------------------------------------------------------------
OCTAGON_SLASH_SUM  = 161.0   # pt: x_page + y_page = questa costante (diagonale [/])
OCTAGON_BACK_DIFF  = 125.7   # pt: x_page - y_page = questa costante (diagonale [\])
OCTAGON_CORNER_Y   = 17.55   # pt: y_page del corner dell'ottagono
OCTAGON_MAX_Y_PAGE = 50.0    # pt: non applicare la maschera sotto questa y_page
CROP_X0_PT         = 20.0    # pt: x0 del crop (uguale per entrambi i tipi)


def is_truly_colored(arr: np.ndarray) -> np.ndarray:
    """Ritorna una maschera booleana: True dove il pixel ha colore reale (non grigio/B&N)."""
    r = arr[:, :, 0].astype(np.int32)
    g = arr[:, :, 1].astype(np.int32)
    b = arr[:, :, 2].astype(np.int32)
    max_diff = np.maximum(np.maximum(np.abs(r - g), np.abs(r - b)), np.abs(g - b))
    return max_diff > COLOR_DIFF_THRESHOLD


def pt_to_px(pt_val: float, scale: float) -> int:
    """Converte punti PDF in pixel arrotondati."""
    return int(round(pt_val * scale))


def render_page(page: fitz.Page, dpi: int) -> np.ndarray:
    """Renderizza una pagina e restituisce un array RGB."""
    scale = dpi / 72.0
    mat = fitz.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)


def detect_hero(arr: np.ndarray, scale: float) -> bool:
    """Ritorna True se esiste almeno un pixel colorato oltre 5mm sotto l'area basic."""
    x0 = pt_to_px(STANDARD_BOX_PT[0], scale)
    x1 = pt_to_px(STANDARD_BOX_PT[2], scale)
    y0 = pt_to_px(STANDARD_BOX_PT[3] + HERO_MARGIN_PT, scale)
    y1 = pt_to_px(HERO_BOX_PT[3], scale)

    zone = arr[y0:y1, x0:x1]
    if zone.size == 0:
        return False
    return bool(is_truly_colored(zone).any())


def crop_illustration(arr: np.ndarray, scale: float, hero: bool) -> np.ndarray:
    """Ritaglia la finestra illustrazione dall'immagine renderizzata."""
    box = HERO_BOX_PT if hero else STANDARD_BOX_PT
    x0 = pt_to_px(box[0], scale)
    y0 = pt_to_px(box[1], scale)
    x1 = pt_to_px(box[2], scale)
    y1 = pt_to_px(box[3], scale)
    return arr[y0:y1, x0:x1]


def make_white_transparent(arr: np.ndarray, scale: float,
                           crop_y0_pt: float,
                           white_threshold: int = 250) -> Image.Image:
    """
    Converte l'array RGB in RGBA rendendo trasparente:
    - il bianco puro (R, G, B >= white_threshold)
    - i pixel del frammento di ottagono in alto a destra

    La maschera ottagono usa coordinate di PAGINA (pt) e gestisce correttamente
    sia la diagonale "/" visibile nelle carte eroe sia quella "\" nelle carte standard.

    Args:
        arr:            array RGB del crop
        scale:          fattore di scala (dpi/72)
        crop_y0_pt:     coordinata y (in pt) dell'angolo in alto del crop nella pagina
        white_threshold: soglia bianco puro (default 250)
    """
    h, w = arr.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = arr

    # 1. Bianco puro → trasparente
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    is_white = (r >= white_threshold) & (g >= white_threshold) & (b >= white_threshold)

    # 2. Ottagono top-right → trasparente
    #    Convertiamo le coordinate pixel del crop in coordinate di pagina (pt)
    #    x_page = x_px/scale + CROP_X0_PT
    #    y_page = y_px/scale + crop_y0_pt
    ys_px, xs_px = np.mgrid[0:h, 0:w]
    x_page = xs_px / scale + CROP_X0_PT   # pt
    y_page = ys_px / scale + crop_y0_pt   # pt

    # Diagonale [/]: x_page + y_page >= OCTAGON_SLASH_SUM  (visibile nelle carte eroe)
    in_slash = (x_page + y_page >= OCTAGON_SLASH_SUM) & (y_page < OCTAGON_CORNER_Y)

    # Diagonale [\]: x_page - y_page >= OCTAGON_BACK_DIFF  (visibile in entrambi i tipi)
    in_back = (x_page - y_page >= OCTAGON_BACK_DIFF) & (y_page >= OCTAGON_CORNER_Y)

    in_octagon = (in_slash | in_back) & (y_page < OCTAGON_MAX_Y_PAGE)

    # 3. Bordo sinistro del frame esterno nella zona bleed (solo per carte eroe).
    #    Il bordo esterno della carta ha il suo inner edge a ~x_page=18pt; il nostro crop
    #    parte a x_page=20pt, ma l'anti-aliasing del bordo sfora di ~1pt verso l'interno.
    #    Mascheriamo la striscia x_page < 21pt finché siamo sopra il frame interno (y_page<25.8pt).
    INNER_FRAME_TOP = STANDARD_BOX_PT[1]   # 25.8pt: dove inizia l'area illustrazione standard
    LEFT_BORDER_MAX_X = CROP_X0_PT + 1.0   # pt: 21pt → ~4px a 300DPI
    in_left_strip = (x_page < LEFT_BORDER_MAX_X) & (y_page < INNER_FRAME_TOP)

    rgba[:, :, 3] = np.where(is_white | in_octagon | in_left_strip, 0, 255)

    return Image.fromarray(rgba, mode="RGBA")


DPI     = 300
OUT_DIR = Path("images")


def process_pdf(pdf_path: Path) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    doc   = fitz.open(str(pdf_path))
    scale = DPI / 72.0
    stem  = pdf_path.stem

    print(f"PDF: {pdf_path}  |  {len(doc)} pagine  |  DPI={DPI}\n")

    for i, page in enumerate(doc):
        page_num  = i + 1
        arr       = render_page(page, DPI)
        hero      = detect_hero(arr, scale)
        card_type = "EROE" if hero else "STANDARD"

        crop       = crop_illustration(arr, scale, hero)
        crop_y0_pt = (HERO_BOX_PT if hero else STANDARD_BOX_PT)[1]
        img        = make_white_transparent(crop, scale, crop_y0_pt)

        out_path = OUT_DIR / f"{stem}_page{page_num:02d}_{card_type.lower()}.png"
        img.save(out_path, format="PNG")
        print(f"  Pag. {page_num:02d} [{card_type:8s}]  →  {crop.shape[1]}×{crop.shape[0]}px  →  {out_path.name}")

    n_pages = len(doc)
    doc.close()
    print(f"\nDone. {n_pages} immagini salvate in '{OUT_DIR}'")


def main():
    parser = argparse.ArgumentParser(description="Estrae illustrazioni da PDF carte Barbacane.")
    parser.add_argument("deck", help="Nome del deck (es. deck_color → input/deck_color.pdf)")
    args = parser.parse_args()

    pdf_path = Path("input") / f"{args.deck}.pdf"
    if not pdf_path.exists():
        print(f"Errore: file non trovato: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    process_pdf(pdf_path)


if __name__ == "__main__":
    main()
