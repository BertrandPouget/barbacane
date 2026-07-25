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
from scipy import ndimage


# ---------------------------------------------------------------------------
# Costanti di layout (derivate dall'analisi del PDF a 6× zoom = 36 px/pt)
# Tutti i valori sono espressi in PUNTI PDF (pt), validi per pagine 178.5×249.8 pt.
# ---------------------------------------------------------------------------

# Finestra illustrazione standard (Recluta ecc.)
# x leggermente stretto per escludere il bordo del frame; y1 appena sopra il banner nome
# y0 spostato 1mm più in basso (25.8+2.83pt) per non includere il filo d'illustrazione
# che a volte sfora sopra l'etichetta Recluta/Eroe del frame.
STANDARD_BOX_PT = (20.0, 28.6, 159.0, 105.5)   # x0, y0, x1, y1

# Finestra illustrazione eroe (stessa y0 dello standard — "subito sotto il rettangolo")
# La differenza è solo nel y1 più basso: l'illustrazione eroe è più alta.
HERO_BOX_PT    = (20.0, 28.6, 159.0, 158.5)

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

    # 1. Bianco puro → trasparente, ovunque (anche sacche di sfondo racchiuse dentro il
    #    disegno, es. tra le dita o tra braccio/volto/fiamma: sono sfondo vero, non
    #    dettagli). Un dettaglio interno bianco puro isolato (es. l'highlight di un
    #    occhio) verrebbe reso trasparente per errore qui, ma è piccolo — viene
    #    richiuso subito dopo da fill_interior_holes in base alla dimensione, non
    #    alla connettività col bordo (che non distingue le due situazioni).
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

    # Ordine importante: prima si richiudono i piccoli fori interni (falsi
    # positivi come un highlight puro bianco negli occhi), così quello che
    # resta trasparente a quel punto è SOLO vero sfondo — esterno o una sacca
    # interna abbastanza grande (es. tra le dita, sotto un'ascella). Solo
    # allora si fa crescere la frangia da ogni pixel trasparente rimasto: se
    # lo si facesse prima, o solo dal bordo esterno, le sacche interne
    # resterebbero con l'alone bianco mai pulito (bug osservato sulla fodera
    # sotto le braccia di Giulio).
    fill_interior_holes(rgba)
    remove_edge_halo(rgba)
    remove_isolated_specks(rgba)

    return Image.fromarray(rgba, mode="RGBA")


# ---------------------------------------------------------------------------
# Rimozione della frangia bianco-grigiastra residua sul contorno
#
# La sogliatura "bianco puro" lascia intatta la sfumatura di anti-aliasing tra
# lo sfondo e il tratto nero del disegno (es. il contorno del personaggio),
# perché quei pixel non sono abbastanza bianchi da superare white_threshold.
# Non basta abbassare la soglia globale: dettagli chiari INTERNI al disegno
# (es. il bianco degli occhi) hanno valori di luminosità che si sovrappongono
# a quelli della frangia, quindi verrebbero cancellati per errore.
#
# La distinzione giusta non è il colore ma la connettività: la frangia tocca
# sempre una zona di vero sfondo (esterna alla sagoma, o una sacca interna
# abbastanza grande), i dettagli interni piccoli no (sono chiusi dentro un
# contorno scuro e già richiusi da fill_interior_holes PRIMA di questa
# funzione — vedi l'ordine in make_white_transparent). Si fa quindi
# "crescere" ogni pixel trasparente rimasto, consumando i vicini grigiastri
# e abbastanza chiari; la crescita si ferma da sola contro il tratto nero
# vero o un colore reale.
#
# HALO_BRIGHTNESS_FLOOR basso (non 150): il gradiente di anti-aliasing tra
# nero del contorno e bianco passa per grigi medi (misurato: 100-150 di
# luminosità) che con una soglia troppo alta restano opachi a chiazze,
# lasciando una fila di puntini invece di un bordo pulito. Un floor più
# basso rischia di erodere qualche pixel in più su un eventuale riempimento
# grigio scuro che tocca lo sfondo direttamente, ma è un rischio limitato
# da HALO_MAX_ITERATIONS (la profondità massima di erosione dal bordo).
# ---------------------------------------------------------------------------
HALO_BRIGHTNESS_FLOOR = 60    # luminosità minima perché un pixel di bordo sia "frangia"
HALO_MAX_ITERATIONS   = 5     # profondità massima di erosione dal vero sfondo, in px


def _border_connected(mask: np.ndarray) -> np.ndarray:
    """Sottoinsieme di mask connesso (8-adiacenza) al bordo dell'immagine."""
    labeled, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return mask
    border_labels = np.union1d(
        np.union1d(labeled[0, :], labeled[-1, :]),
        np.union1d(labeled[:, 0], labeled[:, -1]),
    )
    border_labels = border_labels[border_labels != 0]
    return np.isin(labeled, border_labels)


def remove_edge_halo(rgba: np.ndarray,
                      brightness_floor: int = HALO_BRIGHTNESS_FLOOR,
                      max_iterations: int = HALO_MAX_ITERATIONS) -> None:
    """Estende in-place la trasparenza di rgba mangiando la frangia grigiastra intorno a ogni
    zona di vero sfondo rimasta (esterna alla sagoma o sacca interna). Va chiamata DOPO
    fill_interior_holes, altrimenti userebbe anche i piccoli fori-errore come seed."""
    alpha = rgba[:, :, 3]
    seed = alpha == 0
    if not seed.any() or seed.all():
        return

    grayish = ~is_truly_colored(rgba[:, :, :3])
    brightness = rgba[:, :, :3].astype(np.int32).mean(axis=2)
    candidate = grayish & (brightness >= brightness_floor)

    grown = seed.copy()
    for _ in range(max_iterations):
        border = ndimage.binary_dilation(grown, structure=np.ones((3, 3))) & ~grown
        newly_transparent = border & candidate
        if not newly_transparent.any():
            break
        grown |= newly_transparent

    final_transparent = (alpha == 0) | grown
    rgba[:, :, 3] = np.where(final_transparent, 0, alpha)


# ---------------------------------------------------------------------------
# Rimozione dei "pallini" residui: piccoli frammenti opachi isolati lasciati
# dalla sogliatura del bianco (rumore di anti-aliasing sparso nello sfondo).
#
# Anche qui la distinzione è per dimensione, non per colore/posizione: molte
# illustrazioni hanno elementi disegnati intenzionalmente separati dal corpo
# principale (fiori, rami, oggetti fluttuanti) grandi centinaia/migliaia di
# pixel, e vanno preservati. I pallini di rumore misurati sono sempre <=15px,
# con un salto netto rispetto al primo elemento di disegno legittimo (>=17px).
# ---------------------------------------------------------------------------
SPECK_MAX_SIZE = 15   # px; componenti connesse fino a questa dimensione sono rumore


def remove_isolated_specks(rgba: np.ndarray, max_size: int = SPECK_MAX_SIZE) -> None:
    """Rende trasparenti in-place le componenti opache isolate sotto max_size px."""
    alpha = rgba[:, :, 3]
    opaque = alpha > 0

    labeled, n = ndimage.label(opaque, structure=np.ones((3, 3)))
    if n <= 1:
        return

    sizes = ndimage.sum(opaque, labeled, range(1, n + 1))
    small_labels = np.flatnonzero(sizes <= max_size) + 1
    if small_labels.size == 0:
        return

    rgba[:, :, 3] = np.where(np.isin(labeled, small_labels), 0, alpha)


# ---------------------------------------------------------------------------
# Chiusura dei piccoli fori interni: l'esatto speculare di remove_isolated_specks.
#
# is_white (anche dopo il fix border-connected) può ancora produrre un piccolo
# foro se un dettaglio interno era già puro bianco al momento della PRIMA
# estrazione da PDF, o se un'immagine è stata processata prima di questo fix
# (es. i buchi nelle pupille di Evelyn e The Briny). remove_edge_halo e
# remove_isolated_specks aggiungono solo trasparenza: non possono richiudere
# un foro già esistente. Qui si richiudono i fori trasparenti che NON toccano
# il bordo (quindi non sono vero sfondo) sotto una soglia di dimensione,
# riempendoli con il colore del pixel opaco più vicino.
# ---------------------------------------------------------------------------
def fill_interior_holes(rgba: np.ndarray, max_size: int = SPECK_MAX_SIZE) -> int:
    """Richiude in-place i piccoli fori trasparenti interni. Ritorna i pixel richiusi."""
    alpha = rgba[:, :, 3]
    transparent = alpha == 0
    interior_holes = transparent & ~_border_connected(transparent)
    if not interior_holes.any():
        return 0

    labeled, n = ndimage.label(interior_holes, structure=np.ones((3, 3)))
    sizes = ndimage.sum(interior_holes, labeled, range(1, n + 1))
    small_labels = np.flatnonzero(sizes <= max_size) + 1
    fill_mask = np.isin(labeled, small_labels)
    filled = int(fill_mask.sum())
    if filled == 0:
        return 0

    _, nearest_idx = ndimage.distance_transform_edt(transparent, return_distances=True, return_indices=True)
    nearest_rgb = rgba[:, :, :3][tuple(nearest_idx)]
    for c in range(3):
        rgba[:, :, c] = np.where(fill_mask, nearest_rgb[:, :, c], rgba[:, :, c])
    rgba[:, :, 3] = np.where(fill_mask, 255, alpha)
    return filled


DPI     = 300
OUT_DIR = Path("images")


def process_pdf(pdf_path: Path, out_dir: Path = None) -> None:
    out_dir = out_dir or OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    doc   = fitz.open(str(pdf_path))
    scale = DPI / 72.0
    stem  = pdf_path.stem

    print(f"PDF: {pdf_path}  |  {len(doc)} pagine  |  DPI={DPI}  |  out={out_dir}\n")

    for i, page in enumerate(doc):
        page_num  = i + 1
        arr       = render_page(page, DPI)
        hero      = detect_hero(arr, scale)
        card_type = "EROE" if hero else "STANDARD"

        crop       = crop_illustration(arr, scale, hero)
        crop_y0_pt = (HERO_BOX_PT if hero else STANDARD_BOX_PT)[1]
        img        = make_white_transparent(crop, scale, crop_y0_pt)

        out_path = out_dir / f"{stem}_page{page_num:02d}.png"
        img.save(out_path, format="PNG")
        print(f"  Pag. {page_num:02d} [{card_type:8s}]  →  {crop.shape[1]}×{crop.shape[0]}px  →  {out_path.name}")

    n_pages = len(doc)
    doc.close()
    print(f"\nDone. {n_pages} immagini salvate in '{out_dir}'")


def clean_existing(names: list[str], out_dir: Path = None) -> None:
    """Riapplica halo/specks/fori a PNG già estratti in images/. Scrive in out_dir (default: in-place)."""
    paths = [OUT_DIR / f"{n}.png" for n in names] if names else sorted(OUT_DIR.glob("*.png"))
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    for path in paths:
        if not path.exists():
            print(f"Errore: file non trovato: {path}", file=sys.stderr)
            continue
        img = Image.open(path).convert("RGBA")
        arr = np.array(img)
        opaque_before = int((arr[:, :, 3] > 0).sum())

        filled = fill_interior_holes(arr)
        remove_edge_halo(arr)
        remove_isolated_specks(arr)

        removed = opaque_before - int((arr[:, :, 3] > 0).sum())
        dest = (out_dir / path.name) if out_dir else path
        Image.fromarray(arr, mode="RGBA").save(dest)
        print(f"{path.name}: {removed}px rimossi, {filled}px fori richiusi  -> {dest}")


def main():
    parser = argparse.ArgumentParser(description="Estrae illustrazioni da PDF carte Barbacane.")
    parser.add_argument("deck", nargs="?", help="Nome del deck (es. deck_color → input/deck_color.pdf)")
    parser.add_argument("--clean", action="store_true",
                         help="Ripulisce i PNG già estratti in images/ invece di estrarre da un PDF")
    parser.add_argument("--out-dir", type=Path, default=None,
                         help="Scrive qui invece di sovrascrivere images/ (per anteprima)")
    parser.add_argument("names", nargs="*", help="Con --clean: nomi carta da ripulire (default: tutte)")
    args = parser.parse_args()

    if args.clean:
        names = [n for n in [args.deck, *args.names] if n]
        clean_existing(names, out_dir=args.out_dir)
        return

    if not args.deck:
        print("Errore: specifica il nome del deck (o usa --clean).", file=sys.stderr)
        sys.exit(1)

    pdf_path = Path("input") / f"{args.deck}.pdf"
    if not pdf_path.exists():
        print(f"Errore: file non trovato: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    process_pdf(pdf_path, out_dir=args.out_dir)


if __name__ == "__main__":
    main()
