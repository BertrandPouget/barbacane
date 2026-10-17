/**
 * drag.js — Giocare le carte trascinandole dalla mano al campo, condiviso dai
 * client desktop e mobile.
 *
 * Il client chiama start/move/end con le coordinate del puntatore (mouse sul
 * desktop, dito sul mobile); qui vivono la copia della carta che segue il
 * puntatore, le zone illuminate e il ritorno in mano se la carta viene lasciata
 * fuori. Dove si può giocare una carta lo dice zonesFor; cosa succede al rilascio
 * lo decide il client (onDrop).
 *
 * Se onDrop ha già mandato l'azione, la copia resta dov'è stata lasciata finché
 * arriva il nuovo stato: Motion.snapshot la ritira (takeDrop) e fa partire da lì
 * il volo verso il campo. Se il server rifiuta la giocata il client chiama
 * reject() e la carta torna subito in mano (senza risposta, dopo PENDING_MS).
 * Se invece al rilascio si apre una scelta (bersagli, Recluta da evolvere…:
 * opts.choiceOpen), la copia aspetta lì, sotto la finestra: quando il client
 * manda l'azione (sent) si comporta come sopra, se la scelta viene chiusa
 * senza mandare nulla torna in mano.
 *
 * Zone: 'bastion_left' | 'vanguard' | 'bastion_right' | 'village' (elementi del
 * client), 'field' per le Magie, che si giocano portandole verso il centro del
 * campo (opts.fieldTest), e 'warriors' per il Trono, che va su un Guerriero:
 * il client decide come (desktop: sul Guerriero; mobile: come una Magia).
 */

'use strict';

const DragPlay = (() => {
  const REGIONS = ['bastion_left', 'vanguard', 'bastion_right'];
  let s = null;        // trascinamento in corso
  let pending = null;  // carta lasciata, in attesa del nuovo stato
  const PENDING_MS = 2500;
  const CHOICE_POLL_MS = 150;

  function _warriorsIn(player, region) {
    const f = player.field;
    return (region === 'vanguard' ? f.vanguard : (f[region] || {}).warriors) || [];
  }

  /**
   * Zone in cui si può giocare la carta `def` del giocatore `player`:
   * Reclute nelle tre Regioni, Eroi dove c'è una Recluta che evolve in loro,
   * Costruzioni nel Villaggio, il Trono su un Guerriero, Magie verso il campo.
   */
  function zonesFor(def, player, getCardDef) {
    if (!def || !player) return [];
    if (def.type === 'spell') return ['field'];
    if (def.type === 'building') {
      if (def.id !== 'trono') return ['village'];
      return REGIONS.some(r => _warriorsIn(player, r).length > 0) ? ['warriors'] : [];
    }
    if (def.type === 'warrior') {
      if (def.subtype !== 'hero') return REGIONS.slice();
      return REGIONS.filter(r => _warriorsIn(player, r).some(w => {
        const d = getCardDef(w.instance_id);
        return d && d.evolves_into === def.id;
      }));
    }
    return [];
  }

  /** Tutti i Guerrieri del giocatore. */
  function warriorsOf(player) {
    return REGIONS.flatMap(r => _warriorsIn(player, r));
  }

  /**
   * Inizia il trascinamento della carta `cardEl` dal punto (x, y).
   * opts.zones     [{ key, el, quiet }]: zone dove la carta si può lasciare
   *                (quiet: non illuminata finché la carta non ci è sopra)
   * opts.fieldTest (x, y) → bool: per le Magie, la carta è abbastanza dentro il
   *                campo; (x, y) è il centro della carta trascinata (sul mobile sta
   *                sopra il dito, vedi lift)
   * opts.noGlow    la carta non si accende sopra una zona (non si può giocare:
   *                lasciata lì torna in mano con l'errore)
   * opts.lift      di quanto la carta sta sopra il puntatore (frazione dell'altezza;
   *                sul mobile il dito non deve coprirla)
   * opts.onDrop(key) chiamata al rilascio su una zona valida; ritorna true se ha
   *                già mandato l'azione, 'land' se la carta resta nella zona senza
   *                azione (es. un Muro posato, da confermare): la copia ci sparisce dentro
   * opts.choiceOpen () → bool: è aperta una scelta (selettore, conferma) nata dal
   *                rilascio; finché lo è la carta aspetta dove è stata lasciata
   * opts.extras    [cardEl]: altre carte della mano portate insieme (Muri impilati):
   *                volano dal loro posto sotto la carta trascinata e la seguono
   */
  function start(cardEl, x, y, opts) {
    cancel();
    _releasePending();
    const w = cardEl.offsetWidth, h = cardEl.offsetHeight;
    const ghost = _makeGhost(cardEl, w, h);
    document.body.appendChild(ghost);
    // Sotto la carta trascinata, ognuna sotto la precedente (stesso z-index:
    // conta l'ordine nel documento)
    let above = ghost;
    const extras = (opts.extras || []).map(el => {
      const g = _makeGhost(el, w, h);
      document.body.insertBefore(g, above);
      above = g;
      el.classList.add('drag-source');
      return { cardEl: el, ghost: g, from: el.getBoundingClientRect() };
    });
    cardEl.classList.add('drag-source');
    document.body.classList.add('dragging-card');
    (opts.zones || []).forEach(z => { if (!z.quiet) z.el.classList.add('drop-zone'); });
    s = { cardEl, ghost, w, h, opts, over: null, extras };
    move(x, y);
    _gather(extras);
  }

  function _makeGhost(cardEl, w, h) {
    const ghost = cardEl.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.remove('drag-source', 'peeked');
    ghost.classList.add('motion-ghost', 'drag-ghost');
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
    ghost.style.opacity = '';
    ghost.style.margin = '0';  // le carte in mano hanno un margine inline (sovrapposizione del ventaglio)
    return ghost;
  }

  // Le carte al seguito partono dal loro posto in mano e raggiungono la pila
  function _gather(extras) {
    if (typeof Motion !== 'undefined' && Motion.reducedMotion()) return;
    extras.forEach(({ ghost, from }, i) => {
      const to = ghost.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      ghost.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 200, delay: i * 50, easing: 'cubic-bezier(.2, .75, .25, 1)', fill: 'backwards' });
    });
  }

  // Carta trascinata e carte al seguito: [{ cardEl, ghost }]
  function _all(cur) {
    return [{ cardEl: cur.cardEl, ghost: cur.ghost }, ...(cur.extras || [])];
  }

  function move(x, y) {
    if (!s) return;
    const { ghost, w, h, opts } = s;
    const left = x - w / 2, top = y - h / 2 - h * (opts.lift || 0);
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    // La pila: le carte sotto, allineate, sporgono appena in alto
    s.extras.forEach(({ ghost: g }, i) => {
      const off = (i + 1) * Math.max(3, h * 0.05);
      g.style.left = `${left}px`;
      g.style.top = `${top - off}px`;
    });
    let over = null;
    for (const z of opts.zones || []) {
      const r = z.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { over = z; break; }
    }
    if (!over && opts.fieldTest && opts.fieldTest(x, y - h * (opts.lift || 0))) over = { key: 'field', el: null };
    if ((over && over.el) !== (s.over && s.over.el)) {
      if (s.over && s.over.el) s.over.el.classList.remove('drop-over');
      if (over && over.el) over.el.classList.add('drop-over');
    }
    s.over = over;
    _all(s).forEach(c => c.ghost.classList.toggle('drop-ok', !!over && !opts.noGlow));
  }

  function _cleanup() {
    const cur = s;
    s = null;
    (cur.opts.zones || []).forEach(z => z.el.classList.remove('drop-zone', 'drop-over'));
    document.body.classList.remove('dragging-card');
    return cur;
  }

  /** Rilascio in (x, y): gioca la carta se è su una zona valida, altrimenti torna in mano. */
  function end(x, y) {
    if (!s) return false;
    move(x, y);
    const cur = _cleanup();
    _all(cur).forEach(c => c.cardEl.classList.remove('drag-source'));
    if (!cur.over) { _flyBack(cur); return false; }
    const res = cur.opts.onDrop(cur.over.key);
    if (res === 'land') { _land(cur); return true; }
    if (res) {
      _all(cur).forEach(c => c.cardEl.classList.add('drag-pending'));
      pending = { ...cur, timer: setTimeout(_releasePending, PENDING_MS), poll: null };
      return true;
    }
    if (cur.opts.choiceOpen && cur.opts.choiceOpen()) {
      // Si sceglie: la carta aspetta sotto la finestra della scelta
      _all(cur).forEach(c => {
        c.cardEl.classList.add('drag-pending');
        c.ghost.classList.add('drag-held');
      });
      pending = { ...cur, timer: null, poll: null };
      pending.poll = setInterval(() => { if (!cur.opts.choiceOpen()) _releasePending(); }, CHOICE_POLL_MS);
      return true;
    }
    _flyBack(cur);
    return true;
  }

  function _clearPending() {
    const cur = pending;
    pending = null;
    clearTimeout(cur.timer);
    clearInterval(cur.poll);
    _all(cur).forEach(c => {
      c.cardEl.classList.remove('drag-pending');
      c.ghost.classList.remove('drag-held');
    });
    return cur;
  }

  function _releasePending() {
    if (!pending) return;
    _flyBack(_clearPending());
  }

  /**
   * Il client ha mandato un'azione: se la carta aspettava la fine di una scelta,
   * ora aspetta il nuovo stato (vedi takeDrop).
   */
  function sent() {
    if (!pending || !pending.poll) return;
    clearInterval(pending.poll);
    pending.poll = null;
    _all(pending).forEach(c => c.ghost.classList.remove('drag-held'));
    pending.timer = setTimeout(_releasePending, PENDING_MS);
  }

  /**
   * Per Motion.snapshot: ritira le copie delle carte appena lasciate (con quelle
   * al seguito) e dice da dove deve partire il loro volo ([{ iid, rect }]), o null.
   */
  function takeDrop() {
    // Durante una scelta un aggiornamento qualsiasi non la riguarda: resta lì
    if (!pending || pending.poll) return null;
    return _all(_clearPending()).map(({ cardEl, ghost }) => {
      const rect = ghost.getBoundingClientRect();
      ghost.remove();
      return { iid: cardEl.dataset.instanceId, rect };
    });
  }

  // Le copie rimpiccioliscono verso il centro della zona e spariscono
  function _land(cur) {
    const zone = cur.over && cur.over.el ? cur.over.el.getBoundingClientRect() : null;
    _all(cur).forEach(({ ghost }) => {
      const done = () => ghost.remove();
      if (!zone || (typeof Motion !== 'undefined' && Motion.reducedMotion())) { done(); return; }
      const g = ghost.getBoundingClientRect();
      const dx = zone.left + zone.width / 2 - (g.left + g.width / 2);
      const dy = zone.top + zone.height / 2 - (g.top + g.height / 2);
      const anim = ghost.animate(
        [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 }],
        { duration: 260, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
      anim.onfinish = done;
      anim.oncancel = done;
    });
  }

  function _flyBack(cur) {
    _all(cur).forEach(_flyBackOne);
  }

  function _flyBackOne({ ghost, cardEl }) {
    ghost.classList.remove('drop-ok');
    const done = () => { ghost.remove(); cardEl.classList.remove('drag-source'); };
    const from = ghost.getBoundingClientRect();
    const to = cardEl.isConnected ? cardEl.getBoundingClientRect() : null;
    if (!to || !to.width || (typeof Motion !== 'undefined' && Motion.reducedMotion())) { done(); return; }
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const anim = ghost.animate(
      [{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px)` }],
      { duration: 220, easing: 'cubic-bezier(.2, .75, .25, 1)', fill: 'forwards' });
    anim.onfinish = done;
    anim.oncancel = done;
  }

  function cancel() {
    if (!s) return;
    const cur = _cleanup();
    _all(cur).forEach(c => {
      c.ghost.remove();
      c.cardEl.classList.remove('drag-source');
    });
  }

  const active = () => !!s;

  // Giocata rifiutata dal server: la carta lasciata torna subito in mano
  const reject = _releasePending;

  return { zonesFor, warriorsOf, start, move, end, cancel, active, takeDrop, reject, sent };
})();
