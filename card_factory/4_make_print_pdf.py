#!/usr/bin/env python3
"""
4_make_print_pdf.py

Nessun argomento: legge tutti i PNG in output/, e per ognuno crea una coppia
di pagine (back, carta) con un bordo monocromo di 3mm su tutti i lati (dello
stesso colore del bordo della carta, estratto dal pixel più a sinistra in
centro verticale). Salva il PDF risultante in output/cards_to_print.pdf.
"""

import glob
import io
import os

import fitz  # PyMuPDF
from PIL import Image, ImageOps

DPI = 300
BORDER_MM = 3
BORDER_PX = round(BORDER_MM / 25.4 * DPI)

BACK_PATH = "assets/templates/back.png"
OUTPUT_DIR = "output"
OUTPUT_PDF = os.path.join(OUTPUT_DIR, "cards_to_print.pdf")


def add_border(im: Image.Image) -> Image.Image:
    w, h = im.size
    color = im.getpixel((0, h // 2))
    return ImageOps.expand(im, border=BORDER_PX, fill=color)


def build_pdf(pages, output_path):
    doc = fitz.open()
    for path in pages:
        with Image.open(path).convert("RGB") as im:
            page_im = add_border(im)

        w_px, h_px = page_im.size
        w_pt, h_pt = w_px * 72 / DPI, h_px * 72 / DPI

        buf = io.BytesIO()
        page_im.save(buf, format="PNG")

        page = doc.new_page(width=w_pt, height=h_pt)
        page.insert_image(fitz.Rect(0, 0, w_pt, h_pt), stream=buf.getvalue())

    doc.save(output_path)


def main():
    card_paths = sorted(
        p for p in glob.glob(os.path.join(OUTPUT_DIR, "*.png"))
    )

    pages = []
    for card_path in card_paths:
        pages.append(BACK_PATH)
        pages.append(card_path)

    build_pdf(pages, OUTPUT_PDF)
    print(f"Salvate {len(card_paths)} carte ({len(pages)} pagine totali) in {OUTPUT_PDF}")


if __name__ == "__main__":
    main()
