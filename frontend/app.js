/**
 * app.js — Logica principale del client Barbacane
 * Gestisce il flusso UI: lobby, attesa, gioco.
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
  let cardDefs = {};        // base_card_id → definizione carta
  let instanceMap = {};     // instance_id → base_card_id

  // Selezione interazione
  let selectedCard = null;  // { instanceId, source: 'hand'|'field'|'village' }
  let pendingAction = null; // { type, ... }

  // Timer countdown locale
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
      // Popola instanceMap (per ora solo le copie standard)
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

    // Normalizza il codice lobby mentre si digita
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
  // WebSocket (usato anche per la sala d'attesa)
  // ---------------------------------------------------------------------------

  function connectWS() {
    // Per la sala d'attesa usiamo polling leggero (WS si connette solo dopo game_id)
    // Il WS vero si connette quando la partita inizia
    // Per aggiornamenti lobby usiamo polling ogni 2s
    startLobbyPolling();
  }

  let lobbyPollTimer = null;

  function startLobbyPolling() {
    stopLobbyPolling();
    lobbyPollTimer = setInterval(async () => {
      try {
        const lobby = await apiFetch(`/lobby/${lobbyCode}`);
        updateWaitingPlayers(lobby.players);
        document.getElementById('btn-start').disabled = !lobby.can_start;

        // Se la partita è iniziata (il creatore ha premuto Start),
        // entra automaticamente nella schermata di gioco
        if (lobby.game_id && !gameId) {
          stopLobbyPolling();
          gameId = lobby.game_id;
          const gameState = await apiFetch(`/game/${lobby.game_id}?session_token=${sessionToken}`);
          enterGame(gameState);
        }
      } catch (_) {}
    }, 2000);
  }

  function stopLobbyPolling() {
    clearInterval(lobbyPollTimer);
    lobbyPollTimer = null;
  }

  function connectGameWS() {
    if (!gameId || !myPlayerId) return;
    WS.connect(gameId, myPlayerId);

    WS.on('state_update', (msg) => {
      if (msg.state) onStateUpdate(msg.state, msg.action, msg.result);
    });

    WS.on('game_started', (msg) => {
      if (msg.state) enterGame(msg.state);
    });

    WS.on('turn_warning', (msg) => {
      timerSecondsLeft = msg.seconds_left;
      Renderer.showTimerWarning(timerSecondsLeft);
      startLocalTimer(timerSecondsLeft);
    });

    WS.on('player_connected', (msg) => {
      Renderer.toast(`${msg.player_id} si è connesso`, 'success');
    });

    WS.on('player_disconnected', (msg) => {
      Renderer.toast(`${msg.player_id} si è disconnesso`, 'error');
    });

    WS.on('error', (msg) => {
      Renderer.toast(msg.message || 'Errore', 'error');
    });
  }

  function onStateUpdate(state, action, result) {
    currentState = state;
    Renderer.render(state, myPlayerId);

    if (result) {
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

      if (action === 'battle' && result) {
        const log = `⚔ ${result.attacker_id} → ${result.defender_id} [${result.defender_bastion}]: `
          + `${result.total_damage} Danni, ${result.walls_destroyed} Muri, ${result.life_lost} Vita`;
        Renderer.updateBattleLog(log);
      }
    }

    if (state.winner_id) {
      setTimeout(() => Renderer.showGameOver(state), 800);
    }

    // Reset selezione dopo ogni azione
    clearSelection();

    // Aggiorna timer
    if (state.current_player_id === myPlayerId) {
      Renderer.hideTimer();
      stopLocalTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Schermata di gioco
  // ---------------------------------------------------------------------------

  function enterGame(state) {
    stopLobbyPolling();
    gameId = gameId || state.game_id;
    currentState = state;
    connectGameWS();
    Renderer.showScreen('game');
    Renderer.render(state, myPlayerId);
  }

  // ---------------------------------------------------------------------------
  // Timer locale (countdown visuale)
  // ---------------------------------------------------------------------------

  function startLocalTimer(seconds) {
    stopLocalTimer();
    timerSecondsLeft = seconds;
    timerInterval = setInterval(() => {
      timerSecondsLeft--;
      if (timerSecondsLeft <= 0) {
        stopLocalTimer();
        Renderer.hideTimer();
      } else {
        Renderer.showTimerWarning(timerSecondsLeft);
      }
    }, 1000);
  }

  function stopLocalTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // ---------------------------------------------------------------------------
  // Interazione carte
  // ---------------------------------------------------------------------------

  function onCardClick(instanceId, source) {
    if (!currentState) return;
    const isMyTurn = currentState.current_player_id === myPlayerId;
    if (!isMyTurn) {
      Renderer.toast('Non è il tuo turno', 'error');
      return;
    }

    if (source === 'hand') {
      onHandCardClick(instanceId);
    } else if (source === 'field' || source === 'village') {
      onFieldCardClick(instanceId, source);
    }
  }

  function onHandCardClick(instanceId) {
    const def = getCardDef(instanceId);
    if (!def) return;

    // Se c'era già una selezione, deseleziona
    if (selectedCard && selectedCard.instanceId === instanceId) {
      clearSelection();
      return;
    }
    clearSelection();

    selectedCard = { instanceId, source: 'hand', def };

    // Aggiorna UI selezione
    const infoEl = document.getElementById('selection-info');
    infoEl.classList.remove('hidden');
    infoEl.innerHTML = `<strong>${def.name}</strong><br>${def.type === 'warrior' ? `⚔${def.att} 🏹${def.git} 🛡${def.dif}` : ''}`;

    document.getElementById('action-hint').textContent = getPlayHint(def);

    // Per le carte con destinazione chiara, mostra direttamente il modale
    showPlayOptions(instanceId, def);
  }

  function onFieldCardClick(instanceId, source) {
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    if (!myPlayer) return;

    // Controlla se è una costruzione da completare
    if (source === 'village') {
      const building = myPlayer.field.village.buildings.find(b => b.instance_id === instanceId);
      if (building && !building.completed) {
        const def = getCardDef(instanceId);
        Renderer.showModal(
          `Completa ${def ? def.name : instanceId}`,
          `Costo completamento: <strong>${def ? def.completion_cost : '?'} Mana</strong><br>${def ? def.complete_effect : ''}`,
          () => sendAction('complete_building', { building_instance_id: instanceId }),
        );
      }
      return;
    }

    // Guerriero in campo: permetti riposizionamento
    Renderer.showChoiceModal(
      'Riposiziona Guerriero',
      [
        { label: 'Avanscoperta', value: 'vanguard' },
        { label: 'Bastione Sinistro', value: 'bastion_left' },
        { label: 'Bastione Destro', value: 'bastion_right' },
      ],
      (dest) => sendAction('reposition', { warrior_instance_id: instanceId, destination: dest }),
    );
  }

  // Opzioni muro riutilizzabili
  const _wallOpts = [
    { label: '🧱 Muro Bastione Sinistro', value: 'wall_left' },
    { label: '🧱 Muro Bastione Destro',   value: 'wall_right' },
  ];

  function _handleWallOrAction(choice, instanceId, actionFn) {
    if (choice === 'wall_left' || choice === 'wall_right') {
      sendAction('add_wall', { instance_id: instanceId, bastion_side: choice === 'wall_left' ? 'left' : 'right' });
    } else {
      actionFn(choice);
    }
  }

  function showPlayOptions(instanceId, def) {
    if (def.type === 'warrior') {
      if (def.subtype === 'hero') {
        _showHeroPlayOptions(instanceId, def);
      } else {
        Renderer.showChoiceModal(
          `Gioca ${def.name}`,
          [
            { label: '⚔ Avanscoperta', value: 'vanguard' },
            { label: '🛡 Bastione Sinistro', value: 'bastion_left' },
            { label: '🛡 Bastione Destro', value: 'bastion_right' },
            ..._wallOpts,
          ],
          (choice) => _handleWallOrAction(choice, instanceId,
            (region) => sendAction('play_warrior', { instance_id: instanceId, region }),
          ),
        );
      }

    } else if (def.type === 'spell') {
      _showSpellOptions(instanceId, def);

    } else if (def.type === 'building') {
      Renderer.showChoiceModal(
        `Gioca ${def.name}`,
        [
          { label: `🏗 Costruisci in Villaggio (${def.cost} Mana)`, value: 'build' },
          ..._wallOpts,
        ],
        (choice) => _handleWallOrAction(choice, instanceId,
          () => sendAction('play_building', { instance_id: instanceId }),
        ),
      );
    }
  }

  function _showHeroPlayOptions(instanceId, def) {
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    const compatRecruits = [];
    myPlayer && myPlayer.field && ['vanguard', 'bastion_left', 'bastion_right'].forEach(reg => {
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

    const options = [
      ...compatRecruits,
      { label: '⚔ Piazza in Avanscoperta', value: 'vanguard' },
      { label: '🛡 Piazza in Bastione Sinistro', value: 'bastion_left' },
      { label: '🛡 Piazza in Bastione Destro', value: 'bastion_right' },
      ..._wallOpts,
    ];

    Renderer.showChoiceModal(`Gioca ${def.name}`, options, (choice) => {
      if (choice === 'wall_left' || choice === 'wall_right') {
        sendAction('add_wall', { instance_id: instanceId, bastion_side: choice === 'wall_left' ? 'left' : 'right' });
      } else if (['vanguard', 'bastion_left', 'bastion_right'].includes(choice)) {
        sendAction('play_warrior', { instance_id: instanceId, region: choice });
      } else {
        // È un instance_id di Recluta → Evolvi
        sendAction('evolve', { recruit_instance_id: choice, hero_instance_id: instanceId });
      }
    });
  }

  function _showSpellOptions(instanceId, def) {
    const opponents = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);

    const spellsNeedingTarget = [
      'ardolancio', 'guerremoto', 'cuordipietra', 'incendifesa',
      'regicidio', 'malcomune', 'telecinesi', 'bastioncontrario',
      'dazipazzi', 'cambiamente',
    ];

    if (!spellsNeedingTarget.includes(def.id) || opponents.length === 0) {
      // Magia senza target: offri lancio o muro
      Renderer.showChoiceModal(
        `${def.name}`,
        [
          { label: `✨ Lancia (${def.cost} Maghe) — ${def.base_effect}`, value: 'cast' },
          ..._wallOpts,
        ],
        (choice) => _handleWallOrAction(choice, instanceId,
          () => sendAction('play_spell', { instance_id: instanceId }),
        ),
      );
      return;
    }

    // Magia con target: mostra avversari + opzioni muro
    const options = [];
    opponents.forEach(p => {
      options.push({ label: `🎯 ${p.name} — Bastione Sinistro`, value: `${p.id}:left` });
      options.push({ label: `🎯 ${p.name} — Bastione Destro`,   value: `${p.id}:right` });
    });
    options.push(..._wallOpts);

    Renderer.showChoiceModal(`${def.name} — bersaglio o muro`, options, (choice) => {
      if (choice === 'wall_left' || choice === 'wall_right') {
        sendAction('add_wall', { instance_id: instanceId, bastion_side: choice === 'wall_left' ? 'left' : 'right' });
        return;
      }
      const [targetId, side] = choice.split(':');
      sendAction('play_spell', {
        instance_id: instanceId,
        target_player_id: targetId,
        target_bastion_side: side,
      });
    });
  }

  function clearSelection() {
    selectedCard = null;
    pendingAction = null;
    document.getElementById('selection-info').classList.add('hidden');
  }

  function getPlayHint(def) {
    if (def.type === 'warrior') return `Scegli dove posizionare ${def.name}.`;
    if (def.type === 'spell')   return `Scegli il bersaglio per ${def.name}.`;
    if (def.type === 'building') return `Premi per costruire ${def.name}.`;
    return '';
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

    // Raccogli i target validi dagli elementi DOM
    const targets = [];
    document.querySelectorAll('.attack-target').forEach(el => {
      const pid = el.dataset.targetPlayerId;
      const side = el.dataset.targetSide;
      if (pid && side) {
        const p = currentState.players.find(pp => pp.id === pid);
        if (p && p.lives > 0) {
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
    // Prima prova via WS se disponibile
    if (WS && gameId) {
      WS.sendAction(action, params);
      return;
    }
    // Fallback REST
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
  // Utilità globali
  // ---------------------------------------------------------------------------

  function returnToLobby() {
    WS.disconnect();
    stopLobbyPolling();
    stopLocalTimer();
    selectedCard = null;
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

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  return {
    init,
    getCardDef,
    onCardClick,
    sendAction,
  };
})();

// Funzioni globali per onclick inline in HTML
function returnToLobby() { App.returnToLobby && App.returnToLobby(); location.reload(); }
function copyLobbyCode() {
  navigator.clipboard.writeText(
    document.getElementById('lobby-code-text').textContent
  ).then(() => Renderer.toast('Codice copiato!', 'success'));
}

// Avvio
document.addEventListener('DOMContentLoaded', () => App.init());
