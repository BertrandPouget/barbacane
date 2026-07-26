#!/usr/bin/env python3
"""
4_make_print_pdf.py

Rigenera tutte le carte (Step 3, richiamato come libreria) a risoluzione di stampa
in una cartella temporanea — senza toccare i PNG in output/, usati dal frontend — e
per ognuna crea una coppia di pagine (back, carta) con un bordo monocromo di 3mm su
tutti i lati (dello stesso colore del bordo della carta, estratto dal pixel più a
sinistra in centro verticale). Salva il PDF risultante in output/cards_to_print.pdf.

Utilizzo:
    python 4_make_print_pdf.py             # qualità massima di stampa (scala 4 = ~1200 DPI)
    python 4_make_print_pdf.py --scale 6   # ancora più definito
"""

import argparse
import importlib.util
import io
import tempfile
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageOps

ROOT = Path(__file__).parent
BASE_DPI = 300  # DPI a scala 1 (744x1039px, carta 63x88mm) — vedi 3_generate_cards.py
BORDER_MM = 3

OUTPUT_DIR = ROOT / "output"
OUTPUT_PDF = OUTPUT_DIR / "cards_to_print.pdf"
BACK_ID = "retro"

# 3_generate_cards.py inizia con una cifra: non importabile con `import`, si carica dal path.
_spec = importlib.util.spec_from_file_location("generate_cards", ROOT / "3_generate_cards.py")
_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gen)


def add_border(im: Image.Image, border_px: int) -> Image.Image:
    w, h = im.size
    color = im.getpixel((0, h // 2))
    return ImageOps.expand(im, border=border_px, fill=color)


def build_pdf(pages, output_path: Path, dpi: float, border_px: int) -> None:
    doc = fitz.open()
    for path in pages:
        with Image.open(path).convert("RGB") as im:
            page_im = add_border(im, border_px)

        w_px, h_px = page_im.size
        w_pt, h_pt = w_px * 72 / dpi, h_px * 72 / dpi

        buf = io.BytesIO()
        page_im.save(buf, format="PNG")

        page = doc.new_page(width=w_pt, height=h_pt)
        page.insert_image(fitz.Rect(0, 0, w_pt, h_pt), stream=buf.getvalue())

    doc.save(str(output_path))


def main():
    parser = argparse.ArgumentParser(
        description="Rigenera le carte a qualità di stampa e compone il PDF pronto per la stampa."
    )
    parser.add_argument(
        "--scale", type=float, default=4.0,
        help="Risoluzione di stampa, moltiplicatore della base 300 DPI (4 = ~1200 DPI). "
             "Non tocca i PNG in output/. Default 4.",
    )
    args = parser.parse_args()

    dpi = BASE_DPI * args.scale
    border_px = round(BORDER_MM / 25.4 * dpi)

    cards, id_to_name = _gen.load_cards(_gen.CARDS_JSON)

    with tempfile.TemporaryDirectory(prefix="barbacane_print_") as tmp:
        tmp_dir = Path(tmp)
        print(f"Rendering {len(cards)} carte a qualità di stampa (scala {args.scale}x, ~{dpi:.0f} DPI)...\n")
        _gen.render_cards(cards, id_to_name, tmp_dir, scale=args.scale)

        back_path = tmp_dir / f"{BACK_ID}.png"
        card_paths = sorted(p for p in tmp_dir.glob("*.png") if p.stem != BACK_ID)

        pages = []
        for card_path in card_paths:
            pages.append(back_path)
            pages.append(card_path)

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        build_pdf(pages, OUTPUT_PDF, dpi, border_px)

    print(f"\nSalvate {len(card_paths)} carte ({len(pages)} pagine totali) in {OUTPUT_PDF}")


if __name__ == "__main__":
    main()
