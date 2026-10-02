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

  // Orda di Evelyn: base_card_id della Magia da rigiocare. Finché è valorizzato,
  // le sendAction('play_spell') diventano 'recast_spell' (stessa UI di targeting).
  let recastPending = null;

  // True dopo la prima registrazione degli handler WS.on: connectGameWS()
  // viene richiamata a ogni nuova partita/tutorial, ma gli handler vanno
  // registrati una sola volta per tutta la vita della pagina (altrimenti si
  // accumulano e ogni evento viene gestito più volte).
  let wsHandlersBound = false;

  // ---------------------------------------------------------------------------
  // Stato Tutorial
  // ---------------------------------------------------------------------------

  let isTutorial = false;
  let tutorialsMeta = [];        // elenco tutorial (id, title, description, step_count)
  let tutorialStepsCache = {};   // tutorial_id -> [step, ...] (con testo/highlight)
  let tutorialCompletedShown = false;

  const SESSION_KEY = 'barb_m_session';

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    Sparks.init({ sizeFactor: 0.42, density: 2.5 });
    BgMusic.init();
    await loadCardDefs();
    bindLobbyUI();
    bindGameChrome();
    bindSplashUI();
    const resumed = await tryResume();
    if (!resumed) Screens.show('splash');
  }

  // La splash mostra solo il logo: toccandolo (primo gesto utente, sblocca
  // anche l'audio) sale verso la sua posizione e appare il resto della lobby.
  function bindSplashUI() {
    const splash = $('scr-splash');
    if (!splash) return;
    splash.addEventListener('click', enterFromSplash, { once: true });
  }

  function enterFromSplash() {
    const splash = $('scr-splash');
    const lobby = $('scr-lobby');
    if (!splash || !lobby) return;

    BgMusic.start();   // questo tocco è il gesto che sblocca l'audio

    const splashLogo = $('splash-logo');
    const lobbyLogo = lobby.querySelector('.lobby-logo');
    const scroll = lobby.querySelector('.lobby-scroll');
    const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Impagina la lobby (ancora invisibile) per misurare dove deve atterrare il logo.
    // Lo splash diventa un overlay fisso così non allunga la pagina falsando la misura.
    scroll.classList.add('logo-hidden', 'reveal');
    splash.classList.add('splash-flying');
    lobby.classList.add('active');

    const land = () => {
      scroll.classList.remove('logo-hidden');
      splash.classList.remove('splash-flying');
      if (splashLogo) splashLogo.style.transform = '';
      Screens.show('lobby');
    };

    const from = splashLogo ? splashLogo.getBoundingClientRect() : null;
    const to = lobbyLogo ? lobbyLogo.getBoundingClientRect() : null;
    // Se il logo non è caricato (fallback testuale) non c'è niente da far volare
    if (reducedMotion || !from || !to || from.width === 0 || to.width === 0) {
      land();
      return;
    }

    const scale = to.width / from.width;
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);

    requestAnimationFrame(() => {
      splashLogo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      land();
    };
    splashLogo.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 950); // rete di sicurezza se la transizione non parte
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
      if (state.tutorial) {
        isTutorial = true;
        tutorialCompletedShown = false;
        await _ensureTutorialStepsCached(state.tutorial.tutorial_id);
      }
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
    $('btn-add-bot').addEventListener('click', () => { haptic(); editLobby('/lobby/add_bot'); });
    document.querySelectorAll('.wait-diff-btn').forEach(btn => {
      btn.addEventListener('click', () => { haptic(); editLobby('/lobby/bot_difficulty', { difficulty: btn.dataset.diff }); });
    });
    $('in-join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
    $('wait-code').addEventListener('click', copyLobbyCode);

    // Catalogo carte
    $('btn-catalog').addEventListener('click', openCatalog);
    $('cat-back').addEventListener('click', () => { haptic(); Screens.show('lobby'); });

    // Tutorial
    $('btn-tutorial').addEventListener('click', openTutorialList);
    $('tut-back').addEventListener('click', () => { haptic(); Screens.show('lobby'); });
    $('tutorial-panel-exit').addEventListener('click', exitTutorial);
    $('tutorial-panel-next').addEventListener('click', (e) => {
      haptic();
      // Fine tutorial: si torna all'elenco senza ricaricare la pagina, che
      // interromperebbe la musica (il browser non la fa ripartire da solo).
      if (tutorialCompletedShown) { exitTutorial(); return; }
      // Disabilitato fino al passo successivo: un doppio tocco salterebbe un passo.
      e.currentTarget.disabled = true;
      sendAction('tutorial_next', {});
    });
    ['tutorial-panel-prev', 'card-anatomy-prev'].forEach(id => $(id).addEventListener('click', (e) => {
      haptic();
      e.currentTarget.disabled = true;
      sendAction('tutorial_prev', {});
    }));
    $('card-anatomy-exit').addEventListener('click', exitTutorial);
    $('card-anatomy-next').addEventListener('click', (e) => {
      // Disabilitato fino al passo successivo: un doppio tocco salterebbe un passo.
      haptic();
      e.currentTarget.disabled = true;
      sendAction('tutorial_next', {});
    });

    // Sfida un Bot
    $('btn-mode-single').addEventListener('click', () => { haptic(); Screens.show('bot-difficulty'); });
    $('btn-mode-multi').addEventListener('click', () => { haptic(); Screens.show('multi'); });
    $('multi-back').addEventListener('click', () => { haptic(); Screens.show('lobby'); });
    $('bot-diff-back').addEventListener('click', () => { haptic(); Screens.show('lobby'); });
    document.querySelectorAll('.bot-count-btn').forEach(btn => {
      btn.addEventListener('click', () => { haptic(); selectBotCount(parseInt(btn.dataset.bots, 10)); });
    });
    document.querySelectorAll('.difficulty-card').forEach(card => {
      card.addEventListener('click', () => { haptic(); startPracticeGame(card.dataset.difficulty); });
    });
  }

  // ---------------------------------------------------------------------------
  // Partita di pratica contro 1–3 Bot (partita reale, non scriptata)
  // ---------------------------------------------------------------------------

  let practiceBotCount = 1;

  function selectBotCount(n) {
    practiceBotCount = n;
    document.querySelectorAll('.bot-count-btn').forEach(btn => {
      const on = parseInt(btn.dataset.bots, 10) === n;
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    document.querySelector('.bot-count-hint').textContent = `Partita da ${n + 1} giocatori`;
  }

  async function startPracticeGame(difficulty) {
    try {
      const res = await api('/practice/start', { player_name: 'Tu', difficulty, num_bots: practiceBotCount });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      gameId = res.game_id;
      lobbyCode = null;
      isCreator = false;
      isTutorial = false;
      saveSession();
      enterGame(res.state);
    } catch (e) {
      Toast.show(e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Tutorial — elenco e avvio
  // ---------------------------------------------------------------------------

  async function openTutorialList() {
    haptic();
    try {
      if (!tutorialsMeta.length) {
        const res = await apiFetch('/tutorials');
        tutorialsMeta = res.tutorials || [];
      }
      renderTutorialListGrid();
      Screens.show('tutorial-list');
    } catch (e) {
      Toast.show('Impossibile caricare i tutorial', 'error');
    }
  }

  function renderTutorialListGrid() {
    const list = $('tut-list');
    list.innerHTML = '';
    tutorialsMeta.forEach(t => {
      const item = el('div', { className: 'tut-item' }, [
        el('div', { className: 'tut-item-title' }, [t.title]),
        el('div', { className: 'tut-item-desc' }, [t.description]),
        el('div', { className: 'tut-item-steps' }, [`${t.step_count} passi`]),
      ]);
      item.addEventListener('click', () => { haptic(); startTutorial(t.id); });
      list.appendChild(item);
    });
  }

  async function _ensureTutorialStepsCached(tutorialId) {
    if (!tutorialStepsCache[tutorialId]) {
      const full = await apiFetch(`/tutorials/${tutorialId}`);
      tutorialStepsCache[tutorialId] = full.steps || [];
    }
  }

  async function startTutorial(tutorialId) {
    try {
      await _ensureTutorialStepsCached(tutorialId);
      const res = await api('/tutorial/start', { tutorial_id: tutorialId, player_name: 'Tu' });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      gameId = res.game_id;
      lobbyCode = null;
      isTutorial = true;
      tutorialCompletedShown = false;
      saveSession();
      enterGame(res.state);
    } catch (e) {
      Toast.show(e.message, 'error');
    }
  }

  function exitTutorial() {
    haptic();
    recastPending = null;
    WS.disconnect();
    stopLocalTimer();
    Sheet.close(true);
    hideTutorialStep();
    hideCardAnatomy();
    $('tb-leave').hidden = false;
    clearSession();
    leavingGame = false;
    currentState = null;
    gameId = null;
    sessionToken = null;
    myPlayerId = null;
    isTutorial = false;
    Screens.show('tutorial-list');
  }

  // ---------------------------------------------------------------------------
  // Tutorial — occhio di bue sul campo e pannello dei passi
  // ---------------------------------------------------------------------------

  // Tutto lo schermo si scurisce tranne le zone del passo corrente (spotlight.js);
  // il pannello col testo si piazza accanto e resta visibile anche nei passi
  // d'azione, dove al posto di "Avanti" invita a compiere la mossa sul campo.
  // «← Indietro» compare solo se il server lo consente: si torna solo a un
  // passo di spiegazione, mai a prima di una mossa già giocata.
  function _setTutorialBackButton(id, canGoBack) {
    $(id).hidden = !canGoBack;
    $(id).disabled = false;
  }

  function showTutorialStep(step, idx, steps, canGoBack) {
    const panel = $('tutorial-panel');
    $('tutorial-panel-progress').textContent = `Passo ${idx + 1} di ${steps.length}`;
    $('tutorial-panel-title').textContent = step.title || '';
    $('tutorial-panel-text').textContent = step.text || '';
    const nextBtn = $('tutorial-panel-next');
    nextBtn.textContent = 'Avanti →';
    nextBtn.hidden = !!step.requires_action;
    nextBtn.disabled = false;
    $('tutorial-panel-exit').hidden = false;
    $('tutorial-panel-waiting').hidden = !step.requires_action;
    _setTutorialBackButton('tutorial-panel-prev', canGoBack);
    panel.hidden = false;
    const ids = step.highlight_mobile && step.highlight_mobile.length ? step.highlight_mobile : step.highlight;
    Spotlight.show(ids || [], panel);
  }

  // Fine tutorial: stesso pannello dei passi, centrato a schermo spento, con
  // un solo pulsante per tornare all'elenco (e il nome del tutorial successivo).
  function showTutorialCompleted(tutorialId) {
    const idx = tutorialsMeta.findIndex(t => t.id === tutorialId);
    const current = tutorialsMeta[idx];
    const next = idx >= 0 ? tutorialsMeta[idx + 1] : null;
    $('tutorial-panel-progress').textContent = current ? current.title : '';
    $('tutorial-panel-title').textContent = 'Tutorial completato!';
    $('tutorial-panel-text').textContent = next
      ? `Torna all'elenco per provare il prossimo: «${next.title}».`
      : (idx >= 0 ? 'Hai completato tutti i tutorial: sei pronto per una vera partita.'
                  : 'Torna all\'elenco per provarne un altro.');
    const nextBtn = $('tutorial-panel-next');
    nextBtn.textContent = 'Torna all\'elenco →';
    nextBtn.hidden = false;
    nextBtn.disabled = false;
    ['tutorial-panel-exit', 'tutorial-panel-prev', 'tutorial-panel-waiting'].forEach(id => { $(id).hidden = true; });
    const panel = $('tutorial-panel');
    panel.hidden = false;
    Spotlight.show([], panel);
  }

  function hideTutorialStep() {
    Spotlight.hide();
    $('tutorial-panel').hidden = true;
  }

  // Passi con card_focus (tutorial "Anatomia di una Carta"): la carta appare a
  // schermo intero e il riquadro evidenzia la sezione spiegata. rect è in
  // percentuale della carta ([x, y, w, h]); null = carta intera, niente riquadro.
  function showCardAnatomy(step, idx, steps, canGoBack) {
    const focus = step.card_focus;
    // Precarica le altre carte del tutorial, così il cambio carta non sfarfalla.
    steps.forEach(s => {
      if (s.card_focus) new window.Image().src = `/card_images/${s.card_focus.card}.png`;
    });
    const img = $('card-anatomy-img');
    const src = `/card_images/${focus.card}.png`;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);

    const box = $('card-anatomy-focus');
    if (focus.rect) {
      const [x, y, w, h] = focus.rect;
      Object.assign(box.style, { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` });
      box.hidden = false;
    } else {
      box.hidden = true;
    }

    $('card-anatomy-progress').textContent = `Passo ${idx + 1} di ${steps.length}`;
    $('card-anatomy-title').textContent = step.title || '';
    $('card-anatomy-text').textContent = step.text || '';
    $('card-anatomy-next').disabled = false;
    _setTutorialBackButton('card-anatomy-prev', canGoBack);
    $('card-anatomy-overlay').hidden = false;
  }

  function hideCardAnatomy() {
    $('card-anatomy-overlay').hidden = true;
  }

  function updateTutorialUI(state) {
    if (!isTutorial || !state.tutorial) {
      hideCardAnatomy();
      hideTutorialStep();
      return;
    }

    const steps = tutorialStepsCache[state.tutorial.tutorial_id] || [];
    const idx = state.tutorial.step_index;

    if (state.tutorial.completed || idx >= steps.length) {
      hideCardAnatomy();
      if (!tutorialCompletedShown) {
        tutorialCompletedShown = true;
        showTutorialCompleted(state.tutorial.tutorial_id);
      }
      return;
    }

    const step = steps[idx];
    if (!step) { hideTutorialStep(); return; }

    if (step.card_focus) {
      hideTutorialStep();
      showCardAnatomy(step, idx, steps, !!state.tutorial.can_go_back);
      return;
    }
    hideCardAnatomy();
    showTutorialStep(step, idx, steps, !!state.tutorial.can_go_back);
  }

  // ---------------------------------------------------------------------------
  // Catalogo carte (consultabile dalla lobby, prima della partita)
  // ---------------------------------------------------------------------------

  let catalogList = [];      // definizioni in ordine di visualizzazione
  let catalogBuilt = false;

  const CATALOG_SECTIONS = [
    { type: 'warrior',  label: 'Guerrieri' },
    { type: 'spell',    label: 'Magie' },
    { type: 'building', label: 'Costruzioni' },
  ];

  function openCatalog() {
    haptic();
    if (!catalogBuilt) buildCatalogGrid();
    Screens.show('catalog');
  }

  function buildCatalogGrid() {
    const grid = $('cat-grid');
    grid.innerHTML = '';
    catalogList = [];

    CATALOG_SECTIONS.forEach(section => {
      const defs = Object.values(cardDefs).filter(c => c.type === section.type);
      if (!defs.length) return;

      const box = el('div', { className: 'cat-section' });
      box.appendChild(el('div', { className: 'cat-section-title' }, [section.label]));

      const row = el('div', { className: 'cat-cards' });
      defs.forEach(def => {
        const idx = catalogList.length;
        catalogList.push(def);

        const cell = el('div', { className: 'cat-card' });
        const img = el('img', { alt: def.name, draggable: 'false' });
        img.loading = 'lazy';
        img.src = `/card_images/${def.id}.png`;
        // Senza immagine: tessera testuale col nome
        img.onerror = () => {
          cell.innerHTML = '';
          cell.appendChild(el('div', { className: 'cat-card-fallback' }, [def.name]));
        };
        cell.appendChild(img);
        cell.addEventListener('click', () => { haptic(); showCatalogCard(idx); });
        row.appendChild(cell);
      });
      box.appendChild(row);
      grid.appendChild(box);
    });

    catalogBuilt = true;
  }

  function catalogSubtitle(def) {
    if (def.type === 'warrior') {
      return `${capitalize(def.species)} · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}`;
    }
    if (def.type === 'spell') return `Magia · ${capitalize(def.school)}`;
    return 'Costruzione';
  }

  function showCatalogCard(idx) {
    const def = catalogList[idx];
    if (!def) return;

    // Precarica le vicine per una navigazione fluida
    if (catalogList[idx - 1]) Render.preloadCardImage(catalogList[idx - 1].id);
    if (catalogList[idx + 1]) Render.preloadCardImage(catalogList[idx + 1].id);

    showCardNavSheet({
      title: def.name,
      subtitle: catalogSubtitle(def),
      def,
      ctx: { realBack: true },
      pos: { idx, total: catalogList.length },
      onPrev: idx > 0 ? () => showCatalogCard(idx - 1) : null,
      onNext: idx < catalogList.length - 1 ? () => showCatalogCard(idx + 1) : null,
    });
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
      isTutorial = false;
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
      isTutorial = false;
      saveSession();
      showWaitingRoom(res.lobby);
    } catch (e) {
      Toast.show(e.message, 'error');
    }
  }

  function showWaitingRoom(lobby) {
    lobbyCode = lobby.lobby_code;
    $('wait-code-text').textContent = lobby.lobby_code;
    updateWaitingRoom(lobby);
    $('btn-start').hidden = !isCreator;
    $('wait-bots').hidden = !isCreator;
    $('wait-status').textContent = '';
    Screens.show('wait');
    startLobbyPolling();
  }

  let waitingPlayers = [];

  function updateWaitingRoom(lobby) {
    waitingPlayers = lobby.players || [];
    updateWaitingPlayers(waitingPlayers);
    $('btn-start').disabled = !lobby.can_start;
    $('btn-add-bot').disabled = waitingPlayers.length >= 4;
    document.querySelectorAll('.wait-diff-btn').forEach(btn => {
      btn.classList.toggle('on', btn.dataset.diff === (lobby.bot_difficulty || 'normal'));
    });
  }

  // Ordine dei posti al tavolo: i Bastioni confinano con quelli dei vicini,
  // quindi il creatore può riordinare i giocatori (e rimuovere i Bot).
  function updateWaitingPlayers(players) {
    const list = $('wait-players');
    list.innerHTML = '';
    players.forEach((p, i) => {
      const tag = p.is_bot ? 'Bot' : (p.player_id === myPlayerId ? 'tu' : '');
      const children = [
        el('span', { className: 'wait-seat' }, [`${i + 1}.`]),
        el('span', { className: p.is_bot ? 'dot bot' : 'dot' }),
        el('span', { className: 'wait-name' }, [p.name]),
        tag ? el('span', { className: 'wait-tag' }, [tag]) : null,
      ];
      if (isCreator) {
        const seatBtn = (label, ariaLabel, disabled, onClick) => el('button', {
          className: 'wait-seat-btn', 'aria-label': ariaLabel,
          disabled: disabled ? '' : null,
          onclick: () => { haptic(); onClick(); },
        }, [label]);
        children.push(
          seatBtn('▲', 'Sposta su', i === 0, () => moveWaitingPlayer(i, -1)),
          seatBtn('▼', 'Sposta giù', i === players.length - 1, () => moveWaitingPlayer(i, 1)),
        );
        if (p.is_bot) {
          children.push(seatBtn('✕', 'Rimuovi Bot', false,
            () => editLobby('/lobby/remove_bot', { bot_id: p.player_id })));
        }
      }
      list.appendChild(el('div', { className: 'wait-player' }, children));
    });
  }

  function moveWaitingPlayer(index, delta) {
    const order = waitingPlayers.map(p => p.player_id);
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    editLobby('/lobby/reorder', { order });
  }

  async function editLobby(path, params = {}) {
    try {
      const lobby = await api(path, { lobby_code: lobbyCode, session_token: sessionToken, ...params });
      updateWaitingRoom(lobby);
    } catch (e) {
      Toast.show(e.message, 'error');
    }
  }

  function startLobbyPolling() {
    stopLobbyPolling();
    lobbyPollTimer = setInterval(async () => {
      try {
        const lobby = await apiFetch(`/lobby/${lobbyCode}`);
        updateWaitingRoom(lobby);
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
    if (wsHandlersBound) return;
    wsHandlersBound = true;

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
      // Blocco dovuto a un'interazione in attesa: riapre gli sheet pendenti
      // nell'ordine giusto (prima la ricerca, poi Biblioteca & co.)
      if (msg.message && msg.message.includes('Biblioteca') && currentState) {
        _openPendingSheets(currentState);
      }
    });
  }

  // La mia interazione in attesa, solo se è la prima della coda: il server
  // risolve pending_interactions in ordine (es. Malcomune con due avversari),
  // quindi una mia interazione più indietro va solo attesa.
  function _myPendingInteraction(state) {
    const first = state && state.pending_interactions && state.pending_interactions[0];
    return first && first.player_id === myPlayerId ? first : null;
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
    $('tb-leave').hidden = isTutorial;
    _lastTurnPlayer = state.current_player_id;
    Render.game(state, myPlayerId);
    refreshDock();
    _openPendingSheets(state);
    if (state.winner_id) showGameOver(state);
    // Tutorial: aggiornata per ultima, così un eventuale sheet di completamento
    // non venga chiuso da altra logica di questo ciclo.
    if (isTutorial) updateTutorialUI(state);
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
        TurnBanner.show('Il tuo turno');
        haptic(40);
      } else {
        TurnBanner.show(`Il turno di ${playerName(state.current_player_id)}`, true);
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
          `${result.total_damage} Danni, ${result.walls_destroyed} Muri, ${result.life_lost} Vita` +
          (result.walls_discarded_guerremoto ? ` (+${result.walls_discarded_guerremoto} Muri scartati da Guerremoto)` : ''));
      }

      // Eracle: distruggi una costruzione avversaria
      if (action === 'battle' && result.eracle_destroy_triggered &&
          result.eracle_targets && result.eracle_targets.length > 0 &&
          state.current_player_id === myPlayerId) {
        const defender = state.players.find(p => p.id === result.defender_id);
        const targetIds = new Set(result.eracle_targets.map(b => b.instance_id));
        pickBuilding({
          title: 'Orda di Eracle — distruggi una Costruzione',
          subtitle: 'Hai inflitto almeno 3 Danni: scegli una Costruzione del difensore',
          players: defender ? [defender] : [],
          filter: (b) => targetIds.has(b.instance_id),
          locked: true,
          cancelLabel: null,
          onPick: (b) => sendAction('eracle_destroy', {
            building_instance_id: b.instance_id,
            target_player_id: result.defender_id,
          }),
        });
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

    // Tutorial: aggiornata per ultima (vedi nota in enterGame).
    if (isTutorial) updateTutorialUI(state);
  }

  function _openPendingSheets(state) {
    const me = state.players.find(p => p.id === myPlayerId);
    const myPending = _myPendingInteraction(state);

    if (state.pending_search && state.pending_search.player_id === myPlayerId && state.search_deck) {
      showSearchSheet(state.search_deck, state.pending_search);
      return true;
    }
    if (myPending) {
      if (myPending.type === 'cardo_move') showCardoSheet();
      else if (myPending.type === 'agilpesca_discard') showAgilpescaSheet();
      else if (myPending.type === 'magiscudo_counter') showMagiscudoSheet(myPending);
      else if (myPending.type === 'malcomune_discard') showMalcomuneSheet(myPending);
      else if (myPending.type === 'evelyn_recast') showEvelynRecastSheet(myPending);
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
    if (ev.type === 'warrior_to_wall') return `${pName} — ${cardLabel}: guerriero trasformato in Muro`;
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
        joseph: `Orda Joseph: ${(ev.enemy_troni_discarded || []).length ? 'Troni avversari scartati' : 'Troni avversari bloccati'}`,
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
        guerremoto: `Guerremoto: attacco a qualsiasi Bastione${ev.discard_walls ? `, scarta fino a ${ev.discard_walls} Muri prima dei Danni` : ''}`,
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

    const mkBtn = (label, cls, onClick, disabled = false, id = null) => {
      const b = el('button', { className: `mbtn ${cls || ''}` }, [label]);
      if (id) b.id = id;  // usato dallo spotlight dei tutorial
      b.disabled = disabled;
      b.addEventListener('click', () => { haptic(); onClick(); });
      return b;
    };
    const hint = (text) => el('div', { className: 'dock-hint' }, [text]);

    // Interazioni pendenti che mi riguardano → un solo bottone che riapre lo sheet
    const myPending = _myPendingInteraction(currentState);
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
        dock.appendChild(mkBtn('🏗️', '', openCompleteSheet, !hasIncomplete, 'dock-complete'));
        dock.appendChild(mkBtn('🧱', '', enterWallMode, !hasCards, 'dock-wall'));
        dock.appendChild(mkBtn('›', '', () => sendAction('next_phase', {}), false, 'dock-next'));
      } else {
        dock.appendChild(hint(hasEthereal ? 'Gioca la carta eterea o avanza' : 'Azioni esaurite'));
        dock.appendChild(mkBtn('Schieramento ›', 'mbtn-gold mbtn-pulse', () => sendAction('next_phase', {}), false, 'dock-next'));
      }

    } else if (phase === 'schieramento') {
      const hordes = (my && my.available_hordes) || [];
      dock.appendChild(hint('Tocca una Regione per riposizionare i Guerrieri.'));
      if (hordes.length > 0) {
        dock.appendChild(mkBtn(`⚡ Orda (${hordes.length})`, 'mbtn-warn mbtn-pulse', openHordeSheet, false, 'dock-horde'));
      }
      dock.appendChild(mkBtn('Battaglia ›', '', () => sendAction('next_phase', {}), false, 'dock-next'));

    } else if (phase === 'battaglia') {
      const canAttack = currentState.battles_remaining > 0 &&
        my && my.field.vanguard && my.field.vanguard.length > 0;
      dock.appendChild(hint(canAttack ? 'Attacca o termina il turno.' : 'Nessun attacco possibile.'));
      dock.appendChild(mkBtn('⚔️ Attacca', canAttack ? 'mbtn-gold' : '', openBattleSheet, !canAttack, 'dock-attack'));
      dock.appendChild(mkBtn('Fine turno', 'mbtn-danger', confirmEndTurn, false, 'dock-end-turn'));
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

  function showPlayOptions(iid, def) {
    if (!def) return;
    if (def.type === 'warrior') {
      if (def.subtype === 'hero') showHeroPlayOptions(iid, def);
      else {
        pickRegion({
          title: `Gioca ${def.name}`,
          subtitle: 'Scegli dove schierarlo',
          note: (z) => z === 'vanguard' ? 'Attacca in Battaglia' : 'Difende questo Bastione',
          onPick: (region) => sendAction('play_warrior', { instance_id: iid, region }),
        });
      }
    } else if (def.type === 'spell') {
      showSpellOptions(iid, def);
    } else if (def.type === 'building') {
      if (def.id === 'trono') {
        showTronoPlayOptions(iid, def);
        return;
      }
      Sheet.confirm(
        `Costruisci ${def.name}`,
        `Costo: <b>${def.cost} Mana</b><br>${def.base_effect || ''}`,
        () => sendAction('play_building', { instance_id: iid }),
        { yesLabel: '🏗️ Costruisci' },
      );
    }
  }

  // Trono: richiede la scelta immediata del Guerriero a cui assegnarlo
  function showTronoPlayOptions(iid, def) {
    const my = me();
    const warriors = my ? getAllWarriors(my) : [];
    if (warriors.length === 0) {
      Toast.show('Non hai nessun Guerriero in campo a cui assegnare il Trono.', 'error');
      return;
    }
    pickWarrior({
      title: `Costruisci ${def.name}`,
      subtitle: "Scegli il Guerriero a cui assegnarlo: completato, ne rende sempre attivo l'effetto Orda",
      players: [my],
      note: (w) => { const d = getCardDef(w.instance_id); return d && d.horde_effect ? null : 'Nessun effetto Orda'; },
      onPick: (w) => sendAction('play_building', { instance_id: iid, target_warrior_iid: w.instance_id }),
    });
  }

  function showHeroPlayOptions(iid, def) {
    const my = me();
    pickWarrior({
      title: `Evolvi in ${def.name}`,
      subtitle: 'La Recluta diventa Eroe e ne eredita le carte assegnate',
      players: [my],
      filter: (w) => { const d = getCardDef(w.instance_id); return !!d && d.evolves_into === def.id; },
      empty: `Nessuna Recluta compatibile in campo per evolvere ${def.name}.`,
      onPick: (w) => sendAction('evolve', { recruit_instance_id: w.instance_id, hero_instance_id: iid }),
    });
  }

  // -- Magie ------------------------------------------------------------------

  function computeSpellProdigy(def) {
    const my = me();
    if (!my || !def) return false;
    const all = getAllWarriors(my);
    // Orda Madeleine: i Prodigi degli Incantesimi si attivano indipendentemente
    // dalla Scuola delle Maghe -> contano tutte le Maghe in campo.
    const madeleineActive = (my.active_effects || []).some(
      e => e.type === 'madeleine_prodigy_any_school'
    );
    const countable = all.filter(w => {
      const d = getCardDef(w.instance_id) || {};
      if (madeleineActive && def.school === 'incantesimo') return d.species === 'maga';
      return d.school === def.school;
    }).length;
    return countable >= def.cost && def.cost > 0;
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
      const needPicker = def.id === 'plasmarmo' || (def.id === 'plasmattone' && prodigy);
      pickBastion({
        title: `${def.name} — scegli un tuo Bastione`,
        players: [my],
        filter: (p, side) => (bastionOf(p, side).wall_count ?? 0) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, side) => {
          if (needPicker) {
            showSpellWallPicker(bastionOf(my, side).walls || [], side, iid, 0);
          } else {
            sendAction('play_spell', { instance_id: iid, bastion_side: side });
          }
        },
      });
      return;
    }

    if (def.id === 'arrampicarta') {
      const my = me();
      if (getAllWarriors(my).length === 0) { Toast.show('Non hai nessun Guerriero in campo a cui assegnare un Muro.', 'error'); return; }
      pickBastion({
        title: `${def.name} — scegli un tuo Bastione`,
        subtitle: 'Poi scegli il Muro e il Guerriero a cui assegnarlo',
        players: [my],
        filter: (p, side) => (bastionOf(p, side).wall_count ?? 0) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, side) => showArrampicartaWallPicker(bastionOf(my, side).walls || [], side, iid, 0),
      });
      return;
    }

    if (def.id === 'cambiamente') {
      pickWarrior({
        title: `${def.name} — scegli un Guerriero`,
        players: opponents,
        empty: 'Nessun Guerriero avversario disponibile.',
        onPick: (w, p) => sendAction('play_spell', { instance_id: iid, target_player_id: p.id, target_warrior_iid: w.instance_id }),
      });
      return;
    }

    if (def.id === 'equipotenza') {
      pickWarrior({
        title: `${def.name} — scegli un tuo Guerriero`,
        subtitle: 'ATT e DIF diventano pari al valore maggiore dei due',
        players: [me()],
        empty: 'Non hai nessun Guerriero in campo.',
        onPick: (ownW) => {
          if (!prodigy) { sendAction('play_spell', { instance_id: iid, own_warrior_iid: ownW.instance_id }); return; }
          const shown = pickWarrior({
            title: `${def.name} — scegli un Guerriero qualsiasi`,
            subtitle: 'Prodigio: ATT e DIF diventano pari al valore minore dei due',
            onPick: (w) => sendAction('play_spell', { instance_id: iid, own_warrior_iid: ownW.instance_id, enemy_warrior_iid: w.instance_id }),
          });
          if (!shown) sendAction('play_spell', { instance_id: iid, own_warrior_iid: ownW.instance_id });
        },
      });
      return;
    }

    if (def.id === 'cuordipietra') { showCuordipietraOptions(iid, def, prodigy); return; }

    if (def.id === 'bastioncontrario') { showBastioncontrarioOptions(iid, def, prodigy); return; }

    if (def.id === 'regicidio') { showRegicidioOptions(iid, def, prodigy); return; }

    if (def.id === 'malcomune') {
      pickWarrior({
        title: `${def.name} — scegli un tuo Guerriero`,
        subtitle: (prodigy ? 'Prodigio: il tuo Guerriero resta in campo' : 'Il Guerriero scelto verrà scartato')
          + '. Ogni avversario ne scarta uno della stessa Specie',
        players: [me()],
        note: (w) => { const d = getCardDef(w.instance_id); return d && d.species ? `Specie: ${capitalize(d.species)}` : null; },
        empty: 'Non hai nessun Guerriero in campo.',
        onPick: (w) => sendAction('play_spell', { instance_id: iid, own_warrior_iid: w.instance_id }),
      });
      return;
    }

    const spellsNeedingTarget = ['ardolancio', 'incendifesa'];
    if (!spellsNeedingTarget.includes(def.id) || opponents.length === 0) {
      const effText = prodigy && def.prodigy_effect
        ? (def.prodigy_is_additive ? `${def.base_effect}<br><b style="color:var(--gold)">✨ Prodigio:</b> ${def.prodigy_effect}` : `<b style="color:var(--gold)">✨ Prodigio:</b> ${def.prodigy_effect}`)
        : (def.base_effect || '');
      Sheet.confirm(`Lancia ${def.name}`, `Costo: <b>${def.cost} Maghe</b><br>${effText}`,
        () => sendAction('play_spell', { instance_id: iid }),
        { yesLabel: '✨ Lancia' });
      return;
    }

    pickBastion({
      title: `${def.name} — scegli il Bastione bersaglio`,
      players: opponents,
      onPick: (p, side) => sendAction('play_spell', { instance_id: iid, target_player_id: p.id, target_bastion_side: side }),
    });
  }

  function showCuordipietraOptions(iid, def, prodigy) {
    const opponents = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);
    pickWarrior({
      title: `${def.name} — scegli un Guerriero`,
      subtitle: prodigy ? '' : 'Solo Reclute (con il Prodigio anche gli Eroi)',
      players: opponents,
      filter: (w) => prodigy || w.subtype === 'recruit',
      empty: prodigy ? 'Nessun Guerriero avversario disponibile.' : 'Nessuna Recluta avversaria disponibile.',
      onPick: (w, p) => {
        const targetPlayerId = p.id;
        const targetWarriorIid = w.instance_id;
        // Base: il Guerriero diventa Muro in un Bastione del suo proprietario; Prodigio: in uno tuo
        pickBastion({
          title: `${def.name} — dove diventa Muro ${w.name}?`,
          players: [prodigy ? me() : p],
          onPick: (bp, destSide) => sendAction('play_spell', {
            instance_id: iid,
            target_player_id: targetPlayerId,
            target_warrior_iid: targetWarriorIid,
            dest_bastion_side: destSide,
          }),
        });
      },
    });
  }

  function showBastioncontrarioOptions(iid, def, prodigy) {
    if (!prodigy) {
      pickPlayer({
        title: `${def.name} — scegli un giocatore`,
        subtitle: 'I suoi due Bastioni si scambiano i Muri',
        onPick: (p) => sendAction('play_spell', { instance_id: iid, player1_id: p.id }),
      });
      return;
    }
    pickBastion({
      title: `${def.name} — primo Bastione`,
      subtitle: 'Prodigio: due Bastioni qualsiasi si scambiano i Muri',
      onPick: (p1, s1) => {
        const sideName = s1 === 'left' ? 'Sinistro' : 'Destro';
        pickBastion({
          title: `${def.name} — secondo Bastione`,
          subtitle: p1.id === myPlayerId
            ? `Scambierà i Muri con il tuo Bastione ${sideName}`
            : `Scambierà i Muri con il Bastione ${sideName} di ${p1.name}`,
          filter: (p2, s2) => !(p2.id === p1.id && s2 === s1),
          onPick: (p2, s2) => sendAction('play_spell', { instance_id: iid, player1_id: p1.id, side1: s1, player2_id: p2.id, side2: s2 }),
        });
      },
    });
  }

  function showRegicidioOptions(iid, def, prodigy) {
    pickBuilding({
      title: `${def.name} — scegli un Trono`,
      subtitle: prodigy ? 'Prodigio: verrà scartato anche il Guerriero a cui è assegnato' : '',
      filter: (b) => b.base_card_id === 'trono',
      note: (b, p) => {
        if (!b.assigned_warrior) return 'Non assegnato';
        const warrior = getAllWarriors(p).find(w => w.instance_id === b.assigned_warrior);
        return `Assegnato a ${warrior ? (warrior.name || warrior.base_card_id) : 'un Guerriero'}`;
      },
      empty: 'Non ci sono Troni in campo.',
      onPick: (b, p) => sendAction('play_spell', { instance_id: iid, target_player_id: p.id, target_trono_iid: b.instance_id }),
    });
  }

  function showTelecinesiOptions(iid, def, prodigy) {
    const my = me();
    const alive = currentState.players.filter(p => p.lives > 0);
    const wallCount = (p, side) => bastionOf(p, side).wall_count ?? 0;

    function pickCount(maxWalls, onCount) {
      const rows = [];
      for (let i = 1; i <= Math.min(3, maxWalls); i++) rows.push({ name: `${i} ${i > 1 ? 'Muri' : 'Muro'}`, value: i });
      pickGrouped({
        title: 'Telecinesi — quanti Muri?',
        subtitle: 'I Muri spostati sono scelti a caso',
        groups: [{ zones: [{ rows }] }],
        onPick: (n) => onCount(n),
      });
    }

    if (!prodigy) {
      pickBastion({
        title: 'Telecinesi — Bastione di partenza',
        subtitle: "I Muri si spostano nell'altro tuo Bastione",
        players: [my],
        filter: (p, side) => wallCount(p, side) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, srcSide) => {
          const destSide = srcSide === 'left' ? 'right' : 'left';
          pickCount(wallCount(my, srcSide), (count) => {
            sendAction('play_spell', { instance_id: iid, source_side: srcSide, dest_side: destSide, count });
          });
        },
      });
      return;
    }

    function adjacentKeys(playerId, side) {
      const n = alive.length;
      const idx = alive.findIndex(p => p.id === playerId);
      const adj = [`${playerId}:${side === 'left' ? 'right' : 'left'}`];
      if (side === 'right') adj.push(`${alive[(idx + 1) % n].id}:left`);
      else adj.push(`${alive[(idx - 1 + n) % n].id}:right`);
      return new Set(adj);
    }

    pickBastion({
      title: 'Telecinesi — Bastione di partenza',
      subtitle: 'Prodigio: da un Bastione qualsiasi a uno adiacente',
      filter: (p, side) => wallCount(p, side) > 0,
      empty: 'Nessun Muro disponibile.',
      onPick: (src, srcSide) => {
        const adj = adjacentKeys(src.id, srcSide);
        pickBastion({
          title: 'Telecinesi — Bastione di arrivo',
          subtitle: 'Solo i Bastioni adiacenti a quello di partenza',
          filter: (p, side) => adj.has(`${p.id}:${side}`),
          onPick: (dst, dstSide) => pickCount(wallCount(src, srcSide), (count) => {
            sendAction('play_spell', {
              instance_id: iid,
              source_player_id: src.id, source_side: srcSide,
              dest_player_id: dst.id, dest_side: dstSide,
              count,
            });
          }),
        });
      },
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

  // Selettore muro per Arrampicarta, seguito dalla scelta del Guerriero a cui assegnarlo
  function showArrampicartaWallPicker(walls, side, spellIid, idx) {
    if (!walls.length) return;
    const iid = walls[idx];
    const def = getCardDef(iid);
    preloadCardImages([walls[idx - 1], walls[idx + 1]]);
    showCardNavSheet({
      title: def ? def.name : iid,
      subtitle: `Muro ${idx + 1} di ${walls.length}`,
      def,
      pos: { idx, total: walls.length },
      onPrev: idx > 0 ? () => showArrampicartaWallPicker(walls, side, spellIid, idx - 1) : null,
      onNext: idx < walls.length - 1 ? () => showArrampicartaWallPicker(walls, side, spellIid, idx + 1) : null,
      footer: [{
        label: '✓ Scegli questo Muro',
        className: 'mbtn-gold',
        onClick: () => {
          Sheet.close(true);
          showArrampicartaWarriorPicker(spellIid, side, iid);
        },
      }],
    });
  }

  function showArrampicartaWarriorPicker(spellIid, wallSide, wallIid) {
    pickWarrior({
      title: 'Arrampicarta — assegna il Muro a un Guerriero',
      players: [me()],
      onPick: (w) => sendAction('play_spell', {
        instance_id: spellIid,
        bastion_side: wallSide,
        wall_instance_id: wallIid,
        warrior_iid: w.instance_id,
      }),
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
    pickBuilding({
      title: 'Completa una Costruzione',
      players: [my],
      filter: (b) => !b.completed,
      meta: (b) => {
        if (my.ethereal_complete === b.instance_id) return 'Gratis (Velocemento)';
        const def = getCardDef(b.instance_id);
        const baseCost = def ? def.completion_cost : null;
        const discount = reinholdDiscountFor(b.base_card_id);
        const eff = baseCost !== null ? Math.max(0, baseCost - discount) : '?';
        return `${discount > 0 ? `${baseCost}→` : ''}${eff} Mana`;
      },
      note: (b) => {
        const def = getCardDef(b.instance_id);
        return def && def.complete_effect ? def.complete_effect.replace(/^&\s*/, '') : null;
      },
      onPick: (b) => sendAction('complete_building', { building_instance_id: b.instance_id }),
    });
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
        const hasAssigned = w.assigned_cards && w.assigned_cards.length > 0;
        const row = el('button', { className: `opt-row sp-${w.species || 'umano'}${hasAssigned ? ' has-assigned' : ''}` }, [
          el('span', { className: 'opt-icon' }, ['🗡️']),
          el('span', { className: 'opt-main' }, [
            el('span', { className: 'opt-label' }, [(hasAssigned ? '📌 ' : '') + (w.name || w.base_card_id)]),
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
    preloadCardImages([walls[idx - 1], walls[idx + 1]]);
    showCardNavSheet({
      title: `🧱 ${def ? def.name : iid}`,
      subtitle: 'Questa carta è un Muro: assorbe 1 Danno in Battaglia.',
      def,
      pos: { idx, total: walls.length },
      onPrev: idx > 0 ? () => showMyWallSheet(walls, side, idx - 1) : null,
      onNext: idx < walls.length - 1 ? () => showMyWallSheet(walls, side, idx + 1) : null,
      footer: [],
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

    const footer = [];
    if (w.evolved_from) {
      footer.push({
        label: 'Recluta',
        onClick: () => { Sheet.close(true); openRecruitSheet(w.evolved_from, w.name || iid, () => openFieldWarriorSheet(iid)); },
      });
    }
    if (w.assigned_cards && w.assigned_cards.some(ac => ac.type !== 'wall')) {
      footer.push({
        label: 'Carte assegnate',
        onClick: () => { Sheet.close(true); openAssignedCardsSheet(iid, myPlayerId, 0, () => openFieldWarriorSheet(iid)); },
      });
    }
    if (w.assigned_cards && w.assigned_cards.some(ac => ac.type === 'wall')) {
      footer.push({
        label: 'Muri assegnati',
        onClick: () => { Sheet.close(true); openAssignedWallSheet(iid, myPlayerId, 0, () => openFieldWarriorSheet(iid)); },
      });
    }
    footer.push({
      label: '⇄ Riposiziona',
      className: 'mbtn-gold',
      disabled: !canMove,
      onClick: () => {
        Sheet.close(true);
        pickRegion({
          title: `Sposta ${w.name || ''}`,
          exclude: zone,
          onPick: (dest) => sendAction('reposition', { warrior_instance_id: iid, destination: dest }),
        });
      },
    });
    footer.push({ label: 'Chiudi', onClick: () => Sheet.close() });

    Sheet.open({
      title: w.name || iid,
      subtitle: `${zoneLabel}${w.horde_active ? ' · ⚡ Orda attiva' : ''}` +
        (canMove ? '' : ' — spostabile nella fase Schieramento'),
      body: Render.cardViewNode(def, { att: w.att, git: w.git, dif: w.dif, instanceId: iid }),
      footer,
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
      const hasAssigned = w.assigned_cards && w.assigned_cards.length > 0;
      const row = el('button', { className: `opt-row sp-${w.species || 'umano'}${hasAssigned ? ' has-assigned' : ''}` }, [
        el('span', { className: 'opt-icon' }, ['🗡️']),
        el('span', { className: 'opt-main' }, [
          el('span', { className: 'opt-label' }, [(hasAssigned ? '📌 ' : '') + (w.name || w.base_card_id)]),
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
    // Le Costruzioni assegnate a un Guerriero (es. Trono) sono mostrate sul Guerriero, non qui
    const buildings = (my.field.village.buildings || []).filter(b => !b.assigned_warrior);
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

    const footer = [];

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

  // -- Selettori ------------------------------------------------------------------
  // Uno sheet comune diviso in gruppi (giocatore, oppure "Selezionabili" /
  // "Resto del mazzo") e sottosezioni (Regione, tipo di carta). Tutte le scelte di
  // Guerrieri, Bastioni, Costruzioni e carte passano di qui, così hanno lo stesso
  // aspetto. Parità con Renderer.showPicker & co. del client desktop.

  // Simboli monocromi di Regione, come sul desktop (⚔ e 🛡). Sono SVG e non
  // caratteri perché sui telefoni ︎ non basta: senza un glifo testuale nei
  // font di sistema (🛡 su iOS) il carattere torna un'emoji a colori.
  // Usano currentColor, quindi prendono il colore del testo che li contiene.
  const REGION_SVG = {
    vanguard: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M4 4l11 11M20 4L9 15"/><path d="M12.5 17.5l5-5M6.5 12.5l5 5"/><path d="M16 16l4 4M8 16l-4 4"/></svg>',
    bastion: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z"/></svg>',
  };
  const ICON_VANGUARD = 'svg:vanguard';
  const ICON_BASTION  = 'svg:bastion';

  // Nodo per un'icona dei selettori: 'svg:<nome>' → SVG di REGION_SVG, altrimenti testo
  function iconNode(icon) {
    if (typeof icon === 'string' && icon.startsWith('svg:')) {
      const span = el('span', { className: 'region-svg' });
      span.innerHTML = REGION_SVG[icon.slice(4)] || '';
      return span;
    }
    return icon;
  }

  const PICKER_ZONES = [
    { key: 'vanguard',      icon: ICON_VANGUARD, label: 'Avanscoperta' },
    { key: 'bastion_left',  icon: ICON_BASTION,  label: 'Bastione Sinistro', side: 'left' },
    { key: 'bastion_right', icon: ICON_BASTION,  label: 'Bastione Destro',   side: 'right' },
  ];
  const TARGET_TAG = 'Possibile Bersaglio';

  function zoneWarriors(p, zoneKey) {
    return zoneKey === 'vanguard' ? (p.field.vanguard || []) : (p.field[zoneKey].warriors || []);
  }

  function bastionOf(p, side) {
    return side === 'left' ? p.field.bastion_left : p.field.bastion_right;
  }

  // Giocatori vivi in ordine di posto, partendo da me.
  function playersFromMe() {
    const ps = currentState.players;
    const i = Math.max(0, ps.findIndex(p => p.id === myPlayerId));
    return [...ps.slice(i), ...ps.slice(0, i)].filter(p => (p.lives ?? 0) > 0);
  }

  // Chiavi "playerId:side" dei Bastioni avversari che posso attaccare
  function targetKeys() {
    return new Set(myAttackTargets().map(t => `${t.player.id}:${t.side}`));
  }

  const playerHead = (p) => (p.id === myPlayerId ? 'Tu' : p.name);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * Sheet di scelta a gruppi. Il tap su una riga sceglie subito.
   * opts: {
   *   title, subtitle,
   *   groups: [{ head?, zones: [{ icon?, label?, tag?, rows: [row] }] }],
   *     row: { icon?, name, meta?, note?, tag?, value, disabled? }
   *   onPick(value),
   *   locked, cancelLabel (default 'Annulla'; null = nessun bottone), onCancel,
   *   empty: messaggio (toast) se non c'è nessuna riga selezionabile
   * }
   * Ritorna false se non c'è niente da scegliere.
   */
  function pickGrouped(opts) {
    const groups = (opts.groups || []).map(g => ({
      ...g, zones: (g.zones || []).filter(z => z.rows && z.rows.length > 0),
    })).filter(g => g.zones.length > 0);
    const selectable = groups.some(g => g.zones.some(z => z.rows.some(r => !r.disabled)));
    if (!selectable) {
      if (opts.empty) Toast.show(opts.empty, 'error');
      return false;
    }

    const body = groups.map(g => el('div', { className: 'wpick-player' }, [
      g.head ? el('div', { className: 'wpick-player-head' }, [g.head]) : null,
      ...g.zones.map(z => el('div', { className: 'wpick-zone' }, [
        z.label ? el('div', { className: 'wpick-zone-head' }, [
          z.icon ? el('span', { className: 'wpick-zone-icon' }, [iconNode(z.icon)]) : null,
          el('span', { className: 'wpick-zone-name' }, [z.label]),
          z.tag ? el('span', { className: 'wpick-tag' }, [z.tag]) : null,
        ]) : null,
        ...z.rows.map(r => {
          const row = el(r.disabled ? 'div' : 'button', { className: `wpick-row${r.disabled ? ' disabled' : ''}` }, [
            r.icon ? el('span', { className: 'wpick-row-icon' }, [iconNode(r.icon)]) : null,
            el('span', { className: 'wpick-main' }, [
              el('span', { className: 'wpick-name' }, [r.name]),
              r.tag ? el('span', { className: 'wpick-tag' }, [r.tag]) : null,
              r.meta ? el('span', { className: 'wpick-stats' }, [r.meta]) : null,
              r.note ? el('span', { className: 'wpick-note' }, [r.note]) : null,
            ]),
            r.disabled ? null : el('span', { className: 'opt-chevron' }, ['›']),
          ]);
          if (!r.disabled) {
            row.addEventListener('click', () => {
              haptic();
              Sheet.close(true);
              opts.onPick(r.value);
            });
          }
          return row;
        }),
      ])),
    ]));

    const footer = [];
    if (opts.cancelLabel !== null && (!opts.locked || opts.cancelLabel)) {
      footer.push({
        label: opts.cancelLabel || 'Annulla',
        onClick: () => { Sheet.close(true); opts.onCancel && opts.onCancel(); },
      });
    }
    Sheet.open({
      title: opts.title,
      subtitle: opts.subtitle || '',
      body,
      footer,
      locked: opts.locked,
      onClose: opts.onCancel,
    });
    return true;
  }

  // Opzioni comuni ai selettori specializzati, passate così come sono a pickGrouped
  function passthrough(opts) {
    const { title, subtitle, locked, cancelLabel, onCancel, empty } = opts;
    return { title, subtitle, locked, cancelLabel, onCancel, empty };
  }

  /**
   * Guerrieri, divisi per giocatore e per Regione.
   * opts: { players (default: tutti i vivi, io per primo), filter(w, p, zoneKey),
   *         note(w, p, zoneKey), onPick(w, p, zoneKey), + opzioni di pickGrouped }
   */
  function pickWarrior(opts) {
    const players = opts.players || playersFromMe();
    const onlyMe = players.length === 1 && players[0].id === myPlayerId;
    const targets = targetKeys();
    return pickGrouped({
      ...passthrough(opts),
      groups: players.map(p => ({
        head: onlyMe ? null : playerHead(p),
        zones: PICKER_ZONES.map(z => ({
          icon: z.icon,
          label: z.label,
          tag: z.side && targets.has(`${p.id}:${z.side}`) ? TARGET_TAG : null,
          rows: zoneWarriors(p, z.key)
            .filter(w => !opts.filter || opts.filter(w, p, z.key))
            .map(w => ({
              name: w.name || w.base_card_id,
              meta: `ATT ${w.att} · GIT ${w.git} · DIF ${w.dif}`,
              note: opts.note ? opts.note(w, p, z.key) : null,
              value: { w, p, zoneKey: z.key },
            })),
        })),
      })),
      onPick: (v) => opts.onPick(v.w, v.p, v.zoneKey),
    });
  }

  /**
   * Bastioni, divisi per giocatore.
   * opts: { players, filter(p, side), meta(p, side), note(p, side), onPick(p, side), + opzioni di pickGrouped }
   */
  function pickBastion(opts) {
    const players = opts.players || playersFromMe();
    const onlyMe = players.length === 1 && players[0].id === myPlayerId;
    const targets = targetKeys();
    return pickGrouped({
      ...passthrough(opts),
      groups: players.map(p => ({
        head: onlyMe ? null : playerHead(p),
        zones: [{
          rows: ['left', 'right']
            .filter(side => !opts.filter || opts.filter(p, side))
            .map(side => {
              const b = bastionOf(p, side);
              return {
                icon: ICON_BASTION,
                name: `Bastione ${side === 'left' ? 'Sinistro' : 'Destro'}`,
                tag: targets.has(`${p.id}:${side}`) ? TARGET_TAG : null,
                meta: opts.meta ? opts.meta(p, side)
                  : `${plural(b.wall_count ?? 0, 'Muro', 'Muri')} · ${plural((b.warriors || []).length, 'Guerriero', 'Guerrieri')}`,
                note: opts.note ? opts.note(p, side) : null,
                value: { p, side },
              };
            }),
        }],
      })),
      onPick: (v) => opts.onPick(v.p, v.side),
    });
  }

  /** Giocatori (es. Bastioncontrario base): una riga per giocatore con i Muri dei due Bastioni. */
  function pickPlayer(opts) {
    const players = opts.players || playersFromMe();
    return pickGrouped({
      ...passthrough(opts),
      groups: [{ zones: [{ rows: players.map(p => ({
        name: playerHead(p),
        meta: `Sinistro ${p.field.bastion_left.wall_count ?? 0} · Destro ${p.field.bastion_right.wall_count ?? 0} Muri`,
        value: p,
      })) }] }],
      onPick: (p) => opts.onPick(p),
    });
  }

  /**
   * Costruzioni nel Villaggio, divise per giocatore.
   * opts: { players, filter(b, p), meta(b, p), note(b, p), onPick(b, p), + opzioni di pickGrouped }
   */
  function pickBuilding(opts) {
    const players = opts.players || playersFromMe();
    const onlyMe = players.length === 1 && players[0].id === myPlayerId;
    return pickGrouped({
      ...passthrough(opts),
      groups: players.map(p => ({
        head: onlyMe ? null : playerHead(p),
        zones: [{
          label: 'Villaggio',
          rows: (p.field.village.buildings || [])
            .filter(b => !opts.filter || opts.filter(b, p))
            .map(b => {
              const def = getCardDef(b.instance_id);
              return {
                name: def ? def.name : b.base_card_id,
                meta: opts.meta ? opts.meta(b, p) : (b.completed ? 'Completa' : 'Base'),
                note: opts.note ? opts.note(b, p) : null,
                value: { b, p },
              };
            }),
        }],
      })),
      onPick: (v) => opts.onPick(v.b, v.p),
    });
  }

  /** Regione di destinazione di un proprio Guerriero (gioco dalla mano, riposizionamento, Cardo). */
  function pickRegion(opts) {
    return pickGrouped({
      ...passthrough(opts),
      groups: [{ zones: [{ rows: PICKER_ZONES.filter(z => z.key !== opts.exclude).map(z => ({
        icon: z.icon,
        name: z.label,
        note: opts.note ? opts.note(z.key) : null,
        value: z.key,
      })) }] }],
      onPick: (zoneKey) => opts.onPick(zoneKey),
    });
  }

  const CARD_TYPES = [
    { type: 'warrior',  label: 'Guerrieri' },
    { type: 'spell',    label: 'Magie' },
    { type: 'building', label: 'Costruzioni' },
  ];

  // Riga descrittiva di una carta (tipo, Specie/Scuola, costo), senza emoji
  function cardMeta(def) {
    if (!def) return '';
    if (def.type === 'warrior') return `${def.subtype === 'hero' ? 'Eroe' : 'Recluta'} · ${capitalize(def.species)}`;
    if (def.type === 'spell') return `${capitalize(def.school)} · ${plural(def.cost, 'Maga', 'Maghe')}`;
    return `${def.cost} Mana`;
  }

  /**
   * Carte (mano o mazzo), divise per tipo.
   * opts: {
   *   groups: [{ head?, cards: [instance_id], disabled? }]   (oppure cards: [...] per un solo gruppo)
   *   dedupe: raggruppa le copie della stessa carta in una riga "×N" (si sceglie la prima),
   *   note(def, iid), onPick(iid), + opzioni di pickGrouped
   * }
   */
  function pickCard(opts) {
    const srcGroups = opts.groups || [{ cards: opts.cards || [] }];
    return pickGrouped({
      ...passthrough(opts),
      groups: srcGroups.map(g => {
        const entries = [];
        const byBase = new Map();
        g.cards.forEach(iid => {
          const def = getCardDef(iid);
          const key = def ? def.id : iid;
          if (opts.dedupe && byBase.has(key)) { byBase.get(key).count++; return; }
          const entry = { iid, def, count: 1 };
          entries.push(entry);
          if (opts.dedupe) byBase.set(key, entry);
        });
        return {
          head: g.head || null,
          zones: CARD_TYPES.map(t => ({
            label: t.label,
            rows: entries
              .filter(e => (e.def ? e.def.type : 'building') === t.type)
              .sort((a, b) => (a.def ? a.def.name : '').localeCompare(b.def ? b.def.name : ''))
              .map(e => ({
                name: `${e.def ? e.def.name : e.iid}${e.count > 1 ? ` ×${e.count}` : ''}`,
                meta: cardMeta(e.def),
                note: opts.note ? opts.note(e.def, e.iid) : null,
                disabled: !!g.disabled,
                value: e.iid,
              })),
          })),
        };
      }),
      onPick: (iid) => opts.onPick(iid),
    });
  }

  // -- Arena -------------------------------------------------------------------

  function canActivateArena(buildingIid) {
    const my = me();
    if (!my || !isMyTurn()) return false;
    // Solo prima della Battaglia (fasi Azioni e Schieramento)
    if (!['action', 'schieramento'].includes(currentState.phase)) return false;
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
    const enemies = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);
    const beats = (own, ew) => own.att > ew.att || own.git > ew.git || own.dif > ew.dif;
    const hasTarget = (own) => enemies.some(en => getAllWarriors(en).some(ew => beats(own, ew)));

    pickWarrior({
      title: 'Arena — scegli il tuo campione',
      subtitle: 'Verrà scartato insieme al Guerriero avversario che sconfigge',
      players: [my],
      filter: (w) => hasTarget(w),
      empty: 'Nessun tuo Guerriero ha un bersaglio valido.',
      onPick: (ownW) => {
        pickWarrior({
          title: `Arena — chi sconfigge ${ownW.name}?`,
          subtitle: `Il tuo campione: ATT ${ownW.att} · GIT ${ownW.git} · DIF ${ownW.dif}. Basta una Caratteristica più bassa`,
          players: enemies,
          filter: (ew) => beats(ownW, ew),
          note: (ew) => 'Più debole in ' + ['att', 'git', 'dif']
            .filter(k => ew[k] < ownW[k]).map(k => k.toUpperCase()).join(', '),
          empty: 'Nessun bersaglio valido per questo Guerriero.',
          onPick: (ew, p) => sendAction('arena_activate', {
            building_instance_id: buildingIid,
            own_warrior_iid: ownW.instance_id,
            target_warrior_iid: ew.instance_id,
            target_player_id: p.id,
          }),
        });
      },
    });
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
      // Vicini vivi più prossimi: gli eliminati vengono saltati (il cerchio si stringe).
      const nextAlive = d => {
        let j = myIdx;
        for (let k = 0; k < n - 1; k++) {
          j = (j + d + n) % n;
          if ((players[j].lives ?? 0) > 0) return j;
        }
        return -1;
      };
      push(nextAlive(1), 'left');   // il mio B.D. attacca il B.S. del vicino di destra
      push(nextAlive(-1), 'right'); // il mio B.S. attacca il B.D. del vicino di sinistra
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
    const buildings = ((p.field.village && p.field.village.buildings) || []).filter(b => !b.assigned_warrior);
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
    const footer = [];
    if (w.evolved_from) {
      footer.push({
        label: 'Recluta',
        onClick: () => { Sheet.close(true); openRecruitSheet(w.evolved_from, w.name || w.instance_id, () => openEnemyCardSheet(w, owner)); },
      });
    }
    if (w.assigned_cards && w.assigned_cards.some(ac => ac.type !== 'wall')) {
      footer.push({
        label: 'Carte assegnate',
        onClick: () => { Sheet.close(true); openAssignedCardsSheet(w.instance_id, owner.id, 0, () => openOpponentSheet(owner.id)); },
      });
    }
    if (w.assigned_cards && w.assigned_cards.some(ac => ac.type === 'wall')) {
      const walls = w.assigned_cards.filter(ac => ac.type === 'wall');
      const revealable = walls.every(ac => ac.instance_id);
      footer.push({
        label: 'Muri assegnati',
        disabled: !revealable,
        onClick: revealable
          ? () => { Sheet.close(true); openAssignedWallSheet(w.instance_id, owner.id, 0, () => openOpponentSheet(owner.id)); }
          : () => {},
      });
    }
    footer.push({ label: '‹ Indietro', onClick: () => openOpponentSheet(owner.id) });
    Sheet.open({
      title: w.name || w.instance_id,
      subtitle: `di ${owner.name}`,
      body: Render.cardViewNode(def, { att: w.att, git: w.git, dif: w.dif }),
      footer,
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: Recluta sotto un Eroe evoluto — l'Eroe ne conserva l'effetto Orda,
  // ma la sua carta non lo riporta.
  // ---------------------------------------------------------------------------

  function openRecruitSheet(recruitIid, heroName, onBack) {
    const def = getCardDef(recruitIid);
    Sheet.open({
      title: def ? def.name : recruitIid,
      subtitle: `Recluta di ${heroName}`,
      body: Render.cardViewNode(def, { instanceId: recruitIid }),
      footer: [
        { label: 'Eroe', onClick: () => { Sheet.close(true); if (onBack) onBack(); } },
        { label: 'Chiudi', onClick: () => Sheet.close() },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: carte assegnate a un Guerriero (es. Trono)
  // ---------------------------------------------------------------------------

  function openAssignedCardsSheet(warriorIid, ownerPlayerId, idx, onBack) {
    const owner = currentState.players.find(p => p.id === ownerPlayerId);
    const warrior = owner ? getAllWarriors(owner).find(w => w.instance_id === warriorIid) : null;
    if (!warrior) return;
    const assignedCards = (warrior.assigned_cards || []).filter(ac => ac.type !== 'wall');
    if (assignedCards.length === 0) return;

    const ac = assignedCards[idx];
    const def = getCardDef(ac.instance_id);
    const isMine = ownerPlayerId === myPlayerId;
    const canComplete = ac.type === 'building' && ac.completed === false && isMine && isMyTurn();

    const footer = [];
    if (canComplete) {
      footer.push({
        label: 'Completa',
        className: 'mbtn-gold',
        onClick: () => { Sheet.close(true); sendAction('complete_building', { building_instance_id: ac.instance_id }); },
      });
    }
    if (onBack) footer.push({ label: '‹ Indietro', onClick: onBack });

    preloadCardImages([
      assignedCards[idx - 1] && assignedCards[idx - 1].instance_id,
      assignedCards[idx + 1] && assignedCards[idx + 1].instance_id,
    ]);
    showCardNavSheet({
      title: `📌 ${def ? def.name : ac.instance_id}`,
      subtitle: `Assegnata a ${warrior.name || warrior.base_card_id}` +
        (ac.completed !== undefined ? (ac.completed ? ' · ✓ Completata' : ' · Incompleta') : ''),
      def,
      ctx: { completed: ac.completed, instanceId: ac.instance_id, assigned: true },
      pos: { idx, total: assignedCards.length },
      onPrev: idx > 0 ? () => openAssignedCardsSheet(warriorIid, ownerPlayerId, idx - 1, onBack) : null,
      onNext: idx < assignedCards.length - 1 ? () => openAssignedCardsSheet(warriorIid, ownerPlayerId, idx + 1, onBack) : null,
      footer,
    });
  }

  // ---------------------------------------------------------------------------
  // Sheet: Muri assegnati a un Guerriero (es. Arrampicarta) — a testa in giù
  // e numerati come nel Bastione; identità nascosta agli avversari dal server.
  // ---------------------------------------------------------------------------

  function openAssignedWallSheet(warriorIid, ownerPlayerId, idx, onBack) {
    const owner = currentState.players.find(p => p.id === ownerPlayerId);
    const warrior = owner ? getAllWarriors(owner).find(w => w.instance_id === warriorIid) : null;
    if (!warrior) return;
    const walls = (warrior.assigned_cards || []).filter(ac => ac.type === 'wall' && ac.instance_id);
    if (walls.length === 0) return;

    const ac = walls[idx];
    const def = getCardDef(ac.instance_id);

    const footer = [];
    if (onBack) footer.push({ label: '‹ Indietro', onClick: onBack });

    preloadCardImages([
      walls[idx - 1] && walls[idx - 1].instance_id,
      walls[idx + 1] && walls[idx + 1].instance_id,
    ]);
    showCardNavSheet({
      title: def ? def.name : ac.instance_id,
      subtitle: `Muro assegnato a ${warrior.name || warrior.base_card_id}`,
      def,
      ctx: { instanceId: ac.instance_id },
      pos: { idx, total: walls.length },
      onPrev: idx > 0 ? () => openAssignedWallSheet(warriorIid, ownerPlayerId, idx - 1, onBack) : null,
      onNext: idx < walls.length - 1 ? () => openAssignedWallSheet(warriorIid, ownerPlayerId, idx + 1, onBack) : null,
      footer,
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
    const hordes = my.available_hordes || [];
    if (hordes.length === 0) { Toast.show('Nessuna Orda disponibile', 'error'); return; }

    // Un gruppo per Orda (Regione + Specie). Le carte già attive per il proprio
    // gruppo non vanno riproposte; le altre carte dello stesso gruppo permettono
    // di cambiare l'effetto Orda attivo.
    const zoneOf = (key) => PICKER_ZONES.find(z => z.key === key) || { label: key };
    pickGrouped({
      title: 'Attiva un effetto Orda',
      subtitle: "Un'Orda resta attiva finché non si divide o scegli un altro effetto",
      groups: [{
        zones: hordes.map(h => ({
          icon: zoneOf(h.zone).icon,
          label: `${zoneOf(h.zone).label} — ${capitalize(h.species)}`,
          rows: h.warriors.filter(w => !w.active).map(w => ({
            name: w.name,
            note: w.horde_effect,
            value: { w, zone: h.zone },
          })),
        })),
      }],
      empty: 'Nessuna Orda disponibile',
      onPick: ({ w, zone }) => sendAction('horde', {
        horde_card_id: w.base_card_id, warrior_instance_id: w.instance_id, zone,
      }),
    });
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

    // Indice del giocatore nello stato, richiesto dall'azione battle
    const indexOf = new Map(targets.map(t => [`${t.player.id}:${t.side}`, t.playerIndex]));
    const players = playersFromMe().filter(p => targets.some(t => t.player.id === p.id));
    pickBastion({
      title: 'Battaglia — scegli il Bastione da attaccare',
      subtitle: `I tuoi attaccanti: ATT ${attAtt} · GIT ${attGit}`,
      players,
      filter: (p, side) => indexOf.has(`${p.id}:${side}`),
      note: (p, side) => {
        const defs = bastionOf(p, side).warriors || [];
        const defDif = defs.length ? Math.max(...defs.map(w => w.dif)) : 0;
        const defGit = defs.length ? Math.max(...defs.map(w => w.git)) : 0;
        const est = Math.max(attAtt - defDif, 0) + Math.max(attGit - defGit, 0);
        return `Danno stimato: ${est}`;
      },
      onPick: (p, side) => {
        haptic(30);
        sendAction('battle', { defender_player_index: indexOf.get(`${p.id}:${side}`), defender_bastion_side: side });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Interazioni pendenti (sheet bloccati)
  // ---------------------------------------------------------------------------

  function showSearchSheet(deckView, pendingSearch) {
    const titles = {
      cercapersone_base: 'Cercapersone — scegli una Recluta',
      cercapersone_prodigio: 'Cercapersone — scegli una Recluta',
      giulio_horde: 'Orda di Giulio — cerca Giulio II',
    };
    const subs = {
      cercapersone_base: 'La Recluta scelta va nella tua mano.',
      cercapersone_prodigio: 'Prodigio: la Recluta scelta va nella tua mano e diventa Eterea.',
      giulio_horde: 'Giulio II va nella tua mano.',
    };
    // Le copie della stessa carta sono raggruppate in una riga "×N": l'ordine del
    // mazzo non viene mostrato.
    const matches = deckView.filter(c => c.matches).map(c => c.instance_id);
    const others = deckView.filter(c => !c.matches).map(c => c.instance_id);
    const title = titles[pendingSearch.context] || 'Cerca nel mazzo';
    const shown = pickCard({
      title,
      subtitle: `${subs[pendingSearch.context] || ''} ${matches.length} carte selezionabili su ${deckView.length} nel mazzo.`.trim(),
      groups: [
        { head: 'Selezionabili', cards: matches },
        { head: 'Resto del mazzo', cards: others, disabled: true },
      ],
      dedupe: true,
      locked: true,
      cancelLabel: 'Esci senza prendere',
      onCancel: () => sendAction('resolve_search', {}),
      onPick: (iid) => sendAction('resolve_search', { chosen_iid: iid }),
    });
    // Nessuna carta adatta nel mazzo: si può solo uscire
    if (!shown) {
      Sheet.open({
        title,
        body: [el('div', { className: 'sheet-note' }, ["Nel mazzo non c'è nessuna carta adatta."])],
        footer: [{
          label: 'Continua',
          className: 'mbtn-gold',
          onClick: () => { Sheet.close(true); sendAction('resolve_search', {}); },
        }],
        locked: true,
      });
    }
  }

  function showBibliotecaSheet(interaction) {
    const my = me();
    const hand = (my && my.hand) || [];
    const isWall = interaction.type === 'biblioteca_wall';

    if (hand.length === 0) { sendAction('resolve_biblioteca', {}); return; }

    if (isWall) {
      pickCard({
        title: 'Biblioteca — scegli una carta',
        subtitle: 'La carta scelta diventa un Muro in un tuo Bastione',
        cards: hand,
        locked: true,
        cancelLabel: null,
        onPick: (chosenIid) => pickBastion({
          title: 'Biblioteca — in quale Bastione?',
          players: [my],
          locked: true,
          cancelLabel: null,
          onPick: (p, side) => sendAction('resolve_biblioteca', { wall_card_iid: chosenIid, wall_bastion_side: side }),
        }),
      });
    } else {
      pickCard({
        title: 'Biblioteca — scegli una carta da scartare',
        cards: hand,
        locked: true,
        cancelLabel: null,
        onPick: (chosenIid) => sendAction('resolve_biblioteca', { discard_iid: chosenIid }),
      });
    }
  }

  function showVelocementoSheet(buildingIids) {
    pickCard({
      title: 'Velocemento — scegli una Costruzione',
      subtitle: 'La Costruzione scelta diventa Eterea',
      cards: buildingIids,
      note: (def) => def ? def.base_effect : null,
      locked: true,
      cancelLabel: null,
      onPick: (iid) => sendAction('resolve_velocemento', { building_instance_id: iid }),
    });
  }

  function showAgilpescaSheet() {
    const my = me();
    const hand = (my && my.hand) || [];
    pickCard({
      title: 'Agilpesca — scegli una carta da scartare',
      cards: hand,
      locked: true,
      cancelLabel: null,
      onPick: (iid) => sendAction('resolve_agilpesca', { discard_iid: iid }),
    });
  }

  // Orda di Evelyn: la Magia appena giocata va rigiocata, con nuovi bersagli.
  // Riusa la UI di targeting della prima giocata (vedi recastPending).
  function showEvelynRecastSheet(pending) {
    const baseId = pending.base_card_id;
    const def = cardDefs[baseId];
    Sheet.open({
      title: '✨ Orda di Evelyn',
      subtitle: `${def ? def.name : baseId} viene giocata una seconda volta: scegli i nuovi bersagli.`,
      body: def ? Render.cardViewNode(def, {}) : [],
      footer: [
        {
          label: 'Rinuncia',
          onClick: () => {
            Sheet.close(true);
            recastPending = null;
            sendAction('recast_spell', { base_card_id: baseId, skip: true });
          },
        },
        {
          label: '✨ Rigioca',
          className: 'mbtn-gold',
          onClick: () => {
            Sheet.close(true);
            recastPending = baseId;
            showSpellOptions(baseId, def);
            // Se il targeting non è possibile il flusso si chiude con un toast
            // senza aprire nulla: riproponi la scelta, altrimenti l'interazione
            // resterebbe in sospeso senza UI.
            setTimeout(() => {
              if (recastPending && !Sheet.isOpen()) {
                recastPending = null;
                showEvelynRecastSheet(pending);
              }
            }, 50);
          },
        },
      ],
      locked: true,
    });
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
    const shown = pickWarrior({
      title: 'Malcomune — scegli il Guerriero da scartare',
      subtitle: `${playerName(pending.caster_id)} ti costringe a scartare un Guerriero ${capitalize(pending.species)}`,
      players: [me()],
      filter: (w) => { const d = getCardDef(w.instance_id); return !!d && d.species === pending.species; },
      locked: true,
      cancelLabel: null,
      onPick: (w) => sendAction('resolve_malcomune', { warrior_iid: w.instance_id }),
    });
    if (!shown) sendAction('resolve_malcomune', {});
  }

  function showCardoSheet() {
    const shown = pickWarrior({
      title: 'Cardo — sposta un Guerriero',
      subtitle: 'Facoltativo: puoi anche saltare',
      players: [me()],
      locked: true,
      cancelLabel: 'Salta',
      onCancel: () => sendAction('resolve_cardo_move', {}),
      onPick: (w, p, zoneKey) => {
        pickRegion({
          title: `Cardo — dove sposti ${w.name}?`,
          exclude: zoneKey,
          locked: true,
          cancelLabel: null,
          onPick: (dest) => sendAction('resolve_cardo_move', { warrior_iid: w.instance_id, destination: dest }),
        });
      },
    });
    if (!shown) sendAction('resolve_cardo_move', {});
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
    $('over-winner').textContent = iWon ? 'Hai conquistato il Barbacane'
      : winner ? `${winner.name} conquista il Barbacane` : 'Nessun vincitore';
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
    if (recastPending && action === 'play_spell') {
      const { instance_id, ...rest } = params;
      action = 'recast_spell';
      params = { base_card_id: recastPending, ...rest };
      recastPending = null;
    }
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
