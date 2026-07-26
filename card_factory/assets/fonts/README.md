# Font

La grafica usa **Caudex** (regular/bold, con corsivo).

## Online (default)

`card.html` carica il font da Google Fonts tramite `<link>`. Se generi con accesso a
internet non devi fare nulla: funziona subito.

## Offline / dentro la repo

Per non dipendere dalla rete, scarica i file da Google Fonts (famiglia Caudex) e
mettili in questa cartella (`assets/fonts/`):

- `Caudex-Regular.ttf`
- `Caudex-Bold.ttf`
- `Caudex-Italic.ttf`
- `Caudex-BoldItalic.ttf`

poi **sostituisci il `<link>` di Google in `card.html`** (che vive in `assets/`, quindi
`fonts/` è una sottocartella diretta) con questo blocco `<style>`:

```html
<style>
  @font-face{font-family:'Caudex';font-weight:400;font-style:normal;
    src:url('fonts/Caudex-Regular.ttf');}
  @font-face{font-family:'Caudex';font-weight:700;font-style:normal;
    src:url('fonts/Caudex-Bold.ttf');}
  @font-face{font-family:'Caudex';font-weight:400;font-style:italic;
    src:url('fonts/Caudex-Italic.ttf');}
  @font-face{font-family:'Caudex';font-weight:700;font-style:italic;
    src:url('fonts/Caudex-BoldItalic.ttf');}
</style>
```

Se manca un file, il browser ripiega su un serif di sistema per quel peso/stile.
