# Barbacane — Specifica di Progetto

## Panoramica

Barbacane è un gioco di carte da tavolo ambientato in un mondo fantasy popolato da Umani, Elfi, Nani e Maghe (tutti di sangue Goblin). Versione digitale multiplayer online, giocabile da browser.

Il gioco è a turni: ogni giocatore posiziona carte (Guerrieri, Magie, Costruzioni) su un campo diviso in 4 Regioni (Avanscoperta, Bastione sinistro, Bastione destro, Villaggio). Vince l'ultimo giocatore con almeno una Vita rimasta.

---

## File di Riferimento

| File | Contenuto |
|---|---|
| `assets/rules.md` | Regolamento completo — fonte autoritativa per ogni dubbio sulle regole |
| `assets/logo.png` | Logo del gioco |
| `data/cards.json` | Database carte — fonte diretta per il motore di gioco, editabile manualmente |
| `data/rules_config.json` | Parametri di gioco (mana per turno, vite iniziali, ecc.) |
| `data/test_cards.json` | Carte che compaiono in cima al mazzo per il giocatore "Test" (modalità debug) |

---

## Stack Tecnologico

- **Backend**: Python + FastAPI, WebSocket per aggiornamenti real-time
- **Frontend**: SPA in vanilla JS, servita come file statico da FastAPI
- **Persistenza**: SQLite (file `.db` locale)
- **Deploy**: Render (free tier, supporta WebSocket, deploy da GitHub; cold start ~30s accettabile)

---

## Architettura del Progetto

```
barbacane/
├── main.py                      # Entry point FastAPI; monta router e serve /frontend
├── assets/
│   ├── logo.png
│   └── rules.md                 # Regolamento completo
├── data/
│   ├── cards.json               # Database carte (fonte diretta, editare qui)
│   ├── rules_config.json        # Parametri di gioco
│   └── test_cards.json          # Carte di test per il giocatore "Test"
├── engine/
│   ├── models.py                # Pydantic models: carte, istanze, giocatori, GameState
│   ├── game.py                  # Logica turno: _begin_turn, end_turn, public_state, bot
│   ├── cards.py                 # CARD_REGISTRY: carica cards.json, espone get_card()
│   ├── battle.py                # Risoluzione Battaglia, apply_damage_to_bastion
│   ├── effects.py               # EFFECT_REGISTRY: tutti gli effetti carte/orda
│   ├── actions.py               # Azioni turno: play_warrior/spell/building, add_wall, ecc.
│   └── deck.py                  # build_deck, draw_cards, make_*_instance
├── server/
│   ├── lobby.py                 # create_lobby, join_lobby, start_game
│   ├── ws_manager.py            # WebSocket manager: broadcast, send_to_player, timer
│   └── routes.py                # Endpoint REST + WebSocket; _dispatch_action
├── db/
│   └── storage.py               # save_game, load_game (SQLite)
└── frontend/
    ├── index.html
    ├── style.css
    ├── app.js                   # UI principale: gestione stato, modali, azioni
    ├── ws.js                    # Client WebSocket
    └── renderer.js              # Rendering campo da gioco
```

---

## Come Interagiscono le Parti

**Azione del giocatore (es. gioca Plasmattone):**

1. `app.js` costruisce un oggetto `{action: "play_spell", params: {instance_id: "...", bastion_side: "left"}}` e lo invia via WebSocket.
2. `routes.py` → `_dispatch_action()` riceve il messaggio, identifica l'azione, chiama `play_spell(state, player_id, instance_id, **params)`.
3. `actions.py` → `play_spell()` valida (turno, mana, maghe), rimuove la carta dalla mano, chiama `apply_effect(card.effect_id, state, player, prodigy=..., **params)`.
4. `effects.py` → la funzione registrata (es. `plasmattone_effect`) modifica lo stato e ritorna un dict risultato.
5. `routes.py` salva il nuovo stato su SQLite, chiama `public_state(state, player_id)` per ogni giocatore connesso e fa broadcast via WebSocket.
6. `ws.js` riceve il messaggio e chiama `app.js` → `applyState()`, che aggiorna la UI.

**Effetti a inizio/fine turno**: `game.py` → `_begin_turn()` chiama `_trigger_building_start()` (estrattore, biblioteca, fucina), `_process_deferred_effects()` (investimento, divinazione). `end_turn()` chiama `_trigger_building_end()` (granaio) e `draw_cards()`.

**Interazioni asincrone** (cerca, biblioteca): l'effetto imposta `state.pending_search` o aggiunge a `state.pending_interactions`. Il client riceve lo stato con il pending e invia un'azione separata (`resolve_search`, `resolve_biblioteca`) per completarlo.

---

## Modello Dati

### `cards.json` — struttura

```json
{
  "warriors": [{
    "id": "patrizio", "name": "Patrizio", "type": "warrior", "subtype": "recruit",
    "species": "elfo", "school": null, "cost": 2, "cost_type": "mana",
    "att": 2, "git": 1, "dif": 2,
    "horde_effect": "Questa carta ottiene +2 GIT.",
    "horde_effect_id": "patrizio_horde",
    "evolves_from": null, "evolves_into": "san_patrizio", "copies": 4
  }],
  "spells": [{
    "id": "ardolancio", "name": "Ardolancio", "type": "spell", "subtype": "anatema",
    "school": "anatema", "cost": 1, "cost_type": "maga",
    "base_effect": "Infliggi 2 Danni a un Bastione a tua scelta.",
    "prodigy_effect": "Infliggi 4 Danni a un Bastione a tua scelta.",
    "prodigy_is_additive": false, "effect_id": "ardolancio_effect", "copies": 4
  }],
  "buildings": [{
    "id": "estrattore", "name": "Estrattore", "type": "building",
    "cost": 3, "cost_type": "mana", "completion_cost": 3,
    "base_effect": "A inizio turno lancia un D10. Se ≥6, ottieni 1 Mana.",
    "complete_effect": "A inizio turno ottieni 1 Mana.",
    "complete_is_additive": false, "effect_id": "estrattore_effect",
    "auto_complete": false, "copies": 4
  }]
}
```

**Convenzione `&`**: se `prodigy_effect` o `complete_effect` inizia con `&`, l'effetto si aggiunge al Base invece di sostituirlo → campo booleano `prodigy_is_additive` / `complete_is_additive: true`.

**`auto_complete`**: solo Cardo e Decumano hanno `auto_complete: true` — vengono completati automaticamente al momento del piazzamento.

### Modelli Python (`engine/models.py`)

**`WallInstance`**: `instance_id`, `base_card_id`, `durability: int = 1`  
**`WarriorInstance`**: `instance_id`, `base_card_id`, `evolved_from`, `assigned_cards: List[str]`, `horde_active: bool`, `temp_modifiers: Dict[str, int]`  
**`BuildingInstance`**: `instance_id`, `base_card_id`, `completed: bool`, `assigned_warrior`  
**`Bastion`**: `walls: List[WallInstance]`, `warriors: List[WarriorInstance]`, `dif_bonus: int`  
**`PlayerField`**: `vanguard`, `bastion_left`, `bastion_right`, `village`

**`Player`** (campi rilevanti):
```python
life_cards: List[str]        # instance_ids delle carte-vita (len = vite rimanenti)
mana: int                    # mana assegnato questo turno
mana_remaining: int          # mana ancora spendibile
actions_remaining: int       # azioni rimaste (di solito 2)
hand: List[str]              # instance_ids in mano
field: PlayerField
active_effects: List[Dict]   # effetti temporanei attivi
ethereal_card: Optional[str] # instance_id della carta eterea (gratis, 0 azioni)
hordes_activated_this_turn: List[str]  # "{zone}:{species}" già attivate
```

**`GameState`** (campi rilevanti):
```python
turn: int
current_player_index: int
phase: str                   # "action" | "reposition" | "horde" | "battle" | "draw" | "end"
players: List[Player]
deck: List[str]              # instance_ids nel mazzo
discard_pile: List[str]
winner_id: Optional[str]
battles_remaining: int       # default 1; può aumentare (Orda Eracle)
recent_events: List[Dict]    # D10 rolls, azzerati a ogni azione
pending_search: Optional[Dict]          # effetto "cerca" in attesa di risposta
pending_interactions: List[Dict]        # coda interazioni biblioteca
turn_timer: int              # secondi; 0 = disattivato
```

### Instance ID

Ogni copia di carta ha un `instance_id` univoco (es. `"patrizio_3"`) composto da `{base_card_id}_{numero}`. `get_base_card_id(instance_id)` estrae il `base_card_id`; `CARD_REGISTRY[base_card_id]` ritorna la definizione statica della carta.

### Schema SQLite

```sql
CREATE TABLE games (
    game_id TEXT PRIMARY KEY,
    lobby_code TEXT UNIQUE,
    state TEXT NOT NULL,           -- GameState serializzato come JSON
    status TEXT DEFAULT 'lobby',   -- lobby | playing | finished
    created_at TIMESTAMP, updated_at TIMESTAMP
);
CREATE TABLE players (
    player_id TEXT PRIMARY KEY, game_id TEXT, name TEXT,
    session_token TEXT UNIQUE, connected BOOLEAN DEFAULT TRUE
);
```

---

## Regole di Gioco

Per il regolamento completo consultare `assets/rules.md`.

### Setup

- 2–4 giocatori. Ogni giocatore inizia con 3 Vite (carte casuali pescate dal mazzo, a faccia in giù in Villaggio).
- Mazzo comune da 200 carte. Ogni giocatore pesca 6 carte. Primo giocatore scelto casualmente.

### Turno

1. **Ricevi Mana**: turni 1–2 → 1; 3–4 → 2; 5–6 → 3; 7–9 → 4; 10+ → 5
2. **Azione 1** (opzionale): giocare una carta / completare costruzione / aggiungere fino a 3 muri
3. **Azione 2** (opzionale): idem
4. **Riposiziona Guerrieri** tra Avanscoperta e Bastioni (gratuito)
5. **Attiva Orde**: per ogni Orda disponibile, scegli quale effetto attivare
6. **Battaglia** (opzionale): attacca un Bastione avversario adiacente
7. **Pesca** fino a 6 carte in mano

Se il mazzo si esaurisce, la pila degli scarti viene mescolata e diventa il nuovo mazzo.

### Azioni che consumano 1 Azione

| Azione | Funzione |
|---|---|
| Gioca Guerriero | `play_warrior()` — costo Mana |
| Gioca Magia | `play_spell()` — costo Maghe in campo |
| Gioca Costruzione | `play_building()` — costo Mana |
| Completa Costruzione | `complete_building()` — costo Mana completamento |
| Aggiungi Muri (1–3) | `add_wall()` — nessun costo Mana |
| Evolvi Guerriero | `evolve_warrior()` — costo Mana dell'Eroe |

### Operazioni gratuite (non consumano Azione)

`reposition_warrior`, `activate_horde`, `battle`, `discard_card`, `retrieve_wall`, `discard_wall`, `arena_activate`, `recast_spell` (Evelyn), `eracle_destroy`

### Tipologie di Carte

**Guerrieri** (Reclute ed Eroi): ATT, GIT, DIF, Specie, Scuola (solo Maghe), effetto Orda. Reclute evolvono in Eroi. Se un Eroe viene scartato, la Recluta torna in campo con le carte assegnate. Se viene scartata una Recluta, anche le carte assegnate vanno negli scarti.

**Magie** (Anatemi, Sortilegi, Incantesimi): costo in Maghe, non Mana. Prodigio attivo se le Maghe in campo della stessa Scuola sono ≥ costo. Scartate dopo l'uso (salvo Araminta/Obelisco).

**Costruzioni**: costo Mana. Piazzate incomplete (effetto Base). Completabili con Azione + Mana (effetto Completo).

**Muri**: qualsiasi carta può diventare Muro (perde ogni altra funzione). Assorbono danni in Battaglia.

### Battaglia

1. Attaccante sceglie un Bastione adiacente (o qualsiasi con Guerremoto).
2. ATT_att e GIT_att = massimi tra i Guerrieri in Avanscoperta; DIF_dif e GIT_dif = massimi tra i Guerrieri nel Bastione bersaglio.
3. Danno Totale = max(ATT_att − DIF_dif, 0) + max(GIT_att − GIT_dif, 0).
4. Il Bastione perde Muri pari al Danno. Se Danno > 0 e Muri insufficienti → il difensore perde 1 Vita.

**Danno diretto da carte**: bypassa i Guerrieri difensori e si applica direttamente ai Muri.

### Orda

3 Guerrieri della stessa Specie nella stessa Regione. Il giocatore sceglie quale effetto Orda attivare. Ogni Orda (zona + specie) può essere attivata una sola volta per turno. Tracciata in `player.hordes_activated_this_turn`.

### Meccaniche Speciali

- **cercare**: guarda il mazzo, prendi la carta specificata se presente, poi mescola. Implementato con `state.pending_search`.
- **assegnare**: carte posizionate sotto un Guerriero (`assigned_cards`). Non spostabili. Seguono le regole di scarto del Guerriero.
- **D10**: `random.randint(1, 10)`, incluso in `state.recent_events`, visibile a tutti.

### Adiacenza Bastioni

I giocatori siedono in circolo. Il Bastione destro del giocatore X è adiacente al Bastione sinistro del giocatore X+1.

---

## Meccanica Carta Eterea

Alcune carte (es. Plasmarmo prodigio) possono rendere una carta in mano **eterea**: giocabile una volta senza pagarne il costo in Mana/Maghe e senza consumare Azioni.

**Implementazione**:

- `Player.ethereal_card: Optional[str]` — `instance_id` della carta eterea corrente.
- In `play_warrior`, `play_spell`, `play_building`: se `player.ethereal_card == instance_id`, salta `_require_actions()` e setta il costo a 0. Dopo il gioco, `player.ethereal_card = None`.
- La carta eterea ha bordo bianco nel frontend (classe CSS `.card.ethereal`) e mostra il costo come "0".
- Il pulsante "Gioca" appare anche con 0 azioni rimanenti se la carta è eterea.

**Quando l'eteri viene azzerato** (`server/routes.py` → `_ETHEREAL_BREAKING`): solo su azioni che rappresentano mosse di gioco reali (`play_warrior`, `play_spell`, `play_building`, `complete_building`, `add_wall`, `evolve`, `battle`, `end_turn`). Azioni gratuite come `discard`, `reposition`, `activate_horde` **non** azzerano l'eterea.

---

## Effetti delle Carte

### Registry Pattern

```python
EFFECT_REGISTRY: Dict[str, Callable] = {}

def register_effect(effect_id: str):
    def decorator(func):
        EFFECT_REGISTRY[effect_id] = func
        return func
    return decorator

@register_effect("ardolancio_effect")
def ardolancio_effect(state, player, prodigy=False, target_player_id=None, ...):
    damage = 4 if prodigy else 2
    ...
```

`apply_effect(effect_id, state, player, **kwargs)` in `effects.py` cerca nel registry e chiama la funzione.

### Firme per tipo

- **Costruzioni**: `(state, player, completed: bool, **kwargs)`
- **Magie**: `(state, player, prodigy: bool, **kwargs)` — kwargs contiene targeting (target_player_id, target_bastion_side, ecc.)
- **Orde**: `(state, player, warrior_iid=None, **kwargs)`

### Quando vengono triggerati

| Momento | Chi chiama | Cosa |
|---|---|---|
| Al gioco della carta | `actions.py` | Magie (immediato) |
| Al piazzamento Costruzione | `actions.py` | Cardo/Decumano auto_complete |
| Inizio turno | `game.py` → `_trigger_building_start` | Estrattore, Biblioteca, Fucina |
| Fine turno | `game.py` → `_trigger_building_end` | Granaio |
| Inizio turno (deferred) | `game.py` → `_process_deferred_effects` | Investimento prodigio, Divinazione |
| Attivazione Orda | `actions.py` → `activate_horde` | Effetti orda |
| Post-battaglia | `routes.py` | Eracle (distruggi costruzione) |

### Effetti passivi

Ariete, Catapulta, Saracinesca, Fossato, Obelisco, Scrigno sono passivi: la loro funzione registrata ritorna `{"passive": True}`, e il comportamento è gestito direttamente in `battle.py` o `actions.py` controllando le costruzioni in campo.

---

## Flusso Multiplayer

**Creazione Lobby**: giocatore crea → server genera codice (`BARB-7X3K`) → altri si uniscono → creatore avvia → server genera stato iniziale.

**Gestione Turno**: server invia stato via WebSocket → giocatore attivo invia azioni → server valida, aggiorna, salva, notifica tutti.

**Visibilità**:
- Tutti: Guerrieri, Costruzioni, numero Muri/Vite/carte in mano in campo
- Solo proprietario: contenuto mano, identità dei propri Muri/Vite, `ethereal_card`
- Nessuno: ordine del mazzo

**Disconnessione**: turno saltato dopo 120s. Riconnessione con session token. Partita resta in SQLite.

---

## Modalità Test

Se un giocatore ha nome `"Test"` o `"Test2"`:
- Le prime 6 carte pescate vengono prese da `data/test_cards.json` (posta in cima al mazzo).
- Ogni inizio turno: `mana_remaining = 10` e `actions_remaining = 5`.

Utile per testare effetti specifici senza dover giocare turni di setup.

---

## Stato di Avanzamento

| Fase | Stato |
|---|---|
| **Fase 1** — Motore Python completo | ✅ Completata |
| **Fase 2** — Server, WebSocket, lobby, persistenza | ✅ Completata |
| **Fase 3** — Frontend giocabile da browser | ✅ Completata |
| **Fase 4** — Effetti avanzati (orde, magie, costruzioni) | 🔄 In corso — molte carte implementate, alcune mancanti |
| **Fase 5** — Deploy, tutorial, QA | ⏳ Non iniziata |

---

## Note Tecniche

### Validazione Server-Side

Il client invia solo intenzioni; il server valida tutto (turno, azioni rimanenti, mana/maghe, carta in mano, posizionamento legale). Il client non modifica mai lo stato localmente.

### public_state

`game.py → public_state(state, viewer_player_id)` filtra lo stato prima del broadcast: nasconde mano e `ethereal_card` degli avversari, nasconde l'identità dei Muri/Vite altrui.

### Timer per Turno

120s per turno (disattivabile in lobby). Allo scadere `_on_turn_expire()` in `routes.py` forza `end_turn`. Il client mostra countdown con avviso visivo a 15s.

### Animazioni Frontend

Transizioni CSS leggere. Nessuna libreria esterna.

---

## Decisioni Finali

| Tema | Decisione |
|---|---|
| **Numero giocatori** | 2–4 |
| **Timer per turno** | 120s, disattivabile in lobby |
| **Spettatori** | Non supportati |
| **Immagini carte** | No — carte renderizzate a testo/CSS |
| **Tutorial in-game** | Sì, in Fase 5 contro avversario fittizio preconfigurato |
| **Animazioni** | Minimaliste, transizioni CSS, nessuna libreria esterna |
