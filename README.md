# 🧱 Barbacane

![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)

Barbacane è un gioco di carte fantasy, ora in versione digitale multiplayer.

Il mondo di Barbacane è popolato da Umani, Elfi, Nani e Maghe — tutti, inspiegabilmente, di sangue Goblin. Turno dopo turno, ogni giocatore deve potenziare il proprio campo di gioco schierando Guerrieri, erigendo Costruzioni e scagliando Magie contro gli avversari. Niente alleanze, niente tregue: ne resterà soltanto uno.

La beta è disponibile qui: [Play Barbacane](https://barbacane.onrender.com).

## Avvio in Locale

```bash
pip install -r requirements.txt
python main.py
```

Apri il browser su `http://localhost:8000` per accedere alla schermata di gioco. Accedi da più finestre per poter simulare una partita.

In locale la persistenza usa un file SQLite (`barbacane.db`) creato automaticamente. Per usare Postgres anche in locale, imposta la variabile d'ambiente `DATABASE_URL` con una connection string Postgres prima di avviare il server.

## Come si Gioca

Ecco una breve introduzione al gioco e alle sue meccaniche principali. Per il regolamento completo, consigliamo comunque di vedere `assets/rules.md`.

### Campo di Gioco

Si gioca da 2 a 4 giocatori, con un mazzo comune di 200 carte. Ogni giocatore inizia con 3 Vite e pesca 6 carte.

Ogni giocatore ha un campo diviso in 4 Regioni:
- **Avanscoperta** — dove si posizionano i Guerrieri offensivi: i loro ATT e GIT determinano la potenza d'attacco in Battaglia.
- **Bastioni (Destro e Sinistro)** — dove si posizionano i Muri e i Guerrieri difensivi: i Muri assorbono i Danni, mentre la DIF e la GIT dei Guerrieri determinano la potenza difensiva in Battaglia.
- **Villaggio** — dove si posizionano le Costruzioni, che potenziano il giocatore

### Turno

1. **Fase iniziale**: ricevi Mana (scalato al numero di turno: da 1 a 5)
2. **Fase delle Azioni**: fino a 2 Azioni — gioca carte, completa Costruzioni, aggiungi Muri
3. **Fase dello Schieramento**: riposiziona i Guerrieri tra Avanscoperta e Bastioni e attiva le Orde disponibili
4. **Fase della Battaglia** (opzionale): attacca un Bastione avversario adiacente
5. **Fase finale**: pesca fino a 6 carte

### Tipi di Carta

- **Guerrieri** (Reclute ed Eroi): hanno ATT, GIT e DIF; le Reclute evolvono in Eroi
- **Magie** (Anatemi, Sortilegi, Incantesimi): costo in Maghe anziché Mana; attivano il Prodigio se le Maghe della stessa Scuola in campo sono sufficienti
- **Costruzioni**: piazzate incomplete con effetto Base, completabili con un'azione aggiuntiva per sbloccare l'effetto Completo
- **Muri**: qualsiasi carta può essere convertita in Muro per assorbire danni in Battaglia

### Battaglia

Il danno inflitto a un Bastione è calcolato così:

```
Danno = max(ATT_att − DIF_dif, 0) + max(GIT_att − GIT_dif, 0)
```

Il Bastione perde Muri pari al Danno. Se il Danno supera i Muri disponibili, il difensore perde 1 Vita.

### Orde

Schierare 3 Guerrieri della stessa Specie nella stessa Regione forma un'Orda e sblocca un effetto speciale attivabile una volta per turno.

## Guida per Developer

### Struttura del Progetto

```
barbacane/
├── main.py                      # Entry point FastAPI
├── assets/
│   ├── logo.png
│   └── rules.md                 # Regolamento completo
├── data/
│   ├── cards.json               # Database carte
│   ├── rules_config.json        # Parametri di gioco
│   └── test_cards.json          # Carte di test (modalità debug)
├── engine/
│   ├── models.py                # Modelli dati (carte, giocatori, GameState)
│   ├── game.py                  # Logica turno
│   ├── cards.py                 # Registro carte
│   ├── battle.py                # Risoluzione Battaglia
│   ├── effects.py               # Registro effetti carte
│   ├── actions.py               # Azioni di turno
│   └── deck.py                  # Gestione mazzo
├── server/
│   ├── lobby.py                 # Creazione e accesso lobby
│   ├── ws_manager.py            # WebSocket manager
│   └── routes.py                # Endpoint REST + WebSocket
├── db/
│   └── storage.py               # Persistenza: Postgres (Neon) o SQLite in locale
└── frontend/
    ├── index.html
    ├── style.css
    ├── app.js                   # UI principale
    ├── ws.js                    # Client WebSocket
    └── renderer.js              # Rendering campo da gioco
```

### Flusso di un'Azione

Il client (frontend) non conosce le regole del gioco: si limita a tradurre i click del giocatore in un'**intenzione** (`{action, params}`) e a mostrare lo stato che riceve indietro. Tutta la logica vive nel server, organizzato in livelli che si passano lo stato in sequenza:

```
app.js          (intenzione)
  → routes.py   (dispatcher)
  → actions.py  (regole del turno)
  → effects.py  (effetto carta)
  → storage.py  (persistenza)
  → ws.js       (broadcast a tutti i client)
  → app.js      (applyState → aggiorna la UI)
```

- **`app.js`** (client) — costruisce l'intenzione (es. "gioca questa carta su questo bersaglio") e la invia via WebSocket. Non modifica mai lo stato in locale.
- **`routes.py`** (dispatcher) — unico punto d'ingresso del server: riceve il messaggio e lo smista alla funzione giusta in base al tipo di azione.
- **`actions.py`** (regole del turno) — verifica che l'azione sia legale in questo momento (turno del giocatore, mana/maghe sufficienti, azioni rimaste, carta effettivamente in mano), poi consuma la risorsa necessaria.
- **`effects.py`** (effetto carta) — la funzione registrata per quella carta specifica, che modifica davvero il `GameState` (danni, pescate, mana guadagnato...).
- **`storage.py`** (persistenza) — salva il nuovo `GameState` sul database (Postgres su Neon in produzione, SQLite in locale); il server genera poi una vista filtrata dello stato per ciascun giocatore (`public_state`) e la rispedisce a tutti via WebSocket, dove `ws.js` la riceve e aggiorna la UI.

Esempio concreto, un giocatore gioca la Magia Ardolancio:

1. `app.js` costruisce `{action: "play_spell", params: {instance_id, bastion_side}}` e lo invia via WebSocket.
2. `routes.py` → `_dispatch_action()` riceve il messaggio e chiama `play_spell(state, player_id, instance_id, **params)`.
3. `actions.py` → `play_spell()` valida turno/mana/maghe, rimuove la carta dalla mano, poi chiama `apply_effect(card.effect_id, state, player, prodigy=..., **params)`.
4. `effects.py` → la funzione registrata (`ardolancio_effect`) modifica il `GameState` e ritorna un dict con il risultato.
5. `routes.py` salva il nuovo stato sul database, genera `public_state(state, player_id)` per ogni giocatore connesso e fa broadcast via WebSocket.
6. `ws.js` riceve il nuovo stato e chiama `app.js` → `applyState()`, che aggiorna la UI.

### Aggiungere una Nuova Carta

1. Definire la carta in `data/cards.json` con un `effect_id` univoco.
2. Implementare e registrare la funzione effetto in `engine/effects.py`:

   ```python
   @register_effect("ardolancio_effect")
   def ardolancio_effect(state, player, prodigy=False, target_player_id=None, bastion_side=None, **kwargs):
       damage = 4 if prodigy else 2
       apply_damage_to_bastion(state, target_player_id, bastion_side, damage)
       return {"damage": damage}
   ```

3. Se l'effetto richiede targeting o input dal giocatore (scegliere un bastione, un bersaglio, una carta da cercare...), aggiungere la UI ad hoc in `app.js` per costruire i `params` dell'azione, ed eventualmente il rendering specifico in `renderer.js`.
4. Se l'effetto introduce un'interazione asincrona in due passi (es. cercare, biblioteca), usare `state.pending_search` / `state.pending_interactions` e gestire la risposta con un'azione `resolve_*` dedicata.

### Modalità Test

Entrare con nome `Test` o `Test2` per avere le carte da `data/test_cards.json` in cima al mazzo, 10 Mana e 5 Azioni a ogni turno. Utile per testare effetti specifici senza dover giocare turni di setup.

## Stack Tecnologico

- **Backend**: Python + FastAPI, WebSocket per aggiornamenti real-time
- **Frontend**: SPA in vanilla JS, servita come file statico da FastAPI
- **Persistenza**: PostgreSQL su [Neon](https://neon.tech) (free tier) in produzione, tramite variabile d'ambiente `DATABASE_URL`; fallback automatico su SQLite locale in sviluppo. Le partite finite o abbandonate vengono eliminate automaticamente.
- **Deploy**: Render (free tier); il client invia un ping HTTP periodico per evitare lo spindown durante le partite
