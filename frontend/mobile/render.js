/**
 * render.js — Rendering dello stato di gioco per il client mobile.
 * Costruisce l'intestazione (turno, mazzo, fasi, le mie risorse), il campo a
 * triangoli (board.js) con i nomi degli avversari e la mano a ventaglio.
 * Negli sheet le carte usano il markup del desktop con le minicarte.
 * I gesti/flussi sono delegati a Mob (app.js).
 */

'use strict';

const Render = (() => {

  const SPECIES_ICON = { elfo: '🌿', nano: '⛏️', maga: '🔮', umano: '🛡️' };

  const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 5 6.4 5c2 0 3.6 1.1 4.6 2.6C12 6.1 13.6 5 15.6 5 19 5 21.1 8.4 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>';
  const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.6 12S5.6 5.2 12 5.2 22.4 12 22.4 12 18.4 18.8 12 18.8 1.6 12 1.6 12z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.3" fill="currentColor"/></svg>';

  // ---------------------------------------------------------------------------
  // Render principale
  // ---------------------------------------------------------------------------

  /** viewId: giocatore di cui si guarda il campo (null = il mio). */
  function game(state, myId, viewId = null) {
    if (!state) return;
    topbar(state);

    const me = state.players.find(p => p.id === myId);
    if (!me) return;

    field(state, myId, viewId);
    statusbar(me);
    hand(me);
  }

  // ---------------------------------------------------------------------------
  // Intestazione: turno, mazzo, fasi
  // ---------------------------------------------------------------------------

  const PHASES = ['action', 'schieramento', 'battaglia'];

  function topbar(state) {
    $('tb-turn').textContent = `T${state.turn}`;
    $('tb-deck-n').textContent = state.deck_count;

    const idx = PHASES.indexOf(state.phase);
    document.querySelectorAll('#tb-phase .ph-dot').forEach(dot => {
      const i = PHASES.indexOf(dot.dataset.ph);
      dot.classList.toggle('on', i === idx);
      dot.classList.toggle('done', idx >= 0 && i < idx);
    });
  }

  function phaseDimmed(dimmed) {
    $('tb-phase').classList.toggle('dimmed', dimmed);
  }

  /**
   * Fasi toccabili: con canAdvance quelle dopo la corrente portano lì (app.js);
   * la successiva ha l'id per il tutorial e, con ready, pulsa (fase finita).
   */
  function phaseControls(phase, canAdvance, ready) {
    const idx = PHASES.indexOf(phase);
    document.querySelectorAll('#tb-phase .ph-dot').forEach(dot => {
      const i = PHASES.indexOf(dot.dataset.ph);
      const ahead = canAdvance && idx >= 0 && i > idx;
      dot.disabled = !ahead;
      dot.classList.toggle('ahead', ahead);
      const next = ahead && i === idx + 1;
      if (next) dot.id = 'tb-next-phase';
      else dot.removeAttribute('id');
      dot.classList.toggle('ready', next && ready);
    });
  }

  // ---------------------------------------------------------------------------
  // Timer: barra sotto l'intestazione
  // ---------------------------------------------------------------------------

  let _timerTotal = 120;

  function timerStart(total) { _timerTotal = Math.max(1, total); }

  function timer(secondsLeft) {
    const box = $('tb-timer');
    box.hidden = false;
    $('tb-timer-num').textContent = secondsLeft;
    const frac = Math.max(0, Math.min(1, secondsLeft / _timerTotal));
    $('timer-bar').style.transform = `scaleX(${frac.toFixed(3)})`;
    box.classList.toggle('urgent', secondsLeft <= 15);
  }

  function timerHide() {
    const box = $('tb-timer');
    box.hidden = true;
    box.classList.remove('urgent');
  }

  // ---------------------------------------------------------------------------
  // Carte — stesso markup del desktop (renderer.js), usate negli sheet
  // ---------------------------------------------------------------------------

  // Usate dagli sheet di app.js (Regioni, avversari): la versione testuale
  // con sopra la minicarta, come renderWarriorCard/renderBuildingCard del desktop.
  function warriorMini(w) {
    const div = el('div', {
      className: 'card card-sm in-field',
      dataset: { type: 'warrior', instanceId: w.instance_id, baseId: w.base_card_id },
    });
    if (w.horde_active) div.classList.add('horde-active');
    if (w.assigned_cards && w.assigned_cards.length > 0) div.classList.add('has-assigned');

    div.appendChild(el('div', { className: 'card-name' }, [w.name || w.base_card_id]));
    div.appendChild(el('div', {
      className: `card-species species-${w.species}`
    }, [capitalize(w.species || '')]));

    const stats = el('div', { className: 'card-stats' });
    stats.appendChild(el('span', { className: 'stat stat-att' }, [`🗡️${w.att}`]));
    stats.appendChild(el('span', { className: 'stat stat-git' }, [`🏹${w.git}`]));
    stats.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡️${w.dif}`]));
    div.appendChild(stats);
    // Minicarta con le Caratteristiche correnti
    CardArt.attach(div, Mob.getCardDef(w.instance_id), w);
    CardArt.attachAssigned(div, w.assigned_cards, Mob.getCardDef);
    return div;
  }

  function buildingMini(b, ethereal) {
    const div = el('div', {
      className: `card card-sm in-field${b.completed ? ' completed' : ''}${ethereal ? ' ethereal' : ''}`,
      dataset: { type: 'building', instanceId: b.instance_id, baseId: b.base_card_id },
    });
    div.appendChild(el('div', { className: 'card-name' }, [b.name || b.base_card_id]));
    div.appendChild(el('div', { className: 'card-species' }, [b.completed ? '✓ Completa' : '— Incompleta']));
    // Minicarta con la torre piena o vuota
    CardArt.attach(div, Mob.getCardDef(b.instance_id), b);
    return div;
  }


  // Mazzo coperto (es. i Muri di un Bastione avversario): il dorso della carta
  // con, sotto la scritta, un riquadro marrone e il numero di carte dentro un
  // simbolo. Parità con renderDeck di renderer.js (desktop).
  const DECK_SHAPES = {
    wall:   '<rect x="2.5" y="2.5" width="19" height="19" rx="3"/>',
    life:   '<path d="M12 22 10.5 20.6C5.2 15.8 1.5 12.5 1.5 8.4 1.5 5.1 4.1 2.5 7.4 2.5c1.8 0 3.6.9 4.6 2.3 1-1.4 2.8-2.3 4.6-2.3 3.3 0 5.9 2.6 5.9 5.9 0 4.1-3.7 7.4-9 12.2L12 22z"/>',
    active: '<path d="M12 0 15.6 8.4 24 12 15.6 15.6 12 24 8.4 15.6 0 12 8.4 8.4z"/>',
  };

  function deckNode(kind, count) {
    const div = el('div', { className: `card card-sm in-field deck deck-${kind}`, dataset: { type: 'deck' } });
    div.appendChild(el('img', { className: 'deck-back', alt: '', draggable: 'false', src: '/card_images/mini/retro.webp' }));
    const badge = el('div', { className: 'deck-count' });
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DECK_SHAPES[kind]}</svg>`;
    badge.appendChild(el('span', {}, [String(count)]));
    div.appendChild(badge);
    return div;
  }

  // ---------------------------------------------------------------------------
  // Campo — le Regioni del giocatore osservato e dei suoi vicini (board.js)
  // ---------------------------------------------------------------------------

  // Vicini vivi più prossimi a sinistra e a destra di un giocatore: gli
  // eliminati vengono saltati. Il Bastione destro di X confina col sinistro
  // del primo vivo alla sua destra (successivo in state.players).
  function aliveNeighbors(state, playerId) {
    const ps = state.players;
    const n = ps.length;
    const i = ps.findIndex(p => p.id === playerId);
    const step = d => {
      let j = i;
      for (let k = 0; k < n - 1; k++) {
        j = (j + d + n) % n;
        if ((ps[j].lives ?? 0) > 0) return ps[j];
      }
      return null;
    };
    return { left: step(-1), right: step(1) };
  }

  function _maxStat(warriors, key) {
    if (!warriors || warriors.length === 0) return 0;
    return Math.max(...warriors.map(w => w[key] || 0));
  }

  // Numeri di una Regione per board.js (le Costruzioni assegnate a un
  // Guerriero, es. Trono, si vedono sul Guerriero e non contano nel Villaggio)
  function regionSlot(p, region) {
    const f = p.field;
    if (region === 'vanguard') {
      const ws = f.vanguard || [];
      return { ownerId: p.id, data: { att: _maxStat(ws, 'att'), git: _maxStat(ws, 'git'), species: ws.map(w => w.species) } };
    }
    if (region === 'village') {
      const bs = ((f.village && f.village.buildings) || []).filter(b => !b.assigned_warrior);
      const done = bs.filter(b => b.completed).length;
      return { ownerId: p.id, data: { incomplete: bs.length - done, complete: done } };
    }
    const b = region === 'bastion_left' ? f.bastion_left : f.bastion_right;
    const ws = b.warriors || [];
    return {
      ownerId: p.id,
      data: {
        walls: b.wall_count ?? (b.walls || []).length,
        dif: _maxStat(ws, 'dif'), git: _maxStat(ws, 'git'), species: ws.map(w => w.species),
      },
    };
  }

  function field(state, myId, viewId) {
    const center = state.players.find(p => p.id === viewId) || state.players.find(p => p.id === myId);
    const { left, right } = aliveNeighbors(state, center.id);
    const slots = {
      c_vanguard: regionSlot(center, 'vanguard'),
      c_village: regionSlot(center, 'village'),
      c_bastion_left: regionSlot(center, 'bastion_left'),
      c_bastion_right: regionSlot(center, 'bastion_right'),
      // Il vicino di sinistra espone il suo Bastione destro, quello di destra il sinistro
      l_bastion: left && regionSlot(left, 'bastion_right'),
      l_vanguard: left && regionSlot(left, 'vanguard'),
      l_village: left && regionSlot(left, 'village'),
      r_bastion: right && regionSlot(right, 'bastion_left'),
      r_vanguard: right && regionSlot(right, 'vanguard'),
      r_village: right && regionSlot(right, 'village'),
    };

    const hot = new Set(), target = new Set(), quiet = new Set();
    if (center.id === myId) {
      // Nel mio turno le mie Regioni cambiano per le mie mosse: si illuminano
      // quando ci arriva la carta (transizioni in app.js), non subito
      if (state.current_player_id === myId) {
        ['c_vanguard', 'c_village', 'c_bastion_left', 'c_bastion_right'].forEach(k => quiet.add(k));
      }
      // Schieramento: le mie Regioni con Guerrieri da spostare
      if (state.current_player_id === myId && state.phase === 'schieramento') {
        ['c_vanguard', 'c_bastion_left', 'c_bastion_right'].forEach(k => {
          if (slots[k].data.species.length > 0) hot.add(k);
        });
      }
      // Battaglia: i Bastioni esposti che posso attaccare ora
      if (Mob.canAttackNow()) {
        const keys = Mob.attackTargetKeys();
        if (left && keys.has(`${left.id}:right`)) target.add('l_bastion');
        if (right && keys.has(`${right.id}:left`)) target.add('r_bastion');
      }
    }
    Board.update(slots, { hot, target, quiet });
    opponents(state, myId, center.id, left, right);
  }

  // ---------------------------------------------------------------------------
  // Nomi degli altri giocatori sopra il campo: i vicini sopra i loro Bastioni,
  // in alto al centro gli altri (e l'unico avversario di una partita a due)
  // ---------------------------------------------------------------------------

  function heartsNode(lives, cls) {
    const n = Math.max(0, lives ?? 0);
    const box = el('span', { className: cls, role: 'img', 'aria-label': `${n} ${n === 1 ? 'Vita' : 'Vite'}` });
    box.innerHTML = HEART_SVG.repeat(Math.min(n, 4));
    if (n > 4) box.appendChild(el('b', {}, [`×${n}`]));
    return box;
  }

  function opponentLabel(state, p, pos, myId) {
    const dead = (p.lives ?? 0) <= 0;
    const isMe = p.id === myId;
    const turn = p.id === state.current_player_id && !state.winner_id;
    const label = el('div', {
      className: `opp-label ${pos}${turn ? ' turn' : ''}${dead ? ' dead' : ''}${isMe ? ' me' : ''}`,
      dataset: { playerId: p.id },
    });

    // Il nome apre la scheda del giocatore; il mio riporta al mio campo
    const name = el('button', { className: 'opp-name', type: 'button' }, [p.name]);
    name.addEventListener('click', () => {
      haptic();
      if (isMe) Mob.setView(null);
      else Mob.openOpponentSheet(p.id);
    });
    label.appendChild(name);

    const sub = el('div', { className: 'opp-sub' });
    if (dead) {
      sub.appendChild(el('span', { className: 'opp-out' }, ['Eliminato']));
    } else {
      sub.appendChild(heartsNode(p.lives, 'opp-hearts'));
      const fx = isMe ? 0 : activeEffectItems(p).length;
      if (fx > 0) sub.appendChild(el('span', { className: 'opp-fx' }, [`✨${fx}`]));
      // Occhio: il campo visto dalla sua parte (nel tutorial no: c'è un solo campo da seguire)
      if (!Mob.isTutorial()) {
        const eye = el('button', {
          className: 'opp-eye', type: 'button',
          'aria-label': isMe ? 'Torna al tuo campo' : `Guarda il campo di ${p.name}`,
        });
        eye.innerHTML = EYE_SVG;
        eye.addEventListener('click', () => { haptic(); Mob.setView(isMe ? null : p.id); });
        sub.appendChild(eye);
      }
    }
    label.appendChild(sub);
    return label;
  }

  function opponents(state, myId, centerId, left, right) {
    const single = !!left && !!right && left.id === right.id;
    const nodes = [];
    if (!single) {
      if (left) nodes.push(opponentLabel(state, left, 'pos-l', myId));
      if (right) nodes.push(opponentLabel(state, right, 'pos-r', myId));
    }
    // In alto al centro: l'unico avversario di una partita a due, poi chi non
    // confina (prima i vivi, in ordine di posto), poi gli eliminati
    const ps = state.players;
    const ci = Math.max(0, ps.findIndex(p => p.id === centerId));
    const bySeat = ps.map((_, k) => ps[(ci + 1 + k) % ps.length]).filter(p => p.id !== centerId);
    const sides = new Set(single ? [] : [left && left.id, right && right.id]);
    const top = single ? [left] : [];
    bySeat.filter(p => (p.lives ?? 0) > 0).forEach(p => { if (!sides.has(p.id) && !top.includes(p)) top.push(p); });
    bySeat.forEach(p => { if (!sides.has(p.id) && !top.includes(p)) top.push(p); });
    if (top.length) {
      nodes.push(el('div', { className: 'opp-top' }, top.map(p => opponentLabel(state, p, 'pos-c', myId))));
    }
    $('opp-rail').replaceChildren(...nodes);
  }

  function flashOpponent(playerId) {
    document.querySelectorAll(`.opp-label[data-player-id="${CSS.escape(playerId)}"]`).forEach(label => {
      label.classList.remove('damaged');
      void label.offsetWidth;
      label.classList.add('damaged');
    });
  }

  // ---------------------------------------------------------------------------
  // Le mie risorse (seconda riga dell'intestazione)
  // ---------------------------------------------------------------------------

  let _prevMana = null;
  let _prevActs = null;

  function _bump(id) {
    const item = $(id);
    item.classList.remove('bump');
    void item.offsetWidth;
    item.classList.add('bump');
  }

  function statusbar(me) {
    // Azioni: un rombo per ognuna rimasta, vuoti quelli usati fino alle 2 del
    // turno; oltre 3 (effetti, modalità Test) un rombo solo con il numero
    const acts = me.actions_remaining ?? 0;
    $('st-actions').querySelector('.st-pips').innerHTML = acts > 3 ? `<i></i><b>×${acts}</b>`
      : '<i></i>'.repeat(acts) + '<i class="off"></i>'.repeat(Math.max(0, 2 - acts));
    $('st-actions').setAttribute('aria-label', `Azioni: ${acts}`);
    if (_prevActs !== null && acts !== _prevActs) _bump('st-actions');
    _prevActs = acts;

    const hearts = $('st-lives').querySelector('.st-hearts');
    hearts.replaceWith(heartsNode(me.lives, 'st-hearts'));

    const mana = me.mana_remaining ?? 0;
    $('st-mana-n').textContent = mana;
    $('st-mana').setAttribute('aria-label', `Mana: ${mana}`);
    if (_prevMana !== null && mana !== _prevMana) _bump('st-mana');
    _prevMana = mana;

    const fxItems = activeEffectItems(me);
    const fxBtn = $('st-fx');
    fxBtn.hidden = fxItems.length === 0;
    fxBtn.textContent = `✨ ${fxItems.length}`;
  }

  const ACTIVE_EFFECT_CONFIG = {
    'spell_immune':            { baseCardId: 'magiscudo',    label: 'Magiscudo',    desc: () => 'Le Magie non hanno effetto su di te fino al prossimo turno.' },
    'guerremoto':              { baseCardId: 'guerremoto',   label: 'Guerremoto',   desc: ef => `Puoi attaccare qualsiasi Bastione${ef.discard_walls ? ` (scarta fino a ${ef.discard_walls} Muri prima dei Danni)` : ''}.` },
    'investimento_deferred':   { baseCardId: 'investimento', label: 'Investimento', desc: ef => `+${ef.mana || 2} Mana all'inizio del prossimo turno.` },
    'divinazione_base':        { baseCardId: 'divinazione',  label: 'Divinazione',  desc: () => '+1 Mana a inizio prossimo turno.' },
    'divinazione_all_mage':    { baseCardId: 'divinazione',  label: 'Divinazione',  desc: () => '+1 Mana per ogni tua Maga a inizio prossimo turno.' },
    'equipotenza_own':         { baseCardId: 'equipotenza',  label: 'Equipotenza',  desc: () => 'Un tuo Guerriero ha le statistiche livellate ai valori più alti in campo.' },
  };

  function activeEffectItems(player) {
    const seen = new Set();
    const items = [];
    for (const ef of (player.active_effects || [])) {
      const cfg = ACTIVE_EFFECT_CONFIG[ef.type];
      if (!cfg || seen.has(cfg.baseCardId)) continue;
      seen.add(cfg.baseCardId);
      items.push({ baseCardId: cfg.baseCardId, label: cfg.label, desc: cfg.desc(ef) });
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // Mano — carte intere a ventaglio, che escono un poco dai lati dello schermo
  // ---------------------------------------------------------------------------

  // Carte della mano dell'ultimo ridisegno, per riusarle: ricreare le immagini a
  // ogni aggiornamento le farebbe sparire per un fotogramma (sfarfallio).
  let _handNodes = new Map();  // iid -> { node, ethereal }

  function hand(me) {
    const wrap = $('hand');
    const cards = me.hand || [];
    if (cards.length === 0) {
      _handNodes = new Map();
      wrap.replaceChildren(el('div', { className: 'hand-empty' }, ['Mano vuota']));
      return;
    }
    const etherealCard = me.ethereal_card || null;
    const next = new Map();
    const nodes = cards.map(iid => {
      const ethereal = etherealCard === iid;
      const prev = _handNodes.get(iid);
      let node;
      if (prev && prev.ethereal === ethereal) {
        node = prev.node;
        node.classList.remove('wall-marked');  // le carte girate le rigira app.js (applyWallFlips)
        node.style.opacity = '';
      } else {
        node = handCard(iid, ethereal);
      }
      next.set(iid, { node, ethereal });
      return node;
    });
    wrap.replaceChildren(...nodes);
    _handNodes = next;
    fanHand(nodes);
  }

  // Mano a ventaglio: ogni carta ruota attorno a un punto sotto il proprio fondo e
  // quelle ai lati scendono un poco, lungo un arco. Rotate/translate stanno in
  // proprietà CSS separate da transform, che resta libero per :active e
  // animazioni (motion.js, che legge l'inclinazione per i fantasmi). Le carte si
  // sovrappongono quanto serve: dai lati dello schermo escono solo gli angoli in
  // basso, la parte scoperta di ogni carta resta da afferrare anche a metà altezza.
  function fanHand(nodes = [...document.querySelectorAll('#hand .card')]) {
    const n = nodes.length;
    if (!n) return;
    const step = n > 1 ? Math.min(5.2, 26 / (n - 1)) : 0;  // apertura totale massima 26°
    const cardW = nodes[0].offsetWidth, cardH = nodes[0].offsetHeight;
    // Ruotando attorno a un punto 0,2 altezze sotto la carta, a 2/3 d'altezza le
    // carte ai lati si spostano verso l'esterno di tanto: il ventaglio ne rientra
    const tilt = Math.sin((step * (n - 1) / 2) * Math.PI / 180) * cardH * 0.85;
    const avail = $('hand').clientWidth - 2 * (tilt + 6);
    let shown = cardW * 0.6;  // parte di ogni carta non coperta dalla successiva
    if (n > 1 && cardW + (n - 1) * shown > avail) shown = Math.max(6, (avail - cardW) / (n - 1));
    nodes.forEach((node, i) => {
      const rot = (i - (n - 1) / 2) * step;
      node.style.setProperty('--fan-rot', `${rot.toFixed(2)}deg`);
      node.style.setProperty('--fan-y', `${(cardH * rot * rot * 0.0008).toFixed(1)}px`);
      node.style.marginLeft = i ? `${(shown - cardW).toFixed(1)}px` : '';
    });
  }

  // Carta in mano: l'immagine intera della carta stampata; dietro, il dorso,
  // che si vede quando la carta è girata per diventare un Muro (CardArt.flipWall)
  function handCard(iid, ethereal) {
    const def = Mob.getCardDef(iid);
    const div = el('div', {
      className: `card hand-card${ethereal ? ' ethereal' : ''}`,
      dataset: { instanceId: iid, baseId: def ? def.id : '' },
    });
    if (def) {
      div.title = def.name;
      const img = el('img', { className: 'hc-img', alt: def.name, draggable: 'false' });
      CardArt.setPreview(img, def.id);
      div.appendChild(img);
    } else {
      div.appendChild(el('div', { className: 'hc-missing' }, [iid]));
    }
    div.appendChild(el('img', { className: 'mc-back', alt: '', draggable: 'false', src: '/card_images/preview/retro.webp' }));
    div.addEventListener('click', () => Mob.onHandTap(iid));
    return div;
  }


  // ---------------------------------------------------------------------------
  // Flashcard testuale di una carta (corpo condiviso da tutti gli sheet)
  // ---------------------------------------------------------------------------

  function cardTextHTML(def, ctx = {}) {
    if (!def) return `<div class="ct-dim">${ctx.instanceId || 'Carta sconosciuta'}</div>`;
    let html = '';

    if (def.type === 'warrior') {
      const att = ctx.att ?? def.att, git = ctx.git ?? def.git, dif = ctx.dif ?? def.dif;
      html += `<div class="ct-meta">
        <span class="sp-${def.species}" style="color:var(--${def.species})">${SPECIES_ICON[def.species] || ''} ${capitalize(def.species)}</span>
        ${def.school ? ` · ${capitalize(def.school)}` : ''}
        · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'} · 💎${def.cost} Mana
      </div>
      <div class="ct-stats">
        <span class="c-att">🗡️ ${att}</span><span class="c-git">🏹 ${git}</span><span class="c-dif">🛡️ ${dif}</span>
      </div>`;
      if (def.horde_effect) html += `<div class="ct-section"><strong>Effetto Orda</strong><br>${def.horde_effect}</div>`;
      if (def.evolves_from) html += `<div class="ct-dim">Evolve da: ${Mob.cardName(def.evolves_from)}</div>`;
      if (def.evolves_into) html += `<div class="ct-dim">Evolve in: ${Mob.cardName(def.evolves_into)}</div>`;

    } else if (def.type === 'spell') {
      html += `<div class="ct-meta">
        <span style="color:var(--${def.school})">${capitalize(def.school)}</span> · Magia · 🔮${def.cost} Maghe
      </div>
      <div class="ct-section"><strong>Effetto Base</strong><br>${def.base_effect || '—'}</div>`;
      if (def.prodigy_effect) html += `<div class="ct-section"><strong>Prodigio</strong><br>${def.prodigy_effect}</div>`;

    } else if (def.type === 'building') {
      const statusStr = ctx.completed === undefined ? ''
        : ctx.completed ? ' · <span style="color:var(--gold-light)">✓ Completata</span>'
        : ' · <span style="color:var(--text-faint)">Incompleta</span>';
      const baseCls = ctx.completed === false ? ' ct-active' : '';
      const complCls = ctx.completed === true ? ' ct-active' : '';
      html += `<div class="ct-meta">Costruzione · 💎${def.cost} Mana · 🏗️${ctx.completionCostLabel || def.completion_cost} Mana${statusStr}</div>
      <div class="ct-section${baseCls}"><strong>Effetto Base</strong><br>${def.base_effect || '—'}</div>`;
      if (def.complete_effect) {
        html += `<div class="ct-section${complCls}"><strong>Effetto Completo</strong><br>${def.complete_effect}</div>`;
      }
    }

    if (ctx.extraHTML) html += ctx.extraHTML;
    return html;
  }

  /**
   * Vista carta per lo sheet: immagine con flip verso il testo, o solo flashcard.
   * Ritorna un Node. Prova a caricare /card_images/full/{baseId}.webp.
   */
  // Immagini carta caricate almeno una volta: per queste la vista carta viene
  // costruita subito, senza il flash della flashcard testuale in attesa della rete.
  const _imgLoaded = new Set();

  function preloadCardImage(baseId) {
    if (!baseId || _imgLoaded.has(baseId)) return;
    const i = new Image();
    i.onload = () => _imgLoaded.add(baseId);
    i.src = `/card_images/full/${baseId}.webp`;
  }

  function cardViewNode(def, ctx = {}) {
    const textHTML = cardTextHTML(def, ctx);
    const wrap = el('div', { className: 'cardview' });
    const textOnly = el('div', { className: 'cardtext' });
    textOnly.innerHTML = textHTML;

    if (!def) { wrap.appendChild(textOnly); return wrap; }

    const flip = el('div', { className: ctx.assigned ? 'flip flip-assigned' : 'flip' });
    const inner = el('div', { className: 'flip-inner' });
    const front = el('div', { className: 'flip-face' });
    const img = el('img', { alt: def.name, draggable: 'false' });
    front.appendChild(img);
    const back = el('div', { className: 'flip-face flip-back' });
    // Girando la carta si vede il retro (come nel catalogo); la scheda testuale
    // resta solo se la chiamata la chiede (ctx.textBack)
    if (!ctx.textBack) {
      back.classList.add('flip-back-img');
      back.appendChild(el('img', { alt: 'Retro carta', draggable: 'false', src: '/card_images/full/retro.webp' }));
    } else {
      back.innerHTML = textHTML;
    }
    inner.appendChild(front);
    inner.appendChild(back);
    flip.appendChild(inner);

    const showFlip = () => {
      _imgLoaded.add(def.id);
      wrap.innerHTML = '';
      wrap.appendChild(flip);
      wrap.appendChild(el('div', { className: 'flip-hint' }, ['tocca la carta per girarla']));
      flip.addEventListener('click', () => { haptic(8); flip.classList.toggle('flipped'); });
    };

    if (_imgLoaded.has(def.id)) {
      img.onerror = () => { wrap.innerHTML = ''; wrap.appendChild(textOnly); };
      img.src = `/card_images/full/${def.id}.webp`;
      showFlip();
    } else {
      img.onload = showFlip;
      img.onerror = () => { /* resta la flashcard testuale */ };
      img.src = `/card_images/full/${def.id}.webp`;
      wrap.appendChild(textOnly);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Cronaca: l'ultima voce sotto il campo
  // ---------------------------------------------------------------------------

  /** Mostra sotto il campo l'ultima voce della cronaca (HTML già sicuro, da chronicle.js). */
  function ticker(html) {
    const t = $('ticker');
    t.innerHTML = html;
    t.classList.remove('ticker-in');
    void t.offsetWidth;  // forza il replay dell'animazione
    t.classList.add('ticker-in');
  }

  return {
    game,
    topbar,
    phaseDimmed,
    phaseControls,
    flashOpponent,
    field,
    statusbar,
    hand,
    fanHand,
    warriorMini,
    buildingMini,
    deckNode,
    activeEffectItems,
    cardTextHTML,
    cardViewNode,
    preloadCardImage,
    timerStart,
    timer,
    timerHide,
    ticker,
  };
})();
