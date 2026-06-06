# Card Factory

Mini-progetto autonomo all'interno di Barbacane. Legge i dati delle carte da `../data/cards.json` (la stessa fonte che alimenta il motore di gioco) e produce i PNG finali pronti da usare nell'interfaccia.

```
input/          ← PDF delle illustrazioni (da creare / aggiungere tu)
images/         ← PNG estratti dallo step 2
output/         ← PNG carte finali → usati dal frontend di Barbacane
assets/
  templates/    ← template PNG per ogni tipo di carta (recruit, hero, spell, building)
  fonts/        ← STIXTwoText (Regular, Italic, Medium)
```

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

Dipendenze: `PyMuPDF`, `numpy`, `Pillow`.

---

## Pipeline

### Step 1 — Ritaglia e normalizza il PDF

```bash
python 1_resize_input.py <nome_deck>
# es. python 1_resize_input.py deck_color  →  legge input/deck_color.pdf
```

Rileva automaticamente il bounding box del contenuto sulla prima pagina, ritaglia i margini bianchi e ridimensiona ogni pagina a **63 × 88 mm**. Salva in-place su `input/`.

---

### Step 2 — Estrai le illustrazioni

```bash
python 2_extract_images.py <nome_deck>
# es. python 2_extract_images.py deck_color  →  legge input/deck_color.pdf
```

Per ogni pagina del PDF estrae la finestra illustrazione (riconosce automaticamente se la carta è Recluta o Eroe), rimuove il bianco puro e salva un PNG con trasparenza in `images/<nome_deck>_pageNN.png`.

Rinomina poi i PNG con l'`id` della carta (es. `images/patrizio.png`) prima di procedere allo step 3.

---

### Step 3 — Genera le carte finali

```bash
python 3_generate_cards.py
```

Nessun argomento: legge `../data/cards.json`, abbina ogni carta al suo template in `assets/templates/`, incolla l'illustrazione da `images/`, scrive testi (nome, statistiche, effetti, costo) con i font STIX e salva il PNG finale in `output/<card_id>.png`.

Le carte senza illustrazione corrispondente in `images/` vengono comunque generate (solo il template con testi, senza immagine).

---

## Output

I PNG in `output/` sono già referenziati dal frontend di Barbacane. Una volta rigenerati basta sostituire i file nella stessa cartella; non serve toccare altro.
