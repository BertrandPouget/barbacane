/**
 * render.js — Rendering dello stato di gioco per il client mobile.
 * Costruisce topbar, avversari, campo, statusbar e mano.
 * I gesti/flussi sono delegati a Mob (app.js).
 */

'use strict';

const Render = (() => {

  const SPECIES_ICON = { elfo: '🌿', nano: '⛏', maga: '🔮', umano: '🛡' };
  const KIND_ICON = { warrior: '🗡', spell: '✨', building: '🏛' };

  // ---------------------------------------------------------------------------
  // Render principale
  // ---------------------------------------------------------------------------

  function game(state, myId) {
    if (!state) return;
    topbar(state);
    opponents(state, myId);

    const me = state.players.find(p => p.id === myId);
    if (!me) return;

    vanguard(me, state, myId);
    towers(me, state, myId);
    statusbar(me);
    hand(me);
  }

  // ---------------------------------------------------------------------------
  // Topbar
  // ---------------------------------------------------------------------------

  function topbar(state) {
    $('tb-turn').textContent = `T${state.turn}`;
    $('tb-deck').textContent = `🂠 ${state.deck_count}`;

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
  // Avversari
  // ---------------------------------------------------------------------------

  function _livesStr(lives) {
    const n = Math.max(0, lives);
    return '❤'.repeat(n) + '✕'.repeat(Math.max(0, 3 - n));
  }

  function _speciesDots(warriors, max = 5) {
    const wrap = el('span', { className: 'opp-vg-dots' });
    (warriors || []).slice(0, max).forEach(w => {
      wrap.appendChild(el('i', {
        className: 'tower-dot',
        style: `width:6px;height:6px;border-radius:50%;display:inline-block;` +
               `background:var(--${w.species || 'umano'});`,
      }));
    });
    return wrap;
  }

  function opponents(state, myId) {
    const rail = $('opp-rail');
    rail.innerHTML = '';
    state.players.forEach(p => {
      if (p.id === myId) return;
      const isTurn = p.id === state.current_player_id;
      const dead = (p.lives ?? 0) <= 0;
      const fxCount = (p.active_effects || []).length;
      const wallsL = p.field.bastion_left.wall_count ?? 0;
      const wallsR = p.field.bastion_right.wall_count ?? 0;

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
          el('span', {}, ['🧱 ', el('b', {}, [`${wallsL}·${wallsR}`])]),
          (p.field.vanguard || []).length > 0 ? _speciesDots(p.field.vanguard) : null,
          fxCount > 0 ? el('span', { className: 'opp-fx-badge' }, [`✨${fxCount}`]) : null,
        ]),
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
  // Campo: avanscoperta
  // ---------------------------------------------------------------------------

  function warriorMini(w, { showMove = false } = {}) {
    const card = el('button', {
      className: `wmini sp-${w.species || 'umano'}${w.horde_active ? ' horde' : ''}`,
      dataset: { instanceId: w.instance_id },
    }, [
      showMove ? el('span', { className: 'wm-move' }, ['⇄']) : null,
      el('span', { className: 'wm-name', style: 'display:block' }, [w.name || w.base_card_id]),
      el('span', { className: 'wm-species', style: 'display:block' },
        [`${SPECIES_ICON[w.species] || ''} ${capitalize(w.species || '')}`]),
      el('span', { className: 'wm-stats' }, [
        el('span', { className: 'c-att' }, [`🗡${w.att}`]),
        el('span', { className: 'c-git' }, [`🏹${w.git}`]),
        el('span', { className: 'c-dif' }, [`🛡${w.dif}`]),
      ]),
    ]);
    return card;
  }

  function vanguard(me, state, myId) {
    const wrap = $('vg-cards');
    wrap.innerHTML = '';
    const ws = me.field.vanguard || [];
    const canMove = state.current_player_id === myId && state.phase === 'schieramento';
    $('fld-vanguard').classList.toggle('hot', canMove && ws.length > 0);

    if (ws.length === 0) {
      wrap.appendChild(el('div', { className: 'vg-empty' }, ['Nessun guerriero in avanscoperta']));
      return;
    }
    ws.forEach(w => {
      const card = warriorMini(w, { showMove: canMove });
      card.addEventListener('click', () => { haptic(); Mob.openFieldWarriorSheet(w.instance_id); });
      wrap.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------------
  // Campo: torri
  // ---------------------------------------------------------------------------

  function _towerDots(container, warriors) {
    container.innerHTML = '';
    (warriors || []).slice(0, 5).forEach(w => {
      container.appendChild(el('i', { style: `--sp: var(--${w.species || 'umano'})` }));
    });
  }

  function towers(me, state, myId) {
    const n = state.players.length;
    const myIndex = state.players.findIndex(p => p.id === myId);
    const leftNb = state.players[(myIndex - 1 + n) % n];
    const rightNb = state.players[(myIndex + 1) % n];

    $('tw-left-walls').textContent = me.field.bastion_left.wall_count ?? 0;
    $('tw-right-walls').textContent = me.field.bastion_right.wall_count ?? 0;
    _towerDots($('tw-left-dots'), me.field.bastion_left.warriors);
    _towerDots($('tw-right-dots'), me.field.bastion_right.warriors);
    $('tw-left-threat').textContent = leftNb && leftNb.id !== myId ? `⚔ ${leftNb.name}` : '';
    $('tw-right-threat').textContent = rightNb && rightNb.id !== myId ? `⚔ ${rightNb.name}` : '';

    const buildings = (me.field.village.buildings || []);
    $('tw-village-count').textContent = buildings.length;
    const incomplete = buildings.some(b => !b.completed);
    $('tw-village-badge').hidden = !incomplete;
  }

  // ---------------------------------------------------------------------------
  // Statusbar
  // ---------------------------------------------------------------------------

  function statusbar(me) {
    $('st-lives').textContent = _livesStr(me.lives ?? 0);

    const mana = me.mana_remaining ?? 0;
    $('st-mana').textContent = `💎 ${mana}`;

    const acts = me.actions_remaining ?? 0;
    const actEl = $('st-actions');
    actEl.innerHTML = '';
    actEl.appendChild(document.createTextNode('⚡'));
    const total = Math.max(acts, 2);
    for (let i = 0; i < Math.min(total, 5); i++) {
      actEl.appendChild(document.createTextNode(' '));
      actEl.appendChild(el('span', { className: i < acts ? '' : 'dimmed' }, ['●']));
    }

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
  // Mano
  // ---------------------------------------------------------------------------

  function hand(me) {
    const wrap = $('hand');
    wrap.innerHTML = '';
    const cards = me.hand || [];
    if (cards.length === 0) {
      wrap.appendChild(el('div', { className: 'hand-empty' }, ['Mano vuota']));
      return;
    }

    const n = cards.length;
    cards.forEach((iid, i) => {
      const def = Mob.getCardDef(iid);
      const isEthereal = me.ethereal_card === iid;
      const center = (n - 1) / 2;
      const rot = n > 1 ? ((i - center) * Math.min(4.5, 26 / n)).toFixed(2) : 0;
      const lift = n > 1 ? (Math.abs(i - center) * 3.4).toFixed(1) : 0;

      const card = el('button', {
        className: `hcard${isEthereal ? ' ethereal' : ''}`,
        dataset: { instanceId: iid },
        style: `--rot:${rot}deg; --lift:${lift}px; animation-delay:${i * 0.045}s`,
      });

      if (def) {
        const isSpell = def.type === 'spell';
        const costCls = isEthereal ? 'hc-cost zero' : (isSpell ? 'hc-cost maghe' : 'hc-cost');
        card.appendChild(el('span', { className: costCls }, [String(isEthereal ? 0 : def.cost)]));
        card.appendChild(el('span', { className: 'hc-name', style: 'display:block' }, [def.name]));

        const spCls = def.type === 'warrior' ? `sp-${def.species}` : (isSpell ? `sc-${def.school}` : '');
        const typeLabel = def.type === 'warrior'
          ? `${capitalize(def.species)}${def.subtype === 'hero' ? ' · Eroe' : ''}`
          : isSpell ? capitalize(def.school)
          : `Costruzione · 🏗${def.completion_cost}`;
        card.appendChild(el('span', { className: `hc-type ${spCls}`, style: 'display:block' }, [typeLabel]));
        if (spCls) card.classList.add(spCls);

        if (def.type === 'warrior') {
          card.appendChild(el('span', { className: 'hc-stats' }, [
            el('span', { className: 'c-att' }, [`🗡${def.att}`]),
            el('span', { className: 'c-git' }, [`🏹${def.git}`]),
            el('span', { className: 'c-dif' }, [`🛡${def.dif}`]),
          ]));
        } else {
          card.appendChild(el('span', { className: 'hc-kind' }, [KIND_ICON[def.type] || '❔']));
        }
      } else {
        card.appendChild(el('span', { className: 'hc-name', style: 'display:block' }, [iid]));
      }

      card.addEventListener('click', () => { haptic(); Mob.onHandTap(iid); });
      wrap.appendChild(card);
    });
  }

  function markWallPicks(selectedIds) {
    document.querySelectorAll('#hand .hcard').forEach(c => {
      c.classList.toggle('wall-pick', selectedIds.has(c.dataset.instanceId));
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
        <span class="c-att">🗡 ${att}</span><span class="c-git">🏹 ${git}</span><span class="c-dif">🛡 ${dif}</span>
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
      html += `<div class="ct-meta">Costruzione · 💎${def.cost} Mana · 🏗${ctx.completionCostLabel || def.completion_cost} Mana${statusStr}</div>
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
    back.innerHTML = textHTML;
    inner.appendChild(front);
    inner.appendChild(back);
    flip.appendChild(inner);

    img.onload = () => {
      wrap.innerHTML = '';
      wrap.appendChild(flip);
      wrap.appendChild(el('div', { className: 'flip-hint' }, ['tocca la carta per girarla']));
      flip.addEventListener('click', () => { haptic(8); flip.classList.toggle('flipped'); });
    };
    img.onerror = () => { /* resta la flashcard testuale */ };
    img.src = `/card_images/${def.id}.png`;

    wrap.appendChild(textOnly);
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
    vanguard,
    towers,
    statusbar,
    hand,
    markWallPicks,
    warriorMini,
    activeEffectItems,
    cardTextHTML,
    cardViewNode,
    timerStart,
    timer,
    timerHide,
    logPush,
    logEntries,
  };
})();
