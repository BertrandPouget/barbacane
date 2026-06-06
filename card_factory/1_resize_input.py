#!/usr/bin/env python3
"""
resize_input.py
Ritaglia le aree bianche esterne alla carta e ridimensiona ogni pagina a 63×88 mm.

Il bounding box viene rilevato solo dalla prima pagina (tutte le altre hanno lo stesso layout).
Il file viene risalvato in-place nella cartella input/.

Utilizzo:
    python resize_input.py <deck>
    # es. python resize_input.py deck_color  →  input/deck_color.pdf
"""

import argparse
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF
import numpy as np


CARD_W_PT = 63.0 / 25.4 * 72   # ≈ 178.58 pt
CARD_H_PT = 88.0 / 25.4 * 72   # ≈ 249.45 pt

DETECT_DPI = 150        # DPI per l'analisi del bounding box
WHITE_THRESHOLD = 240   # tutti i canali >= soglia → pixel bianco


def find_content_rect(page: fitz.Page) -> fitz.Rect:
    """Ritorna il rettangolo minimo che contiene tutti i pixel non-bianchi, in pt."""
    scale = DETECT_DPI / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)

    is_content = np.any(arr < WHITE_THRESHOLD, axis=2)
    rows = np.any(is_content, axis=1)
    cols = np.any(is_content, axis=0)

    if not rows.any():
        return page.rect  # fallback: pagina intera

    y0_px, y1_px = np.where(rows)[0][[0, -1]]
    x0_px, x1_px = np.where(cols)[0][[0, -1]]

    return fitz.Rect(
        x0_px / scale,
        y0_px / scale,
        (x1_px + 1) / scale,
        (y1_px + 1) / scale,
    )


def process_pdf(pdf_path: Path) -> None:
    src = fitz.open(str(pdf_path))
    n = len(src)

    print(f"PDF: {pdf_path}  |  {n} pagine")

    crop = find_content_rect(src[0])
    print(
        f"Crop rilevato: ({crop.x0:.1f}, {crop.y0:.1f}, {crop.x1:.1f}, {crop.y1:.1f}) pt"
        f"  [{crop.width * 25.4 / 72:.1f}×{crop.height * 25.4 / 72:.1f} mm]"
    )

    target = fitz.Rect(0, 0, CARD_W_PT, CARD_H_PT)
    dst = fitz.open()

    for i in range(n):
        page = dst.new_page(width=CARD_W_PT, height=CARD_H_PT)
        page.show_pdf_page(target, src, i, clip=crop)

    # Salva su file temporaneo nella stessa cartella, poi sostituisce l'originale.
    # Evita conflitti di file-lock su Windows con src ancora aperto.
    tmp_fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=pdf_path.parent)
    tmp_path = Path(tmp_name)
    try:
        import os; os.close(tmp_fd)
        dst.save(str(tmp_path))
        dst.close()
        src.close()
        tmp_path.replace(pdf_path)
    except Exception:
        dst.close()
        src.close()
        tmp_path.unlink(missing_ok=True)
        raise

    print(f"Salvato: {pdf_path}  ({n} pagine a 63×88 mm)")


def main():
    parser = argparse.ArgumentParser(
        description="Ritaglia bordi bianchi e ridimensiona un PDF di carte a 63×88 mm."
    )
    parser.add_argument("deck", help="Nome del deck (es. deck_color → input/deck_color.pdf)")
    args = parser.parse_args()

    pdf_path = Path("input") / f"{args.deck}.pdf"
    if not pdf_path.exists():
        print(f"Errore: file non trovato: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    process_pdf(pdf_path)


if __name__ == "__main__":
    main()
