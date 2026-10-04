/**
 * cardart.js — Miniature delle carte, condivise dai client desktop e mobile.
 *
 * Le miniature sono WebP leggeri (~30 KB) generati da card_factory
 * (4_make_miniatures.py) in card_factory/output/miniature/, serviti come
 * /card_images/miniature/<id>.webp. Le viste ingrandite continuano a usare il
 * PNG pieno (/card_images/<id>.png).
 */

'use strict';

const CardArt = (() => {
  // Miniature già scaricate: la carta mostra subito l'immagine, senza passare
  // per un fotogramma della versione testuale a ogni ridisegno della mano.
  const loaded = new Set();

  function miniatureUrl(baseId) {
    return `/card_images/miniature/${encodeURIComponent(baseId)}.webp`;
  }

  /**
   * Aggiunge la miniatura a una carta già costruita in versione testuale.
   * La carta riceve la classe "has-art" (il CSS nasconde allora i testi, salvo
   * il badge del costo) solo quando l'immagine è disponibile: se manca, resta
   * la versione testuale.
   */
  function attach(cardEl, def) {
    if (!cardEl || !def || !def.id) return;
    const img = document.createElement('img');
    img.className = 'card-art';
    img.alt = def.name || def.id;
    img.draggable = false;
    // Già scaricata: decodifica immediata, così la carta non resta vuota per un fotogramma
    img.decoding = loaded.has(def.id) ? 'sync' : 'async';
    if (loaded.has(def.id)) cardEl.classList.add('has-art');
    img.addEventListener('load', () => {
      loaded.add(def.id);
      cardEl.classList.add('has-art');
    });
    img.addEventListener('error', () => {
      cardEl.classList.remove('has-art');
      img.remove();
    });
    img.src = miniatureUrl(def.id);
    cardEl.title = def.name || '';
    cardEl.appendChild(img);
  }

  /**
   * Scarica in sottofondo le miniature delle carte indicate (tutto il mazzo
   * pesa ~2 MB), così una carta appena pescata ha già la sua immagine anche
   * mentre vola in mano. Va chiamata entrando in partita.
   */
  let preloading = false;
  function preload(baseIds) {
    if (preloading) return;
    preloading = true;
    const queue = (baseIds || []).filter(id => !loaded.has(id));
    const idle = window.requestIdleCallback || (cb => setTimeout(cb, 200));
    const next = () => {
      const batch = queue.splice(0, 6);
      if (!batch.length) return;
      let pending = batch.length;
      batch.forEach(id => {
        const img = new Image();
        img.onload = () => { loaded.add(id); if (--pending === 0) idle(next); };
        img.onerror = () => { if (--pending === 0) idle(next); };
        img.src = miniatureUrl(id);
      });
    };
    idle(next);
  }

  return { miniatureUrl, attach, preload };
})();
