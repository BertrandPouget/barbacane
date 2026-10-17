/**
 * motion.js — Transizioni delle carte tra un aggiornamento di stato e l'altro,
 * condivise dai client desktop e mobile.
 *
 * Il client ridisegna l'interfaccia da zero a ogni state_update. Per non far
 * "saltare" le carte, prima del ridisegno si fotografano gli elementi con
 * data-instance-id (snapshot) e dopo si confrontano con quelli nuovi (play):
 *
 * - carta presente prima e dopo in un altro punto (mano → campo, riposizionamento,
 *   carta rubata): un "fantasma" vola dalla vecchia alla nuova posizione;
 * - carta comparsa (pescata, schierata da un avversario): entra dalla sorgente
 *   indicata da opts.sourceFor (es. il mazzo) o, in mancanza, appare sul posto;
 * - carta sparita (diventata Muro o Vita, Magia lanciata, Guerriero scartato):
 *   il fantasma vola verso opts.targetFor (es. il Bastione) o si dissolve.
 *
 * Per le carte che non sono disegnate (il campo riassunto degli avversari sul
 * desktop) ci sono travel (da un elemento a un altro) e vanish (si dissolve).
 *
 * I fantasmi vivono in un livello fisso sopra l'interfaccia, così il volo non
 * viene tagliato dai contenitori che scorrono (mano, righe delle Regioni).
 * Con "riduci movimento" attivo nel sistema non si anima nulla.
 */

'use strict';

const Motion = (() => {
  const EASE = 'cubic-bezier(.2, .75, .25, 1)';
  const MOVE_MS = 480;
  const ENTER_MS = 420;
  const LEAVE_MS = 520;
  const STAGGER_MS = 70;

  let layer = null;
  let running = [];  // fantasmi in volo: chiusi se arriva un nuovo aggiornamento

  function reducedMotion() {
    return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function _layer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.className = 'motion-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function _visibleRect(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  /**
   * Rettangolo di una carta senza le sue proprietà CSS rotate/translate (es. la
   * mano a ventaglio), più l'inclinazione (`tilt`) che i fantasmi riproducono:
   * spostamento {x, y} del centro e angolo `a`, attorno al centro della carta.
   * getBoundingClientRect di una carta ruotata darebbe il riquadro che la
   * contiene, più grande e spostato.
   */
  function _pose(el) {
    const r = _visibleRect(el);
    if (!r) return null;
    const cs = getComputedStyle(el);
    const rot = /(-?[\d.]+)deg/.exec(cs.rotate || '');
    const a = rot ? parseFloat(rot[1]) : 0;
    const tr = cs.translate && cs.translate !== 'none' ? cs.translate.split(' ').map(parseFloat) : [];
    const tx = tr[0] || 0, ty = tr[1] || 0;
    if (!a && !tx && !ty) return { rect: r, tilt: null };
    const ow = el.offsetWidth, oh = el.offsetHeight;
    const rad = a * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    // Scala tra misure CSS e schermo (zoom dei contenitori)
    const k = r.width / (ow * Math.abs(cos) + oh * Math.abs(sin)) || 1;
    const w = ow * k, h = oh * k;
    // Ruotando attorno a transform-origin (q, misurato dal centro) il centro si sposta
    const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
    const qx = ox * k - w / 2, qy = oy * k - h / 2;
    const x = qx - (qx * cos - qy * sin) + tx * k;
    const y = qy - (qx * sin + qy * cos) + ty * k;
    const cx = r.left + r.width / 2 - x, cy = r.top + r.height / 2 - y;
    return { rect: { left: cx - w / 2, top: cy - h / 2, width: w, height: h }, tilt: { x, y, a } };
  }

  /** Fotografa posizione e aspetto delle carte dentro `root`. */
  function snapshot(root) {
    const items = new Map();
    // Carte appena giocate trascinandole (drag.js): il volo parte da dove sono state lasciate
    const drops = new Map(((typeof DragPlay !== 'undefined' && DragPlay.takeDrop()) || [])
      .map(d => [d.iid, d.rect]));
    if (!root || reducedMotion()) return items;
    root.querySelectorAll('[data-instance-id]').forEach(el => {
      const iid = el.dataset.instanceId;
      const pose = _pose(el);
      if (!iid || !pose || items.has(iid)) return;
      const node = el.cloneNode(true);
      node.style.opacity = '';  // la carta può essere nascosta da un volo ancora in corso
      if (drops.has(iid)) items.set(iid, { rect: drops.get(iid), tilt: null, node });
      else items.set(iid, { rect: pose.rect, tilt: pose.tilt, node });
    });
    return items;
  }

  function _finishRunning() {
    running.forEach(fn => fn());
    running = [];
  }

  /** Crea un fantasma (copia di `node`) posizionato su `rect`. */
  function _ghost(node, rect) {
    const g = node.cloneNode(true);
    g.removeAttribute('id');
    g.classList.add('motion-ghost');
    g.style.margin = '0';  // le carte in mano hanno un margine inline (sovrapposizione del ventaglio)
    // Il fantasma deve avere la sua immagine pronta fin dal primo fotogramma
    g.querySelectorAll('img').forEach(img => { img.decoding = 'sync'; img.loading = 'eager'; });
    // Carta con immagine: il fantasma la mostra anche se l'originale non aveva
    // ancora finito di caricarla (es. una carta appena pescata)
    if (g.querySelector('.card-art')) g.classList.add('has-art');
    g.style.left = `${rect.left}px`;
    g.style.top = `${rect.top}px`;
    g.style.width = `${rect.width}px`;
    g.style.height = `${rect.height}px`;
    _layer().appendChild(g);
    return g;
  }

  // Trasformazione che porta un elemento di rettangolo `from` sul rettangolo `to`
  // (con `t` < 1, solo quella frazione del tragitto). Le inclinazioni
  // `fromTilt`/`toTilt` (vedi _pose) si interpolano lungo il volo.
  const NO_TILT = { x: 0, y: 0, a: 0 };
  function _toward(from, to, t = 1, fromTilt = null, toTilt = null) {
    const f = fromTilt || NO_TILT, g = toTilt || NO_TILT;
    const dx = (to.left + to.width / 2 - from.left - from.width / 2) * t + f.x + (g.x - f.x) * t;
    const dy = (to.top + to.height / 2 - from.top - from.height / 2) * t + f.y + (g.y - f.y) * t;
    const a = f.a + (g.a - f.a) * t;
    const s = Math.max(0.15, Math.min(to.width / from.width, to.height / from.height));
    return `translate(${dx}px, ${dy}px) rotate(${a}deg) scale(${1 + (s - 1) * t})`;
  }

  function _hide(el) {
    el.style.opacity = '0';
    return () => { el.style.opacity = ''; };
  }

  function _fly(ghostNode, from, to, { duration, delay = 0, fadeOut = false, onDone, fromTilt = null, toTilt = null }) {
    const g = _ghost(ghostNode, from);
    const at = t => _toward(from, to, t, fromTilt, toTilt);
    // Chi sparisce resta ben visibile per gran parte del volo e sfuma solo all'arrivo
    const keyframes = fadeOut ? [
      { transform: at(0), opacity: 1 },
      { transform: at(0.75), opacity: 1, offset: 0.7 },
      { transform: at(1), opacity: 0 },
    ] : [
      { transform: at(0), opacity: 1 },
      { transform: at(1), opacity: 1 },
    ];
    const anim = g.animate(keyframes, { duration, delay, easing: EASE, fill: 'both' });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Prima ricompare la carta vera, poi (al fotogramma dopo) sparisce il
      // fantasma: così non c'è un istante in cui non si vede nessuno dei due.
      if (onDone) onDone();
      requestAnimationFrame(() => g.remove());
    };
    anim.onfinish = finish;
    anim.oncancel = finish;
    running.push(() => { anim.cancel(); });
  }

  /**
   * Anima il passaggio dalla fotografia `before` al contenuto attuale di `root`.
   * opts.sourceFor(iid, el) → elemento da cui far entrare una carta nuova (o null)
   * opts.targetFor(iid)     → elemento verso cui far volare una carta sparita (o null)
   * opts.onLand(el)         → chiamata quando una carta arriva su quell'elemento
   */
  function play(before, root, opts = {}) {
    _finishRunning();
    if (!before || !root || reducedMotion()) return;

    const after = new Map();
    root.querySelectorAll('[data-instance-id]').forEach(el => {
      const iid = el.dataset.instanceId;
      if (iid && !after.has(iid)) after.set(iid, el);
    });

    let entering = 0;
    after.forEach((el, iid) => {
      const pose = _pose(el);
      if (!pose) return;
      const { rect, tilt } = pose;
      const prev = before.get(iid);

      if (prev) {
        const moved = Math.abs(prev.rect.left - rect.left) > 3 || Math.abs(prev.rect.top - rect.top) > 3
          || Math.abs(prev.rect.width - rect.width) > 3
          || Math.abs((prev.tilt || NO_TILT).a - (tilt || NO_TILT).a) > 0.5;
        if (!moved) return;
        // Il fantasma ha l'aspetto di prima (es. la carta in mano) e atterra
        // sulla carta nuova, che compare quando arriva.
        const reveal = _hide(el);
        _fly(prev.node, prev.rect, rect, { duration: MOVE_MS, onDone: reveal, fromTilt: prev.tilt, toTilt: tilt });
        return;
      }

      // Carta nuova: entra dalla sorgente, se c'è, altrimenti appare sul posto
      const sourceEl = opts.sourceFor ? opts.sourceFor(iid, el) : null;
      const source = sourceEl ? _visibleRect(sourceEl) : null;
      const delay = entering++ * STAGGER_MS;
      if (source) {
        const from = {
          left: source.left + source.width / 2 - rect.width / 2,
          top: source.top + source.height / 2 - rect.height / 2,
          width: rect.width, height: rect.height,
        };
        const reveal = _hide(el);
        const g = el.cloneNode(true);
        g.style.opacity = '';
        _fly(g, from, rect, { duration: ENTER_MS, delay, onDone: reveal, toTilt: tilt });
      } else {
        el.animate([
          { transform: 'scale(0.6)', opacity: 0 },
          { transform: 'scale(1.06)', opacity: 1, offset: 0.7 },
          { transform: 'none', opacity: 1 },
        ], { duration: ENTER_MS, delay, easing: EASE, fill: 'backwards' });
      }
    });

    before.forEach((prev, iid) => {
      if (after.has(iid)) return;
      const targetEl = opts.targetFor ? opts.targetFor(iid) : null;
      const target = targetEl ? _visibleRect(targetEl) : null;
      if (target) {
        // Si rimpicciolisce verso il centro della destinazione e sparisce lì
        const w = prev.rect.width * 0.35;
        const h = prev.rect.height * 0.35;
        const to = { left: target.left + target.width / 2 - w / 2, top: target.top + target.height / 2 - h / 2, width: w, height: h };
        _fly(prev.node, prev.rect, to, {
          duration: LEAVE_MS, fadeOut: true, fromTilt: prev.tilt,
          onDone: () => { if (opts.onLand && targetEl.isConnected) opts.onLand(targetEl); },
        });
      } else {
        // Nessuna destinazione visibile (Magia lanciata, carta scartata): si dissolve salendo
        const to = {
          left: prev.rect.left - prev.rect.width * 0.1, top: prev.rect.top - 40,
          width: prev.rect.width * 1.2, height: prev.rect.height * 1.2,
        };
        _fly(prev.node, prev.rect, to, { duration: LEAVE_MS, fadeOut: true, fromTilt: prev.tilt });
      }
    });
  }

  // Rettangolo di lato size.w × size.h centrato sull'elemento
  function _centeredOn(el, size) {
    const r = _visibleRect(el);
    return r ? { left: r.left + r.width / 2 - size.w / 2, top: r.top + r.height / 2 - size.h / 2, width: size.w, height: size.h } : null;
  }

  /**
   * Carta che non è disegnata sul tavolo (es. il campo riassunto di un avversario
   * sul desktop): un fantasma `node` grande size {w, h} parte dal centro di `fromEl`,
   * vola verso il centro di `toEl` rimpicciolendosi e sparisce lì.
   * opts: { size, delay, onLand(toEl) }
   */
  function travel(node, fromEl, toEl, opts = {}) {
    if (reducedMotion() || !node || !fromEl || !toEl) return;
    const size = opts.size || { w: 99, h: 143 };
    const from = _centeredOn(fromEl, size);
    const to = _centeredOn(toEl, { w: size.w * 0.35, h: size.h * 0.35 });
    if (!from || !to) return;
    _fly(node, from, to, {
      duration: MOVE_MS + 120, delay: opts.delay || 0, fadeOut: true,
      onDone: () => { if (opts.onLand && toEl.isConnected) opts.onLand(toEl); },
    });
  }

  /** Come travel, ma la carta compare su `atEl` e si dissolve salendo (scartata). */
  function vanish(node, atEl, opts = {}) {
    if (reducedMotion() || !node || !atEl) return;
    const size = opts.size || { w: 99, h: 143 };
    const from = _centeredOn(atEl, size);
    if (!from) return;
    const to = { left: from.left - size.w * 0.1, top: from.top - 40, width: size.w * 1.2, height: size.h * 1.2 };
    _fly(node, from, to, { duration: LEAVE_MS, delay: opts.delay || 0, fadeOut: true });
  }

  /** Breve impulso su un elemento (es. la Regione dove è appena arrivata una carta). */
  function pulse(el) {
    if (!el || reducedMotion()) return;
    el.animate([
      { boxShadow: '0 0 0 0 rgba(251, 196, 2, 0)' },
      { boxShadow: '0 0 0 3px rgba(251, 196, 2, 0.55)', offset: 0.35 },
      { boxShadow: '0 0 0 0 rgba(251, 196, 2, 0)' },
    ], { duration: 600, easing: 'ease-out' });
  }

  /**
   * Dove si trova ora una carta del giocatore `playerId` nello stato pubblico:
   * 'hand' | 'vanguard' | 'bastion_left' | 'bastion_right' | 'wall_left' |
   * 'wall_right' | 'village' | 'life' | null (non in vista: scarti, mazzo…).
   */
  function locate(state, playerId, iid) {
    const p = state && state.players && state.players.find(x => x.id === playerId);
    if (!p) return null;
    if ((p.hand || []).includes(iid)) return 'hand';
    if ((p.life_cards || []).includes(iid)) return 'life';
    const f = p.field || {};
    const holds = w => w.instance_id === iid || (w.assigned_cards || []).some(a => (a.instance_id || a) === iid);
    if ((f.vanguard || []).some(holds)) return 'vanguard';
    for (const side of ['left', 'right']) {
      const b = f[`bastion_${side}`] || {};
      if ((b.walls || []).includes(iid)) return `wall_${side}`;
      if ((b.warriors || []).some(holds)) return `bastion_${side}`;
    }
    if (((f.village || {}).buildings || []).some(b => b.instance_id === iid)) return 'village';
    return null;
  }

  return { snapshot, play, travel, vanish, pulse, locate, reducedMotion };
})();
