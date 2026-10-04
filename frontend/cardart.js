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

  function _div(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /**
   * Miniatura per una carta in campo. Le Caratteristiche stampate sulla carta
   * non bastano: in campo cambiano (carte assegnate, Orde, Costruzioni...),
   * quindi sopra l'immagine compare una fascia con i valori correnti, verdi se
   * più alti di quelli stampati e rossi se più bassi. Una Costruzione non
   * completata appare spenta, con il nastro «Incompleta».
   * Gli elementi aggiunti hanno la classe "card-keep": restano visibili sopra
   * l'immagine (il CSS di .has-art nasconde tutto il resto).
   */
  function attachField(cardEl, def, current) {
    if (!cardEl || !def || !def.id) return;
    attach(cardEl, def);
    if (def.type === 'warrior' && current) {
      const band = _div('card-keep card-field-stats');
      [['att', 'ATT'], ['git', 'GIT'], ['dif', 'DIF']].forEach(([k, label]) => {
        const v = current[k] ?? 0;
        const base = def[k] ?? 0;
        const s = _div('cfs-stat' + (v > base ? ' up' : v < base ? ' down' : ''), String(v));
        s.title = v === base ? `${label} ${v}` : `${label} ${v} (stampata ${base})`;
        band.appendChild(s);
      });
      cardEl.appendChild(band);
    } else if (def.type === 'building' && current && !current.completed) {
      cardEl.classList.add('incomplete');
      cardEl.appendChild(_div('card-keep card-field-tag', 'Incompleta'));
    }
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

  return { miniatureUrl, attach, attachField, preload };
})();
