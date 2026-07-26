#!/usr/bin/env python3
"""
lib/render.py
Motore di rendering delle carte: apre assets/card.html in un browser headless
(Playwright), gli passa i dati di ogni carta e ne fotografa il risultato.

card.html impagina tutto da solo — nome, tipo, costo, statistiche, pannelli
effetto, effetto orda — con auto-adattamento del testo lungo. Per cambiare lo
stile grafico si tocca solo assets/card.html: tutte le carte si aggiornano
insieme, senza coordinate da ritarare.

Usato sia da 2_generate_cards.py (carte gioco, output/) sia da
3_make_print_pdf.py (rigenerazione a risoluzione di stampa).
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent   # card_factory/
CARD_HTML = ROOT / "assets" / "card.html"
IMAGES_DIR = ROOT / "images"


def render_cards(cards, id_to_name, out_dir: Path, scale: float = 1.0, quiet: bool = False, debug: bool = False):
    """Renderizza ogni carta con card.html in un browser headless e salva out_dir/<id>.png.

    debug=True disegna i bordi dei contenitori flex (vedi card.html, classe .debug-borders).
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=scale,
                                viewport={"width": 900, "height": 1200})
        page.goto(CARD_HTML.resolve().as_uri())
        page.wait_for_function("() => typeof renderCard === 'function'")
        if debug:
            page.evaluate("() => document.documentElement.classList.add('debug-borders')")

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
