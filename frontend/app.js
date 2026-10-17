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

  // Carte girate col doppio clic: trascinate in un Bastione diventano Muri
  // (ognuna subito, vedi _startFlippedWallDrag)
  const wallFlips = new Set();

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
  let tutorialCompletedShown = false;
  let tutorialCardsRead = new Set();  // carte già spiegate (base_card_id)

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
    bindHandDrag();
    _bindWallFlip();
    bindFieldDrag();
    Spotlight.keepVisible(['btn-abandon']);  // nel tutorial «Abbandona» resta scoperto
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
    // Con Riprendi in cima al menu, Gioca perde le punte in alto
    const play = document.getElementById('btn-mode-play');
    play.classList.toggle('menu-frame-alto', !state);
    play.classList.toggle('menu-frame-centro', !!state);
    if (!state) return;
    const others = state.players.filter(p => p.id !== saved.playerId).map(p => p.name);
    const kind = state.mode === 'practice' ? 'Giocatore singolo · ' : '';
    document.getElementById('btn-resume-sub').textContent =
      `${kind}Turno ${state.turn} · contro ${others.join(', ')}`;
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
    document.querySelectorAll('#waiting-bot-controls .wait-diff-btn').forEach(btn => {
      btn.addEventListener('click', () => editLobby('/lobby/bot_difficulty', { difficulty: btn.dataset.diff }));
    });
    document.getElementById('btn-end-turn').addEventListener('click', onEndTurn);
    document.getElementById('btn-battle').addEventListener('click', onBattleClick);
    document.getElementById('btn-horde').addEventListener('click', onHordeClick);
    document.getElementById('btn-next-phase').addEventListener('click', onNextPhase);
    document.getElementById('btn-abandon').addEventListener('click', onAbandonClick);
    bindBastionClickHandlers();

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
    document.getElementById('btn-tutorial').addEventListener('click', startTutorial);
    document.getElementById('tutorial-panel-prev').addEventListener('click', (e) => {
      // Schema della Battaglia aperto: si torna al passo senza attaccare
      if (tutorialBattlePreview) { tutorialBattlePreview = null; updateTutorialUI(currentState); return; }
      // Disabilitato fino al passo successivo: un doppio click tornerebbe indietro due volte.
      e.currentTarget.disabled = true;
      sendAction('tutorial_prev', {});
    });
    document.getElementById('tutorial-panel-next').addEventListener('click', (e) => {
      // Fine tutorial: si torna al menu senza ricaricare la pagina, che
      // interromperebbe la musica (il browser non la fa ripartire da solo).
      if (tutorialCompletedShown) { exitTutorial(); return; }
      // Disabilitato fino al passo successivo: un doppio click salterebbe un passo.
      e.currentTarget.disabled = true;
      // Schema della Battaglia aperto: «Attacca →» manda l'attacco scelto
      if (tutorialBattlePreview) {
        const params = tutorialBattlePreview;
        tutorialBattlePreview = null;
        tutorialBattleConfirmed = true;
        sendAction('battle', params);
        return;
      }
      sendAction('tutorial_next', {});
    });

    // Sfida un Bot
    document.getElementById('btn-mode-play').addEventListener('click', () => Renderer.showScreen('multiplayer'));
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
  // Tutorial — avvio e uscita
  // ---------------------------------------------------------------------------

  async function startTutorial() {
    try {
      const res = await api('/tutorial/start', { player_name: 'Giocatore' });
      sessionToken = res.session_token;
      myPlayerId = res.player_id;
      gameId = res.game_id;
      isTutorial = true;
      tutorialCompletedShown = false;
      tutorialCardsRead = new Set();
      enterGame(res.state);
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
    if (stopCardReading) stopCardReading();
    leavingGame = false;
    currentState = null;
    gameId = null;
    sessionToken = null;
    myPlayerId = null;
    isTutorial = false;
    Renderer.showScreen('lobby');
  }

  // ---------------------------------------------------------------------------
  // Tutorial — occhio di bue sul campo e pannello dei passi
  // ---------------------------------------------------------------------------

  // Tutto lo schermo si scurisce tranne le zone degli obiettivi ancora da fare
  // (spotlight.js); il pannello si piazza accanto e mostra il testo del passo,
  // il commento all'ultima mossa e la lista degli obiettivi. Il passo arriva
  // già pronto dal server (state.tutorial.step).
  // Testo sotto l'obiettivo corrente già mostrato: la lista si ricostruisce a
  // ogni aggiornamento (es. «Avanza Fase» premuto due volte), e il testo si
  // anima solo quando cambia, altrimenti sembra nuovo e da rileggere
  let _lastGoalText = null;

  function showTutorialStep(state) {
    const step = state.tutorial.step;
    const panel = document.getElementById('tutorial-panel');
    document.getElementById('tutorial-panel-progress').textContent = step.number ? `${step.number} di ${step.total}` : '';
    document.getElementById('tutorial-panel-title').textContent = step.title || '';
    // Passo di spiegazione: solo il testo. Passo con obiettivi: la lista, e
    // sotto l'obiettivo da fare ora il suo testo (all'inizio quello del passo,
    // poi il commento all'ultima mossa); quelli fatti sono spuntati, i
    // successivi attenuati.
    const text = document.getElementById('tutorial-panel-text');
    text.textContent = step.goals.length ? '' : (step.text || '');
    text.classList.toggle('hidden', !text.textContent);
    // Lo schema della Battaglia compare solo all'attacco (_previewTutorialBattle)
    document.getElementById('tutorial-panel-diagram').classList.add('hidden');
    panel.classList.remove('tut-panel-wide');
    const goals = document.getElementById('tutorial-panel-goals');
    goals.innerHTML = '';
    const current = step.goals.findIndex(g => !g.done);
    const lead = step.goals.some(g => g.done) ? step.feedback : step.text;
    step.goals.forEach((g, i) => {
      const li = document.createElement('li');
      li.className = g.done ? 'done' : i === current ? 'current' : 'todo';
      const label = document.createElement('span');
      label.textContent = g.label;
      li.appendChild(label);
      if (i === current && lead) {
        const p = document.createElement('div');
        p.className = 'tut-goal-text';
        p.textContent = lead;
        if (lead === _lastGoalText) p.style.animation = 'none';
        _lastGoalText = lead;
        li.appendChild(p);
      }
      goals.appendChild(li);
    });
    goals.classList.toggle('hidden', !step.goals.length);
    const nextBtn = document.getElementById('tutorial-panel-next');
    nextBtn.textContent = '›';
    nextBtn.classList.add('tut-arrow');
    nextBtn.classList.toggle('hidden', step.goals.length > 0);
    nextBtn.disabled = false;
    // «← Indietro» solo verso un passo di spiegazione, mai a prima di una mossa giocata
    const prevBtn = document.getElementById('tutorial-panel-prev');
    prevBtn.classList.toggle('hidden', !state.tutorial.can_go_back);
    prevBtn.disabled = false;
    panel.classList.remove('hidden');
    Spotlight.show(step.highlight || [], panel, { center: !!step.panel_center, avoid: TUTORIAL_AVOID, preferCenter: true });
  }

  // Cosa il pannello del tutorial evita di coprire, oltre alle zone evidenziate
  // (spotlight.js): avversari, cronaca e carte; ancora di più Mana, Azioni e
  // pulsanti. Le finestre di scelta no: passano sopra il pannello.
  const TUTORIAL_AVOID = [
    '#top-opponents', '#left-strip', '#right-strip', '#battle-log > *',
    ['#phase-bar', 5], ['#game-header .btn', 5],
    ['#my-field .card', 3], ['#hand-cards .card', 3], '#my-life-deck',
    ['#banner-turn-label', 20], ['#my-stats', 20], ['#action-panel .ap-right .btn', 20],
  ];

  // Fine tutorial: stesso pannello, centrato a schermo spento, con un solo
  // pulsante per tornare al menu.
  function showTutorialCompleted(outro) {
    document.getElementById('tutorial-panel-progress').textContent = '';
    document.getElementById('tutorial-panel-title').textContent = (outro && outro.title) || 'Tutorial completato!';
    document.getElementById('tutorial-panel-text').textContent = (outro && outro.text) || '';
    document.getElementById('tutorial-panel-text').classList.remove('hidden');
    const nextBtn = document.getElementById('tutorial-panel-next');
    nextBtn.textContent = 'Torna al menu ›';
    nextBtn.classList.remove('tut-arrow');
    nextBtn.classList.remove('hidden');
    nextBtn.disabled = false;
    ['tutorial-panel-prev', 'tutorial-panel-goals', 'tutorial-panel-diagram']
      .forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('tutorial-panel').classList.remove('tut-panel-wide');
    const panel = document.getElementById('tutorial-panel');
    panel.classList.remove('hidden');
    Spotlight.show([], panel);
  }

  function hideTutorialStep() {
    Spotlight.hide();
    document.getElementById('tutorial-panel').classList.add('hidden');
  }

  // Lettura di una carta al primo tocco in mano (solo le carte che il copione
  // spiega, state.tutorial.card_reads): si apre il dettaglio normale della
  // carta e, sopra l'immagine, un riquadro evidenzia una sezione alla volta,
  // spiegata in un pannello accanto. Finché la lettura non è finita i pulsanti
  // del dettaglio (Gioca, Chiudi…) restano spenti. rect è in % della carta.
  let stopCardReading = null;   // chiude la lettura in corso, se c'è

  function maybeReadCard(instanceId, openDetail) {
    const reads = isTutorial && currentState && currentState.tutorial && currentState.tutorial.card_reads;
    const def = getCardDef(instanceId);
    const sections = reads && def && reads[def.id];
    if (!sections || tutorialCardsRead.has(def.id)) return false;
    // Solo quando tocca al giocatore agire: nei passi di spiegazione si apre il
    // dettaglio normale e la carta resta da leggere per dopo
    const step = currentState.tutorial.step;
    if (!step || !step.goals.length) return false;
    tutorialCardsRead.add(def.id);
    hideTutorialStep();
    Renderer.afterCardShown(mode => _startCardReading(def, sections, mode));
    openDetail();
    return true;
  }

  function _startCardReading(def, sections, mode) {
    const overlay = document.getElementById('card-detail-overlay');
    const flip = document.getElementById('card-flip');
    const box = document.createElement('div');
    box.className = 'card-read-focus';
    if (mode === 'image') flip.querySelector('.card-flip-inner').appendChild(box);

    const panel = document.createElement('div');
    panel.id = 'card-read';
    panel.className = 'tut-panel menu-frame';
    panel.innerHTML = `
      <div class="tut-panel-progress"></div>
      <div class="tut-panel-title"></div>
      <div class="tut-panel-text"></div>
      <div class="tut-panel-actions">
        <button class="btn btn-secondary tut-arrow" title="Indietro" aria-label="Indietro">‹</button>
        <button class="btn btn-primary" title="Avanti" aria-label="Avanti">›</button>
      </div>`;
    overlay.appendChild(panel);
    const [prevBtn, nextBtn] = panel.querySelectorAll('button');

    overlay.classList.add('reading');
    flip.classList.add('reading');
    const backdropClick = overlay.onclick;
    overlay.onclick = null;

    // Pannello attaccato alla carta, a destra e centrato; se non c'è spazio, sotto
    const place = () => {
      const r = (mode === 'image' ? flip : document.getElementById('card-detail-box')).getBoundingClientRect();
      const pw = panel.offsetWidth, ph = panel.offsetHeight;
      const gap = 24, edge = 16;
      if (r.right + gap + pw <= window.innerWidth - edge) {
        panel.style.left = `${r.right + gap}px`;
        panel.style.top = `${Math.max(edge, Math.min(window.innerHeight - ph - edge, r.top + r.height / 2 - ph / 2))}px`;
      } else {
        panel.style.left = `${Math.max(edge, (window.innerWidth - pw) / 2)}px`;
        panel.style.top = `${Math.max(edge, window.innerHeight - ph - edge)}px`;
      }
    };
    window.addEventListener('resize', place);

    let i = 0;
    const render = () => {
      const s = sections[i];
      const [x, y, w, h] = s.rect;
      Object.assign(box.style, { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` });
      panel.querySelector('.tut-panel-progress').textContent = `${def.name} · ${i + 1} di ${sections.length}`;
      panel.querySelector('.tut-panel-title').textContent = s.title;
      panel.querySelector('.tut-panel-text').textContent = s.text;
      nextBtn.textContent = i < sections.length - 1 ? '›' : 'Ho capito';
      nextBtn.classList.toggle('tut-arrow', i < sections.length - 1);
      prevBtn.classList.toggle('invisible', i === 0);
      place();
    };
    stopCardReading = () => {
      stopCardReading = null;
      window.removeEventListener('resize', place);
      box.remove();
      panel.remove();
      overlay.classList.remove('reading');
      flip.classList.remove('reading');
      overlay.onclick = backdropClick;
    };
    prevBtn.onclick = (e) => { e.stopPropagation(); if (i > 0) { i--; render(); } };
    nextBtn.onclick = (e) => {
      e.stopPropagation();
      if (++i < sections.length) { render(); return; }
      // Letta la carta si torna al tavolo: si gioca trascinandola
      stopCardReading();
      Renderer.closeCardDetail();
      updateTutorialUI(currentState);
    };
    render();
  }

  function updateTutorialUI(state) {
    if (!isTutorial || !state.tutorial) {
      if (stopCardReading) stopCardReading();
      hideTutorialStep();
      return;
    }
    if (state.tutorial.completed || !state.tutorial.step) {
      if (stopCardReading) stopCardReading();
      if (!tutorialCompletedShown) {
        tutorialCompletedShown = true;
        showTutorialCompleted(state.tutorial.outro);
      }
      return;
    }
    // Durante la lettura di una carta il pannello resta nascosto, e lo schema
    // della Battaglia resta finché non si conferma o si torna indietro
    if (stopCardReading || tutorialBattlePreview) return;
    showTutorialStep(state);
  }

  // Schema della Battaglia nel tutorial (step.battle_diagram): quando il
  // giocatore sceglie di attaccare il Bastione indicato, prima di mandare
  // l'attacco il pannello mostra come si calcola; «Attacca →» lo conferma,
  // «← Indietro» torna al passo senza attaccare.
  let tutorialBattlePreview = null;   // parametri dell'attacco in attesa di conferma
  let tutorialBattleConfirmed = false;

  function _previewTutorialBattle(params) {
    if (tutorialBattleConfirmed) { tutorialBattleConfirmed = false; return false; }
    const step = isTutorial && currentState && currentState.tutorial && currentState.tutorial.step;
    const diagram = step && step.battle_diagram;
    if (!diagram || params.defender_bastion_side !== diagram.side) return false;
    tutorialBattlePreview = params;
    const panel = document.getElementById('tutorial-panel');
    document.getElementById('tutorial-panel-title').textContent = diagram.title;
    document.getElementById('tutorial-panel-text').classList.add('hidden');
    document.getElementById('tutorial-panel-goals').classList.add('hidden');
    const box = document.getElementById('tutorial-panel-diagram');
    box.innerHTML = '';
    box.appendChild(TutorialDiagram.render(diagram));
    box.classList.remove('hidden');
    const nextBtn = document.getElementById('tutorial-panel-next');
    nextBtn.textContent = 'Attacca ›';
    nextBtn.classList.remove('tut-arrow');
    nextBtn.classList.remove('hidden');
    nextBtn.disabled = false;
    const prevBtn = document.getElementById('tutorial-panel-prev');
    prevBtn.classList.remove('hidden');
    prevBtn.disabled = false;
    panel.classList.add('tut-panel-wide');
    panel.classList.remove('hidden');
    Spotlight.show([], panel);
    return true;
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
    waitingSeatsKey = '';
    document.getElementById('waiting-players').innerHTML = '';
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
  let waitingSeatsKey = '';
  const LOBBY_SEATS = 4;

  function updateWaitingRoom(lobby) {
    // Il creatore può cambiare: se esce, il ruolo passa al primo umano rimasto
    isCreator = lobby.creator_id === myPlayerId;
    waitingPlayers = lobby.players;
    updateWaitingPlayers(lobby.players);

    const n = lobby.players.length;
    const start = document.getElementById('btn-start');
    start.hidden = !isCreator;
    start.disabled = !lobby.can_start;
    // La difficoltà serve solo se c'è almeno un Bot
    document.getElementById('waiting-bot-controls').hidden = !isCreator || !lobby.players.some(p => p.is_bot);
    const difficulty = lobby.bot_difficulty || 'normal';
    document.querySelectorAll('#waiting-bot-controls .wait-diff-btn').forEach(btn => {
      const on = btn.dataset.diff === difficulty;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  // Posti al tavolo: l'ordine conta perché i Bastioni confinano con quelli dei
  // vicini, quindi il creatore può riordinare i giocatori (e rimuovere i Bot).
  // Il polling arriva ogni 2 s: si ridisegna solo se è cambiato qualcosa,
  // altrimenti l'elenco sfarfalla (e i pulsanti perdono l'hover).
  function updateWaitingPlayers(players) {
    const key = JSON.stringify([isCreator, myPlayerId, players.map(p => [p.player_id, p.name, p.is_bot])]);
    if (key === waitingSeatsKey) return;
    waitingSeatsKey = key;

    const list = document.getElementById('waiting-players');
    const shown = new Set([...list.querySelectorAll('[data-pid]')].map(n => n.dataset.pid));
    list.innerHTML = '';
    for (let i = 0; i < LOBBY_SEATS; i++) {
      const p = players[i];
      const seat = document.createElement('div');
      // Colore del posto: lo stesso del giocatore nella cronaca (--seat-N)
      seat.style.setProperty('--seat-color', `var(--seat-${i})`);
      const hex = `<span class="seat-hex"><span>${i + 1}</span></span>`;
      if (!p) {
        seat.className = 'wait-seat empty';
        seat.innerHTML = `${hex}<span class="seat-name">Posto libero</span>`;
        // Il Bot si siede nel primo posto libero: il pulsante sta lì
        if (isCreator && i === players.length) {
          const add = document.createElement('button');
          add.className = 'seat-add';
          add.textContent = '+ Bot';
          add.title = 'Aggiungi un Bot in questo posto';
          add.addEventListener('click', () => editLobby('/lobby/add_bot'));
          seat.appendChild(add);
        }
        list.appendChild(seat);
        continue;
      }
      seat.className = 'wait-seat' + (p.is_bot ? ' bot' : '') + (shown.size && !shown.has(p.player_id) ? ' seat-enter' : '');
      seat.dataset.pid = p.player_id;
      const tag = p.is_bot ? 'Bot' : (p.player_id === myPlayerId ? 'tu' : '');
      seat.innerHTML = `${hex}<span class="seat-name"></span>` + (tag ? `<span class="seat-tag">${tag}</span>` : '');
      seat.querySelector('.seat-name').textContent = p.name;
      if (isCreator) {
        const tools = document.createElement('span');
        tools.className = 'seat-tools';
        const btn = (label, title, disabled, onClick) => {
          const b = document.createElement('button');
          b.className = 'seat-btn';
          b.textContent = label;
          b.title = title;
          b.disabled = disabled;
          b.addEventListener('click', onClick);
          tools.appendChild(b);
        };
        btn('▲', 'Sposta su', i === 0, () => moveWaitingPlayer(i, -1));
        btn('▼', 'Sposta giù', i === players.length - 1, () => moveWaitingPlayer(i, 1));
        if (p.is_bot) btn('✕', 'Rimuovi Bot', false, () => editLobby('/lobby/remove_bot', { bot_id: p.player_id }));
        seat.appendChild(tools);
      }
      list.appendChild(seat);
    }
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
      DragPlay.reject();
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

    // I miei tiri di D10: a inizio del mio turno (Estrattore) dopo il banner,
    // a fine turno (Granaio) prima del banner del giocatore successivo
    const turnChanged = prevTurnPlayer !== state.current_player_id && !state.winner_id;
    const myTurnStarts = turnChanged && state.current_player_id === myPlayerId;
    Dice.fromState(state, myPlayerId, cardDefs, { silent: !action, delay: myTurnStarts ? 1700 : 0 });
    if (turnChanged) {
      if (myTurnStarts) _showTurnBanner(state);
      else Dice.afterRolls(() => {
        // Nel frattempo il turno può essere già passato oltre
        if (currentState.current_player_id === state.current_player_id) _showTurnBanner(state);
      });
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

    // Nel tutorial la vittoria sul Manichino chiude il copione (pannello finale)
    if (state.winner_id && !isTutorial) {
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
    Dice.fromState(state, myPlayerId, cardDefs, { silent: true });
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
    // Guerrieri trascinabili (illuminati appena) durante il mio Schieramento
    document.getElementById('my-field').classList.toggle('can-reposition', _canReposition());
    // Le carte della mano restano le stesse tra un disegno e l'altro: le spente
    // si riaccendono, e _showBanner rispegne quelle da spegnere
    document.querySelectorAll('#hand-cards .card.unplayable').forEach(c => c.classList.remove('unplayable'));
    _applyWallFlips();

    const hide = id => document.getElementById(id).classList.add('hidden');
    const show = id => document.getElementById(id).classList.remove('hidden');

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

    if (phase === 'action') {
      if (player && (player.actions_remaining > 0 || player.wall_slots > 0 || _hasFreeActions(player))) {
        _showBanner(player);
      } else {
        document.getElementById('action-hint').textContent = 'Nessuna azione rimasta.';
      }
      show('btn-next-phase');
      document.getElementById('btn-next-phase').textContent = 'Schieramento ›';

    } else if (phase === 'schieramento') {
      document.getElementById('action-hint').textContent = 'Sposta i Guerrieri e attiva le Orde.';
      const hasHorde = player && player.available_hordes && player.available_hordes.length > 0;
      if (hasHorde) show('btn-horde');
      show('btn-next-phase');
      document.getElementById('btn-next-phase').textContent = 'Battaglia ›';

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
    // Azioni finite: restano solo le giocate che non consumano Azioni (Orde, eterea, Decumano)
    const noActions = player.actions_remaining <= 0;
    const rem = player.actions_remaining;
    // Muri posati da poco: i successivi (fino a 3) rientrano nella stessa Azione
    const slots = player.wall_slots || 0;
    document.getElementById('banner-turn-label').textContent = slots > 0
      ? `Ancora ${slots} Mur${slots === 1 ? 'o' : 'i'} in quest'Azione · ${rem} Azion${rem === 1 ? 'e' : 'i'} rimast${rem === 1 ? 'a' : 'e'}`
      : noActions
      ? `Azioni esaurite · ${_freeActionsLabel(player)}`
      : `Azione ${actNum} · ${rem} rimast${rem === 1 ? 'a' : 'e'}`;

    document.getElementById('action-banner').classList.remove('hidden');
    document.getElementById('action-hint').textContent = '';
    _updatePlayableMarkings(player);
  }

  // Senza Azioni restano "accese" solo le carte giocabili gratis (vedi
  // _isFreePlay) e, se l'Azione dei Muri è ancora aperta, quelle girate
  function _updatePlayableMarkings(player) {
    const dim = player.actions_remaining <= 0;
    document.querySelectorAll('#hand-cards .card').forEach(card => {
      const iid = card.dataset.instanceId;
      const playable = !dim || _isFreePlay(player, iid) || (wallFlips.has(iid) && player.wall_slots > 0);
      card.classList.toggle('unplayable', !playable);
    });
  }

  // ---------------------------------------------------------------------------
  // Muri
  // ---------------------------------------------------------------------------

  // Doppio clic su una carta in mano: si gira per essere giocata come Muro, o
  // torna di fronte
  function _bindWallFlip() {
    document.getElementById('hand-cards').addEventListener('dblclick', e => {
      const card = e.target.closest('.card');
      if (!card || !card.dataset.instanceId) return;
      const iid = card.dataset.instanceId;
      const on = !wallFlips.has(iid);
      if (on) wallFlips.add(iid); else wallFlips.delete(iid);
      CardArt.flipWall(card, on);
      const me = currentState && currentState.players.find(p => p.id === myPlayerId);
      if (me && currentState.current_player_id === myPlayerId && currentState.phase === 'action') {
        _updatePlayableMarkings(me);
      }
    });
  }

  // Dopo ogni ridisegno della mano: le carte girate restano girate (senza
  // rifare il giro); quelle uscite dalla mano si dimenticano
  function _applyWallFlips() {
    const inHand = new Set();
    document.querySelectorAll('#hand-cards .card').forEach(card => {
      const iid = card.dataset.instanceId;
      inHand.add(iid);
      if (wallFlips.has(iid)) CardArt.flipWall(card, true, true);
    });
    [...wallFlips].forEach(iid => { if (!inHand.has(iid)) wallFlips.delete(iid); });
  }

  // Perché ora non si può alzare un Muro (o null)
  function _wallRefusal() {
    if (!currentState || currentState.current_player_id !== myPlayerId) return 'Non è il tuo turno.';
    if (currentState.phase !== 'action') return 'I Muri si alzano nella fase Azioni.';
    const me = currentState.players.find(p => p.id === myPlayerId);
    if (!me || !(me.actions_remaining > 0 || me.wall_slots > 0)) return 'Azioni esaurite per questo turno.';
    return null;
  }

  // Altre carte girate in mano, le più vicine, da impilare sotto `card` e posare con lei: quante
  // ne restano nell'Azione dei Muri aperta, altrimenti fino a 3 con una nuova
  function _wallStack(card) {
    if (_wallRefusal()) return [];
    const me = currentState.players.find(p => p.id === myPlayerId);
    const cap = me.wall_slots > 0 ? me.wall_slots : 3;
    // Le più vicine in mano a quella premuta
    const cx = c => { const r = c.getBoundingClientRect(); return r.left + r.width / 2; };
    const x0 = cx(card);
    return [...document.querySelectorAll('#hand-cards .card')]
      .filter(c => c !== card && wallFlips.has(c.dataset.instanceId))
      .sort((c1, c2) => Math.abs(cx(c1) - x0) - Math.abs(cx(c2) - x0))
      .slice(0, cap - 1);
  }

  // Carta girata trascinata in un Bastione: diventa subito un Muro (con le
  // carte impilate sotto, extras, tutte nello stesso Bastione)
  function _startFlippedWallDrag(card, x, y, extras = []) {
    const err = _wallRefusal();
    if (err) { Renderer.toast(err, 'error'); return false; }
    const iids = [card, ...extras].map(c => c.dataset.instanceId);
    const zones = ['left', 'right'].map(side => ({ key: side, el: document.getElementById(`my-bastion-${side}`) }));
    DragPlay.start(card, x, y, {
      zones, extras,
      onDrop: side => {
        sendAction('add_wall', { walls: iids.map(iid => ({ instance_id: iid, bastion: side })) });
        return true;
      },
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Interazione carte
  // ---------------------------------------------------------------------------

  function onCardClick(instanceId, source) {
    if (!currentState) return;

    if (['hand', 'field', 'village', 'opponent'].includes(source) && !cardHasDetail(instanceId, source)) return;

    // Nel tutorial, il clic su una carta in mano da spiegare apre la lettura
    // (una volta sola): mostra il dettaglio e lo chiude a lettura finita
    const detail = () => showCardDetail(instanceId, source === 'life_card' ? 'life_card' : source);
    if (source === 'hand') { maybeReadCard(instanceId, detail); return; }
    detail();
  }

  // Le carte si giocano e si spostano trascinandole, e si guardano passandoci
  // sopra: il clic apre il dettaglio solo dove ha pulsanti propri (Attiva Arena,
  // Completa, carte assegnate, Recluta sotto l'Eroe). Nella mano solo il tutorial lo usa,
  // per la lettura delle carte (onCardClick). I mazzi (Vite, Muri…) hanno i loro clic.
  function cardHasDetail(instanceId, source) {
    if (source === 'hand') return isTutorial;
    if (!currentState) return false;
    const def = getCardDef(instanceId);
    if (def && def.type === 'building') {
      if (source !== 'village') return false;
      // Arena (Attiva) e Costruzioni incomplete (Completa, dal dettaglio)
      const me = currentState.players.find(p => p.id === myPlayerId);
      const b = me && (me.field.village.buildings || []).find(x => x.instance_id === instanceId);
      return def.id === 'arena' || !!(b && !b.completed);
    }
    for (const p of currentState.players) {
      const w = _getAllWarriors(p).find(x => x.instance_id === instanceId);
      if (w) return (w.assigned_cards || []).length > 0 || !!w.evolved_from;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Giocare le carte trascinandole dalla mano al campo (drag.js)
  // ---------------------------------------------------------------------------

  const _DROP_ZONE_IDS = {
    bastion_left: 'my-bastion-left', vanguard: 'my-vanguard',
    bastion_right: 'my-bastion-right', village: 'my-village',
  };

  // Nel mio turno, in fase Azioni
  function _canDragFromHand() {
    if (!currentState) return false;
    return currentState.current_player_id === myPlayerId && currentState.phase === 'action';
  }

  // Perché la carta ora non si può giocare (o null). Si trascina lo stesso, verso
  // il centro del tavolo come una Magia, e al rilascio torna in mano con l'errore.
  function _dragRefusal(iid, def, me, keys) {
    if (!(me.actions_remaining > 0 || _isFreePlay(me, iid))) return 'Azioni esaurite per questo turno.';
    const err = _playError(iid);
    if (err) return err;
    if (keys.length) return null;
    return def && def.type === 'warrior'
      ? `Nessuna Recluta compatibile in campo per evolvere ${def.name}.`
      : 'Non hai nessun Guerriero in campo a cui assegnare il Trono.';
  }

  // Pressione del mouse su una carta di `container` (pick(target) → la carta, o
  // null): oltre qualche pixel di movimento parte il trascinamento (start(card,
  // x, y) → false se non si può), e il click che segue il rilascio non apre il
  // dettaglio. hold(card, x, y), se c'è, è la pressione prolungata a mouse fermo:
  // se ritorna true ha già fatto partire il trascinamento.
  function _bindPressDrag(container, pick, start, hold = null) {
    const HOLD_MS = 280;
    let press = null;
    let suppressClick = false;

    container.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const card = pick(e.target);
      if (!card) return;
      const p = { card, x: e.clientX, y: e.clientY, dragging: false, timer: null };
      if (hold) {
        p.timer = setTimeout(() => {
          p.timer = null;
          if (press === p && !p.dragging && hold(p.card, p.x, p.y)) p.dragging = true;
        }, HOLD_MS);
      }
      press = p;
    });
    window.addEventListener('pointermove', e => {
      if (!press) return;
      if (!press.dragging) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
        clearTimeout(press.timer);
        if (!start(press.card, e.clientX, e.clientY)) { press = null; return; }
        press.dragging = true;
      }
      DragPlay.move(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', e => {
      if (!press) return;
      clearTimeout(press.timer);
      if (press.dragging) {
        DragPlay.end(e.clientX, e.clientY);
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
      press = null;
    });
    window.addEventListener('pointercancel', () => {
      if (press) clearTimeout(press.timer);
      if (press && press.dragging) DragPlay.cancel();
      press = null;
    });
    container.addEventListener('click', e => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
    }, true);
  }

  function bindHandDrag() {
    _bindPressDrag(document.getElementById('hand-cards'),
      t => {
        // Carte girate (Muri): l'errore, se non si possono posare, al trascinamento
        const c = t.closest('.card');
        if (c && wallFlips.has(c.dataset.instanceId)) return c;
        return _canDragFromHand() ? c : null;
      },
      (card, x, y) => (wallFlips.has(card.dataset.instanceId) ? _startFlippedWallDrag(card, x, y)
        : _startHandDrag(card, x, y)),
      // Tenendo premuto su una carta girata, le altre girate le si impilano sotto
      (card, x, y) => {
        if (!wallFlips.has(card.dataset.instanceId)) return false;
        const extras = _wallStack(card);
        return extras.length > 0 && _startFlippedWallDrag(card, x, y, extras);
      });
  }

  // -- Schieramento: i miei Guerrieri si trascinano su un'altra Regione --------

  function _canReposition() {
    return !!currentState && currentState.current_player_id === myPlayerId
      && currentState.phase === 'schieramento';
  }

  // Regione (chiave) di un mio Guerriero in campo, dal suo elemento
  function _regionOfFieldCard(card) {
    const region = card.closest('.region');
    return region && Object.keys(_DROP_ZONE_IDS).find(k => k !== 'village' && _DROP_ZONE_IDS[k] === region.id);
  }

  function bindFieldDrag() {
    _bindPressDrag(document.getElementById('my-field'), t => {
      if (!_canReposition()) return null;
      const card = t.closest('.card.in-field[data-type="warrior"]');
      return card && _regionOfFieldCard(card) ? card : null;
    }, (card, x, y) => {
      const iid = card.dataset.instanceId;
      const from = _regionOfFieldCard(card);
      const zones = ['bastion_left', 'vanguard', 'bastion_right'].filter(k => k !== from)
        .map(k => ({ key: k, el: document.getElementById(_DROP_ZONE_IDS[k]) }));
      DragPlay.start(card, x, y, {
        zones,
        onDrop: dest => {
          sendAction('reposition', { warrior_instance_id: iid, destination: dest });
          return true;
        },
      });
      return true;
    });
  }

  function _startHandDrag(card, x, y) {
    const iid = card.dataset.instanceId;
    // Tutorial: una carta da spiegare non ancora letta apre la lettura invece di partire
    if (maybeReadCard(iid, () => showCardDetail(iid, 'hand'))) return false;
    const def = getCardDef(iid);
    const me = currentState.players.find(p => p.id === myPlayerId);
    const keys = DragPlay.zonesFor(def, me, getCardDef);
    // Verso il campo: oltre un po' sotto la metà del mio campo (Magie e carte
    // che non si possono giocare)
    const towardField = (px, py) => {
      const r = document.getElementById('my-field').getBoundingClientRect();
      return py < r.top + r.height * 0.6;
    };
    const refusal = _dragRefusal(iid, def, me, keys);
    if (refusal) {
      DragPlay.start(card, x, y, {
        zones: [], fieldTest: towardField, noGlow: true,
        onDrop: () => { Renderer.toast(refusal, 'error'); return false; },
      });
      return true;
    }
    const isHero = def.type === 'warrior' && def.subtype === 'hero';
    const zones = isHero ? [] : keys.filter(k => _DROP_ZONE_IDS[k])
      .map(k => ({ key: k, el: document.getElementById(_DROP_ZONE_IDS[k]) }))
      .filter(z => z.el);
    // Trono ed Eroi: si lasciano sul Guerriero (per l'Eroe, una Recluta che evolve
    // in lui), che si illumina solo quando ci si è sopra
    if (keys.includes('warriors') || isHero) {
      DragPlay.warriorsOf(me).forEach(w => {
        if (isHero) {
          const d = getCardDef(w.instance_id);
          if (!d || d.evolves_into !== def.id) return;
        }
        const el = document.querySelector(`#my-field .card[data-instance-id="${CSS.escape(w.instance_id)}"]`);
        if (el) zones.push({ key: `warrior:${w.instance_id}`, el, quiet: true });
      });
    }
    // Magie: basta portarle sopra la mano, verso il campo
    const fieldTest = keys.includes('field') ? towardField : null;
    DragPlay.start(card, x, y, {
      zones, fieldTest, onDrop: key => _playDropped(iid, def, key),
      // Selettori e conferme (modal-overlay), scelta di un Muro (dettaglio carta)
      choiceOpen: () => ['modal-overlay', 'card-detail-overlay']
        .some(id => !document.getElementById(id).classList.contains('hidden')),
    });
    return true;
  }

  // Ritorna true se l'azione è già partita (la carta resta dove è stata lasciata)
  function _playDropped(iid, def, key) {
    const me = currentState.players.find(p => p.id === myPlayerId);
    if (def.type === 'spell') return _showSpellOptions(iid, def, { direct: true }) === true;
    if (key.startsWith('warrior:')) {  // Trono o Eroe lasciato su un Guerriero
      const target = key.slice('warrior:'.length);
      if (def.type === 'warrior') sendAction('evolve', { recruit_instance_id: target, hero_instance_id: iid });
      else sendAction('play_building', { instance_id: iid, target_warrior_iid: target });
      return true;
    }
    if (def.type === 'building') {
      sendAction('play_building', { instance_id: iid });
      return true;
    }
    sendAction('play_warrior', { instance_id: iid, region: key });
    return true;
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
        ? (fieldBuilding.completed ? ' · <span style="color:var(--gold-light)">✓ Completata</span>' : ' · <span style="color:var(--text-dim)">Incompleta</span>')
        : '';
      const baseLabel = (fieldBuilding && !fieldBuilding.completed) ? 'Effetto Base <span style="color:var(--green-light)">(attivo)</span>'
        : (fieldBuilding && fieldBuilding.completed) ? 'Effetto Base <span style="color:var(--text-dim)">(non attivo)</span>'
        : 'Effetto Base';
      const completeLabel = (fieldBuilding && fieldBuilding.completed) ? 'Effetto Completo <span style="color:var(--green-light)">(attivo)</span>'
        : (fieldBuilding && !fieldBuilding.completed) ? 'Effetto Completo <span style="color:var(--text-dim)">(non attivo)</span>'
        : 'Effetto Completo';
      const me = currentState && currentState.players.find(p => p.id === myPlayerId);
      const discount = me ? _reinholdDiscount(me) : 0;
      bodyHTML += `<div class="detail-meta">Costruzione · 💎${_costLabel(def.cost, discount)} Mana · 🏗️${_costLabel(def.completion_cost, discount)} Mana${completionStatus}</div>
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
      const player = currentState.players.find(p => p.id === myPlayerId);
      if (player && (player.actions_remaining > 0 || _isFreePlay(player, instanceId))) {
        actionLabel = 'Gioca';
        onAction = () => { Renderer.closeCardDetail(); showPlayOptions(instanceId, def); };
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

  // Perché la carta in mano ora non si può giocare (Mana/Maghe, dal server), o null
  function _playError(instanceId) {
    const me = currentState && currentState.players.find(p => p.id === myPlayerId);
    return (me && me.play_errors && me.play_errors[instanceId]) || null;
  }

  function showPlayOptions(instanceId, def) {
    const err = _playError(instanceId);
    if (err) { Renderer.toast(err, 'error'); return; }
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
      const me = currentState.players.find(p => p.id === myPlayerId);
      const cost = me && me.ethereal_card === instanceId ? 0 : _costLabel(def.cost, me ? _reinholdDiscount(me) : 0);
      Renderer.showModal(
        `Costruisci ${def.name}`,
        `Costo: <strong>${cost} Mana</strong><br>${def.base_effect || ''}`,
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

  // Giocate che non consumano Azioni (stesse regole di play_spell/play_building/
  // complete_building): carta eterea, Incantesimi a costo 1 con l'Orda di Madeleine,
  // Costruzioni giocate con l'Orda di Faust o completate con quella di Joseph,
  // Cardo con Decumano, completamento di Velocemento.
  function _hasEffect(player, type) {
    return (player.active_effects || []).some(e => e.type === type);
  }

  function _isFreePlay(player, iid) {
    const def = getCardDef(iid);
    if (!def) return false;
    if (player.ethereal_card === iid) return true;
    if (def.type === 'building') return _hasEffect(player, 'faust_free_play_building');
    return def.type === 'spell' && def.school === 'incantesimo' && def.cost === 1 &&
      _hasEffect(player, 'madeleine_free_action');
  }

  function _isFreeComplete(player, b) {
    const buildings = player.field.village.buildings || [];
    return player.ethereal_complete === b.instance_id ||
      (b.base_card_id === 'cardo' && buildings.some(x => x.base_card_id === 'decumano')) ||
      _hasEffect(player, 'joseph_free_complete_building');
  }

  function _hasFreePlays(player) {
    return (player.hand || []).some(iid => _isFreePlay(player, iid));
  }

  function _hasFreeCompletes(player) {
    return (player.field.village.buildings || []).some(b => !b.completed && _isFreeComplete(player, b));
  }

  function _hasFreeActions(player) {
    return _hasFreePlays(player) || _hasFreeCompletes(player);
  }

  function _freeActionsLabel(player) {
    const parts = [];
    if (_hasFreePlays(player)) parts.push('gioca le carte accese');
    if (_hasFreeCompletes(player)) parts.push('completa Costruzioni');
    return parts.length ? `puoi ancora: ${parts.join(', ')}` : 'nessuna giocata gratuita';
  }

  // Orda di Reinhold: Costruzioni giocate e completate costano meno
  function _reinholdDiscount(player) {
    return (player.active_effects || [])
      .filter(e => e.type === 'reinhold_building_discount')
      .reduce((sum, e) => sum + (e.discount || 0), 0);
  }

  function _costLabel(cost, discount) {
    const eff = Math.max(0, cost - discount);
    return eff !== cost ? `${cost}→${eff}` : `${cost}`;
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

  // opts.direct: la Magia è stata trascinata in campo, quindi senza bersagli si
  // lancia subito, senza conferma (e la funzione ritorna true)
  function _showSpellOptions(instanceId, def, opts = {}) {
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
      if (opts.direct) {
        sendAction('play_spell', { instance_id: instanceId });
        return true;
      }
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
    DragPlay.sent();
    // Nel tutorial l'attacco può passare prima dallo schema della Battaglia
    if (action === 'battle' && _previewTutorialBattle(params)) return;
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
      DragPlay.reject();
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
    // Nel tutorial si torna al menu (l'avversario è il Manichino)
    if (isTutorial) {
      Renderer.showModal('Abbandona il tutorial', 'Sei sicuro? Tornerai al menu.', exitTutorial);
      return;
    }
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
    currentState = null;
    gameId = null;
    lobbyCode = null;
    sessionToken = null;
    myPlayerId = null;
    isTutorial = false;
    hideTutorialStep();
    if (stopCardReading) stopCardReading();
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
    cardHasDetail,
    sendAction,
    showWallSlideshow,
    showLifeSlideshow,
    showActiveSlideshow,
  };
})();

function returnToLobby() { App.returnToLobby(); }
function copyInviteLink() {
  _copyText(Invite.message(document.getElementById('lobby-code-text').textContent.trim()),
            'Link d\'invito copiato');
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
