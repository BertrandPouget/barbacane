/**
 * renderer.js — Rendering del campo da gioco di Barbacane
 * Costruisce il DOM a partire dallo stato di gioco ricevuto dal server.
 */

const Renderer = (() => {

  // ---------------------------------------------------------------------------
  // Render dello stato completo
  // ---------------------------------------------------------------------------

  let _myPlayerId = null;

  function render(state, myPlayerId) {
    if (!state) return;
    _myPlayerId = myPlayerId;

    document.getElementById('hdr-turn').textContent = `Turno ${state.turn}`;
    document.getElementById('hdr-phase').textContent = `Fase: ${phaseLabel(state.phase)}`;
    document.getElementById('hdr-current-player').textContent =
      `Il turno di: ${getPlayerName(state, state.current_player_id)}`;
    document.getElementById('hdr-deck').textContent = `Mazzo: ${state.deck_count}`;

    const myPlayer = state.players.find(p => p.id === myPlayerId);

    renderTableLayout(state, myPlayerId);

    if (myPlayer) renderMyField(myPlayer, state, myPlayerId);
    updateActionPanel(state, myPlayerId);
  }

  // ---------------------------------------------------------------------------
  // Layout tavolo — 2 / 3 / 4 giocatori
  //
  //   2p: avversario unico in cima (specchiato, piena larghezza); no strip
  //   3p: no top; vicino S. nella strip sinistra, vicino D. nella strip destra
  //   4p: giocatore di fronte in cima (campo completo specchiato);
  //       vicino S. nella strip sinistra, vicino D. nella strip destra
  //
  // I vicini laterali mostrano nella strip il bastione adiacente in fondo
  // (fisicamente vicino al mio campo) e quello non adiacente in cima (dimmer).
  // ---------------------------------------------------------------------------

  function renderTableLayout(state, myPlayerId) {
    const n        = state.players.length;
    const myIndex  = state.players.findIndex(p => p.id === myPlayerId);
    const topArea  = document.getElementById('top-opponents');
    const leftStrip  = document.getElementById('left-strip');
    const rightStrip = document.getElementById('right-strip');

    // Svuota sempre tutti e tre i contenitori
    topArea.innerHTML    = '';
    leftStrip.innerHTML  = '';
    rightStrip.innerHTML = '';

    if (n === 2) {
      const opp = state.players.find(p => p.id !== myPlayerId);
      topArea.appendChild(renderTopOpponent(opp, state, 'both'));
      leftStrip.classList.add('hidden');
      rightStrip.classList.add('hidden');

    } else if (n === 3) {
      // Nessuno di fronte; vicini ai lati
      const rn = state.players[(myIndex + 1) % 3]; // vicino destro
      const ln = state.players[(myIndex + 2) % 3]; // vicino sinistro
      leftStrip.classList.remove('hidden');
      rightStrip.classList.remove('hidden');
      leftStrip.appendChild(renderSideStrip(ln, state, 'left'));
      rightStrip.appendChild(renderSideStrip(rn, state, 'right'));
      leftStrip.classList.toggle('active-player-strip',  ln.id === state.current_player_id);
      rightStrip.classList.toggle('active-player-strip', rn.id === state.current_player_id);

      // Su mobile (strip nascoste dal CSS) mostra i vicini in top-opponents
      topArea.appendChild(renderTopOpponent(ln, state, 'left-neighbor'));
      topArea.appendChild(renderTopOpponent(rn, state, 'right-neighbor'));

    } else if (n === 4) {
      const rn     = state.players[(myIndex + 1) % 4]; // vicino destro
      const across = state.players[(myIndex + 2) % 4]; // di fronte
      const ln     = state.players[(myIndex + 3) % 4]; // vicino sinistro
      topArea.appendChild(renderTopOpponent(across, state, 'across'));
      leftStrip.classList.remove('hidden');
      rightStrip.classList.remove('hidden');
      leftStrip.appendChild(renderSideStrip(ln, state, 'left'));
      rightStrip.appendChild(renderSideStrip(rn, state, 'right'));
      leftStrip.classList.toggle('active-player-strip',  ln.id === state.current_player_id);
      rightStrip.classList.toggle('active-player-strip', rn.id === state.current_player_id);
    }
  }

  // ---------------------------------------------------------------------------
  // Campo avversario in cima (top-opponents) — specchiato
  //
  // role:
  //   'both'          → 2p: entrambi i bastioni sono attack-target
  //   'left-neighbor' → 3p mobile: B.D. (sx nel display) è adj al mio B.S.
  //   'right-neighbor'→ 3p mobile: B.S. (dx nel display) è adj al mio B.D.
  //   'across'        → 4p: nessun bastione adj; campo completo visibile ma non attaccabile
  // ---------------------------------------------------------------------------

  function renderTopOpponent(player, state, role) {
    const isActive = player.id === state.current_player_id;
    const div = el('div', { className: `opponent-field${isActive ? ' active-player' : ''}`,
      dataset: { playerId: player.id } });

    const infoRow = el('div', { className: 'opp-info-row' }, [
      el('span', { className: 'opp-name' }, [player.name]),
      el('span', { className: 'opp-lives' },
        ['❤'.repeat(Math.max(0, player.lives)) + '✕'.repeat(Math.max(0, 3 - player.lives))]),
      el('span', { className: 'opp-hand-count' }, [`✋ ${player.hand_count}`]),
    ]);
    if (role === 'across') {
      infoRow.appendChild(el('span', { className: 'opp-position-badge' }, ['↕ Di fronte']));
    }
    const villageEl = renderOppVillageInline(player.field.village);
    if (villageEl) infoRow.appendChild(villageEl);
    div.appendChild(infoRow);

    // Bastioni SPECCHIATI: B.D. a sinistra, B.S. a destra
    // isAdj: across → nessuno; both → tutti; left-neighbor → solo sx; right-neighbor → solo dx
    const leftAdj  = role === 'both' || role === 'left-neighbor';
    const rightAdj = role === 'both' || role === 'right-neighbor';

    const row = el('div', { className: 'opp-regions-row' });
    row.appendChild(renderOppBastionCell(player.field.bastion_right, player.id, 'right', leftAdj));
    row.appendChild(renderOppVanguardCell(player.field.vanguard));
    row.appendChild(renderOppBastionCell(player.field.bastion_left,  player.id, 'left',  rightAdj));
    div.appendChild(row);

    return div;
  }

  function renderOppBastionCell(bastion, playerId, side, isAdj) {
    const div = el('div', { className: `opp-region opp-bastion${isAdj ? ' attack-target' : ' nonadj'}`,
      dataset: isAdj ? { targetPlayerId: playerId, targetSide: side } : {} });
    div.appendChild(el('div', { className: 'opp-wall-count' }, [`🧱 ${bastion.wall_count}`]));
    if (bastion.warriors && bastion.warriors.length > 0) {
      const ws = el('div', { className: 'opp-warriors' });
      bastion.warriors.forEach(w => ws.appendChild(renderCardSmall(w, false)));
      div.appendChild(ws);
    }
    return div;
  }

  function renderOppVanguardCell(warriors) {
    const div = el('div', { className: 'opp-region opp-vanguard' });
    const ws = el('div', { className: 'opp-warriors' });
    (warriors || []).forEach(w => ws.appendChild(renderCardSmall(w, false)));
    div.appendChild(ws);
    return div;
  }

  // ---------------------------------------------------------------------------
  // Strip laterale — vicino sx o dx
  //
  // mySide 'left':  vicino SINISTRO → il suo B.D. (right) è adiacente al mio B.S.
  // mySide 'right': vicino DESTRO   → il suo B.S. (left)  è adiacente al mio B.D.
  //
  // Layout (dall'alto verso il basso):
  //   header (nome, vite, mano)
  //   bastione NON adiacente (dimmer)
  //   avanscoperta (flex:1, si espande)
  //   bastione ADIACENTE (margin-top:auto, spinto in fondo — vicino al mio campo)
  // ---------------------------------------------------------------------------

  function renderSideStrip(player, state, mySide) {
    const isAdj_side = mySide === 'left' ? 'right' : 'left'; // lato del loro bastione adj
    const adjBastion    = mySide === 'left' ? player.field.bastion_right : player.field.bastion_left;
    const nonAdjBastion = mySide === 'left' ? player.field.bastion_left  : player.field.bastion_right;
    const adjLabel = mySide === 'left'
      ? `⚔ vs Mio B.S.`
      : `⚔ vs Mio B.D.`;
    const nonAdjLabel = mySide === 'left' ? 'B.S. loro' : 'B.D. loro';
    const posLabel = mySide === 'left' ? '◄ Vicino S.' : 'Vicino D. ►';

    const wrapper = el('div', { className: 'strip-player' +
      (player.id === state.current_player_id ? ' active-player-content' : '') });

    // Header
    wrapper.appendChild(el('div', { className: 'strip-header' }, [
      el('div', { className: 'strip-name'  }, [`${posLabel} — ${player.name}`]),
      el('div', { className: 'strip-lives' },
        ['❤'.repeat(Math.max(0, player.lives)) + '✕'.repeat(Math.max(0, 3 - player.lives))]),
      el('div', { className: 'strip-hand'  }, [`✋ ${player.hand_count}`]),
    ]));

    // Villaggio
    const buildings = (player.field.village && player.field.village.buildings) || [];
    if (buildings.length > 0) {
      const vill = el('div', { className: 'strip-section strip-vanguard',
        style: 'border-color: var(--border); flex: 0 0 auto;' });
      vill.appendChild(el('div', { className: 'strip-section-label' }, ['🏛 Villaggio']));
      buildings.forEach(b => {
        const badge = el('div', { className: `opp-building-badge${b.completed ? ' completed' : ''}` },
          [b.name || b.base_card_id]);
        badge.addEventListener('click', e => { e.stopPropagation(); App.onCardClick(b.instance_id, 'opponent'); });
        vill.appendChild(badge);
      });
      wrapper.appendChild(vill);
    }

    // Bastione NON adiacente (dimmer, in alto)
    const nonAdj = el('div', { className: 'strip-section nonadj' });
    nonAdj.appendChild(el('div', { className: 'strip-section-label' }, [nonAdjLabel]));
    nonAdj.appendChild(el('div', { className: 'opp-wall-count' }, [`🧱 ${nonAdjBastion.wall_count}`]));
    if (nonAdjBastion.warriors && nonAdjBastion.warriors.length > 0) {
      const ws = el('div', { className: 'opp-warriors' });
      nonAdjBastion.warriors.forEach(w => ws.appendChild(renderCardSmall(w, false)));
      nonAdj.appendChild(ws);
    }
    wrapper.appendChild(nonAdj);

    // Avanscoperta (si espande, occupa lo spazio tra i due bastioni)
    const vg = el('div', { className: 'strip-section strip-vanguard' });
    vg.appendChild(el('div', { className: 'strip-section-label' }, ['Avanscoperta']));
    if (player.field.vanguard && player.field.vanguard.length > 0) {
      const ws = el('div', { className: 'opp-warriors' });
      player.field.vanguard.forEach(w => ws.appendChild(renderCardSmall(w, false)));
      vg.appendChild(ws);
    }
    wrapper.appendChild(vg);

    // Bastione ADIACENTE (in fondo, attack-target, margin-top:auto)
    const adj = el('div', { className: 'strip-section adj attack-target',
      dataset: { targetPlayerId: player.id, targetSide: isAdj_side } });
    adj.appendChild(el('div', { className: 'strip-section-label' }, [adjLabel]));
    adj.appendChild(el('div', { className: 'opp-wall-count' }, [`🧱 ${adjBastion.wall_count}`]));
    if (adjBastion.warriors && adjBastion.warriors.length > 0) {
      const ws = el('div', { className: 'opp-warriors' });
      adjBastion.warriors.forEach(w => ws.appendChild(renderCardSmall(w, false)));
      adj.appendChild(ws);
    }
    wrapper.appendChild(adj);

    return wrapper;
  }

  function renderOppVillageInline(village) {
    const buildings = (village && village.buildings) || [];
    if (buildings.length === 0) return null;
    const span = el('span', { className: 'opp-village-inline' });
    span.appendChild(document.createTextNode('🏛 '));
    buildings.forEach(b => {
      const badge = el('span', { className: `opp-building-badge${b.completed ? ' completed' : ''}` },
        [b.name || b.base_card_id]);
      badge.addEventListener('click', e => { e.stopPropagation(); App.onCardClick(b.instance_id, 'opponent'); });
      span.appendChild(badge);
    });
    return span;
  }

  // ---------------------------------------------------------------------------
  // Il mio campo
  // ---------------------------------------------------------------------------

  function renderMyField(player, state, myPlayerId) {
    // Carte-vita (solo per il proprietario)
    renderLifeCards(player);
    document.getElementById('my-mana').textContent    = `Mana: ${player.mana_remaining ?? 0}`;
    document.getElementById('my-actions').textContent = `Azioni: ${player.actions_remaining ?? 0}`;

    // Regioni
    renderRegion('my-vanguard', player.field.vanguard, 'warrior', true);
    renderBastionRegion('my-bastion-left',  player.field.bastion_left,  'left',  true);
    renderBastionRegion('my-bastion-right', player.field.bastion_right, 'right', true);
    renderVillage('my-village', player.field.village);

    // Mano
    renderHand(player.hand || []);
    document.getElementById('hand-count').textContent = (player.hand || []).length;
  }

  function renderRegion(containerId, warriors, kind, interactive) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    (warriors || []).forEach(w => {
      const card = renderWarriorCard(w, true, interactive);
      container.appendChild(card);
    });
  }

  function renderBastionRegion(containerId, bastion, side, interactive) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    // Muri come carta-stack singola
    const walls = bastion.walls || [];
    if (walls.length > 0) {
      container.appendChild(renderWallStack(walls, side, interactive));
    } else if (bastion.wall_count > 0) {
      container.appendChild(renderWallStackOpaque(bastion.wall_count));
    }

    // Guerrieri
    (bastion.warriors || []).forEach(w => {
      container.appendChild(renderWarriorCard(w, true, interactive));
    });
  }

  function renderWallStack(walls, side, interactive) {
    const div = el('div', {
      className: 'card card-sm in-field wall-stack',
      dataset: { type: 'wall' },
    });
    div.appendChild(el('div', { className: 'wall-stack-icon' }, ['🧱']));
    div.appendChild(el('div', { className: 'wall-stack-count' }, [String(walls.length)]));
    if (interactive) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        App.showWallSlideshow(walls, side, 0);
      });
    }
    return div;
  }

  function renderWallStackOpaque(count) {
    const div = el('div', {
      className: 'card card-sm in-field wall-stack',
      dataset: { type: 'wall' },
    });
    div.appendChild(el('div', { className: 'wall-stack-icon' }, ['🧱']));
    div.appendChild(el('div', { className: 'wall-stack-count' }, [String(count)]));
    return div;
  }

  function renderVillage(containerId, village) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    (village.buildings || []).forEach(b => {
      container.appendChild(renderBuildingCard(b, true));
    });
  }

  function renderLifeCards(player) {
    const container = document.getElementById('my-life-cards');
    if (!container) return;
    container.innerHTML = '';

    const lifeCards = player.life_cards || [];
    const lives = player.lives ?? lifeCards.length;

    // Slot visivi: uno per ogni vita iniziale (3)
    for (let i = 0; i < 3; i++) {
      const slot = el('div', { className: `life-slot ${i < lives ? 'life-slot-active' : 'life-slot-lost'}` });
      if (i < lifeCards.length) {
        const iid = lifeCards[i];
        const def = App.getCardDef ? App.getCardDef(iid) : null;
        slot.title = def ? def.name : iid;
        slot.textContent = '❤';
        slot.style.cursor = 'pointer';
        slot.addEventListener('click', () => App.onCardClick(iid, 'life_card'));
      } else {
        slot.textContent = '✕';
      }
      container.appendChild(slot);
    }
  }

  function renderHand(cards) {
    const container = document.getElementById('hand-cards');
    container.innerHTML = '';
    cards.forEach(iid => {
      container.appendChild(renderHandCard(iid));
    });
  }

  // ---------------------------------------------------------------------------
  // Carte
  // ---------------------------------------------------------------------------

  function renderHandCard(iid) {
    const div = el('div', { className: 'card', dataset: { instanceId: iid } });

    const def = App.getCardDef ? App.getCardDef(iid) : null;
    if (def) {
      div.dataset.type = def.type;
      div.dataset.baseId = def.id;

      div.appendChild(el('div', { className: 'card-name' }, [def.name]));

      if (def.type === 'warrior') {
        div.appendChild(el('div', {
          className: `card-species species-${def.species}`
        }, [`${capitalize(def.species)}${def.school ? ` · ${capitalize(def.school)}` : ''}`]));

        // Caratteristiche in colonna (auto-push verso il basso), mana in fondo
        const attrsDiv = el('div', { className: 'card-warrior-attrs' });
        attrsDiv.appendChild(el('span', { className: 'stat stat-att' }, [`⚔️ ${def.att}`]));
        attrsDiv.appendChild(el('span', { className: 'stat stat-git' }, [`🏹 ${def.git}`]));
        attrsDiv.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡️ ${def.dif}`]));
        div.appendChild(attrsDiv);
        div.appendChild(el('div', { className: 'hand-mana-row' }, [
          el('span', { className: 'stat stat-cost' }, [`💎${def.cost}`]),
        ]));

      } else if (def.type === 'spell') {
        div.appendChild(el('div', {
          className: `card-species school-${def.school}`
        }, [capitalize(def.school)]));

        div.appendChild(el('div', { className: 'card-stats hand-cost-row' }, [
          el('span', { className: 'stat stat-cost' }, [`🔮${def.cost}`]),
        ]));

      } else if (def.type === 'building') {
        div.appendChild(el('div', { className: 'card-stats hand-cost-row' }, [
          el('span', { className: 'stat stat-cost' }, [`💎${def.cost}`]),
          el('span', { className: 'stat stat-mana' }, [`🔨${def.completion_cost}`]),
        ]));
      }
    } else {
      div.appendChild(el('div', { className: 'card-name' }, [iid]));
    }

    div.addEventListener('click', () => App.onCardClick(iid, 'hand'));
    return div;
  }

  function renderWarriorCard(warrior, inField, interactive) {
    const div = el('div', { className: 'card card-sm in-field', dataset: {
      type: 'warrior',
      instanceId: warrior.instance_id,
      baseId: warrior.base_card_id,
    }});

    if (warrior.horde_active) div.classList.add('horde-active');

    div.appendChild(el('div', { className: 'card-name' }, [warrior.name || warrior.base_card_id]));
    div.appendChild(el('div', {
      className: `card-species species-${warrior.species}`
    }, [capitalize(warrior.species || '')]));

    const stats = el('div', { className: 'card-stats' });
    stats.appendChild(el('span', { className: 'stat stat-att' }, [`⚔️${warrior.att}`]));
    stats.appendChild(el('span', { className: 'stat stat-git' }, [`🏹${warrior.git}`]));
    stats.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡️${warrior.dif}`]));
    div.appendChild(stats);

    if (interactive) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => App.onCardClick(warrior.instance_id, 'field'));
    }
    return div;
  }

  function renderBuildingCard(building, inField) {
    const div = el('div', { className: `card card-sm in-field${building.completed ? ' completed' : ''}`,
      dataset: { type: 'building', instanceId: building.instance_id, baseId: building.base_card_id }
    });

    div.appendChild(el('div', { className: 'card-name' }, [building.name || building.base_card_id]));
    div.appendChild(el('div', { className: 'card-effect' }, [
      building.effect || ''
    ]));

    const badge = el('div', {
      className: 'card-species',
      style: `color: ${building.completed ? 'var(--gold)' : 'var(--text-dim)'}`
    }, [building.completed ? '✓ Completa' : '— Incompleta']);
    div.appendChild(badge);

    if (inField) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => App.onCardClick(building.instance_id, 'village'));
    }
    return div;
  }

  function renderCardSmall(warrior, interactive) {
    const div = renderWarriorCard(warrior, true, interactive);
    if (!interactive) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        App.onCardClick(warrior.instance_id, 'opponent');
      });
    }
    return div;
  }

  function renderBuildingSmall(b) {
    const div = el('div', {
      className: 'card card-sm in-field' + (b.completed ? ' completed' : ''),
      dataset: { type: 'building', instanceId: b.instance_id }
    });
    div.appendChild(el('div', { className: 'card-name' }, [b.name || b.base_card_id]));
    div.style.cursor = 'pointer';
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      App.onCardClick(b.instance_id, 'opponent');
    });
    return div;
  }

  function renderWall(wall) {
    const div = el('div', { className: 'wall-card' });
    div.title = wall.instance_id;
    div.textContent = '🧱';
    return div;
  }

  function renderWallBack() {
    const div = el('div', { className: 'wall-card' });
    div.textContent = '?';
    return div;
  }

  // ---------------------------------------------------------------------------
  // UI State helpers
  // ---------------------------------------------------------------------------

  function updateActionPanel(state, myPlayerId) {
    const isMyTurn = state.current_player_id === myPlayerId;
    document.getElementById('btn-end-turn').disabled = !isMyTurn;
    document.getElementById('btn-battle').disabled   = !isMyTurn || state.battles_remaining <= 0;
    // action-hint e banner sono gestiti da App._refreshActionUI()
  }

  function showTimerWarning(secondsLeft) {
    const timerEl = document.getElementById('turn-timer-display');
    timerEl.classList.remove('hidden');
    timerEl.textContent = `⏱ ${secondsLeft}s`;
    if (secondsLeft <= 15) timerEl.classList.add('warning');
    else timerEl.classList.remove('warning');
  }

  function hideTimer() {
    const timerEl = document.getElementById('turn-timer-display');
    timerEl.classList.add('hidden');
    timerEl.classList.remove('warning');
  }

  function updateBattleLog(text) {
    document.getElementById('battle-log').textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Card detail overlay
  // ---------------------------------------------------------------------------

  function showCardDetail(title, bodyHTML, actionLabel, onAction, onDiscard, extraButtons = [], navOptions = null) {
    document.getElementById('card-detail-title').textContent = title;
    document.getElementById('card-detail-body').innerHTML = bodyHTML;

    const actionBtn = document.getElementById('card-detail-action-btn');
    if (actionLabel && onAction) {
      actionBtn.textContent = actionLabel;
      actionBtn.onclick = onAction;
      actionBtn.classList.remove('hidden');
    } else {
      actionBtn.classList.add('hidden');
    }

    const discardBtn = document.getElementById('card-detail-discard-btn');
    if (onDiscard) {
      discardBtn.onclick = onDiscard;
      discardBtn.classList.remove('hidden');
    } else {
      discardBtn.classList.add('hidden');
    }

    const extraContainer = document.getElementById('card-detail-extra-btns');
    if (extraContainer) {
      extraContainer.innerHTML = '';
      extraButtons.forEach(btn => {
        const el = document.createElement('button');
        el.textContent = btn.label;
        el.className = `btn ${btn.className || 'btn-secondary'}`;
        el.disabled = !!btn.disabled;
        el.onclick = btn.onClick;
        extraContainer.appendChild(el);
      });
    }

    const prevBtn = document.getElementById('card-nav-prev');
    const nextBtn = document.getElementById('card-nav-next');
    if (prevBtn && nextBtn) {
      if (navOptions && navOptions.onPrev) {
        prevBtn.onclick = navOptions.onPrev;
        prevBtn.classList.remove('hidden');
      } else {
        prevBtn.classList.add('hidden');
      }
      if (navOptions && navOptions.onNext) {
        nextBtn.onclick = navOptions.onNext;
        nextBtn.classList.remove('hidden');
      } else {
        nextBtn.classList.add('hidden');
      }
    }

    const overlay = document.getElementById('card-detail-overlay');
    overlay.classList.remove('hidden');
    document.getElementById('card-detail-close').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
  }

  function closeCardDetail() {
    document.getElementById('card-detail-overlay').classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Modale generica
  // ---------------------------------------------------------------------------

  function showModal(title, bodyHTML, onConfirm, onCancel) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-overlay').classList.remove('hidden');

    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn  = document.getElementById('modal-cancel');

    const cleanup = () => {
      document.getElementById('modal-overlay').classList.add('hidden');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };

    confirmBtn.onclick = () => { cleanup(); onConfirm && onConfirm(); };
    cancelBtn.onclick  = () => { cleanup(); onCancel  && onCancel();  };
  }

  function showChoiceModal(title, options, onChoice) {
    const optionsDiv = el('div', { className: 'modal-options' });
    let selected = null;

    options.forEach((opt, i) => {
      const btn = el('div', { className: 'modal-option' }, [opt.label]);
      btn.addEventListener('click', () => {
        optionsDiv.querySelectorAll('.modal-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selected = opt.value;
      });
      optionsDiv.appendChild(btn);
    });

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    const body = document.getElementById('modal-body');
    body.innerHTML = '';
    body.appendChild(optionsDiv);
    overlay.classList.remove('hidden');

    document.getElementById('modal-confirm').onclick = () => {
      overlay.classList.add('hidden');
      if (selected !== null) onChoice(selected);
    };
    document.getElementById('modal-cancel').onclick = () => {
      overlay.classList.add('hidden');
    };
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  function toast(message, type = '') {
    const t = el('div', { className: `toast${type ? ' ' + type : ''}` }, [message]);
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ---------------------------------------------------------------------------
  // Schermata fine partita
  // ---------------------------------------------------------------------------

  function showGameOver(state) {
    showScreen('gameover');
    const winner = state.players.find(p => p.id === state.winner_id);
    document.getElementById('gameover-winner').textContent =
      winner ? `Vincitore: ${winner.name} 🏆` : 'Nessun vincitore';
    document.getElementById('gameover-scores').innerHTML =
      state.players.map(p => `${p.name}: ${livesText(p.lives)} Vite`).join('<br>');
  }

  // ---------------------------------------------------------------------------
  // Schermate
  // ---------------------------------------------------------------------------

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${name}`);
    if (target) target.classList.add('active');
  }

  // ---------------------------------------------------------------------------
  // Helpers DOM
  // ---------------------------------------------------------------------------

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') node.className = v;
      else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => node.dataset[dk] = dv);
      else if (k === 'style' && typeof v === 'string') node.style.cssText = v;
      else node.setAttribute(k, v);
    });
    children.forEach(c => {
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });
    return node;
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }

  function livesText(lives) {
    return '❤️'.repeat(Math.max(0, lives)) + '🖤'.repeat(Math.max(0, 3 - lives));
  }

  function livesHTML(lives) {
    return livesText(lives);
  }

  function phaseLabel(phase) {
    const map = {
      action: 'Azione', reposition: 'Riposizionamento',
      horde: 'Orda', battle: 'Battaglia', draw: 'Pesca', end: 'Fine'
    };
    return map[phase] || phase;
  }

  function getPlayerName(state, pid) {
    const p = state.players.find(p => p.id === pid);
    return p ? p.name : pid;
  }

  return {
    render,
    showScreen,
    showModal,
    showChoiceModal,
    showCardDetail,
    closeCardDetail,
    toast,
    showGameOver,
    showTimerWarning,
    hideTimer,
    updateBattleLog,
    el,
    livesText,
  };
})();
