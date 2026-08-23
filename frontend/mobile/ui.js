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
  },
};

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const Toast = {
  show(message, type = '') {
    const t = el('div', { className: `toast${type ? ' ' + type : ''}` }, [message]);
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3400);
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

  // -- drag-to-dismiss ------------------------------------------------------
  let dragStartY = null;
  let dragDelta = 0;

  function _bindDrag() {
    const grab = $('sheet-grab');
    const sheet = sheetEl();

    grab.addEventListener('touchstart', (e) => {
      if (_locked) return;
      dragStartY = e.touches[0].clientY;
      dragDelta = 0;
      sheet.classList.add('dragging');
    }, { passive: true });

    grab.addEventListener('touchmove', (e) => {
      if (dragStartY === null) return;
      dragDelta = Math.max(0, e.touches[0].clientY - dragStartY);
      sheet.style.transform = `translateY(${dragDelta}px)`;
    }, { passive: true });

    grab.addEventListener('touchend', () => {
      if (dragStartY === null) return;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (dragDelta > 90) close();
      dragStartY = null;
    });

    scrimEl().addEventListener('click', () => { if (!_locked) close(); });
  }

  document.addEventListener('DOMContentLoaded', _bindDrag);

  // -- API ------------------------------------------------------------------

  /**
   * Apre (o sostituisce il contenuto del) bottom sheet.
   * opts: { title, subtitle, body: Node|Node[]|string, footer: [{label, className, disabled, onClick}],
   *         locked: bool, onClose: fn }
   */
  function open(opts = {}) {
    const sheet = sheetEl();
    const scrim = scrimEl();

    _locked = !!opts.locked;
    _onClose = opts.onClose || null;
    sheet.classList.toggle('locked', _locked);

    $('sheet-title').textContent = opts.title || '';
    $('sheet-sub').textContent = opts.subtitle || '';

    const body = $('sheet-body');
    body.innerHTML = '';
    if (opts.body) {
      const items = Array.isArray(opts.body) ? opts.body : [opts.body];
      items.forEach(item => {
        if (typeof item === 'string') body.insertAdjacentHTML('beforeend', item);
        else if (item) body.appendChild(item);
      });
    }
    body.scrollTop = 0;

    const foot = $('sheet-foot');
    foot.innerHTML = '';
    (opts.footer || []).forEach(btn => {
      const b = el('button', { className: `mbtn ${btn.className || ''}` }, [btn.label]);
      b.disabled = !!btn.disabled;
      b.addEventListener('click', () => { haptic(); btn.onClick && btn.onClick(); });
      foot.appendChild(b);
    });

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

  return { open, close, isOpen, choice, confirm };
})();

// ---------------------------------------------------------------------------
// Confetti di fine partita
// ---------------------------------------------------------------------------

function spawnConfetti() {
  const box = $('confetti');
  if (!box || box.childElementCount > 0) return;
  const colors = ['#f0ce06', '#ff9a3d', '#4a9a58', '#4a7aaa', '#9966cc', '#e04040'];
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
