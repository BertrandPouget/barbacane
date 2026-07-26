#!/usr/bin/env python3
"""
1_prepare_images.py
Unico entry point per popolare images/ con le illustrazioni pronte per lo Step 2
(2_generate_cards.py). Due percorsi, a seconda di dove si trova <nome>:

  - input/<nome>.pdf esiste  → normalizza ogni pagina a 63x88mm, estrae la
    finestra illustrazione (riconoscendo automaticamente Recluta/Eroe) e la
    pulisce dallo sfondo. Salva un PNG per pagina in
    images/<nome>_pageNN.png. Vanno poi rinominati a mano con l'id carta
    (es. images/patrizio.png) prima di passare allo Step 2.

  - images/<nome>.png esiste → l'illustrazione è già stata fornita pronta
    (bypassando l'estrazione da PDF): viene comunque ripulita dallo sfondo
    (no-op se è già pulita/trasparente) e adattata al canvas standard usato
    da tutte le altre immagini in images/. Risalvata in-place.

Se non viene indicato nessun nome, processa tutti i PDF trovati in input/.

Utilizzo:
    python 1_prepare_images.py deck_color        # legge input/deck_color.pdf
    python 1_prepare_images.py eracles           # legge images/eracles.png
    python 1_prepare_images.py                   # tutti i PDF in input/
    python 1_prepare_images.py --clean           # ripulisce tutti i PNG in images/
    python 1_prepare_images.py --clean eracle    # ripulisce solo images/eracle.png
"""

import argparse
import sys
from pathlib import Path

import fitz  # PyMuPDF
import numpy as np
from PIL import Image

from lib import image_ops
from lib.cards_data import is_hero_card

ROOT = Path(__file__).resolve().parent
INPUT_DIR = ROOT / "input"
IMAGES_DIR = ROOT / "images"


def process_pdf(name: str) -> None:
    pdf_path = INPUT_DIR / f"{name}.pdf"
    image_ops.crop_pdf_to_card_size(pdf_path)

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf_path))
    print(f"\nEstrazione illustrazioni: {pdf_path}  |  {len(doc)} pagine")

    for i, page in enumerate(doc):
        page_num = i + 1
        img, hero = image_ops.extract_illustration_from_page(page)
        out_path = IMAGES_DIR / f"{name}_page{page_num:02d}.png"
        img.save(out_path, format="PNG")
        card_type = "EROE" if hero else "STANDARD"
        print(f"  Pag. {page_num:02d} [{card_type:8s}]  →  {img.width}x{img.height}px  →  {out_path.name}")

    doc.close()
    print(f"Fatto. Rinomina i PNG in '{IMAGES_DIR}' con l'id carta prima dello Step 2.")


def process_manual_image(name: str) -> None:
    png_path = IMAGES_DIR / f"{name}.png"
    img = Image.open(png_path)
    cleaned = image_ops.clean_background(img)
    cleaned.save(png_path, format="PNG")

    image_ops.fit_illustration_to_canvas(png_path, is_hero=is_hero_card(name))


def clean_existing(names: list[str], out_dir: Path = None) -> None:
    """Manutenzione: riapplica halo/specks/fori a PNG già presenti in images/."""
    paths = [IMAGES_DIR / f"{n}.png" for n in names] if names else sorted(IMAGES_DIR.glob("*.png"))
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    for path in paths:
        if not path.exists():
            print(f"Errore: file non trovato: {path}", file=sys.stderr)
            continue
        img = Image.open(path).convert("RGBA")
        arr = np.array(img)
        opaque_before = int((arr[:, :, 3] > 0).sum())

        filled = image_ops.fill_interior_holes(arr)
        pre_halo_opaque = arr[:, :, 3] > 0
        image_ops.remove_edge_halo(arr)
        image_ops.remove_isolated_specks(arr, protect_from=pre_halo_opaque)

        removed = opaque_before - int((arr[:, :, 3] > 0).sum())
        dest = (out_dir / path.name) if out_dir else path
        Image.fromarray(arr, mode="RGBA").save(dest)
        print(f"{path.name}: {removed}px rimossi, {filled}px fori richiusi  -> {dest}")


def main():
    parser = argparse.ArgumentParser(
        description="Popola images/ da un PDF (estrazione) o da un'illustrazione già pronta (pulizia+resize)."
    )
    parser.add_argument("--clean", action="store_true",
                         help="Ripulisce i PNG già presenti in images/ invece di prepararne di nuovi")
    parser.add_argument("--out-dir", type=Path, default=None,
                         help="Con --clean: scrive qui invece di sovrascrivere images/ (per anteprima)")
    parser.add_argument("names", nargs="*",
                         help="Nomi deck (input/<nome>.pdf) o id carta (images/<nome>.png). "
                              "Con --clean: nomi carta. Omesso: tutti i deck in input/ (o tutte le "
                              "carte in images/ con --clean).")
    args = parser.parse_args()

    if args.clean:
        clean_existing(args.names, out_dir=args.out_dir)
        return

    if args.names:
        names = args.names
    else:
        pdf_paths = sorted(INPUT_DIR.glob("*.pdf"))
        if not pdf_paths:
            print("Errore: nessun PDF trovato in input/.", file=sys.stderr)
            sys.exit(1)
        names = [p.stem for p in pdf_paths]

    for name in names:
        pdf_path = INPUT_DIR / f"{name}.pdf"
        png_path = IMAGES_DIR / f"{name}.png"
        if pdf_path.exists():
            process_pdf(name)
        elif png_path.exists():
            process_manual_image(name)
        else:
            print(f"Errore: nessun file trovato ({pdf_path} né {png_path})", file=sys.stderr)


if __name__ == "__main__":
    main()
