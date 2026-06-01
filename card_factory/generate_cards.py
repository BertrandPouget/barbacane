#!/usr/bin/env python3
"""
generate_cards.py
Genera carte Barbacane dal template PDF + JSON dati + PNG illustrazioni.

Utilizzo:
    python generate_cards.py cards.json
    python generate_cards.py cards.json --template Barbacane_-_Template_v2.pdf
                                         --images ./images  --fonts ./fonts
                                         --out ./output     --dpi 300
"""

import argparse
import json
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# DPI e scala (sovrascrivibili via --dpi)
# ---------------------------------------------------------------------------
DPI   = 300
SCALE = DPI / 72.0

def pt(v: float) -> int:
    return int(round(v * SCALE))


# ---------------------------------------------------------------------------
# Coordinate layout in PUNTI PDF — invarianti per ogni carta con il template v2
# Derivate dall'analisi vettoriale del PDF e misurate sull'output reale.
# ---------------------------------------------------------------------------

CARD_W_PT = 178.50
CARD_H_PT = 249.75
CX_PT     = CARD_W_PT / 2          # 89.25

# Intestazione tipo / sottotipo
TYPE_CX_PT     = CX_PT
TYPE_Y_PT      = 10.7
SUBTYPE_CX_PT  = CX_PT
SUBTYPE_Y_PT   = 21.0

# Ottagono costo — centro dell'immagine embedded rect=[148.1, 8.0, 167.6, 27.5]
COST_CX_PT     = 157.85
COST_CY_PT     =  17.75

# Illustrazione: larghezza = estremo sx linea deco sx → estremo dx linea deco dx
ILLUS_X_LEFT_PT  = 17.9
ILLUS_X_RIGHT_PT = 160.7
ILLUS_WIDTH_PT   = ILLUS_X_RIGHT_PT - ILLUS_X_LEFT_PT   # 142.8 pt
ILLUS_Y_TOP_PT   = 30.0
ILLUS_Y_BOT_PT   = 107.9

# Banner nome — RECRUIT / SPELL / BUILDING
BANNER_Y_TOP_PT = 107.9
BANNER_Y_BOT_PT = 121.2
NAME_CX_PT      = CX_PT
NAME_CY_PT      = 114.7   # centro testo = centro delle lineette decorative dello stendardo

# Statistiche (Y modificate con +7.5 per compensare l'anchor "ls" alla baseline)
STATS_Y1_PT       = 129.8 + 7.5    # ATT  / Specie
STATS_Y2_PT       = 145.9 + 7.5    # GIT  / Evolve
STATS_Y3_PT       = 161.75 + 7.5   # DIF  / Scuola

STATS_LABEL_L_X_PT    = 25.2
STATS_VAL_L_X_PT      = 52.0
STATS_LABEL_R_EDGE_PT = 108.0
STATS_VAL_R_X_PT      = 112.0

# Effetto orda — RECRUIT
HORDE_CX_PT    = CX_PT
HORDE_Y_PT     = 201.8
HORDE_MAX_W_PT = ILLUS_WIDTH_PT   # = 142.8pt — stessi estremi delle lineette decorative

# ---------------------------------------------------------------------------
# Coordinate HERO — banner più in basso, stessi offset dal banner top
# Banner: [39.6, 168.3, 139.0, 181.5]
# ---------------------------------------------------------------------------
H_BANNER_TOP = 168.3
H_BANNER_BOT = 181.5
H_NAME_CY    = (H_BANNER_TOP + H_BANNER_BOT) / 2 + 0.15   # ~175.05
H_STATS_Y1   = H_BANNER_TOP + (STATS_Y1_PT - 7.5 - BANNER_Y_TOP_PT) + 7.5
H_STATS_Y2   = H_BANNER_TOP + (STATS_Y2_PT - 7.5 - BANNER_Y_TOP_PT) + 7.5
H_STATS_Y3   = H_BANNER_TOP + (STATS_Y3_PT - 7.5 - BANNER_Y_TOP_PT) + 7.5
# Nessun horde per hero (non c'è spazio né icona nel template)

# ---------------------------------------------------------------------------
# Coordinate SPELL / BUILDING
# Banner identico al recruit. Due icone sotto il banner:
#   Icona 1 (vuota, effetto base)    center y = 135.0pt → testo da 146pt
#   Icona 2 (piena, prodigio/compl.) center y = 186.7pt → testo da 196pt
# ---------------------------------------------------------------------------
SB_TEXT1_Y      = 146.0
SB_TEXT2_Y      = 196.0
SB_EFFECT_MAX_W = ILLUS_WIDTH_PT

# Building: costo completamento centrato nell'icona piena (color gold, size = costo)
BLDG_COMPL_CX = CX_PT
BLDG_COMPL_CY = 186.7

# ---------------------------------------------------------------------------
# Dimensioni font (pt)
# ---------------------------------------------------------------------------
FSIZE_TYPE    = 11.0
FSIZE_SUBTYPE =  8.0
FSIZE_NAME    =  8.5
FSIZE_COST    =  9.0
FSIZE_STATS   =  7.5
FSIZE_EFFECT  =  8.0

# ---------------------------------------------------------------------------
# Colori
# ---------------------------------------------------------------------------
COLOR_BROWN = (123, 69,  13)
COLOR_GOLD  = (255, 189, 89)

# ---------------------------------------------------------------------------
# Mappings
# ---------------------------------------------------------------------------
TYPE_MAP = {
    "warrior":  "Guerriero",
    "mage":     "Mago",
    "rogue":    "Ladro",
    "cleric":   "Chierico",
    "beast":    "Bestia",
    "spell":    "Magia",
    "building": "Costruzione",
}
SUBTYPE_MAP = {
    "recruit":     "Recluta",
    "hero":        "Eroe",
    "elite":       "Elite",
    "anatema":     "Anatema",
    "sortilegio":  "Sortilegio",
    "incantesimo": "Incantesimo",
}


def snake_to_title(s: str) -> str:
    return " ".join(w.capitalize() for w in s.split("_")) if s else "—"


# ---------------------------------------------------------------------------
# Caricamento JSON (piatto o annidato per categoria)
# ---------------------------------------------------------------------------

def load_cards(json_path: Path) -> tuple[list[dict], dict[str, str]]:
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        all_cards = data
    else:
        all_cards = []
        for v in data.values():
            if isinstance(v, list):
                all_cards.extend(v)
    id_to_name = {c["id"]: c["name"] for c in all_cards}
    return all_cards, id_to_name


# ---------------------------------------------------------------------------
# Template key — determina quale PDF usare in templates/
# ---------------------------------------------------------------------------

def get_template_key(card: dict) -> str:
    t = card.get("type", "")
    if t == "spell":    return "spell"
    if t == "building": return "building"
    return card.get("subtype", "recruit")   # "recruit" o "hero"


# ---------------------------------------------------------------------------
# Font
# ---------------------------------------------------------------------------

def _pick(font_dir: Path, *patterns: str) -> Path | None:
    """Ritorna il primo file in font_dir il cui nome (lower) contiene tutti i pattern."""
    exts = {".ttf", ".otf", ".TTF", ".OTF"}
    for f in sorted(font_dir.iterdir()):
        if f.suffix not in exts:
            continue
        nl = f.name.lower()
        if all(p.lower() in nl for p in patterns):
            return f
    return None


def load_fonts(font_dir: Path) -> dict:
    lb_regular = _pick(font_dir, "librebaskerville", "regular")
    lb_italic  = _pick(font_dir, "librebaskerville", "italic")
    lb_semi    = _pick(font_dir, "librebaskerville", "semibold")

    missing = [name for name, f in [("LibreBaskerville-Regular", lb_regular),
                                     ("LibreBaskerville-Italic",  lb_italic),
                                     ("LibreBaskerville-SemiBold", lb_semi)] if f is None]
    if missing:
        print(f"  ⚠  Font non trovati: {', '.join(missing)} — uso PIL default per quelli mancanti")

    fallback = ImageFont.load_default()

    def tf(path: Path | None, size_pt: float) -> ImageFont.FreeTypeFont:
        if path is None:
            return fallback
        return ImageFont.truetype(str(path), pt(size_pt))

    return {
        "type":       tf(lb_semi,    FSIZE_TYPE),     # Guerriero  — SemiBold
        "subtype":    tf(lb_regular, FSIZE_SUBTYPE),  # Recluta    — Regular
        "name":       tf(lb_semi,    FSIZE_NAME),     # PATRIZIO   — SemiBold
        "cost":       tf(lb_semi,    FSIZE_COST),     # numero     — SemiBold
        "stat_label": tf(lb_regular, FSIZE_STATS),    # ATT: GIT:  — Regular
        "stat_val":   tf(lb_italic,  FSIZE_STATS),    # Elfo, …    — Italic
        "effect":     tf(lb_italic,  FSIZE_EFFECT),   # effetto    — Italic
    }


# ---------------------------------------------------------------------------
# Helpers di disegno
# ---------------------------------------------------------------------------

def draw_mm(draw, cx_pt, cy_pt, text, font, color):
    """Centro-centro."""
    draw.text((pt(cx_pt), pt(cy_pt)), text, font=font, fill=color, anchor="mm")

def draw_mt(draw, cx_pt, y_pt, text, font, color):
    """Centro-top."""
    draw.text((pt(cx_pt), pt(y_pt)), text, font=font, fill=color, anchor="mt")

def draw_lt(draw, x_pt, y_pt, text, font, color):
    """Left-top."""
    draw.text((pt(x_pt), pt(y_pt)), text, font=font, fill=color, anchor="lt")

def draw_rt(draw, x_pt, y_pt, text, font, color):
    """Right-align: calcola la x manualmente e usa lt per garantire stessa y di draw_lt."""
    try:
        text_w = font.getlength(text)
    except AttributeError:
        text_w = len(text) * pt(FSIZE_STATS) * 0.6
    x_start = pt(x_pt) - int(round(text_w))
    draw.text((x_start, pt(y_pt)), text, font=font, fill=color, anchor="lt")


# ---------------------------------------------------------------------------
# Illustrazione
# ---------------------------------------------------------------------------

def wrap_pixels(text: str, font, max_px: int) -> list[str]:
    """Word-wrap basato sulla larghezza reale in pixel, non sul conteggio caratteri."""
    words = text.split()
    lines, current = [], []
    for word in words:
        test = " ".join(current + [word])
        try:
            w = font.getlength(test)
        except AttributeError:
            w = len(test) * max_px / 20   # fallback grezzo
        if w <= max_px or not current:
            current.append(word)
        else:
            lines.append(" ".join(current))
            current = [word]
    if current:
        lines.append(" ".join(current))
    return lines


def paste_illustration(bg: Image.Image, illus_path: Path,
                        banner_top_pt: float = BANNER_Y_TOP_PT) -> None:
    """Incolla l'illustrazione con il fondo allineato alla cima del banner."""
    illus = Image.open(illus_path).convert("RGBA")

    target_w = pt(ILLUS_WIDTH_PT)
    ratio     = target_w / illus.width
    target_h  = int(round(illus.height * ratio))
    illus     = illus.resize((target_w, target_h), Image.LANCZOS)

    paste_x = pt(ILLUS_X_LEFT_PT)
    paste_y = pt(banner_top_pt) - target_h   # fondo = cima banner

    bg.paste(illus, (paste_x, paste_y), illus)


# ---------------------------------------------------------------------------
# Sezione stats condivisa (recruit + hero, con y parametrizzate)
# ---------------------------------------------------------------------------

def _draw_stats(draw, card: dict, fonts: dict, id_to_name: dict,
                sy1: float, sy2: float, sy3: float) -> None:
    sy = [pt(sy1), pt(sy2), pt(sy3)]

    left_labels = ["ATT:", "GIT:", "DIF:"]
    left_vals   = [str(card.get("att","")), str(card.get("git","")), str(card.get("dif",""))]

    for i, (lbl, val) in enumerate(zip(left_labels, left_vals)):
        draw.text((pt(STATS_LABEL_L_X_PT), sy[i]), lbl, font=fonts["stat_label"],
                  fill=COLOR_BROWN, anchor="ls")
        draw.text((pt(STATS_VAL_L_X_PT),   sy[i]), val, font=fonts["stat_label"],
                  fill=COLOR_BROWN, anchor="ls")

    evo_into = card.get("evolves_into")
    evo_from = card.get("evolves_from")
    if evo_into:
        evo_label = "Evolve in:"
        evo_val   = id_to_name.get(evo_into, snake_to_title(evo_into))
    elif evo_from:
        evo_label = "Evolve da:"
        evo_val   = id_to_name.get(evo_from, snake_to_title(evo_from))
    else:
        evo_label, evo_val = "Evolve in:", "—"

    school     = card.get("school")
    school_str = "Nessuna" if not school else school.capitalize()
    species_str = snake_to_title(card.get("species",""))

    right_labels = ["Specie:", "Scuola:", evo_label]
    right_vals   = [species_str, school_str, evo_val]

    for i, (lbl, val) in enumerate(zip(right_labels, right_vals)):
        try:
            lbl_w = int(round(fonts["stat_label"].getlength(lbl)))
        except AttributeError:
            lbl_w = len(lbl) * pt(FSIZE_STATS) // 2
        lbl_x = pt(STATS_LABEL_R_EDGE_PT) - lbl_w

        draw.text((lbl_x,               sy[i]), lbl, font=fonts["stat_label"],
                  fill=COLOR_BROWN, anchor="ls")
        draw.text((pt(STATS_VAL_R_X_PT), sy[i]), val, font=fonts["stat_val"],
                  fill=COLOR_BROWN, anchor="ls")


# ---------------------------------------------------------------------------
# Blocco testo effetto (spell / building)
# ---------------------------------------------------------------------------

def _draw_effect_block(draw, text: str, fonts: dict, y_start_pt: float) -> None:
    if not text:
        return
    max_px = pt(SB_EFFECT_MAX_W)
    lines  = wrap_pixels(text, fonts["effect"], max_px)
    lh_px  = int(FSIZE_EFFECT * SCALE * 1.35)
    for i, line in enumerate(lines):
        draw_mt(draw, CX_PT, y_start_pt + i * lh_px / SCALE, line, fonts["effect"], COLOR_BROWN)


# ---------------------------------------------------------------------------
# Generazione singola carta — dispatch per tipo
# ---------------------------------------------------------------------------

def generate_card(card: dict, tpl: Image.Image, images_dir: Path,
                  fonts: dict, id_to_name: dict, out_dir: Path) -> None:
    t       = card.get("type", "")
    subtype = card.get("subtype", "")
    cid     = card["id"]

    bg   = tpl.copy().convert("RGBA")
    draw = ImageDraw.Draw(bg)

    # -- Intestazione comune a tutti i tipi --
    tipo      = TYPE_MAP.get(t,       snake_to_title(t))
    sottotipo = SUBTYPE_MAP.get(subtype, snake_to_title(subtype) if subtype else "")
    draw_mt(draw, TYPE_CX_PT, TYPE_Y_PT, tipo, fonts["type"], COLOR_BROWN)
    if sottotipo:
        draw_mt(draw, SUBTYPE_CX_PT, SUBTYPE_Y_PT, sottotipo, fonts["subtype"], COLOR_BROWN)
    draw_mm(draw, COST_CX_PT,    COST_CY_PT,   str(card.get("cost","")), fonts["cost"], COLOR_BROWN)

    if t == "spell":
        # Illustrazione (banner standard)
        paste_illustration(bg, images_dir / f"{cid}.png")
        # Nome
        draw_mm(draw, NAME_CX_PT, NAME_CY_PT, card.get("name","").upper(), fonts["name"], COLOR_GOLD)
        # Due blocchi effetto sotto le icone stella
        _draw_effect_block(draw, card.get("base_effect",""),    fonts, SB_TEXT1_Y)
        _draw_effect_block(draw, card.get("prodigy_effect",""), fonts, SB_TEXT2_Y)

    elif t == "building":
        # Illustrazione (banner standard)
        paste_illustration(bg, images_dir / f"{cid}.png")
        # Nome
        draw_mm(draw, NAME_CX_PT, NAME_CY_PT, card.get("name","").upper(), fonts["name"], COLOR_GOLD)
        # Due blocchi effetto sotto le icone torre
        _draw_effect_block(draw, card.get("base_effect",""),     fonts, SB_TEXT1_Y)
        _draw_effect_block(draw, card.get("complete_effect",""), fonts, SB_TEXT2_Y)
        # Costo completamento centrato nell'icona torre piena (gold, stesso size del costo)
        compl = card.get("completion_cost")
        if compl is not None:
            draw_mm(draw, BLDG_COMPL_CX, BLDG_COMPL_CY, str(compl), fonts["cost"], COLOR_GOLD)

    elif subtype == "hero":
        # Illustrazione (banner più in basso)
        paste_illustration(bg, images_dir / f"{cid}.png", banner_top_pt=H_BANNER_TOP)
        # Nome
        draw_mm(draw, NAME_CX_PT, H_NAME_CY, card.get("name","").upper(), fonts["name"], COLOR_GOLD)
        # Stats con y spostate
        _draw_stats(draw, card, fonts, id_to_name, H_STATS_Y1, H_STATS_Y2, H_STATS_Y3)
        # No horde per l'eroe

    else:  # recruit (default warrior)
        # Illustrazione (banner standard)
        paste_illustration(bg, images_dir / f"{cid}.png")
        # Nome
        draw_mm(draw, NAME_CX_PT, NAME_CY_PT, card.get("name","").upper(), fonts["name"], COLOR_GOLD)
        # Stats
        _draw_stats(draw, card, fonts, id_to_name, STATS_Y1_PT, STATS_Y2_PT, STATS_Y3_PT)
        # Effetto orda
        effect = card.get("horde_effect","")
        if effect:
            max_px = pt(HORDE_MAX_W_PT)
            lines  = wrap_pixels(effect, fonts["effect"], max_px)
            lh_px  = int(FSIZE_EFFECT * SCALE * 1.35)
            for i, line in enumerate(lines):
                draw_mt(draw, HORDE_CX_PT, HORDE_Y_PT + i * lh_px / SCALE, line, fonts["effect"], COLOR_BROWN)

    # cx_px = pt(CX_PT)
    # draw.line([(cx_px, 0), (cx_px, pt(CARD_H_PT))], fill=(255, 0, 0), width=1)

    out = out_dir / f"{cid}.png"
    bg.convert("RGB").save(out, format="PNG", dpi=(DPI, DPI))
    print(f"  ✓ {out.name}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cards_json")
    ap.add_argument("--templates", default="./templates",
                    help="Cartella template PNG. File usato per ogni carta: {key}.png "
                         "(recruit.png, hero.png, spell.png, building.png). "
                         "La scala viene rilevata automaticamente dalla larghezza del PNG.")
    ap.add_argument("--images",   default="./images")
    ap.add_argument("--fonts",    default="./fonts")
    ap.add_argument("--out",      default="./output")
    ap.add_argument("--dpi",      type=int, default=300)
    args = ap.parse_args()

    global DPI, SCALE
    DPI, SCALE = args.dpi, args.dpi / 72.0

    out_dir       = Path(args.out);       out_dir.mkdir(parents=True, exist_ok=True)
    templates_dir = Path(args.templates)
    images_dir    = Path(args.images)

    fonts = load_fonts(Path(args.fonts))
    all_cards, id_to_name = load_cards(Path(args.cards_json))

    # Cache dei template renderizzati
    tpl_cache: dict[str, Image.Image] = {}

    def get_template(key: str) -> Image.Image | None:
        global SCALE, DPI
        if key in tpl_cache:
            return tpl_cache[key]
        png_path = templates_dir / f"{key}.png"
        if not png_path.exists():
            print(f"  ✗  Template non trovato: {png_path}")
            return None
        img = Image.open(str(png_path)).convert("RGBA")
        # Rileva la scala dalla larghezza reale del PNG (al primo template)
        if not tpl_cache:
            SCALE = img.width / CARD_W_PT
            DPI   = round(SCALE * 72.0)
            print(f"  Scala rilevata: {SCALE:.4f}  (DPI equivalente: {DPI})")
        tpl_cache[key] = img
        print(f"  Template caricato: {png_path.name}  ({img.width}×{img.height}px)")
        return img

    print(f"Carte nel JSON: {len(all_cards)}\n")
    for card in all_cards:
        cid     = card.get("id", "?")
        tpl_key = get_template_key(card)
        has_img = (images_dir / f"{cid}.png").exists()

        print(f"→ {cid}  [{tpl_key}] [img: {'✓' if has_img else '✗ skip'}]")
        if not has_img:
            continue

        tpl = get_template(tpl_key)
        if tpl is None:
            continue
        generate_card(card, tpl, images_dir, fonts, id_to_name, out_dir)

    print(f"\nFatto — output in '{args.out}'")


if __name__ == "__main__":
    main()