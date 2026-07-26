# Card Factory

Mini-progetto autonomo all'interno di Barbacane. Legge i dati delle carte da `../data/cards.json` (la stessa fonte che alimenta il motore di gioco) e produce i PNG finali pronti da usare nell'interfaccia.

```
input/          ← PDF delle illustrazioni (da creare / aggiungere tu)
images/         ← PNG delle illustrazioni, rinominati con l'id carta
output/         ← PNG carte finali → usati dal frontend di Barbacane
lib/            ← libreria condivisa: cards_data.py, image_ops.py, render.py
assets/
  card.html     ← il renderer: unica fonte di verità per la grafica delle carte
  sfondo.png, esagono*.png, stella*.png, spade.png, back.png  ← texture/icone usate da card.html
```

Gli script numerati (`1_prepare_images.py`, `2_generate_cards.py`, `3_make_print_pdf.py`) sono CLI sottili: la logica di image processing e rendering vive in `lib/`.

---

## Setup

**1. Crea la cartella `input/`** (se non esiste già) e mettici i PDF delle illustrazioni:

```
card_factory/
└── input/
    └── deck_color.pdf   ← un PDF in cui ogni pagina = un'illustrazione
```

**2. Installa le dipendenze** (dall'interno di `card_factory/`, o con il tuo ambiente conda attivo):

```bash
pip install -r requirements.txt
```

Dipendenze: `PyMuPDF`, `numpy`, `Pillow`, `scipy`, `playwright`. Lo Step 2 usa un browser headless, va installato una volta sola:

```bash
playwright install chromium
```

---

## Pipeline

### Step 1 — Prepara le immagini

```bash
python 1_prepare_images.py <nome_deck>
# es. python 1_prepare_images.py deck_color  →  legge input/deck_color.pdf
```

Ritaglia i margini bianchi e ridimensiona ogni pagina a 63×88mm, poi estrae la finestra illustrazione (riconosce automaticamente se la carta è Recluta o Eroe), rimuove il bianco puro e ripulisce frangia di anti-aliasing e pallini residui. Salva un PNG per pagina in `images/<nome_deck>_pageNN.png`.

Rinomina poi i PNG con l'`id` della carta (es. `images/patrizio.png`) prima di procedere allo Step 2.

**Variante senza PDF:** se `images/<id_carta>.png` esiste già (illustrazione pronta a mano, non estratta da PDF), `python 1_prepare_images.py <id_carta>` pulisce lo sfondo (no-op se è già pulito) e la ridimensiona in-place alle dimensioni standard. A questo punto si può passare direttamente allo Step 2.

**Manutenzione:** `python 1_prepare_images.py --clean [id...]` riapplica la sola pulizia sfondo a PNG già estratti in passato (es. dopo un fix all'algoritmo), senza rifare l'estrazione da PDF.

---

### Step 2 — Genera le carte finali

```bash
python 2_generate_cards.py                    # tutte le carte di ../data/cards.json
python 2_generate_cards.py faust joseph        # solo gli id indicati
python 2_generate_cards.py --scale 2           # 2x risoluzione (default 1 → 744×1039px, ~300 DPI)
```

Apre `assets/card.html` in un browser headless (Playwright), gli passa i dati di ogni
carta da `../data/cards.json`, incolla l'illustrazione da `images/<id>.png` (se presente)
e ne fotografa il risultato in `output/<card_id>.png`. `card.html` impagina tutto da solo —
nome, tipo, costo, statistiche, pannelli effetto, effetto orda — con auto-adattamento
del testo lungo. Per cambiare lo stile grafico si tocca solo `assets/card.html`: tutte le
carte si aggiornano insieme, senza coordinate da ritarare.

Le carte senza illustrazione corrispondente in `images/` vengono comunque generate (solo
la cornice con i testi, senza immagine). Il retro delle carte (`retro.png`) non è una
carta da gioco quindi non vive in `cards.json`: viene aggiunto in coda da `load_cards()`
(in `lib/cards_data.py`, costante `BACK_CARD`) e generato allo stesso modo dalle altre.

La risoluzione di default (300 DPI) è la stessa della vecchia pipeline: i PNG in `output/`
sono tracciati in git, quindi non conviene alzarla qui — per la stampa ad alta qualità
c'è lo Step 3, che rigenera le carte a parte senza appesantire il repo.

---

### Step 3 — Genera il PDF di stampa

```bash
python 3_make_print_pdf.py             # qualità massima (scala 4 → ~1200 DPI)
python 3_make_print_pdf.py --scale 6   # ancora più definito
```

Richiama `lib/render.py` e rigenera *tutte* le carte a risoluzione di stampa in
una cartella temporanea (senza toccare i PNG in `output/`), poi compone una coppia di
pagine per carta — back, carta — con un bordo monocromo di 3mm su tutti i lati (estratto
dal pixel più a sinistra in centro verticale, per simulare il bordo di taglio). Salva il
risultato in `output/cards_to_print.pdf`.

---

## Output

I PNG in `output/` sono già referenziati dal frontend di Barbacane. Una volta rigenerati basta sostituire i file nella stessa cartella; non serve toccare altro.
