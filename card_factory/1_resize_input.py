#!/usr/bin/env python3
"""
resize_input.py
Due modalità, a seconda di dove si trova <nome>:

  - input/<nome>.pdf esiste  → ritaglia le aree bianche esterne alla carta e
    ridimensiona ogni pagina a 63×88 mm. Il file viene risalvato in-place.

  - images/<nome>.png esiste → ridimensiona l'illustrazione già pronta (non
    passata da 2_extract_images.py) alle dimensioni standard usate da tutte
    le altre immagini in images/ (579×552 px per le carte Eroe, 579×332 px
    per le altre). Adatta alla larghezza mantenendo le proporzioni (nessuna
    distorsione) e aggiunge trasparenza sopra se il risultato è più basso del
    canvas target; se è più alto, ritaglia l'eccesso dall'alto. Il file viene
    risalvato in-place in images/.

Utilizzo:
    python resize_input.py <nome>
    # es. python resize_input.py deck_color  →  input/deck_color.pdf
    # es. python resize_input.py eracles     →  images/eracles.png
"""

import argparse
import json
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF
import numpy as np
from PIL import Image


CARD_W_PT = 63.0 / 25.4 * 72   # ≈ 178.58 pt
CARD_H_PT = 88.0 / 25.4 * 72   # ≈ 249.45 pt

DETECT_DPI = 150        # DPI per l'analisi del bounding box
WHITE_THRESHOLD = 240   # tutti i canali >= soglia → pixel bianco

# Dimensioni target per le immagini in images/ (larghezza illustrazione a 300 DPI,
# stesse di tutte le illustrazioni già presenti nella cartella).
IMG_TARGET_WIDTH = 579
IMG_HERO_HEIGHT = 552
IMG_STANDARD_HEIGHT = 332

CARDS_JSON_PATH = Path("..") / "data" / "cards.json"


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


def is_hero_card(card_id: str) -> bool:
    """Una carta è di tipo Eroe se è un Guerriero con evolves_from valorizzato."""
    with open(CARDS_JSON_PATH, encoding="utf-8") as f:
        data = json.load(f)
    for warrior in data["warriors"]:
        if warrior["id"] == card_id:
            return warrior.get("evolves_from") is not None
    return False


def process_image(png_path: Path) -> None:
    """Adatta l'illustrazione al canvas standard mantenendo le proporzioni
    (nessuna distorsione): sceglie se adattare alla larghezza o all'altezza
    del canvas confrontando l'aspect ratio dell'immagine con quello del
    canvas target, in modo che un'illustrazione più "quadrata"/verticale di
    una carta Recluta (canvas largo) venga adattata all'altezza e centrata
    orizzontalmente con bande trasparenti a destra e sinistra (come
    patrizio.png), invece di essere stirata a piena larghezza e poi
    tagliata pesantemente in verticale. Ancoraggio verticale in basso."""
    target_h = IMG_HERO_HEIGHT if is_hero_card(png_path.stem) else IMG_STANDARD_HEIGHT
    canvas_aspect = IMG_TARGET_WIDTH / target_h

    img = Image.open(png_path).convert("RGBA")
    img_aspect = img.width / img.height

    canvas = Image.new("RGBA", (IMG_TARGET_WIDTH, target_h), (0, 0, 0, 0))

    if img_aspect >= canvas_aspect:
        # Immagine relativamente più larga del canvas -> adatta alla larghezza.
        scale = IMG_TARGET_WIDTH / img.width
        fitted_h = int(round(img.height * scale))
        fitted = img.resize((IMG_TARGET_WIDTH, fitted_h), Image.LANCZOS)

        if fitted_h <= target_h:
            canvas.paste(fitted, (0, target_h - fitted_h), fitted)
            note = f"+{target_h - fitted_h}px trasparenti sopra"
        else:
            crop_top = fitted_h - target_h
            fitted = fitted.crop((0, crop_top, IMG_TARGET_WIDTH, fitted_h))
            canvas.paste(fitted, (0, 0), fitted)
            note = f"ritagliati {crop_top}px in alto"
        fit_kind = "larghezza"
    else:
        # Immagine relativamente più stretta/verticale del canvas -> adatta
        # all'altezza e centra orizzontalmente (bande trasparenti sui lati).
        scale = target_h / img.height
        fitted_w = int(round(img.width * scale))
        fitted = img.resize((fitted_w, target_h), Image.LANCZOS)

        x_off = (IMG_TARGET_WIDTH - fitted_w) // 2
        canvas.paste(fitted, (x_off, 0), fitted)
        note = f"bande trasparenti laterali {x_off}px/{IMG_TARGET_WIDTH - fitted_w - x_off}px"
        fit_kind = "altezza"

    canvas.save(png_path, format="PNG")
    kind = "eroe" if target_h == IMG_HERO_HEIGHT else "standard"
    print(
        f"{png_path.name}: {img.size} -> adattata per {fit_kind} "
        f"-> canvas {kind} {IMG_TARGET_WIDTH}x{target_h} ({note})"
    )


def process_pdf(pdf_path: Path) -> None:
    src = fitz.open(str(pdf_path))
    n = len(src)

    print(f"PDF: {pdf_path}  |  {n} pagine")

    target = fitz.Rect(0, 0, CARD_W_PT, CARD_H_PT)
    dst = fitz.open()

    for i in range(n):
        crop = find_content_rect(src[i])
        print(
            f"  Pag. {i + 1}: crop ({crop.x0:.1f}, {crop.y0:.1f}, {crop.x1:.1f}, {crop.y1:.1f}) pt"
            f"  [{crop.width * 25.4 / 72:.1f}×{crop.height * 25.4 / 72:.1f} mm]"
        )
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
        description="Ridimensiona un PDF in input/ (deck) oppure un'illustrazione in images/ (nome carta)."
    )
    parser.add_argument(
        "nome",
        help="Nome del deck (input/<nome>.pdf) o id carta (images/<nome>.png)",
    )
    args = parser.parse_args()

    pdf_path = Path("input") / f"{args.nome}.pdf"
    png_path = Path("images") / f"{args.nome}.png"

    if pdf_path.exists():
        process_pdf(pdf_path)
    elif png_path.exists():
        process_image(png_path)
    else:
        print(f"Errore: nessun file trovato ({pdf_path} né {png_path})", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
