# Barbacane — Specifica di Progetto

## Panoramica

Barbacane è un gioco di carte da tavolo ambientato in un mondo fantasy popolato da Umani, Elfi, Nani e Maghe (tutti di sangue Goblin). Versione digitale multiplayer online, giocabile da browser.

Il gioco è a turni: ogni giocatore posiziona carte (Guerrieri, Magie, Costruzioni) su un campo diviso in 4 Regioni (Avanscoperta, Bastione sinistro, Bastione destro, Villaggio). Vince l'ultimo giocatore con almeno una Vita rimasta.

---

## Asset di Riferimento

| File | Contenuto |
|---|---|
| `assets/rules.md` | Regolamento completo — fonte autoritativa per ogni dubbio sulle regole |
| `assets/cards.xlsx` | Database completo di tutte le carte — fonte per aggiornare `data/cards.json` |
| `assets/logo.png` | Logo del gioco — schermata iniziale, favicon, header |
| `assets/cards_raw.json` | Raw export da `cards.xlsx` usato per generare `data/cards.json` |
| `data/cards.json` | Database carte in uso dal motore di gioco |
| `data/rules_config.json` | Parametri di gioco (mana per turno, vite iniziali, ecc.) |

---

## Stack Tecnologico

- **Backend**: Python + FastAPI, WebSocket per aggiornamenti real-time
- **Frontend**: Single Page Application in vanilla JS, servita come file statico da FastAPI
- **Persistenza**: SQLite (file `.db` locale, perfetto per gioco a turni)
- **Deploy**: Render (free tier, supporta WebSocket, deploy da GitHub; cold start ~30s accettabile)

---

## Architettura del Progetto

```
barbacane/
├── README.md
├── requirements.txt
├── render.yaml                  # Config deploy Render
├── main.py                      # Entry point FastAPI
├── assets/
│   ├── logo.png
│   ├── rules.md                 # Regolamento completo
│   ├── cards.xlsx               # Database carte sorgente
│   └── cards_raw.json           # Raw export da cards.xlsx
├── data/
│   ├── cards.json               # Database carte (generato da cards.xlsx)
│   └── rules_config.json        # Parametri di gioco
├── engine/
│   ├── __init__.py
│   ├── models.py                # Pydantic models per carte, giocatori, stato
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
│       └── logo.png
└── tests/
    ├── test_game.py
    ├── test_battle.py
    └── test_effects.py
```

---

## Modello Dati

### `cards.json` — struttura

```json
{
  "warriors": [
    {
      "id": "patrizio", "name": "Patrizio", "type": "warrior", "subtype": "recruit",
      "species": "elfo", "school": null, "cost": 2, "cost_type": "mana",
      "att": 2, "git": 1, "dif": 2,
      "horde_effect": "Questa carta ottiene +2 GIT.",
      "evolves_from": null, "evolves_into": "san_patrizio", "copies": 4
    }
  ],
  "spells": [
    {
      "id": "ardolancio", "name": "Ardolancio", "type": "spell", "subtype": "anatema",
      "school": "anatema", "cost": 1, "cost_type": "maga",
      "base_effect": "Infliggi 2 Danni a un Bastione a tua scelta.",
      "prodigy_effect": "Infliggi 4 Danni a un Bastione a tua scelta.",
      "prodigy_is_additive": false, "effect_id": "ardolancio_effect", "copies": 4
    }
  ],
  "buildings": [
    {
      "id": "estrattore", "name": "Estrattore", "type": "building",
      "cost": 3, "cost_type": "mana", "completion_cost": 3,
      "base_effect": "A inizio turno lancia un D10. Se esce almeno 6, ottieni un Mana aggiuntivo.",
      "complete_effect": "A inizio turno ottieni un Mana aggiuntivo.",
      "complete_is_additive": false, "effect_id": "estrattore_effect", "copies": 4
    }
  ]
}
```

### Convenzione `&` negli effetti

Sia per le Magie (`prodigy_effect`) che per le Costruzioni (`complete_effect`), un testo che inizia con `&` indica che l'effetto **si aggiunge** a quello Base invece di sostituirlo. Questo è codificato nei campi booleani `prodigy_is_additive` e `complete_is_additive` in `cards.json`.

### Stato Partita (Game State JSON)

Salvato in SQLite a ogni cambio di stato significativo:

```json
{
  "game_id": "abc123",
  "turn": 3,
  "current_player_index": 1,
  "phase": "action",
  "players": [
    {
      "id": "player_1", "name": "Marco",
      "lives": ["card_id_x", "card_id_y", "card_id_z"],
      "mana": 2, "mana_remaining": 1, "actions_remaining": 2,
      "hand": ["patrizio_3", "ardolancio_1", "estrattore_2"],
      "field": {
        "vanguard": [
          {
            "card_instance_id": "san_patrizio_1", "base_card_id": "san_patrizio",
            "evolved_from": "patrizio_1", "assigned_cards": [],
            "active_horde_effect": false, "temp_modifiers": {}
          }
        ],
        "bastion_left": { "walls": ["giulio_4", "random_card_7"], "warriors": [] },
        "bastion_right": { "walls": [], "warriors": ["reinhold_2"] },
        "village": {
          "buildings": [
            { "card_instance_id": "estrattore_1", "base_card_id": "estrattore", "completed": false }
          ]
        }
      },
      "active_hordes": [], "active_effects": []
    }
  ],
  "deck": ["card_id_1", "card_id_2"],
  "discard_pile": ["card_id_3"],
  "log": [
    {"turn": 1, "player": "player_1", "action": "play_card", "detail": {}}
  ]
}
```

**Nota**: `lives` è una lista di `card_instance_id` di carte casuali pescate dal mazzo durante il setup, posizionate a faccia in giù in Villaggio. Ogni Vita persa = una carta rimossa dalla lista.

### Schema SQLite

```sql
CREATE TABLE games (
    game_id TEXT PRIMARY KEY,
    lobby_code TEXT UNIQUE,
    state TEXT NOT NULL,
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

## Regole di Gioco

Per il regolamento completo consultare `assets/rules.md`. Questa sezione riassume le regole chiave per il motore.

### Setup Partita

- 2–4 giocatori. Ogni giocatore inizia con 3 Vite.
- Le Vite sono 3 carte casuali pescate dal mazzo durante il setup, posizionate a faccia in giù in Villaggio dietro al nucleo.
- Mazzo comune unico di 200 carte (72 Guerrieri, 68 Magie, 60 Costruzioni). Mescolato. Ogni giocatore pesca 6 carte.
- Primo giocatore determinato casualmente.

### Turno

1. **Ricevi Mana**: turni 1–2 → 1; 3–4 → 2; 5–6 → 3; 7–9 → 4; 10+ → 5
2. **Azione 1** (opzionale): Giocare una carta, Completare una Costruzione, o Aggiungere fino a 3 Muri
3. **Azione 2** (opzionale): idem
4. **Riposiziona Guerrieri** tra Avanscoperta e Bastioni a piacimento
5. **Attiva Orde**: per ogni Orda (3 Guerrieri stessa Specie stessa Regione), scegli quale effetto Orda attivare; la carta scelta si posiziona tra le altre due
6. **Battaglia** (opzionale): attacca un Bastione avversario adiacente; richiede almeno un Guerriero in Avanscoperta
7. **Pesca** fino a 6 carte in mano (o limite modificato da carte); se ne hai già di più non scarti

Gli effetti di Costruzioni e Magie si attivano nel momento indicato dalla carta, indipendentemente dai passi.

Se il mazzo si esaurisce, la pila degli scarti viene mescolata e diventa il nuovo mazzo.

### Azioni

- **Giocare una carta**: spendi Mana (Guerrieri/Costruzioni) o richiedi Maghe in campo (Magie). Posiziona nella Regione appropriata.
- **Completare una Costruzione**: spendi il Mana di completamento, ruota da orizzontale a verticale.
- **Aggiungere fino a 3 Muri**: scegli 1–3 carte dalla mano, convertile in Muri a faccia in giù nei Bastioni in qualsiasi combinazione (es. 3+0, 2+1). Tutta l'operazione consuma 1 sola Azione.

### Carte — Tipologie

#### Guerrieri (Reclute ed Eroi)
- Hanno ATT, GIT, DIF, Specie, Scuola (solo Maghe), linea evolutiva, effetto Orda.
- Le Reclute evolvono in Eroi: l'Eroe si posiziona sopra la Recluta, ereditandone Orda e carte assegnate.
- Se un **Eroe** viene scartato, la Recluta rimane in gioco con le sue carte assegnate.
- Se una **Recluta** con carte assegnate viene scartata, anche le carte assegnate vengono scartate.
- Posizionabili in Avanscoperta (attacco) o Bastioni (difesa).

#### Magie (Anatemi, Sortilegi, Incantesimi)
- Costo in numero di Maghe in campo (non Mana).
- Effetto Base sempre attivo; effetto Prodigio se le Maghe in campo sono della stessa Scuola della Magia.
- `prodigy_effect` con `&` iniziale → `prodigy_is_additive: true` → si aggiunge al Base.
- Scartate dopo l'uso (salvo eccezioni).

#### Costruzioni
- Costo in Mana. Posizionate in Villaggio (salvo diversa indicazione).
- Giocate incomplete (orizzontale, effetto Base). Completabili con Azione + Mana (verticale, effetto Completo).
- `complete_effect` con `&` iniziale → `complete_is_additive: true` → si aggiunge al Base.

#### Muri
- Qualsiasi carta può diventare Muro (perde ogni altra funzione).
- Compongono i Bastioni. Assorbono Danni in Battaglia.

### Battaglia

1. Attaccante sceglie un Bastione avversario **adiacente** a uno dei propri.
2. Calcolo valori:
   - Attaccante: max ATT e max GIT tra Guerrieri in Avanscoperta
   - Difensore: max DIF e max GIT tra Guerrieri nel Bastione bersaglio
3. Danni:
   - Danno da Attacco = max(ATT_att − DIF_dif, 0)
   - Danno da Gittata = max(GIT_att − GIT_dif, 0)
   - Danno Totale = somma dei due
4. Il Bastione perde Muri pari al Danno Totale. Se Danno > 0 ma Muri insufficienti → difensore perde 1 Vita (danni residui ignorati).

**Danno diretto da carte**: alcune carte infliggono Danni direttamente a un Bastione. In quel caso i Guerrieri presenti nel Bastione bersaglio vengono ignorati per il calcolo — il Danno si applica ai Muri seguendo le stesse regole della Battaglia normale.

### Orda

- 3 Guerrieri della stessa Specie nella stessa Regione.
- A fine turno, il giocatore sceglie quale effetto Orda attivare tra quelli disponibili.
- Se l'Orda aveva già un effetto attivo, esso viene prima disattivato.

### Adiacenza Bastioni

I giocatori siedono in circolo. Il Bastione destro del giocatore X è adiacente al Bastione sinistro del giocatore X+1. Un Bastione può attaccare solo un Bastione adiacente.

```python
def adjacent_bastions(player_index: int, num_players: int):
    right_neighbor = (player_index + 1) % num_players
    left_neighbor = (player_index - 1) % num_players
    return {
        "my_right_bastion_attacks": (right_neighbor, "left"),
        "my_left_bastion_is_attacked_by": (left_neighbor, "right"),
    }
```

### Meccaniche Speciali

- **cercare**: guardare il mazzo, prendere la carta specificata se presente, poi mescolare. Non si può cercare da Bastioni o Vite salvo diversa indicazione.
- **assegnare**: carte posizionate sotto un Guerriero. Non spostabili. Seguono le regole di scarto del Guerriero.
- **D10**: generato lato server (`random.randint(1, 10)`), incluso nel log, visibile a tutti.

### Condizione di Vittoria

Ultimo giocatore con almeno 1 Vita.

---

## Flusso Multiplayer

### Creazione Lobby

1. Giocatore crea partita → server genera codice lobby (es. `BARB-7X3K`)
2. Gli altri si uniscono con il codice
3. Il creatore avvia → server genera stato iniziale (mescola mazzo, distribuisce carte e Vite, sceglie primo giocatore)

### Gestione Turno

1. Server invia stato aggiornato a tutti via WebSocket
2. Ogni giocatore vede il proprio campo completo e i campi avversari (senza mano e senza identità di Muri/Vite)
3. Giocatore attivo invia azioni → server valida, aggiorna stato, salva in SQLite, notifica tutti
4. Fine turno → server passa al giocatore successivo

### Visibilità Informazioni

- **Visibile a tutti**: campo da gioco (Guerrieri, Costruzioni, numero di Muri, numero di Vite, numero di carte in mano)
- **Visibile solo al proprietario**: contenuto della propria mano, identità dei propri Muri e delle proprie Vite
- **Non visibile a nessuno**: ordine del mazzo

### Gestione Disconnessione

- Turno saltato dopo timeout di 120s se il giocatore non risponde
- Riconnessione possibile con session token
- Partita resta salvata in SQLite se tutti si disconnettono

---

## Piano di Implementazione (Fasi)

### Fase 1 — Motore di gioco (solo Python, nessuna UI)
- Modelli Pydantic: carta, giocatore, stato partita
- Caricamento `cards.json`
- Gestione mazzo: shuffle, pesca, scarti, riciclo
- Logica turno completa: mana, azioni, riposizionamento, pesca
- Logica Battaglia: calcolo danni, distruzione muri, perdita vite
- Effetti base (iniziare da: Ariete, Catapulta, Saracinesca)
- Test unitari per ogni componente
- **Milestone**: partita completa simulata in console tra 2 bot casuali

### Fase 2 — Server e persistenza
- FastAPI + WebSocket
- Lobby: creazione, join, avvio
- Endpoint azioni di gioco (validazione server-side)
- WebSocket manager per broadcast stato
- Persistenza SQLite + autenticazione leggera (session token)
- **Milestone**: due client possono giocare una partita via API

### Fase 3 — Frontend
- Layout campo da gioco (4 Regioni + nucleo centrale)
- Rendering carte (testo/CSS, senza immagini)
- Interazione: seleziona carta → scegli dove giocarla
- Visualizzazione campi avversari (informazioni limitate)
- Connessione WebSocket per aggiornamenti in tempo reale
- Schermata lobby (crea/join partita) con `logo.png`
- **Milestone**: partita completa giocabile da browser

### Fase 4 — Effetti avanzati e polish
- Tutti gli effetti Orda
- Tutte le Magie (con Prodigio)
- Tutte le Costruzioni (con effetto Completo)
- Effetti con interazione (scegliere bersagli, D10)
- Gestione Cardo/Decumano (completamento condizionale)
- Gestione Trono (assegnazione e effetto)
- Log delle azioni visibile ai giocatori
- **Milestone**: tutte le 60 carte base implementate correttamente

### Fase 5 — Deploy, tutorial e QA
- Configurazione Render (web service Python)
- File statici serviti da FastAPI (`/frontend/*`)
- Tutorial interattivo contro avversario fittizio (stato preconfigurato): giocare carte, completare costruzioni, aggiungere muri, battaglia
- Test con amici reali + fix bug
- **Milestone**: gioco live e giocabile online con tutorial

---

## Note Tecniche

### Effetti delle Carte — Registry Pattern

```python
EFFECT_REGISTRY = {}

def register_effect(card_id: str):
    def decorator(func):
        EFFECT_REGISTRY[card_id] = func
        return func
    return decorator

@register_effect("ariete")
def ariete_effect(game_state, player, card, completed: bool):
    player.battle_modifiers["att"] += 2 if completed else 1
```

### Timer per Turno

120s per turno (disattivabile dal creatore in lobby). Allo scadere il server forza la fine del turno. Il client mostra countdown con avviso visivo a 15s.

### Animazioni Frontend

Transizioni CSS leggere: comparsa/scomparsa carte, spostamento tra regioni, flash danno su Bastione, fade cambio turno. Nessuna libreria di animazione esterna.

### Validazione Server-Side

Il client invia solo intenzioni; il server valida tutto (turno, azioni rimanenti, mana/maghe, carta in mano, posizionamento legale). Il client non modifica mai lo stato localmente.

---

## Decisioni Finali

| Tema | Decisione |
|---|---|
| **Numero giocatori** | 2–4. Lobby richiede almeno 2, accetta massimo 4. |
| **Timer per turno** | 120s, disattivabile in lobby. Allo scadere il turno passa automaticamente. |
| **Spettatori** | Non supportati. |
| **Immagini carte** | No. Carte renderizzate interamente a testo/CSS. |
| **Tutorial in-game** | Sì, implementato in Fase 5 contro avversario fittizio con stato preconfigurato. |
| **Animazioni** | Minimaliste. Transizioni CSS. Nessuna libreria esterna. |
