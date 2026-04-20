/**
 * renderer.js — Rendering del campo da gioco di Barbacane
 * Costruisce il DOM a partire dallo stato di gioco ricevuto dal server.
 */

const Renderer = (() => {

  // ---------------------------------------------------------------------------
  // Render dello stato completo
  // ---------------------------------------------------------------------------

  function render(state, myPlayerId) {
    if (!state) return;

    // Header
    document.getElementById('hdr-turn').textContent = `Turno ${state.turn}`;
    document.getElementById('hdr-phase').textContent = `Fase: ${phaseLabel(state.phase)}`;
    document.getElementById('hdr-current-player').textContent =
      `Il turno di: ${getPlayerName(state, state.current_player_id)}`;
    document.getElementById('hdr-deck').textContent = `Mazzo: ${state.deck_count}`;

    const myPlayer = state.players.find(p => p.id === myPlayerId);
    const opponents = state.players.filter(p => p.id !== myPlayerId);

    // Campi avversari
    renderOpponents(opponents, state);

    // Il mio campo
    if (myPlayer) {
      renderMyField(myPlayer, state, myPlayerId);
    }

    // Pannello azioni
    updateActionPanel(state, myPlayerId);
  }

  // ---------------------------------------------------------------------------
  // Avversari
  // ---------------------------------------------------------------------------

  function renderOpponents(opponents, state) {
    const area = document.getElementById('opponents-area');
    area.innerHTML = '';
    opponents.forEach(p => {
      area.appendChild(renderOpponentField(p, state));
    });
  }

  function renderOpponentField(player, state) {
    const div = document.createElement('div');
    div.className = 'opponent-field' + (player.id === state.current_player_id ? ' active-player' : '');
    div.dataset.playerId = player.id;

    // Info giocatore
    const info = el('div', { className: 'opp-info' }, [
      el('div', { className: 'opp-name' }, [player.name]),
      el('div', { className: 'opp-lives' }, ['❤'.repeat(Math.max(0, player.lives)) + '✕'.repeat(Math.max(0, 3 - player.lives))]),
      el('div', { className: 'opp-hand-count' }, [`Mano: ${player.hand_count} carte`]),
    ]);

    const regions = el('div', { className: 'opp-regions' });

    // Bastione sinistro
    regions.appendChild(renderOppBastion(player.field.bastion_left, 'Bastione S.', player.id, 'left'));
    // Avanscoperta
    regions.appendChild(renderOppVanguard(player.field.vanguard));
    // Bastione destro
    regions.appendChild(renderOppBastion(player.field.bastion_right, 'Bastione D.', player.id, 'right'));
    // Villaggio
    regions.appendChild(renderOppVillage(player.field.village));

    div.appendChild(info);
    div.appendChild(regions);
    return div;
  }

  function renderOppBastion(bastion, label, playerId, side) {
    const div = el('div', { className: 'opp-region' });
    div.appendChild(el('div', { className: 'opp-region-label' }, [label]));

    const walls = el('div', { className: 'opp-wall-count' },
      [`🧱 ${bastion.wall_count}`]);
    div.appendChild(walls);

    if (bastion.warriors && bastion.warriors.length > 0) {
      const ws = el('div', { className: 'opp-warriors' });
      bastion.warriors.forEach(w => ws.appendChild(renderCardSmall(w, false)));
      div.appendChild(ws);
    }

    // Rende cliccabile per attaccare
    div.dataset.targetPlayerId = playerId;
    div.dataset.targetSide = side;
    div.classList.add('attack-target');
    div.title = `Attacca Bastione ${side === 'left' ? 'Sinistro' : 'Destro'} di ${playerId}`;

    return div;
  }

  function renderOppVanguard(warriors) {
    const div = el('div', { className: 'opp-region' });
    div.appendChild(el('div', { className: 'opp-region-label' }, ['Avanscoperta']));
    const ws = el('div', { className: 'opp-warriors' });
    (warriors || []).forEach(w => ws.appendChild(renderCardSmall(w, false)));
    div.appendChild(ws);
    return div;
  }

  function renderOppVillage(village) {
    const div = el('div', { className: 'opp-region' });
    div.appendChild(el('div', { className: 'opp-region-label' }, ['Villaggio']));
    const bs = el('div', { className: 'opp-buildings' });
    (village.buildings || []).forEach(b => bs.appendChild(renderBuildingSmall(b)));
    div.appendChild(bs);
    return div;
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

    // Muri
    const wallDiv = el('div', { className: 'walls-row', style: 'display:flex;flex-wrap:wrap;gap:2px;' });
    (bastion.walls || []).forEach(w => {
      wallDiv.appendChild(renderWall(w));
    });
    if (bastion.wall_count > 0 && !(bastion.walls)) {
      for (let i = 0; i < bastion.wall_count; i++) {
        wallDiv.appendChild(renderWallBack());
      }
    }
    if (wallDiv.children.length) container.appendChild(wallDiv);

    // Guerrieri
    (bastion.warriors || []).forEach(w => {
      container.appendChild(renderWarriorCard(w, true, interactive));
    });
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

    // Il nome e tipo vengono dal registry locale (App.cardDefs)
    const def = App.getCardDef ? App.getCardDef(iid) : null;
    if (def) {
      div.dataset.type = def.type;
      div.dataset.baseId = def.id;

      div.appendChild(el('div', { className: 'card-name' }, [def.name]));

      if (def.type === 'warrior') {
        div.appendChild(el('div', {
          className: `card-species species-${def.species}`
        }, [`${capitalize(def.species)}${def.school ? ` · ${capitalize(def.school)}` : ''}`]));

        const stats = el('div', { className: 'card-stats' }, [
          el('span', { className: 'stat stat-cost' }, [`⚡${def.cost}`]),
          el('span', { className: 'stat stat-att' },  [`⚔${def.att}`]),
          el('span', { className: 'stat stat-git' },  [`🏹${def.git}`]),
          el('span', { className: 'stat stat-dif' },  [`🛡${def.dif}`]),
        ]);
        div.appendChild(stats);

        if (def.horde_effect) {
          div.appendChild(el('div', { className: 'card-effect' }, [def.horde_effect]));
        }

      } else if (def.type === 'spell') {
        div.appendChild(el('div', {
          className: `card-species school-${def.school}`
        }, [capitalize(def.school)]));

        div.appendChild(el('div', { className: 'card-stats' }, [
          el('span', { className: 'stat stat-cost' }, [`👁${def.cost} Maghe`]),
        ]));
        div.appendChild(el('div', { className: 'card-effect' }, [def.base_effect]));

      } else if (def.type === 'building') {
        div.appendChild(el('div', { className: 'card-stats' }, [
          el('span', { className: 'stat stat-cost' }, [`⚡${def.cost}`]),
          el('span', { className: 'stat stat-mana' }, [`Comp:${def.completion_cost}`]),
        ]));
        div.appendChild(el('div', { className: 'card-effect' }, [def.base_effect]));
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
    stats.appendChild(el('span', { className: 'stat stat-att' }, [`⚔${warrior.att}`]));
    stats.appendChild(el('span', { className: 'stat stat-git' }, [`🏹${warrior.git}`]));
    stats.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡${warrior.dif}`]));
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

  function showCardDetail(title, bodyHTML, actionLabel, onAction, onDiscard) {
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
