/**
 * ui.js — Primitivi UI del client mobile di Barbacane.
 * Sheet (bottom sheet), toast, banner turno, schermate, haptics, helper DOM.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helper DOM
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (k === 'className') node.className = v;
    else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => node.dataset[dk] = dv);
    else if (k === 'style' && typeof v === 'string') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else if (c) node.appendChild(c);
  });
  return node;
}

function $(id) { return document.getElementById(id); }

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function haptic(ms = 12) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Schermate
// ---------------------------------------------------------------------------

const Screens = {
  show(name) {
    document.querySelectorAll('.scr').forEach(s => s.classList.remove('active'));
    const t = $(`scr-${name}`);
    if (t) t.classList.add('active');
    // Il documento non scorre (app shell, vedi mobile.css): riporta in cima
    // gli scroller interni della schermata appena mostrata.
    if (t) {
      t.scrollTop = 0;
      t.querySelectorAll('*').forEach(n => { if (n.scrollTop) n.scrollTop = 0; });
    }
    if (window.Sparks) Sparks.setScreen(name);
    placeMusicToggle(name);
  },
};

// In partita, nel catalogo e nelle schermate di scelta il pulsante
// musica vive nell'header della schermata (rispettivamente accanto a "Esci" e
// speculare a "←"); altrove resta fisso in alto a destra, come sul desktop.
const MUSIC_HOME_CLASSES = ['in-header', 'in-catalog-header'];

function placeMusicToggle(name) {
  const btn = $('btn-music-toggle');
  if (!btn) return;

  // Nella splash c'è solo il logo da toccare: il pulsante compare dopo.
  btn.hidden = (name === 'splash');

  let target = null;
  let cls = null;
  if (name === 'game') {
    target = document.querySelector('#topbar .tb-right');
    cls = 'in-header';
  } else if (name === 'catalog') {
    target = $('cat-head');
    cls = 'in-catalog-header';
  } else if (name === 'bot-difficulty') {
    target = $('bot-diff-head');
    cls = 'in-catalog-header';
  } else if (name === 'multi') {
    target = $('multi-head');
    cls = 'in-catalog-header';
  } else if (name === 'wait') {
    target = $('wait-head');
    cls = 'in-catalog-header';
  }

  if (target) {
    if (btn.parentElement !== target) target.appendChild(btn);
    MUSIC_HOME_CLASSES.forEach(c => btn.classList.toggle(c, c === cls));
  } else if (MUSIC_HOME_CLASSES.some(c => btn.classList.contains(c))) {
    document.body.appendChild(btn);
    MUSIC_HOME_CLASSES.forEach(c => btn.classList.remove(c));
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

// Un messaggio uguale a uno ancora visibile non si ripete: si allunga la sua durata
const Toast = {
  _shown: new Map(),  // testo -> { el, timer }
  show(message, type = '') {
    const key = `${type}|${message}`;
    const prev = this._shown.get(key);
    if (prev && prev.el.isConnected) {
      clearTimeout(prev.timer);
      prev.timer = setTimeout(() => { prev.el.remove(); this._shown.delete(key); }, 3400);
      return;
    }
    const t = el('div', { className: `toast${type ? ' ' + type : ''}` }, [message]);
    $('toasts').appendChild(t);
    const entry = { el: t, timer: null };
    entry.timer = setTimeout(() => { t.remove(); this._shown.delete(key); }, 3400);
    this._shown.set(key, entry);
  },
};

// ---------------------------------------------------------------------------
// Banner turno / fase
// ---------------------------------------------------------------------------

const TurnBanner = {
  _timer: null,
  show(text, subtle = false) {
    const banner = $('turn-banner');
    const span = $('turn-banner-text');
    clearTimeout(this._timer);
    banner.hidden = true;
    // forza il replay dell'animazione
    void banner.offsetWidth;
    span.textContent = text;
    banner.classList.toggle('subtle', subtle);
    banner.hidden = false;
    this._timer = setTimeout(() => { banner.hidden = true; }, 1950);
  },
};

// ---------------------------------------------------------------------------
// Sheet — bottom sheet unico, con contenuto sostituibile e drag-to-dismiss
// ---------------------------------------------------------------------------

const Sheet = (() => {
  const sheetEl = () => $('sheet');
  const scrimEl = () => $('scrim');

  let _open = false;
  let _locked = false;
  let _onClose = null;
  // Sheet di consultazione: funzione che lo riapre con lo stato nuovo (vedi refresh)
  let _refresh = null;
  let _refreshing = false;
  let _opens = 0;
  let _sig = '';

  // -- drag-to-dismiss ------------------------------------------------------
  // Si trascina giù da qualsiasi punto dello sheet: dal corpo solo se è già in
  // cima e il dito scende, altrimenti il corpo scorre normalmente. Un tocco
  // senza movimento resta un tocco (pulsanti, carte).
  let dragStartY = null;
  let dragDelta = 0;
  let dragging = false;
  let dragFromBody = false;

  function _bindDrag() {
    const sheet = sheetEl();
    const body = () => $('sheet-body');

    const start = (y, target) => {
      if (_locked) return;
      dragFromBody = body().contains(target);
      if (dragFromBody && body().scrollTop > 0) return;
      dragStartY = y;
      dragDelta = 0;
      dragging = false;
    };
    // Ritorna true se il gesto è un trascinamento dello sheet
    const move = (y) => {
      if (dragStartY === null) return false;
      const d = y - dragStartY;
      if (!dragging) {
        // Dal corpo, un dito che sale vuol dire scorrere: niente trascinamento
        if (d < 0 && dragFromBody) { dragStartY = null; return false; }
        if (d < 8) return false;
        dragging = true;
        sheet.classList.add('dragging');
      }
      dragDelta = Math.max(0, d);
      sheet.style.transform = `translateY(${dragDelta}px)`;
      return true;
    };
    const end = () => {
      if (dragStartY === null) return;
      dragStartY = null;
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (dragDelta > 90) close();
    };

    // Dito
    sheet.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) start(e.touches[0].clientY, e.target);
    }, { passive: true });
    // Non passivo: durante il trascinamento il gesto non deve scorrere la pagina
    // (Safari su iPhone altrimenti se lo prende e lo sheet non segue il dito)
    sheet.addEventListener('touchmove', (e) => {
      if (move(e.touches[0].clientY) && e.cancelable) e.preventDefault();
    }, { passive: false });
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', end);
    // Mouse (la versione mobile aperta da computer)
    sheet.addEventListener('mousedown', (e) => { if (e.button === 0) start(e.clientY, e.target); });
    window.addEventListener('mousemove', (e) => move(e.clientY));
    window.addEventListener('mouseup', end);

    scrimEl().addEventListener('click', () => { if (!_locked) close(); });
  }

  document.addEventListener('DOMContentLoaded', _bindDrag);

  // -- API ------------------------------------------------------------------

  /**
   * Apre (o sostituisce il contenuto del) bottom sheet.
   * opts: { title, subtitle, body: Node|Node[]|string, footer: [{label, className, disabled, onClick}],
   *         locked: bool, onClose: fn,
   *         refresh: fn — solo per gli sheet di consultazione: lo riapre con lo stato
   *                  nuovo; con questa opzione lo sheet resta aperto quando arriva un
   *                  aggiornamento della partita invece di essere chiuso (vedi refresh()) }
   */
  function open(opts = {}) {
    const sheet = sheetEl();
    const scrim = scrimEl();
    _opens++;

    // Contenuto nuovo costruito fuori dallo sheet: in un aggiornamento si confronta
    // con quello mostrato e, se è uguale, lo sheet non viene toccato.
    const newBody = document.createElement('div');
    if (opts.body) {
      const items = Array.isArray(opts.body) ? opts.body : [opts.body];
      items.forEach(item => {
        if (typeof item === 'string') newBody.insertAdjacentHTML('beforeend', item);
        else if (item) newBody.appendChild(item);
      });
    }
    const footer = opts.footer || [];
    const sig = JSON.stringify([opts.title || '', opts.subtitle || '', newBody.innerHTML,
      footer.map(btn => [btn.label, btn.className || '', !!btn.disabled])]);
    const updating = _refreshing && _open;
    _refresh = opts.refresh || null;
    if (updating && sig === _sig) return;
    _sig = sig;

    _locked = !!opts.locked;
    _onClose = opts.onClose || null;
    sheet.classList.toggle('locked', _locked);

    $('sheet-title').textContent = opts.title || '';
    $('sheet-sub').textContent = opts.subtitle || '';

    const body = $('sheet-body');
    const scroll = body.scrollTop;
    body.innerHTML = '';
    while (newBody.firstChild) body.appendChild(newBody.firstChild);
    body.scrollTop = updating ? scroll : 0;

    const foot = $('sheet-foot');
    foot.innerHTML = '';
    footer.forEach(btn => {
      const b = el('button', { className: `mbtn ${btn.className || ''}` }, [btn.label]);
      b.disabled = !!btn.disabled;
      b.addEventListener('click', () => { haptic(); btn.onClick && btn.onClick(); });
      foot.appendChild(b);
    });
    if (updating) return;

    scrim.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(() => {
      scrim.classList.add('show');
      sheet.classList.add('show');
    });
    _open = true;
  }

  function close(silent = false) {
    if (!_open) return;
    const sheet = sheetEl();
    const scrim = scrimEl();
    _open = false;
    _locked = false;
    _refresh = null;
    sheet.classList.remove('show', 'locked');
    scrim.classList.remove('show');
    setTimeout(() => {
      if (!_open) { sheet.hidden = true; scrim.hidden = true; }
    }, 400);
    const cb = _onClose;
    _onClose = null;
    if (cb && !silent) cb();
  }

  function isOpen() { return _open; }

  /** Impedisce (o riconsente) di chiudere lo sheet aperto trascinandolo o toccando fuori. */
  function lock(on) {
    _locked = !!on;
    sheetEl().classList.toggle('locked', _locked);
  }

  /**
   * Aggiorna lo sheet aperto dopo un aggiornamento della partita, se è di
   * consultazione (aperto con opts.refresh): lo riapre con lo stato nuovo tenendo
   * lo scorrimento; se ciò che mostrava non c'è più (la funzione non riapre nulla)
   * lo chiude. Ritorna false se lo sheet aperto non è aggiornabile.
   */
  function refresh() {
    if (!_open || !_refresh) return false;
    const fn = _refresh;
    const before = _opens;
    _refreshing = true;
    try { fn(); } finally { _refreshing = false; }
    if (_opens === before) close(true);
    return true;
  }

  /**
   * Sheet di scelta: lista di righe tappabili. Il tap sceglie subito.
   * options: [{label, sub, icon, value, className, disabled}]
   * opts: { subtitle, locked, cancelLabel (default 'Annulla'; null = nessun bottone),
   *         keepOpen: non chiudere dopo la scelta, onCancel }
   */
  function choice(title, options, onChoice, opts = {}) {
    const rows = options.map(opt => {
      const row = el('button', { className: `opt-row ${opt.className || ''}` }, [
        opt.icon ? el('span', { className: 'opt-icon' }, [opt.icon]) : null,
        el('span', { className: 'opt-main' }, [
          el('span', { className: 'opt-label' }, [opt.label]),
          opt.sub ? el('span', { className: 'opt-sub', style: 'display:block' }, [opt.sub]) : null,
        ]),
        el('span', { className: 'opt-chevron' }, ['›']),
      ]);
      row.disabled = !!opt.disabled;
      row.addEventListener('click', () => {
        haptic();
        if (!opts.keepOpen) close(true);
        onChoice(opt.value);
      });
      return row;
    });

    const footer = [];
    if (opts.cancelLabel !== null && !opts.locked) {
      footer.push({
        label: opts.cancelLabel || 'Annulla',
        onClick: () => { close(true); opts.onCancel && opts.onCancel(); },
      });
    }
    if (opts.locked && opts.cancelLabel) {
      // sheet bloccato ma con un'uscita esplicita (es. "Salta")
      footer.push({
        label: opts.cancelLabel,
        onClick: () => { close(true); opts.onCancel && opts.onCancel(); },
      });
    }

    open({
      title,
      subtitle: opts.subtitle,
      body: rows,
      footer,
      locked: opts.locked,
      onClose: opts.onCancel,
    });
  }

  /** Conferma sì/no. */
  function confirm(title, bodyHTML, onYes, opts = {}) {
    open({
      title,
      subtitle: opts.subtitle,
      body: bodyHTML ? [`<div class="sheet-note">${bodyHTML}</div>`] : [],
      footer: [
        { label: opts.noLabel || 'Annulla', onClick: () => { close(true); opts.onNo && opts.onNo(); } },
        {
          label: opts.yesLabel || 'Conferma',
          className: opts.danger ? 'mbtn-danger' : 'mbtn-gold',
          onClick: () => { close(true); onYes && onYes(); },
        },
      ],
      locked: opts.locked,
    });
  }

  return { open, close, isOpen, lock, refresh, choice, confirm };
})();

// ---------------------------------------------------------------------------
// Confetti di fine partita
// ---------------------------------------------------------------------------

function spawnConfetti() {
  const box = $('confetti');
  if (!box || box.childElementCount > 0) return;
  const colors = ['#fbc402', '#ff9a3d', '#4a9a58', '#4a7aaa', '#9966cc', '#e04040'];
  for (let i = 0; i < 34; i++) {
    const c = el('i', {
      style: `left:${Math.random() * 100}vw;` +
        `background:${colors[i % colors.length]};` +
        `animation-duration:${3.2 + Math.random() * 3.4}s;` +
        `animation-delay:${Math.random() * 2.4}s;` +
        `transform:rotate(${Math.random() * 360}deg);`,
    });
    box.appendChild(c);
  }
}
