/**
 * render.js — Rendering dello stato di gioco per il client mobile.
 * Costruisce topbar, avversari, campo (4 tasselli), statusbar e mano.
 * Nei tasselli le carte sono riassunte in chip a una riga (dettaglio nello
 * sheet della Regione); negli sheet e in mano usano il markup del desktop.
 * I gesti/flussi sono delegati a Mob (app.js).
 */

'use strict';

const Render = (() => {

  const SPECIES_ICON = { elfo: '🌿', nano: '⛏️', maga: '🔮', umano: '🛡️' };

  // ---------------------------------------------------------------------------
  // Render principale
  // ---------------------------------------------------------------------------

  function game(state, myId) {
    if (!state) return;
    topbar(state);
    opponents(state, myId);

    const me = state.players.find(p => p.id === myId);
    if (!me) return;

    field(me, state, myId);
    statusbar(me);
    hand(me);
  }

  // ---------------------------------------------------------------------------
  // Topbar
  // ---------------------------------------------------------------------------

  function topbar(state) {
    $('tb-turn').textContent = `T${state.turn}`;
    $('tb-deck').textContent = `🃏 ${state.deck_count}`;

    const phases = ['action', 'schieramento', 'battaglia'];
    const idx = phases.indexOf(state.phase);
    document.querySelectorAll('.ph-dot').forEach(dot => {
      const i = phases.indexOf(dot.dataset.ph);
      dot.classList.toggle('on', i === idx);
      dot.classList.toggle('done', idx >= 0 && i < idx);
    });
  }

  function phaseDimmed(dimmed) {
    $('tb-phase').classList.toggle('dimmed', dimmed);
  }

  // ---------------------------------------------------------------------------
  // Timer ad anello
  // ---------------------------------------------------------------------------

  const RING_LEN = 97.4;
  let _timerTotal = 120;

  function timerStart(total) { _timerTotal = Math.max(1, total); }

  function timer(secondsLeft) {
    const box = $('tb-timer');
    box.hidden = false;
    $('tb-timer-num').textContent = secondsLeft;
    const frac = Math.max(0, Math.min(1, secondsLeft / _timerTotal));
    $('timer-ring').style.strokeDashoffset = (RING_LEN * (1 - frac)).toFixed(1);
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

  // Usata dagli sheet di app.js (avversari, ecc.)
  function warriorMini(w) {
    const div = el('div', {
      className: 'card card-sm in-field',
      dataset: { type: 'warrior', instanceId: w.instance_id, baseId: w.base_card_id },
    });
    if (w.horde_active) div.classList.add('horde-active');

    div.appendChild(el('div', { className: 'card-name' }, [w.name || w.base_card_id]));
    div.appendChild(el('div', {
      className: `card-species species-${w.species}`
    }, [capitalize(w.species || '')]));

    const stats = el('div', { className: 'card-stats' });
    stats.appendChild(el('span', { className: 'stat stat-att' }, [`🗡️${w.att}`]));
    stats.appendChild(el('span', { className: 'stat stat-git' }, [`🏹${w.git}`]));
    stats.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡️${w.dif}`]));
    div.appendChild(stats);
    return div;
  }

  // ---------------------------------------------------------------------------
  // Riassunto di una Regione dentro i suoi tasselli — solo numeri, come per
  // gli avversari ma con più respiro. Il dettaglio carta per carta si apre
  // toccando il tassello (vedi openVanguardSheet/openBastionSheet/openVillageSheet).
  // ---------------------------------------------------------------------------

  function _speciesDots(warriors, max = 8) {
    const wrap = el('span', { className: 'rg-dots' });
    (warriors || []).slice(0, max).forEach(w => {
      wrap.appendChild(el('i', { className: `rg-dot sp-${w.species || 'umano'}` }));
    });
    if ((warriors || []).length > max) {
      wrap.appendChild(el('span', { className: 'rg-dots-more' }, [`+${warriors.length - max}`]));
    }
    return wrap;
  }

  function _maxStat(warriors, key) {
    if (!warriors || warriors.length === 0) return 0;
    return Math.max(...warriors.map(w => w[key] || 0));
  }

  function _statBlock(num, label) {
    return el('div', { className: `rg-stat${num === 0 ? ' zero' : ''}` }, [
      el('span', { className: 'rg-stat-num' }, [String(num)]),
      el('span', { className: 'rg-stat-label' }, [label]),
    ]);
  }

  function _statRow(...blocks) {
    return el('div', { className: 'rg-stat-row' }, blocks);
  }

  function vanguardSummary(vg) {
    const wrap = el('div', { className: 'rg-summary' }, [
      _statRow(_statBlock(vg.length, vg.length === 1 ? 'Guerriero' : 'Guerrieri')),
      _speciesDots(vg),
      el('div', { className: 'rg-summary-sub' },
        [`ATT max ${_maxStat(vg, 'att')} · GIT max ${_maxStat(vg, 'git')}`]),
    ]);
    return wrap;
  }

  function bastionSummary(bastion) {
    const wallCount = bastion.wall_count ?? (bastion.walls || []).length;
    const warriors = bastion.warriors || [];
    const wrap = el('div', { className: 'rg-summary' }, [
      _statRow(
        _statBlock(wallCount, wallCount === 1 ? 'Muro' : 'Muri'),
        _statBlock(warriors.length, warriors.length === 1 ? 'Difensore' : 'Difensori'),
      ),
    ]);
    if (warriors.length > 0) {
      wrap.appendChild(_speciesDots(warriors));
      wrap.appendChild(el('div', { className: 'rg-summary-sub' },
        [`DIF max ${_maxStat(warriors, 'dif')} · GIT max ${_maxStat(warriors, 'git')}`]));
    }
    return wrap;
  }

  function villageSummary(buildings) {
    const completed = buildings.filter(b => b.completed).length;
    return el('div', { className: 'rg-summary' }, [
      _statRow(
        _statBlock(buildings.length, buildings.length === 1 ? 'Costruzione' : 'Costruzioni'),
        _statBlock(completed, completed === 1 ? 'Completa' : 'Complete'),
      ),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Avversari — mini versione delle 4 Regioni
  // ---------------------------------------------------------------------------

  function _livesStr(lives) {
    const n = Math.max(0, lives);
    return '❤︎'.repeat(n) + '✕'.repeat(Math.max(0, 3 - n));
  }

  function _oppGrid(p, canHitLeft, canHitRight) {
    const cell = (label, value, attackable) => el('span', {
      className: `og-cell${attackable ? ' atk-target' : ''}`
    }, [
      el('i', {}, [label]),
      el('b', {}, [value]),
    ]);
    const vg = (p.field.vanguard || []).length;
    const vil = ((p.field.village && p.field.village.buildings) || []).length;
    const wallsL = p.field.bastion_left.wall_count ?? 0;
    const wallsR = p.field.bastion_right.wall_count ?? 0;
    const defL = (p.field.bastion_left.warriors || []).length;
    const defR = (p.field.bastion_right.warriors || []).length;

    return el('span', { className: 'opp-grid' }, [
      cell('Avanscoperta', `🗡️${vg}`),
      cell('Villaggio', `🏗️${vil}`),
      cell('Bastione S.', `🧱${wallsL}${defL ? ` 🗡️${defL}` : ''}`, canHitLeft),
      cell('Bastione D.', `🧱${wallsR}${defR ? ` 🗡️${defR}` : ''}`, canHitRight),
    ]);
  }

  function opponents(state, myId) {
    const rail = $('opp-rail');
    rail.innerHTML = '';
    const n = state.players.length;
    const myIndex = state.players.findIndex(pp => pp.id === myId);
    const leftNb = state.players[(myIndex - 1 + n) % n];
    const rightNb = state.players[(myIndex + 1) % n];

    state.players.forEach(p => {
      if (p.id === myId) return;
      const isTurn = p.id === state.current_player_id;
      const dead = (p.lives ?? 0) <= 0;
      const fxCount = (p.active_effects || []).length;
      // Bastione destro di X è adiacente al Bastione sinistro di X+1:
      // se p è il mio vicino di destra posso colpire il suo Bastione S.,
      // se p è il mio vicino di sinistra posso colpire il suo Bastione D.
      const canHitLeft = p.id === rightNb.id;
      const canHitRight = p.id === leftNb.id;

      const chip = el('button', {
        className: `opp-chip${isTurn ? ' turn' : ''}${dead ? ' dead' : ''}`,
        dataset: { playerId: p.id },
      }, [
        el('span', { className: 'opp-top' }, [
          el('span', { className: 'opp-name' }, [p.name]),
          el('span', { className: 'opp-lives' }, [_livesStr(p.lives ?? 0)]),
        ]),
        el('span', { className: 'opp-sub' }, [
          el('span', {}, ['🃏 ', el('b', {}, [String(p.hand_count ?? 0)])]),
          fxCount > 0 ? el('span', { className: 'opp-fx-badge' }, [`✨${fxCount}`]) : null,
        ]),
        _oppGrid(p, canHitLeft, canHitRight),
      ]);
      chip.addEventListener('click', () => { haptic(); Mob.openOpponentSheet(p.id); });
      rail.appendChild(chip);
    });
  }

  function flashOpponent(playerId) {
    const chip = document.querySelector(`.opp-chip[data-player-id="${playerId}"]`);
    if (!chip) return;
    chip.classList.remove('damaged');
    void chip.offsetWidth;
    chip.classList.add('damaged');
  }

  // ---------------------------------------------------------------------------
  // Campo — 4 tasselli uguali (Avanscoperta, Villaggio, Bastione S., Bastione D.)
  // ---------------------------------------------------------------------------

  function field(me, state, myId) {
    const canMove = state.current_player_id === myId && state.phase === 'schieramento';

    // Avanscoperta
    const vgWrap = $('vg-cards');
    vgWrap.innerHTML = '';
    const vg = me.field.vanguard || [];
    $('fld-vanguard').classList.toggle('hot', canMove && vg.length > 0);
    vgWrap.appendChild(vg.length === 0
      ? el('div', { className: 'rg-empty' }, ['Vuota'])
      : vanguardSummary(vg));

    // Villaggio
    const vWrap = $('village-cards');
    vWrap.innerHTML = '';
    const buildings = (me.field.village.buildings || []);
    vWrap.appendChild(buildings.length === 0
      ? el('div', { className: 'rg-empty' }, ['Nessuna Costruzione'])
      : villageSummary(buildings));

    // Bastioni + nome del vicino che li minaccia
    const n = state.players.length;
    const myIndex = state.players.findIndex(p => p.id === myId);
    const leftNb = state.players[(myIndex - 1 + n) % n];
    const rightNb = state.players[(myIndex + 1) % n];
    $('tw-left-threat').textContent = leftNb && leftNb.id !== myId ? `Esposto a ${leftNb.name}` : '';
    $('tw-right-threat').textContent = rightNb && rightNb.id !== myId ? `Esposto a ${rightNb.name}` : '';

    [['left', 'bl-cards', 'tw-left'], ['right', 'br-cards', 'tw-right']].forEach(([side, wrapId, tileId]) => {
      const bastion = side === 'left' ? me.field.bastion_left : me.field.bastion_right;
      const wrap = $(wrapId);
      wrap.innerHTML = '';
      const wallCount = bastion.wall_count ?? (bastion.walls || []).length;
      const warriors = bastion.warriors || [];
      $(tileId).classList.toggle('hot', canMove && warriors.length > 0);
      wrap.appendChild(wallCount === 0 && warriors.length === 0
        ? el('div', { className: 'rg-empty' }, ['Vuoto'])
        : bastionSummary(bastion));
    });
  }

  // ---------------------------------------------------------------------------
  // Statusbar
  // ---------------------------------------------------------------------------

  let _prevMana = null;
  let _prevActs = null;

  function _bump(id) {
    const chip = $(id);
    chip.classList.remove('bump');
    void chip.offsetWidth;
    chip.classList.add('bump');
  }

  function statusbar(me) {
    $('st-lives').textContent = _livesStr(me.lives ?? 0);

    const mana = me.mana_remaining ?? 0;
    $('st-mana').textContent = `Mana: ${mana}`;
    if (_prevMana !== null && mana !== _prevMana) _bump('st-mana');
    _prevMana = mana;

    const acts = me.actions_remaining ?? 0;
    $('st-actions').textContent = `Azioni: ${acts}`;
    if (_prevActs !== null && acts !== _prevActs) _bump('st-actions');
    _prevActs = acts;

    const fxItems = activeEffectItems(me);
    const fxBtn = $('st-fx');
    fxBtn.hidden = fxItems.length === 0;
    fxBtn.textContent = `✨ ${fxItems.length}`;
  }

  const ACTIVE_EFFECT_CONFIG = {
    'spell_immune':            { baseCardId: 'magiscudo',    label: 'Magiscudo',    desc: () => 'Le Magie non hanno effetto su di te fino al prossimo turno.' },
    'guerremoto':              { baseCardId: 'guerremoto',   label: 'Guerremoto',   desc: ef => `Puoi attaccare qualsiasi Bastione${ef.damage_bonus ? ` (+${ef.damage_bonus} Danni)` : ''}.` },
    'investimento_deferred':   { baseCardId: 'investimento', label: 'Investimento', desc: ef => `+${ef.mana || 2} Mana all'inizio del prossimo turno.` },
    'divinazione_incantesimo': { baseCardId: 'divinazione',  label: 'Divinazione',  desc: () => 'Ricevi un Incantesimo gratuito a inizio prossimo turno.' },
    'divinazione_all_mage':    { baseCardId: 'divinazione',  label: 'Divinazione',  desc: () => '+1 Maga a inizio prossimo turno.' },
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

  function hand(me) {
    const wrap = $('hand');
    wrap.innerHTML = '';
    const cards = me.hand || [];
    if (cards.length === 0) {
      wrap.appendChild(el('div', { className: 'hand-empty' }, ['Mano vuota']));
      return;
    }
    cards.forEach(iid => wrap.appendChild(handCard(iid, me.ethereal_card || null)));
  }

  function handCard(iid, etherealCard) {
    const isEthereal = etherealCard === iid;
    const div = el('div', { className: isEthereal ? 'card ethereal' : 'card', dataset: { instanceId: iid } });

    const def = Mob.getCardDef(iid);
    if (def) {
      div.dataset.type = def.type;
      div.dataset.baseId = def.id;

      // Badge costo: notifica in alto a destra, oro = Mana, azzurro = Maghe
      const badgeCls = isEthereal ? 'ethereal' : (def.cost_type === 'maga' ? 'maga' : 'mana');
      div.appendChild(el('div', { className: `card-cost-badge ${badgeCls}` }, [String(isEthereal ? 0 : def.cost)]));

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
    } else {
      div.appendChild(el('div', { className: 'card-name' }, [iid]));
    }

    div.addEventListener('click', () => { haptic(); Mob.onHandTap(iid); });
    return div;
  }

  function markWallPicks(selectedIds) {
    document.querySelectorAll('#hand .card').forEach(c => {
      c.classList.toggle('wall-marked', selectedIds.has(c.dataset.instanceId));
    });
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
        : ctx.completed ? ' · <span style="color:var(--gold)">✓ Completata</span>'
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
   * Ritorna un Node. Prova a caricare /card_images/{baseId}.png.
   */
  // Immagini carta caricate almeno una volta: per queste la vista carta viene
  // costruita subito, senza il flash della flashcard testuale in attesa della rete.
  const _imgLoaded = new Set();

  function preloadCardImage(baseId) {
    if (!baseId || _imgLoaded.has(baseId)) return;
    const i = new Image();
    i.onload = () => _imgLoaded.add(baseId);
    i.src = `/card_images/${baseId}.png`;
  }

  function cardViewNode(def, ctx = {}) {
    const textHTML = cardTextHTML(def, ctx);
    const wrap = el('div', { className: 'cardview' });
    const textOnly = el('div', { className: 'cardtext' });
    textOnly.innerHTML = textHTML;

    if (!def) { wrap.appendChild(textOnly); return wrap; }

    const flip = el('div', { className: 'flip' });
    const inner = el('div', { className: 'flip-inner' });
    const front = el('div', { className: 'flip-face' });
    const img = el('img', { alt: def.name, draggable: 'false' });
    front.appendChild(img);
    const back = el('div', { className: 'flip-face flip-back' });
    if (ctx.realBack) {
      back.classList.add('flip-back-img');
      back.appendChild(el('img', { alt: 'Retro carta', draggable: 'false', src: '/card_images/retro.png' }));
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
      img.src = `/card_images/${def.id}.png`;
      showFlip();
    } else {
      img.onload = showFlip;
      img.onerror = () => { /* resta la flashcard testuale */ };
      img.src = `/card_images/${def.id}.png`;
      wrap.appendChild(textOnly);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Registro eventi (log)
  // ---------------------------------------------------------------------------

  const _log = [];

  function logPush(text) {
    _log.unshift({ text, at: new Date() });
    if (_log.length > 60) _log.pop();
    const ticker = $('ticker');
    ticker.textContent = text;
    ticker.hidden = false;
    ticker.classList.remove('ticker');
    void ticker.offsetWidth;
    ticker.classList.add('ticker');
  }

  function logEntries() { return _log; }

  return {
    game,
    topbar,
    phaseDimmed,
    opponents,
    flashOpponent,
    field,
    statusbar,
    hand,
    markWallPicks,
    warriorMini,
    activeEffectItems,
    cardTextHTML,
    cardViewNode,
    preloadCardImage,
    timerStart,
    timer,
    timerHide,
    logPush,
    logEntries,
  };
})();
