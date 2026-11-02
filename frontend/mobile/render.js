/**
 * render.js — Rendering dello stato di gioco per il client mobile.
 * Costruisce l'intestazione (turno, mazzo, fasi, cronaca), il campo a
 * triangoli (board.js) con i nomi degli avversari, le mie risorse e la mano.
 * Negli sheet le carte usano il markup del desktop con le minicarte.
 * I gesti/flussi sono delegati a Mob (app.js).
 */

'use strict';

const Render = (() => {

  const SPECIES_ICON = { elfo: '🌿', nano: '⛏️', maga: '🔮', umano: '🛡️' };

  const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 5 6.4 5c2 0 3.6 1.1 4.6 2.6C12 6.1 13.6 5 15.6 5 19 5 21.1 8.4 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>';

  // ---------------------------------------------------------------------------
  // Render principale
  // ---------------------------------------------------------------------------

  function game(state, myId) {
    if (!state) return;
    topbar(state);

    const me = state.players.find(p => p.id === myId);
    if (!me) return;

    field(state, myId);
    statusbar(me);
    hand(me);
  }

  // ---------------------------------------------------------------------------
  // Intestazione: turno, mazzo, fasi
  // ---------------------------------------------------------------------------

  const PHASES = ['action', 'schieramento', 'battaglia'];
  const PHASE_NAMES = { action: 'Azioni', schieramento: 'Schieramento', battaglia: 'Battaglia' };

  function topbar(state) {
    $('tb-turn').textContent = `T${state.turn}`;
    $('tb-deck-n').textContent = state.deck_count;

    const idx = PHASES.indexOf(state.phase);
    document.querySelectorAll('#tb-phase .ph-dot').forEach(dot => {
      const i = PHASES.indexOf(dot.dataset.ph);
      dot.classList.toggle('on', i === idx);
      dot.classList.toggle('done', idx >= 0 && i < idx);
    });
    $('tb-phase-name').textContent = PHASE_NAMES[state.phase] || '';
  }

  function phaseDimmed(dimmed) {
    $('tb-phase').classList.toggle('dimmed', dimmed);
  }

  // ---------------------------------------------------------------------------
  // Timer: barra in fondo all'intestazione
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
  // Campo — le mie Regioni e quelle degli altri giocatori (board.js)
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

  // Posti degli altri giocatori attorno a me (board.js): r a destra, t di
  // fronte, l a sinistra, in ordine di posto: con tre vivi uno per posto, con
  // due i vicini ai lati, con uno solo di fronte. Gli eliminati occupano i
  // posti rimasti vuoti, col solo nome.
  function seatsAround(state, myId) {
    const ps = state.players;
    const ci = Math.max(0, ps.findIndex(p => p.id === myId));
    const others = ps.map((_, k) => ps[(ci + 1 + k) % ps.length]).filter(p => p.id !== myId);
    const alive = others.filter(p => (p.lives ?? 0) > 0), dead = others.filter(p => (p.lives ?? 0) <= 0);
    const order = alive.length === 1 ? ['t'] : alive.length === 2 ? ['r', 'l'] : ['r', 't', 'l'];
    const seats = {};
    alive.slice(0, 3).forEach((p, i) => { seats[order[i]] = p; });
    ['r', 't', 'l'].filter(s => !seats[s]).forEach(s => { if (dead.length) seats[s] = dead.shift(); });
    return seats;
  }

  function field(state, myId) {
    const me = state.players.find(p => p.id === myId);
    const { left, right } = aliveNeighbors(state, myId);
    const seats = seatsAround(state, myId);
    const slots = {
      c_vanguard: regionSlot(me, 'vanguard'),
      c_village: regionSlot(me, 'village'),
      c_bastion_left: regionSlot(me, 'bastion_left'),
      c_bastion_right: regionSlot(me, 'bastion_right'),
    };
    const vacant = new Set();
    const seatOf = {};
    ['r', 't', 'l'].forEach(s => {
      const p = seats[s];
      if (!p || (p.lives ?? 0) <= 0) { vacant.add(s); return; }
      seatOf[p.id] = s;
      ['vanguard', 'village', 'bastion_left', 'bastion_right'].forEach(r => { slots[`${s}_${r}`] = regionSlot(p, r); });
    });

    const hot = new Set(), target = new Set(), quiet = new Set();
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
    // Battaglia: i Bastioni che posso attaccare ora. Il vicino di sinistra si
    // attacca nel Bastione destro, quello di destra nel sinistro
    if (Mob.canAttackNow()) {
      const keys = Mob.attackTargetKeys();
      if (left && seatOf[left.id] && keys.has(`${left.id}:right`)) target.add(`${seatOf[left.id]}_bastion_right`);
      if (right && seatOf[right.id] && keys.has(`${right.id}:left`)) target.add(`${seatOf[right.id]}_bastion_left`);
    }
    Board.update(slots, { hot, target, quiet, vacant });
    opponents(state, seats);
  }

  // ---------------------------------------------------------------------------
  // Nomi degli altri giocatori: chi sta di fronte sopra la tavola, chi sta di
  // lato in verticale nella striscia ai lati. Nome e Vite su una riga
  // ---------------------------------------------------------------------------

  function heartsNode(lives, cls) {
    const n = Math.max(0, lives ?? 0);
    const box = el('span', { className: cls, role: 'img', 'aria-label': `${n} ${n === 1 ? 'Vita' : 'Vite'}` });
    box.innerHTML = HEART_SVG.repeat(Math.min(n, 4));
    if (n > 4) box.appendChild(el('b', {}, [`×${n}`]));
    return box;
  }

  function opponentLabel(state, p, pos) {
    const dead = (p.lives ?? 0) <= 0;
    const turn = p.id === state.current_player_id && !state.winner_id;
    const label = el('div', {
      className: `opp-label ${pos}${turn ? ' turn' : ''}${dead ? ' dead' : ''}`,
      dataset: { playerId: p.id },
    });

    // Il nome apre la scheda del giocatore
    const name = el('button', { className: 'opp-name', type: 'button' }, [p.name]);
    name.addEventListener('click', () => { haptic(); Mob.openOpponentSheet(p.id); });
    label.appendChild(name);

    if (dead) {
      label.appendChild(el('span', { className: 'opp-out' }, ['Eliminato']));
    } else {
      label.appendChild(heartsNode(p.lives, 'opp-hearts'));
      const fx = activeEffectItems(p).length;
      if (fx > 0) label.appendChild(el('span', { className: 'opp-fx' }, [`✧${fx}`]));
    }
    return label;
  }

  function opponents(state, seats) {
    const nodes = [];
    ['l', 'r'].forEach(s => {
      if (!seats[s]) return;
      const label = opponentLabel(state, seats[s], `pos-${s}`);
      label.style.cssText = Board.seatLabelStyle(s);
      nodes.push(label);
    });
    if (seats.t) nodes.push(opponentLabel(state, seats.t, 'pos-t'));
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
  // Le mie risorse (sotto il campo)
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
    // Vite e Azioni come il Mana: un simbolo con dentro il numero
    const acts = me.actions_remaining ?? 0;
    $('st-actions-n').textContent = acts;
    $('st-actions').setAttribute('aria-label', `Azioni: ${acts}`);
    if (_prevActs !== null && acts !== _prevActs) _bump('st-actions');
    _prevActs = acts;

    const lives = Math.max(0, me.lives ?? 0);
    $('st-lives-n').textContent = lives;
    $('st-lives').setAttribute('aria-label', `Le tue Vite: ${lives}`);

    const mana = me.mana_remaining ?? 0;
    $('st-mana-n').textContent = mana;
    $('st-mana').setAttribute('aria-label', `Mana: ${mana}`);
    if (_prevMana !== null && mana !== _prevMana) _bump('st-mana');
    _prevMana = mana;

    const fxItems = activeEffectItems(me);
    const fxBtn = $('st-fx');
    fxBtn.hidden = fxItems.length === 0;
    fxBtn.textContent = `✧ ${fxItems.length}`;
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
  // Mano — riga orizzontale scorrevole, carte identiche al desktop
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
        // La fascia della minicarta può cambiare anche se la carta resta (es. Prodigio)
        const def = Mob.getCardDef(iid);
        CardArt.update(node, def, CardArt.handInfo(def, iid, me.prodigy_ready));
      } else {
        node = handCard(iid, etherealCard, me.prodigy_ready);
      }
      next.set(iid, { node, ethereal });
      return node;
    });
    wrap.replaceChildren(...nodes);
    _handNodes = next;
    fanHand(nodes);
  }

  // Mano a ventaglio: ogni carta ruota attorno al proprio fondo e quelle ai lati
  // scendono un poco, lungo un arco. Rotate/translate stanno in proprietà CSS
  // separate da transform, che resta libero per :active e animazioni (motion.js,
  // che legge l'inclinazione per i fantasmi). La mano non scorre: se le carte non
  // ci stanno in larghezza si sovrappongono quanto serve.
  function fanHand(nodes = [...document.querySelectorAll('#hand .card')]) {
    const n = nodes.length;
    if (!n) return;
    const step = n > 1 ? Math.min(4, 14 / (n - 1)) : 0;  // apertura totale massima 14°
    const cardW = nodes[0].offsetWidth;
    const avail = $('hand').clientWidth - 24;
    let shown = cardW * 0.76;  // parte di ogni carta non coperta dalla successiva
    if (n > 1 && cardW + (n - 1) * shown > avail) shown = Math.max(4, (avail - cardW) / (n - 1));
    nodes.forEach((node, i) => {
      const rot = (i - (n - 1) / 2) * step;
      node.style.setProperty('--fan-rot', `${rot.toFixed(2)}deg`);
      // Discesa delle carte ai lati: ruotando sul fondo l'angolo esterno sale, va compensato
      node.style.setProperty('--fan-y', `calc(var(--card-h-hand) * ${(rot * rot * 0.002).toFixed(4)})`);
      node.style.marginLeft = i ? `${(shown - cardW).toFixed(1)}px` : '';
    });
  }

  function handCard(iid, etherealCard, prodigyReady) {
    const isEthereal = etherealCard === iid;
    const div = el('div', { className: isEthereal ? 'card hand-card ethereal' : 'card hand-card', dataset: { instanceId: iid } });

    const def = Mob.getCardDef(iid);
    if (def) {
      div.dataset.type = def.type;
      div.dataset.baseId = def.id;

      // Badge costo come sulle carte stampate: esagono giallo per il Mana, stella azzurra per le Maghe, bianco per la carta Eterea
      const badgeCls = isEthereal ? 'ethereal' : (def.cost_type === 'maga' ? 'maga' : 'mana');
      div.appendChild(el('div', { className: `card-cost-badge ${badgeCls}${def.cost_type === 'maga' ? ' star' : ''}` }, [String(isEthereal ? 0 : def.cost)]));

      div.appendChild(el('div', { className: 'card-name' }, [def.name]));

      if (def.type === 'warrior') {
        div.appendChild(el('div', {
          className: `card-species species-${def.species}`
        }, [`${capitalize(def.species)}${def.school ? ` · ${capitalize(def.school)}` : ''}`]));

        // Caratteristiche in colonna, una sotto l'altra
        const attrsDiv = el('div', { className: 'card-warrior-attrs' });
        attrsDiv.appendChild(el('span', { className: 'stat stat-att' }, [`🗡️ ${def.att}`]));
        attrsDiv.appendChild(el('span', { className: 'stat stat-git' }, [`🏹 ${def.git}`]));
        attrsDiv.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡️ ${def.dif}`]));
        div.appendChild(attrsDiv);

      } else if (def.type === 'spell') {
        div.appendChild(el('div', {
          className: `card-species school-${def.school}`
        }, [capitalize(def.school)]));

      } else if (def.type === 'building') {
        div.appendChild(el('div', { className: 'card-stats hand-cost-row' }, [
          el('span', { className: 'stat stat-mana' }, [`🏗️${def.completion_cost}`]),
        ]));
      }
      // Minicarta disegnata sopra la versione testuale, che resta nascosta
      CardArt.attach(div, def, CardArt.handInfo(def, iid, prodigyReady));
    } else {
      div.appendChild(el('div', { className: 'card-name' }, [iid]));
    }

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
  // Cronaca: l'ultima voce nell'intestazione
  // ---------------------------------------------------------------------------

  /** Mostra nell'intestazione l'ultima voce della cronaca (HTML già sicuro, da chronicle.js). */
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
