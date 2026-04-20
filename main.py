"""
Entry point FastAPI di Barbacane.
Serve sia il backend (API/WebSocket) che i file statici del frontend.
"""

import os
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from db.storage import init_db
from server.routes import router

app = FastAPI(
    title="Barbacane",
    description="Gioco di carte fantasy multiplayer online",
    version="0.1.0",
)

# Inizializza il database al primo avvio
@app.on_event("startup")
async def startup():
    init_db()


# Endpoint API e WebSocket
app.include_router(router, prefix="")


# Percorsi
_FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")
_DATA_DIR     = os.path.join(os.path.dirname(__file__), "data")

_ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")

# Espone /data/ al frontend (cards.json, rules_config.json)
app.mount("/data", StaticFiles(directory=_DATA_DIR), name="data")

# Espone /assets/ al frontend (logo.png, ecc.)
app.mount("/assets", StaticFiles(directory=_ASSETS_DIR), name="assets")

# SPA catch-all: serve file statici se esistono, altrimenti index.html
@app.get("/")
@app.get("/{full_path:path}")
async def serve_spa(full_path: str = ""):
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
