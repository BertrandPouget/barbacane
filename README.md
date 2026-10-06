# 🧱 Barbacane

![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)

Barbacane è un gioco di carte fantasy, ora in versione digitale multiplayer.

Il mondo di Barbacane è popolato da Umani, Elfi, Nani e Maghe — tutti, inspiegabilmente, di sangue Goblin. Turno dopo turno, ogni giocatore deve potenziare il proprio campo di gioco schierando Guerrieri, erigendo Costruzioni e scagliando Magie contro gli avversari. Niente alleanze, niente tregue: ne resterà soltanto uno.

## Come Provarlo

Il gioco è online su **[barbacane-online.onrender.com](https://barbacane-online.onrender.com)**: non serve installare nulla, basta un browser.

### Modalità di Gioco

Dalla schermata iniziale si può scegliere tra:

- **Giocatore Singolo** — una partita vera, in solitaria, contro 1–3 avversari controllati dal computer (i "Mecha-"), con tre livelli di difficoltà: Facile, Normale e Difficile.
- **Multigiocatore** — si crea una lobby e si ottiene un codice da condividere con gli amici, che lo usano per unirsi. In Sala d'Attesa il creatore può riempire i posti liberi con dei Bot, sceglierne la difficoltà e decidere l'ordine dei posti al tavolo (che determina quali Bastioni confinano); al momento della creazione si può anche attivare un timer per turno.
- **Tutorial** — sei brevi partite guidate che insegnano il gioco mossa per mossa, contro un Manichino che si limita a fare da bersaglio.
- **Catalogo Carte** — tutte le carte del gioco, da sfogliare con calma.

Il gioco è pensato sia per desktop che per telefono, con due interfacce dedicate.

### Avvio in Locale

```bash
pip install -r requirements.txt
python main.py
```

Apri il browser su `http://localhost:8000` per accedere alla schermata di gioco. Per simulare una partita Multigiocatore basta aprire più finestre e unirsi alla stessa lobby; per giocare da soli c'è la modalità Giocatore Singolo.

In locale la persistenza usa un file SQLite (`barbacane.db`) creato automaticamente. Per usare Postgres anche in locale, imposta la variabile d'ambiente `DATABASE_URL` con una connection string Postgres prima di avviare il server.

### Modalità Test

Entrando con il nome `Test` o `Test2`, le carte elencate in `data/test_cards.json` finiscono in cima al mazzo (e quindi nella mano iniziale), e a ogni turno si ricevono 10 Mana e 3 Azioni. È il modo più rapido per provare una carta specifica senza dover giocare i turni di preparazione.

## Come si Gioca

Ecco una breve introduzione al gioco e alle sue meccaniche principali. Per il regolamento completo, consigliamo comunque di vedere [`assets/rules.md`](assets/rules.md), oppure di giocare i tutorial.

### Campo di Gioco

Si gioca da 2 a 4 giocatori, con un mazzo comune di 200 carte. Ogni giocatore inizia con 3 Vite e pesca 6 carte.

Ogni giocatore ha un campo diviso in 4 Regioni:
- **Avanscoperta** — dove si posizionano i Guerrieri offensivi: i loro ATT e GIT determinano la potenza d'attacco in Battaglia.
- **Bastioni (Destro e Sinistro)** — dove si posizionano i Muri e i Guerrieri difensivi: i Muri assorbono i Danni, mentre la DIF e la GIT dei Guerrieri determinano la potenza difensiva in Battaglia.
- **Villaggio** — dove si posizionano le Costruzioni, che potenziano il giocatore, e dove sono custodite le Vite.

I giocatori siedono in cerchio: il Bastione destro di ciascuno confina con il Bastione sinistro del vicino alla sua destra, ed è solo lì che si può attaccare. Quando un giocatore viene eliminato, il cerchio si stringe.

### Turno

1. **Fase iniziale**: ricevi Mana (scalato al numero di turno: da 1 a 5)
2. **Fase delle Azioni**: fino a 2 Azioni — gioca carte, completa Costruzioni, aggiungi fino a 3 Muri
3. **Fase dello Schieramento**: riposiziona i Guerrieri tra Avanscoperta e Bastioni e attiva le Orde disponibili
4. **Fase della Battaglia**: attacca un Bastione avversario adiacente
5. **Fase finale**: pesca fino a 6 carte

### Tipi di Carta

- **Guerrieri** (Reclute ed Eroi): hanno ATT, GIT e DIF e una Specie; le Reclute evolvono negli Eroi corrispondenti, che ne ereditano l'effetto Orda
- **Magie** (Anatemi, Sortilegi, Incantesimi): costo in Maghe anziché Mana; attivano il Prodigio se almeno una delle Maghe in campo è della stessa Scuola
- **Costruzioni**: piazzate incomplete con effetto Base, completabili con un'azione aggiuntiva per sbloccare l'effetto Completo
- **Muri**: qualsiasi carta può essere convertita in Muro per assorbire danni in Battaglia

Alcune carte possono inoltre rendere **Eterea** un'altra carta in mano: una carta Eterea si gioca gratis e senza consumare un'Azione, ma la proprietà svanisce appena si fa qualcos'altro.

### Battaglia

Il danno inflitto a un Bastione è calcolato così:

```
Danno = max(ATT_att − DIF_dif, 0) + max(GIT_att − GIT_dif, 0)
```

dove ATT e GIT dell'attaccante sono i valori più alti tra i suoi Guerrieri in Avanscoperta, e DIF e GIT del difensore i più alti tra i Guerrieri nel Bastione attaccato. Il Bastione perde Muri pari al Danno. Se il Danno supera i Muri disponibili, il difensore perde 1 Vita. Non si può attaccare un giocatore che non ha ancora giocato il suo primo turno.

### Orde

Schierare 3 Guerrieri della stessa Specie nella stessa Regione forma un'Orda: il giocatore sceglie quale effetto Orda attivare tra quelli dei Guerrieri coinvolti. L'effetto resta attivo finché l'Orda non si divide.

## Aggiungere una Nuova Carta

Le carte vivono tutte in un unico file, `data/cards.json`: è la fonte da cui leggono il motore di gioco, l'interfaccia e il generatore della grafica. Cambiare un costo, una statistica o il numero di copie di una carta esistente richiede solo di modificare quel file. Aggiungere una carta nuova, invece, richiede qualche passo in più.

1. **Definire la carta** in `data/cards.json`, nella lista giusta (`warriors`, `spells` o `buildings`), con un `id` univoco e — per Magie e Costruzioni — un `effect_id` univoco; per i Guerrieri l'effetto Orda va in `horde_effect_id`. Se il testo del Prodigio o del Completo inizia con `&`, significa che si aggiunge all'effetto Base invece di sostituirlo, e va impostato a `true` il relativo campo `prodigy_is_additive` o `complete_is_additive`.

2. **Implementare l'effetto** in `engine/effects.py`, registrandolo con lo stesso `effect_id`:

   ```python
   @register_effect("ardolancio_effect")
   def ardolancio_effect(state, player, prodigy=False, target_player_id=None, bastion_side=None, **kwargs):
       damage = 4 if prodigy else 2
       apply_damage_to_bastion(state, target_player_id, bastion_side, damage)
       return {"damage": damage}
   ```

   Se la carta può essere giocata solo a certe condizioni (es. "devi avere una Costruzione in mano"), il controllo va fatto in `engine/actions.py`, prima che la carta venga tolta dalla mano: così, se le condizioni non sono rispettate, la carta resta in mano e l'Azione non viene consumata.

3. **Aggiungere l'interfaccia**, se l'effetto richiede delle scelte al giocatore (un bastione bersaglio, un Guerriero, una carta da cercare...). Il gioco ha due interfacce separate, desktop (`frontend/app.js`) e mobile (`frontend/mobile/app.js`): la nuova scelta va costruita in entrambe. Gli effetti che si risolvono in due tempi (come cercare una carta nel mazzo, o la Biblioteca) mettono il gioco in attesa della risposta del giocatore, che arriva con un'azione dedicata.

4. **Insegnarla ai Bot**: in `engine/bot.py` si stabilisce quanto vale la carta e con quali bersagli giocarla. Se la carta introduce una nuova scelta in attesa di risposta, va gestita anche la risposta automatica dei Bot, altrimenti una partita contro di loro resterebbe bloccata.

5. **Generare la grafica** con la [Card Factory](card_factory/README.md): si aggiunge l'illustrazione in `card_factory/images/<id>.png` e si lancia `python card_factory/2_generate_cards.py <id>`. La carta finita compare in `card_factory/output/full/` (con anteprima e minicarta in `output/preview/` e `output/mini/`) e da lì viene mostrata nel gioco.

6. **Provarla** con la Modalità Test: aggiungendo l'`id` della carta a `data/test_cards.json` e entrando con il nome `Test`, la si ritrova subito in mano.

Se la carta cambia le regole generali, ricordarsi di aggiornare anche [`assets/rules.md`](assets/rules.md).

## Stack Tecnologico

- **Backend**: Python + FastAPI, WebSocket per gli aggiornamenti in tempo reale
- **Frontend**: JavaScript vanilla, in due versioni (desktop e mobile), servite come file statici da FastAPI
- **Persistenza**: PostgreSQL su Neon (free tier) in produzione, tramite variabile d'ambiente `DATABASE_URL`; SQLite in locale. Le partite finite o abbandonate vengono eliminate automaticamente.
- **Deploy**: Render
