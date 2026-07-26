#!/usr/bin/env python3
"""
lib/image_ops.py
Tutte le operazioni di image processing usate per preparare le illustrazioni:

- ritaglio/normalizzazione di un PDF di illustrazioni a 63x88mm per pagina
- estrazione della finestra illustrazione da una pagina PDF (con hero detection
  pixel-based, dato che a questo punto la pagina non ha ancora un id carta)
- pulizia sfondo: bianco -> trasparente, rimozione frangia di anti-aliasing,
  rimozione pallini isolati, richiusura piccoli fori interni
- adattamento di un'illustrazione (fornita già pronta, senza passare da PDF) al
  canvas standard usato in images/

Nessuna di queste funzioni conosce cards.json (vedi lib/cards_data.py per
is_hero_card, usata dal chiamante quando serve sapere se una carta già
identificata è un Eroe).
"""

from pathlib import Path

import fitz  # PyMuPDF
import numpy as np
from PIL import Image
from scipy import ndimage

# ---------------------------------------------------------------------------
# Normalizzazione pagina PDF (ex 1_resize_input.py)
# ---------------------------------------------------------------------------

CARD_W_PT = 63.0 / 25.4 * 72   # ≈ 178.58 pt
CARD_H_PT = 88.0 / 25.4 * 72   # ≈ 249.45 pt

DETECT_DPI = 150        # DPI per l'analisi del bounding box
WHITE_THRESHOLD = 240   # tutti i canali >= soglia → pixel bianco

# Dimensioni target per le immagini in images/ (larghezza illustrazione a 300 DPI,
# stesse di tutte le illustrazioni già presenti nella cartella).
IMG_TARGET_WIDTH = 579
IMG_HERO_HEIGHT = 552
IMG_STANDARD_HEIGHT = 332


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


def crop_pdf_to_card_size(pdf_path: Path) -> None:
    """Ritaglia le aree bianche esterne alla carta e ridimensiona ogni pagina a
    63x88mm. Se le pagine sono già di quella dimensione il ritaglio non cambia
    nulla di visibile: è sicuro da rilanciare più volte sullo stesso file."""
    import os
    import tempfile

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
        os.close(tmp_fd)
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


def fit_illustration_to_canvas(png_path: Path, is_hero: bool) -> None:
    """Adatta l'illustrazione al canvas standard mantenendo le proporzioni
    (nessuna distorsione): sceglie se adattare alla larghezza o all'altezza
    del canvas confrontando l'aspect ratio dell'immagine con quello del
    canvas target, in modo che un'illustrazione più "quadrata"/verticale di
    una carta Recluta (canvas largo) venga adattata all'altezza e centrata
    orizzontalmente con bande trasparenti a destra e sinistra (come
    patrizio.png), invece di essere stirata a piena larghezza e poi
    tagliata pesantemente in verticale. Ancoraggio verticale in basso.

    Se l'immagine è già esattamente della dimensione target, il risultato è
    identico all'originale (safe da rilanciare più volte)."""
    target_h = IMG_HERO_HEIGHT if is_hero else IMG_STANDARD_HEIGHT
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


# ---------------------------------------------------------------------------
# Estrazione illustrazione da pagina PDF (ex 2_extract_images.py)
# Costanti di layout derivate dall'analisi del PDF a 6x zoom = 36 px/pt.
# Tutti i valori sono espressi in PUNTI PDF (pt), validi per pagine 178.5x249.8 pt.
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
# Applicabile solo alle pagine PDF ritagliate: un'illustrazione fornita a mano
# (fit_illustration_to_canvas / clean_background) non ha questo badge.
# ---------------------------------------------------------------------------
OCTAGON_SLASH_SUM  = 161.0   # pt: x_page + y_page = questa costante (diagonale [/])
OCTAGON_BACK_DIFF  = 125.7   # pt: x_page - y_page = questa costante (diagonale [\])
OCTAGON_CORNER_Y   = 17.55   # pt: y_page del corner dell'ottagono
OCTAGON_MAX_Y_PAGE = 50.0    # pt: non applicare la maschera sotto questa y_page
CROP_X0_PT         = 20.0    # pt: x0 del crop (uguale per entrambi i tipi)

DPI = 300   # DPI di estrazione dal PDF


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


def detect_hero_from_pixels(arr: np.ndarray, scale: float) -> bool:
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
    pre_halo_opaque = rgba[:, :, 3] > 0
    remove_edge_halo(rgba)
    remove_isolated_specks(rgba, protect_from=pre_halo_opaque)

    return Image.fromarray(rgba, mode="RGBA")


def extract_illustration_from_page(page: fitz.Page, dpi: int = DPI):
    """Estrae l'illustrazione (con pulizia sfondo inclusa) da una pagina PDF.
    Ritorna (Image.Image RGBA, hero: bool)."""
    scale = dpi / 72.0
    arr = render_page(page, dpi)
    hero = detect_hero_from_pixels(arr, scale)
    crop = crop_illustration(arr, scale, hero)
    crop_y0_pt = (HERO_BOX_PT if hero else STANDARD_BOX_PT)[1]
    img = make_white_transparent(crop, scale, crop_y0_pt)
    return img, hero


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


def remove_isolated_specks(rgba: np.ndarray, max_size: int = SPECK_MAX_SIZE,
                            protect_from: np.ndarray = None) -> None:
    """Rende trasparenti in-place le componenti opache isolate sotto max_size px.

    protect_from, se fornito, è la maschera opaca catturata PRIMA di
    remove_edge_halo. Un frammento piccolo che apparteneva a una forma già
    grande in quella maschera non è rumore ma un dettaglio sottile (punta di
    stivale, frangia della mantella) assottigliato dall'erosione del passo
    precedente fino quasi a sparire: va preservato, non cancellato come se
    fosse un pallino d'anti-aliasing (bug osservato sui piedi di Polemarcos)."""
    alpha = rgba[:, :, 3]
    opaque = alpha > 0

    labeled, n = ndimage.label(opaque, structure=np.ones((3, 3)))
    if n <= 1:
        return

    sizes = ndimage.sum(opaque, labeled, range(1, n + 1))
    small_labels = np.flatnonzero(sizes <= max_size) + 1
    if small_labels.size == 0:
        return

    remove_mask = np.isin(labeled, small_labels)

    if protect_from is not None:
        pre_opaque = protect_from.astype(bool)
        pre_labeled, pre_n = ndimage.label(pre_opaque, structure=np.ones((3, 3)))
        if pre_n:
            pre_sizes = ndimage.sum(pre_opaque, pre_labeled, range(1, pre_n + 1))
            large_pre_labels = np.flatnonzero(pre_sizes > max_size) + 1
            protect = np.zeros_like(remove_mask)
            protect[remove_mask] = np.isin(pre_labeled[remove_mask], large_pre_labels)
            remove_mask = remove_mask & ~protect

    rgba[:, :, 3] = np.where(remove_mask, 0, alpha)


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


# ---------------------------------------------------------------------------
# Pulizia sfondo per illustrazioni fornite già pronte (non estratte da PDF).
# Passo "obbligato" nel percorso manuale di 1_prepare_images.py: se
# l'immagine ha già una trasparenza reale (non è completamente opaca) si
# assume già pulita e si applicano solo halo/specks/holes, che su
# un'immagine pulita non trovano nulla da correggere (no-op).
# ---------------------------------------------------------------------------

def clean_background(img: Image.Image, white_threshold: int = 250) -> Image.Image:
    """Rende trasparente lo sfondo di un'illustrazione fornita a mano e ripulisce
    frangia/pallini/fori residui. Non applica la maschera ottagono (specifica
    delle pagine PDF ritagliate): non ha senso fuori da quel contesto."""
    arr = np.array(img.convert("RGBA"))

    already_transparent = (arr[:, :, 3] < 255).any()
    if not already_transparent:
        r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
        is_white = (r >= white_threshold) & (g >= white_threshold) & (b >= white_threshold)
        arr[:, :, 3] = np.where(is_white, 0, 255)

    fill_interior_holes(arr)
    pre_halo_opaque = arr[:, :, 3] > 0
    remove_edge_halo(arr)
    remove_isolated_specks(arr, protect_from=pre_halo_opaque)

    return Image.fromarray(arr, mode="RGBA")
