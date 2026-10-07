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

  // Orda di Evelyn: base_card_id della Magia da rigiocare una seconda volta.
  // Finché è valorizzato, le sendAction('play_spell') vengono convertite in
  // 'recast_spell' (stessa UI di targeting, azione diversa).
  let recastPending = null;

  // Timer
  let timerInterval = null;
  let timerSecondsLeft = 0;

  // True mentre stiamo abbandonando la partita: ignora gli update in arrivo
  let leavingGame = false;
  let lastTurnPlayer = null;   // per il banner di cambio turno
  let turnBannerTimer = null;

  // Cronaca: id dell'ultima voce già mostrata (le successive sono "nuove")
  let chronicleSeenId = 0;
  // Rivincita proposta da un altro giocatore (messaggio WS rematch_offer)
  let rematchOffer = null;
  // Codice lobby arrivato con un link d'invito (?join=BARB-XXXX)
  let pendingJoinCode = null;

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

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    Sparks.init();
    BgMusic.init();
    pendingJoinCode = Invite.takeFromURL();
    await loadCardDefs();
    bindLobbyUI();
    bindSplashUI();
    ['create-name', 'join-name'].forEach(id => { document.getElementById(id).value = PlayerName.get(); });
    // Pagina ricaricata durante una partita: si torna subito al tavolo
    if (await resumeGame(SavedGame.load(false))) return;
    Renderer.showScreen('splash');
    refreshResumeButton();
  }

  // ---------------------------------------------------------------------------
  // Partita salvata nel browser (session.js)
  // ---------------------------------------------------------------------------

  function rememberGame(state) {
    if (isTutorial || !gameId || !sessionToken) return;
    SavedGame.save({ gameId, token: sessionToken, playerId: myPlayerId, lobbyCode, mode: state.mode });
  }

  /** Rientra nella partita salvata, se è ancora in corso. */
  async function resumeGame(saved) {
    const state = await SavedGame.check(saved);
    if (!state) return false;
    sessionToken = saved.token;
    myPlayerId = saved.playerId || state.players.find(p => p.hand !== null && p.hand !== undefined).id;
    gameId = saved.gameId;
    lobbyCode = saved.lobbyCode || null;
    isCreator = false;
    isTutorial = false;
    enterGame(state);
    return true;
  }

  /** Mostra in home il pulsante "Riprendi la partita" se ce n'è una in corso. */
  async function refreshResumeButton() {
    const btn = document.getElementById('btn-resume');
    const saved = SavedGame.load(true);
    const state = saved ? await SavedGame.check(saved) : null;
    btn.classList.toggle('hidden', !state);
    if (!state) return;
    const others = state.players.filter(p => p.id !== saved.playerId).map(p => p.name);
    const kind = state.mode === 'practice' ? 'Giocatore singolo' : 'Multigiocatore';
    document.getElementById('btn-resume-sub').textContent =
      `${kind} · turno ${state.turn} · contro ${others.join(', ')}`;
  }

  // La splash mostra solo il logo: cliccandolo (primo gesto utente, sblocca
  // anche l'audio) sale verso la sua posizione e appare il resto della lobby.
  function bindSplashUI() {
    const splash = document.getElementById('screen-splash');
    if (!splash) return;
    splash.addEventListener('click', enterFromSplash, { once: true });
  }

  function enterFromSplash() {
    const splash = document.getElementById('screen-splash');
    const lobby = document.getElementById('screen-lobby');
    if (!splash || !lobby) return;

    BgMusic.start();   // questo click è il gesto che sblocca l'audio

    const splashLogo = document.getElementById('splash-logo');
    const lobbyLogo = lobby.querySelector('.logo');
    const container = lobby.querySelector('.lobby-container');
    const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Impagina la lobby (ancora invisibile) per misurare dove deve atterrare il logo.
    // Lo splash diventa un overlay fisso così non allunga la pagina falsando la misura.
    container.classList.add('logo-hidden', 'reveal');
    splash.classList.add('splash-flying');
    lobby.classList.add('active');

    const land = () => {
      container.classList.remove('logo-hidden');
      splash.classList.remove('splash-flying', 'splash-exit');
      if (splashLogo) splashLogo.style.transform = '';
      Renderer.showScreen('lobby');
      if (pendingJoinCode) openJoinFromInvite();
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

    splash.classList.add('splash-exit');
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

  // Link d'invito: si apre "Unisciti" con il codice già inserito
  function openJoinFromInvite() {
    const code = pendingJoinCode;
    pendingJoinCode = null;
    Renderer.showScreen('multiplayer');
    document.getElementById('join-code').value = code;
    const name = document.getElementById('join-name');
    (name.value ? document.getElementById('btn-join') : name).focus();
    Renderer.toast(`Invito alla lobby ${code}: scegli il tuo nome ed entra`, 'info');
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
    document.getElementById('btn-add-bot').addEventListener('click', () => editLobby('/lobby/add_bot'));
    document.getElementById('waiting-bot-difficulty').addEventListener('change', (e) =>
      editLobby('/lobby/bot_difficulty', { difficulty: e.target.value }));
    document.getElementById('btn-end-turn').addEventListener('click', onEndTurn);
    document.getElementById('btn-battle').addEventListener('click', onBattleClick);
    document.getElementById('btn-horde').addEventListener('click', onHordeClick);
    document.getElementById('btn-next-phase').addEventListener('click', onNextPhase);
    document.getElementById('btn-abandon').addEventListener('click', onAbandonClick);
    bindBastionClickHandlers();

    // Banner azione
    document.getElementById('banner-btn-play').addEventListener('click', enterPlayCardMode);
    document.getElementById('banner-btn-complete').addEventListener('click', enterCompleteBuildingMode);
    document.getElementById('banner-btn-wall').addEventListener('click', enterAddWallsMode);
    document.getElementById('btn-cancel-action').addEventListener('click', cancelActionMode);
    document.getElementById('wall-confirm-btn').addEventListener('click', confirmWalls);

    // Toggle pannello mobile
    const panelToggle = document.getElementById('panel-toggle');
    if (panelToggle) {
      panelToggle.addEventListener('click', () => {
        const panel = document.getElementById('action-panel');
        const open = panel.classList.toggle('panel-open');
        document.getElementById('panel-toggle-label').textContent = open ? '▾ Azioni' : '⚙ Azioni';
      });
    }

    document.getElementById('join-code').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase();
    });

    // Cronaca della partita
    document.getElementById('btn-chronicle').addEventListener('click', toggleChronicle);
    document.getElementById('battle-log').addEventListener('click', () => openChronicle());
    document.getElementById('chronicle-close').addEventListener('click', () => Renderer.closeChroniclePanel());
    document.getElementById('btn-gameover-chronicle').addEventListener('click', () => openChronicle(true));
    document.getElementById('chronicle-body').addEventListener('click', (e) => {
      const card = e.target.closest('.chr-card');
      if (card && card.dataset.card) showCardInfo(card.dataset.card);
    });

    // Fine partita e home
    document.getElementById('btn-rematch').addEventListener('click', onRematchClick);
    document.getElementById('btn-resume').addEventListener('click', async () => {
      if (!(await resumeGame(SavedGame.load(true)))) {
        Renderer.toast('La partita non è più disponibile', 'error');
        refreshResumeButton();
      }
    });

    // Catalogo carte
    document.getElementById('btn-catalog').addEventListener('click', openCatalog);
    document.getElementById('btn-catalog-back').addEventListener('click', () => Renderer.showScreen('lobby'));

    // Tutorial
    document.getElementById('btn-tutorial').addEventListener('click', openTutorialList);
    document.getElementById('btn-tutorial-back').addEventListener('click', () => Renderer.showScreen('lobby'));
    document.getElementById('tutorial-panel-exit').addEventListener('click', exitTutorial);
    document.getElementById('tutorial-panel-next').addEventListener('click', (e) => {
      // Fine tutorial: si torna all'elenco senza ricaricare la pagina, che
      // interromperebbe la musica (il browser non la fa ripartire da solo).
      if (tutorialCompletedShown) { exitTutorial(); return; }
      // Disabilitato fino al passo successivo: un doppio click salterebbe un passo.
      e.currentTarget.disabled = true;
      sendAction('tutorial_next', {});
    });
    ['tutorial-panel-prev', 'card-anatomy-prev'].forEach(id => {
      document.getElementById(id).addEventListener('click', (e) => {
        e.currentTarget.disabled = true;
        sendAction('tutorial_prev', {});
      });
    });
    document.getElementById('card-anatomy-exit').addEventListener('click', exitTutorial);
    document.getElementById('card-anatomy-next').addEventListener('click', (e) => {
      // Disabilitato fino al passo successivo: un doppio click salterebbe un passo.
      e.currentTarget.disabled = true;
      sendAction('tutorial_next', {});
    });

    // Sfida un Bot
    document.getElementById('btn-mode-single').addEventListener('click', () => Renderer.showScreen('bot-difficulty'));
    document.getElementById('btn-mode-multi').addEventListener('click', () => Renderer.showScreen('multiplayer'));
    document.getElementById('btn-multiplayer-back').addEventListener('click', () => Renderer.showScreen('lobby'));
    document.getElementById('btn-waiting-leave').addEventListener('click', leaveWaitingRoom);
    document.getElementById('btn-invite-link').addEventListener('click', copyInviteLink);
    document.getElementById('btn-bot-difficulty-back').addEventListener('click', () => Renderer.showScreen('lobby'));
    document.querySelectorAll('.bot-count-btn').forEach(btn => {
      btn.addEventListener('click', () => selectBotCount(parseInt(btn.dataset.bots, 10)));
    });
    document.querySelectorAll('.difficulty-card').forEach(card => {
      card.addEventListener('click', () => startPracticeGame(card.dataset.difficulty));
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
      const res = await api('/practice/start', { player_name: 'Giocatore', difficulty, num_bots: practiceBotCount });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      gameId = res.game_id;
      isCreator = false;
      isTutorial = false;
      enterGame(res.state);
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Tutorial — elenco e avvio
  // ---------------------------------------------------------------------------

  async function openTutorialList() {
    try {
      if (!tutorialsMeta.length) {
        const res = await apiFetch('/tutorials');
        tutorialsMeta = res.tutorials || [];
      }
      renderTutorialListGrid();
      Renderer.showScreen('tutorial-list');
    } catch (e) {
      Renderer.toast('Impossibile caricare i tutorial', 'error');
    }
  }

  function renderTutorialListGrid() {
    const grid = document.getElementById('tutorial-list-grid');
    grid.innerHTML = '';
    tutorialsMeta.forEach(t => {
      const card = document.createElement('div');
      card.className = 'tutorial-card';
      card.innerHTML = `
        <div class="tutorial-card-title">${t.title}</div>
        <div class="tutorial-card-desc">${t.description}</div>
        <div class="tutorial-card-steps">${t.step_count} passi</div>
      `;
      card.addEventListener('click', () => startTutorial(t.id));
      grid.appendChild(card);
    });
  }

  async function startTutorial(tutorialId) {
    try {
      if (!tutorialStepsCache[tutorialId]) {
        const full = await apiFetch(`/tutorials/${tutorialId}`);
        tutorialStepsCache[tutorialId] = full.steps || [];
      }
      const res = await api('/tutorial/start', { tutorial_id: tutorialId, player_name: 'Giocatore' });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      gameId = res.game_id;
      isTutorial = true;
      tutorialCompletedShown = false;
      enterGame(res.state);
      // Nel tutorial l'abbandono normale non ha senso (c'è il "Manichino" come
      // avversario fittizio): nascondi il pulsante "Esci" della testata.
      document.getElementById('btn-abandon').classList.add('hidden');
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

  // Chiude modali e azzera le interazioni in attesa: uscendo da una partita
  // (o da un tutorial) non devono sopravvivere nella partita successiva.
  function _clearPendingUI() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-confirm').onclick = null;
    document.getElementById('modal-cancel').onclick = null;
    recastPending = null;
  }

  function exitTutorial() {
    WS.disconnect();
    stopLocalTimer();
    _clearPendingUI();
    hideTutorialStep();
    hideCardAnatomy();
    document.getElementById('btn-abandon').classList.remove('hidden');
    leavingGame = false;
    selectedCard = null;
    actionMode = null;
    wallsSelected = [];
    currentState = null;
    gameId = null;
    sessionToken = null;
    myPlayerId = null;
    isTutorial = false;
    Renderer.showScreen('tutorial-list');
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
    const btn = document.getElementById(id);
    btn.classList.toggle('hidden', !canGoBack);
    btn.disabled = false;
  }

  function showTutorialStep(step, idx, steps, canGoBack) {
    const panel = document.getElementById('tutorial-panel');
    document.getElementById('tutorial-panel-progress').textContent = `Passo ${idx + 1} di ${steps.length}`;
    document.getElementById('tutorial-panel-title').textContent = step.title || '';
    document.getElementById('tutorial-panel-text').textContent = step.text || '';
    const nextBtn = document.getElementById('tutorial-panel-next');
    nextBtn.textContent = 'Avanti →';
    nextBtn.classList.toggle('hidden', !!step.requires_action);
    nextBtn.disabled = false;
    document.getElementById('tutorial-panel-exit').classList.remove('hidden');
    document.getElementById('tutorial-panel-waiting').classList.toggle('hidden', !step.requires_action);
    _setTutorialBackButton('tutorial-panel-prev', canGoBack);
    panel.classList.remove('hidden');
    Spotlight.show(step.highlight || [], panel);
  }

  // Fine tutorial: stesso pannello dei passi, centrato a schermo spento, con
  // un solo pulsante per tornare all'elenco (e il nome del tutorial successivo).
  function showTutorialCompleted(tutorialId) {
    const idx = tutorialsMeta.findIndex(t => t.id === tutorialId);
    const current = tutorialsMeta[idx];
    const next = idx >= 0 ? tutorialsMeta[idx + 1] : null;
    document.getElementById('tutorial-panel-progress').textContent = current ? current.title : '';
    document.getElementById('tutorial-panel-title').textContent = 'Tutorial completato!';
    document.getElementById('tutorial-panel-text').textContent = next
      ? `Torna all'elenco per provare il prossimo: «${next.title}».`
      : (idx >= 0 ? 'Hai completato tutti i tutorial: sei pronto per una vera partita.'
                  : 'Torna all\'elenco per provarne un altro.');
    const nextBtn = document.getElementById('tutorial-panel-next');
    nextBtn.textContent = 'Torna all\'elenco →';
    nextBtn.classList.remove('hidden');
    nextBtn.disabled = false;
    ['tutorial-panel-exit', 'tutorial-panel-prev', 'tutorial-panel-waiting']
      .forEach(id => document.getElementById(id).classList.add('hidden'));
    const panel = document.getElementById('tutorial-panel');
    panel.classList.remove('hidden');
    Spotlight.show([], panel);
  }

  function hideTutorialStep() {
    Spotlight.hide();
    document.getElementById('tutorial-panel').classList.add('hidden');
  }

  // Passi con card_focus (tutorial "Anatomia di una Carta"): la carta appare a
  // schermo intero e il riquadro evidenzia la sezione spiegata. rect è in
  // percentuale della carta ([x, y, w, h]); null = carta intera, niente riquadro.
  function showCardAnatomy(step, idx, steps, canGoBack) {
    const focus = step.card_focus;
    // Precarica le altre carte del tutorial, così il cambio carta non sfarfalla.
    steps.forEach(s => {
      if (s.card_focus) new window.Image().src = `/card_images/full/${s.card_focus.card}.png`;
    });
    const img = document.getElementById('card-anatomy-img');
    const src = `/card_images/full/${focus.card}.png`;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);

    const box = document.getElementById('card-anatomy-focus');
    if (focus.rect) {
      const [x, y, w, h] = focus.rect;
      Object.assign(box.style, { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` });
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }

    document.getElementById('card-anatomy-progress').textContent = `Passo ${idx + 1} di ${steps.length}`;
    document.getElementById('card-anatomy-title').textContent = step.title || '';
    document.getElementById('card-anatomy-text').textContent = step.text || '';
    document.getElementById('card-anatomy-next').disabled = false;
    _setTutorialBackButton('card-anatomy-prev', canGoBack);
    document.getElementById('card-anatomy-overlay').classList.remove('hidden');
  }

  function hideCardAnatomy() {
    document.getElementById('card-anatomy-overlay').classList.add('hidden');
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
    if (!catalogBuilt) buildCatalogGrid();
    Renderer.showScreen('catalog');
  }

  function buildCatalogGrid() {
    const grid = document.getElementById('catalog-grid');
    grid.innerHTML = '';
    catalogList = [];

    CATALOG_SECTIONS.forEach(section => {
      const defs = Object.values(cardDefs).filter(c => c.type === section.type);
      if (!defs.length) return;

      const box = document.createElement('div');
      box.className = 'catalog-section';

      const header = document.createElement('div');
      header.className = 'catalog-section-title';
      header.textContent = section.label;
      box.appendChild(header);

      const row = document.createElement('div');
      row.className = 'catalog-cards';
      defs.forEach(def => {
        const idx = catalogList.length;
        catalogList.push(def);

        const cell = document.createElement('div');
        cell.className = 'catalog-card';
        const img = document.createElement('img');
        // Nella griglia basta l'anteprima; la carta ingrandita usa il PNG grande
        img.src = CardArt.previewUrl(def.id);
        img.alt = def.name;
        img.loading = 'lazy';
        img.draggable = false;
        // Senza anteprima si ripiega sul PNG; senza nemmeno quello, una tessera col nome
        img.onerror = () => {
          if (!img.dataset.fallback) {
            img.dataset.fallback = '1';
            img.src = `/card_images/full/${def.id}.png`;
            return;
          }
          cell.innerHTML = `<div class="catalog-card-fallback">${def.name}</div>`;
        };
        cell.appendChild(img);
        cell.addEventListener('click', () => showCatalogCard(idx));
        row.appendChild(cell);
      });
      box.appendChild(row);
      grid.appendChild(box);
    });

    catalogBuilt = true;
  }

  function showCatalogCard(idx) {
    const def = catalogList[idx];
    if (!def) return;
    const navOptions = {
      onPrev: idx > 0 ? () => showCatalogCard(idx - 1) : null,
      onNext: idx < catalogList.length - 1 ? () => showCatalogCard(idx + 1) : null,
    };
    Renderer.showCardDetail(
      def.name,
      cardDetailBodyHTML(def, def.id),
      null, null, null, [],
      navOptions,
      def.id,
    );
  }

  async function onCreateLobby() {
    const name = document.getElementById('create-name').value.trim();
    const rawTimer = parseInt(document.getElementById('create-timer').value, 10);
    const timer = Number.isFinite(rawTimer) && rawTimer > 0 ? rawTimer : 0;
    if (!name) { Renderer.toast('Inserisci il tuo nome', 'error'); return; }
    PlayerName.set(name);
    try {
      const res = await api('/lobby/create', { player_name: name, turn_timer: timer });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      lobbyCode = res.lobby_code;
      isCreator = true;
      isTutorial = false;
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
    PlayerName.set(name);
    try {
      const res = await api('/lobby/join', { lobby_code: code, player_name: name });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      lobbyCode = res.lobby_code;
      isCreator = false;
      isTutorial = false;
      showWaitingRoom(res.lobby);
      connectWS();
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

  function showWaitingRoom(lobby) {
    lobbyCode = lobby.lobby_code;
    document.getElementById('lobby-code-text').textContent = lobby.lobby_code;
    updateWaitingRoom(lobby);
    document.getElementById('waiting-status').textContent = '';
    Renderer.showScreen('waiting');
  }

  // Uscita dalla sala d'attesa: si torna a Crea / Unisciti. Se esce il
  // creatore, il server passa il ruolo al primo umano rimasto.
  function leaveWaitingRoom() {
    const code = lobbyCode, token = sessionToken;
    stopLobbyPolling();
    lobbyCode = null;
    sessionToken = null;
    myPlayerId = null;
    isCreator = false;
    Renderer.showScreen('multiplayer');
    if (code && token) api('/lobby/leave', { lobby_code: code, session_token: token }).catch(() => {});
  }

  let waitingPlayers = [];

  function updateWaitingRoom(lobby) {
    // Il creatore può cambiare: se esce, il ruolo passa al primo umano rimasto
    isCreator = lobby.creator_id === myPlayerId;
    document.getElementById('btn-start').style.display = isCreator ? 'block' : 'none';
    document.getElementById('waiting-bot-controls').style.display = isCreator ? 'flex' : 'none';
    waitingPlayers = lobby.players;
    updateWaitingPlayers(lobby.players);
    document.getElementById('btn-start').disabled = !lobby.can_start;
    document.getElementById('btn-add-bot').disabled = lobby.players.length >= 4;
    const diff = document.getElementById('waiting-bot-difficulty');
    if (document.activeElement !== diff) diff.value = lobby.bot_difficulty || 'normal';
  }

  // Ordine dei posti al tavolo: i Bastioni confinano con quelli dei vicini,
  // quindi il creatore può riordinare i giocatori (e rimuovere i Bot).
  function updateWaitingPlayers(players) {
    const list = document.getElementById('waiting-players');
    list.innerHTML = '';
    players.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'player-list-item';
      const tag = p.is_bot ? 'Bot' : (p.player_id === myPlayerId ? 'tu' : '');
      item.innerHTML = `<span class="seat">${i + 1}.</span>`
        + `<span class="dot${p.is_bot ? ' bot' : ''}"></span>`
        + `<span class="name"></span>`
        + (tag ? `<span class="tag">${tag}</span>` : '');
      item.querySelector('.name').textContent = p.name;
      if (isCreator) {
        const btn = (label, title, disabled, onClick) => {
          const b = document.createElement('button');
          b.className = 'seat-btn';
          b.textContent = label;
          b.title = title;
          b.disabled = disabled;
          b.addEventListener('click', onClick);
          item.appendChild(b);
        };
        btn('▲', 'Sposta su', i === 0, () => moveWaitingPlayer(i, -1));
        btn('▼', 'Sposta giù', i === players.length - 1, () => moveWaitingPlayer(i, 1));
        if (p.is_bot) {
          btn('✕', 'Rimuovi Bot', false, () => editLobby('/lobby/remove_bot', { bot_id: p.player_id }));
        }
      }
      list.appendChild(item);
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
      Renderer.toast(e.message, 'error');
    }
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
        if (!lobbyPollTimer) return;  // uscito dalla sala durante la richiesta
        updateWaitingRoom(lobby);
        if (lobby.game_id && !gameId) {
          stopLobbyPolling();
          gameId = lobby.game_id;
          const gameState = await apiFetch(`/game/${lobby.game_id}?session_token=${sessionToken}`);
          enterGame(gameState);
        }
      } catch (e) {
        // Sala chiusa (es. riavvio del server): inutile restare in attesa
        if (e.message === 'Lobby non trovata' && lobbyPollTimer) {
          leaveWaitingRoom();
          Renderer.toast("La sala d'attesa non esiste più", 'error');
        }
      }
    }, 2000);
  }

  function stopLobbyPolling() { clearInterval(lobbyPollTimer); lobbyPollTimer = null; }

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
    WS.on('player_connected', (msg) => {
      if (msg.player_id === myPlayerId || !currentState) return;
      Renderer.toast(`${_playerName(msg.player_id)} è di nuovo al tavolo`, 'info');
    });
    WS.on('player_disconnected', (msg) => {
      if (msg.player_id === myPlayerId || !currentState || currentState.winner_id) return;
      Renderer.toast(`${_playerName(msg.player_id)} si è disconnesso`, '');
    });
    WS.on('rematch_offer', (msg) => {
      rematchOffer = msg;
      if (currentState && currentState.winner_id) updateRematchUI(currentState);
    });
    WS.on('error', (msg) => {
      Renderer.toast(msg.message || 'Errore', 'error');
      // Se il blocco è dovuto a un'interazione Biblioteca in attesa, mostra il modale
      // (una ricerca in sospeso ha la precedenza: in quel caso si riapre quella)
      if (msg.message && msg.message.includes('Biblioteca') && currentState) {
        const mySearch = currentState.pending_search && currentState.pending_search.player_id === myPlayerId && currentState.search_deck;
        const myPending = _myPendingInteraction(currentState);
        if (mySearch) _showSearchModal(currentState.search_deck, currentState.pending_search);
        else if (myPending) _showBibliotecaModal(myPending, currentState);
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

  function onStateUpdate(state, action, result) {
    if (leavingGame) return;
    const prevTurnPlayer = lastTurnPlayer;
    const prevState = currentState && currentState.game_id === state.game_id ? currentState : null;
    currentState = state;
    lastTurnPlayer = state.current_player_id;
    // Le carte si spostano con una transizione invece di ricomparire di colpo
    const table = document.getElementById('game-table');
    const before = Motion.snapshot(table);
    Renderer.render(state, myPlayerId);
    Motion.play(before, table, _motionOptions(state, prevState));
    _animateOpponents(prevState, state);

    if (prevTurnPlayer !== state.current_player_id && !state.winner_id) {
      _showTurnBanner(state);
    }

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

      // Eracle: distruggi una costruzione avversaria
      if (action === 'battle' && result.eracle_destroy_triggered && result.eracle_targets && result.eracle_targets.length > 0
          && state.current_player_id === myPlayerId) {
        const defender = state.players.find(p => p.id === result.defender_id);
        const targetIds = new Set(result.eracle_targets.map(b => b.instance_id));
        Renderer.showBuildingPicker(state, {
          title: 'Orda di Eracle — distruggi una Costruzione',
          subtitle: 'Hai inflitto almeno 3 Danni: scegli una Costruzione del difensore da distruggere.',
          players: defender ? [defender] : [],
          filter: (b) => targetIds.has(b.instance_id),
          onPick: (b) => sendAction('eracle_destroy', {
            building_instance_id: b.instance_id,
            target_player_id: result.defender_id,
          }),
        });
        _renderChronicle(state);
        return; // non chiudere il modale; la UI si aggiornerà dopo eracle_destroy
      }

    }

    // Cronaca: le voci nuove arrivano già pronte dal server
    _renderChronicle(state);
    if (action === 'leave_game') {
      (state.recent_events || []).forEach(ev => {
        if (ev.type === 'abandon' && ev.player_id !== myPlayerId) {
          Renderer.toast(`${_playerName(ev.player_id)} ha abbandonato la partita`, 'error');
        }
      });
    }

    if (state.winner_id) {
      setTimeout(() => showGameOver(state), 800);
    }

    // Chiudi eventuale modale aperta e aggiorna la UI azioni
    // (non chiudere se c'è una ricerca o interazione biblioteca in attesa per questo giocatore)
    const myPendingInteraction = _myPendingInteraction(state);
    const myPlayer = state.players && state.players.find(p => p.id === myPlayerId);
    const myPendingVelocemento = myPlayer && myPlayer.pending_velocemento_buildings && myPlayer.pending_velocemento_buildings.length > 0;
    if (!(state.pending_search && state.pending_search.player_id === myPlayerId) && !myPendingInteraction && !myPendingVelocemento) {
      document.getElementById('modal-overlay').classList.add('hidden');
    }
    _refreshActionUI();

    // Mostra il modale di ricerca se siamo noi a dover scegliere. La ricerca ha la
    // precedenza sulle interazioni (il server le accetta solo dopo): quelle si
    // mostrano allo state_update successivo alla risoluzione della ricerca.
    const mySearch = state.pending_search && state.pending_search.player_id === myPlayerId && state.search_deck;
    if (mySearch) {
      _showSearchModal(state.search_deck, state.pending_search);
    }

    // Mostra il modale di interazione in attesa (Biblioteca, Cardo, Agilpesca, Magiscudo, Malcomune)
    if (myPendingInteraction && !mySearch) {
      if (myPendingInteraction.type === 'cardo_move') {
        _showCardoMoveModal(state);
      } else if (myPendingInteraction.type === 'agilpesca_discard') {
        _showAgilpescaDiscardModal(state);
      } else if (myPendingInteraction.type === 'magiscudo_counter') {
        _showMagiscudoCounterModal(myPendingInteraction, state);
      } else if (myPendingInteraction.type === 'malcomune_discard') {
        _showMalcomuneDiscardModal(myPendingInteraction, state);
      } else if (myPendingInteraction.type === 'evelyn_recast') {
        _showEvelynRecastModal(myPendingInteraction);
      } else {
        _showBibliotecaModal(myPendingInteraction, state);
      }
    }

    // Mostra il modale di scelta Velocemento se siamo noi a dover scegliere
    if (myPendingVelocemento) {
      _showVelocementoChoiceModal(myPlayer.pending_velocemento_buildings);
    }

    // Tutorial: aggiornata per ultima, così il suo eventuale modale di
    // completamento non viene chiuso dalla pulizia generica di modal-overlay qui sopra.
    if (isTutorial) updateTutorialUI(state);
  }

  // ---------------------------------------------------------------------------
  // Gioco
  // ---------------------------------------------------------------------------

  function enterGame(state) {
    stopLobbyPolling();
    gameId = gameId || state.game_id;
    currentState = state;
    lastTurnPlayer = state.current_player_id;
    rematchOffer = null;
    connectGameWS();
    Renderer.showScreen('game');
    Renderer.render(state, myPlayerId);
    chronicleSeenId = Chronicle.lastId(state);
    Renderer.renderChronicle(state, myPlayerId, cardDefs);
    rememberGame(state);
    CardArt.preload(Object.keys(cardDefs));
    _refreshActionUI();
    // Mostra modali in attesa (es. riconnessione)
    const myPending = _myPendingInteraction(state);
    if (myPending) {
      if (myPending.type === 'cardo_move') _showCardoMoveModal(state);
      else if (myPending.type === 'agilpesca_discard') _showAgilpescaDiscardModal(state);
      else if (myPending.type === 'magiscudo_counter') _showMagiscudoCounterModal(myPending, state);
      else if (myPending.type === 'malcomune_discard') _showMalcomuneDiscardModal(myPending, state);
      else if (myPending.type === 'evelyn_recast') _showEvelynRecastModal(myPending);
      else _showBibliotecaModal(myPending, state);
    }
    const myP = state.players && state.players.find(p => p.id === myPlayerId);
    if (myP && myP.pending_velocemento_buildings && myP.pending_velocemento_buildings.length > 0) {
      _showVelocementoChoiceModal(myP.pending_velocemento_buildings);
    }
    // Tutorial: aggiornata per ultima (vedi nota in onStateUpdate).
    if (isTutorial) updateTutorialUI(state);
  }

  // Da dove entrano e dove finiscono le carte nelle transizioni (motion.js)
  const _MY_REGION_EL = {
    wall_left: 'my-bastion-left', wall_right: 'my-bastion-right',
    bastion_left: 'my-bastion-left', bastion_right: 'my-bastion-right',
    vanguard: 'my-vanguard', village: 'my-village', life: 'my-life-deck',
  };

  function _motionOptions(state, prevState) {
    const before = prevState ? _fieldIndex(prevState) : new Map();
    const after = _fieldIndex(state);
    return {
      // Carte pescate: arrivano dal mazzo. Carte prese a un avversario: dal suo tassello.
      sourceFor: (iid, el) => {
        if (el.closest('#hand-cards')) return document.getElementById('hdr-deck');
        const was = before.get(iid);
        return was && was.pid !== myPlayerId ? _oppZoneEl(was.pid, was.zone) : null;
      },
      // Carte sparite dalla vista: verso il Bastione se sono diventate Muri, verso
      // le Vite se sono diventate una Vita, verso il tassello di un avversario se
      // sono passate a lui; altrimenti si dissolvono.
      targetFor: (iid) => {
        const id = _MY_REGION_EL[Motion.locate(state, myPlayerId, iid)];
        if (id) return document.getElementById(id);
        const now = after.get(iid);
        return now && now.pid !== myPlayerId ? _oppZoneEl(now.pid, now.zone) : null;
      },
      onLand: Motion.pulse,
    };
  }

  // Dove sta ogni Guerriero e Costruzione in campo: iid → { pid, zone, obj }
  function _fieldIndex(state) {
    const index = new Map();
    (state.players || []).forEach(p => {
      const f = p.field;
      if (!f) return;
      (f.vanguard || []).forEach(w => index.set(w.instance_id, { pid: p.id, zone: 'vanguard', obj: w }));
      ['left', 'right'].forEach(side => {
        ((f[`bastion_${side}`] || {}).warriors || []).forEach(w =>
          index.set(w.instance_id, { pid: p.id, zone: `bastion_${side}`, obj: w }));
      });
      ((f.village || {}).buildings || []).forEach(b => index.set(b.instance_id, { pid: p.id, zone: 'village', obj: b }));
    });
    return index;
  }

  // Tassello di una Regione di un avversario (renderer.js → _oppTile), o il
  // contatore della sua mano se `zone` è null
  function _oppZoneEl(pid, zone) {
    const field = document.querySelector(`.opponent-field[data-player-id="${pid}"]`);
    if (!field) return null;
    return field.querySelector(zone ? `.opp-tile[data-zone="${zone}"]` : '.opp-hand-count');
  }

  // Dimensione dei fantasmi: quella delle carte del mio campo
  function _ghostSize() {
    const css = getComputedStyle(document.documentElement);
    return {
      w: parseFloat(css.getPropertyValue('--card-w-field')) || 99,
      h: parseFloat(css.getPropertyValue('--card-h-field')) || 143,
    };
  }

  // Le carte degli avversari non sono disegnate sul tavolo (solo i tasselli
  // riassuntivi): quelle giocate volano dalla loro mano al tassello della Regione,
  // quelle spostate da un tassello all'altro, quelle scartate si dissolvono sul
  // tassello. I Muri, coperti, volano come dorsi verso il Bastione (o se ne vanno).
  // Le carte che passano dal mio campo a quello di un avversario (e viceversa)
  // le anima già Motion.play con sourceFor / targetFor.
  function _animateOpponents(prevState, state) {
    if (!prevState || Motion.reducedMotion()) return;
    const before = _fieldIndex(prevState);
    const after = _fieldIndex(state);
    const size = _ghostSize();
    let n = 0;
    const next = () => n++ * 90;

    after.forEach((now, iid) => {
      if (now.pid === myPlayerId) return;
      const was = before.get(iid);
      if (was && (was.pid === myPlayerId || (was.pid === now.pid && was.zone === now.zone))) return;
      const from = was ? _oppZoneEl(was.pid, was.zone) : _oppZoneEl(now.pid, null);
      Motion.travel(Renderer.motionCardNode(now.obj, now.zone), from, _oppZoneEl(now.pid, now.zone),
        { size, delay: next(), onLand: Motion.pulse });
    });
    before.forEach((was, iid) => {
      if (was.pid === myPlayerId || after.has(iid)) return;
      Motion.vanish(Renderer.motionCardNode(was.obj, was.zone), _oppZoneEl(was.pid, was.zone), { size, delay: next() });
    });

    state.players.forEach(p => {
      const old = p.id !== myPlayerId && prevState.players.find(x => x.id === p.id);
      if (!old) return;
      ['left', 'right'].forEach(side => {
        const zone = `bastion_${side}`;
        const diff = (p.field[zone].wall_count || 0) - (old.field[zone].wall_count || 0);
        for (let i = 0; i < Math.abs(diff); i++) {
          if (diff > 0) {
            Motion.travel(Renderer.motionBackNode(), _oppZoneEl(p.id, null), _oppZoneEl(p.id, zone),
              { size, delay: next(), onLand: Motion.pulse });
          } else {
            Motion.vanish(Renderer.motionBackNode(), _oppZoneEl(p.id, zone), { size, delay: next() });
          }
        }
      });
    });
  }

  function _playerName(pid) {
    const p = currentState && currentState.players.find(x => x.id === pid);
    return p ? p.name : pid;
  }

  // ---------------------------------------------------------------------------
  // Cronaca della partita
  // ---------------------------------------------------------------------------

  function _renderChronicle(state) {
    const fresh = new Set(Chronicle.newSince(chronicleSeenId, state).map(e => e.id));
    chronicleSeenId = Chronicle.lastId(state);
    Renderer.renderChronicle(state, myPlayerId, cardDefs, fresh);
  }

  function openChronicle(aboveOverlay = false) {
    if (!currentState) return;
    Renderer.openChroniclePanel(currentState, myPlayerId, cardDefs, aboveOverlay);
  }

  function toggleChronicle() {
    if (Renderer.isChroniclePanelOpen()) Renderer.closeChroniclePanel();
    else openChronicle();
  }

  function showCardInfo(baseId) {
    const def = cardDefs[baseId];
    if (!def) return;
    Renderer.showCardDetail(def.name, cardDetailBodyHTML(def, def.id), null, null, null, [], null, def.id);
  }

  // ---------------------------------------------------------------------------
  // Fine partita e rivincita
  // ---------------------------------------------------------------------------

  function showGameOver(state) {
    SavedGame.clear();
    stopLocalTimer();
    Renderer.closeChroniclePanel();
    Renderer.showGameOver(state);
    updateRematchUI(state);
  }

  function updateRematchUI(state) {
    const btn = document.getElementById('btn-rematch');
    const note = document.getElementById('gameover-rematch-note');
    const available = state.mode === 'practice' || state.mode === 'lobby';
    btn.classList.toggle('hidden', !available);
    btn.disabled = false;
    const invited = rematchOffer && rematchOffer.player_id !== myPlayerId;
    btn.textContent = invited ? 'Unisciti alla rivincita' : 'Rivincita';
    note.classList.toggle('hidden', !invited);
    if (invited) note.textContent = `${_playerName(rematchOffer.player_id)} propone la rivincita.`;
    else if (state.mode === 'lobby') {
      note.textContent = 'La rivincita apre una nuova sala d\'attesa con gli stessi posti: gli altri giocatori riceveranno l\'invito.';
      note.classList.remove('hidden');
    }
  }

  async function onRematchClick() {
    const btn = document.getElementById('btn-rematch');
    btn.disabled = true;
    try {
      const res = await api('/game/rematch', { game_id: gameId, session_token: sessionToken });
      // Si lascia la partita finita: da qui in poi conta solo la nuova
      WS.disconnect();
      _clearPendingUI();
      Renderer.closeChroniclePanel();
      rematchOffer = null;
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      isTutorial = false;
      if (res.mode === 'practice') {
        gameId = res.game_id;
        lobbyCode = null;
        isCreator = false;
        enterGame(res.state);
      } else {
        gameId = null;
        currentState = null;
        lobbyCode = res.lobby_code;
        isCreator = !!res.is_creator;
        showWaitingRoom(res.lobby);
        connectWS();
      }
    } catch (e) {
      btn.disabled = false;
      Renderer.toast(e.message, 'error');
    }
  }

  function _showTurnBanner(state) {
    const player = state.players.find(p => p.id === state.current_player_id);
    const banner = document.getElementById('turn-banner');
    clearTimeout(turnBannerTimer);
    banner.classList.add('hidden');
    void banner.offsetWidth;  // forza il replay dell'animazione
    document.getElementById('turn-banner-text').textContent = state.current_player_id === myPlayerId
      ? 'Il tuo turno'
      : `Il turno di ${player ? player.name : state.current_player_id}`;
    banner.classList.toggle('subtle', state.current_player_id !== myPlayerId);
    banner.classList.remove('hidden');
    turnBannerTimer = setTimeout(() => banner.classList.add('hidden'), 1950);
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

    const hide = id => document.getElementById(id).classList.add('hidden');
    const show = id => document.getElementById(id).classList.remove('hidden');

    hide('phase-bar');
    hide('action-banner');
    hide('btn-horde');
    hide('btn-next-phase');
    hide('btn-battle');
    hide('btn-end-turn');
    document.getElementById('action-hint').textContent = '';

    if (!currentState) return;
    const isMyTurn = currentState.current_player_id === myPlayerId;
    const player = currentState.players.find(p => p.id === myPlayerId);

    if (!isMyTurn) {
      const name = (currentState.players.find(p => p.id === currentState.current_player_id) || {}).name || '…';
      document.getElementById('action-hint').textContent = `In attesa di ${name}…`;
      return;
    }

    // Interazioni in attesa (Biblioteca, Cardo, Magiscudo): mostrano solo il modale, bloccano tutto
    const myPendingInteraction = _myPendingInteraction(currentState);
    if (myPendingInteraction) {
      if (myPendingInteraction.type === 'cardo_move') {
        document.getElementById('action-hint').textContent = '🛞 Cardo: scegli un Guerriero da spostare prima di pescare.';
        _showCardoMoveModal(currentState);
      } else if (myPendingInteraction.type === 'agilpesca_discard') {
        document.getElementById('action-hint').textContent = '🎣 Agilpesca: scegli una carta da scartare.';
        _showAgilpescaDiscardModal(currentState);
      } else if (myPendingInteraction.type === 'evelyn_recast') {
        document.getElementById('action-hint').textContent = '✨ Orda di Evelyn: rigioca la Magia o rinuncia.';
      } else if (myPendingInteraction.type !== 'magiscudo_counter') {
        document.getElementById('action-hint').textContent = '📚 Biblioteca: scegli una carta prima di continuare.';
        _showBibliotecaModal(myPendingInteraction, currentState);
      }
      return;
    }

    // Magiscudo counter in attesa da parte di un avversario (blocca il giocatore attivo)
    const magiscudoPending = currentState.pending_interactions &&
      currentState.pending_interactions.find(i => i.type === 'magiscudo_counter');
    if (magiscudoPending) {
      const defName = (currentState.players.find(p => p.id === magiscudoPending.player_id) || {}).name || '…';
      document.getElementById('action-hint').textContent = `🛡 In attesa della risposta di ${defName} (Magiscudo)…`;
      hide('action-banner');
      return;
    }

    const malcomunePending = currentState.pending_interactions &&
      currentState.pending_interactions.find(i => i.type === 'malcomune_discard');
    if (malcomunePending) {
      const defName = (currentState.players.find(p => p.id === malcomunePending.player_id) || {}).name || '…';
      document.getElementById('action-hint').textContent = `☠ In attesa della scelta di ${defName} (Malcomune)…`;
      hide('action-banner');
      return;
    }

    const phase = currentState.phase;

    // Aggiorna indicatore fase
    show('phase-bar');
    ['action', 'schieramento', 'battaglia'].forEach((p, i) => {
      const el = document.getElementById(`pstep-${p}`);
      if (p === phase) { el.className = 'phase-step active'; }
      else if (['action', 'schieramento', 'battaglia'].indexOf(p) < ['action', 'schieramento', 'battaglia'].indexOf(phase)) {
        el.className = 'phase-step done';
      } else {
        el.className = 'phase-step';
      }
    });

    if (phase === 'action') {
      if (player && (player.actions_remaining > 0 || _hasFreeActionSpells(player))) {
        _showBanner(player);
      } else {
        document.getElementById('action-hint').textContent = 'Nessuna azione rimasta.';
      }
      show('btn-next-phase');
      document.getElementById('btn-next-phase').textContent = 'Schieramento →';

    } else if (phase === 'schieramento') {
      document.getElementById('action-hint').textContent = 'Sposta i Guerrieri e attiva le Orde.';
      const hasHorde = player && player.available_hordes && player.available_hordes.length > 0;
      if (hasHorde) show('btn-horde');
      show('btn-next-phase');
      document.getElementById('btn-next-phase').textContent = 'Battaglia →';

    } else if (phase === 'battaglia') {
      document.getElementById('action-hint').textContent = 'Attacca un avversario o termina il turno.';
      show('btn-battle');
      show('btn-end-turn');
    }
  }

  // ---------------------------------------------------------------------------
  // Orda
  // ---------------------------------------------------------------------------

  function onHordeClick() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    const player = currentState.players.find(p => p.id === myPlayerId);
    if (!player) return;

    const hordes = player.available_hordes || [];
    if (hordes.length === 0) {
      Renderer.toast('Nessuna Orda disponibile', 'error');
      return;
    }

    const zoneInfo = {
      vanguard:      { icon: '⚔︎', name: 'Avanscoperta' },
      bastion_left:  { icon: '🛡︎', name: 'Bastione Sinistro' },
      bastion_right: { icon: '🛡︎', name: 'Bastione Destro' },
    };
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    // Un gruppo per Orda (Regione + Specie). Le carte già attive per il proprio
    // gruppo non vanno riproposte (nulla da fare riselezionandole); le altre carte
    // dello stesso gruppo permettono di cambiare l'effetto Orda attivo.
    Renderer.showPicker({
      title: 'Attiva un effetto Orda',
      subtitle: 'Un\'Orda resta attiva finché non si divide o scegli un altro effetto.',
      groups: [{
        zones: hordes.map(h => ({
          icon: (zoneInfo[h.zone] || {}).icon,
          label: `${(zoneInfo[h.zone] || {}).name || h.zone} — ${cap(h.species)}`,
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

  function _showBanner(player) {
    const maxActions = (player.name === 'Test' || player.name === 'Test2') ? 5 : 2;
    const actNum = maxActions - player.actions_remaining + 1;
    // Azioni finite: con l'Orda di Madeleine restano giocabili gli Incantesimi a costo 1
    const noActions = player.actions_remaining <= 0;
    document.getElementById('banner-turn-label').textContent = noActions
      ? 'Azioni esaurite · Incantesimi a costo 1 gratuiti'
      : `Azione ${actNum} · ${player.actions_remaining} rimast${player.actions_remaining === 1 ? 'a' : 'e'}`;

    const hasCards = player.hand && player.hand.length > 0;
    const hasIncomplete = (player.field.village.buildings || []).some(b => !b.completed);

    document.getElementById('banner-btn-play').disabled     = !hasCards;
    document.getElementById('banner-btn-complete').disabled = noActions || !hasIncomplete;
    document.getElementById('banner-btn-wall').disabled     = noActions || !hasCards;

    document.getElementById('action-banner').classList.remove('hidden');
    document.getElementById('action-hint').textContent = '';
  }

  function enterPlayCardMode() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    actionMode = 'play_card';
    document.getElementById('action-banner').classList.add('hidden');
    document.getElementById('btn-cancel-action').classList.remove('hidden');
    document.getElementById('action-hint').textContent = 'Clicca una carta dalla mano.';
    _updatePlayableMarkings();
  }

  // Senza Azioni restano "accese" solo le carte giocabili (Incantesimi a costo 1 con
  // l'Orda di Madeleine, carta eterea)
  function _updatePlayableMarkings() {
    const player = currentState && currentState.players.find(p => p.id === myPlayerId);
    const dim = actionMode === 'play_card' && player && player.actions_remaining <= 0;
    document.querySelectorAll('#hand-cards .card').forEach(card => {
      const iid = card.dataset.instanceId;
      const playable = !dim || player.ethereal_card === iid || _isFreeActionSpell(player, getCardDef(iid));
      card.classList.toggle('unplayable', !playable);
    });
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

    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    const activeEffects = (myPlayer && myPlayer.active_effects) || [];
    const reinholdDiscount = activeEffects.find(e => e.type === 'reinhold_sorgiva_discount');

    Renderer.showBuildingPicker(currentState, {
      title: 'Completa una Costruzione',
      players: [myPlayer],
      filter: (b) => !b.completed,
      meta: (b) => {
        if (myPlayer.ethereal_complete === b.instance_id) return 'Gratis (Velocemento)';
        const def = getCardDef(b.instance_id);
        const baseCost = def ? def.completion_cost : null;
        const discount = (reinholdDiscount && b.base_card_id === 'sorgiva') ? reinholdDiscount.discount : 0;
        const effectiveCost = baseCost !== null ? Math.max(0, baseCost - discount) : '?';
        return `${discount > 0 ? `${baseCost}→` : ''}${effectiveCost} Mana`;
      },
      note: (b) => {
        const def = getCardDef(b.instance_id);
        return def && def.complete_effect ? def.complete_effect.replace(/^&\s*/, '') : null;
      },
      onPick: (b) => sendAction('complete_building', { building_instance_id: b.instance_id }),
    });
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
    document.querySelectorAll('#hand-cards .card.unplayable').forEach(c => c.classList.remove('unplayable'));

    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    const player = currentState.players.find(p => p.id === myPlayerId);
    if (player && currentState.phase === 'action' &&
        (player.actions_remaining > 0 || _hasFreeActionSpells(player))) _showBanner(player);
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
    // Solo prima della Battaglia (fasi Azioni e Schieramento)
    if (!['action', 'schieramento'].includes(currentState.phase)) return false;
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
    const enemies = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);
    const hasTarget = (own) => enemies.some(en => _getAllWarriors(en).some(
      ew => own.att > ew.att || own.git > ew.git || own.dif > ew.dif));

    Renderer.showWarriorPicker(currentState, {
      title: 'Arena — scegli il tuo campione',
      subtitle: 'Verrà scartato insieme al Guerriero avversario che sconfigge.',
      players: [player],
      filter: (w) => hasTarget(w),
      empty: 'Nessun tuo Guerriero ha un bersaglio valido.',
      onPick: (ownW) => {
        Renderer.showWarriorPicker(currentState, {
          title: `Arena — chi sconfigge ${ownW.name}?`,
          subtitle: `Il tuo campione: ATT ${ownW.att} · GIT ${ownW.git} · DIF ${ownW.dif}. Basta una Caratteristica più bassa.`,
          players: enemies,
          filter: (ew) => ownW.att > ew.att || ownW.git > ew.git || ownW.dif > ew.dif,
          note: (ew) => 'Più debole in ' + ['att', 'git', 'dif']
            .filter(k => ew[k] < ownW[k]).map(k => k.toUpperCase()).join(', '),
          empty: 'Nessun bersaglio valido per questo Guerriero.',
          onPick: (ew, p) => sendAction('arena_activate', {
            building_instance_id: buildingInstanceId,
            own_warrior_iid: ownW.instance_id,
            target_warrior_iid: ew.instance_id,
            target_player_id: p.id,
          }),
        });
      },
    });
  }

  // Costruisce il corpo HTML del dettaglio di una carta.
  // fieldWarrior/fieldBuilding sono opzionali (contesto di gioco); senza, mostra i valori base.
  function cardDetailBodyHTML(def, instanceId, fieldWarrior = null, fieldBuilding = null) {
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    let bodyHTML = '';

    if (def && def.type === 'warrior') {
      const att = fieldWarrior ? fieldWarrior.att : def.att;
      const git = fieldWarrior ? fieldWarrior.git : def.git;
      const dif = fieldWarrior ? fieldWarrior.dif : def.dif;

      bodyHTML += `<div class="detail-meta">
        <span class="species-${def.species}">${cap(def.species)}</span>
        ${def.school ? `· <span>${cap(def.school)}</span>` : ''}
        · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}
        · 💎${def.cost} Mana
      </div>
      <div class="detail-stats">
        <span class="stat-att">🗡️ ATT ${att}</span>
        <span class="stat-git">🏹 GIT ${git}</span>
        <span class="stat-dif">🛡️ DIF ${dif}</span>
      </div>`;
      if (def.horde_effect) {
        bodyHTML += `<div class="detail-section"><strong>Effetto Orda:</strong><br>${def.horde_effect}</div>`;
      }
      if (def.evolves_from) bodyHTML += `<div class="detail-dim">Evolve da: ${cardDefs[def.evolves_from]?.name || def.evolves_from}</div>`;
      if (def.evolves_into) bodyHTML += `<div class="detail-dim">Evolve in: ${cardDefs[def.evolves_into]?.name || def.evolves_into}</div>`;

    } else if (def && def.type === 'spell') {
      bodyHTML += `<div class="detail-meta">
        <span class="school-${def.school}">${cap(def.school)}</span> · Magia · 🔮${def.cost} Maghe
      </div>
      <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
      if (def.prodigy_effect) {
        bodyHTML += `<div class="detail-section"><strong>Prodigio:</strong><br>${def.prodigy_effect}</div>`;
      }

    } else if (def && def.type === 'building') {
      const completionStatus = fieldBuilding
        ? (fieldBuilding.completed ? ' · <span style="color:var(--gold)">✓ Completata</span>' : ' · <span style="color:var(--text-dim)">Incompleta</span>')
        : '';
      const baseLabel = (fieldBuilding && !fieldBuilding.completed) ? 'Effetto Base <span style="color:var(--green-light)">(attivo)</span>'
        : (fieldBuilding && fieldBuilding.completed) ? 'Effetto Base <span style="color:var(--text-dim)">(non attivo)</span>'
        : 'Effetto Base';
      const completeLabel = (fieldBuilding && fieldBuilding.completed) ? 'Effetto Completo <span style="color:var(--green-light)">(attivo)</span>'
        : (fieldBuilding && !fieldBuilding.completed) ? 'Effetto Completo <span style="color:var(--text-dim)">(non attivo)</span>'
        : 'Effetto Completo';
      const myActiveEffects = currentState ? ((currentState.players.find(p => p.id === myPlayerId) || {}).active_effects || []) : [];
      const reinholdDiscount = myActiveEffects.find(e => e.type === 'reinhold_sorgiva_discount');
      const rawCompletionCost = def.completion_cost;
      const effectiveCompletionCost = (reinholdDiscount && def.id === 'sorgiva') ? Math.max(0, rawCompletionCost - reinholdDiscount.discount) : rawCompletionCost;
      const completionCostLabel = (effectiveCompletionCost !== rawCompletionCost) ? `${rawCompletionCost}→${effectiveCompletionCost}` : `${rawCompletionCost}`;
      bodyHTML += `<div class="detail-meta">Costruzione · 💎${def.cost} Mana · 🏗️${completionCostLabel} Mana${completionStatus}</div>
      <div class="detail-section"><strong>${baseLabel}:</strong><br>${def.base_effect || '—'}</div>`;
      if (def.complete_effect) {
        bodyHTML += `<div class="detail-section"><strong>${completeLabel}:</strong><br>${def.complete_effect}</div>`;
      }

    } else {
      bodyHTML = `<div class="detail-dim">${instanceId}</div>`;
    }

    return bodyHTML;
  }

  // Costruisce e mostra il pannello di dettaglio per qualsiasi carta
  function showCardDetail(instanceId, source) {
    const def = getCardDef(instanceId);

    // Recupera dati contestuali dallo stato
    let fieldWarrior = null;
    let fieldWarriorOwnerId = null;
    let fieldBuilding = null;
    if (currentState) {
      for (const player of currentState.players) {
        const w = [
          ...(player.field.vanguard || []),
          ...(player.field.bastion_left.warriors || []),
          ...(player.field.bastion_right.warriors || []),
        ].find(w => w.instance_id === instanceId);
        if (w) { fieldWarrior = w; fieldWarriorOwnerId = player.id; break; }

        const b = (player.field.village.buildings || []).find(b => b.instance_id === instanceId);
        if (b) { fieldBuilding = b; break; }
      }
    }

    const bodyHTML = cardDetailBodyHTML(def, instanceId, fieldWarrior, fieldBuilding);

    // Bottone contestuale
    const isMyTurn = currentState && currentState.current_player_id === myPlayerId;
    let actionLabel = null;
    let onAction = null;
    const extraButtons = [];

    if (source === 'hand' && isMyTurn) {
      if (actionMode === 'play_card' || actionMode === null) {
        const player = currentState.players.find(p => p.id === myPlayerId);
        const isEtherealCard = player && player.ethereal_card === instanceId;
        if (player && (player.actions_remaining > 0 || isEtherealCard || _isFreeActionSpell(player, def))) {
          actionLabel = 'Gioca';
          onAction = () => { Renderer.closeCardDetail(); showPlayOptions(instanceId, def); };
        }
      }
    } else if (source === 'field' && isMyTurn && currentState.phase === 'schieramento') {
      actionLabel = 'Riposiziona';
      onAction = () => {
        Renderer.closeCardDetail();
        const me = currentState.players.find(p => p.id === myPlayerId);
        const from = me && ['vanguard', 'bastion_left', 'bastion_right'].find(z =>
          (z === 'vanguard' ? me.field.vanguard : me.field[z].warriors || []).some(w => w.instance_id === instanceId));
        Renderer.showRegionPicker({
          title: 'Riposiziona Guerriero',
          exclude: from,
          onPick: (dest) => sendAction('reposition', { warrior_instance_id: instanceId, destination: dest }),
        });
      };
    } else if (source === 'village' && isMyTurn) {
      // Arena: bottone Attiva (non consuma Azione, appare sempre se disponibile)
      if (def && def.id === 'arena') {
        const canActivate = _canActivateArena(instanceId);
        extraButtons.push({
          label: 'Attiva Arena',
          className: 'btn-warning',
          disabled: !canActivate,
          onClick: () => { Renderer.closeCardDetail(); _showArenaFlow(instanceId); },
        });
      }
      // Completa costruzione
      if (fieldBuilding && !fieldBuilding.completed) {
        const player = currentState.players.find(p => p.id === myPlayerId);
        const isEtherealComplete = player && player.ethereal_complete === instanceId;
        actionLabel = isEtherealComplete ? 'Completa gratis (Velocemento)' : 'Completa';
        onAction = () => {
          Renderer.closeCardDetail();
          sendAction('complete_building', { building_instance_id: instanceId });
        };
      }
    }

    // Recluta sotto l'Eroe: l'Eroe ne conserva l'effetto Orda, ma la sua carta
    // non lo riporta — il pulsante mostra la Recluta, da cui si torna all'Eroe.
    if ((source === 'field' || source === 'opponent') && fieldWarrior && fieldWarrior.evolved_from) {
      extraButtons.push({
        label: 'Recluta',
        className: 'btn-secondary',
        onClick: () => {
          Renderer.closeCardDetail();
          _showRecruitDetail(fieldWarrior.evolved_from, instanceId, source);
        },
      });
    }

    // Carte assegnate (es. Trono): visibili su qualsiasi Guerriero, proprio o avversario
    if ((source === 'field' || source === 'opponent') && fieldWarrior && fieldWarrior.assigned_cards && fieldWarrior.assigned_cards.length > 0) {
      const nonWallAssigned = fieldWarrior.assigned_cards.filter(ac => ac.type !== 'wall');
      const assignedWalls = fieldWarrior.assigned_cards.filter(ac => ac.type === 'wall');

      if (nonWallAssigned.length > 0) {
        extraButtons.push({
          label: 'Carte assegnate',
          className: 'btn-secondary',
          onClick: () => {
            Renderer.closeCardDetail();
            _showAssignedCardsSlideshow(instanceId, fieldWarriorOwnerId, 0);
          },
        });
      }

      // Muri assegnati (es. Arrampicarta): mostrati a testa in giù, impilati e
      // numerati come nel Bastione — l'identità è visibile solo al proprietario.
      if (assignedWalls.length > 0) {
        const revealable = assignedWalls.every(ac => ac.instance_id);
        extraButtons.push({
          label: 'Muri assegnati',
          className: 'btn-secondary',
          disabled: !revealable,
          onClick: revealable ? () => {
            Renderer.closeCardDetail();
            _showAssignedWallSlideshow(instanceId, fieldWarriorOwnerId, 0);
          } : () => {},
        });
      }
    }

    const onDiscard = null;

    const title = def ? def.name : (fieldWarrior ? (fieldWarrior.name || instanceId) : instanceId);
    let baseId = def ? def.id : null;
    let fallbackBaseId = null;
    // Easter egg: mostra l'illustrazione alternativa dell'Obelisco quando la
    // costruzione è completa, con fallback sulla carta ufficiale se manca.
    if (baseId === 'obelisco' && fieldBuilding && fieldBuilding.completed) {
      baseId = 'obelisco_completo';
      fallbackBaseId = 'obelisco';
    }

    // Frecce di navigazione per le carte in mano
    let navOptions = null;
    if (source === 'hand') {
      const myPlayer = currentState ? currentState.players.find(p => p.id === myPlayerId) : null;
      const hand = myPlayer ? (myPlayer.hand || []) : [];
      const idx = hand.indexOf(instanceId);
      if (hand.length > 1 && idx >= 0) {
        navOptions = {
          onPrev: idx > 0 ? () => showCardDetail(hand[idx - 1], 'hand') : null,
          onNext: idx < hand.length - 1 ? () => showCardDetail(hand[idx + 1], 'hand') : null,
        };
      }
    }

    Renderer.showCardDetail(title, bodyHTML, actionLabel, onAction, onDiscard, extraButtons, navOptions, baseId, fallbackBaseId);
  }

  function showPlayOptions(instanceId, def) {
    if (def.type === 'warrior') {
      if (def.subtype === 'hero') {
        _showHeroPlayOptions(instanceId, def);
      } else {
        Renderer.showRegionPicker({
          title: `Gioca ${def.name}`,
          subtitle: 'Scegli dove schierarlo.',
          note: (z) => z === 'vanguard' ? 'Attacca in Battaglia' : 'Difende questo Bastione',
          onPick: (region) => sendAction('play_warrior', { instance_id: instanceId, region }),
        });
      }
    } else if (def.type === 'spell') {
      _showSpellOptions(instanceId, def);
    } else if (def.type === 'building') {
      if (def.id === 'trono') {
        _showTronoPlayOptions(instanceId, def);
        return;
      }
      Renderer.showModal(
        `Costruisci ${def.name}`,
        `Costo: <strong>${def.cost} Mana</strong><br>${def.base_effect || ''}`,
        () => sendAction('play_building', { instance_id: instanceId }),
      );
    }
  }

  // Trono: richiede la scelta immediata del Guerriero a cui assegnarlo
  function _showTronoPlayOptions(instanceId, def) {
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    const warriors = myPlayer ? _getAllWarriors(myPlayer) : [];
    if (warriors.length === 0) {
      Renderer.toast('Non hai nessun Guerriero in campo a cui assegnare il Trono.', 'error');
      return;
    }
    Renderer.showWarriorPicker(currentState, {
      title: `Costruisci ${def.name} — scegli il Guerriero`,
      subtitle: 'Completato, il Trono rende sempre attivo il suo effetto Orda.',
      players: [myPlayer],
      note: (w) => { const d = getCardDef(w.instance_id); return d && d.horde_effect ? null : 'Nessun effetto Orda'; },
      onPick: (w) => sendAction('play_building', { instance_id: instanceId, target_warrior_iid: w.instance_id }),
    });
  }

  function _showHeroPlayOptions(instanceId, def) {
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    if (!myPlayer) return;
    Renderer.showWarriorPicker(currentState, {
      title: `Evolvi in ${def.name}`,
      subtitle: 'La Recluta diventa Eroe e ne eredita le carte assegnate.',
      players: [myPlayer],
      filter: (w) => { const d = getCardDef(w.instance_id); return !!d && d.evolves_into === def.id; },
      empty: `Nessuna Recluta compatibile in campo per evolvere ${def.name}.`,
      onPick: (w) => sendAction('evolve', { recruit_instance_id: w.instance_id, hero_instance_id: instanceId }),
    });
  }

  // Orda di Madeleine: gli Incantesimi a costo 1 non consumano Azioni
  function _isFreeActionSpell(player, def) {
    return !!def && def.type === 'spell' && def.school === 'incantesimo' && def.cost === 1 &&
      (player.active_effects || []).some(e => e.type === 'madeleine_free_action');
  }

  function _hasFreeActionSpells(player) {
    return (player.hand || []).some(iid => _isFreeActionSpell(player, getCardDef(iid)));
  }

  function _computeSpellProdigy(def) {
    if (!currentState) return false;
    const me = currentState.players.find(p => p.id === myPlayerId);
    if (!me) return false;

    const allWarriors = [
      ...(me.field.vanguard || []),
      ...(me.field.bastion_left.warriors || []),
      ...(me.field.bastion_right.warriors || []),
    ];
    // Prodigio: almeno tante Maghe quanto il costo, di cui almeno una della Scuola
    const mages = allWarriors.map(w => getCardDef(w.instance_id)).filter(d => d && d.species === 'maga');
    return mages.length >= def.cost && mages.some(d => d.school === def.school);
  }

  function _showSpellOptions(instanceId, def) {
    const opponents = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);

    // Telecinesi: UI dedicata a 2 step (source bastion → dest bastion)
    if (def.id === 'telecinesi') {
      _showTelecinesiOptions(instanceId);
      return;
    }

    // Plasmattone: base = bastione → muro casuale; prodigio = bastione → scegli muro
    if (def.id === 'plasmattone') {
      const me = currentState.players.find(p => p.id === myPlayerId);
      const prodigy = _computeSpellProdigy(def);
      Renderer.showBastionPicker(currentState, {
        title: `${def.name} — scegli un tuo Bastione`,
        players: [me],
        filter: (p, side) => ((side === 'left' ? p.field.bastion_left : p.field.bastion_right).wall_count ?? 0) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, side) => {
          if (prodigy) {
            const walls = (side === 'left' ? me.field.bastion_left : me.field.bastion_right).walls || [];
            _showSpellWallPicker(walls, side, instanceId, 0);
          } else {
            sendAction('play_spell', { instance_id: instanceId, bastion_side: side });
          }
        },
      });
      return;
    }

    // Plasmarmo: bastione → scegli muro (prodigio: la carta diventa eterea, gestito dal server)
    if (def.id === 'plasmarmo') {
      const me = currentState.players.find(p => p.id === myPlayerId);
      Renderer.showBastionPicker(currentState, {
        title: `${def.name} — scegli un tuo Bastione`,
        players: [me],
        filter: (p, side) => ((side === 'left' ? p.field.bastion_left : p.field.bastion_right).wall_count ?? 0) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, side) => {
          const walls = (side === 'left' ? me.field.bastion_left : me.field.bastion_right).walls || [];
          _showSpellWallPicker(walls, side, instanceId, 0);
        },
      });
      return;
    }

    // Arrampicarta: scegli un tuo Bastione → un tuo Muro → un tuo Guerriero a cui assegnarlo
    if (def.id === 'arrampicarta') {
      const me = currentState.players.find(p => p.id === myPlayerId);
      if (_getAllWarriors(me).length === 0) {
        Renderer.toast('Non hai nessun Guerriero in campo a cui assegnare un Muro.', 'error');
        return;
      }
      Renderer.showBastionPicker(currentState, {
        title: `${def.name} — scegli un tuo Bastione`,
        subtitle: 'Poi scegli il Muro e il Guerriero a cui assegnarlo.',
        players: [me],
        filter: (p, side) => ((side === 'left' ? p.field.bastion_left : p.field.bastion_right).wall_count ?? 0) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, side) => {
          const walls = (side === 'left' ? me.field.bastion_left : me.field.bastion_right).walls || [];
          _showArrampicartaWallPicker(walls, side, instanceId, 0);
        },
      });
      return;
    }

    // Cambiamente: scegli un guerriero avversario
    if (def.id === 'cambiamente') {
      Renderer.showWarriorPicker(currentState, {
        title: `${def.name} — scegli un Guerriero`,
        players: opponents,
        empty: 'Nessun Guerriero avversario disponibile.',
        onPick: (w, p) => sendAction('play_spell', { instance_id: instanceId, target_player_id: p.id, target_warrior_iid: w.instance_id }),
      });
      return;
    }

    // Bastioncontrario: UI dedicata (base = scegli giocatore; prodigio = 2 bastioni qualsiasi)
    if (def.id === 'bastioncontrario') {
      _showBastioncontrarioOptions(instanceId, def);
      return;
    }

    // Malcomune: scegli un tuo Guerriero (scartato se Base, mantenuto se Prodigio);
    // ogni avversario con un Guerriero della stessa Specie lo scarterà (o sceglierà quale, se ne ha più di uno)
    if (def.id === 'malcomune') {
      const me = currentState.players.find(p => p.id === myPlayerId);
      const prodigy = _computeSpellProdigy(def);
      Renderer.showWarriorPicker(currentState, {
        title: prodigy
          ? `${def.name} — scegli un tuo Guerriero (lo mantieni)`
          : `${def.name} — scegli un tuo Guerriero da scartare`,
        subtitle: 'Ogni avversario scarterà un Guerriero della stessa Specie.',
        players: [me],
        note: (w) => { const d = getCardDef(w.instance_id); return d && d.species ? `Specie: ${d.species.charAt(0).toUpperCase() + d.species.slice(1)}` : null; },
        empty: 'Non hai nessun Guerriero in campo.',
        onPick: (w) => sendAction('play_spell', { instance_id: instanceId, own_warrior_iid: w.instance_id }),
      });
      return;
    }

    // Equipotenza: base = scegli un tuo Guerriero (ATT/DIF = valore maggiore dei due);
    // prodigio (additivo): scegli anche un Guerriero qualsiasi, proprio o avversario (ATT/DIF = valore minore).
    if (def.id === 'equipotenza') {
      const me = currentState.players.find(p => p.id === myPlayerId);
      const prodigy = _computeSpellProdigy(def);
      Renderer.showWarriorPicker(currentState, {
        title: `${def.name} — scegli un tuo Guerriero`,
        subtitle: 'ATT e DIF diventano pari al valore maggiore dei due.',
        players: [me],
        empty: 'Non hai nessun Guerriero in campo.',
        onPick: (ownW) => {
          if (!prodigy) {
            sendAction('play_spell', { instance_id: instanceId, own_warrior_iid: ownW.instance_id });
            return;
          }
          const shown = Renderer.showWarriorPicker(currentState, {
            title: `${def.name} — scegli un Guerriero qualsiasi`,
            subtitle: 'Prodigio: ATT e DIF diventano pari al valore minore dei due.',
            onPick: (w) => sendAction('play_spell', { instance_id: instanceId, own_warrior_iid: ownW.instance_id, enemy_warrior_iid: w.instance_id }),
          });
          if (!shown) sendAction('play_spell', { instance_id: instanceId, own_warrior_iid: ownW.instance_id });
        },
      });
      return;
    }

    // Regicidio: UI dedicata — scegli un Trono in campo (di qualsiasi giocatore) da scartare
    if (def.id === 'regicidio') {
      _showRegicidioOptions(instanceId, def);
      return;
    }

    // Cuordipietra: UI dedicata — scegli un Guerriero avversario (base: solo Reclute) poi il Bastione di destinazione
    if (def.id === 'cuordipietra') {
      _showCuordipietraOptions(instanceId, def);
      return;
    }

    const spellsNeedingTarget = [
      'ardolancio', 'incendifesa',
    ];

    if (!spellsNeedingTarget.includes(def.id) || opponents.length === 0) {
      Renderer.showModal(
        `${def.name}`,
        `Costo: <strong>${def.cost} Maghe</strong><br>${def.base_effect || ''}`,
        () => sendAction('play_spell', { instance_id: instanceId }),
      );
      return;
    }

    Renderer.showBastionPicker(currentState, {
      title: `${def.name} — scegli il Bastione bersaglio`,
      players: opponents,
      onPick: (p, side) => sendAction('play_spell', {
        instance_id: instanceId,
        target_player_id: p.id,
        target_bastion_side: side,
      }),
    });
  }

  // Orda di Evelyn: la Magia appena giocata va giocata una seconda volta, con
  // nuovi bersagli. Riusa la stessa UI di targeting della prima giocata: il
  // flag recastPending fa convertire la play_spell finale in recast_spell.
  function _showEvelynRecastModal(pending) {
    const baseId = pending.base_card_id;
    const def = cardDefs[baseId];
    const name = def ? def.name : baseId;
    Renderer.showModal(
      'Orda di Evelyn',
      `<strong>${name}</strong> viene giocata una seconda volta: scegli i nuovi bersagli.`,
      () => {
        recastPending = baseId;
        _showSpellOptions(baseId, def);
        // Se il targeting non è possibile (nessun bersaglio valido) il flusso
        // si chiude con un toast senza aprire nulla: riproponi la scelta,
        // altrimenti l'interazione resterebbe in sospeso senza UI.
        setTimeout(() => {
          const overlay = document.getElementById('modal-overlay');
          if (recastPending && overlay.classList.contains('hidden')) {
            recastPending = null;
            _showEvelynRecastModal(pending);
          }
        }, 50);
      },
      () => {
        recastPending = null;
        sendAction('recast_spell', { base_card_id: baseId, skip: true });
      },
    );
    document.getElementById('modal-confirm').textContent = 'Rigioca';
    document.getElementById('modal-cancel').textContent = 'Rinuncia';
  }

  // Cuordipietra: base = scegli una Recluta avversaria → diventa Muro in un suo Bastione;
  // prodigio = scegli qualsiasi Guerriero avversario → diventa Muro in un tuo Bastione.
  function _showRegicidioOptions(instanceId, def) {
    if (!currentState) return;
    const prodigy = _computeSpellProdigy(def);

    Renderer.showBuildingPicker(currentState, {
      title: `${def.name} — scegli un Trono`,
      subtitle: prodigy ? 'Prodigio: verrà scartato anche il Guerriero a cui è assegnato.' : null,
      filter: (b) => b.base_card_id === 'trono',
      note: (b, p) => {
        if (!b.assigned_warrior) return 'Non assegnato';
        const warrior = _getAllWarriors(p).find(w => w.instance_id === b.assigned_warrior);
        return `Assegnato a ${warrior ? warrior.name : 'un Guerriero'}`;
      },
      empty: 'Non ci sono Troni in campo.',
      onPick: (b, p) => sendAction('play_spell', { instance_id: instanceId, target_player_id: p.id, target_trono_iid: b.instance_id }),
    });
  }

  function _showCuordipietraOptions(instanceId, def) {
    if (!currentState) return;
    const prodigy = _computeSpellProdigy(def);
    const opponents = currentState.players.filter(p => p.id !== myPlayerId && p.lives > 0);

    Renderer.showWarriorPicker(currentState, {
      title: `${def.name} — scegli un Guerriero`,
      subtitle: prodigy ? null : 'Solo Reclute (con il Prodigio anche gli Eroi).',
      players: opponents,
      filter: (w) => prodigy || w.subtype === 'recruit',
      empty: prodigy ? 'Nessun Guerriero avversario disponibile.' : 'Nessuna Recluta avversaria disponibile.',
      onPick: (w, p) => {
        const targetPlayerId = p.id;
        const targetWarriorIid = w.instance_id;
        const me = currentState.players.find(pp => pp.id === myPlayerId);
        // Base: il Guerriero diventa Muro in un Bastione del suo proprietario; Prodigio: in uno tuo
        Renderer.showBastionPicker(currentState, {
          title: `${def.name} — dove diventa Muro ${w.name}?`,
          players: [prodigy ? me : p],
          onPick: (bp, destSide) => sendAction('play_spell', {
            instance_id: instanceId,
            target_player_id: targetPlayerId,
            target_warrior_iid: targetWarriorIid,
            dest_bastion_side: destSide,
          }),
        });
      },
    });
  }

  function _showBastioncontrarioOptions(instanceId, def) {
    if (!currentState) return;
    const prodigy = _computeSpellProdigy(def);
    if (!prodigy) {
      // Base: scegli un giocatore — i suoi due Bastioni si scambiano i Muri
      Renderer.showPlayerPicker(currentState, {
        title: `${def.name} — scegli un giocatore`,
        subtitle: 'I suoi due Bastioni si scambiano i Muri.',
        onPick: (p) => sendAction('play_spell', { instance_id: instanceId, player1_id: p.id }),
      });
    } else {
      // Prodigio: scegli due Bastioni qualsiasi, che si scambiano i Muri
      Renderer.showBastionPicker(currentState, {
        title: `${def.name} — primo Bastione`,
        subtitle: 'Prodigio: due Bastioni qualsiasi si scambiano i Muri.',
        onPick: (p1, s1) => {
          Renderer.showBastionPicker(currentState, {
            title: `${def.name} — secondo Bastione`,
            subtitle: p1.id === myPlayerId
              ? `Scambierà i Muri con il tuo Bastione ${s1 === 'left' ? 'Sinistro' : 'Destro'}.`
              : `Scambierà i Muri con il Bastione ${s1 === 'left' ? 'Sinistro' : 'Destro'} di ${p1.name}.`,
            filter: (p2, s2) => !(p2.id === p1.id && s2 === s1),
            onPick: (p2, s2) => sendAction('play_spell', {
              instance_id: instanceId,
              player1_id: p1.id,
              side1: s1,
              player2_id: p2.id,
              side2: s2,
            }),
          });
        },
      });
    }
  }

  function _showTelecinesiOptions(instanceId) {
    if (!currentState) return;
    const def = getCardDef(instanceId);
    const prodigy = _computeSpellProdigy(def);
    const me = currentState.players.find(p => p.id === myPlayerId);
    const alivePlayers = currentState.players.filter(p => p.lives > 0);

    function wallCount(p, side) {
      return (side === 'left' ? p.field.bastion_left : p.field.bastion_right).wall_count ?? 0;
    }

    function showCountPicker(maxWalls, onCount) {
      const max = Math.min(3, maxWalls);
      const rows = [];
      for (let i = 1; i <= max; i++) rows.push({ name: `${i} ${i > 1 ? 'Muri' : 'Muro'}`, value: i });
      Renderer.showPicker({
        title: 'Telecinesi — quanti Muri?',
        subtitle: 'I Muri spostati sono scelti a caso.',
        groups: [{ zones: [{ rows }] }],
        onPick: (n) => onCount(n),
      });
    }

    if (!prodigy) {
      // Base: tra i miei due bastioni
      Renderer.showBastionPicker(currentState, {
        title: 'Telecinesi — Bastione di partenza',
        subtitle: 'I Muri si spostano nell\'altro tuo Bastione.',
        players: [me],
        filter: (p, side) => wallCount(p, side) > 0,
        empty: 'Nessun Muro nei tuoi Bastioni.',
        onPick: (p, srcSide) => {
          const destSide = srcSide === 'left' ? 'right' : 'left';
          showCountPicker(wallCount(me, srcSide), (count) => {
            sendAction('play_spell', { instance_id: instanceId, source_side: srcSide, dest_side: destSide, count });
          });
        },
      });
    } else {
      // Prodigio: qualsiasi bastione → solo adiacenti
      function getAdjacentKeys(playerId, side) {
        const n = alivePlayers.length;
        const idx = alivePlayers.findIndex(p => p.id === playerId);
        const adj = [`${playerId}:${side === 'left' ? 'right' : 'left'}`];
        if (side === 'right') {
          adj.push(`${alivePlayers[(idx + 1) % n].id}:left`);
        } else {
          adj.push(`${alivePlayers[(idx - 1 + n) % n].id}:right`);
        }
        return adj;
      }

      Renderer.showBastionPicker(currentState, {
        title: 'Telecinesi — Bastione di partenza',
        subtitle: 'Prodigio: da un Bastione qualsiasi a uno adiacente.',
        filter: (p, side) => wallCount(p, side) > 0,
        empty: 'Nessun Muro disponibile.',
        onPick: (src, srcSide) => {
          const adjKeys = new Set(getAdjacentKeys(src.id, srcSide));
          Renderer.showBastionPicker(currentState, {
            title: 'Telecinesi — Bastione di arrivo',
            subtitle: 'Solo i Bastioni adiacenti a quello di partenza.',
            filter: (p, side) => adjKeys.has(`${p.id}:${side}`),
            onPick: (dst, dstSide) => {
              showCountPicker(wallCount(src, srcSide), (count) => {
                sendAction('play_spell', {
                  instance_id: instanceId,
                  source_player_id: src.id,
                  source_side: srcSide,
                  dest_player_id: dst.id,
                  dest_side: dstSide,
                  count,
                });
              });
            },
          });
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Selettore muro per magie (Plasmattone prodigio, Plasmarmo)
  // ---------------------------------------------------------------------------

  function _showSpellWallPicker(walls, side, spellInstanceId, idx) {
    if (!walls.length) return;
    const iid = walls[idx];
    const def = getCardDef(iid);
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    let bodyHTML = '';
    if (def) {
      if (def.type === 'warrior') {
        bodyHTML += `<div class="detail-meta">
          <span class="species-${def.species}">${cap(def.species)}</span>
          ${def.school ? `· <span>${cap(def.school)}</span>` : ''}
          · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}
          · 💎${def.cost} Mana
        </div>
        <div class="detail-stats">
          <span class="stat-att">🗡️ ATT ${def.att}</span>
          <span class="stat-git">🏹 GIT ${def.git}</span>
          <span class="stat-dif">🛡️ DIF ${def.dif}</span>
        </div>`;
        if (def.horde_effect) bodyHTML += `<div class="detail-section"><strong>Effetto Orda:</strong><br>${def.horde_effect}</div>`;
        if (def.evolves_from) bodyHTML += `<div class="detail-dim">Evolve da: ${cardDefs[def.evolves_from]?.name || def.evolves_from}</div>`;
        if (def.evolves_into) bodyHTML += `<div class="detail-dim">Evolve in: ${cardDefs[def.evolves_into]?.name || def.evolves_into}</div>`;
      } else if (def.type === 'spell') {
        bodyHTML += `<div class="detail-meta"><span class="school-${def.school}">${cap(def.school)}</span> · Magia · 🔮${def.cost} Maghe</div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.prodigy_effect) bodyHTML += `<div class="detail-section"><strong>Prodigio:</strong><br>${def.prodigy_effect}</div>`;
      } else if (def.type === 'building') {
        bodyHTML += `<div class="detail-meta">Costruzione · 💎${def.cost} Mana · 🏗️${def.completion_cost} Mana</div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.complete_effect) bodyHTML += `<div class="detail-section"><strong>Effetto Completo:</strong><br>${def.complete_effect}</div>`;
      }
    } else {
      bodyHTML = `<div class="detail-dim">${iid}</div>`;
    }

    Renderer.showCardDetail(
      def ? def.name : iid,
      bodyHTML,
      null, null, null,
      [{
        label: 'Scegli',
        className: 'btn-primary',
        onClick: () => {
          Renderer.closeCardDetail();
          sendAction('play_spell', { instance_id: spellInstanceId, bastion_side: side, wall_instance_id: iid });
        },
      }],
      {
        onPrev: idx > 0 ? () => _showSpellWallPicker(walls, side, spellInstanceId, idx - 1) : null,
        onNext: idx < walls.length - 1 ? () => _showSpellWallPicker(walls, side, spellInstanceId, idx + 1) : null,
      },
      def ? def.id : null
    );
  }

  // Arrampicarta: scelta del Muro, seguita dalla scelta del Guerriero a cui assegnarlo
  function _showArrampicartaWallPicker(walls, side, spellInstanceId, idx) {
    const iid = walls[idx];
    const def = getCardDef(iid);

    const bodyHTML = cardDetailBodyHTML(def, iid);

    Renderer.showCardDetail(
      def ? def.name : iid,
      bodyHTML,
      null, null, null,
      [{
        label: 'Scegli',
        className: 'btn-primary',
        onClick: () => {
          Renderer.closeCardDetail();
          _showArrampicartaWarriorPicker(spellInstanceId, side, iid);
        },
      }],
      {
        onPrev: idx > 0 ? () => _showArrampicartaWallPicker(walls, side, spellInstanceId, idx - 1) : null,
        onNext: idx < walls.length - 1 ? () => _showArrampicartaWallPicker(walls, side, spellInstanceId, idx + 1) : null,
      },
      def ? def.id : null
    );
  }

  function _showArrampicartaWarriorPicker(spellInstanceId, wallSide, wallInstanceId) {
    const me = currentState.players.find(p => p.id === myPlayerId);
    Renderer.showWarriorPicker(currentState, {
      title: 'Arrampicarta — assegna il Muro a un Guerriero',
      players: [me],
      onPick: (w) => sendAction('play_spell', {
        instance_id: spellInstanceId,
        bastion_side: wallSide,
        wall_instance_id: wallInstanceId,
        warrior_iid: w.instance_id,
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // Modale Ricerca
  // ---------------------------------------------------------------------------

  function _showSearchModal(deckView, pendingSearch) {
    const titles = {
      'cercapersone_base':     'Cercapersone — scegli una Recluta',
      'cercapersone_prodigio': 'Cercapersone — scegli una Recluta',
      'giulio_horde':          'Orda di Giulio — cerca Giulio II',
    };
    const subtitles = {
      'cercapersone_base':     'La Recluta scelta va nella tua mano.',
      'cercapersone_prodigio': 'Prodigio: la Recluta scelta va nella tua mano e diventa Eterea.',
      'giulio_horde':          'Giulio II va nella tua mano.',
    };
    // Le copie della stessa carta sono raggruppate in una riga "×N": l'ordine del
    // mazzo non viene mostrato.
    const matches = deckView.filter(c => c.matches).map(c => c.instance_id);
    const others  = deckView.filter(c => !c.matches).map(c => c.instance_id);
    const shown = Renderer.showCardPicker({
      title: titles[pendingSearch.context] || 'Cerca nel mazzo',
      subtitle: `${subtitles[pendingSearch.context] || ''} ${matches.length} carte selezionabili su ${deckView.length} nel mazzo.`.trim(),
      groups: [
        { head: 'Selezionabili', cards: matches },
        { head: 'Resto del mazzo', cards: others, disabled: true },
      ],
      dedupe: true,
      cancelLabel: 'Esci senza prendere',
      onCancel: () => sendAction('resolve_search', {})
        .catch(e => Renderer.toast(e.message || 'Errore nella ricerca', 'error')),
      onPick: (iid) => sendAction('resolve_search', { chosen_iid: iid })
        .catch(e => Renderer.toast(e.message || 'Errore nella ricerca', 'error')),
    });
    // Nessuna carta adatta nel mazzo: si può solo uscire
    if (!shown) {
      Renderer.showModal(
        titles[pendingSearch.context] || 'Cerca nel mazzo',
        'Nel mazzo non c\'è nessuna carta adatta.',
        () => sendAction('resolve_search', {}).catch(() => {}),
        () => sendAction('resolve_search', {}).catch(() => {}),
      );
      document.getElementById('modal-confirm').textContent = 'Continua';
      document.getElementById('modal-cancel').classList.add('hidden');
    }
  }

  function _showVelocementoChoiceModal(buildingIids) {
    Renderer.showCardPicker({
      title: 'Velocemento — scegli una Costruzione',
      subtitle: 'La Costruzione scelta diventa Eterea.',
      cards: buildingIids,
      note: (def) => def ? def.base_effect : null,
      cancelLabel: null,
      onPick: (iid) => sendAction('resolve_velocemento', { building_instance_id: iid })
        .catch(e => Renderer.toast(e.message || 'Errore', 'error')),
    });
  }

  function _showBibliotecaModal(interaction, state) {
    const isWall = interaction.type === 'biblioteca_wall';
    const myPlayer = state.players.find(p => p.id === myPlayerId);
    const hand = (myPlayer && myPlayer.hand) || [];

    if (hand.length === 0) {
      // Mano vuota: il server risolve automaticamente l'interazione
      sendAction('resolve_biblioteca', {}).catch(() => {});
      return;
    }

    if (isWall) {
      Renderer.showCardPicker({
        title: 'Biblioteca — scegli una carta',
        subtitle: 'La carta scelta diventa un Muro in un tuo Bastione.',
        cards: hand,
        cancelLabel: null,
        onPick: (chosenIid) => {
          Renderer.showBastionPicker(state, {
            title: 'Biblioteca — in quale Bastione?',
            players: [myPlayer],
            cancelLabel: null,
            onPick: (p, side) => sendAction('resolve_biblioteca', { wall_card_iid: chosenIid, wall_bastion_side: side })
              .catch(e => Renderer.toast(e.message || 'Errore', 'error')),
          });
        },
      });
    } else {
      Renderer.showCardPicker({
        title: 'Biblioteca — scegli una carta da scartare',
        cards: hand,
        cancelLabel: null,
        onPick: (chosenIid) => sendAction('resolve_biblioteca', { discard_iid: chosenIid })
          .catch(e => Renderer.toast(e.message || 'Errore', 'error')),
      });
    }
  }

  function _showAgilpescaDiscardModal(state) {
    const myPlayer = state.players && state.players.find(p => p.id === myPlayerId);
    const hand = (myPlayer && myPlayer.hand) || [];
    Renderer.showCardPicker({
      title: 'Agilpesca — scegli una carta da scartare',
      cards: hand,
      cancelLabel: null,
      onPick: (chosenIid) => sendAction('resolve_agilpesca', { discard_iid: chosenIid })
        .catch(e => Renderer.toast(e.message || 'Errore', 'error')),
    });
  }

  function _showMagiscudoCounterModal(pending, state) {
    const caster = state.players.find(p => p.id === pending.caster_id) || {};
    const spellDef = getCardDef(pending.spell_iid) || {};
    const spellName = spellDef.name || 'una Magia';

    document.getElementById('modal-title').textContent = '🛡 Magiscudo — reagisci!';
    const body = document.getElementById('modal-body');
    body.innerHTML = '';
    const msg = document.createElement('p');
    msg.textContent = `${caster.name || 'Un avversario'} ha giocato ${spellName} contro di te. Vuoi usare Magiscudo per bloccarla?`;
    body.appendChild(msg);

    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn  = document.getElementById('modal-cancel');
    confirmBtn.textContent = 'Usa Magiscudo';
    confirmBtn.classList.remove('hidden');
    confirmBtn.onclick = () => {
      sendAction('resolve_magiscudo_counter', { accept: true })
        .catch(e => Renderer.toast(e.message || 'Errore', 'error'));
    };
    cancelBtn.textContent = 'Lascia passare';
    cancelBtn.onclick = () => {
      sendAction('resolve_magiscudo_counter', { accept: false })
        .catch(e => Renderer.toast(e.message || 'Errore', 'error'));
    };
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function _showMalcomuneDiscardModal(pending, state) {
    const myPlayer = state.players.find(p => p.id === myPlayerId);
    const caster = state.players.find(p => p.id === pending.caster_id) || {};
    const species = pending.species ? pending.species.charAt(0).toUpperCase() + pending.species.slice(1) : '';
    const shown = Renderer.showWarriorPicker(state, {
      title: 'Malcomune — scegli il Guerriero da scartare',
      subtitle: `${caster.name || 'Un avversario'} ti costringe a scartare un Guerriero ${species}.`,
      players: [myPlayer],
      filter: (w) => { const d = getCardDef(w.instance_id); return !!d && d.species === pending.species; },
      cancelLabel: null,
      onPick: (w) => sendAction('resolve_malcomune', { warrior_iid: w.instance_id })
        .catch(e => Renderer.toast(e.message || 'Errore', 'error')),
    });
    // Non dovrebbe accadere: il server accoda questa interazione solo se c'è una scelta reale.
    if (!shown) sendAction('resolve_malcomune', {}).catch(() => {});
  }

  function _showCardoMoveModal(state) {
    const myPlayer = state.players.find(p => p.id === myPlayerId);
    if (!myPlayer) return;
    const onError = e => Renderer.toast(e.message || 'Errore', 'error');

    const shown = Renderer.showWarriorPicker(state, {
      title: 'Cardo — sposta un Guerriero (facoltativo)',
      players: [myPlayer],
      cancelLabel: 'Salta',
      onCancel: () => sendAction('resolve_cardo_move', {}).catch(onError),
      // Destinazione senza Annulla: l'interazione va risolta
      onPick: (w, p, fromZone) => Renderer.showRegionPicker({
        title: `Cardo — dove sposti ${w.name}?`,
        exclude: fromZone,
        cancelLabel: null,
        onPick: (dest) => sendAction('resolve_cardo_move', { warrior_iid: w.instance_id, destination: dest }).catch(onError),
      }),
    });
    if (!shown) sendAction('resolve_cardo_move', {}).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Fine Turno
  // ---------------------------------------------------------------------------

  async function onNextPhase() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return;
    try {
      await sendAction('next_phase', {});
    } catch (e) {
      Renderer.toast(e.message, 'error');
    }
  }

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
    const my = currentState.players.find(p => p.id === myPlayerId);
    if (!my || !my.field.vanguard || my.field.vanguard.length === 0) {
      Renderer.toast('Non hai Guerrieri in Avanscoperta', 'error');
      return;
    }

    // Bersagli: i Bastioni che il campo segna come attaccabili (adiacenza, Guerremoto)
    const indexOf = new Map();
    document.querySelectorAll('.attack-target').forEach(el => {
      const pid  = el.dataset.targetPlayerId;
      const side = el.dataset.targetSide;
      const p = pid && side && currentState.players.find(pp => pp.id === pid);
      if (p && p.lives > 0) indexOf.set(`${pid}:${side}`, currentState.players.indexOf(p));
    });
    if (indexOf.size === 0) {
      Renderer.toast('Nessun bersaglio adiacente disponibile', 'error');
      return;
    }

    const attAtt = Math.max(0, ...my.field.vanguard.map(w => w.att));
    const attGit = Math.max(0, ...my.field.vanguard.map(w => w.git));
    const bastionOf = (p, side) => p.field[side === 'left' ? 'bastion_left' : 'bastion_right'];

    Renderer.showBastionPicker(currentState, {
      title: 'Battaglia — scegli il Bastione da attaccare',
      subtitle: `I tuoi attaccanti: ATT ${attAtt} · GIT ${attGit}`,
      filter: (p, side) => indexOf.has(`${p.id}:${side}`),
      note: (p, side) => {
        const defs = bastionOf(p, side).warriors || [];
        const defDif = defs.length ? Math.max(...defs.map(w => w.dif)) : 0;
        const defGit = defs.length ? Math.max(...defs.map(w => w.git)) : 0;
        const est = Math.max(attAtt - defDif, 0) + Math.max(attGit - defGit, 0);
        return `Danno stimato: ${est}`;
      },
      onPick: (p, side) => sendAction('battle', {
        defender_player_index: indexOf.get(`${p.id}:${side}`),
        defender_bastion_side: side,
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // Invio azioni al server
  // ---------------------------------------------------------------------------

  async function sendAction(action, params = {}) {
    if (recastPending && action === 'play_spell') {
      const { instance_id, ...rest } = params;
      action = 'recast_spell';
      params = { base_card_id: recastPending, ...rest };
      recastPending = null;
    }
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

  function onAbandonClick() {
    Renderer.showModal(
      'Abbandona la partita',
      'Sei sicuro? Verrai eliminato dalla partita e non potrai rientrare.',
      async () => {
        leavingGame = true;
        try {
          await api('/game/action', {
            game_id: gameId,
            session_token: sessionToken,
            action: 'leave_game',
            params: {},
          });
        } catch (e) {
          // partita già finita o non più raggiungibile: torna comunque alla lobby
        }
        returnToLobby();
      }
    );
  }

  function returnToLobby() {
    WS.disconnect();
    stopLobbyPolling();
    stopLocalTimer();
    _clearPendingUI();
    Renderer.closeChroniclePanel();
    SavedGame.clear();
    rematchOffer = null;
    leavingGame = false;
    selectedCard = null;
    actionMode = null;
    wallsSelected = [];
    currentState = null;
    gameId = null;
    lobbyCode = null;
    sessionToken = null;
    myPlayerId = null;
    isTutorial = false;
    hideTutorialStep();
    hideCardAnatomy();
    document.getElementById('btn-abandon').classList.remove('hidden');
    Renderer.showScreen('lobby');
    refreshResumeButton();
  }

  // ---------------------------------------------------------------------------
  // Slideshow muri
  // ---------------------------------------------------------------------------

  function showWallSlideshow(walls, side, idx) {
    const iid = walls[idx];
    const def = getCardDef(iid);
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    let bodyHTML = '';
    if (def) {
      if (def.type === 'warrior') {
        bodyHTML += `<div class="detail-meta">
          <span class="species-${def.species}">${cap(def.species)}</span>
          ${def.school ? `· <span>${cap(def.school)}</span>` : ''}
          · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}
          · 💎${def.cost} Mana
        </div>
        <div class="detail-stats">
          <span class="stat-att">🗡️ ATT ${def.att}</span>
          <span class="stat-git">🏹 GIT ${def.git}</span>
          <span class="stat-dif">🛡️ DIF ${def.dif}</span>
        </div>`;
        if (def.horde_effect) {
          bodyHTML += `<div class="detail-section"><strong>Effetto Orda:</strong><br>${def.horde_effect}</div>`;
        }
        if (def.evolves_from) bodyHTML += `<div class="detail-dim">Evolve da: ${cardDefs[def.evolves_from]?.name || def.evolves_from}</div>`;
        if (def.evolves_into) bodyHTML += `<div class="detail-dim">Evolve in: ${cardDefs[def.evolves_into]?.name || def.evolves_into}</div>`;
      } else if (def.type === 'spell') {
        bodyHTML += `<div class="detail-meta">
          <span class="school-${def.school}">${cap(def.school)}</span> · Magia · 🔮${def.cost} Maghe
        </div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.prodigy_effect) {
          bodyHTML += `<div class="detail-section"><strong>Prodigio:</strong><br>${def.prodigy_effect}</div>`;
        }
      } else if (def.type === 'building') {
        bodyHTML += `<div class="detail-meta">Costruzione · 💎${def.cost} Mana · 🏗️${def.completion_cost} Mana</div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.complete_effect) {
          bodyHTML += `<div class="detail-section"><strong>Effetto Completo:</strong><br>${def.complete_effect}</div>`;
        }
      }
    } else {
      bodyHTML = `<div class="detail-dim">${iid}</div>`;
    }

    const navOptions = {
      onPrev: idx > 0 ? () => showWallSlideshow(walls, side, idx - 1) : null,
      onNext: idx < walls.length - 1 ? () => showWallSlideshow(walls, side, idx + 1) : null,
    };

    Renderer.showCardDetail(
      def ? def.name : iid,
      bodyHTML,
      null,
      null,
      null,
      [],
      navOptions,
      def ? def.id : null
    );
  }

  // ---------------------------------------------------------------------------
  // Slideshow vite
  // ---------------------------------------------------------------------------

  function showLifeSlideshow(lifeCards, idx) {
    const iid = lifeCards[idx];
    const def = getCardDef(iid);
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    let bodyHTML = '';
    if (def) {
      if (def.type === 'warrior') {
        bodyHTML += `<div class="detail-meta">
          <span class="species-${def.species}">${cap(def.species)}</span>
          ${def.school ? `· <span>${cap(def.school)}</span>` : ''}
          · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}
          · 💎${def.cost} Mana
        </div>
        <div class="detail-stats">
          <span class="stat-att">🗡️ ATT ${def.att}</span>
          <span class="stat-git">🏹 GIT ${def.git}</span>
          <span class="stat-dif">🛡️ DIF ${def.dif}</span>
        </div>`;
        if (def.horde_effect) {
          bodyHTML += `<div class="detail-section"><strong>Effetto Orda:</strong><br>${def.horde_effect}</div>`;
        }
      } else if (def.type === 'spell') {
        bodyHTML += `<div class="detail-meta">
          <span class="school-${def.school}">${cap(def.school)}</span> · Magia · 🔮${def.cost} Maghe
        </div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.prodigy_effect) {
          bodyHTML += `<div class="detail-section"><strong>Prodigio:</strong><br>${def.prodigy_effect}</div>`;
        }
      } else if (def.type === 'building') {
        bodyHTML += `<div class="detail-meta">Costruzione · 💎${def.cost} Mana · 🏗️${def.completion_cost} Mana</div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.complete_effect) {
          bodyHTML += `<div class="detail-section"><strong>Effetto Completo:</strong><br>${def.complete_effect}</div>`;
        }
      }
    } else {
      bodyHTML = `<div class="detail-dim">${iid}</div>`;
    }

    const navOptions = {
      onPrev: idx > 0 ? () => showLifeSlideshow(lifeCards, idx - 1) : null,
      onNext: idx < lifeCards.length - 1 ? () => showLifeSlideshow(lifeCards, idx + 1) : null,
    };

    Renderer.showCardDetail(
      `❤ Vita ${idx + 1} / ${lifeCards.length}${def ? ' — ' + def.name : ''}`,
      bodyHTML,
      null,
      null,
      null,
      [],
      navOptions,
      def ? def.id : null
    );
  }

  // ---------------------------------------------------------------------------
  // Recluta sotto un Eroe evoluto
  // ---------------------------------------------------------------------------

  function _showRecruitDetail(recruitIid, heroIid, heroSource) {
    const def = getCardDef(recruitIid);
    const heroDef = getCardDef(heroIid);
    const bodyHTML = cardDetailBodyHTML(def, recruitIid);

    const extraButtons = [{
      label: 'Eroe',
      className: 'btn-secondary',
      onClick: () => {
        Renderer.closeCardDetail();
        showCardDetail(heroIid, heroSource);
      },
    }];

    Renderer.showCardDetail(
      `Recluta di ${heroDef ? heroDef.name : heroIid}${def ? ' — ' + def.name : ''}`,
      bodyHTML,
      null,
      null,
      null,
      extraButtons,
      null,
      def ? def.id : null
    );
  }

  // ---------------------------------------------------------------------------
  // Slideshow carte assegnate (es. Trono assegnato a un Guerriero)
  // ---------------------------------------------------------------------------

  function _findWarriorByIid(playerId, warriorIid) {
    if (!currentState) return null;
    const player = currentState.players.find(p => p.id === playerId);
    if (!player) return null;
    return [
      ...(player.field.vanguard || []),
      ...(player.field.bastion_left.warriors || []),
      ...(player.field.bastion_right.warriors || []),
    ].find(w => w.instance_id === warriorIid) || null;
  }

  function _showAssignedCardsSlideshow(warriorIid, ownerPlayerId, idx) {
    const warrior = _findWarriorByIid(ownerPlayerId, warriorIid);
    if (!warrior) return;
    const assignedCards = (warrior.assigned_cards || []).filter(ac => ac.type !== 'wall');
    if (assignedCards.length === 0) return;

    const ac = assignedCards[idx];
    const def = getCardDef(ac.instance_id);
    const bodyHTML = cardDetailBodyHTML(def, ac.instance_id, null, ac.type === 'building' ? ac : null);

    const isMyTurn = currentState && currentState.current_player_id === myPlayerId;
    const isMine = ownerPlayerId === myPlayerId;

    let actionLabel = null;
    let onAction = null;
    if (ac.type === 'building' && ac.completed === false && isMine && isMyTurn) {
      actionLabel = 'Completa';
      onAction = () => {
        Renderer.closeCardDetail();
        sendAction('complete_building', { building_instance_id: ac.instance_id });
      };
    }

    // Badge di stato (informativo, non cliccabile): visibile sia in modalità
    // immagine che testo, dove il corpo testuale con lo stato non compare.
    const extraButtons = [];
    if (ac.type === 'building') {
      extraButtons.push({
        label: ac.completed ? '✓ Completa' : '○ Incompleta',
        className: 'btn-secondary',
        disabled: true,
        onClick: () => {},
      });
    }

    const navOptions = {
      onPrev: idx > 0 ? () => _showAssignedCardsSlideshow(warriorIid, ownerPlayerId, idx - 1) : null,
      onNext: idx < assignedCards.length - 1 ? () => _showAssignedCardsSlideshow(warriorIid, ownerPlayerId, idx + 1) : null,
    };

    Renderer.showCardDetail(
      `📌 Assegnata ${idx + 1} / ${assignedCards.length}${def ? ' — ' + def.name : ''}`,
      bodyHTML,
      actionLabel,
      onAction,
      null,
      extraButtons,
      navOptions,
      def ? def.id : null
    );
  }

  // Muri assegnati a un Guerriero (es. Arrampicarta): a testa in giù e numerati
  // come nel Bastione — vedibili solo per il proprietario (identità nascosta
  // agli avversari a monte, dal server, filtrando gli instance_id).
  function _showAssignedWallSlideshow(warriorIid, ownerPlayerId, idx) {
    const warrior = _findWarriorByIid(ownerPlayerId, warriorIid);
    if (!warrior) return;
    const walls = (warrior.assigned_cards || []).filter(ac => ac.type === 'wall' && ac.instance_id);
    if (walls.length === 0) return;

    const ac = walls[idx];
    const def = getCardDef(ac.instance_id);
    const bodyHTML = cardDetailBodyHTML(def, ac.instance_id, null, null);

    const navOptions = {
      onPrev: idx > 0 ? () => _showAssignedWallSlideshow(warriorIid, ownerPlayerId, idx - 1) : null,
      onNext: idx < walls.length - 1 ? () => _showAssignedWallSlideshow(warriorIid, ownerPlayerId, idx + 1) : null,
    };

    Renderer.showCardDetail(
      `Muro assegnato ${idx + 1} / ${walls.length}${def ? ' — ' + def.name : ''}`,
      bodyHTML,
      null, null, null, [],
      navOptions,
      def ? def.id : null
    );
  }

  // ---------------------------------------------------------------------------
  // Click bastione
  // ---------------------------------------------------------------------------

  function bindBastionClickHandlers() {
    ['my-bastion-left', 'my-bastion-right'].forEach(id => {
      const region = document.getElementById(id);
      if (!region) return;
      region.addEventListener('click', (e) => {
        if (e.target.closest('.card') || e.target.closest('.wall-card')) return;
        showBastionContents(id === 'my-bastion-left' ? 'left' : 'right');
      });
    });
  }

  function showBastionContents(side) {
    if (!currentState) return;
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    if (!myPlayer) return;

    const sideName = side === 'left' ? 'Sinistro' : 'Destro';
    const bastion = side === 'left' ? myPlayer.field.bastion_left : myPlayer.field.bastion_right;
    const walls = bastion.walls || [];
    const warriors = bastion.warriors || [];

    const body = document.getElementById('modal-body');
    body.innerHTML = '';

    if (walls.length === 0 && warriors.length === 0) {
      body.innerHTML = '<p style="color:var(--text-dim);font-style:italic;font-size:0.9rem">Bastione vuoto.</p>';
    } else {
      if (walls.length > 0) {
        const wallHeader = document.createElement('p');
        wallHeader.className = 'search-summary';
        wallHeader.textContent = `${walls.length} ${walls.length === 1 ? 'Muro' : 'Muri'}`;
        body.appendChild(wallHeader);

        const wallList = document.createElement('div');
        wallList.className = 'search-deck-list';
        walls.forEach(iid => {
          const def = getCardDef(iid);
          const name = def ? def.name : iid;
          const typeLabel = def
            ? (def.type === 'warrior' ? 'Guerriero' : def.type === 'spell' ? 'Magia' : 'Costruzione')
            : 'Carta';
          const div = document.createElement('div');
          div.className = 'search-deck-card search-match';
          div.innerHTML = `<span class="search-card-name">${name}</span><span class="search-card-type">${typeLabel}</span>`;
          div.addEventListener('click', () => {
            document.getElementById('modal-overlay').classList.add('hidden');
            showCardDetail(iid, 'wall');
          });
          wallList.appendChild(div);
        });
        body.appendChild(wallList);
      }

      if (warriors.length > 0) {
        const warriorHeader = document.createElement('p');
        warriorHeader.className = 'search-summary';
        if (walls.length > 0) warriorHeader.style.marginTop = '0.7rem';
        warriorHeader.textContent = `${warriors.length} ${warriors.length === 1 ? 'Guerriero' : 'Guerrieri'}`;
        body.appendChild(warriorHeader);

        const warriorList = document.createElement('div');
        warriorList.className = 'search-deck-list';
        warriors.forEach(w => {
          const div = document.createElement('div');
          div.className = 'search-deck-card search-match';
          div.innerHTML = `<span class="search-card-name">${w.name || w.base_card_id}</span>` +
            `<span class="search-card-type">🗡️${w.att} 🏹${w.git} 🛡️${w.dif}</span>`;
          div.addEventListener('click', () => {
            document.getElementById('modal-overlay').classList.add('hidden');
            showCardDetail(w.instance_id, 'field');
          });
          warriorList.appendChild(div);
        });
        body.appendChild(warriorList);
      }
    }

    document.getElementById('modal-title').textContent = `Bastione ${sideName}`;
    document.getElementById('modal-confirm').classList.add('hidden');
    const cancelBtn = document.getElementById('modal-cancel');
    cancelBtn.classList.remove('hidden');
    cancelBtn.textContent = 'Chiudi';
    cancelBtn.onclick = () => document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function showActiveSlideshow(items, idx) {
    const item = items[idx];
    const def = getCardDef(item.baseCardId);
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    let bodyHTML = '';

    if (def) {
      if (def.type === 'warrior') {
        bodyHTML += `<div class="detail-meta">
          <span class="species-${def.species}">${cap(def.species)}</span>
          ${def.school ? `· <span>${cap(def.school)}</span>` : ''}
          · ${def.subtype === 'hero' ? 'Eroe' : 'Recluta'}
          · 💎${def.cost} Mana
        </div>
        <div class="detail-stats">
          <span class="stat-att">🗡️ ATT ${def.att}</span>
          <span class="stat-git">🏹 GIT ${def.git}</span>
          <span class="stat-dif">🛡️ DIF ${def.dif}</span>
        </div>`;
        if (def.horde_effect) bodyHTML += `<div class="detail-section"><strong>Effetto Orda:</strong><br>${def.horde_effect}</div>`;
        if (def.evolves_from) bodyHTML += `<div class="detail-dim">Evolve da: ${cardDefs[def.evolves_from]?.name || def.evolves_from}</div>`;
        if (def.evolves_into) bodyHTML += `<div class="detail-dim">Evolve in: ${cardDefs[def.evolves_into]?.name || def.evolves_into}</div>`;
      } else if (def.type === 'spell') {
        bodyHTML += `<div class="detail-meta">
          <span class="school-${def.school}">${cap(def.school)}</span> · Magia · 🔮${def.cost} Maghe
        </div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.prodigy_effect) bodyHTML += `<div class="detail-section"><strong>Prodigio:</strong><br>${def.prodigy_effect}</div>`;
      } else if (def.type === 'building') {
        bodyHTML += `<div class="detail-meta">Costruzione · 💎${def.cost} Mana · 🏗️${def.completion_cost} Mana</div>
        <div class="detail-section"><strong>Effetto Base:</strong><br>${def.base_effect || '—'}</div>`;
        if (def.complete_effect) bodyHTML += `<div class="detail-section"><strong>Effetto Completo:</strong><br>${def.complete_effect}</div>`;
      }
    } else {
      bodyHTML = `<div class="detail-dim">${item.baseCardId}</div>`;
    }

    bodyHTML += `<div class="detail-section" style="color:var(--green-light)"><strong>Effetto Attivo:</strong><br>${item.desc}</div>`;

    const navOptions = {
      onPrev: idx > 0 ? () => showActiveSlideshow(items, idx - 1) : null,
      onNext: idx < items.length - 1 ? () => showActiveSlideshow(items, idx + 1) : null,
    };

    Renderer.showCardDetail(
      `✨ Attivo ${idx + 1} / ${items.length}${def ? ' — ' + def.name : ''}`,
      bodyHTML,
      null, null, null, [],
      navOptions,
      def ? def.id : null
    );
  }

  return {
    init,
    returnToLobby,
    getCardDef,
    onCardClick,
    sendAction,
    showWallSlideshow,
    showLifeSlideshow,
    showActiveSlideshow,
  };
})();

function returnToLobby() { App.returnToLobby(); }
function copyInviteLink() {
  _copyText(Invite.message(document.getElementById('lobby-code-text').textContent.trim()),
            'Link d\'invito copiato: mandalo ai tuoi amici!');
}

function _copyText(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => Renderer.toast(done, 'success'))
      .catch(() => _copyFallback(text, done));
  } else {
    _copyFallback(text, done);
  }
}

function _copyFallback(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    Renderer.toast(done, 'success');
  } catch (_) {
    Renderer.toast(text, '');
  }
  document.body.removeChild(ta);
}

document.addEventListener('DOMContentLoaded', () => App.init());
