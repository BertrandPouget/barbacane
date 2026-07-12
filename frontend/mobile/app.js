/**
 * app.js — Logica del client mobile di Barbacane (modulo Mob).
 * Parla lo stesso protocollo del client desktop (server/routes.py),
 * ma con interazioni ripensate per il touch: bottom sheet, dock contestuale,
 * campo a 4 tasselli (le mie Regioni) da toccare per rivelare.
 */

'use strict';

const Mob = (() => {

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

  // Modalità muri
  let wallMode = false;
  let wallsSelected = [];   // [{instanceId, bastion: 'left'|'right'}]

  // Timer
  let timerInterval = null;
  let timerSecondsLeft = 0;

  let lobbyPollTimer = null;
  let _lastTurnPlayer = null;

  // True mentre stiamo abbandonando la partita: ignora gli update in arrivo
  let leavingGame = false;

  const SESSION_KEY = 'barb_m_session';

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    await loadCardDefs();
    bindLobbyUI();
    bindGameChrome();
    const resumed = await tryResume();
    if (!resumed) Screens.show('lobby');
  }

  async function loadCardDefs() {
    try {
      const res = await fetch('/data/cards.json');
      const data = await res.json();
      [...data.warriors, ...data.spells, ...data.buildings].forEach(c => { cardDefs[c.id] = c; });
      Object.values(cardDefs).forEach(c => {
        for (let i = 1; i <= c.copies; i++) instanceMap[`${c.id}_${i}`] = c.id;
      });
    } catch (e) {
      console.error('Impossibile caricare cards.json', e);
    }
  }

  function getCardDef(instanceId) {
    if (!instanceId) return null;
    const baseId = instanceMap[instanceId] || String(instanceId).replace(/_\d+$/, '');
    return cardDefs[baseId] || null;
  }

  function cardName(baseId) {
    return (cardDefs[baseId] && cardDefs[baseId].name) || baseId;
  }

  // ---------------------------------------------------------------------------
  // Sessione persistente (i browser mobile chiudono le tab spesso)
  // ---------------------------------------------------------------------------

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        token: sessionToken, playerId: myPlayerId, lobbyCode, gameId,
      }));
    } catch (_) {}
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  async function tryResume() {
    // ?resume=GAMEID.TOKEN (utile anche per riaprire una partita da link)
    const qs = new URLSearchParams(location.search);
    let stored = null;
    if (qs.has('resume')) {
      const raw = qs.get('resume');
      const dot = raw.indexOf('.');
      if (dot > 0) stored = { gameId: raw.slice(0, dot), token: raw.slice(dot + 1), playerId: null };
    }
    if (!stored) {
      try { stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) {}
    }
    if (!stored || !stored.token || !stored.gameId) return false;

    try {
      const state = await apiFetch(`/game/${stored.gameId}?session_token=${encodeURIComponent(stored.token)}`);
      if (!state || state.winner_id) { clearSession(); return false; }
      // Il giocatore "visibile" (mano non oscurata) è il proprietario del token
      const mine = state.players.find(p => p.hand !== null && p.hand !== undefined);
      if (!mine) { clearSession(); return false; }
      sessionToken = stored.token;
      myPlayerId = stored.playerId || mine.id;
      gameId = stored.gameId;
      lobbyCode = stored.lobbyCode || null;
      saveSession();
      enterGame(state);
      return true;
    } catch (_) {
      clearSession();
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  function bindLobbyUI() {
    // Tabs
    const tabs = document.querySelector('.seg-tabs');
    $('tab-create').addEventListener('click', () => {
      tabs.classList.remove('join');
      $('tab-create').classList.add('on'); $('tab-join').classList.remove('on');
      $('pane-create').hidden = false; $('pane-join').hidden = true;
    });
    $('tab-join').addEventListener('click', () => {
      tabs.classList.add('join');
      $('tab-join').classList.add('on'); $('tab-create').classList.remove('on');
      $('pane-join').hidden = false; $('pane-create').hidden = true;
    });

    $('btn-create').addEventListener('click', onCreateLobby);
    $('btn-join').addEventListener('click', onJoinLobby);
    $('btn-start').addEventListener('click', onStartGame);
    $('in-join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
    $('wait-code').addEventListener('click', copyLobbyCode);
  }

  async function onCreateLobby() {
    const name = $('in-create-name').value.trim();
    const timer = parseInt($('in-create-timer').value) || 0;
    if (!name) { Toast.show('Inserisci il tuo nome', 'error'); return; }
    try {
      const res = await api('/lobby/create', { player_name: name, turn_timer: timer });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      lobbyCode = res.lobby_code;
      isCreator = true;
      saveSession();
      showWaitingRoom(res.lobby);
    } catch (e) {
      Toast.show(e.message, 'error');
    }
  }

  async function onJoinLobby() {
    const name = $('in-join-name').value.trim();
    const code = $('in-join-code').value.trim().toUpperCase();
    if (!name) { Toast.show('Inserisci il tuo nome', 'error'); return; }
    if (!code) { Toast.show('Inserisci il codice lobby', 'error'); return; }
    try {
      const res = await api('/lobby/join', { lobby_code: code, player_name: name });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      lobbyCode = res.lobby_code;
      isCreator = false;
      saveSession();
      showWaitingRoom(res.lobby);
    } catch (e) {
      Toast.show(e.message, 'error');
    }
  }

  function showWaitingRoom(lobby) {
    lobbyCode = lobby.lobby_code;
    $('wait-code-text').textContent = lobby.lobby_code;
    updateWaitingPlayers(lobby.players);
    $('btn-start').hidden = !isCreator;
    $('wait-status').textContent = '';
    Screens.show('wait');
    startLobbyPolling();
  }

  function updateWaitingPlayers(players) {
    const list = $('wait-players');
    list.innerHTML = '';
    (players || []).forEach(p => {
      list.appendChild(el('div', { className: 'wait-player' }, [
        el('span', { className: 'dot' }),
        el('span', {}, [p.name]),
      ]));
    });
  }

  function startLobbyPolling() {
    stopLobbyPolling();
    lobbyPollTimer = setInterval(async () => {
      try {
        const lobby = await apiFetch(`/lobby/${lobbyCode}`);
        updateWaitingPlayers(lobby.players);
        $('btn-start').disabled = !lobby.can_start;
        if (lobby.game_id && !gameId) {
          stopLobbyPolling();
          gameId = lobby.game_id;
          saveSession();
          const gameState = await apiFetch(`/game/${lobby.game_id}?session_token=${sessionToken}`);
          enterGame(gameState);
        }
      } catch (_) {}
    }, 2000);
  }

  function stopLobbyPolling() { clearInterval(lobbyPollTimer); lobbyPollTimer = null; }

  async function onStartGame() {
    try {
      $('wait-status').textContent = 'Avvio partita…';
      const res = await api('/lobby/start', { lobby_code: lobbyCode, session_token: sessionToken });
      gameId = res.game_id;
      saveSession();
      enterGame(res.state);
    } catch (e) {
      $('wait-status').textContent = e.message;
      Toast.show(e.message, 'error');
    }
  }

  function copyLobbyCode() {
    const text = $('wait-code-text').textContent.trim();
    const done = () => Toast.show('Codice copiato!', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => Toast.show(`Codice: ${text}`));
    } else {
      Toast.show(`Codice: ${text}`);
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

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
      Render.timerHide();
      if (msg.seconds && msg.seconds > 0) {
        Render.timerStart(msg.seconds);
        startLocalTimer(msg.seconds);
      }
    });
    WS.on('turn_warning', (msg) => {
      startLocalTimer(msg.seconds_left);
    });
    WS.on('player_connected', (msg) => {
      Render.logPush(`${playerName(msg.player_id)} si è connesso`);
    });
    WS.on('player_disconnected', (msg) => {
      Render.logPush(`${playerName(msg.player_id)} si è disconnesso`);
    });
    WS.on('disconnected', () => {
      Render.logPush('Connessione persa, riconnessione…');
    });
    WS.on('error', (msg) => {
      Toast.show(msg.message || 'Errore', 'error');
      if (msg.message && msg.message.includes('Biblioteca') && currentState) {
        const myPending = (currentState.pending_interactions || []).find(i => i.player_id === myPlayerId);
        if (myPending) showBibliotecaSheet(myPending);
      }
    });
  }

  function playerName(pid) {
    if (!currentState) return pid;
    const p = currentState.players.find(p => p.id === pid);
    return p ? p.name : pid;
  }

  // ---------------------------------------------------------------------------
  // Ciclo di stato
  // ---------------------------------------------------------------------------

  function enterGame(state) {
    stopLobbyPolling();
    gameId = gameId || state.game_id;
    currentState = state;
    saveSession();
    connectGameWS();
    Screens.show('game');
    _lastTurnPlayer = state.current_player_id;
    Render.game(state, myPlayerId);
    refreshDock();
    _openPendingSheets(state);
    if (state.winner_id) showGameOver(state);
  }

  function confirmLeaveGame() {
    Sheet.confirm(
      'Abbandonare la partita?',
      'Verrai eliminato dalla partita e non potrai rientrare.',
      async () => {
        leavingGame = true;
        try {
          await api('/game/action', {
            game_id: gameId, session_token: sessionToken,
            action: 'leave_game', params: {},
          });
        } catch (_) {
          // partita già finita o non più raggiungibile: esci comunque
        }
        clearSession();
        location.href = '/m';
      },
      { yesLabel: 'Abbandona', danger: true },
    );
  }

  function onStateUpdate(state, action, result) {
    if (leavingGame) return;
    const prevTurnPlayer = _lastTurnPlayer;
    currentState = state;
    _lastTurnPlayer = state.current_player_id;

    exitWallMode(true);
    Render.game(state, myPlayerId);

    // Banner al cambio turno
    if (prevTurnPlayer !== state.current_player_id && !state.winner_id) {
      if (state.current_player_id === myPlayerId) {
        TurnBanner.show('È il tuo turno!');
        haptic(40);
      } else {
        TurnBanner.show(`Turno di ${playerName(state.current_player_id)}`, true);
      }
    }

    // Esiti dell'azione
    if (result) {
      if (result.life_lost > 0 && result.defender_id) {
        Render.flashOpponent(result.defender_id);
        if (result.defender_id === myPlayerId) {
          Toast.show('💔 Hai perso una Vita!', 'error');
          haptic(80);
        }
      }

      if (action === 'battle') {
        const attName = playerName(result.attacker_id);
        const defName = playerName(result.defender_id);
        const side = result.defender_bastion === 'left' ? 'Sinistro' : 'Destro';
        Render.logPush(`⚔️ ${attName} → ${defName} [Bastione ${side}]: ` +
          `${result.total_damage} Danni, ${result.walls_destroyed} Muri, ${result.life_lost} Vita`);
      }

      // Eracle: distruggi una costruzione avversaria
      if (action === 'battle' && result.eracle_destroy_triggered &&
          result.eracle_targets && result.eracle_targets.length > 0 &&
          state.current_player_id === myPlayerId) {
        Sheet.choice(
          '⚡ Eracle',
          result.eracle_targets.map(b => ({
            icon: '🏗️',
            label: cardName(b.base_card_id || (getCardDef(b.instance_id) || {}).id) || b.instance_id,
            value: b.instance_id,
          })),
          (buildingIId) => sendAction('eracle_destroy', {
            building_instance_id: buildingIId,
            target_player_id: result.defender_id,
          }),
          { subtitle: 'Distruggi una Costruzione avversaria', locked: true, cancelLabel: null },
        );
        _logRecentEvents(state);
        refreshDock();
        return;
      }
    }

    _logRecentEvents(state);

    if (state.winner_id) {
      setTimeout(() => showGameOver(state), 900);
      return;
    }

    // Sheet pendenti (ricerca, biblioteca, ecc.) o chiusura di quelli superati
    const hadPending = _openPendingSheets(state);
    if (!hadPending && Sheet.isOpen() && prevTurnPlayer !== state.current_player_id) {
      // il turno è cambiato: qualsiasi sheet contestuale è ormai superato
      Sheet.close(true);
    }

    refreshDock();
  }

  function _openPendingSheets(state) {
    const me = state.players.find(p => p.id === myPlayerId);
    const myPending = (state.pending_interactions || []).find(i => i.player_id === myPlayerId);

    if (state.pending_search && state.pending_search.player_id === myPlayerId && state.search_deck) {
      showSearchSheet(state.search_deck, state.pending_search);
      return true;
    }
    if (myPending) {
      if (myPending.type === 'cardo_move') showCardoSheet();
      else if (myPending.type === 'agilpesca_discard') showAgilpescaSheet();
      else if (myPending.type === 'magiscudo_counter') showMagiscudoSheet(myPending);
      else if (myPending.type === 'malcomune_discard') showMalcomuneSheet(myPending);
      else showBibliotecaSheet(myPending);
      return true;
    }
    if (me && me.pending_velocemento_buildings && me.pending_velocemento_buildings.length > 0) {
      showVelocementoSheet(me.pending_velocemento_buildings);
      return true;
    }
    return false;
  }

  // Descrizione eventi (parità col client desktop)
  function _logRecentEvents(state) {
    if (!state.recent_events || state.recent_events.length === 0) return;
    state.recent_events.forEach(ev => {
      const msg = _describeEvent(ev, state);
      if (msg) Render.logPush(msg);
    });
  }

  function _describeEvent(ev, state) {
    const pName = playerName(ev.player_id);
    const cardLabel = ev.card ? capitalize(ev.card) : '';

    if (ev.type === 'd10') {
      if (ev.card === 'estrattore') return `${pName} — Estrattore: D10=${ev.roll} — ${ev.triggered ? `+${ev.mana_gained} Mana` : 'nessun mana'}`;
      if (ev.card === 'granaio') return `${pName} — Granaio: D10=${ev.roll} — ${ev.triggered ? 'carta pescata' : 'nessuna carta'}`;
      if (ev.card === 'obelisco') return `${pName} — Obelisco: D10=${ev.roll} (soglia ${ev.threshold}) — ${ev.returned ? 'Magia in mano' : 'Magia scartata'}`;
      if (ev.card === 'fucina') return `${pName} — Fucina: D10=${ev.roll} — ${ev.extra_action ? 'azione extra' : 'nessuna azione extra'}`;
      return `${pName} — ${cardLabel}: D10=${ev.roll}`;
    }
    if (ev.type === 'mana') return `${pName} — ${cardLabel}: +${ev.mana_gained} Mana`;
    if (ev.type === 'damage') {
      const defName = playerName(ev.target_player_id);
      const side = ev.target_bastion_side === 'left' ? 'Sin.' : 'Des.';
      return `${pName} — ${cardLabel}: ${ev.damage} Danni a ${defName} [${side}]`;
    }
    if (ev.type === 'draw') {
      const n = ev.cards_drawn ? ev.cards_drawn.length : 0;
      return `${pName} — ${cardLabel}: ${n} carta${n !== 1 ? ' pescate' : ' pescata'}`;
    }
    if (ev.type === 'life_gained') return `${pName} — ${cardLabel}: +${ev.lives_gained || 0} Vita`;
    if (ev.type === 'warrior_discarded') return `${pName} — ${cardLabel}: guerriero scartato`;
    if (ev.type === 'warrior_moved') return `${pName} — ${cardLabel}: guerriero spostato`;
    if (ev.type === 'wall_moved') {
      const n = ev.moved_walls ? ev.moved_walls.length : 0;
      return `${pName} — ${cardLabel}: ${n} ${n !== 1 ? 'Muri spostati' : 'Muro spostato'}`;
    }
    if (ev.type === 'wall_taken') return `${pName} — ${cardLabel}: Muro in mano`;
    if (ev.type === 'search') return `${pName} — ${cardLabel}: ricerca nel mazzo`;
    if (ev.type === 'ethereal') return `${pName} — ${cardLabel}: carta eterea`;
    if (ev.type === 'discard') return `${pName} — ${cardLabel}: scartato`;
    if (ev.type === 'horde') {
      const H = {
        patrizio: 'Orda Patrizio: +2 GIT',
        orfeo: 'Orda Orfeo: +1 ATT +1 DIF',
        polemarco: `Orda Polemarco: +${ev.att_bonus} ATT`,
        reinhold: 'Orda Reinhold: sconto Sorgive -2',
        araminta: 'Orda Araminta: Anatemi tornano in mano',
        evelyn: 'Orda Evelyn: Sortilegi raddoppiati',
        faust: 'Orda Faust: Biblioteche avversarie bloccate',
        giulio: 'Orda Giulio: ricerca nel mazzo',
        madeleine: 'Orda Madeleine: Prodigi liberi da Scuola',
        decimo: 'Orda Decimo: anti-Fossato',
        joseph: `Orda Joseph: ${ev.has_trono ? 'Troni avversari scartati' : 'nessun Trono assegnato'}`,
        eracle: 'Orda Eracle: distruggi Costruzione se ≥3 Danni',
      };
      return `${pName} — ${H[ev.card] || `Orda ${cardLabel}`}`;
    }
    if (ev.type === 'abandon') return `${pName} ha abbandonato la partita`;
    if (ev.type === 'magiscudo_blocked') {
      const blockedName = playerName(ev.blocked_player);
      return `${pName} — ${cardLabel || 'Magia'} annullata: ${blockedName} è protetto da Magiscudo`;
    }
    if (ev.type === 'effect') {
      const E = {
        magiscudo: 'Magiscudo: immune alle Magie',
        guerremoto: `Guerremoto: attacco a qualsiasi Bastione${ev.damage_bonus ? ` +${ev.damage_bonus} Danni` : ''}`,
        divinazione: 'Divinazione: Mana extra al prossimo turno',
        dazipazzi: `Dazipazzi: ${ev.reset_buildings ? ev.reset_buildings.length : 0} costruzioni ripristinate`,
        fucina: `Fucina: ${ev.extra_action ? 'azione extra' : 'azione extra (D10)'}`,
        cardo: 'Cardo: spostamento guerriero attivato',
        decumano: 'Decumano: completamento Cardo gratuito',
        trono: 'Trono: assegnato a guerriero',
        biblioteca: 'Biblioteca: carta pescata',
        equipotenza: 'Equipotenza: statistiche equiparate',
        bastioncontrario: 'Bastioncontrario: Bastioni scambiati',
      };
      return `${pName} — ${E[ev.card] || cardLabel}`;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Timer locale
  // ---------------------------------------------------------------------------

  function startLocalTimer(seconds) {
    stopLocalTimer();
    timerSecondsLeft = seconds;
    Render.timer(timerSecondsLeft);
    timerInterval = setInterval(() => {
      timerSecondsLeft--;
      if (timerSecondsLeft <= 0) {
        stopLocalTimer();
        Render.timerHide();
      } else {
        Render.timer(timerSecondsLeft);
        if (timerSecondsLeft === 15 && currentState && currentState.current_player_id === myPlayerId) {
          Toast.show('⏱️ 15 secondi!', 'error');
          haptic(60);
        }
      }
    }, 1000);
  }

  function stopLocalTimer() { clearInterval(timerInterval); timerInterval = null; }

  // ---------------------------------------------------------------------------
  // Dock contestuale
  // ---------------------------------------------------------------------------

  function bindGameChrome() {
    $('fld-vanguard').addEventListener('click', () => { haptic(); openVanguardSheet(); });
    $('tw-left').addEventListener('click', () => { haptic(); openBastionSheet('left'); });
    $('tw-right').addEventListener('click', () => { haptic(); openBastionSheet('right'); });
    $('tw-village').addEventListener('click', () => { haptic(); openVillageSheet(); });
    $('st-lives').addEventListener('click', () => { haptic(); openLivesSheet(); });
    $('st-fx').addEventListener('click', () => { haptic(); openActiveFxSheet(); });
    $('tb-log').addEventListener('click', () => { haptic(); openLogSheet(); });
    $('tb-leave').addEventListener('click', () => { haptic(); confirmLeaveGame(); });
    $('ticker').addEventListener('click', () => { haptic(); openLogSheet(); });

    $('tray-cancel').addEventListener('click', () => exitWallMode());
    $('tray-confirm').addEventListener('click', confirmWalls);
  }

  function me() {
    return currentState ? currentState.players.find(p => p.id === myPlayerId) : null;
  }

  function isMyTurn() {
    return currentState && currentState.current_player_id === myPlayerId;
  }

  function refreshDock() {
    const dock = $('dock');
    dock.innerHTML = '';
    if (!currentState) return;
    const my = me();
    Render.phaseDimmed(!isMyTurn());

    const mkBtn = (label, cls, onClick, disabled = false) => {
      const b = el('button', { className: `mbtn ${cls || ''}` }, [label]);
      b.disabled = disabled;
      b.addEventListener('click', () => { haptic(); onClick(); });
      return b;
    };
    const hint = (text) => el('div', { className: 'dock-hint' }, [text]);

    // Interazioni pendenti che mi riguardano → un solo bottone che riapre lo sheet
    const myPending = (currentState.pending_interactions || []).find(i => i.player_id === myPlayerId);
    const searchMine = currentState.pending_search && currentState.pending_search.player_id === myPlayerId;
    const veloMine = my && my.pending_velocemento_buildings && my.pending_velocemento_buildings.length > 0;
    if (myPending || searchMine || veloMine) {
      dock.appendChild(hint('Devi rispondere prima di continuare.'));
      dock.appendChild(mkBtn('❗ Rispondi', 'mbtn-gold mbtn-pulse', () => _openPendingSheets(currentState)));
      return;
    }

    if (!isMyTurn()) {
      const w = el('div', { className: 'dock-wait' }, [
        `Turno di ${playerName(currentState.current_player_id)}`,
        el('span', { className: 'dots' }),
      ]);
      dock.appendChild(w);
      return;
    }

    // Attese generate da avversari mentre è il mio turno
    const blocking = (currentState.pending_interactions || [])
      .find(i => i.type === 'magiscudo_counter' || i.type === 'malcomune_discard');
    if (blocking) {
      const who = playerName(blocking.player_id);
      const what = blocking.type === 'magiscudo_counter' ? 'Magiscudo' : 'Malcomune';
      dock.appendChild(el('div', { className: 'dock-wait' }, [
        `In attesa di ${who} (${what})`, el('span', { className: 'dots' }),
      ]));
      return;
    }

    const phase = currentState.phase;

    if (wallMode) {
      dock.appendChild(hint('Tocca le carte in mano da usare come Muri.'));
      return;
    }

    if (phase === 'action') {
      const acts = my ? (my.actions_remaining ?? 0) : 0;
      const hasCards = my && my.hand && my.hand.length > 0;
      const hasIncomplete = my && (my.field.village.buildings || []).some(b => !b.completed);
      const hasEthereal = my && my.ethereal_card;

      if (acts > 0) {
        dock.appendChild(hint(hasCards ? 'Tocca una carta per giocarla' : 'Nessuna carta in mano'));
        dock.appendChild(mkBtn('🏗️', '', openCompleteSheet, !hasIncomplete));
        dock.appendChild(mkBtn('🧱', '', enterWallMode, !hasCards));
        dock.appendChild(mkBtn('›', '', () => sendAction('next_phase', {})));
      } else {
        dock.appendChild(hint(hasEthereal ? 'Gioca la carta eterea o avanza' : 'Azioni esaurite'));
        dock.appendChild(mkBtn('Schieramento ›', 'mbtn-gold mbtn-pulse', () => sendAction('next_phase', {})));
      }

    } else if (phase === 'schieramento') {
      const hordes = my && my.available_hordes
        ? my.available_hordes.filter(h => !h.already_activated) : [];
      dock.appendChild(hint('Tocca una Regione per riposizionare i Guerrieri.'));
      if (hordes.length > 0) {
        dock.appendChild(mkBtn(`⚡ Orda (${hordes.length})`, 'mbtn-warn mbtn-pulse', openHordeSheet));
      }
      dock.appendChild(mkBtn('Battaglia ›', '', () => sendAction('next_phase', {})));

    } else if (phase === 'battaglia') {
      const canAttack = currentState.battles_remaining > 0 &&
        my && my.field.vanguard && my.field.vanguard.length > 0;
      dock.appendChild(hint(canAttack ? 'Attacca o termina il turno.' : 'Nessun attacco possibile.'));
      dock.appendChild(mkBtn('⚔️ Attacca', canAttack ? 'mbtn-gold' : '', openBattleSheet, !canAttack));
      dock.appendChild(mkBtn('Fine turno', 'mbtn-danger', confirmEndTurn));
    }
  }

  function confirmEndTurn() {
    Sheet.confirm('Terminare il turno?', 'Pescherai fino a riempire la mano e il turno passerà al prossimo giocatore.', () => {
      sendAction('end_turn', {});
    }, { yesLabel: 'Fine turno', danger: true });
  }

  // ---------------------------------------------------------------------------
  // Mano → dettaglio carta → gioco
  // ---------------------------------------------------------------------------

  function onHandTap(iid) {
    if (wallMode) { toggleWallCard(iid); return; }
    openHandCardSheet(iid);
  }

  function openHandCardSheet(iid) {
    const def = getCardDef(iid);
    const my = me();
    const hand = (my && my.hand) || [];
    const idx = hand.indexOf(iid);
    const isEthereal = my && my.ethereal_card === iid;
    const canAct = isMyTurn() && currentState.phase === 'action' &&
      my && (my.actions_remaining > 0 || isEthereal);

    const footer = [];
    footer.push({
      label: 'Scarta',
      className: 'mbtn-danger',
      onClick: () => confirmDiscard(iid, 'hand'),
    });
    footer.push({
      label: isEthereal ? '✧ Gioca gratis' : 'Gioca',
      className: 'mbtn-gold',
      disabled: !canAct,
      onClick: () => { Sheet.close(true); showPlayOptions(iid, def); },
    });

    let subtitle = '';
    if (!isMyTurn()) subtitle = 'Non è il tuo turno.';
    else if (currentState.phase !== 'action') subtitle = 'Le carte si giocano nella fase Azioni.';
    else if (!canAct) subtitle = 'Azioni esaurite per questo turno.';
    else if (isEthereal) subtitle = 'Carta eterea: gratis e senza consumare Azioni.';

    preloadCardImages([hand[idx - 1], hand[idx + 1]]);
    showCardNavSheet({
      title: def ? def.name : iid,
      subtitle,
      def,
      ctx: { instanceId: iid },
      pos: idx >= 0 ? { idx, total: hand.length } : null,
      onPrev: idx > 0 ? () => openHandCardSheet(hand[idx - 1]) : null,
      onNext: idx >= 0 && idx < hand.length - 1 ? () => openHandCardSheet(hand[idx + 1]) : null,
      footer,
    });
  }

  function confirmDiscard(iid, source) {
    const def = getCardDef(iid);
    Sheet.confirm(
      `Scartare ${def ? def.name : 'la carta'}?`,
      'La carta andrà nella pila degli scarti.',
      () => sendAction('discard', { instance_id: iid, source }),
      { yesLabel: 'Scarta', danger: true },
    );
  }

  function showPlayOptions(iid, def) {
    if (!def) return;
    if (def.type === 'warrior') {
      if (def.subtype === 'hero') showHeroPlayOptions(iid, def);
      else {
        Sheet.choice(`Gioca ${def.name}`, [
          { icon: '⚔️', label: 'Avanscoperta', sub: 'Prima linea: attacca e difende in battaglia', value: 'vanguard' },
          { icon: '🏰', label: 'Bastione Sinistro', value: 'bastion_left' },
          { icon: '🏰', label: 'Bastione Destro', value: 'bastion_right' },
        ], (region) => sendAction('play_warrior', { instance_id: iid, region }),
        { subtitle: 'Scegli dove schierarlo' });
      }
    } else if (def.type === 'spell') {
      showSpellOptions(iid, def);
    } else if (def.type === 'building') {
      Sheet.confirm(
        `Costruisci ${def.name}`,
        `Costo: <b>${def.cost} Mana</b><br>${def.base_effect || ''}`,
        () => sendAction('play_building', { instance_id: iid }),
        { yesLabel: '🏗️ Costruisci' },
      );
    }
  }

  function showHeroPlayOptions(iid, def) {
    const my = me();
    const regionLabels = { vanguard: 'Avanscoperta', bastion_left: 'Bastione Sin.', bastion_right: 'Bastione Des.' };
    const compat = [];
    ['vanguard', 'bastion_left', 'bastion_right'].forEach(reg => {
      const warriors = reg === 'vanguard'
        ? my.field.vanguard
        : (reg === 'bastion_left' ? my.field.bastion_left.warriors : my.field.bastion_right.warriors);
      (warriors || []).forEach(w => {
        const wDef = getCardDef(w.instance_id);
        if (wDef && wDef.evolves_into === def.id) {
          compat.push({
            icon: '⬆️',
            label: `Evolvi ${wDef.name}`,
            sub: regionLabels[reg],
            value: w.instance_id,
          });
        }
      });
    });

    if (compat.length === 0) {
      Toast.show(`Nessuna Recluta compatibile in campo per evolvere ${def.name}.`, 'error');
      return;
    }
    Sheet.choice(`Evolvi in ${def.name}`, compat,
      (recruitIId) => sendAction('evolve', { recruit_instance_id: recruitIId, hero_instance_id: iid }),
      { subtitle: 'La Recluta diventa Eroe e ne eredita le carte assegnate' });
  }

  // -- Magie ------------------------------------------------------------------

  function computeSpellProdigy(def) {
    const my = me();
    if (!my || !def) return false;
    const all = getAllWarriors(my);
    const sameSchool = all.filter(w => (getCardDef(w.instance_id) || {}).school === def.school).length;
    return sameSchool >= def.cost && def.cost > 0;
  }

  function getAllWarriors(player) {
    return [
      ...(player.field.vanguard || []),
      ...(player.field.bastion_left.warriors || []),
      ...(player.field.bastion_right.warriors || []),
    ];
  }

  function showSpellOptions(iid, def) {
    const opponents = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);
    const prodigy = computeSpellProdigy(def);

    if (def.id === 'telecinesi') { showTelecinesiOptions(iid, def, prodigy); return; }

    if (def.id === 'plasmattone' || def.id === 'plasmarmo') {
      const my = me();
      const bastionOptions = ['left', 'right']
        .filter(s => ((s === 'left' ? my.field.bastion_left : my.field.bastion_right).wall_count ?? 0) > 0)
        .map(s => ({
          icon: '🏰',
          label: `Bastione ${s === 'left' ? 'Sinistro' : 'Destro'}`,
          sub: `${(s === 'left' ? my.field.bastion_left : my.field.bastion_right).wall_count} muri`,
          value: s,
        }));
      if (bastionOptions.length === 0) { Toast.show('Nessun Muro nei tuoi Bastioni.', 'error'); return; }

      const needPicker = def.id === 'plasmarmo' || (def.id === 'plasmattone' && prodigy);
      Sheet.choice(`${def.name} — scegli un Bastione`, bastionOptions, (side) => {
        if (needPicker) {
          const walls = (side === 'left' ? my.field.bastion_left : my.field.bastion_right).walls || [];
          showSpellWallPicker(walls, side, iid, 0);
        } else {
          sendAction('play_spell', { instance_id: iid, bastion_side: side });
        }
      });
      return;
    }

    if (def.id === 'cambiamente') {
      const options = [];
      opponents.forEach(p => {
        const zones = [
          { warriors: p.field.vanguard, label: 'Avanscoperta' },
          { warriors: p.field.bastion_left.warriors, label: 'Bastione Sin.' },
          { warriors: p.field.bastion_right.warriors, label: 'Bastione Des.' },
        ];
        zones.forEach(({ warriors, label }) => {
          (warriors || []).forEach(w => {
            options.push({
              icon: '🗡️',
              label: w.name || w.base_card_id,
              sub: `${p.name} — ${label} · 🗡️${w.att} 🏹${w.git} 🛡️${w.dif}`,
              value: `${p.id}:${w.instance_id}`,
            });
          });
        });
      });
      if (options.length === 0) { Toast.show('Nessun Guerriero avversario disponibile.', 'error'); return; }
      Sheet.choice(`${def.name} — scegli un Guerriero`, options, (choice) => {
        const [targetPlayerId, targetWarriorIid] = choice.split(':');
        sendAction('play_spell', { instance_id: iid, target_player_id: targetPlayerId, target_warrior_iid: targetWarriorIid });
      });
      return;
    }

    if (def.id === 'bastioncontrario') { showBastioncontrarioOptions(iid, def, prodigy); return; }

    if (def.id === 'malcomune') {
      const my = me();
      const zones = [
        { warriors: my.field.vanguard, label: 'Avanscoperta' },
        { warriors: my.field.bastion_left.warriors, label: 'Bastione Sin.' },
        { warriors: my.field.bastion_right.warriors, label: 'Bastione Des.' },
      ];
      const options = [];
      zones.forEach(({ warriors, label }) => {
        (warriors || []).forEach(w => {
          options.push({ icon: '🗡️', label: w.name || w.base_card_id, sub: label, value: w.instance_id });
        });
      });
      if (options.length === 0) { Toast.show('Non hai nessun Guerriero in campo.', 'error'); return; }
      Sheet.choice(
        `${def.name} — scegli un tuo Guerriero`,
        options,
        (chosenIid) => sendAction('play_spell', { instance_id: iid, own_warrior_iid: chosenIid }),
        { subtitle: prodigy ? 'Prodigio: il tuo Guerriero resta in campo' : 'Il Guerriero scelto verrà scartato' },
      );
      return;
    }

    const spellsNeedingTarget = ['ardolancio', 'guerremoto', 'cuordipietra', 'incendifesa', 'regicidio'];
    if (!spellsNeedingTarget.includes(def.id) || opponents.length === 0) {
      const effText = prodigy && def.prodigy_effect
        ? (def.prodigy_is_additive ? `${def.base_effect}<br><b style="color:var(--gold)">✨ Prodigio:</b> ${def.prodigy_effect}` : `<b style="color:var(--gold)">✨ Prodigio:</b> ${def.prodigy_effect}`)
        : (def.base_effect || '');
      Sheet.confirm(`Lancia ${def.name}`, `Costo: <b>${def.cost} Maghe</b><br>${effText}`,
        () => sendAction('play_spell', { instance_id: iid }),
        { yesLabel: '✨ Lancia' });
      return;
    }

    const options = [];
    opponents.forEach(p => {
      options.push({
        icon: '🎯', label: `${p.name} — Bastione Sin.`,
        sub: `🧱 ${p.field.bastion_left.wall_count ?? 0} muri`, value: `${p.id}:left`,
      });
      options.push({
        icon: '🎯', label: `${p.name} — Bastione Des.`,
        sub: `🧱 ${p.field.bastion_right.wall_count ?? 0} muri`, value: `${p.id}:right`,
      });
    });
    Sheet.choice(`${def.name} — scegli bersaglio`, options, (choice) => {
      const [targetId, side] = choice.split(':');
      sendAction('play_spell', { instance_id: iid, target_player_id: targetId, target_bastion_side: side });
    });
  }

  function showBastioncontrarioOptions(iid, def, prodigy) {
    const alive = currentState.players.filter(p => p.lives > 0);
    if (!prodigy) {
      Sheet.choice(`${def.name} — scegli un giocatore`, alive.map(p => ({
        icon: '⇄',
        label: p.id === myPlayerId ? 'I miei Muri' : `I Muri di ${p.name}`,
        value: p.id,
      })), (playerId) => sendAction('play_spell', { instance_id: iid, player1_id: playerId }),
      { subtitle: 'I suoi due Bastioni si scambiano i Muri' });
      return;
    }
    const bastionOptions = [];
    alive.forEach(p => {
      ['left', 'right'].forEach(side => {
        bastionOptions.push({
          icon: '🏰',
          label: `${p.id === myPlayerId ? 'Mio' : p.name} — Bastione ${side === 'left' ? 'Sin.' : 'Des.'}`,
          value: `${p.id}:${side}`,
        });
      });
    });
    Sheet.choice(`${def.name} — primo Bastione`, bastionOptions, (c1) => {
      const [p1, s1] = c1.split(':');
      Sheet.choice(`${def.name} — secondo Bastione`, bastionOptions.filter(o => o.value !== c1), (c2) => {
        const [p2, s2] = c2.split(':');
        sendAction('play_spell', { instance_id: iid, player1_id: p1, side1: s1, player2_id: p2, side2: s2 });
      });
    });
  }

  function showTelecinesiOptions(iid, def, prodigy) {
    const my = me();
    const alive = currentState.players.filter(p => p.lives > 0);
    const wallCount = (p, side) => (side === 'left' ? p.field.bastion_left : p.field.bastion_right).wall_count ?? 0;

    function pickCount(maxWalls, onCount) {
      const max = Math.min(3, maxWalls);
      const opts = [];
      for (let i = 1; i <= max; i++) opts.push({ icon: '🧱', label: `${i} ${i > 1 ? 'Muri' : 'Muro'}`, value: String(i) });
      Sheet.choice('Telecinesi — quanti Muri?', opts, v => onCount(parseInt(v)));
    }

    if (!prodigy) {
      const srcOptions = ['left', 'right']
        .filter(s => wallCount(my, s) > 0)
        .map(s => ({
          icon: '🏰',
          label: `Bastione ${s === 'left' ? 'Sinistro' : 'Destro'}`,
          sub: `${wallCount(my, s)} muri`,
          value: s,
        }));
      if (srcOptions.length === 0) { Toast.show('Nessun Muro nei tuoi Bastioni.', 'error'); return; }
      Sheet.choice('Telecinesi — bastione di partenza', srcOptions, (srcSide) => {
        const destSide = srcSide === 'left' ? 'right' : 'left';
        pickCount(wallCount(my, srcSide), (count) => {
          sendAction('play_spell', { instance_id: iid, source_side: srcSide, dest_side: destSide, count });
        });
      });
      return;
    }

    function adjacentKeys(playerId, side) {
      const n = alive.length;
      const idx = alive.findIndex(p => p.id === playerId);
      const adj = [`${playerId}:${side === 'left' ? 'right' : 'left'}`];
      if (side === 'right') adj.push(`${alive[(idx + 1) % n].id}:left`);
      else adj.push(`${alive[(idx - 1 + n) % n].id}:right`);
      return adj;
    }
    const label = (p, side) =>
      `${p.id === myPlayerId ? 'Mio' : p.name} — Bastione ${side === 'left' ? 'Sin.' : 'Des.'}`;

    const srcOptions = [];
    alive.forEach(p => {
      ['left', 'right'].forEach(side => {
        if (wallCount(p, side) > 0) {
          srcOptions.push({ icon: '🏰', label: label(p, side), sub: `${wallCount(p, side)} muri`, value: `${p.id}:${side}` });
        }
      });
    });
    if (srcOptions.length === 0) { Toast.show('Nessun Muro disponibile.', 'error'); return; }

    Sheet.choice('Telecinesi — bastione di partenza', srcOptions, (srcChoice) => {
      const [srcPid, srcSide] = srcChoice.split(':');
      const dstOptions = adjacentKeys(srcPid, srcSide).map(key => {
        const [pid, side] = key.split(':');
        const p = alive.find(pp => pp.id === pid);
        return { icon: '🏰', label: label(p, side), sub: `${wallCount(p, side)} muri`, value: key };
      });
      Sheet.choice('Telecinesi — bastione di arrivo', dstOptions, (dstChoice) => {
        const [dstPid, dstSide] = dstChoice.split(':');
        const src = alive.find(p => p.id === srcPid);
        pickCount(wallCount(src, srcSide), (count) => {
          sendAction('play_spell', {
            instance_id: iid,
            source_player_id: srcPid, source_side: srcSide,
            dest_player_id: dstPid, dest_side: dstSide,
            count,
          });
        });
      });
    });
  }

  // Selettore muro per Plasmattone prodigio / Plasmarmo (slideshow)
  function showSpellWallPicker(walls, side, spellIid, idx) {
    if (!walls.length) return;
    const iid = walls[idx];
    const def = getCardDef(iid);
    preloadCardImages([walls[idx - 1], walls[idx + 1]]);
    showCardNavSheet({
      title: def ? def.name : iid,
      subtitle: `Muro ${idx + 1} di ${walls.length}`,
      def,
      pos: { idx, total: walls.length },
      onPrev: idx > 0 ? () => showSpellWallPicker(walls, side, spellIid, idx - 1) : null,
      onNext: idx < walls.length - 1 ? () => showSpellWallPicker(walls, side, spellIid, idx + 1) : null,
      footer: [{
        label: '✓ Scegli questo Muro',
        className: 'mbtn-gold',
        onClick: () => {
          Sheet.close(true);
          sendAction('play_spell', { instance_id: spellIid, bastion_side: side, wall_instance_id: iid });
        },
      }],
    });
  }

  // Precarica le immagini delle carte indicate (usato per le carte adiacenti
  // nella navigazione, così lo scorrimento non aspetta la rete)
  function preloadCardImages(iids) {
    (iids || []).forEach(iid => {
      if (!iid) return;
      const def = getCardDef(iid);
      if (def) Render.preloadCardImage(def.id);
    });
  }

  // Sheet carta con navigazione precedente/successiva
  function showCardNavSheet({ title, subtitle, def, ctx = {}, pos, onPrev, onNext, footer = [] }) {
    const body = [Render.cardViewNode(def, ctx)];
    if (onPrev || onNext) {
      const nav = el('div', { className: 'card-nav', style: 'justify-content:center' });
      // ︎ forza la resa testuale 2D (come ❤︎): i glifi ⮜⮞ non esistono nei font iOS
      const prevBtn = el('button', { className: 'nav-btn' }, ['◀︎']);
      prevBtn.disabled = !onPrev;
      prevBtn.addEventListener('click', () => { haptic(); onPrev && onPrev(); });
      const posEl = el('span', { className: 'nav-pos' }, [pos ? `${pos.idx + 1} / ${pos.total}` : '']);
      const nextBtn = el('button', { className: 'nav-btn' }, ['▶︎']);
      nextBtn.disabled = !onNext;
      nextBtn.addEventListener('click', () => { haptic(); onNext && onNext(); });
      nav.append(prevBtn, posEl, nextBtn);
      body.push(nav);
    }
    Sheet.open({ title, subtitle, body, footer: [...footer, { label: 'Chiudi', onClick: () => Sheet.close() }] });
  }

  // ---------------------------------------------------------------------------
  // Modalità muri
  // ---------------------------------------------------------------------------

  function enterWallMode() {
    if (!isMyTurn()) return;
    wallMode = true;
    wallsSelected = [];
    $('wall-tray').hidden = false;
    renderWallTray();
    refreshDock();
  }

  function exitWallMode(silent = false) {
    if (!wallMode && wallsSelected.length === 0) {
      $('wall-tray').hidden = true;
      return;
    }
    wallMode = false;
    wallsSelected = [];
    $('wall-tray').hidden = true;
    Render.markWallPicks(new Set());
    if (!silent) refreshDock();
  }

  function toggleWallCard(iid) {
    const idx = wallsSelected.findIndex(w => w.instanceId === iid);
    if (idx >= 0) wallsSelected.splice(idx, 1);
    else {
      if (wallsSelected.length >= 3) { Toast.show('Massimo 3 muri per azione', 'error'); return; }
      wallsSelected.push({ instanceId: iid, bastion: 'left' });
      haptic();
    }
    renderWallTray();
    Render.markWallPicks(new Set(wallsSelected.map(w => w.instanceId)));
  }

  function renderWallTray() {
    $('tray-count').textContent = wallsSelected.length;
    $('tray-confirm').disabled = wallsSelected.length === 0;
    const list = $('tray-list');
    list.innerHTML = '';
    wallsSelected.forEach(w => {
      const def = getCardDef(w.instanceId);
      const row = el('div', { className: 'tray-row' });
      row.appendChild(el('span', { className: 'tr-name' }, [def ? def.name : w.instanceId]));

      const sideToggle = el('span', { className: 'tray-side' });
      const btnL = el('button', { className: w.bastion === 'left' ? 'on' : '' }, ['Sin']);
      const btnR = el('button', { className: w.bastion === 'right' ? 'on' : '' }, ['Des']);
      btnL.addEventListener('click', () => { haptic(); w.bastion = 'left'; renderWallTray(); });
      btnR.addEventListener('click', () => { haptic(); w.bastion = 'right'; renderWallTray(); });
      sideToggle.append(btnL, btnR);
      row.appendChild(sideToggle);

      const x = el('button', { className: 'tray-x' }, ['✕']);
      x.addEventListener('click', () => toggleWallCard(w.instanceId));
      row.appendChild(x);
      list.appendChild(row);
    });
  }

  function confirmWalls() {
    if (wallsSelected.length === 0) return;
    const walls = wallsSelected.map(w => ({ instance_id: w.instanceId, bastion: w.bastion }));
    sendAction('add_wall', { walls });
    exitWallMode(true);
  }

  // ---------------------------------------------------------------------------
  // Completa costruzione
  // ---------------------------------------------------------------------------

  function reinholdDiscountFor(baseId) {
    const my = me();
    const fx = ((my && my.active_effects) || []).find(e => e.type === 'reinhold_sorgiva_discount');
    return (fx && baseId === 'sorgiva') ? fx.discount : 0;
  }

  function openCompleteSheet() {
    const my = me();
    const buildings = (my.field.village.buildings || []).filter(b => !b.completed);
    if (buildings.length === 0) return;
    Sheet.choice('Completa una Costruzione', buildings.map(b => {
      const def = getCardDef(b.instance_id);
      const baseCost = def ? def.completion_cost : null;
      const discount = reinholdDiscountFor(b.base_card_id);
      const eff = baseCost !== null ? Math.max(0, baseCost - discount) : '?';
      const isEth = my.ethereal_complete === b.instance_id;
      return {
        icon: '🏗️',
        label: def ? def.name : b.base_card_id,
        sub: isEth ? 'Gratis (Velocemento)' : `${discount > 0 ? `${baseCost}→` : ''}${eff} Mana`,
        value: b.instance_id,
        className: isEth ? 'gold' : '',
      };
    }), (instanceId) => sendAction('complete_building', { building_instance_id: instanceId }));
  }

  // ---------------------------------------------------------------------------
  // Sheet: bastioni miei
  // ---------------------------------------------------------------------------

  function openBastionSheet(side) {
    const my = me();
    if (!my) return;
    const bastion = side === 'left' ? my.field.bastion_left : my.field.bastion_right;
    const walls = bastion.walls || [];
    const warriors = bastion.warriors || [];
    const sideName = side === 'left' ? 'Sinistro' : 'Destro';

    const body = [];
    if (walls.length === 0 && warriors.length === 0) {
      body.push(el('div', { className: 'sheet-note' }, ['Bastione vuoto. Aggiungi Muri o schiera Guerrieri qui.']));
    }

    if (walls.length > 0) {
      body.push(el('div', { className: 'zone-label', style: 'padding:6px 4px' }, [`🧱 Muri (${walls.length})`]));
      walls.forEach((iid, i) => {
        const def = getCardDef(iid);
        const row = el('button', { className: 'opt-row' }, [
          el('span', { className: 'opt-icon' }, ['🧱']),
          el('span', { className: 'opt-main' }, [
            el('span', { className: 'opt-label' }, [def ? def.name : iid]),
            el('span', { className: 'opt-sub', style: 'display:block' },
              [def ? ({ warrior: 'Guerriero', spell: 'Magia', building: 'Costruzione' })[def.type] || '' : '']),
          ]),
          el('span', { className: 'opt-chevron' }, ['›']),
        ]);
        row.addEventListener('click', () => { haptic(); showMyWallSheet(walls, side, i); });
        body.push(row);
      });
    }

    if (warriors.length > 0) {
      body.push(el('div', { className: 'zone-label', style: 'padding:6px 4px' }, [`🗡️ Guerrieri (${warriors.length})`]));
      warriors.forEach(w => {
        const row = el('button', { className: `opt-row sp-${w.species || 'umano'}` }, [
          el('span', { className: 'opt-icon' }, ['🗡️']),
          el('span', { className: 'opt-main' }, [
            el('span', { className: 'opt-label' }, [w.name || w.base_card_id]),
            el('span', { className: 'opt-sub', style: 'display:block' },
              [`${capitalize(w.species || '')} · 🗡️${w.att} 🏹${w.git} 🛡️${w.dif}${w.horde_active ? ' · ⚡ Orda' : ''}`]),
          ]),
          el('span', { className: 'opt-chevron' }, ['›']),
        ]);
        row.addEventListener('click', () => { haptic(); openFieldWarriorSheet(w.instance_id); });
        body.push(row);
      });
    }

    Sheet.open({
      title: `🧱 Bastione ${sideName}`,
      subtitle: `${walls.length} Muri · ${warriors.length} Guerrieri`,
      body,
      footer: [{ label: 'Chiudi', onClick: () => Sheet.close() }],
    });
  }

  function showMyWallSheet(walls, side, idx) {
    const iid = walls[idx];
    const def = getCardDef(iid);
    const turnOk = isMyTurn();
    preloadCardImages([walls[idx - 1], walls[idx + 1]]);
    showCardNavSheet({
      title: `🧱 ${def ? def.name : iid}`,
      subtitle: 'Questa carta è un Muro: assorbe 1 Danno in Battaglia.',
      def,
      pos: { idx, total: walls.length },
      onPrev: idx > 0 ? () => showMyWallSheet(walls, side, idx - 1) : null,
      onNext: idx < walls.length - 1 ? () => showMyWallSheet(walls, side, idx + 1) : null,
      footer: [
        {
          label: 'Riprendi in mano',
          disabled: !turnOk,
          onClick: () => { Sheet.close(true); sendAction('retrieve_wall', { instance_id: iid, bastion_side: side }); },
        },
        {
          label: 'Scarta',
          className: 'mbtn-danger',
          disabled: !turnOk,
          onClick: () => { Sheet.close(true); sendAction('discard_wall', { instance_id: iid, bastion_side: side }); },
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: guerriero in campo (mio)
  // ---------------------------------------------------------------------------

  function findMyWarrior(iid) {
    const my = me();
    if (!my) return null;
    const zones = [
      { key: 'vanguard', label: 'Avanscoperta', list: my.field.vanguard || [] },
      { key: 'bastion_left', label: 'Bastione Sin.', list: my.field.bastion_left.warriors || [] },
      { key: 'bastion_right', label: 'Bastione Des.', list: my.field.bastion_right.warriors || [] },
    ];
    for (const z of zones) {
      const w = z.list.find(w => w.instance_id === iid);
      if (w) return { warrior: w, zone: z.key, zoneLabel: z.label };
    }
    return null;
  }

  function openFieldWarriorSheet(iid) {
    const found = findMyWarrior(iid);
    if (!found) return;
    const { warrior: w, zone, zoneLabel } = found;
    const def = getCardDef(iid);
    const canMove = isMyTurn() && currentState.phase === 'schieramento';

    Sheet.open({
      title: w.name || iid,
      subtitle: `${zoneLabel}${w.horde_active ? ' · ⚡ Orda attiva' : ''}` +
        (canMove ? '' : ' — spostabile nella fase Schieramento'),
      body: Render.cardViewNode(def, { att: w.att, git: w.git, dif: w.dif, instanceId: iid }),
      footer: [
        { label: 'Scarta', className: 'mbtn-danger', onClick: () => confirmDiscard(iid, 'field') },
        {
          label: '⇄ Riposiziona',
          className: 'mbtn-gold',
          disabled: !canMove,
          onClick: () => {
            Sheet.close(true);
            Sheet.choice(`Sposta ${w.name || ''}`, [
              { icon: '⚔️', label: 'Avanscoperta', value: 'vanguard', disabled: zone === 'vanguard' },
              { icon: '🏰', label: 'Bastione Sinistro', value: 'bastion_left', disabled: zone === 'bastion_left' },
              { icon: '🏰', label: 'Bastione Destro', value: 'bastion_right', disabled: zone === 'bastion_right' },
            ], (dest) => sendAction('reposition', { warrior_instance_id: iid, destination: dest }));
          },
        },
        { label: 'Chiudi', onClick: () => Sheet.close() },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: avanscoperta (mia)
  // ---------------------------------------------------------------------------

  function openVanguardSheet() {
    const my = me();
    if (!my) return;
    const warriors = my.field.vanguard || [];
    const canMove = isMyTurn() && currentState.phase === 'schieramento';

    const body = [];
    if (warriors.length === 0) {
      body.push(el('div', { className: 'sheet-note' },
        ['Nessun Guerriero in Avanscoperta. Senza di loro non puoi attaccare in Battaglia.']));
    }

    warriors.forEach(w => {
      const row = el('button', { className: `opt-row sp-${w.species || 'umano'}` }, [
        el('span', { className: 'opt-icon' }, ['🗡️']),
        el('span', { className: 'opt-main' }, [
          el('span', { className: 'opt-label' }, [w.name || w.base_card_id]),
          el('span', { className: 'opt-sub', style: 'display:block' },
            [`${capitalize(w.species || '')} · 🗡️${w.att} 🏹${w.git} 🛡️${w.dif}${w.horde_active ? ' · ⚡ Orda' : ''}`]),
        ]),
        el('span', { className: 'opt-chevron' }, ['›']),
      ]);
      row.addEventListener('click', () => { haptic(); openFieldWarriorSheet(w.instance_id); });
      body.push(row);
    });

    Sheet.open({
      title: '⚔️ Avanscoperta',
      subtitle: `${warriors.length} Guerrieri` +
        (canMove && warriors.length > 0 ? ' · tocca un Guerriero per riposizionarlo' : ''),
      body,
      footer: [{ label: 'Chiudi', onClick: () => Sheet.close() }],
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: villaggio (mio)
  // ---------------------------------------------------------------------------

  function openVillageSheet() {
    const my = me();
    if (!my) return;
    const buildings = my.field.village.buildings || [];
    const body = [];

    if (buildings.length === 0) {
      body.push(el('div', { className: 'sheet-note' }, ['Nessuna Costruzione nel Villaggio. Giocale dalla mano nella fase Azioni.']));
    }

    buildings.forEach(b => {
      const def = getCardDef(b.instance_id);
      const isEth = my.ethereal_complete === b.instance_id;
      const row = el('button', { className: `opt-row${b.completed ? ' gold' : ''}` }, [
        el('span', { className: 'opt-icon' }, [b.completed ? '🏰' : '🏗️']),
        el('span', { className: 'opt-main' }, [
          el('span', { className: 'opt-label' }, [(def ? def.name : b.base_card_id) + (b.completed ? ' ✓' : '')]),
          el('span', { className: 'opt-sub', style: 'display:block' },
            [isEth ? '✧ Completabile gratis (Velocemento)' : (b.effect || (b.completed ? 'Completata' : 'Incompleta'))]),
        ]),
        el('span', { className: 'opt-chevron' }, ['›']),
      ]);
      row.addEventListener('click', () => { haptic(); openBuildingSheet(b.instance_id); });
      body.push(row);
    });

    Sheet.open({
      title: '🏰 Villaggio',
      subtitle: `${buildings.length} Costruzioni`,
      body,
      footer: [{ label: 'Chiudi', onClick: () => Sheet.close() }],
    });
  }

  function openBuildingSheet(iid) {
    const my = me();
    const b = (my.field.village.buildings || []).find(x => x.instance_id === iid);
    if (!b) return;
    const def = getCardDef(iid);
    const turnOk = isMyTurn();

    const discount = reinholdDiscountFor(b.base_card_id);
    const rawCost = def ? def.completion_cost : 0;
    const effCost = Math.max(0, rawCost - discount);
    const costLabel = discount > 0 ? `${rawCost}→${effCost}` : `${rawCost}`;
    const isEth = my.ethereal_complete === iid;

    const footer = [
      { label: 'Scarta', className: 'mbtn-danger', onClick: () => confirmDiscard(iid, 'village') },
    ];

    if (def && def.id === 'arena') {
      footer.push({
        label: '⚔️ Attiva Arena',
        className: 'mbtn-warn',
        disabled: !canActivateArena(iid),
        onClick: () => { Sheet.close(true); showArenaFlow(iid); },
      });
    }

    if (!b.completed) {
      footer.push({
        label: isEth ? '✧ Completa gratis' : `Completa (${costLabel} Mana)`,
        className: 'mbtn-gold',
        disabled: !turnOk,
        onClick: () => { Sheet.close(true); sendAction('complete_building', { building_instance_id: iid }); },
      });
    }

    footer.push({ label: 'Chiudi', onClick: () => Sheet.close() });

    Sheet.open({
      title: def ? def.name : iid,
      subtitle: b.completed ? '✓ Completata' : 'Incompleta — effetto Base attivo',
      body: Render.cardViewNode(def, { completed: b.completed, completionCostLabel: costLabel, instanceId: iid }),
      footer,
    });
  }

  // -- Arena -------------------------------------------------------------------

  function canActivateArena(buildingIid) {
    const my = me();
    if (!my || !isMyTurn()) return false;
    const b = (my.field.village.buildings || []).find(x => x.instance_id === buildingIid);
    if (!b || b.arena_available === false) return false;
    const mine = getAllWarriors(my);
    if (mine.length === 0) return false;
    const enemies = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);
    return mine.some(ow => enemies.some(en => getAllWarriors(en).some(
      ew => ow.att > ew.att || ow.git > ew.git || ow.dif > ew.dif)));
  }

  function showArenaFlow(buildingIid) {
    const my = me();
    const mine = getAllWarriors(my);
    const enemies = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);

    Sheet.choice('Arena — il tuo campione', mine.map(w => ({
      icon: '🗡️',
      label: w.name || w.base_card_id,
      sub: `🗡️${w.att} 🏹${w.git} 🛡️${w.dif} — verrà scartato`,
      value: w.instance_id,
    })), (ownIid) => {
      const ownW = mine.find(w => w.instance_id === ownIid);
      if (!ownW) return;
      const targets = [];
      enemies.forEach(p => {
        getAllWarriors(p).forEach(ew => {
          if (ownW.att > ew.att || ownW.git > ew.git || ownW.dif > ew.dif) {
            targets.push({
              icon: '💀',
              label: ew.name || ew.base_card_id,
              sub: `${p.name} · 🗡️${ew.att} 🏹${ew.git} 🛡️${ew.dif}`,
              value: `${p.id}:${ew.instance_id}`,
            });
          }
        });
      });
      if (targets.length === 0) { Toast.show('Nessun bersaglio valido per questo guerriero', 'error'); return; }
      Sheet.choice('Arena — chi viene sconfitto?', targets, (choice) => {
        const colon = choice.indexOf(':');
        sendAction('arena_activate', {
          building_instance_id: buildingIid,
          own_warrior_iid: ownIid,
          target_warrior_iid: choice.substring(colon + 1),
          target_player_id: choice.substring(0, colon),
        });
      }, { subtitle: 'Entrambi i Guerrieri vengono scartati' });
    }, { subtitle: 'Sacrifica un tuo Guerriero per eliminarne uno più debole' });
  }

  // ---------------------------------------------------------------------------
  // Sheet: avversario
  // ---------------------------------------------------------------------------

  function myAttackTargets() {
    const my = me();
    if (!currentState || !my) return [];
    const players = currentState.players;
    const myIdx = players.findIndex(p => p.id === myPlayerId);
    const n = players.length;
    const guerremoto = (my.active_effects || []).some(e => e.type === 'guerremoto' && e.any_target);

    const seen = new Set();
    const targets = [];
    const push = (idx, side) => {
      const p = players[idx];
      if (!p || p.id === myPlayerId || (p.lives ?? 0) <= 0) return;
      const key = `${p.id}:${side}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ player: p, playerIndex: idx, side });
    };

    if (guerremoto) {
      players.forEach((p, i) => { push(i, 'left'); push(i, 'right'); });
    } else {
      push((myIdx + 1) % n, 'left');   // il mio B.D. attacca il B.S. del vicino di destra
      push((myIdx - 1 + n) % n, 'right'); // il mio B.S. attacca il B.D. del vicino di sinistra
    }
    return targets;
  }

  function openOpponentSheet(playerId) {
    const p = currentState.players.find(pp => pp.id === playerId);
    if (!p) return;
    const attackable = new Set(myAttackTargets().filter(t => t.player.id === playerId).map(t => t.side));
    const body = [];

    // Effetti attivi visibili
    const fxItems = Render.activeEffectItems(p);
    if (fxItems.length > 0) {
      body.push(el('div', { className: 'zone-label', style: 'padding:6px 4px' }, ['✨ Effetti attivi']));
      fxItems.forEach(item => {
        body.push(el('div', { className: 'opt-row gold', style: 'pointer-events:none' }, [
          el('span', { className: 'opt-icon' }, ['✨']),
          el('span', { className: 'opt-main' }, [
            el('span', { className: 'opt-label' }, [item.label]),
            el('span', { className: 'opt-sub', style: 'display:block' }, [item.desc]),
          ]),
        ]));
      });
    }

    // Avanscoperta
    body.push(el('div', { className: 'zone-label', style: 'padding:6px 4px' }, ['⚔️ Avanscoperta']));
    if ((p.field.vanguard || []).length === 0) {
      body.push(el('div', { className: 'sheet-note' }, ['Vuota — non può attaccare.']));
    } else {
      const row = el('div', { style: 'display:flex;gap:8px;overflow-x:auto;padding:2px 2px 8px' });
      p.field.vanguard.forEach(w => {
        const mini = Render.warriorMini(w);
        mini.addEventListener('click', () => { haptic(); openEnemyCardSheet(w, p); });
        row.appendChild(mini);
      });
      body.push(row);
    }

    // Bastioni
    [['left', 'Sinistro'], ['right', 'Destro']].forEach(([side, name]) => {
      const bastion = side === 'left' ? p.field.bastion_left : p.field.bastion_right;
      const tag = attackable.has(side) ? ' (Possibile Bersaglio)' : '';
      body.push(el('div', { className: 'zone-label', style: 'padding:6px 4px' },
        [`🧱 Bastione ${name}${tag}`]));
      const row = el('div', { style: 'display:flex;gap:8px;overflow-x:auto;padding:2px 2px 8px' });
      row.appendChild(el('div', {
        className: 'card card-sm in-field wall-stack',
        dataset: { type: 'wall' },
      }, [
        el('div', { className: 'wall-stack-icon' }, ['🧱']),
        el('div', { className: 'wall-stack-count' }, [String(bastion.wall_count ?? 0)]),
      ]));
      (bastion.warriors || []).forEach(w => {
        const mini = Render.warriorMini(w);
        mini.addEventListener('click', () => { haptic(); openEnemyCardSheet(w, p); });
        row.appendChild(mini);
      });
      body.push(row);
    });

    // Villaggio
    const buildings = (p.field.village && p.field.village.buildings) || [];
    body.push(el('div', { className: 'zone-label', style: 'padding:6px 4px' }, ['🏰 Villaggio']));
    buildings.forEach(b => {
      const def = getCardDef(b.instance_id);
      const row = el('button', { className: `opt-row${b.completed ? ' gold' : ''}` }, [
        el('span', { className: 'opt-icon' }, [b.completed ? '🏰' : '🏗️']),
        el('span', { className: 'opt-main' }, [
          el('span', { className: 'opt-label' }, [(def ? def.name : b.base_card_id) + (b.completed ? ' ✓' : '')]),
          el('span', { className: 'opt-sub', style: 'display:block' }, [b.effect || '']),
        ]),
        el('span', { className: 'opt-chevron' }, ['›']),
      ]);
      row.addEventListener('click', () => {
        haptic();
        Sheet.open({
          title: def ? def.name : b.instance_id,
          subtitle: `${p.name} — ${b.completed ? '✓ Completata' : 'Incompleta'}`,
          body: Render.cardViewNode(def, { completed: b.completed }),
          footer: [{ label: '‹ Indietro', onClick: () => openOpponentSheet(playerId) }],
        });
      });
      body.push(row);
    });
    if (buildings.length === 0) body.push(el('div', { className: 'sheet-note' }, ['Nessuna Costruzione.']));

    Sheet.open({
      title: p.name,
      subtitle: `❤︎ ${p.lives} Vite · 🃏 ${p.hand_count} carte in mano` +
        (p.id === currentState.current_player_id ? ' · sta giocando' : ''),
      body,
      footer: [{ label: 'Chiudi', onClick: () => Sheet.close() }],
    });
  }

  function openEnemyCardSheet(w, owner) {
    const def = getCardDef(w.instance_id);
    Sheet.open({
      title: w.name || w.instance_id,
      subtitle: `di ${owner.name}`,
      body: Render.cardViewNode(def, { att: w.att, git: w.git, dif: w.dif }),
      footer: [{ label: '‹ Indietro', onClick: () => openOpponentSheet(owner.id) }],
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: vite, effetti attivi, log
  // ---------------------------------------------------------------------------

  function openLivesSheet(idx = 0) {
    const my = me();
    if (!my || !my.life_cards || my.life_cards.length === 0) {
      Toast.show('Nessuna Vita rimasta', 'error');
      return;
    }
    const cards = my.life_cards;
    const iid = cards[idx];
    const def = getCardDef(iid);
    preloadCardImages([cards[idx - 1], cards[idx + 1]]);
    showCardNavSheet({
      title: `❤︎ Vita ${idx + 1} di ${cards.length}`,
      subtitle: 'Solo tu puoi vedere le tue carte-Vita.',
      def,
      ctx: { instanceId: iid },
      pos: { idx, total: cards.length },
      onPrev: idx > 0 ? () => openLivesSheet(idx - 1) : null,
      onNext: idx < cards.length - 1 ? () => openLivesSheet(idx + 1) : null,
    });
  }

  function openActiveFxSheet() {
    const my = me();
    if (!my) return;
    const items = Render.activeEffectItems(my);
    if (items.length === 0) return;
    const body = items.map(item => el('div', { className: 'opt-row gold', style: 'pointer-events:none' }, [
      el('span', { className: 'opt-icon' }, ['✨']),
      el('span', { className: 'opt-main' }, [
        el('span', { className: 'opt-label' }, [item.label]),
        el('span', { className: 'opt-sub', style: 'display:block' }, [item.desc]),
      ]),
    ]));
    Sheet.open({
      title: '✨ Effetti attivi',
      body,
      footer: [{ label: 'Chiudi', onClick: () => Sheet.close() }],
    });
  }

  function openLogSheet() {
    const entries = Render.logEntries();
    const body = entries.length === 0
      ? [el('div', { className: 'log-empty' }, ['Nessun evento registrato finora.'])]
      : entries.map(e => el('div', { className: 'log-row' }, [e.text]));
    Sheet.open({
      title: '📜 Registro eventi',
      body,
      footer: [{ label: 'Chiudi', onClick: () => Sheet.close() }],
    });
  }

  // ---------------------------------------------------------------------------
  // Orda
  // ---------------------------------------------------------------------------

  function openHordeSheet() {
    const my = me();
    if (!my || !isMyTurn()) return;
    const hordes = (my.available_hordes || []).filter(h => !h.already_activated);
    if (hordes.length === 0) { Toast.show('Nessuna Orda disponibile', 'error'); return; }

    const zoneNames = { vanguard: 'Avanscoperta', bastion_left: 'Bastione Sin.', bastion_right: 'Bastione Des.' };
    const options = [];
    hordes.forEach(h => {
      h.warriors.forEach(w => {
        options.push({
          icon: '⚡',
          label: w.name,
          sub: `${capitalize(h.species)} · ${zoneNames[h.zone] || h.zone} — ${w.horde_effect}`,
          value: `${w.base_card_id}|${w.instance_id}|${h.zone}`,
        });
      });
    });

    Sheet.choice('⚡ Attiva un effetto Orda', options, (choice) => {
      const [hordeCardId, warriorIid, zone] = choice.split('|');
      sendAction('horde', { horde_card_id: hordeCardId, warrior_instance_id: warriorIid, zone });
    }, { subtitle: 'Ogni Orda può essere attivata una sola volta per turno' });
  }

  // ---------------------------------------------------------------------------
  // Battaglia
  // ---------------------------------------------------------------------------

  function openBattleSheet() {
    if (!isMyTurn()) return;
    if (currentState.battles_remaining <= 0) { Toast.show('Hai già attaccato questo turno', 'error'); return; }
    const my = me();
    if (!my.field.vanguard || my.field.vanguard.length === 0) {
      Toast.show('Non hai Guerrieri in Avanscoperta', 'error');
      return;
    }

    const targets = myAttackTargets();
    if (targets.length === 0) { Toast.show('Nessun bersaglio disponibile', 'error'); return; }

    const attAtt = Math.max(0, ...my.field.vanguard.map(w => w.att));
    const attGit = Math.max(0, ...my.field.vanguard.map(w => w.git));

    const options = targets.map(t => {
      const bastion = t.side === 'left' ? t.player.field.bastion_left : t.player.field.bastion_right;
      const defs = bastion.warriors || [];
      const defDif = defs.length ? Math.max(...defs.map(w => w.dif)) : 0;
      const defGit = defs.length ? Math.max(...defs.map(w => w.git)) : 0;
      const est = Math.max(attAtt - defDif, 0) + Math.max(attGit - defGit, 0);
      return {
        icon: '🎯',
        label: `${t.player.name} — Bastione ${t.side === 'left' ? 'Sin.' : 'Des.'}`,
        sub: `🧱 ${bastion.wall_count ?? 0} muri · ${defs.length} difensori · danno stimato ${est}`,
        value: `${t.playerIndex}:${t.side}`,
      };
    });

    Sheet.choice('⚔️ Scegli il bersaglio', options, (choice) => {
      const [idx, side] = choice.split(':');
      haptic(30);
      sendAction('battle', { defender_player_index: parseInt(idx), defender_bastion_side: side });
    }, { subtitle: `I tuoi attaccanti: 🗡️ ${attAtt} · 🏹 ${attGit}` });
  }

  // ---------------------------------------------------------------------------
  // Interazioni pendenti (sheet bloccati)
  // ---------------------------------------------------------------------------

  function showSearchSheet(deckView, pendingSearch) {
    const titles = {
      cercapersone_base: 'Cercapersone',
      cercapersone_prodigio: 'Cercapersone ✨',
      giulio_horde: 'Orda di Giulio',
    };
    const subs = {
      cercapersone_base: 'Scegli una Recluta da aggiungere alla mano',
      cercapersone_prodigio: 'Scegli una Recluta: diventerà Eterea',
      giulio_horde: 'Cerca Giulio II nel mazzo',
    };
    const matches = deckView.filter(c => c.matches);
    const body = [];
    body.push(el('div', { className: 'sheet-note' },
      [`${matches.length} carte selezionabili su ${deckView.length} nel mazzo.`]));

    const CHUNK = 60;
    const list = el('div');
    body.push(list);

    function renderChunk(from) {
      deckView.slice(from, from + CHUNK).forEach(card => {
        const typeLabel = card.type === 'warrior' ? (card.subtype === 'recruit' ? 'Recluta' : 'Eroe')
          : card.type === 'spell' ? 'Magia' : 'Costruzione';
        const row = el('button', { className: `deck-row${card.matches ? ' match' : ''}` }, [
          el('span', { className: 'dr-name' }, [card.name]),
          el('span', { className: 'dr-type' }, [typeLabel]),
        ]);
        row.disabled = !card.matches;
        if (card.matches) {
          row.addEventListener('click', () => {
            haptic();
            Sheet.close(true);
            sendAction('resolve_search', { chosen_iid: card.instance_id });
          });
        }
        list.appendChild(row);
      });
      if (from + CHUNK < deckView.length) {
        const more = el('button', { className: 'opt-row' }, [
          el('span', { className: 'opt-main' }, [
            el('span', { className: 'opt-label' }, [`Mostra altre ${Math.min(CHUNK, deckView.length - from - CHUNK)} carte…`]),
          ]),
        ]);
        more.addEventListener('click', () => { more.remove(); renderChunk(from + CHUNK); });
        list.appendChild(more);
      }
    }
    renderChunk(0);

    Sheet.open({
      title: `🔍 ${titles[pendingSearch.context] || 'Cerca nel mazzo'}`,
      subtitle: subs[pendingSearch.context] || '',
      body,
      footer: [{
        label: 'Esci senza prendere',
        onClick: () => { Sheet.close(true); sendAction('resolve_search', {}); },
      }],
      locked: true,
    });
  }

  function showBibliotecaSheet(interaction) {
    const my = me();
    const hand = (my && my.hand) || [];
    const isWall = interaction.type === 'biblioteca_wall';

    if (hand.length === 0) { sendAction('resolve_biblioteca', {}); return; }

    const options = hand.map(iid => {
      const def = getCardDef(iid);
      return { icon: '🃏', label: def ? def.name : iid, value: iid };
    });

    if (isWall) {
      Sheet.choice('📚 Biblioteca', options, (chosenIid) => {
        Sheet.choice('Su quale Bastione?', [
          { icon: '🏰', label: 'Bastione Sinistro', value: 'left' },
          { icon: '🏰', label: 'Bastione Destro', value: 'right' },
        ], (side) => {
          sendAction('resolve_biblioteca', { wall_card_iid: chosenIid, wall_bastion_side: side });
        }, { locked: true, cancelLabel: null });
      }, { subtitle: 'Scegli una carta da aggiungere come Muro', locked: true, cancelLabel: null });
    } else {
      Sheet.choice('📚 Biblioteca', options, (chosenIid) => {
        sendAction('resolve_biblioteca', { discard_iid: chosenIid });
      }, { subtitle: 'Scegli una carta da scartare', locked: true, cancelLabel: null });
    }
  }

  function showVelocementoSheet(buildingIids) {
    Sheet.choice('✨ Velocemento', buildingIids.map(iid => {
      const def = getCardDef(iid);
      return { icon: '🏗️', label: def ? def.name : iid, sub: def ? `${def.base_effect || ''}` : '', value: iid };
    }), (iid) => sendAction('resolve_velocemento', { building_instance_id: iid }),
    { subtitle: 'Scegli la Costruzione da rendere Eterea', locked: true, cancelLabel: null });
  }

  function showAgilpescaSheet() {
    const my = me();
    const hand = (my && my.hand) || [];
    Sheet.choice('🎣 Agilpesca', hand.map(iid => {
      const def = getCardDef(iid);
      return { icon: '🃏', label: def ? def.name : iid, value: iid };
    }), (iid) => sendAction('resolve_agilpesca', { discard_iid: iid }),
    { subtitle: 'Scegli una carta da scartare', locked: true, cancelLabel: null });
  }

  function showMagiscudoSheet(pending) {
    const caster = playerName(pending.caster_id);
    const spellDef = getCardDef(pending.spell_iid);
    const spellName = spellDef ? spellDef.name : 'una Magia';
    Sheet.open({
      title: '🛡️ Magiscudo — reagisci!',
      subtitle: `${caster} ha lanciato ${spellName} contro di te.`,
      body: spellDef ? Render.cardViewNode(spellDef, {}) : [],
      footer: [
        {
          label: 'Lascia passare',
          onClick: () => { Sheet.close(true); sendAction('resolve_magiscudo_counter', { accept: false }); },
        },
        {
          label: '🛡️ Usa Magiscudo',
          className: 'mbtn-gold',
          onClick: () => { Sheet.close(true); sendAction('resolve_magiscudo_counter', { accept: true }); },
        },
      ],
      locked: true,
    });
  }

  function showMalcomuneSheet(pending) {
    const my = me();
    const caster = playerName(pending.caster_id);
    const zones = [
      { warriors: my.field.vanguard, label: 'Avanscoperta' },
      { warriors: my.field.bastion_left.warriors, label: 'Bastione Sin.' },
      { warriors: my.field.bastion_right.warriors, label: 'Bastione Des.' },
    ];
    const options = [];
    zones.forEach(({ warriors, label }) => {
      (warriors || []).forEach(w => {
        const wDef = getCardDef(w.instance_id);
        if (wDef && wDef.species === pending.species) {
          options.push({ icon: '💀', label: wDef.name, sub: label, value: w.instance_id });
        }
      });
    });
    if (options.length === 0) { sendAction('resolve_malcomune', {}); return; }
    Sheet.choice('☠️ Malcomune', options,
      (iid) => sendAction('resolve_malcomune', { warrior_iid: iid }),
      { subtitle: `${caster} ti costringe a scartare un Guerriero ${capitalize(pending.species)}`, locked: true, cancelLabel: null });
  }

  function showCardoSheet() {
    const my = me();
    const zoneLabels = { vanguard: '⚔️ Avanscoperta', bastion_left: '🏰 Bastione Sin.', bastion_right: '🏰 Bastione Des.' };
    const options = [];
    Object.entries(zoneLabels).forEach(([zoneKey, zoneLabel]) => {
      const zone = my.field[zoneKey];
      const warriors = zone ? (zone.warriors || zone) : [];
      (warriors || []).forEach(w => {
        options.push({ icon: '🛞', label: w.name || w.base_card_id, sub: zoneLabel, value: w.instance_id });
      });
    });

    Sheet.choice('🛞 Cardo — sposta un Guerriero', options, (warriorIid) => {
      Sheet.choice('🛞 Cardo — destinazione', [
        { icon: '⚔️', label: 'Avanscoperta', value: 'vanguard' },
        { icon: '🏰', label: 'Bastione Sinistro', value: 'bastion_left' },
        { icon: '🏰', label: 'Bastione Destro', value: 'bastion_right' },
      ], (dest) => sendAction('resolve_cardo_move', { warrior_iid: warriorIid, destination: dest }),
      { locked: true, cancelLabel: null });
    }, {
      subtitle: 'Facoltativo: puoi anche saltare',
      locked: true,
      cancelLabel: 'Salta',
      onCancel: () => sendAction('resolve_cardo_move', {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Fine partita
  // ---------------------------------------------------------------------------

  function showGameOver(state) {
    stopLocalTimer();
    Sheet.close(true);
    clearSession();
    Screens.show('over');
    spawnConfetti();
    const winner = state.players.find(p => p.id === state.winner_id);
    const iWon = state.winner_id === myPlayerId;
    $('over-title').textContent = iWon ? 'Vittoria!' : 'Fine partita';
    $('over-winner').textContent = winner ? `${winner.name} conquista il Barbacane` : 'Nessun vincitore';
    $('over-scores').innerHTML = state.players
      .map(p => `${p.name}: ${'❤︎'.repeat(Math.max(0, p.lives))}${'✕'.repeat(Math.max(0, 3 - p.lives))}`)
      .join('<br>');
    haptic(iWon ? 120 : 40);
  }

  // ---------------------------------------------------------------------------
  // Animazione: la carta giocata vola dalla mano al bersaglio
  // ---------------------------------------------------------------------------

  const PLAY_TARGETS = {
    vanguard: 'fld-vanguard',
    bastion_left: 'tw-left',
    bastion_right: 'tw-right',
  };

  function flyFromHand(iid, targetElId) {
    const src = document.querySelector(`#hand .card[data-instance-id="${iid}"]`);
    if (!src) return;
    const r = src.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.add('hcard-ghost');
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    ghost.style.bottom = 'auto';
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);

    const target = targetElId ? document.getElementById(targetElId) : null;
    const tr = target ? target.getBoundingClientRect()
      : { left: window.innerWidth / 2 - r.width / 2, top: window.innerHeight * 0.3, width: r.width, height: 0 };
    const dx = (tr.left + tr.width / 2) - (r.left + r.width / 2);
    const dy = (tr.top + tr.height / 2) - (r.top + r.height / 2);

    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${dx.toFixed(0)}px, ${dy.toFixed(0)}px) scale(0.3) rotate(8deg)`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), 600);
  }

  function _animateAction(action, params) {
    if (action === 'play_warrior') flyFromHand(params.instance_id, PLAY_TARGETS[params.region]);
    else if (action === 'play_building') flyFromHand(params.instance_id, 'tw-village');
    else if (action === 'play_spell') flyFromHand(params.instance_id, null);
    else if (action === 'evolve') flyFromHand(params.hero_instance_id, null);
  }

  // ---------------------------------------------------------------------------
  // Trasporto
  // ---------------------------------------------------------------------------

  async function sendAction(action, params = {}) {
    _animateAction(action, params);
    if (WS && gameId) {
      WS.sendAction(action, params);
      return;
    }
    try {
      const res = await api('/game/action', {
        game_id: gameId, session_token: sessionToken, action, params,
      });
      onStateUpdate(res.state, action, res.result);
    } catch (e) {
      Toast.show(e.message || 'Errore', 'error');
    }
  }

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
  // API pubblica (usata da render.js e dagli event listener)
  // ---------------------------------------------------------------------------

  return {
    init,
    getCardDef,
    cardName,
    onHandTap,
    openFieldWarriorSheet,
    openBuildingSheet,
    openOpponentSheet,
    sendAction,
  };
})();

document.addEventListener('DOMContentLoaded', () => Mob.init());
