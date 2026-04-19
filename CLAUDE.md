# Barbacane — Specifica di Progetto

## Panoramica

Barbacane è un gioco di carte da tavolo ambientato in un mondo fantasy popolato da Umani, Elfi, Nani e Maghe (tutti di sangue Goblin). L'obiettivo di questo progetto è realizzarne una versione digitale multiplayer online, giocabile da browser con i propri amici.

Il gioco è a turni: ogni giocatore posiziona carte (Guerrieri, Magie, Costruzioni) su un campo diviso in 4 Regioni (Avanscoperta, Bastione sinistro, Bastione destro, Villaggio) disposte attorno a un nucleo centrale. Vince l'ultimo giocatore con almeno una Vita rimasta.

---

## Stack Tecnologico

### Linguaggio: Python (backend) + HTML/CSS/JS (frontend)

Il motore di gioco è interamente in **Python**. Il backend espone un'API REST (o WebSocket) con cui il frontend comunica. Il frontend è una Single Page Application leggera in vanilla JS (o con un micro-framework come Alpine.js / Preact) che viene servita come file statico.

### Framework backend: FastAPI + WebSocket

- **FastAPI** per l'API REST e il supporto nativo a WebSocket.
- WebSocket per aggiornamenti in tempo reale (stato del turno, notifiche di azioni avversarie, chat).
- Fallback polling REST se WebSocket non disponibile.

### Persistenza dati: JSON su file system (via GitHub o SQLite)

Lo stato della partita viene serializzato come un singolo JSON a ogni cambio di stato significativo (fine azione, fine turno). Due opzioni gratuite da valutare:

| Opzione | Pro | Contro |
|---|---|---|
| **SQLite (su disco del server)** | Veloce, zero latenza di rete, nativo Python, zero setup | Legato al filesystem del server; se il server muore, i dati si perdono (mitigabile con backup periodici su GitHub) |
| **GitHub come datastore (API)** | Già testato in passato, dati persistenti e versionati, accessibili da ovunque | Latenza API (~300-800ms per write), rate limit (5000 req/h con token), complessità aggiuntiva |

**Decisione: SQLite come storage primario, con export/backup su GitHub opzionale.**

SQLite è perfetto per questo caso d'uso: il gioco è a turni (non richiede scritture ad altissima frequenza), il file `.db` è piccolo e facilmente portabile, ed è già integrato in Python. Ogni partita è una riga con il JSON dello stato completo. Si può aggiungere in seguito un meccanismo di backup su GitHub per durabilità.

### Deploy: Render (free tier)

| Piattaforma | Pro | Contro |
|---|---|---|
| **Vercel** | Già usato, ottimo per frontend statico | Non supporta processi long-running (WebSocket), serverless-only per backend |
| **Render** | Free tier con web service always-on, supporta WebSocket, deploy da GitHub, Python nativo | Il free tier va in sleep dopo 15 min di inattività (~30s cold start) |
| **Railway** | Simile a Render, buon free tier | Crediti limitati/mese |
| **Fly.io** | Ottimo per WebSocket, macchine leggere | Setup più complesso, free tier ridotto |

**Decisione: Render.**

Render supporta WebSocket nativamente, fa deploy diretto da un repo GitHub, e il free tier è sufficiente per partite tra amici. Il cold start di ~30s è accettabile: il primo giocatore che crea la lobby "sveglia" il server e gli altri lo trovano già attivo.

Schema di deploy:
- Un singolo **Web Service** Render che serve sia l'API/WebSocket (FastAPI) che i file statici del frontend.
- Il repo GitHub contiene tutto: backend Python, frontend statico, file dati delle carte.

---

## Architettura del Progetto

```
barbacane/
├── README.md
├── requirements.txt
├── render.yaml                  # Config deploy Render
├── main.py                      # Entry point FastAPI
├── assets/
│   ├── Logo.png
│   └── cards/                   # Eventuali immagini carte (futuro)
├── data/
│   ├── cards.json               # Database carte (generato da Carte.xlsx)
│   └── rules_config.json        # Parametri di gioco (mana per turno, vite iniziali, ecc.)
├── engine/
│   ├── __init__.py
│   ├── models.py                # Dataclass / Pydantic models per carte, giocatori, stato
│   ├── game.py                  # Logica principale del gioco
│   ├── cards.py                 # Caricamento e gestione carte
│   ├── battle.py                # Logica di Battaglia
│   ├── effects.py               # Risoluzione effetti (Orda, Magie, Costruzioni)
│   ├── actions.py               # Azioni del turno (giocare carta, completare, muro)
│   └── deck.py                  # Gestione mazzo, pesca, scarti
├── server/
│   ├── __init__.py
│   ├── lobby.py                 # Creazione/join lobby, gestione giocatori
│   ├── ws_manager.py            # WebSocket connection manager
│   └── routes.py                # Endpoint REST + WebSocket
├── db/
│   ├── __init__.py
│   └── storage.py               # Persistenza SQLite (salva/carica stato partita)
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── app.js                   # Logica UI principale
│   ├── ws.js                    # Client WebSocket
│   ├── renderer.js              # Rendering campo da gioco
│   └── assets/
│       └── Logo.png
└── tests/
    ├── test_game.py
    ├── test_battle.py
    └── test_effects.py
```

---

## Modello Dati

### `cards.json` — Database Carte

Generato dal file `Carte.xlsx` allegato. Struttura:

```json
{
  "warriors": [
    {
      "id": "patrizio",
      "name": "Patrizio",
      "type": "warrior",
      "subtype": "recruit",
      "species": "elfo",
      "school": null,
      "cost": 2,
      "cost_type": "mana",
      "att": 2,
      "git": 1,
      "dif": 2,
      "horde_effect": "Questa carta ottiene +2 GIT.",
      "evolves_from": null,
      "evolves_into": "san_patrizio",
      "copies": 4
    },
    {
      "id": "san_patrizio",
      "name": "San Patrizio",
      "type": "warrior",
      "subtype": "hero",
      "species": "elfo",
      "school": null,
      "cost": 2,
      "cost_type": "mana",
      "att": 4,
      "git": 3,
      "dif": 3,
      "horde_effect": null,
      "evolves_from": "patrizio",
      "evolves_into": null,
      "copies": 2
    }
  ],
  "spells": [
    {
      "id": "ardolancio",
      "name": "Ardolancio",
      "type": "spell",
      "subtype": "anatema",
      "school": "anatema",
      "cost": 1,
      "cost_type": "maga",
      "base_effect": "Infliggi 2 Danni a un Bastione a tua scelta.",
      "prodigy_effect": "Infliggi 4 Danni a un Bastione a tua scelta.",
      "prodigy_is_additive": false,
      "copies": 4
    }
  ],
  "buildings": [
    {
      "id": "estrattore",
      "name": "Estrattore",
      "type": "building",
      "cost": 3,
      "cost_type": "mana",
      "completion_cost": 3,
      "base_effect": "A inizio turno lancia un D10. Se esce almeno 6, ottieni un Mana aggiuntivo.",
      "complete_effect": "A inizio turno ottieni un Mana aggiuntivo.",
      "copies": 4
    }
  ]
}
```

### Stato Partita (Game State JSON)

Questo è il JSON che viene salvato in SQLite a ogni cambio di stato:

```json
{
  "game_id": "abc123",
  "turn": 3,
  "current_player_index": 1,
  "phase": "action",
  "players": [
    {
      "id": "player_1",
      "name": "Marco",
      "lives": 3,
      "mana": 2,
      "mana_remaining": 1,
      "actions_remaining": 2,
      "hand": ["patrizio_3", "ardolancio_1", "estrattore_2"],
      "field": {
        "vanguard": [
          {
            "card_instance_id": "san_patrizio_1",
            "base_card_id": "san_patrizio",
            "evolved_from": "patrizio_1",
            "assigned_cards": [],
            "active_horde_effect": false,
            "temp_modifiers": {}
          }
        ],
        "bastion_left": {
          "walls": ["giulio_4", "random_card_7"],
          "warriors": []
        },
        "bastion_right": {
          "walls": [],
          "warriors": ["reinhold_2"]
        },
        "village": {
          "buildings": [
            {
              "card_instance_id": "estrattore_1",
              "base_card_id": "estrattore",
              "completed": false
            }
          ]
        }
      },
      "active_hordes": [],
      "active_effects": []
    }
  ],
  "deck": ["card_id_1", "card_id_2"],
  "discard_pile": ["card_id_3"],
  "log": [
    {"turn": 1, "player": "player_1", "action": "play_card", "detail": {...}},
    {"turn": 1, "player": "player_1", "action": "battle", "detail": {...}}
  ]
}
```

### Schema SQLite

```sql
CREATE TABLE games (
    game_id TEXT PRIMARY KEY,
    lobby_code TEXT UNIQUE,
    state TEXT NOT NULL,          -- JSON serializzato
    status TEXT DEFAULT 'lobby',  -- lobby | playing | finished
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE players (
    player_id TEXT PRIMARY KEY,
    game_id TEXT REFERENCES games(game_id),
    name TEXT NOT NULL,
    session_token TEXT UNIQUE,
    connected BOOLEAN DEFAULT TRUE
);
```

---

## Regole di Gioco — Riepilogo per il Motore

Questa sezione riassume le regole che il motore deve implementare. I file di riferimento completi sono il regolamento (`Regolamento Ufficiale`) e il database carte (`Carte.xlsx`).

### Setup Partita

- 2-4 giocatori.
- Ogni giocatore inizia con 3 Vite.
- Mazzo comune unico di 200 carte (72 Guerrieri, 68 Magie, 60 Costruzioni).
- Il mazzo viene mescolato. Ogni giocatore pesca 5 carte.
- Si determina casualmente il primo giocatore.

### Turno

Il turno di un giocatore segue questi passi in ordine:

1. **Ricevi Mana** secondo il turno corrente:
   - Turni 1–2: 1 Mana
   - Turni 3–4: 2 Mana
   - Turni 5–6: 3 Mana
   - Turni 7–9: 4 Mana
   - Turni 10+: 5 Mana
2. **Azione 1** (opzionale): Giocare una carta, Completare una Costruzione, Aggiungere un Muro.
3. **Azione 2** (opzionale): idem.
4. **Riposiziona Guerrieri** tra Avanscoperta e Bastioni a piacimento.
5. **Attiva Orde**: per ogni Orda (3 Guerrieri stessa Specie), scegli quale effetto Orda attivare.
6. **Battaglia** (opzionale): attacca un Bastione adiacente di un avversario.
7. **Pesca** fino a 5 carte in mano (o il limite modificato da carte in gioco). Se ne hai già di più, non scarti.

Gli effetti di Costruzioni e Magie si attivano nel momento indicato dalla carta, indipendentemente dai passi.

### Azioni

- **Giocare una carta**: spendi Mana (Guerrieri/Costruzioni) o richiedi Maghe in campo (Magie). Posiziona nelle Regioni appropriate.
- **Completare una Costruzione**: spendi Mana di completamento, ruota la carta da orizzontale a verticale.
- **Aggiungere un Muro**: qualsiasi carta dalla mano diventa un Muro a faccia in giù in un Bastione.

### Carte — Tipologie

#### Guerrieri (Reclute ed Eroi)
- Hanno ATT, GIT, DIF, Specie, Scuola (solo Maghe), linea evolutiva, effetto Orda.
- Le Reclute evolvono in Eroi: l'Eroe si posiziona sopra la Recluta, ereditandone Orda e carte assegnate.
- Se un Eroe viene scartato, la Recluta rimane con le carte assegnate.
- Posizionabili in Avanscoperta (attacco) o Bastioni (difesa).

#### Magie (Anatemi, Sortilegi, Incantesimi)
- Costo in numero di Maghe in campo (non Mana).
- Effetto Base sempre attivo; effetto Prodigio se le Maghe in campo sono della stessa Scuola della Magia.
- Prodigio con `&` iniziale: si aggiunge al Base. Senza `&`: sostituisce il Base.
- Scartate dopo l'uso (salvo eccezioni).

#### Costruzioni
- Costo in Mana. Posizionate in Villaggio.
- Giocate incomplete (orizzontale, effetto Base). Completabili con Azione + Mana (verticale, effetto Completo).

#### Muri
- Qualsiasi carta può diventare Muro (perde ogni altra funzione).
- Compongono i Bastioni. Assorbono Danni in Battaglia.

### Battaglia

1. L'attaccante sceglie un Bastione avversario **adiacente** a uno dei propri.
2. Calcolo valori:
   - Attaccante: max ATT e max GIT tra Guerrieri in Avanscoperta.
   - Difensore: max DIF e max GIT tra Guerrieri nel Bastione bersaglio.
3. Danni:
   - Danno da Attacco = max(ATT_att - DIF_dif, 0)
   - Danno da Gittata = max(GIT_att - GIT_dif, 0)
   - Danno Totale = Danno Attacco + Danno Gittata
4. Risoluzione:
   - Il Bastione perde Muri pari al Danno Totale.
   - Se Danno > 0 ma Muri insufficienti → il difensore perde 1 Vita (danni residui ignorati).

### Orda

- 3 Guerrieri della stessa Specie in campo (qualsiasi Regione).
- A fine turno, il giocatore sceglie quale effetto Orda attivare tra quelli disponibili.
- La carta selezionata va posizionata tra le altre due (segnale visivo).

### Adiacenza Bastioni

I giocatori siedono in circolo. Il Bastione destro di un giocatore è adiacente al Bastione sinistro del giocatore alla sua destra, e viceversa. Un Bastione può attaccare solo un Bastione adiacente.

### Condizione di Vittoria

Ultimo giocatore con almeno 1 Vita.

---

## Database Carte Completo

### Guerrieri (24 carte base → 72 copie totali)

| ID | Nome | Specie | Scuola | Livello | Costo | ATT | GIT | DIF | Copie |
|---|---|---|---|---|---|---|---|---|---|
| patrizio | Patrizio | Elfo | — | Recluta | 2 | 2 | 1 | 2 | 4 |
| san_patrizio | San Patrizio | Elfo | — | Eroe | 2 | 4 | 3 | 3 | 2 |
| reinhold | Reinhold | Nano | — | Recluta | 2 | 2 | 0 | 3 | 4 |
| von_reinhold | Von Reinhold | Nano | — | Eroe | 2 | 5 | 0 | 5 | 2 |
| araminta | Araminta | Maga | Anatemi | Recluta | 2 | 2 | 0 | 2 | 4 |
| araminta_pyric | Araminta, the Pyric | Maga | Anatemi | Eroe | 2 | 4 | 1 | 3 | 2 |
| orfeo | Orfeo | Umano | — | Recluta | 2 | 3 | 0 | 2 | 4 |
| orfeus | Ὀρφεύς | Umano | — | Eroe | 2 | 6 | 1 | 4 | 2 |
| giulio | Giulio | Elfo | — | Recluta | 1 | 1 | 2 | 1 | 4 |
| giulio_ii | Giulio II | Elfo | — | Eroe | 3 | 4 | 4 | 4 | 2 |
| faust | Faust | Nano | — | Recluta | 2 | 2 | 0 | 2 | 4 |
| doctor_faustus | Doctor Faustus | Nano | — | Eroe | 2 | 4 | 0 | 4 | 2 |
| evelyn | Evelyn | Maga | Sortilegi | Recluta | 2 | 1 | 0 | 3 | 4 |
| evelyn_briny | Evelyn, the Briny | Maga | Sortilegi | Eroe | 2 | 3 | 1 | 4 | 2 |
| polemarco | Polemarco | Umano | — | Recluta | 3 | 0 | 0 | 3 | 4 |
| polemarcos | Πολέμαρχος | Umano | — | Eroe | 2 | 0 | 0 | 7 | 2 |
| decimo | Decimo | Elfo | — | Recluta | 2 | 2 | 2 | 1 | 4 |
| pio_decimo | Pio Decimo | Elfo | — | Eroe | 2 | 4 | 4 | 2 | 2 |
| joseph | Joseph | Nano | — | Recluta | 2 | 2 | 0 | 3 | 4 |
| kaiser_joseph | Kaiser Joseph | Nano | — | Eroe | 2 | 4 | 0 | 5 | 2 |
| madeleine | Madeleine | Maga | Incantesimi | Recluta | 2 | 1 | 1 | 2 | 4 |
| madeleine_nemoral | Madeleine, the Nemoral | Maga | Incantesimi | Eroe | 2 | 3 | 2 | 3 | 2 |
| eracle | Eracle | Umano | — | Recluta | 3 | 3 | 1 | 1 | 4 |
| eracles | Ἡρακλῆς | Umano | — | Eroe | 3 | 5 | 2 | 5 | 2 |

### Magie (21 carte base → 68 copie totali)

| ID | Nome | Scuola | Costo (Maghe) | Copie |
|---|---|---|---|---|
| ardolancio | Ardolancio | Anatema | 1 | 4 |
| vitalflusso | Vitalflusso | Sortilegio | 1 | 4 |
| magiscudo | Magiscudo | Incantesimo | 1 | 4 |
| equipotenza | Equipotenza | Anatema | 1 | 4 |
| regicidio | Regicidio | Sortilegio | 1 | 4 |
| agilpesca | Agilpesca | Incantesimo | 1 | 4 |
| guerremoto | Guerremoto | Anatema | 1 | 4 |
| arrampicarta | Arrampicarta | Sortilegio | 1 | 4 |
| investimento | Investimento | Incantesimo | 1 | 3 |
| cuordipietra | Cuordipietra | Anatema | 2 | 3 |
| bastioncontrario | Bastioncontrario | Sortilegio | 2 | 3 |
| divinazione | Divinazione | Incantesimo | 2 | 3 |
| malcomune | Malcomune | Anatema | 2 | 3 |
| telecinesi | Telecinesi | Sortilegio | 2 | 3 |
| cercapersone | Cercapersone | Incantesimo | 2 | 3 |
| incendifesa | Incendifesa | Anatema | 2 | 3 |
| dazipazzi | Dazipazzi | Sortilegio | 2 | 3 |
| plasmattone | Plasmattone | Incantesimo | 2 | 3 |
| cambiamente | Cambiamente | Anatema | 3 | 2 |
| velocemento | Velocemento | Sortilegio | 3 | 2 |
| plasmarmo | Plasmarmo | Incantesimo | 3 | 2 |

### Costruzioni (15 carte base → 60 copie totali)

| ID | Nome | Costo | Costo Completamento | Copie |
|---|---|---|---|---|
| estrattore | Estrattore | 3 | 3 | 4 |
| granaio | Granaio | 3 | 3 | 4 |
| fucina | Fucina | 3 | 3 | 4 |
| biblioteca | Biblioteca | 2 | 2 | 4 |
| ariete | Ariete | 1 | 1 | 4 |
| catapulta | Catapulta | 1 | 1 | 4 |
| saracinesca | Saracinesca | 1 | 1 | 4 |
| sorgiva | Sorgiva | 1 | 4 | 4 |
| arena | Arena | 2 | 2 | 4 |
| fossato | Fossato | 2 | 2 | 4 |
| scrigno | Scrigno | 1 | 3 | 4 |
| obelisco | Obelisco | 1 | 2 | 4 |
| cardo | Cardo | 1 | 0 | 4 |
| decumano | Decumano | 1 | 0 | 4 |
| trono | Trono | 2 | 2 | 4 |

**Totale mazzo: 200 carte.**

---

## Flusso Multiplayer

### Creazione Lobby

1. Un giocatore crea una nuova partita → il server genera un codice lobby (es. `BARB-7X3K`).
2. Il giocatore condivide il codice con gli amici.
3. Gli amici accedono e inseriscono il codice per unirsi.
4. Quando tutti sono pronti, il creatore avvia la partita.
5. Il server genera lo stato iniziale (mescola mazzo, distribuisce carte, sceglie primo giocatore).

### Gestione Turno

1. Il server invia lo stato aggiornato a tutti i giocatori via WebSocket.
2. Ogni giocatore vede il proprio campo completo e i campi avversari (senza mano e Muri a faccia in giù).
3. Il giocatore attivo interagisce via UI → il client invia azioni al server.
4. Il server valida l'azione, aggiorna lo stato, salva in SQLite, notifica tutti.
5. A fine turno il server passa al giocatore successivo.

### Visibilità Informazioni

- **Visibile a tutti**: campo da gioco di ogni giocatore (Guerrieri, Costruzioni, numero di Muri, numero di Vite, numero di carte in mano).
- **Visibile solo al proprietario**: contenuto della propria mano, identità dei propri Muri.
- **Non visibile a nessuno**: ordine del mazzo.

### Gestione Disconnessione

- Se un giocatore si disconnette, il suo turno viene saltato dopo un timeout (es. 120s).
- Il giocatore può riconnettersi con il proprio session token e riprendere.
- Se tutti i giocatori si disconnettono, la partita rimane salvata in SQLite e può essere ripresa.

---

## Piano di Implementazione (Fasi)

### Fase 1 — Motore di gioco (solo Python, nessuna UI)

- Modelli dati (Pydantic): carta, giocatore, stato partita.
- Caricamento `cards.json`.
- Gestione mazzo: shuffle, pesca, scarti, riciclo.
- Logica turno completa: mana, azioni, riposizionamento, pesca.
- Logica Battaglia: calcolo danni, distruzione muri, perdita vite.
- Effetti base delle carte (iniziare dalle più semplici: Ariete, Catapulta, Saracinesca).
- Test unitari per ogni componente.
- **Milestone**: una partita completa simulata in console tra 2 bot casuali.

### Fase 2 — Server e persistenza

- Setup FastAPI con WebSocket.
- Lobby: creazione, join, avvio partita.
- Endpoint per azioni di gioco (validazione server-side).
- WebSocket manager per broadcast stato.
- Persistenza SQLite.
- Autenticazione leggera (session token).
- **Milestone**: due client possono connettersi e giocare una partita via API.

### Fase 3 — Frontend

- Layout campo da gioco (4 Regioni + nucleo centrale).
- Rendering carte (con dati dal JSON, senza immagini per ora).
- Interazione: seleziona carta → scegli dove giocarla.
- Visualizzazione campi avversari (informazioni limitate).
- Connessione WebSocket per aggiornamenti in tempo reale.
- Schermata lobby (crea/join partita).
- Logo (`Logo.png`) nella schermata iniziale.
- **Milestone**: partita completa giocabile da browser.

### Fase 4 — Effetti avanzati e polish

- Implementare tutti gli effetti Orda.
- Implementare tutte le Magie (con Prodigio).
- Implementare tutte le Costruzioni (con effetto Completo).
- Effetti che richiedono interazione (scegliere bersagli, D10).
- Gestione Cardo/Decumano (completamento condizionale).
- Gestione Trono (assegnazione e effetto).
- Log delle azioni visibile ai giocatori.
- **Milestone**: tutte le 60 carte base implementate correttamente.

### Fase 5 — Deploy, tutorial e QA

- Configurazione Render (web service Python).
- File statici serviti da FastAPI (`/frontend/*`).
- Tutorial interattivo: partita guidata contro avversario fittizio con stato preconfigurato, che introduce giocare carte, completare costruzioni, aggiungere muri e battaglia.
- Test con amici reali.
- Fix bug e bilanciamento UX.
- **Milestone**: gioco live e giocabile online, con tutorial per nuovi giocatori.

---

## Note Tecniche Aggiuntive

### Effetti delle Carte — Strategia di Implementazione

Gli effetti delle carte sono la parte più complessa. Si suggerisce un approccio a **registry pattern**:

```python
# engine/effects.py

EFFECT_REGISTRY = {}

def register_effect(card_id: str):
    def decorator(func):
        EFFECT_REGISTRY[card_id] = func
        return func
    return decorator

@register_effect("ariete")
def ariete_effect(game_state, player, card, completed: bool):
    if completed:
        player.battle_modifiers["att"] += 2
    else:
        player.battle_modifiers["att"] += 1

@register_effect("ardolancio")
def ardolancio_effect(game_state, player, target_bastion, prodigy: bool):
    damage = 4 if prodigy else 2
    apply_damage_to_bastion(game_state, target_bastion, damage)
```

Ogni effetto è una funzione registrata per ID carta. Questo permette di implementarli incrementalmente e testarli in isolamento.

### Timer per Turno

Il server traccia il tempo rimanente per ogni turno. Se il timer è attivo (default: 120s, configurabile in lobby):

```python
# server/ws_manager.py — logica concettuale
async def start_turn_timer(game_id: str, player_id: str, seconds: int = 120):
    await asyncio.sleep(seconds)
    # Se il giocatore non ha ancora finito il turno, forzalo
    game = load_game(game_id)
    if game.current_player.id == player_id:
        game.end_turn()  # azioni non spese vanno perse
        save_game(game)
        await broadcast_state(game_id)
```

Il client mostra un countdown visuale. A 15 secondi un avviso visivo.

### Animazioni Frontend

Approccio minimalista con sole transizioni CSS:

- `transition` su carte che appaiono/scompaiono (`opacity`, `transform`).
- Flash rosso breve sul Bastione che subisce danni.
- Slide orizzontale per spostamento Guerrieri tra Regioni.
- Fade per cambio turno.
- Nessuna animazione particellare, nessuna libreria di animazione esterna.

### D10

Alcune carte richiedono il lancio di un D10. Il server genera il risultato (`random.randint(1, 10)`) e lo include nel log, garantendo che sia determinato lato server e visibile a tutti.

### Adiacenza tra Giocatori

I giocatori sono disposti in un cerchio logico. L'adiacenza si calcola così:

```python
def adjacent_bastions(player_index: int, num_players: int):
    right_neighbor = (player_index + 1) % num_players
    left_neighbor = (player_index - 1) % num_players
    return {
        "my_right_bastion_attacks": (right_neighbor, "left"),
        "my_left_bastion_is_attacked_by": (left_neighbor, "right"),
    }
```

Il Bastione destro del giocatore X è adiacente al Bastione sinistro del giocatore X+1 (seduto alla sua destra).

### Validazione Server-Side

Tutte le azioni sono validate dal server. Il client invia l'intenzione (es. "gioco carta X in Avanscoperta"), il server verifica:
- È il turno del giocatore?
- Ha azioni rimanenti?
- Ha Mana/Maghe sufficienti?
- La carta è nella sua mano?
- Il posizionamento è legale?

Se la validazione fallisce, il server rifiuta e invia un errore. Il client non modifica mai lo stato localmente.

---

## File di Riferimento Disponibili

I seguenti file sono accessibili a Claude Code e possono essere referenziati durante lo sviluppo:

| File | Contenuto | Uso |
|---|---|---|
| `Regolamento Ufficiale` | Regolamento completo di Barbacane (Google Doc) | Riferimento per ogni dubbio sulle regole |
| `Carte.xlsx` | Database completo di tutte le carte (Google Sheet) | Sorgente per generare `cards.json` |
| `Logo.png` | Logo del gioco | Schermata iniziale, favicon, header |

---

## Decisioni Finali

| Tema | Decisione |
|---|---|
| **Numero giocatori** | 2–4 giocatori. La lobby richiede almeno 2 giocatori per avviare e ne accetta massimo 4. |
| **Timer per turno** | 120 secondi per turno, disattivabile dal creatore della lobby nelle impostazioni pre-partita. Allo scadere il turno viene passato automaticamente (le azioni non spese vanno perse). |
| **Spettatori** | Non supportati. Solo i giocatori che hanno fatto join nella lobby possono accedere alla partita. |
| **Immagini carte** | No. Le carte sono renderizzate interamente a testo/CSS. Nessuna illustrazione, nessun asset grafico per le carte. |
| **Tutorial in-game** | Sì. Implementare un tutorial interattivo che guidi il giocatore attraverso le meccaniche base: giocare carte, completare costruzioni, aggiungere muri, battaglia. Il tutorial si gioca contro un avversario fittizio con stato preconfigurato. Da implementare nella Fase 5 (dopo il deploy base). |
| **Animazioni** | Minimaliste. Transizioni CSS leggere per: comparsa/scomparsa carte, spostamento tra regioni, esito battaglia (flash danno), cambio turno. Nessuna animazione elaborata o particellare. Priorità a chiarezza e reattività. |