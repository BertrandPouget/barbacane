"""
Entry point FastAPI di Barbacane.
Serve sia il backend (API/WebSocket) che i file statici del frontend.
"""

import asyncio
import logging
import os
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from db.storage import init_db, cleanup_games
from server.routes import router

logger = logging.getLogger("barbacane")

app = FastAPI(
    title="Barbacane",
    description="Gioco di carte fantasy multiplayer online",
    version="0.1.0",
)

_CLEANUP_INTERVAL_SECONDS = 15 * 60


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
    logging.basicConfig(level=logging.INFO)
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

# Espone /data/ al frontend (cards.json, rules_config.json)
app.mount("/data", StaticFiles(directory=_DATA_DIR), name="data")

# Espone /assets/ al frontend (logo.png, ecc.)
app.mount("/assets", StaticFiles(directory=_ASSETS_DIR), name="assets")

# Espone le immagini delle carte (card_factory/output/) se disponibili
if os.path.isdir(_CARD_IMAGES_DIR):
    app.mount("/card_images", StaticFiles(directory=_CARD_IMAGES_DIR), name="card_images")

# SPA catch-all: serve file statici se esistono, altrimenti index.html
@app.get("/")
@app.get("/{full_path:path}")
async def serve_spa(full_path: str = ""):
    # Frontend mobile: /m (o /mobile) → frontend/mobile/index.html
    if full_path in ("m", "m/", "mobile", "mobile/"):
        return FileResponse(os.path.join(_FRONTEND_DIR, "mobile", "index.html"))
    # Se è un file che esiste nel frontend dir, servilo direttamente
    candidate = os.path.join(_FRONTEND_DIR, full_path)
    if full_path and os.path.isfile(candidate):
        return FileResponse(candidate)
    # Altrimenti ritorna index.html (SPA routing)
    return FileResponse(os.path.join(_FRONTEND_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
