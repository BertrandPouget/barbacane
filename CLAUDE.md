# Barbacane — Note per Claude

Questo file è il contesto di lavoro per Claude all'inizio di ogni conversazione. Il `README.md` è per gli umani (regole, come provare il gioco, come aggiungere carte) e non va duplicato qui: qui c'è come è fatto il codice, dove stanno le cose e quali trappole evitare.

> **Mantenerlo aggiornato.** Quando un lavoro cambia qualcosa di descritto qui (nuovo modulo, nuova modalità, nuova azione o interazione pendente, cambio di stack/deploy, una fase del progetto che si chiude, una trappola scoperta), aggiorna questo file nello stesso intervento, senza aspettare che venga chiesto. Se trovi un'affermazione qui che non corrisponde più al codice, correggila. Aggiorna anche la data nella sezione "Stato attuale".

---

## Stato attuale (aggiornato al 2026-10-02)

Il gioco è **completo e in produzione**:

- **Tutte le carte di `data/cards.json` sono implementate** (24 Guerrieri, 21 Magie, 15 Costruzioni; 200 copie nel mazzo), effetti Orda inclusi.
- **Deploy attivo** su Render (free tier) + Postgres su Neon: https://barbacane-online.onrender.com (deploy automatico da GitHub, configurazione in `render.yaml`).
- **Modalità di gioco** (nomi come appaiono in home, identici su desktop e mobile): **Giocatore Singolo** (partita contro 1–3 Bot "Mecha-…"), **Multigiocatore** (lobby online, anche con Bot ai posti liberi), **Tutorial** (6 partite scriptate), **Catalogo Carte**. Nei documenti per gli utenti usare questi nomi esatti.
- **Due client**: desktop (`frontend/`) e mobile (`frontend/mobile/`, servito su `/m`).
- Musica di sottofondo, scintille animate, grafica carte generata da `card_factory/`.

Non ci sono fasi aperte: il lavoro corrente è rifinitura (bilanciamento carte, fix, UI/UX, forza dei Bot, nuove illustrazioni).

---

## Convenzioni di lavoro

- **Lingua**: codice commentato in italiano, messaggi per il giocatore in italiano, commit liberi. Rispondere all'utente in italiano.
- **Ambiente Python**: conda, ambiente `barbacane` (non venv). Avvio locale: `python main.py` → `http://localhost:8000` (desktop) e `/m` (mobile; da desktop `?desktop=1` forza la versione desktop).
- **Ogni modifica di UI va fatta su entrambi i client**: `frontend/app.js` + `renderer.js` + `style.css` *e* `frontend/mobile/app.js` + `render.js` + `mobile.css`. Sono due codebase separate che parlano lo stesso protocollo; `mobile.css` ha una sua copia della palette.
- **Estetica**: la UI riusa il linguaggio grafico delle carte (font Caudex, palette, nastri/esagoni di `card_factory/assets/card.html`). Niente librerie esterne nel frontend, solo CSS/JS vanilla.
- **Nessuna test suite**. Per verificare il motore: `python -m engine.game` (simula una partita tra bot casuali), oppure piccoli script ad hoc nello scratchpad che creano uno stato con `create_game` / `create_practice_game` e chiamano le azioni. Per la UI: avviare il server e provare (nome `Test` per avere carte e risorse a piacere, vedi sotto).
- **Fonte autoritativa delle regole**: `assets/rules.md`. Il testo delle carte è in `data/cards.json`.

---

## Mappa del codice

```
main.py                 FastAPI: monta router, static (/data, /assets, /card_images), SPA catch-all,
                        /m → client mobile, /health, cache busting (?v=<hash di frontend/>), cleanup loop
render.yaml             Deploy Render (DATABASE_URL impostata in dashboard, non nel repo)
data/
  cards.json            Database carte: unica fonte per motore, frontend e card_factory
  test_cards.json       base_id messi in cima al mazzo per i giocatori "Test"/"Test2"
engine/
  models.py             Pydantic: carte, istanze, Player, GameState (mana_for_turn è qui)
  cards.py              CARD_REGISTRY da cards.json, get_card()
  deck.py               build_deck, draw_cards, draw_to_hand_limit, make_*_instance, get_base_card_id
  actions.py            Azioni di turno (play_*, complete, add_wall, evolve, reposition, horde, arena,
                        recast_spell, eracle_destroy) + pre-validazioni per carta; ActionError
  effects.py            EFFECT_REGISTRY: effetti di Magie, Costruzioni, Orde (~1700 righe)
  battle.py             adjacent_bastions, statistiche att/dif con bonus Costruzioni, calculate_damage,
                        apply_damage_to_bastion, resolve_battle
  game.py               create_game, create_practice_game, _begin_turn, end_turn, do_battle,
                        abandon_game, public_state, bot casuale (random_bot_turn), simulate_game
  bot.py                IA euristica dei Bot (easy/normal/hard), entry point run_bot_turn
  tutorial.py           6 tutorial scriptati (TutorialDef/TutorialStep), validazione e avanzamento step
  chronicle.py          Cronaca della partita: da log + recent_events a frasi italiane (con testo privato
                        per chi può vedere le carte coperte) e statistiche del riepilogo finale
server/
  routes.py             REST + WebSocket, _dispatch_action, timer turno, scheduling turni Bot,
                        handler resolve_* delle interazioni pendenti
  lobby.py              Lobby IN MEMORIA (_lobbies), Bot in lobby, nomi Mecha-, start_game, auth token,
                        rivincita multigiocatore (rematch, _rematches)
  ws_manager.py         Connessioni per partita, send/broadcast, timer turno
db/storage.py           Postgres (se DATABASE_URL) o SQLite; save/load game, players, cleanup_games
frontend/               Client desktop
  index.html            Schermate (splash, home = #screen-lobby, multigiocatore, catalogo, tutorial,
                        giocatore singolo = #screen-bot-difficulty, sala d'attesa, partita, gameover) + redirect automatico a /m da telefono
  app.js                Tutta la logica UI desktop (~3200 righe): stato, macchina a stati azioni,
                        modali per ogni carta con targeting, tutorial, catalogo, lobby
  renderer.js           Rendering del campo; contiene anche la logica client dell'adiacenza
  ws.js                 Client WebSocket (condiviso con mobile)
  spotlight.js          "Occhio di bue" dei tutorial (condiviso)
  sparks.js, audio.js   Scintille e musica (condivisi)
  chronicle.js          Formattazione della cronaca e classifica di fine partita (condiviso)
  session.js            Partita salvata nel browser (SavedGame), link d'invito (Invite), nome ricordato (condiviso)
  mobile/               Client mobile: app.js (modulo Mob), render.js, ui.js (sheet, toast), mobile.css
card_factory/           Pipeline grafica carte (vedi suo README): cards.json + illustrazioni → output/<id>.png,
                        servite al frontend come /card_images/<id>.png (retro.png = dorso)
assets/                 rules.md, logo, sfondo, musica, immagini home
```

---

## Flusso di un'azione

1. Il client invia via WebSocket `{type: "action", action, params}` (esiste anche `POST /game/action`, stesso flusso).
2. `routes.py` → `_handle_ws_message` carica lo stato dal DB e chiama `_dispatch_action(state, player_id, action, params)`, che nell'ordine:
   - azzera `state.recent_events`; gestisce subito `leave_game` (abbandono, sempre consentito);
   - nei tutorial rifiuta le azioni fuori copione (`tutorial_engine.validate_action`);
   - azzera `ethereal_card` / `ethereal_complete` se l'azione è in `_ETHEREAL_BREAKING` e non è il gioco della carta eterea stessa;
   - blocca tutto se c'è un `pending_search` o una `pending_interactions[0]` non risolta (mappa tipo → azione `resolve_*` ammessa), o un Velocemento in sospeso;
   - verifica la fase richiesta (`_PHASE_REQUIRED`);
   - chiama l'handler; dopo un'azione che consuma Azione controlla la Fucina (`check_fucina_after_action`);
   - dopo `battle`/`eracle_destroy`, se non restano battaglie, chiama `end_turn` automaticamente (non nei tutorial);
   - nei tutorial avanza lo step; con Bot in partita risolve subito le loro interazioni pendenti (`_auto_resolve_bot_pending`);
   - infine `chronicle.sync(state)` racconta nella cronaca ciò che l'azione ha prodotto.
3. Salva (`save_game`), invia a ogni connesso il proprio `public_state(state, pid)` con `type: "state_update"` (`_broadcast_state`), riavvia il timer se il turno è cambiato, poi `_schedule_bot_turn(state)`.
4. Gli errori di regola sono `ActionError` → messaggio `{type: "error"}` solo a chi ha agito.

**Fasi del turno** (`state.phase`): `"action"` → `"schieramento"` (riposizionamento + Orde) → `"battaglia"`, avanzate dal client con l'azione `next_phase`; `"end"` a partita finita.

**Azioni disponibili** (chiavi di `handlers` in `_dispatch_action`): `play_warrior`, `play_spell`, `play_building`, `complete_building`, `add_wall`, `evolve` (consumano Azione) · `reposition`, `horde`, `battle`, `arena_activate`, `recast_spell`, `eracle_destroy`, `next_phase`, `end_turn`, `leave_game` · `resolve_search`, `resolve_biblioteca`, `resolve_velocemento`, `resolve_agilpesca`, `resolve_cardo_move`, `resolve_magiscudo_counter`, `resolve_malcomune` · `tutorial_next`, `tutorial_prev`.

**Interazioni asincrone**: un effetto che richiede una scelta imposta `state.pending_search` (cercare nel mazzo) o accoda in `state.pending_interactions` un dict `{type, player_id, ...}`. Tipi attuali: `biblioteca_discard`, `biblioteca_wall`, `cardo_move`, `agilpesca_discard`, `magiscudo_counter` (la risposta la dà il *bersaglio*, anche fuori dal suo turno), `malcomune_discard`, `evelyn_recast`. Possono coesistere (es. Orda di Giulio + Biblioteca a inizio turno): il `pending_search` ha la precedenza, `_dispatch_action` accetta `resolve_search` anche con interazioni in coda, e i client mostrano prima la ricerca e solo dopo l'interazione. Un nuovo tipo va aggiunto in tre posti: la mappa in `_dispatch_action`, `_auto_resolve_bot_pending` (altrimenti una partita con Bot si blocca) e la UI di entrambi i client.

**Turno** (`game.py`): `_begin_turn` azzera azioni/eterea, assegna Mana (`mana_for_turn`, Dazipazzi può azzerarlo), applica la modalità Test, `_trigger_building_start` (Estrattore, Sorgiva, Biblioteca, Fucina, Trono), effetti differiti (Investimento, Divinazione), Orda di Giulio. `end_turn` gestisce prima l'eventuale `cardo_move` (ritorna presto: il turno riprende dopo `resolve_cardo_move`), poi Granaio, pesca fino a 6 (+ Granai), controllo vittoria, passaggio al prossimo vivo; il numero di turno avanza quando il giro torna al primo giocatore vivo.

**Orde**: restano attive tra un turno e l'altro finché il gruppo non si rompe (`deactivate_broken_horde`) o si sceglie un altro effetto per lo stesso gruppo (`deactivate_horde_for_switch`). `hordes_activated_this_turn` impedisce di riattivare la stessa zona:specie nello stesso turno. Gli Eroi ereditano l'effetto Orda della Recluta (gli `horde_effect_id` sono del tipo `<recluta>_horde`).

---

## Modalità di partita

- **Multigiocatore** (`server/lobby.py`): codice tipo `BARB-7X3K`. Le lobby vivono **solo in memoria** (`_lobbies`): un riavvio del server perde le sale d'attesa, non le partite già avviate (che sono nel DB). Il creatore può aggiungere/rimuovere Bot, sceglierne la difficoltà (unica) e riordinare i posti (`/lobby/add_bot|remove_bot|bot_difficulty|reorder`); l'ordine della lobby = ordine di `state.players` = adiacenza. Nomi Bot: "Mecha-" + Recluta casuale, unici case-insensitive; un umano omonimo fa ribattezzare il Bot. I Bot non hanno riga in `players`.
- **Giocatore Singolo** (`POST /practice/start`, `create_practice_game`): 1–3 Bot, umano sempre primo, game_id `vs-…`, timer disattivato.
- **Bot**: `state.bot_player_ids` + `state.bot_difficulty`. I turni girano in background (`_schedule_bot_turn` → `_play_bot_turn` in thread), uno alla volta per partita, e **solo se almeno un umano è connesso**. Il turno è calcolato tutto insieme (`run_bot_turn(..., on_step)` fotografa lo stato dopo ogni mossa), lo stato finale viene salvato subito e poi il tavolo riceve le fotografie una alla volta (`action: "bot_step"`, pausa `_BOT_STEP_SECONDS`, prima mossa dopo `_BOT_THINK_SECONDS`), infine lo stato vero (`bot_turn`). Il racconto si interrompe se nel frattempo il tavolo riceve uno stato più recente (`_game_versions`). La strategia è in `engine/bot.py` (docstring in testa spiega le tre difficoltà; `hard` simula fino a fine turno e stima la minaccia avversaria). Un turno da 3–4 s è accettabile: non sacrificare la forza per la velocità; `hard` ha comunque un tetto di riflessione per la fase Azioni (`HARD_THINK_SECONDS`), oltre il quale gioca la mossa migliore trovata. Magie che il Bot non sa usare: `_SPELL_EFFECT_EXCLUDE`.
- **Cronaca** (`engine/chronicle.py`): `sync()` trasforma le nuove voci di `state.log` (cursore `chronicle_cursor`) e gli eventi non ancora raccontati (marcati `_told`) in voci di `state.chronicle`, con segnaposto `{p:player_id}` e `{c:base_card_id}` che i client rendono con `frontend/chronicle.js`. Le informazioni coperte (carte pescate, Muri, carte scartate dalla mano) vanno in `private_text` per il solo proprietario; `view()` invia a ciascuno la propria versione. Una carta nuova che produce eventi o voci di log merita una frase in `_tell_log`/`_tell_event`. Aggiorna anche `match_stats` ed `eliminations`, usati dal riepilogo di fine partita.
- **Fine partita**: riepilogo (classifica + statistiche) e **Rivincita** (`POST /game/rematch`): in Giocatore Singolo crea una nuova partita contro gli stessi Bot; in multigiocatore il primo che la chiede crea una nuova sala d'attesa con timer, Bot e posti della partita precedente (`seat_hint`), gli altri ricevono `{type: "rematch_offer"}` via WebSocket e con la stessa chiamata ci entrano. `state.mode` ("lobby" | "practice" | "tutorial", vedi `game_mode()` per le partite vecchie) dice quale delle due.
- **Ripresa e inviti** (`frontend/session.js`): la partita in corso è salvata in `localStorage` (pulsante «Riprendi la partita» in home) e in `sessionStorage` (ricaricando la pagina si torna subito al tavolo). Il link d'invito è `/?join=BARB-XXXX` (passa anche al redirect mobile).
- **Tutorial** (`engine/tutorial.py`, `GET /tutorials`, `POST /tutorial/start`): partita contro un "Manichino" che non gioca; ogni step `info` (avanza con `tutorial_next`) o `action` (richiede un'azione precisa, con `match`). Si torna indietro solo verso step `info` tramite snapshot. Gli step usano `highlight` per lo spotlight (con `_MOBILE_HIGHLIGHT_MAP` per i selettori mobile) e `card_focus` con rettangoli in percentuale sull'immagine della carta: se cambia il layout di `card.html`, quei rettangoli vanno ritarati.
- **Modalità Test**: nome `Test` o `Test2` → le carte di `data/test_cards.json` in cima al mazzo prima della pescata iniziale, e a ogni inizio turno 10 Mana e 5 Azioni.

---

## Modello dati: cose da sapere

- `cards.json` ha tre liste (`warriors`, `spells`, `buildings`); campi principali: `id`, `cost`, `cost_type` (`mana`/`maga`), `att/git/dif`, `species`, `school`, `evolves_from/into`, `horde_effect_id`, `effect_id`, `base_effect`, `prodigy_effect`/`complete_effect`, `*_is_additive` (il testo con `&` iniziale si somma al Base), `auto_complete` (solo Cardo e Decumano), `completion_cost`, `copies`.
- **Instance id** = `{base_card_id}_{n}` (es. `patrizio_3`); `get_base_card_id()` lo inverte. Mano, Vite, Muri, mazzo e scarti contengono instance id.
- Istanze: `WarriorInstance` (`assigned_cards`, `horde_active`, `temp_modifiers`, `evolved_from`), `BuildingInstance` (`completed`, `assigned_warrior` per il Trono), `WallInstance` (`durability`, 2 con Plasmattone), `Bastion` (`walls`, `warriors`, `dif_bonus`).
- `Player` oltre alle risorse ha molti flag di effetti: `active_effects` (lista di dict con `type`), `skip_mana_next_turn`, `extra_battles`, `spell_cost_reductions`, `ethereal_card`, `ethereal_complete` (Velocemento prodigio), `pending_velocemento_*`, `turns_completed` (non si attacca chi non ha ancora giocato un turno).
- `GameState` oltre al flusso turno ha `tutorial`, `bot_player_ids`, `bot_difficulty`, `turn_timer`, `log`.
- **I parametri di gioco sono nel codice** (non esiste un file di configurazione): Mana in `GameState.mana_for_turn`, 2 Azioni e pesca a 6 in `game.py`, 3 Vite in `create_game`.
- `public_state` nasconde agli avversari mano, Vite, identità dei Muri, mana/azioni, `ethereal_card` e la maggior parte degli `active_effects` (whitelist dei tipi visibili). In fase `battaglia` i Guerrieri mostrano già i bonus di Ariete/Catapulta/Saracinesca.

---

## Effetti delle carte

- `@register_effect("<effect_id>")` in `effects.py`; `apply_effect(effect_id, state, player, **kwargs)` ritorna `{"warning": ...}` se l'id non è registrato.
- Firme: Magie `(state, player, prodigy=False, **targeting)`, Costruzioni `(state, player, completed=False, **kw)`, Orde `(state, player, warrior_iid=None, **kw)`.
- **Passive** (Ariete, Catapulta, Saracinesca, Fossato, Obelisco, Scrigno, Fucina…): l'effetto registrato ritorna `{"passive": True, ...}`; il comportamento vero sta in `battle.py` / `actions.py` / `game.py`, che controllano le Costruzioni in campo.
- **Pre-validazione Magie**: le condizioni per poter giocare una Magia vanno in `actions.py` → `play_spell()`, nel blocco `if base_id == "...": raise ActionError(...)` **prima** di `player.hand.remove(instance_id)`. Un errore ritornato dall'effetto arriva troppo tardi: la carta è già consumata. Stessa logica per le Costruzioni in `play_building` / `complete_building`.
- Una carta già in campo si sposta/scarta solo se un effetto lo richiede: non esistono scarto libero né recupero di Muri.
- Eroe scartato → la Recluta torna in campo con le carte assegnate; Recluta scartata → anche le assegnate vanno negli scarti.
- D10: `_roll_d10()`, il risultato va in `state.recent_events` (visibile a tutti, azzerato a ogni azione).

**Checklist quando si aggiunge o cambia una carta:**
1. `data/cards.json` (testo, costi, statistiche, copie).
2. Effetto in `engine/effects.py` (+ pre-validazione in `actions.py`, + logica passiva o trigger in `game.py`/`battle.py` se serve).
3. Targeting/interazione in **entrambi** i client (`frontend/app.js` e `frontend/mobile/app.js`; spesso c'è un ramo dedicato per `base_id`). Ogni scelta passa dai **selettori comuni**, mai da liste fatte a mano: desktop `Renderer.showWarriorPicker / showBastionPicker / showBuildingPicker / showCardPicker / showPlayerPicker / showRegionPicker` (base: `Renderer.showPicker`), mobile `pickWarrior / pickBastion / pickBuilding / pickCard / pickPlayer / pickRegion` (base: `pickGrouped`). Dividono per giocatore e Regione (o tipo di carta), mettono "Possibile Bersaglio" sui Bastioni adiacenti e usano i simboli di Regione del client (desktop ⚔ 🛡 monocromi, mobile ⚔️ 🏰); stesse opzioni nei due client (`players`, `filter`, `note`, `onPick`, `cancelLabel`, `empty`).
4. Bot: candidati e kwargs in `bot.py` (`_default_spell_kwargs`, `_card_value`, `_SPELL_EFFECT_EXCLUDE`) e, se c'è un nuovo pending, `_auto_resolve_bot_pending` in `routes.py`.
5. Tutorial: controllare se la carta compare negli script di `tutorial.py`.
6. Grafica: illustrazione in `card_factory/images/<id>.png`, poi `python card_factory/2_generate_cards.py <id>` → `card_factory/output/<id>.png` (committato, il frontend lo serve da lì).
7. Se il testo della regola cambia, aggiornare `assets/rules.md`.

---

## Persistenza e deploy

- `db/storage.py`: Postgres se `DATABASE_URL` è impostata, altrimenti SQLite (`barbacane.db`, path sovrascrivibile con `BARBACANE_DB`). Placeholder `?` convertiti in `%s` da `_q()`; timestamp ISO 8601 UTC generati in Python.
- Tabelle `games` (`game_id`, `lobby_code`, `state` JSON, `status` lobby|playing|finished, timestamp) e `players` (PK `(game_id, player_id)`, FK su `games`, `session_token` unico). **Prima `save_game`, poi `save_player`**: Postgres applica la FK.
- `cleanup_games` (all'avvio e ogni 5 min) elimina le partite `finished` da più di 5 min e quelle ferme da più di 1 ora.
- Ogni azione ricarica lo stato dal DB e lo risalva: lo stato in memoria non è mai la fonte di verità per una partita avviata.
- Render free tier andrebbe in spindown dopo ~15 min senza traffico HTTP (il WebSocket non conta). Il servizio è tenuto sempre acceso da un **cron-job esterno** che interroga periodicamente il sito, quindi in pratica non ci sono cold start; in più il client fa un ping a `/health` ogni 4 minuti durante le partite (`ws.js`), come rete di sicurezza se il cron-job si fermasse.
- Il cache busting di `main.py` aggiunge `?v=<hash>` a CSS/JS negli `index.html`: un nuovo file JS/CSS va referenziato con `src`/`href` relativo per esserne coperto.

---

## Trappole note

- **Disconnessione**: non c'è un salto automatico del turno dopo 120 s; il turno passa da solo solo se in lobby è stato impostato un timer (`turn_timer > 0`, `_on_turn_expire`).
- **Adiacenza**: il Bastione destro di X confina col sinistro del primo giocatore **vivo** alla sua destra (eliminati saltati). La logica è duplicata in `battle.py → adjacent_bastions`, `frontend/renderer.js`, `frontend/mobile/render.js` e `frontend/mobile/app.js`: cambiarla ovunque.
- **Massimo 2 Azioni** è scritto anche lato client per la modalità Test (`maxActions` in `app.js`).
- Nel tutorial la fine turno automatica dopo la Battaglia è disattivata (il Manichino non gioca).
- I nomi delle partite di pratica (`vs-…`) e le partite tutorial hanno una sola riga in `players` (`player_1`).
- `engine/game.py` contiene ancora un bot casuale (`random_bot_turn`, `_bot_try_horde` riusato da `bot.py`) usato da `simulate_game`: non è il Bot delle partite reali.
