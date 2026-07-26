#!/usr/bin/env python3
"""
3_generate_cards.py
Genera le carte Barbacane finali dal renderer HTML unico (card.html).

A differenza della vecchia pipeline PIL (template PNG + testo sovrapposto a coordinate
fisse), qui la carta *disegna se stessa*: card.html impagina tutto — nome, tipo, costo,
statistiche, pannelli, effetto orda, auto-adattamento del testo lungo. Questo script si
limita a passargli i dati di ogni carta (da ../data/cards.json) e a fotografarne il
risultato con un browser headless.

Vantaggio: un'unica fonte di verità per la grafica (card.html). Cambi lo stile lì e
tutte le carte si aggiornano — nessuna coordinata da ritarare.

`render_cards()` è riutilizzato anche da 4_make_print_pdf.py, che rigenera le carte a
risoluzione più alta apposta per la stampa senza toccare i PNG in output/.

Utilizzo:
    python 3_generate_cards.py                  # tutte le carte
    python 3_generate_cards.py faust joseph      # solo le carte indicate
    python 3_generate_cards.py --scale 2         # 2x risoluzione (default 1 = 300 DPI)
"""

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT       = Path(__file__).parent
CARD_HTML  = ROOT / "assets" / "card.html"
CARDS_JSON = ROOT.parent / "data" / "cards.json"
IMAGES_DIR = ROOT / "images"
OUT_DIR    = ROOT / "output"

# Il retro non è una carta da gioco: non vive in cards.json, si genera comunque con
# card.html (case "back" in renderCard) per restare l'unica fonte di verità grafica.
BACK_CARD = {"id": "retro", "name": "Retro", "type": "back"}


def load_cards(json_path: Path):
    """Accetta sia una lista piatta sia un dict {categoria: [carte...]}."""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        cards = data
    else:
        cards = []
        for v in data.values():
            if isinstance(v, list):
                cards.extend(v)
    cards.append(BACK_CARD)
    id_to_name = {c["id"]: c["name"] for c in cards if "id" in c and "name" in c}
    return cards, id_to_name


def render_cards(cards, id_to_name, out_dir: Path, scale: float = 1.0, quiet: bool = False):
    """Renderizza ogni carta con card.html in un browser headless e salva out_dir/<id>.png."""
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=scale,
                                viewport={"width": 900, "height": 1200})
        page.goto(CARD_HTML.resolve().as_uri())
        page.wait_for_function("() => typeof renderCard === 'function'")

        for card in cards:
            cid = card.get("id", "?")
            has_img = (IMAGES_DIR / f"{cid}.png").exists()
            page.evaluate("([c, n]) => renderCard(c, n)", [card, id_to_name])
            page.wait_for_function("() => !!document.getElementById('card')")
            page.evaluate("() => document.fonts.ready")
            page.wait_for_timeout(120)  # lascia assestare il fit del testo
            el = page.query_selector("#card")
            out = out_dir / f"{cid}.png"
            el.screenshot(path=str(out))
            if not quiet:
                print(f"  OK {out.name}  [{card.get('type', '?')}/{card.get('subtype') or '-'}]"
                      f"{'' if has_img or card.get('type') == 'back' else '  (nessuna illustrazione)'}")

        browser.close()


def main():
    parser = argparse.ArgumentParser(
        description="Genera le carte Barbacane dal renderer HTML (card.html)."
    )
    parser.add_argument(
        "ids",
        nargs="*",
        help="Id delle carte da generare (es. faust joseph reinhold). "
             "Se omesso, genera tutte le carte del JSON.",
    )
    parser.add_argument(
        "--scale", type=float, default=1.0,
        help="Moltiplicatore di risoluzione (1 = 744x1039px, ~300 DPI). Default 1.",
    )
    args = parser.parse_args()

    cards, id_to_name = load_cards(CARDS_JSON)

    if args.ids:
        wanted = set(args.ids)
        missing = wanted - {c.get("id") for c in cards}
        if missing:
            print(f"Attenzione: id non trovati nel JSON: {', '.join(sorted(missing))}", file=sys.stderr)
        cards = [c for c in cards if c.get("id") in wanted]

    print(f"Carte da generare: {len(cards)}  (scala {args.scale}x)\n")
    render_cards(cards, id_to_name, OUT_DIR, scale=args.scale)
    print(f"\nFatto — output in '{OUT_DIR}'")


if __name__ == "__main__":
    main()
