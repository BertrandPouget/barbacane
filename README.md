# 🧱 Barbacane

![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat&logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)

Barbacane è un gioco di carte da tavolo fantasy in versione digitale multiplayer online, giocabile da browser senza installazione.

Il gioco è ambientato in un mondo popolato da Umani, Elfi, Nani e Maghe (tutti di sangue Goblin). Ogni giocatore costruisce e difende il proprio campo schierando Guerrieri, erigendo Costruzioni e lanciando Magie — finché non rimane uno solo con almeno una Vita in piedi.

**Prova la beta su [barbacane.onrender.com](https://barbacane.onrender.com)**

## Avvio in Locale

```bash
pip install -r requirements.txt
python main.py
```

Apri il browser su `http://localhost:8000` per accedere alla schermata di gioco. Accedi da più finestre per poter simulare una partita.

## Come si Gioca

**Setup**: 2–4 giocatori. Mazzo comune da 200 carte. Ogni giocatore inizia con 3 Vite e pesca 6 carte.

### Il Campo di Gioco

Ogni giocatore ha un campo diviso in 4 Regioni:

```
[ Avanscoperta ] [ Bastione Sinistro ] [ Bastione Destro ] [ Villaggio ]
```

- **Avanscoperta** — i Guerrieri qui attaccano e determinano la potenza offensiva
- **Bastioni** — i Guerrieri qui difendono; i Muri assorbono i danni in arrivo
- **Villaggio** — contiene le Costruzioni, che potenziano il giocatore, e le Vite rimanenti

I giocatori siedono in cerchio: il Bastione destro di un giocatore è adiacente al Bastione sinistro del successivo.

### Turno

1. Ricevi Mana (scalato al numero di turno: da 1 a 5)
2. Fino a 2 Azioni: gioca carte, completa Costruzioni, aggiungi Muri
3. Riposiziona Guerrieri tra Avanscoperta e Bastioni (gratuito)
4. Attiva le Orde disponibili
5. Battaglia (opzionale): attacca un Bastione avversario adiacente
6. Pesca fino a 6 carte

### Tipi di Carta

- **Guerrieri** (Reclute ed Eroi): hanno ATT, GIT e DIF; le Reclute evolvono in Eroi
- **Magie** (Anatemi, Sortilegi, Incantesimi): costo in Maghe anziché Mana; attivano il **Prodigio** se le Maghe della stessa Scuola in campo sono sufficienti
- **Costruzioni**: piazzate incomplete con effetto Base, completabili con un'azione aggiuntiva per sbloccare l'effetto Completo
- **Muri**: qualsiasi carta può essere convertita in Muro per assorbire danni in Battaglia

Per il regolamento completo vedere `assets/rules.md`.

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
│   └── storage.py               # Persistenza SQLite
└── frontend/
    ├── index.html
    ├── style.css
    ├── app.js                   # UI principale
    ├── ws.js                    # Client WebSocket
    └── renderer.js              # Rendering campo da gioco
```

### Flusso di un'Azione

Quando un giocatore gioca una carta, l'intera pipeline è:

```
app.js  →  WebSocket  →  routes.py (_dispatch_action)
       →  actions.py (validazione + rimozione dalla mano)
       →  effects.py (applica effetto sul GameState)
       →  storage.py (salva su SQLite)
       →  public_state() per ogni giocatore  →  broadcast WebSocket
```

Il client invia solo intenzioni; il server valida tutto e non si fida mai dello stato client.

### Registry degli Effetti

Ogni effetto carta è una funzione registrata in `engine/effects.py`:

```python
@register_effect("ardolancio_effect")
def ardolancio_effect(state, player, prodigy=False, target_player_id=None, bastion_side=None, **kwargs):
    damage = 4 if prodigy else 2
    apply_damage_to_bastion(state, target_player_id, bastion_side, damage)
    return {"damage": damage}
```

Per aggiungere una carta: definire la carta in `data/cards.json` con un `effect_id`, poi registrare la funzione corrispondente in `effects.py`.

### Modalità Test

Entrare con nome `Test` o `Test2` per avere le carte da `data/test_cards.json` in cima al mazzo, 10 Mana e 5 Azioni a ogni turno. Utile per testare effetti specifici senza dover giocare turni di setup.

## Stack Tecnologico

- **Backend**: Python + FastAPI, WebSocket per aggiornamenti real-time
- **Frontend**: SPA in vanilla JS, servita come file statico da FastAPI
- **Persistenza**: SQLite
- **Deploy**: Render (free tier)