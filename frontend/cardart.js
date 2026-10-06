/**
 * cardart.js — Minicarte e anteprime, condivise dai client desktop e mobile.
 *
 * - Minicarta: la versione delle carte piccole (mano e campo), disegnata qui in
 *   HTML/CSS (classi .mc-* nei CSS dei due client), così i testi restano nitidi
 *   a ogni dimensione. Cornice del colore del tipo, stendardo con il nome,
 *   bollino della specie e Scuola (Magie e Maghe), illustrazione, fascia con le
 *   informazioni che cambiano (Caratteristiche correnti, torre della
 *   Costruzione, stella del Prodigio). Le immagini (illustrazione
 *   ridotta, pergamena) sono in /card_images/mini/, generate da card_factory.
 * - Anteprima (/card_images/preview/<id>.webp, ~30 KB): la carta intera
 *   rimpicciolita, per l'anteprima al passaggio del mouse e il catalogo.
 * Le viste ingrandite continuano a usare il PNG pieno (/card_images/full/<id>.png).
 */

'use strict';

const CardArt = (() => {
  // Immagini già scaricate: decodificate subito, senza un fotogramma vuoto a
  // ogni ridisegno.
  const loaded = new Set();

  const SCHOOLS = { anatema: 'Anatema', sortilegio: 'Sortilegio', incantesimo: 'Incantesimo' };
  const _cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');

  function previewUrl(baseId) {
    return `/card_images/preview/${encodeURIComponent(baseId)}.webp`;
  }

  function miniUrl(baseId) {
    return `/card_images/mini/${encodeURIComponent(baseId)}.webp`;
  }

  // Simboli delle carte stampate (card.html): torre delle Costruzioni e stella
  // delle Magie, vuote o piene. Il colore viene dal CSS (currentColor).
  const TOWER_PATH = 'M5 7 L5 4 L7 4 L7 6 L9 6 L9 4 L11 4 L11 6 L13 6 L13 4 L15 4 L15 6 L17 6 L17 4 L19 4 L19 7 L16.8 9 L16.3 14.5 L18.5 16.5 L19.5 20.5 L4.5 20.5 L5.5 16.5 L7.7 14.5 L7.2 9 Z';
  const STAR_PATH = 'M12 2l2.9 6.9 7.1.6-5.4 4.7 1.7 7L12 17.8 5.7 21.2l1.7-7L2 9.5l7.1-.6z';
  function _symbol(path, filled) {
    // Stesso contorno per pieno e vuoto: i due simboli hanno la stessa dimensione
    const paint = `fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"`;
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" ${paint}></path></svg>`;
  }

  function _el(tag, cls, text) {
    const d = document.createElement(tag);
    d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /**
   * Fascia in basso della minicarta, con lo stato corrente della carta:
   * - Guerriero: le tre Caratteristiche nei rombi, verdi se più alte di quelle
   *   stampate e rosse se più basse (info = il Guerriero in campo, o la carta).
   * - Costruzione: torre piena se completata, altrimenti il costo per
   *   completarla nell'esagono (info = { completed }).
   * - Magia: stella piena se giocandola ora si attiva il Prodigio (info = { prodigy }).
   * Ha la classe "card-keep": resta visibile sopra la carta testuale.
   */
  function _band(def, info) {
    info = info || {};
    const band = _el('div', `card-keep mc-band mc-${def.type}`);
    if (def.type === 'warrior') {
      [['att', 'ATT'], ['git', 'GIT'], ['dif', 'DIF']].forEach(([k, label]) => {
        const v = info[k] ?? def[k] ?? 0;
        const base = def[k] ?? 0;
        const s = _el('span', 'mc-dia' + (v > base ? ' up' : v < base ? ' down' : ''));
        s.appendChild(_el('b', '', String(v)));
        s.title = v === base ? `${label} ${v}` : `${label} ${v} (stampata ${base})`;
        band.appendChild(s);
      });
    } else if (def.type === 'building') {
      const done = !!info.completed;
      if (done) {
        const tower = _el('span', 'mc-sym');
        tower.innerHTML = _symbol(TOWER_PATH, true);
        band.appendChild(tower);
      } else if (!def.auto_complete) {
        band.appendChild(_el('span', 'mc-gem', String(def.completion_cost || 0)));
      }
      band.title = done ? 'Completata' : `Non completata: costo per completarla ${def.completion_cost}`;
    } else if (def.type === 'spell') {
      const star = _el('span', 'mc-sym');
      star.innerHTML = _symbol(STAR_PATH, !!info.prodigy);
      band.appendChild(star);
      band.title = info.prodigy ? 'Prodigio attivo' : 'Prodigio non attivo';
    }
    return band;
  }

  // Nome come sulla carta stampata: maiuscolo, con le iniziali più grandi
  function _nameNode(name) {
    const span = _el('span', '');
    [...String(name)].forEach(ch => {
      if (ch.toUpperCase() === ch && ch.toLowerCase() !== ch) span.appendChild(_el('span', 'ini', ch));
      else span.appendChild(document.createTextNode(ch));
    });
    return span;
  }

  // Riga sotto il nome: bollino della specie (Guerrieri) · Scuola (Magie e Maghe)
  function _kindLine(def) {
    const line = _el('div', 'mc-school');
    if (def.type === 'warrior' && def.species) {
      const dot = _el('span', `mc-dot mc-sp-${def.species}`);
      dot.title = _cap(def.species);
      line.appendChild(dot);
    }
    if (def.school) {
      if (line.firstChild) line.appendChild(_el('span', 'mc-sep', '·'));
      line.appendChild(_el('span', '', SCHOOLS[def.school] || _cap(def.school)));
    }
    return line;
  }

  // Parte fissa della minicarta: cornice, nome, specie/Scuola, illustrazione
  function _mini(def) {
    const root = _el('div', `card-art mc mc-${def.type}`);
    const name = _el('div', 'mc-name');
    // Nome abbreviato (mini_name in cards.json) per i pochi nomi troppo lunghi
    name.appendChild(_nameNode(def.mini_name || def.name || def.id));
    root.appendChild(name);
    root.appendChild(_kindLine(def));

    const hero = def.type === 'warrior' && !!def.evolves_from;
    const illus = _el('div', 'mc-illus' + (hero ? ' hero' : ''));
    const url = miniUrl(def.id);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = loaded.has(url) ? 'sync' : 'async';
    img.addEventListener('load', () => loaded.add(url));
    img.addEventListener('error', () => img.remove());
    img.src = url;
    illus.appendChild(img);
    root.appendChild(illus);
    return root;
  }

  /**
   * Trasforma una carta già costruita in versione testuale in minicarta: la
   * carta riceve la classe "has-art" (il CSS nasconde allora i testi, salvo il
   * badge del costo e gli elementi "card-keep") e sopra le compaiono la
   * minicarta e la fascia con lo stato corrente `info` (vedi _band).
   */
  function attach(cardEl, def, info) {
    if (!cardEl || !def || !def.id) return;
    cardEl.classList.add('has-art');
    cardEl.title = def.name || '';
    cardEl.appendChild(_mini(def));
    cardEl.appendChild(_band(def, info));
  }

  /** Ridisegna solo la fascia di una minicarta già costruita (es. carta in mano riusata). */
  function update(cardEl, def, info) {
    if (!cardEl || !def) return;
    const old = cardEl.querySelector(':scope > .mc-band');
    if (old) old.replaceWith(_band(def, info));
  }

  /**
   * Stato da mostrare sulla fascia di una carta in mano: Caratteristiche
   * stampate per i Guerrieri, Prodigio per le Magie (`prodigyReady` = elenco
   * dal server, public_state → prodigy_ready), torre vuota per le Costruzioni.
   */
  function handInfo(def, iid, prodigyReady) {
    if (!def) return null;
    if (def.type === 'spell') return { prodigy: (prodigyReady || []).includes(iid) };
    if (def.type === 'building') return { completed: false };
    return def;
  }

  /**
   * Scarica in sottofondo le immagini delle carte indicate (prima pergamena e
   * illustrazioni delle minicarte, ~1 MB in tutto, poi le anteprime), così una
   * carta appena pescata ha già la sua immagine anche mentre vola in mano. Va
   * chiamata entrando in partita.
   */
  let preloading = false;
  function preload(baseIds) {
    if (preloading) return;
    preloading = true;
    const ids = baseIds || [];
    const queue = [miniUrl('sfondo'), ...ids.map(miniUrl), ...ids.map(previewUrl)].filter(u => !loaded.has(u));
    const idle = window.requestIdleCallback || (cb => setTimeout(cb, 200));
    const next = () => {
      const batch = queue.splice(0, 6);
      if (!batch.length) return;
      let pending = batch.length;
      batch.forEach(url => {
        const img = new Image();
        img.onload = () => { loaded.add(url); if (--pending === 0) idle(next); };
        img.onerror = () => { if (--pending === 0) idle(next); };
        img.src = url;
      });
    };
    idle(next);
  }

  return { previewUrl, miniUrl, attach, update, handInfo, preload };
})();
