# Barbacane — Note per Claude

Contesto di lavoro per Claude. Il `README.md` è per gli umani (regole, come provare, come aggiungere carte) e non va duplicato qui.

## Come mantenere questo file

Scopo: evitare che un Claude futuro **sbagli** o perda molto tempo. Non è documentazione del gioco né diario delle modifiche.

- **Prova**: una riga entra solo se, senza di essa, un Claude che legge il codice sbaglierebbe (rompe un invariante, modifica un posto solo dove ne servono tre, viola una convenzione dell'utente). Se il codice lo dice da solo in un minuto, non va qui.
- **Sì**: convenzioni dell'utente, logica duplicata in più file, "va aggiunto in N posti", trappole controintuitive, dove sta cosa (a livello di file, non di funzione minore).
- **No**: come funziona una funzionalità, dettagli di UI/CSS (misure, colori, zoom, valori tarati), elenchi che il codice già contiene (azioni, flag, campi), numeri di righe, date, cronaca di cosa è stato fatto.
- **Forma**: una voce = 1–2 righe, rimandando al file/funzione per il resto. Lunghezza massima del file ~130 righe: per aggiungere, prima comprimi o togli.
- **Quando**: alla fine di un lavoro che cambia la struttura (nuovo modulo, modalità, interazione pendente, stack/deploy) o che ha fatto scoprire una trappola. Ritocchi, fix e funzionalità di UI di norma non lo toccano. Correggi sempre ciò che non è più vero.

---

## Stato e convenzioni

- Gioco **completo e in produzione** (tutte le carte di `data/cards.json` implementate). Deploy automatico da GitHub su Render free tier + Postgres Neon: https://barbacane-online.onrender.com (`render.yaml`). Lavoro corrente: rifinitura.
- **Voci della home** (identiche su desktop e mobile, da usare nei testi per gli utenti): **Gioca** (Crea/Unisciti lobby, Bot compresi), **Tutorial**, **Catalogo**.
- **Lingua**: commenti e messaggi al giocatore in italiano; rispondere all'utente in italiano.
- **Python**: conda, ambiente `barbacane`. Avvio: `python main.py` → `http://localhost:8000` (desktop), `/m` (mobile; `?desktop=1` forza il desktop).
- **Due client separati** con lo stesso protocollo: desktop `frontend/` (`app.js`, `renderer.js`, `style.css`) e mobile `frontend/mobile/` (`app.js`, `render.js`, `mobile.css`, con una sua copia della palette). **Ogni modifica di UI va fatta su entrambi.**
- **Estetica**: la UI riusa il linguaggio delle carte (Caudex, palette, nastri/esagoni di `card_factory/assets/card.html`). Solo CSS/JS vanilla, niente librerie.
- **Pannelli dei menu**: classe `.menu-frame` (cornice con angoli a punta, SVG in `assets/frames/` via border-image), niente bordi arrotondati. Non chiamarla `.bastion`: è la classe dei Bastioni in partita (`.region.bastion`). Sta in fondo a entrambi i CSS: una regola con `#id` sul pannello la scavalca. Gli SVG vanno salvati in UTF-8, se no il browser li scarta in silenzio.
- **Nessuna test suite**: `python -m engine.game` simula una partita; per il resto script nello scratchpad con `create_game`/`create_practice_game`. UI: server + nome giocatore `Test`.
- Regole autoritative: `assets/rules.md`. Testo delle carte: `data/cards.json` (unica fonte per motore, frontend e card_factory).

## Mappa del codice

```
main.py            FastAPI: router, static, SPA, /m, /health, cache busting (?v=<hash>), cleanup loop
engine/
  models.py        Pydantic: carte, istanze, Player, GameState (mana_for_turn)
  cards.py, deck.py  Registry carte; mazzo, pescata, instance id
  actions.py       Azioni di turno + pre-validazioni per carta (ActionError)
  effects.py       EFFECT_REGISTRY: Magie, Costruzioni, Orde
  battle.py        Adiacenza, statistiche con bonus, danni, resolve_battle
  game.py          create_game/create_practice_game, _begin_turn, end_turn, public_state, simulate_game
  bot.py           IA dei Bot (docstring in testa: easy/normal/hard), run_bot_turn
  tutorial.py      6 tutorial scriptati
  chronicle.py     Cronaca (log/eventi → frasi) e statistiche di fine partita
server/
  routes.py        REST + WebSocket, _dispatch_action, timer, turni Bot, handler resolve_*
  lobby.py         Lobby in memoria, Bot in lobby, rivincita multigiocatore
  ws_manager.py    Connessioni, broadcast, timer turno
db/storage.py      Postgres (DATABASE_URL) o SQLite
frontend/          Desktop (app.js, renderer.js) + moduli condivisi col mobile: ws, spotlight, sparks,
                   audio, chronicle, session, cardart (minicarte), motion (transizioni)
frontend/mobile/   Client mobile (modulo Mob), ui.js (sheet, toast)
card_factory/      Grafica carte (vedi suo README) → output/full, output/preview, output/mini, serviti su /card_images
```

## Flusso di un'azione

Client → WebSocket `{type: "action", action, params}` → `routes._dispatch_action`, che: gestisce `leave_game`; valida il copione nei tutorial; azzera l'eterea (`_ETHEREAL_BREAKING`); **blocca tutto se c'è un `pending_search` o una `pending_interactions[0]`** (ammette solo il `resolve_*` corrispondente); controlla la fase (`_PHASE_REQUIRED`); chiama l'handler (elenco in `handlers`); Fucina; fine turno automatica dopo l'ultima battaglia (non nei tutorial); risolve i pending dei Bot; `chronicle.sync`. Poi salva, manda a ognuno il proprio `public_state` e schedula il turno Bot. Errori di regola = `ActionError` → `{type: "error"}` solo a chi ha agito.

- Fasi: `action` → `schieramento` → `battaglia` (azione `next_phase`); `end` a partita finita.
- **Interazioni pendenti**: un effetto che chiede una scelta imposta `pending_search` o accoda `{type, player_id, ...}` in `pending_interactions` (alcune le risolve il bersaglio fuori turno). Possono coesistere: il `pending_search` ha la precedenza, anche nei client (prima la ricerca, poi l'interazione). **Un nuovo tipo va aggiunto in tre posti**: mappa in `_dispatch_action`, `_auto_resolve_bot_pending` (altrimenti le partite con Bot si bloccano), UI di entrambi i client.
- `end_turn` può fermarsi su `cardo_move` e riprendere dopo `resolve_cardo_move`.
- Orde attive finché il gruppo regge; gli Eroi ereditano l'Orda della Recluta (`<recluta>_horde`).

## Modalità di partita

- **Multigiocatore**: le lobby vivono **solo in memoria** (un riavvio perde le sale d'attesa, non le partite avviate). Ordine della lobby = ordine di `state.players` = adiacenza. I Bot non hanno riga in `players`.
- **Giocatore Singolo** (schermata `bot-difficulty`, non più raggiungibile dalla home): game_id `vs-…`, umano primo, timer disattivato.
- **Bot**: girano in background **solo se almeno un umano è connesso**; il turno è calcolato tutto, salvato, poi raccontato al tavolo mossa per mossa (`bot_step`). Un turno da 3–4 s è accettabile: non sacrificare la forza per la velocità. Magie non gestite: `_SPELL_EFFECT_EXCLUDE`.
- **Cronaca**: le informazioni coperte (pescate, Muri, scarti dalla mano) vanno in `private_text`, mai nel testo pubblico. Una carta nuova che produce eventi/log merita una frase in `_tell_log`/`_tell_event`.
- **Tutorial**: `card_focus` usa rettangoli in % sull'immagine della carta: se cambia il layout di `card.html` vanno ritarati. Selettori mobile in `_MOBILE_HIGHLIGHT_MAP`.
- **Modalità Test**: nome `Test`/`Test2` → carte di `data/test_cards.json` in cima al mazzo, 10 Mana e 5 Azioni a turno.
- Rivincita e ripresa partita: `POST /game/rematch` (`state.mode` distingue i casi), `frontend/session.js`.

## Modello dati

- **Instance id** = `{base_card_id}_{n}` (`get_base_card_id()` lo inverte); mano, Vite, Muri, mazzo e scarti contengono instance id.
- Testo con `&` iniziale (`*_is_additive`) si somma al Base. `mini_name` in `cards.json` è solo per le minicarte del client.
- **Parametri di gioco nel codice**, non in un config: Mana in `mana_for_turn`, 2 Azioni e pesca a 6 in `game.py`, 3 Vite in `create_game`.
- `public_state` nasconde agli avversari mano, Vite, Muri, risorse e gran parte di `active_effects` (whitelist): un nuovo effetto visibile va aggiunto lì.

## Effetti delle carte

- `@register_effect("<effect_id>")` in `effects.py`. Firme: Magie `(state, player, prodigy=False, **targeting)`, Costruzioni `(state, player, completed=False, **kw)`, Orde `(state, player, warrior_iid=None, **kw)`.
- **Passive** (Ariete, Catapulta, Fossato, Fucina…): l'effetto ritorna `{"passive": True}`, la logica vera è in `battle.py`/`actions.py`/`game.py`.
- **Pre-validazione**: le condizioni per giocare una Magia/Costruzione vanno in `actions.py` (`play_spell`/`play_building`/`complete_building`) **prima** che la carta lasci la mano: un errore dall'effetto arriva quando la carta è già consumata.
- Non esistono scarto libero né recupero di Muri. Eroe scartato → torna la Recluta con le assegnate; Recluta scartata → anche le assegnate negli scarti. D10 con `_roll_d10()` → `recent_events`.

**Checklist per una carta nuova o cambiata:**
1. `data/cards.json`.
2. Effetto in `effects.py` (+ pre-validazione in `actions.py`, + passiva/trigger in `game.py`/`battle.py`).
3. Targeting in **entrambi** i client, sempre con i **selettori comuni** (desktop `Renderer.show*Picker`, mobile `pick*`), mai liste fatte a mano.
4. Bot: `_default_spell_kwargs`, `_card_value`, `_SPELL_EFFECT_EXCLUDE` in `bot.py`; nuovo pending → `_auto_resolve_bot_pending`.
5. Tutorial: la carta compare negli script?
6. Grafica: `card_factory/images/<id>.png` → `python card_factory/2_generate_cards.py <id>` (genera full, preview, mini; tutto committato).
7. Regola cambiata → `assets/rules.md`.

## Persistenza e deploy

- Ogni azione ricarica lo stato dal DB e lo risalva: lo stato in memoria non è mai la fonte di verità di una partita avviata.
- **Prima `save_game`, poi `save_player`** (FK su Postgres). Placeholder `?` convertiti da `_q()`.
- `cleanup_games` elimina le partite finite da 5 min e quelle ferme da 1 ora.
- Render è tenuto sveglio da un cron-job esterno (+ ping `/health` del client ogni 4 min).
- Un nuovo file JS/CSS va referenziato con percorso relativo negli `index.html`, altrimenti sfugge al cache busting.

## Trappole note

- **Adiacenza**: il Bastione destro confina col sinistro del primo giocatore **vivo** a destra. Logica duplicata in `battle.py`, `frontend/renderer.js`, `frontend/mobile/render.js`, `frontend/mobile/app.js`: cambiarla ovunque.
- **Massimo 2 Azioni** è scritto anche lato client (`maxActions` in `app.js`).
- **Regola del Prodigio**: `_prodigy_active` in `actions.py` (usata anche da `bot.py`), ricopiata nei client per il targeting (`_computeSpellProdigy` desktop, `computeSpellProdigy` mobile). La stella delle minicarte usa invece `prodigy_ready` dal server.
- **Giocate senza Azioni** (eterea, Orde di Madeleine/Faust/Joseph, Cardo+Decumano): regola in `actions.py`, ricopiata in `bot._is_free_action` e nei client (`_isFreePlay`/`_isFreeComplete` desktop, `isFreePlay`/`isFreeComplete` mobile), che con 0 Azioni lasciano attive solo quelle.
- Nessun salto turno automatico per disconnessione: solo con timer di lobby (`turn_timer > 0`).
- Partite `vs-…` e tutorial hanno una sola riga in `players` (`player_1`).
- **Transizioni** (`motion.js`): i client ridisegnano tutto a ogni `state_update`; si anima solo ciò che ha `data-instance-id`. Gli avversari sul desktop sono riassunti senza carte: le loro animazioni sono in `_animateOpponents`.
- **Minicarte** (`cardart.js`, classi `.mc-*` in entrambi i CSS): sopra una carta `.has-art` il CSS nasconde tutto tranne minicarta e badge del costo; ciò che deve restare visibile va marcato `card-keep`. Il corpo del nome è tarato sul nome più lungo: se arriva un nome più lungo, usa `mini_name`.
- **Tavolo desktop**: la dimensione delle carte la calcola `fitCards()` (`renderer.js`); con altezza ≤ 1000px alcune zone hanno `zoom`, quindi si misurano con `getBoundingClientRect`.
- **Sheet mobile** di sola consultazione: passare `refresh` a `Sheet.open`, altrimenti si chiude al cambio turno.
- `game.py` contiene ancora un bot casuale (`random_bot_turn`) per `simulate_game`: non è il Bot delle partite reali.
