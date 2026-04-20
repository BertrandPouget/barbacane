/**
 * app.js — Logica principale del client Barbacane
 */

const App = (() => {

  // ---------------------------------------------------------------------------
  // Stato locale
  // ---------------------------------------------------------------------------

  let sessionToken = null;
  let myPlayerId = null;
  let lobbyCode = null;
  let gameId = null;
  let isCreator = false;
  let currentState = null;
  let cardDefs = {};
  let instanceMap = {};
  let selectedCard = null;

  // Macchina a stati per le azioni del turno
  let actionMode = null;    // null | 'play_card' | 'complete_building' | 'add_walls'
  let wallsSelected = [];   // [{instanceId, bastion: 'left'|'right'}]

  // Timer
  let timerInterval = null;
  let timerSecondsLeft = 0;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    await loadCardDefs();
    bindLobbyUI();
    Renderer.showScreen('lobby');
  }

  async function loadCardDefs() {
    try {
      const res = await fetch('/data/cards.json');
      const data = await res.json();
      [...data.warriors, ...data.spells, ...data.buildings].forEach(c => {
        cardDefs[c.id] = c;
      });
      Object.values(cardDefs).forEach(c => {
        for (let i = 1; i <= c.copies; i++) {
          instanceMap[`${c.id}_${i}`] = c.id;
        }
      });
    } catch (e) {
      console.error('Impossibile caricare cards.json', e);
    }
  }

  function getCardDef(instanceId) {
    const baseId = instanceMap[instanceId] || instanceId.replace(/_\d+$/, '');
    return cardDefs[baseId] || null;
  }

  // ---------------------------------------------------------------------------
  // UI Lobby
  // ---------------------------------------------------------------------------

  function bindLobbyUI() {
    document.getElementById('btn-create').addEventListener('click', onCreateLobby);
    document.getElementById('btn-join').addEventListener('click', onJoinLobby);
    document.getElementById('btn-start').addEventListener('click', onStartGame);
    document.getElementById('btn-end-turn').addEventListener('click', onEndTurn);
    document.getElementById('btn-battle').addEventListener('click', onBattleClick);
    document.getElementById('btn-horde').addEventListener('click', onHordeClick);

    // Banner azione
    document.getElementById('banner-btn-play').addEventListener('click', enterPlayCardMode);
    document.getElementById('banner-btn-complete').addEventListener('click', enterCompleteBuildingMode);
    document.getElementById('banner-btn-wall').addEventListener('click', enterAddWallsMode);
    document.getElementById('btn-cancel-action').addEventListener('click', cancelActionMode);
    document.getElementById('wall-confirm-btn').addEventListener('click', confirmWalls);

    document.getElementById('join-code').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase();
    });
  }

  async function onCreateLobby() {
    const name = document.getElementById('create-name').value.trim();
    const timer = parseInt(document.getElementById('create-timer').value) || 120;
    if (!name) { Renderer.toast('Inserisci il tuo nome', 'error'); return; }
    try {
      const res = await api('/lobby/create', { player_name: name, turn_timer: timer });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      lobbyCode = res.lobby_code;
      isCreator = true;
      showWaitingRoom(res.lobby);
      connectWS();
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

  async function onJoinLobby() {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!name) { Renderer.toast('Inserisci il tuo nome', 'error'); return; }
    if (!code) { Renderer.toast('Inserisci il codice lobby', 'error'); return; }
    try {
      const res = await api('/lobby/join', { lobby_code: code, player_name: name });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      lobbyCode = res.lobby_code;
      isCreator = false;
      showWaitingRoom(res.lobby);
      connectWS();
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

  function showWaitingRoom(lobby) {
    lobbyCode = lobby.lobby_code;
    document.getElementById('lobby-code-text').textContent = lobby.lobby_code;
    updateWaitingPlayers(lobby.players);
    document.getElementById('btn-start').style.display = isCreator ? 'block' : 'none';
    document.getElementById('waiting-status').textContent = '';
    Renderer.showScreen('waiting');
  }

  function updateWaitingPlayers(players) {
    const list = document.getElementById('waiting-players');
    list.innerHTML = '';
    players.forEach(p => {
      const item = document.createElement('div');
      item.className = 'player-list-item';
      item.innerHTML = `<span class="dot"></span><span>${p.name}</span>`;
      list.appendChild(item);
    });
  }

  async function onStartGame() {
    try {
      document.getElementById('waiting-status').textContent = 'Avvio partita…';
      const res = await api('/lobby/start', { lobby_code: lobbyCode, session_token: sessionToken });
      gameId = res.game_id;
      enterGame(res.state);
    } catch (e) {
      document.getElementById('waiting-status').textContent = e.message;
      Renderer.toast(e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket / polling lobby
  // ---------------------------------------------------------------------------

  function connectWS() { startLobbyPolling(); }

  let lobbyPollTimer = null;

  function startLobbyPolling() {
    stopLobbyPolling();
    lobbyPollTimer = setInterval(async () => {
      try {
        const lobby = await apiFetch(`/lobby/${lobbyCode}`);
        updateWaitingPlayers(lobby.players);
        document.getElementById('btn-start').disabled = !lobby.can_start;
        if (lobby.game_id && !gameId) {
          stopLobbyPolling();
          gameId = lobby.game_id;
          const gameState = await apiFetch(`/game/${lobby.game_id}?session_token=${sessionToken}`);
          enterGame(gameState);
        }
      } catch (_) {}
    }, 2000);
  }

  function stopLobbyPolling() { clearInterval(lobbyPollTimer); lobbyPollTimer = null; }

  function connectGameWS() {
    if (!gameId || !myPlayerId) return;
    WS.connect(gameId, myPlayerId);

    WS.on('state_update', (msg) => {
      if (msg.state) onStateUpdate(msg.state, msg.action, msg.result);
    });
    WS.on('game_started', (msg) => {
      if (msg.state) enterGame(msg.state);
    });
    WS.on('turn_started', (msg) => {
      stopLocalTimer();
      Renderer.hideTimer();
      if (msg.seconds && msg.seconds > 0) {
        timerSecondsLeft = msg.seconds;
        startLocalTimer(msg.seconds);
        if (msg.player_id !== myPlayerId) {
          const name = currentState
            ? ((currentState.players.find(p => p.id === msg.player_id) || {}).name || msg.player_id)
            : msg.player_id;
          Renderer.toast(`Turno di ${name} (${msg.seconds}s)`, 'info');
        }
      }
    });
    WS.on('turn_warning', (msg) => {
      timerSecondsLeft = msg.seconds_left;
      Renderer.showTimerWarning(timerSecondsLeft);
      startLocalTimer(timerSecondsLeft);
    });
    WS.on('player_connected',    (msg) => Renderer.toast(`${msg.player_id} si è connesso`, 'success'));
    WS.on('player_disconnected', (msg) => Renderer.toast(`${msg.player_id} si è disconnesso`, 'error'));
    WS.on('error', (msg) => Renderer.toast(msg.message || 'Errore', 'error'));
  }

  function onStateUpdate(state, action, result) {
    currentState = state;
    Renderer.render(state, myPlayerId);

    if (result) {
      // Flash danno sul campo del difensore
      if (result.life_lost > 0) {
        const defPlayer = state.players.find(p => p.id === result.defender_id);
        if (defPlayer) {
          const fieldEl = document.querySelector(`[data-player-id="${defPlayer.id}"]`);
          if (fieldEl) {
            fieldEl.classList.add('damaged');
            setTimeout(() => fieldEl.classList.remove('damaged'), 600);
          }
        }
      }

      // Log battaglia
      if (action === 'battle') {
        const log = `⚔ ${result.attacker_id} → ${result.defender_id} [${result.defender_bastion}]: `
          + `${result.total_damage} Danni, ${result.walls_destroyed} Muri, ${result.life_lost} Vita`;
        Renderer.updateBattleLog(log);
      }

      // Eracle: distruggi una costruzione avversaria
      if (action === 'battle' && result.eracle_destroy_triggered && result.eracle_targets && result.eracle_targets.length > 0
          && state.current_player_id === myPlayerId) {
        const options = result.eracle_targets.map(b => {
          const def = getCardDef(b.instance_id);
          return { label: def ? def.name : b.base_card_id, value: b.instance_id };
        });
        Renderer.showChoiceModal('⚡ Eracle — distruggi una Costruzione avversaria', options, (buildingIId) => {
          sendAction('eracle_destroy', {
            building_instance_id: buildingIId,
            target_player_id: result.defender_id,
          });
        });
        return; // non chiudere il modale; la UI si aggiornerà dopo eracle_destroy
      }
    }

    // D10 — mostra tutti gli eventi recenti (Estrattore, Granaio, Obelisco, Fucina)
    if (state.recent_events && state.recent_events.length > 0) {
      state.recent_events.forEach(ev => {
        if (ev.type !== 'd10') return;
        const pName = (state.players.find(p => p.id === ev.player_id) || {}).name || ev.player_id;
        let msg, good;
        if (ev.card === 'estrattore') {
          good = ev.triggered;
          msg = `🎲 ${pName} — Estrattore: D10=${ev.roll} — ${good ? `✓ +${ev.mana_gained} Mana!` : '✗ Nessun mana'}`;
        } else if (ev.card === 'granaio') {
          good = ev.triggered;
          msg = `🎲 ${pName} — Granaio: D10=${ev.roll} — ${good ? `✓ ${ev.cards_drawn} carta pescata!` : '✗ Nessuna carta'}`;
        } else if (ev.card === 'obelisco') {
          good = ev.returned;
          msg = `🎲 ${pName} — Obelisco: D10=${ev.roll} (soglia ${ev.threshold}) — ${good ? '✓ Magia in mano!' : '✗ Magia scartata'}`;
        } else if (ev.card === 'fucina') {
          good = ev.extra_action;
          msg = `🎲 ${pName} — Fucina: D10=${ev.roll} — ${good ? '✓ Azione extra!' : '✗ Nessuna azione extra'}`;
        } else {
          return;
        }
        Renderer.toast(msg, good ? 'success' : 'info');
      });
    }

    if (state.winner_id) {
      setTimeout(() => Renderer.showGameOver(state), 800);
    }

    // Chiudi eventuale modale aperta e aggiorna la UI azioni
    document.getElementById('modal-overlay').classList.add('hidden');
    _refreshActionUI();

    // Reset timer display quando ricevi un state update (il turn_started WS lo riavvierà)
    if (state.current_player_id === myPlayerId) {
      stopLocalTimer();
      Renderer.hideTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Gioco
  // ---------------------------------------------------------------------------

  function enterGame(state) {
    stopLobbyPolling();
    gameId = gameId || state.game_id;
    currentState = state;
    connectGameWS();
    Renderer.showScreen('game');
    Renderer.render(state, myPlayerId);
    _refreshActionUI();
  }

  // ---------------------------------------------------------------------------
  // Timer locale
  // ---------------------------------------------------------------------------

  function startLocalTimer(seconds) {
    stopLocalTimer();
    timerSecondsLeft = seconds;
    timerInterval = setInterval(() => {
      timerSecondsLeft--;
      if (timerSecondsLeft <= 0) { stopLocalTimer(); Renderer.hideTimer(); }
      else Renderer.showTimerWarning(timerSecondsLeft);
    }, 1000);
  }

  function stopLocalTimer() { clearInterval(timerInterval); timerInterval = null; }

  // ---------------------------------------------------------------------------
  // Macchina a stati per le azioni
  // ---------------------------------------------------------------------------

  function _refreshActionUI() {
    // Resetta lo stato azione dopo ogni aggiornamento server
    actionMode = null;
    wallsSelected = [];
    selectedCard = null;

    document.getElementById('wall-staging').classList.add('hidden');
    document.getElementById('btn-cancel-action').classList.add('hidden');
    document.getElementById('selection-info').classList.add('hidden');
    document.querySelectorAll('#hand-cards .card.wall-marked').forEach(c => c.classList.remove('wall-marked'));

    if (!currentState) return;
    const isMyTurn = currentState.current_player_id === myPlayerId;
    const player = currentState.players.find(p => p.id === myPlayerId);

    // Horde button: visible when it's my turn and there's at least one non-activated horde
    const hasHorde = isMyTurn && player &&
      player.available_hordes && player.available_hordes.some(h => !h.already_activated);
    document.getElementById('btn-horde').classList.toggle('hidden', !hasHorde);

    if (!isMyTurn) {
      document.getElementById('action-banner').classList.add('hidden');
      const name = (currentState.players.find(p => p.id === currentState.current_player_id) || {}).name || '…';
      document.getElementById('action-hint').textContent = `In attesa di ${name}…`;
      return;
    }

    if (!player || player.actions_remaining <= 0) {
      document.getElementById('action-banner').classList.add('hidden');
      document.getElementById('action-hint').textContent = 'Nessuna azione rimasta. Puoi attaccare o finire il turno.';
      return;
    }

    _showBanner(player);
  }

  // ---------------------------------------------------------------------------
  // Orda
  // ---------------------------------------------------------------------------

  function onHordeClick() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    const player = currentState.players.find(p => p.id === myPlayerId);
    if (!player) return;

    const hordes = (player.available_hordes || []).filter(h => !h.already_activated);
    if (hordes.length === 0) {
      Renderer.toast('Nessuna Orda disponibile', 'error');
      return;
    }

    const zoneNames = {
      vanguard: 'Avanscoperta',
      bastion_left: 'Bastione Sin.',
      bastion_right: 'Bastione Des.',
    };
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    const options = [];
    for (const horde of hordes) {
      const zoneName = zoneNames[horde.zone] || horde.zone;
      for (const w of horde.warriors) {
        options.push({
          label: `[${cap(horde.species)}, ${zoneName}] ${w.name}: ${w.horde_effect}`,
          value: `${w.base_card_id}|${w.instance_id}|${horde.zone}`,
        });
      }
    }

    Renderer.showChoiceModal('Attiva Effetto Orda', options, (choice) => {
      const [hordeCArId, warriorIId, hZone] = choice.split('|');
      sendAction('horde', { horde_card_id: hordeCArId, warrior_instance_id: warriorIId, zone: hZone });
    });
  }

  function _showBanner(player) {
    const actNum = 3 - player.actions_remaining; // 1 o 2
    document.getElementById('banner-turn-label').textContent = `Azione ${actNum} di 2`;

    const hasCards = player.hand && player.hand.length > 0;
    const hasIncomplete = (player.field.village.buildings || []).some(b => !b.completed);

    document.getElementById('banner-btn-play').disabled     = !hasCards;
    document.getElementById('banner-btn-complete').disabled = !hasIncomplete;
    document.getElementById('banner-btn-wall').disabled     = !hasCards;

    document.getElementById('action-banner').classList.remove('hidden');
    document.getElementById('action-hint').textContent = '';
  }

  function enterPlayCardMode() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    actionMode = 'play_card';
    document.getElementById('action-banner').classList.add('hidden');
    document.getElementById('btn-cancel-action').classList.remove('hidden');
    document.getElementById('action-hint').textContent = 'Clicca una carta dalla mano.';
  }

  function enterCompleteBuildingMode() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    const player = currentState.players.find(p => p.id === myPlayerId);
    const buildings = (player.field.village.buildings || []).filter(b => !b.completed);
    if (buildings.length === 0) return;

    actionMode = 'complete_building';
    document.getElementById('action-banner').classList.add('hidden');
    document.getElementById('btn-cancel-action').classList.remove('hidden');
    document.getElementById('action-hint').textContent = 'Scegli la costruzione da completare.';

    Renderer.showChoiceModal(
      'Completa una costruzione',
      buildings.map(b => {
        const def = getCardDef(b.instance_id);
        return {
          label: `${def ? def.name : b.base_card_id} — ${def ? def.completion_cost : '?'} Mana`,
          value: b.instance_id,
        };
      }),
      (instanceId) => sendAction('complete_building', { building_instance_id: instanceId }),
    );
  }

  function enterAddWallsMode() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    actionMode = 'add_walls';
    wallsSelected = [];
    document.getElementById('action-banner').classList.add('hidden');
    document.getElementById('btn-cancel-action').classList.remove('hidden');
    document.getElementById('wall-staging').classList.remove('hidden');
    document.getElementById('action-hint').textContent = 'Clicca carte dalla mano (max 3).';
    renderWallStaging();
  }

  function cancelActionMode() {
    actionMode = null;
    wallsSelected = [];
    selectedCard = null;
    document.getElementById('wall-staging').classList.add('hidden');
    document.getElementById('btn-cancel-action').classList.add('hidden');
    document.getElementById('action-hint').textContent = '';
    document.getElementById('selection-info').classList.add('hidden');
    document.querySelectorAll('#hand-cards .card.wall-marked').forEach(c => c.classList.remove('wall-marked'));

    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    const player = currentState.players.find(p => p.id === myPlayerId);
    if (player && player.actions_remaining > 0) _showBanner(player);
  }

  // ---------------------------------------------------------------------------
  // Selezione muri
  // ---------------------------------------------------------------------------

  function toggleWallCard(instanceId) {
    const idx = wallsSelected.findIndex(w => w.instanceId === instanceId);
    if (idx >= 0) {
      wallsSelected.splice(idx, 1);
    } else {
      if (wallsSelected.length >= 3) {
        Renderer.toast('Massimo 3 muri per azione', 'error');
        return;
      }
      wallsSelected.push({ instanceId, bastion: 'left' });
    }
    renderWallStaging();
    _updateWallMarkings();
  }

  function _updateWallMarkings() {
    document.querySelectorAll('#hand-cards .card').forEach(card => {
      card.classList.toggle('wall-marked', !!wallsSelected.find(w => w.instanceId === card.dataset.instanceId));
    });
  }

  function renderWallStaging() {
    const list       = document.getElementById('wall-selected-list');
    const countEl    = document.getElementById('wall-count');
    const confirmBtn = document.getElementById('wall-confirm-btn');

    countEl.textContent = wallsSelected.length;
    confirmBtn.disabled = wallsSelected.length === 0;
    list.innerHTML = '';

    wallsSelected.forEach(w => {
      const def = getCardDef(w.instanceId);
      const row = document.createElement('div');
      row.className = 'wall-entry';

      const nameEl = document.createElement('div');
      nameEl.className = 'wall-entry-name';
      nameEl.textContent = (def ? def.name : w.instanceId).substring(0, 14);
      row.appendChild(nameEl);

      const btns = document.createElement('div');
      btns.className = 'wall-entry-btns';

      const btnL = document.createElement('button');
      btnL.textContent = 'Sin.';
      btnL.className = `btn btn-small ${w.bastion === 'left' ? 'btn-primary' : 'btn-secondary'}`;
      btnL.onclick = () => { w.bastion = 'left'; renderWallStaging(); };

      const btnR = document.createElement('button');
      btnR.textContent = 'Des.';
      btnR.className = `btn btn-small ${w.bastion === 'right' ? 'btn-primary' : 'btn-secondary'}`;
      btnR.onclick = () => { w.bastion = 'right'; renderWallStaging(); };

      const btnX = document.createElement('button');
      btnX.textContent = '×';
      btnX.className = 'btn btn-small btn-danger';
      btnX.onclick = () => { toggleWallCard(w.instanceId); };

      btns.append(btnL, btnR, btnX);
      row.appendChild(btns);
      list.appendChild(row);
    });
  }

  function confirmWalls() {
    if (wallsSelected.length === 0) return;
    const walls = wallsSelected.map(w => ({ instance_id: w.instanceId, bastion: w.bastion }));
    sendAction('add_wall', { walls });
  }

  // ---------------------------------------------------------------------------
  // Interazione carte
  // ---------------------------------------------------------------------------

  function onCardClick(instanceId, source) {
    if (!currentState) return;

    // In modalità muro, il click sulla mano toglie/aggiunge la carta alla selezione
    if (source === 'hand' && actionMode === 'add_walls') {
      if (currentState.current_player_id !== myPlayerId) return;
      toggleWallCard(instanceId);
      return;
    }

    // In tutti gli altri casi: mostra il dettaglio della carta
    showCardDetail(instanceId, source === 'life_card' ? 'life_card' : source);
  }

  // ---------------------------------------------------------------------------
  // Arena helpers
  // ---------------------------------------------------------------------------

  function _getAllWarriors(player) {
    return [
      ...(player.field.vanguard || []),
      ...(player.field.bastion_left.warriors || []),
      ...(player.field.bastion_right.warriors || []),
    ];
  }

  function _canActivateArena(buildingInstanceId) {
    if (!currentState || currentState.current_player_id !== myPlayerId) return false;
    const player = currentState.players.find(p => p.id === myPlayerId);
    if (!player) return false;
    const building = player.field.village.buildings.find(b => b.instance_id === buildingInstanceId);
    if (!building || building.arena_available === false) return false;
    const myWarriors = _getAllWarriors(player);
    if (myWarriors.length === 0) return false;
    const enemies = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);
    for (const ow of myWarriors) {
      for (const enemy of enemies) {
        for (const ew of _getAllWarriors(enemy)) {
          if (ow.att > ew.att || ow.git > ew.git || ow.dif > ew.dif) return true;
        }
      }
    }
    return false;
  }

  function _showArenaFlow(buildingInstanceId) {
    const player = currentState.players.find(p => p.id === myPlayerId);
    if (!player) return;
    const myWarriors = _getAllWarriors(player);
    const enemies = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);

    const myOptions = myWarriors.map(w => ({
      label: `${w.name} (ATT ${w.att}  GIT ${w.git}  DIF ${w.dif})`,
      value: w.instance_id,
    }));

    Renderer.showChoiceModal('Arena — scegli il tuo Guerriero da sacrificare', myOptions, (ownIid) => {
      const ownW = myWarriors.find(w => w.instance_id === ownIid);
      if (!ownW) return;

      const validTargets = [];
      enemies.forEach(p => {
        _getAllWarriors(p).forEach(ew => {
          if (ownW.att > ew.att || ownW.git > ew.git || ownW.dif > ew.dif) {
            validTargets.push({
              label: `${p.name}: ${ew.name} (ATT ${ew.att}  GIT ${ew.git}  DIF ${ew.dif})`,
              value: `${p.id}:${ew.instance_id}`,
            });
          }
        });
      });

      if (validTargets.length === 0) {
        Renderer.toast('Nessun bersaglio valido per questo guerriero', 'error');
        return;
      }

      Renderer.showChoiceModal('Arena — scegli il Guerriero avversario da scartare', validTargets, (choice) => {
        const colonIdx = choice.indexOf(':');
        const targetPlayerId = choice.substring(0, colonIdx);
        const targetWarriorIid = choice.substring(colonIdx + 1);
        sendAction('arena_activate', {
          building_instance_id: buildingInstanceId,
          own_warrior_iid: ownIid,
          target_warrior_iid: targetWarriorIid,
          target_player_id: targetPlayerId,
        });
      });
    });
  }

  // Costruisce e mostra il pannello di dettaglio per qualsiasi carta
  function showCardDetail(instanceId, source) {
    const def = getCardDef(instanceId);
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    // Recupera dati contestuali dallo stato
    let fieldWarrior = null;
    let fieldBuilding = null;
    if (currentState) {
      for (const player of currentState.players) {
        const w = [
          ...(player.field.vanguard || []),
          ...(player.field.bastion_left.warriors || []),
          ...(player.field.bastion_right.warriors || []),
        ].find(w => w.instance_id === instanceId);
        if (w) { fieldWarrior = w; break; }

        const b = (player.field.village.buildings || []).find(b => b.instance_id === instanceId);
        if (b) { fieldBuilding = b; break; }
      }
    }

    // Costruisce il corpo HTML del dettaglio
    let bodyHTML = '';

    if (def && def.type === 'warrior') {
      const att = fieldWarrior ? fieldWarrior.att : def.att;
      const git = fieldWarrior ? fieldWarrior.git : def.git;
      const dif = fieldWarrior ? fieldWarrior.dif : def.dif;

      bodyHTML += `<div class="detail-meta">
        <span class="species-${def.species}">${cap(def.species)}</span>
        ${def.school ? `· <span>${cap(def.school)}</span>` : ''}
        · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}
        · ⚡${def.cost} Mana
      </div>
      <div class="detail-stats">
        <span class="stat-att">⚔ ATT ${att}</span>
        <span class="stat-git">🏹 GIT ${git}</span>
        <span class="stat-dif">🛡 DIF ${dif}</span>
      </div>`;
      if (def.horde_effect) {
        bodyHTML += `<div class="detail-section"><strong>⚡ Effetto Orda:</strong><br>${def.horde_effect}</div>`;
      }
      if (def.evolves_from) bodyHTML += `<div class="detail-dim">Evolve da: ${def.evolves_from}</div>`;
      if (def.evolves_into) bodyHTML += `<div class="detail-dim">Evolve in: ${def.evolves_into}</div>`;

    } else if (def && def.type === 'spell') {
      bodyHTML += `<div class="detail-meta">
        <span class="school-${def.school}">${cap(def.school)}</span> · Magia · 👁 ${def.cost} Maghe
      </div>
      <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
      if (def.prodigy_effect) {
        bodyHTML += `<div class="detail-section detail-prodigy"><strong>✨ Prodigio:</strong><br>${def.prodigy_effect}</div>`;
      }

    } else if (def && def.type === 'building') {
      const status = fieldBuilding ? (fieldBuilding.completed ? ' · <span style="color:var(--gold)">✓ Completata</span>' : ' · Incompleta') : '';
      bodyHTML += `<div class="detail-meta">Costruzione · ⚡${def.cost} Mana · Comp: ${def.completion_cost} Mana${status}</div>
      <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
      if (def.complete_effect) {
        bodyHTML += `<div class="detail-section detail-gold"><strong>✓ Effetto Completo:</strong><br>${def.complete_effect}</div>`;
      }

    } else {
      bodyHTML = `<div class="detail-dim">${instanceId}</div>`;
    }

    // Bottone contestuale
    const isMyTurn = currentState && currentState.current_player_id === myPlayerId;
    let actionLabel = null;
    let onAction = null;
    const extraButtons = [];

    if (source === 'hand' && isMyTurn) {
      if (actionMode === 'play_card' || actionMode === null) {
        const player = currentState.players.find(p => p.id === myPlayerId);
        if (player && player.actions_remaining > 0) {
          actionLabel = 'Gioca';
          onAction = () => { Renderer.closeCardDetail(); showPlayOptions(instanceId, def); };
        }
      }
    } else if (source === 'field' && isMyTurn) {
      actionLabel = 'Riposiziona';
      onAction = () => {
        Renderer.closeCardDetail();
        Renderer.showChoiceModal(
          'Riposiziona Guerriero',
          [
            { label: 'Avanscoperta',      value: 'vanguard' },
            { label: 'Bastione Sinistro', value: 'bastion_left' },
            { label: 'Bastione Destro',   value: 'bastion_right' },
          ],
          (dest) => sendAction('reposition', { warrior_instance_id: instanceId, destination: dest }),
        );
      };
    } else if (source === 'village' && isMyTurn) {
      // Arena: bottone Attiva (non consuma Azione, appare sempre se disponibile)
      if (def && def.id === 'arena') {
        const canActivate = _canActivateArena(instanceId);
        extraButtons.push({
          label: '⚔ Attiva Arena',
          className: 'btn-warning',
          disabled: !canActivate,
          onClick: () => { Renderer.closeCardDetail(); _showArenaFlow(instanceId); },
        });
      }
      // Completa costruzione
      if (fieldBuilding && !fieldBuilding.completed) {
        actionLabel = 'Completa costruzione';
        onAction = () => {
          Renderer.closeCardDetail();
          sendAction('complete_building', { building_instance_id: instanceId });
        };
      }
    }

    // Bottone Scarta: disponibile per le proprie carte (mano, campo, villaggio) in qualsiasi momento
    let onDiscard = null;
    if (source === 'hand' || source === 'field' || source === 'village') {
      const discardSource = source === 'field' ? 'field' : (source === 'village' ? 'village' : 'hand');
      onDiscard = () => {
        Renderer.closeCardDetail();
        sendAction('discard', { instance_id: instanceId, source: discardSource });
      };
    }

    const title = def ? def.name : (fieldWarrior ? (fieldWarrior.name || instanceId) : instanceId);
    Renderer.showCardDetail(title, bodyHTML, actionLabel, onAction, onDiscard, extraButtons);
  }

  function showPlayOptions(instanceId, def) {
    if (def.type === 'warrior') {
      if (def.subtype === 'hero') {
        _showHeroPlayOptions(instanceId, def);
      } else {
        Renderer.showChoiceModal(
          `Gioca ${def.name}`,
          [
            { label: '⚔ Avanscoperta',      value: 'vanguard' },
            { label: '🛡 Bastione Sinistro', value: 'bastion_left' },
            { label: '🛡 Bastione Destro',   value: 'bastion_right' },
          ],
          (region) => sendAction('play_warrior', { instance_id: instanceId, region }),
        );
      }
    } else if (def.type === 'spell') {
      _showSpellOptions(instanceId, def);
    } else if (def.type === 'building') {
      Renderer.showModal(
        `Costruisci ${def.name}`,
        `Costo: <strong>${def.cost} Mana</strong><br>${def.base_effect || ''}`,
        () => sendAction('play_building', { instance_id: instanceId }),
      );
    }
  }

  function _showHeroPlayOptions(instanceId, def) {
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    const compatRecruits = [];
    myPlayer && ['vanguard', 'bastion_left', 'bastion_right'].forEach(reg => {
      const warriors = reg === 'vanguard'
        ? myPlayer.field.vanguard
        : (reg === 'bastion_left' ? myPlayer.field.bastion_left.warriors : myPlayer.field.bastion_right.warriors);
      (warriors || []).forEach(w => {
        const wDef = getCardDef(w.instance_id);
        if (wDef && wDef.evolves_into === def.id) {
          compatRecruits.push({ label: `Evolvi ${wDef.name} (${reg})`, value: w.instance_id });
        }
      });
    });

    Renderer.showChoiceModal(
      `Gioca ${def.name}`,
      [
        ...compatRecruits,
        { label: '⚔ Piazza in Avanscoperta',       value: 'vanguard' },
        { label: '🛡 Piazza in Bastione Sinistro',  value: 'bastion_left' },
        { label: '🛡 Piazza in Bastione Destro',    value: 'bastion_right' },
      ],
      (choice) => {
        if (['vanguard', 'bastion_left', 'bastion_right'].includes(choice)) {
          sendAction('play_warrior', { instance_id: instanceId, region: choice });
        } else {
          sendAction('evolve', { recruit_instance_id: choice, hero_instance_id: instanceId });
        }
      },
    );
  }

  function _showSpellOptions(instanceId, def) {
    const opponents = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);

    // Telecinesi: UI dedicata a 2 step (source bastion → dest bastion)
    if (def.id === 'telecinesi') {
      _showTelecinesiOptions(instanceId);
      return;
    }

    const spellsNeedingTarget = [
      'ardolancio', 'guerremoto', 'cuordipietra', 'incendifesa',
      'regicidio', 'malcomune', 'bastioncontrario',
      'dazipazzi', 'cambiamente',
    ];

    if (!spellsNeedingTarget.includes(def.id) || opponents.length === 0) {
      Renderer.showModal(
        `${def.name}`,
        `Costo: <strong>${def.cost} Maghe</strong><br>${def.base_effect || ''}`,
        () => sendAction('play_spell', { instance_id: instanceId }),
      );
      return;
    }

    const options = [];
    opponents.forEach(p => {
      options.push({ label: `🎯 ${p.name} — Bastione Sinistro`, value: `${p.id}:left` });
      options.push({ label: `🎯 ${p.name} — Bastione Destro`,   value: `${p.id}:right` });
    });

    Renderer.showChoiceModal(`${def.name} — scegli bersaglio`, options, (choice) => {
      const [targetId, side] = choice.split(':');
      sendAction('play_spell', {
        instance_id: instanceId,
        target_player_id: targetId,
        target_bastion_side: side,
      });
    });
  }

  function _showTelecinesiOptions(instanceId) {
    if (!currentState) return;
    const allPlayers = currentState.players.filter(p => p.lives > 0);

    // Construisce la lista di tutti i bastioni con i loro muri
    const bastionOptions = [];
    allPlayers.forEach(p => {
      const isMe = p.id === myPlayerId;
      const prefix = isMe ? 'Mio' : p.name;
      ['left', 'right'].forEach(side => {
        const bastionData = side === 'left' ? p.field.bastion_left : p.field.bastion_right;
        const walls = bastionData.wall_count != null ? bastionData.wall_count : 0;
        const label = `${prefix} — Bastione ${side === 'left' ? 'Sinistro' : 'Destro'} (${walls} muri)`;
        bastionOptions.push({ label, value: `${p.id}:${side}` });
      });
    });

    Renderer.showChoiceModal('Telecinesi — bastione di partenza', bastionOptions, (srcChoice) => {
      const [srcPlayerId, srcSide] = srcChoice.split(':');
      const destOptions = bastionOptions.filter(o => o.value !== srcChoice);
      Renderer.showChoiceModal('Telecinesi — bastione di arrivo', destOptions, (dstChoice) => {
        const [dstPlayerId, dstSide] = dstChoice.split(':');
        sendAction('play_spell', {
          instance_id: instanceId,
          source_player_id: srcPlayerId,
          source_side: srcSide,
          dest_player_id: dstPlayerId,
          dest_side: dstSide,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Fine Turno
  // ---------------------------------------------------------------------------

  async function onEndTurn() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    try {
      await sendAction('end_turn', {});
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Battaglia
  // ---------------------------------------------------------------------------

  function onBattleClick() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    if (currentState.battles_remaining <= 0) {
      Renderer.toast('Hai già attaccato questo turno', 'error');
      return;
    }

    const targets = [];
    // Evita duplicati: un bastione può apparire più volte nel DOM
    const seen = new Set();
    document.querySelectorAll('.attack-target').forEach(el => {
      const pid  = el.dataset.targetPlayerId;
      const side = el.dataset.targetSide;
      const key  = `${pid}:${side}`;
      if (pid && side && !seen.has(key)) {
        const p = currentState.players.find(pp => pp.id === pid);
        if (p && p.lives > 0) {
          seen.add(key);
          const idx = currentState.players.indexOf(p);
          targets.push({
            label: `${p.name} — Bastione ${side === 'left' ? 'Sinistro' : 'Destro'}`,
            value: `${idx}:${side}`,
          });
        }
      }
    });

    if (targets.length === 0) {
      Renderer.toast('Nessun bersaglio adiacente disponibile', 'error');
      return;
    }

    // Un solo bersaglio: attacca direttamente senza modale
    if (targets.length === 1) {
      const [idx, side] = targets[0].value.split(':');
      sendAction('battle', { defender_player_index: parseInt(idx), defender_bastion_side: side });
      return;
    }

    Renderer.showChoiceModal('Scegli il bersaglio', targets, (choice) => {
      const [idx, side] = choice.split(':');
      sendAction('battle', {
        defender_player_index: parseInt(idx),
        defender_bastion_side: side,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Invio azioni al server
  // ---------------------------------------------------------------------------

  async function sendAction(action, params = {}) {
    if (WS && gameId) {
      WS.sendAction(action, params);
      return;
    }
    try {
      const res = await api('/game/action', {
        game_id: gameId,
        session_token: sessionToken,
        action,
        params,
      });
      onStateUpdate(res.state, action, res.result);
    } catch (e) {
      Renderer.toast(e.message || 'Errore', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // API helper
  // ---------------------------------------------------------------------------

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Errore server');
    return data;
  }

  async function apiFetch(path) {
    const res = await fetch(path);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Errore server');
    return data;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  function returnToLobby() {
    WS.disconnect();
    stopLobbyPolling();
    stopLocalTimer();
    selectedCard = null;
    actionMode = null;
    wallsSelected = [];
    currentState = null;
    gameId = null;
    lobbyCode = null;
    sessionToken = null;
    myPlayerId = null;
    Renderer.showScreen('lobby');
  }

  function copyLobbyCode() {
    navigator.clipboard.writeText(
      document.getElementById('lobby-code-text').textContent
    ).then(() => Renderer.toast('Codice copiato!', 'success'));
  }

  return {
    init,
    getCardDef,
    onCardClick,
    sendAction,
  };
})();

function returnToLobby() { location.reload(); }
function copyLobbyCode() {
  navigator.clipboard.writeText(
    document.getElementById('lobby-code-text').textContent
  ).then(() => Renderer.toast('Codice copiato!', 'success'));
}

document.addEventListener('DOMContentLoaded', () => App.init());
