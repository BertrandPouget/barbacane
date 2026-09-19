"""
Entry point FastAPI di Barbacane.
Serve sia il backend (API/WebSocket) che i file statici del frontend.
"""

import asyncio
import hashlib
import logging
import os
import re
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from db.storage import init_db, cleanup_games
from server.routes import router

logger = logging.getLogger("barbacane")

app = FastAPI(
    title="Barbacane",
    description="Gioco di carte fantasy multiplayer online",
    version="0.1.0",
)

_CLEANUP_INTERVAL_SECONDS = 5 * 60


async def _cleanup_loop():
    """Elimina periodicamente le partite finite/abbandonate dal database."""
    while True:
        try:
            deleted = await asyncio.to_thread(cleanup_games)
            if deleted:
                logger.info("[cleanup] Eliminate %d partite finite/abbandonate", deleted)
        except Exception as e:
            logger.error("[cleanup] Errore: %s", e)
        await asyncio.sleep(_CLEANUP_INTERVAL_SECONDS)


# Inizializza il database al primo avvio
@app.on_event("startup")
async def startup():
    from db.storage import IS_POSTGRES

    # Riusa l'handler/formatter di Uvicorn per allineare lo stile dei nostri
    # log ("INFO:     msg") a quello delle righe stampate da Uvicorn stesso,
    # invece del formato di default di basicConfig ("INFO:barbacane:msg").
    # Configurato sul root logger cosi' ne beneficiano anche i logger creati
    # con getLogger(__name__) altrove nel progetto (es. server/routes.py).
    uvicorn_logger = logging.getLogger("uvicorn")
    root_logger = logging.getLogger()
    if uvicorn_logger.handlers:
        root_logger.handlers = uvicorn_logger.handlers
    root_logger.setLevel(logging.INFO)

    logger.info("[storage] Backend attivo: %s", "POSTGRES (Neon)" if IS_POSTGRES else "SQLITE (locale/effimero)")
    init_db()
    asyncio.create_task(_cleanup_loop())


# Keep-alive: il client lo chiama periodicamente via HTTP per evitare che
# Render consideri inattivo il servizio (il traffico WebSocket non conta).
@app.get("/health")
async def health():
    return {"status": "ok"}


# Endpoint API e WebSocket
app.include_router(router, prefix="")


# Percorsi
_FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")
_DATA_DIR     = os.path.join(os.path.dirname(__file__), "data")

_ASSETS_DIR       = os.path.join(os.path.dirname(__file__), "assets")
_CARD_IMAGES_DIR  = os.path.join(os.path.dirname(__file__), "card_factory", "output")

# --- Cache busting -----------------------------------------------------------
# Senza questi accorgimenti il browser continua a mostrare CSS, immagini e carte
# della visita precedente finche' non gli si svuota la cache a mano: banale da
# fare su desktop (Ctrl+F5), scomodo su mobile e impossibile da chiedere a chi
# gioca. CSS e JS vengono quindi serviti con un ?v=<impronta di frontend/> che
# cambia da solo a ogni modifica; immagini, audio e dati con un Cache-Control
# che impone la rivalidazione (ETag -> 304 quando il file non e' cambiato).

_VERSIONED_REF = re.compile(r'\b(href|src)="(?!https?:|//|data:)([^"?#]+\.(?:css|js))"')


def _asset_version() -> str:
    """Impronta di frontend/ (nome + mtime + dimensione di ogni file)."""
    h = hashlib.md5()
    for root, _dirs, files in os.walk(_FRONTEND_DIR):
        for name in sorted(files):
            try:
                st = os.stat(os.path.join(root, name))
            except OSError:
                continue
            h.update(f"{name}:{st.st_mtime_ns}:{st.st_size};".encode())
    return h.hexdigest()[:10]


def _serve_html(path: str) -> HTMLResponse:
    """Serve un index.html marcando CSS e JS con la versione corrente.

    L'HTML stesso non va mai cacheato senza rivalidare, altrimenti il browser
    non vedrebbe mai i ?v= aggiornati e il meccanismo si morderebbe la coda.
    """
    with open(path, encoding="utf-8") as f:
        html = f.read()
    html = _VERSIONED_REF.sub(rf'\1="\2?v={_asset_version()}"', html)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


class _RevalidatingStatic(StaticFiles):
    """StaticFiles che chiede al browser di rivalidare prima di riusare la copia in cache."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Espone /data/ al frontend (cards.json, rules_config.json)
app.mount("/data", _RevalidatingStatic(directory=_DATA_DIR), name="data")

# Espone /assets/ al frontend (logo.png, ecc.)
app.mount("/assets", _RevalidatingStatic(directory=_ASSETS_DIR), name="assets")

# Espone le immagini delle carte (card_factory/output/) se disponibili
if os.path.isdir(_CARD_IMAGES_DIR):
    app.mount("/card_images", _RevalidatingStatic(directory=_CARD_IMAGES_DIR), name="card_images")

# SPA catch-all: serve file statici se esistono, altrimenti index.html
@app.get("/")
@app.get("/{full_path:path}")
async def serve_spa(request: Request, full_path: str = ""):
    # Frontend mobile: /m (o /mobile) → frontend/mobile/index.html
    if full_path in ("m", "m/", "mobile", "mobile/"):
        return _serve_html(os.path.join(_FRONTEND_DIR, "mobile", "index.html"))
    # Se è un file che esiste nel frontend dir, servilo direttamente
    candidate = os.path.join(_FRONTEND_DIR, full_path)
    if full_path and os.path.isfile(candidate):
        if full_path.endswith(".html"):
            return _serve_html(candidate)
        # Un ?v= nell'URL identifica gia' questa versione del file: puo' restare
        # in cache a lungo, e una modifica arriva con un ?v= diverso. Senza ?v=
        # (richiesta diretta, link vecchio) si ricade sulla rivalidazione.
        cache = "public, max-age=31536000, immutable" if request.query_params.get("v") else "no-cache"
        return FileResponse(candidate, headers={"Cache-Control": cache})
    # Altrimenti ritorna index.html (SPA routing)
    return _serve_html(os.path.join(_FRONTEND_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
