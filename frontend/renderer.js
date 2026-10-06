/**
 * renderer.js — Rendering del campo da gioco di Barbacane
 * Costruisce il DOM a partire dallo stato di gioco ricevuto dal server.
 */

const Renderer = (() => {

  // ---------------------------------------------------------------------------
  // Render dello stato completo
  // ---------------------------------------------------------------------------

  let _myPlayerId = null;
  let _lastState = null;

  function render(state, myPlayerId) {
    if (!state) return;
    _myPlayerId = myPlayerId;
    _lastState = state;

    document.getElementById('hdr-turn').textContent = `Turno ${state.turn}`;
    document.getElementById('hdr-phase').textContent = `Fase: ${phaseLabel(state.phase)}`;
    document.getElementById('hdr-current-player').textContent =
      `Il turno di: ${getPlayerName(state, state.current_player_id)}`;
    document.getElementById('hdr-deck').textContent = `Mazzo: ${state.deck_count}`;

    const myPlayer = state.players.find(p => p.id === myPlayerId);

    renderTableLayout(state, myPlayerId);

    if (myPlayer) renderMyField(myPlayer, state, myPlayerId);
    updateActionPanel(state, myPlayerId);
    fitCards(state, myPlayerId);
  }

  // ---------------------------------------------------------------------------
  // Dimensione delle carte (mano e campo)
  //
  // Il tavolo è un tabellone fisso: le Regioni del mio campo hanno un'altezza
  // che non dipende da quante carte contengono (le carte scorrono in
  // orizzontale). La dimensione delle carte si calcola quindi una volta sola,
  // all'ingresso al tavolo e quando cambia la finestra, la più grande per cui
  // tutto ci sta: riga dei Bastioni, Villaggio e mano.
  // Lo spazio degli avversari in cima è riservato già pieno (tasselli con
  // Guerrieri, Muri e Costruzioni), così non cresce durante la partita.
  // ---------------------------------------------------------------------------

  const CARD_RATIO = 7 / 10;     // larghezza / altezza delle minicarte (280×400)
  const CARD_H_MIN = 90;
  const CARD_H_MAX = 190;
  const FIT_RESERVE = 12;        // margine per il pannello azioni che va a capo
  let _fitKey = null;

  function _setCardSize(h) {
    const root = document.documentElement.style;
    const w = Math.round(h * CARD_RATIO);
    root.setProperty('--card-w-hand', `${w}px`);
    root.setProperty('--card-h-hand', `${h}px`);
    root.setProperty('--card-w-field', `${w}px`);
    root.setProperty('--card-h-field', `${h}px`);
  }

  // Altezza del riassunto di un avversario in cima con tutte le Regioni occupate
  function _fullOpponentHeight(state, myPlayerId) {
    const topArea = document.getElementById('top-opponents');
    const opp = state.players.find(p => p.id !== myPlayerId);
    if (!opp) return 0;
    const ws = Array.from({ length: 8 }, (_, i) =>
      ({ instance_id: `probe_${i}`, species: ['elfo', 'nano', 'maga', 'umano'][i % 4], att: 10, git: 10, dif: 10 }));
    const bastion = { walls: [], wall_count: 3, warriors: ws };
    const full = {
      ...opp, lives: 3,
      field: {
        vanguard: ws, bastion_left: bastion, bastion_right: bastion,
        village: { buildings: [{ completed: true }, { completed: false }] },
      },
    };
    const probe = renderOpponentSummary(full, state, 'row');
    probe.classList.add('active-player');
    const saved = Array.from(topArea.childNodes);
    topArea.replaceChildren(probe);
    const h = topArea.getBoundingClientRect().height;
    topArea.replaceChildren(...saved);
    return h;
  }

  function fitCards(state, myPlayerId, force = false) {
    const topArea = document.getElementById('top-opponents');
    const column = document.getElementById('center-column');
    const surface = document.getElementById('table-surface');
    const field = document.getElementById('my-field');
    if (!column || !column.offsetParent) return;
    const hasTop = topArea.childElementCount > 0;
    const key = `${window.innerWidth}x${window.innerHeight}|${state.players.length}|${hasTop}`;
    if (!force && key === _fitKey) return;
    _fitKey = key;

    column.classList.add('fitting');
    const bar = document.getElementById('center-bar');
    // Quanto potrà ancora crescere l'avversario in cima: lo lascia libero
    // #table-surface, sopra il mio campo (le strip laterali non ne risentono).
    // Una parte la cede la cronaca, che può scendere da 3 righe a una.
    // Misure a schermo (getBoundingClientRect): avversari e cronaca possono
    // avere uno zoom CSS (style.css, schermi non alti), la colonna no.
    const topExtra = hasTop
      ? Math.max(0, _fullOpponentHeight(state, myPlayerId) - topArea.getBoundingClientRect().height) : 0;
    let barShrink = 0;
    if (bar) {
      const cs = getComputedStyle(bar);
      const own = parseFloat(cs.height), min = parseFloat(cs.minHeight) || 0;
      if (own > 0) barShrink = bar.getBoundingClientRect().height * (1 - min / own);
    }
    const reserve = FIT_RESERVE + Math.max(0, topExtra - barShrink);

    // Lo spazio richiesto cresce di 3 altezze di carta per ogni pixel in più
    // (riga dei Bastioni, Villaggio, mano): si parte da una misura e si corregge.
    let h = CARD_H_MAX;
    _setCardSize(h);
    for (let i = 0; i < 3; i++) {
      const avail = column.clientHeight - reserve;
      const need = column.clientHeight - surface.offsetHeight + (field.scrollHeight - field.clientHeight);
      const next = Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, Math.floor(h + (avail - need) / 3)));
      if (next === h) break;
      h = next;
      _setCardSize(h);
    }
    column.classList.remove('fitting');
    _panelHeight = _measurePanel();
  }

  // Il pannello azioni si riempie dopo il primo disegno (app.js) e può andare
  // a capo: se diventa più alto di quanto misurato si ricalcola (solo in
  // crescita, così le carte non cambiano a ogni azione)
  let _panelHeight = 0;
  function _measurePanel() {
    return document.getElementById('action-panel')?.offsetHeight || 0;
  }
  if (window.ResizeObserver) {
    const panel = document.getElementById('action-panel');
    if (panel) new ResizeObserver(() => {
      if (_lastState && _measurePanel() > _panelHeight + 1) fitCards(_lastState, _myPlayerId, true);
    }).observe(panel);
  }

  let _fitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_fitTimer);
    _fitTimer = setTimeout(() => { if (_lastState) fitCards(_lastState, _myPlayerId, true); }, 150);
  });
  // Il font delle carte cambia le misure: si ricalcola quando è caricato
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (_lastState) fitCards(_lastState, _myPlayerId, true); });
  }

  // ---------------------------------------------------------------------------
  // Layout tavolo — 2 / 3 / 4 giocatori
  //
  //   2p: avversario unico in cima (specchiato, piena larghezza); no strip
  //   3p: no top; vicino S. nella strip sinistra, vicino D. nella strip destra
  //   4p: giocatore di fronte in cima (riga di tasselli specchiata);
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
      topArea.appendChild(renderOpponentSummary(opp, state, 'row'));
      leftStrip.classList.add('hidden');
      rightStrip.classList.add('hidden');

    } else if (n === 3) {
      // Nessuno di fronte; vicini ai lati
      const rn = state.players[(myIndex + 1) % 3]; // vicino destro
      const ln = state.players[(myIndex + 2) % 3]; // vicino sinistro
      leftStrip.classList.remove('hidden');
      rightStrip.classList.remove('hidden');
      leftStrip.appendChild(renderOpponentSummary(ln, state, 'left'));
      rightStrip.appendChild(renderOpponentSummary(rn, state, 'right'));
      leftStrip.classList.toggle('active-player-strip',  ln.id === state.current_player_id);
      rightStrip.classList.toggle('active-player-strip', rn.id === state.current_player_id);

    } else if (n === 4) {
      const rn     = state.players[(myIndex + 1) % 4]; // vicino destro
      const across = state.players[(myIndex + 2) % 4]; // di fronte
      const ln     = state.players[(myIndex + 3) % 4]; // vicino sinistro
      topArea.appendChild(renderOpponentSummary(across, state, 'row'));
      leftStrip.classList.remove('hidden');
      rightStrip.classList.remove('hidden');
      leftStrip.appendChild(renderOpponentSummary(ln, state, 'left'));
      rightStrip.appendChild(renderOpponentSummary(rn, state, 'right'));
      leftStrip.classList.toggle('active-player-strip',  ln.id === state.current_player_id);
      rightStrip.classList.toggle('active-player-strip', rn.id === state.current_player_id);
    }
  }

  // ---------------------------------------------------------------------------
  // Avversari — 4 tasselli riassuntivi (Bastioni agli estremi, Avanscoperta e
  // Villaggio al centro), con gli stessi riassunti del proprio campo sul mobile.
  //
  //   in cima (2p, e il giocatore di fronte in 4p): una riga SPECCHIATA,
  //     B.D. a sinistra, B.S. a destra;
  //   strip laterali (3p/4p): una colonna, col Bastione adiacente al mio campo
  //     in fondo e quello lontano in cima.
  //
  // Le carte di una Regione si vedono cliccando il suo tassello (showOpponentRegion).
  // I Bastioni attaccabili dipendono dai vicini VIVI: in 4p il giocatore di
  // fronte diventa adiacente se un vicino laterale è eliminato.
  // ---------------------------------------------------------------------------

  function _guerremotoActive(state) {
    const myPlayer = state.players.find(p => p.id === _myPlayerId);
    return !!myPlayer && (myPlayer.active_effects || []).some(e => e.type === 'guerremoto' && e.any_target);
  }

  // Vicini vivi più prossimi a sinistra e a destra: gli eliminati vengono saltati.
  function _aliveNeighbors(state, myId) {
    const ps = state.players;
    const n = ps.length;
    const i = ps.findIndex(p => p.id === myId);
    const step = d => {
      let j = i;
      for (let k = 0; k < n - 1; k++) {
        j = (j + d + n) % n;
        if ((ps[j].lives ?? 0) > 0) return ps[j];
      }
      return null;
    };
    return { left: step(-1), right: step(1) };
  }

  // Chiavi "playerId:side" dei Bastioni avversari attaccabili dal mio campo.
  function _adjacentKeys(state) {
    const { left, right } = _aliveNeighbors(state, _myPlayerId);
    const keys = new Set();
    if (right && right.id !== _myPlayerId) keys.add(`${right.id}:left`);
    if (left && left.id !== _myPlayerId) keys.add(`${left.id}:right`);
    return keys;
  }

  // Riassunti numerici di una Regione: parità con vanguardSummary & co. di mobile/render.js
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

  function _statBlock(num, label) {
    return el('div', { className: `rg-stat${num === 0 ? ' zero' : ''}` }, [
      el('span', { className: 'rg-stat-num' }, [String(num)]),
      el('span', { className: 'rg-stat-label' }, [label]),
    ]);
  }

  function _statRow(...blocks) {
    return el('div', { className: 'rg-stat-row' }, blocks);
  }

  function _vanguardSummary(vg) {
    if (vg.length === 0) return el('div', { className: 'rg-empty' }, ['Vuota']);
    return el('div', { className: 'rg-summary' }, [
      _statRow(_statBlock(vg.length, vg.length === 1 ? 'Guerriero' : 'Guerrieri')),
      _speciesDots(vg),
      el('div', { className: 'rg-summary-sub' },
        [`ATT max ${_maxStat(vg, 'att')} · GIT max ${_maxStat(vg, 'git')}`]),
    ]);
  }

  function _bastionSummary(bastion) {
    const wallCount = bastion.wall_count ?? (bastion.walls || []).length;
    const warriors = bastion.warriors || [];
    if (wallCount === 0 && warriors.length === 0) return el('div', { className: 'rg-empty' }, ['Vuoto']);
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

  function _villageSummary(buildings) {
    if (buildings.length === 0) return el('div', { className: 'rg-empty' }, ['Nessuna Costruzione']);
    const completed = buildings.filter(b => b.completed).length;
    return el('div', { className: 'rg-summary' }, [
      _statRow(
        _statBlock(buildings.length, buildings.length === 1 ? 'Costruzione' : 'Costruzioni'),
        _statBlock(completed, completed === 1 ? 'Completa' : 'Complete'),
      ),
    ]);
  }

  // Le Costruzioni assegnate a un Guerriero (es. Trono) sono mostrate sul Guerriero, non nel Villaggio
  function _villageBuildings(player) {
    return ((player.field.village && player.field.village.buildings) || []).filter(b => !b.assigned_warrior);
  }

  // `zone` (vanguard | village | bastion_left | bastion_right) serve alle
  // transizioni delle carte (app.js → _animateOpponents)
  function _oppTile(player, zone, label, sub, content, extraClass = '', dataset = {}) {
    const tile = el('div', { className: `opp-tile${extraClass}`, dataset: { zone, ...dataset } }, [
      el('div', { className: 'opp-tile-title' }, [
        el('span', { className: 'opp-tile-label' }, [label]),
        sub ? el('span', { className: 'opp-tile-sub' }, [sub]) : null,
      ]),
      content,
    ]);
    tile.addEventListener('click', () => showOpponentRegion(player.id, zone));
    return tile;
  }

  function _oppBastionTile(player, side, isTarget) {
    const name = side === 'left' ? 'Bastione S.' : 'Bastione D.';
    return _oppTile(player, `bastion_${side}`, name, isTarget ? TARGET_TAG : '', _bastionSummary(_bastion(player, side)),
      ` opp-tile-bastion${isTarget ? ' attack-target' : ' nonadj'}`,
      isTarget ? { targetPlayerId: player.id, targetSide: side } : {});
  }

  function _oppHeader(player) {
    const head = el('div', { className: 'opp-head' }, [
      el('span', { className: 'opp-name' }, [player.name]),
      el('span', { className: 'opp-lives' },
        ['❤'.repeat(Math.max(0, player.lives)) + '✕'.repeat(Math.max(0, 3 - player.lives))]),
      el('span', { className: 'opp-hand-count' }, [`🃏 ${player.hand_count}`]),
    ]);
    const fx = renderOppActiveEffects(player);
    if (fx) head.appendChild(fx);
    return head;
  }

  // Lati dei Bastioni all'inizio (a sinistra o in cima) e alla fine della fila:
  // in cima il campo è specchiato; nelle strip il Bastione adiacente al mio campo
  // (B.D. del vicino sinistro, B.S. del vicino destro) sta in fondo.
  const OPP_BASTION_ENDS = {
    row:   ['right', 'left'],
    left:  ['left', 'right'],
    right: ['right', 'left'],
  };

  // layout 'row': in cima. layout 'left' / 'right': strip del vicino da quel lato.
  function renderOpponentSummary(player, state, layout) {
    const isActive = player.id === state.current_player_id;
    const div = el('div', {
      className: `opponent-field opp-${layout === 'row' ? 'row' : 'column'}${isActive ? ' active-player' : ''}`,
      dataset: { playerId: player.id },
    });
    div.appendChild(_oppHeader(player));

    // Con Guerremoto attivo (any_target) tutti i Bastioni diventano bersagli validi.
    const guerremoto = _guerremotoActive(state);
    const adjKeys = _adjacentKeys(state);
    const target = side => guerremoto || adjKeys.has(`${player.id}:${side}`);

    const [first, last] = OPP_BASTION_ENDS[layout];
    div.appendChild(el('div', { className: 'opp-tiles' }, [
      _oppBastionTile(player, first, target(first)),
      _oppTile(player, 'vanguard', 'Avanscoperta', '', _vanguardSummary(player.field.vanguard || [])),
      _oppTile(player, 'village', 'Villaggio', '', _villageSummary(_villageBuildings(player))),
      _oppBastionTile(player, last, target(last)),
    ]));
    return div;
  }

  function _activeEffectItems(player) {
    const seen = new Set();
    const items = [];
    for (const ef of (player.active_effects || [])) {
      const cfg = ACTIVE_EFFECT_CONFIG[ef.type];
      if (!cfg || seen.has(cfg.baseCardId)) continue;
      seen.add(cfg.baseCardId);
      items.push({ label: cfg.label, desc: cfg.desc(ef) });
    }
    return items;
  }

  function renderOppActiveEffects(player) {
    const items = _activeEffectItems(player);
    if (items.length === 0) return null;
    const row = el('div', { className: 'opp-active-effects' });
    items.forEach(item => {
      row.appendChild(el('span', { className: 'opp-active-badge', title: item.desc }, [item.label]));
    });
    return row;
  }

  // Una Regione di un avversario carta per carta (minicarte con anteprima al
  // passaggio del mouse, clic per il dettaglio), come i tasselli del proprio campo
  // sul mobile (openVanguardSheet / openBastionSheet / openVillageSheet).
  function showOpponentRegion(playerId, zone) {
    const state = _lastState;
    const p = state && state.players.find(pp => pp.id === playerId);
    if (!p) return;

    let title, subtitle, cards, empty;
    if (zone === 'vanguard') {
      const ws = p.field.vanguard || [];
      title = 'Avanscoperta';
      subtitle = _plural(ws.length, 'Guerriero', 'Guerrieri');
      cards = ws.map(w => renderCardSmall(w, false));
      empty = 'Nessun Guerriero in Avanscoperta: non può attaccare.';
    } else if (zone === 'village') {
      const bs = _villageBuildings(p);
      const done = bs.filter(b => b.completed).length;
      title = 'Villaggio';
      subtitle = `${_plural(bs.length, 'Costruzione', 'Costruzioni')} · ${_plural(done, 'completa', 'complete')}`;
      cards = bs.map(b => {
        const card = renderBuildingCard(b, false, null);
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => App.onCardClick(b.instance_id, 'opponent'));
        return card;
      });
      empty = 'Nessuna Costruzione nel Villaggio.';
    } else {
      const side = zone === 'bastion_left' ? 'left' : 'right';
      const b = _bastion(p, side);
      const walls = b.wall_count ?? 0;
      const ws = b.warriors || [];
      title = `Bastione ${side === 'left' ? 'Sinistro' : 'Destro'}`;
      subtitle = `${_plural(walls, 'Muro', 'Muri')} · ${_plural(ws.length, 'Guerriero', 'Guerrieri')}` +
        (_isTarget(state, p, side) ? ` · ${TARGET_TAG}` : '');
      cards = [...(walls > 0 ? [renderDeck('wall', walls)] : []), ...ws.map(w => renderCardSmall(w, false))];
      empty = 'Bastione vuoto: niente Muri né Difensori.';
    }

    const body = el('div', { className: 'oppf' });
    const row = el('div', { className: 'oppf-cards' });
    if (cards.length === 0) row.appendChild(el('div', { className: 'oppf-empty' }, [empty]));
    cards.forEach(c => row.appendChild(c));
    body.appendChild(row);

    const overlay = document.getElementById('modal-overlay');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn  = document.getElementById('modal-cancel');
    document.getElementById('modal-title').textContent = `${title} di ${p.name}`;
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = '';
    modalBody.appendChild(el('p', { className: 'wpick-subtitle' }, [subtitle]));
    modalBody.appendChild(body);
    overlay.classList.remove('hidden');

    confirmBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    cancelBtn.textContent = 'Chiudi';
    cancelBtn.onclick = () => {
      overlay.classList.add('hidden');
      CardPreview.hide();
    };
  }

  // ---------------------------------------------------------------------------
  // Il mio campo
  // ---------------------------------------------------------------------------

  function renderMyField(player, state, myPlayerId) {
    // Carte-vita e carte con effetti attivi
    renderLifeCards(player);
    renderActiveCards(player);
    document.getElementById('my-mana').textContent    = `Mana: ${player.mana_remaining ?? 0}`;
    document.getElementById('my-actions').textContent = `Azioni: ${player.actions_remaining ?? 0}`;

    // Etichette bastioni con nome del vicino che li minaccia
    const { left: leftNeighbor, right: rightNeighbor } = _aliveNeighbors(state, myPlayerId);
    document.getElementById('my-bastion-left').dataset.label  = 'Bastione Sinistro';
    document.getElementById('my-bastion-left').dataset.sub    = leftNeighbor ? `Esposto a ${leftNeighbor.name}` : '';
    document.getElementById('my-bastion-right').dataset.label = 'Bastione Destro';
    document.getElementById('my-bastion-right').dataset.sub   = rightNeighbor ? `Esposto a ${rightNeighbor.name}` : '';

    // Regioni
    renderRegion('my-vanguard', player.field.vanguard, 'warrior', true);
    renderBastionRegion('my-bastion-left',  player.field.bastion_left,  'left',  true);
    renderBastionRegion('my-bastion-right', player.field.bastion_right, 'right', true);
    renderVillage('my-village', player.field.village, player.ethereal_complete || null);

    // Mano
    renderHand(player.hand || [], player.ethereal_card || null, player.prodigy_ready || []);
    document.getElementById('hand-count').textContent = (player.hand || []).length;
  }

  function _maxStat(warriors, key) {
    if (!warriors || warriors.length === 0) return 0;
    return Math.max(...warriors.map(w => w[key] || 0));
  }

  // Le carte di una regione stanno in una riga che scorre in orizzontale invece
  // di andare a capo: con molti Guerrieri il campo non cambia altezza.
  function _regionCardsRow(container) {
    const row = el('div', { className: 'region-cards' });
    container.appendChild(row);
    return row;
  }

  function renderRegion(containerId, warriors, kind, interactive) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const row = _regionCardsRow(container);
    (warriors || []).forEach(w => {
      const card = renderWarriorCard(w, true, interactive);
      row.appendChild(card);
    });
    if (kind === 'warrior' && (warriors || []).length > 0) {
      container.appendChild(el('div', { className: 'region-stats-recap' },
        [`ATT max ${_maxStat(warriors, 'att')} · GIT max ${_maxStat(warriors, 'git')}`]));
    }
  }

  function renderBastionRegion(containerId, bastion, side, interactive) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const row = _regionCardsRow(container);

    // Muri come carta-stack singola
    const walls = bastion.walls || [];
    if (walls.length > 0) {
      row.appendChild(renderWallStack(walls, side, interactive));
    } else if (bastion.wall_count > 0) {
      row.appendChild(renderDeck('wall', bastion.wall_count));
    }

    // Guerrieri
    (bastion.warriors || []).forEach(w => {
      row.appendChild(renderWarriorCard(w, true, interactive));
    });
    if ((bastion.warriors || []).length > 0) {
      container.appendChild(el('div', { className: 'region-stats-recap' },
        [`DIF max ${_maxStat(bastion.warriors, 'dif')} · GIT max ${_maxStat(bastion.warriors, 'git')}`]));
    }
  }

  // Mazzo coperto (Muri, Vite, Carte Attive): il dorso della carta e, sotto la
  // scritta, un riquadro marrone col numero di carte dentro un simbolo
  // (quadrato per i Muri, cuore per le Vite, scintilla per le Carte Attive).
  // Ha la misura delle carte del mio campo.
  const DECK_SHAPES = {
    wall:   '<rect x="2.5" y="2.5" width="19" height="19" rx="3"/>',
    life:   '<path d="M12 22 10.5 20.6C5.2 15.8 1.5 12.5 1.5 8.4 1.5 5.1 4.1 2.5 7.4 2.5c1.8 0 3.6.9 4.6 2.3 1-1.4 2.8-2.3 4.6-2.3 3.3 0 5.9 2.6 5.9 5.9 0 4.1-3.7 7.4-9 12.2L12 22z"/>',
    active: '<path d="M12 0 15.6 8.4 24 12 15.6 15.6 12 24 8.4 15.6 0 12 8.4 8.4z"/>',
  };

  function renderDeck(kind, count) {
    const div = el('div', { className: `card card-sm in-field deck deck-${kind}`, dataset: { type: 'deck' } });
    div.appendChild(el('img', { className: 'deck-back', alt: '', draggable: 'false', src: '/card_images/mini/retro.webp' }));
    const badge = el('div', { className: 'deck-count' });
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DECK_SHAPES[kind]}</svg>`;
    badge.appendChild(el('span', {}, [String(count)]));
    div.appendChild(badge);
    return div;
  }

  function renderWallStack(walls, side, interactive) {
    const div = renderDeck('wall', walls.length);
    if (interactive) {
      div.classList.add('clickable');
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        App.showWallSlideshow(walls, side, 0);
      });
    }
    return div;
  }

  function renderVillage(containerId, village, etherealComplete) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const row = _regionCardsRow(container);
    // Le Costruzioni assegnate a un Guerriero (es. Trono) sono mostrate sul Guerriero, non qui
    (village.buildings || []).filter(b => !b.assigned_warrior).forEach(b => {
      row.appendChild(renderBuildingCard(b, true, etherealComplete));
    });
  }

  function renderLifeCards(player) {
    const container = document.getElementById('my-life-deck');
    if (!container) return;
    container.innerHTML = '';

    const lifeCards = player.life_cards || [];
    const lives = player.lives ?? lifeCards.length;

    if (lives === 0) return;

    const stack = renderDeck('life', lives);
    if (lifeCards.length > 0) {
      stack.classList.add('clickable');
      stack.addEventListener('click', () => App.showLifeSlideshow(lifeCards, 0));
    }

    container.appendChild(stack);
  }

  const ACTIVE_EFFECT_CONFIG = {
    'spell_immune':            { baseCardId: 'magiscudo',    label: 'Magiscudo',    desc: () => 'Le Magie non hanno effetto su di te fino al prossimo turno.' },
    'guerremoto':              { baseCardId: 'guerremoto',   label: 'Guerremoto',   desc: ef => `Puoi attaccare qualsiasi Bastione${ef.discard_walls ? ` (scarta fino a ${ef.discard_walls} Muri prima dei Danni)` : ''}.` },
    'investimento_deferred':   { baseCardId: 'investimento', label: 'Investimento', desc: ef => `+${ef.mana || 2} Mana all'inizio del prossimo turno.` },
    'divinazione_base':        { baseCardId: 'divinazione',  label: 'Divinazione',  desc: () => '+1 Mana a inizio prossimo turno.' },
    'divinazione_all_mage':    { baseCardId: 'divinazione',  label: 'Divinazione',  desc: () => '+1 Mana per ogni tua Maga a inizio prossimo turno.' },
    'equipotenza_own':         { baseCardId: 'equipotenza',  label: 'Equipotenza',  desc: () => 'Un tuo Guerriero ha le statistiche livellate ai valori più alti in campo.' },
  };

  function renderActiveCards(player) {
    const container = document.getElementById('my-active-cards');
    if (!container) return;
    container.innerHTML = '';

    const activeEffects = player.active_effects || [];
    const seen = new Set();
    const items = [];
    for (const ef of activeEffects) {
      const cfg = ACTIVE_EFFECT_CONFIG[ef.type];
      if (!cfg || seen.has(cfg.baseCardId)) continue;
      seen.add(cfg.baseCardId);
      items.push({ baseCardId: cfg.baseCardId, label: cfg.label, desc: cfg.desc(ef) });
    }

    if (items.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = '';
    const stack = renderDeck('active', items.length);
    stack.classList.add('clickable');
    stack.addEventListener('click', () => {
      if (App.showActiveSlideshow) App.showActiveSlideshow(items, 0);
    });
    container.appendChild(stack);
  }

  // Carte della mano dell'ultimo ridisegno, per riusarle: ricreare le immagini a
  // ogni aggiornamento le farebbe sparire per un fotogramma (sfarfallio).
  let _handNodes = new Map();  // iid -> { node, ethereal }

  function renderHand(cards, etherealCard, prodigyReady) {
    const container = document.getElementById('hand-cards');
    CardPreview.hide();
    const next = new Map();
    const nodes = cards.map(iid => {
      const ethereal = etherealCard === iid;
      const prev = _handNodes.get(iid);
      let node;
      if (prev && prev.ethereal === ethereal && prev.node.dataset.instanceId === iid) {
        node = prev.node;
        node.classList.remove('wall-marked');  // la modalità Muri la riapplica se serve
        node.style.opacity = '';
        // La fascia della minicarta può cambiare anche se la carta resta (es. Prodigio)
        const def = App.getCardDef ? App.getCardDef(iid) : null;
        CardArt.update(node, def, CardArt.handInfo(def, iid, prodigyReady));
      } else {
        node = renderHandCard(iid, etherealCard, prodigyReady);
      }
      next.set(iid, { node, ethereal });
      return node;
    });
    container.replaceChildren(...nodes);
    _handNodes = next;
  }

  // ---------------------------------------------------------------------------
  // Carte
  // ---------------------------------------------------------------------------

  function renderHandCard(iid, etherealCard, prodigyReady) {
    const isEthereal = etherealCard === iid;
    const div = el('div', { className: isEthereal ? 'card ethereal' : 'card', dataset: { instanceId: iid } });

    const def = App.getCardDef ? App.getCardDef(iid) : null;
    if (def) {
      div.dataset.type = def.type;
      div.dataset.baseId = def.id;

      // Badge costo come sulle carte stampate: esagono giallo per il Mana, stella azzurra per le Maghe, bianco per la carta Eterea
      const badgeCls = isEthereal ? 'ethereal' : (def.cost_type === 'maga' ? 'maga' : 'mana');
      div.appendChild(el('div', { className: `card-cost-badge ${badgeCls}${def.cost_type === 'maga' ? ' star' : ''}` }, [String(isEthereal ? 0 : def.cost)]));

      div.appendChild(el('div', { className: 'card-name' }, [def.name]));

      if (def.type === 'warrior') {
        div.appendChild(el('div', {
          className: `card-species species-${def.species}`
        }, [`${capitalize(def.species)}${def.school ? ` · ${capitalize(def.school)}` : ''}`]));

        // Caratteristiche in colonna (auto-push verso il basso)
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
      // Minicarta disegnata sopra la versione testuale, che resta nascosta
      CardArt.attach(div, def, CardArt.handInfo(def, iid, prodigyReady));
      CardPreview.bind(div, def);
    } else {
      div.appendChild(el('div', { className: 'card-name' }, [iid]));
    }

    div.addEventListener('click', () => { CardPreview.hide(); App.onCardClick(iid, 'hand'); });
    return div;
  }

  // Anteprima della carta intera al passaggio del mouse sulle minicarte (mano e
  // campo). Vive in un livello fisso: le righe delle carte scorrono in orizzontale
  // e taglierebbero una carta ingrandita sul posto.
  const CardPreview = (() => {
    const WIDTH = 230;
    const GAP = 12;
    let timer = null;
    let node = null;

    function hide() {
      clearTimeout(timer);
      timer = null;
      if (node) node.hidden = true;
    }

    function schedule(cardEl, def) {
      hide();
      if (!window.matchMedia || !matchMedia('(hover: hover)').matches) return;
      timer = setTimeout(() => show(cardEl, def), 280);
    }

    function bind(cardEl, def) {
      cardEl.addEventListener('mouseenter', () => schedule(cardEl, def));
      cardEl.addEventListener('mouseleave', hide);
      cardEl.addEventListener('click', hide);
    }

    function show(cardEl, def) {
      if (!cardEl.isConnected || !cardEl.classList.contains('has-art')) return;
      const r = cardEl.getBoundingClientRect();
      const height = Math.round(WIDTH * 1040 / 744);
      const vw = window.innerWidth, vh = window.innerHeight;
      // Sopra la carta se c'è spazio, altrimenti sotto, altrimenti di fianco
      let left = Math.max(8, Math.min(vw - WIDTH - 8, r.left + r.width / 2 - WIDTH / 2));
      let top;
      if (r.top - height - GAP >= 0) top = r.top - height - GAP;
      else if (r.bottom + GAP + height <= vh) top = r.bottom + GAP;
      else {
        top = Math.max(8, Math.min(vh - height - 8, r.top + r.height / 2 - height / 2));
        left = r.right + GAP + WIDTH <= vw ? r.right + GAP : r.left - GAP - WIDTH;
        if (left < 0) return;
      }
      if (!node) {
        node = el('img', { className: 'hand-preview', alt: '' });
        document.body.appendChild(node);
      }
      node.src = CardArt.previewUrl(def.id);
      node.alt = def.name;
      node.style.width = `${WIDTH}px`;
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.hidden = false;
    }

    return { schedule, bind, hide };
  })();

  function renderWarriorCard(warrior, inField, interactive) {
    const div = el('div', { className: 'card card-sm in-field', dataset: {
      type: 'warrior',
      instanceId: warrior.instance_id,
      baseId: warrior.base_card_id,
    }});

    if (warrior.horde_active) div.classList.add('horde-active');
    if (warrior.assigned_cards && warrior.assigned_cards.length > 0) div.classList.add('has-assigned');

    div.appendChild(el('div', { className: 'card-name' }, [warrior.name || warrior.base_card_id]));
    div.appendChild(el('div', {
      className: `card-species species-${warrior.species}`
    }, [capitalize(warrior.species || '')]));

    const stats = el('div', { className: 'card-stats' });
    stats.appendChild(el('span', { className: 'stat stat-att' }, [`🗡️${warrior.att}`]));
    stats.appendChild(el('span', { className: 'stat stat-git' }, [`🏹${warrior.git}`]));
    stats.appendChild(el('span', { className: 'stat stat-dif' }, [`🛡️${warrior.dif}`]));
    div.appendChild(stats);

    // Minicarta con le Caratteristiche correnti, sopra la versione testuale
    const def = App.getCardDef ? App.getCardDef(warrior.instance_id) : null;
    CardArt.attach(div, def, warrior);
    if (def) CardPreview.bind(div, def);

    if (interactive) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => App.onCardClick(warrior.instance_id, 'field'));
    }
    return div;
  }

  function renderBuildingCard(building, inField, etherealComplete) {
    const isEtherealComplete = etherealComplete === building.instance_id;
    const div = el('div', { className: `card card-sm in-field${building.completed ? ' completed' : ''}${isEtherealComplete ? ' ethereal' : ''}`,
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

    // Minicarta con la torre piena o vuota, sopra la versione testuale
    const def = App.getCardDef ? App.getCardDef(building.instance_id) : null;
    CardArt.attach(div, def, building);
    if (def) CardPreview.bind(div, def);

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

  // Carte per i fantasmi delle transizioni degli avversari (app.js → _animateOpponents)
  function motionCardNode(obj, zone) {
    return zone === 'village' ? renderBuildingCard(obj, false, null) : renderWarriorCard(obj, true, false);
  }

  function motionBackNode() {
    return el('div', { className: 'card motion-back' }, [
      el('img', { className: 'deck-back', alt: '', src: '/card_images/mini/retro.webp' }),
    ]);
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

  // ---------------------------------------------------------------------------
  // Cronaca della partita (testi dal server, formattati da chronicle.js)
  // ---------------------------------------------------------------------------

  const CHRONICLE_TICKER_ENTRIES = 3;

  function _chronicleEntryHTML(e, state, opts, fresh, tag = 'div', cls = 'chr-entry') {
    return `<${tag} class="${cls} chr-${e.kind}${fresh.has(e.id) ? ' fresh' : ''}">`
      + `${Chronicle.toHTML(e.text, state, opts)}</${tag}>`;
  }

  /**
   * Aggiorna le ultime righe della cronaca sopra il campo e, se aperto, il
   * pannello completo. `fresh`: id delle voci appena arrivate (animate).
   */
  function renderChronicle(state, myPlayerId, cardDefs, fresh = new Set()) {
    const opts = { cardDefs, myPlayerId };
    const recent = Chronicle.entries(state).filter(e => e.kind !== 'turn').slice(-CHRONICLE_TICKER_ENTRIES);
    document.getElementById('battle-log').innerHTML = recent
      .map(e => _chronicleEntryHTML(e, state, opts, fresh, 'div', 'battle-log-entry'))
      .join('');
    if (!document.getElementById('chronicle-panel').classList.contains('hidden')) {
      renderChroniclePanel(state, myPlayerId, cardDefs, fresh);
    }
  }

  function renderChroniclePanel(state, myPlayerId, cardDefs, fresh = new Set(), forceBottom = false) {
    const body = document.getElementById('chronicle-body');
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    const opts = { cardDefs, myPlayerId, interactive: true };
    const list = Chronicle.entries(state);
    const groups = Chronicle.groupByTurn(list);
    let html = list.length && list[0].id > 1
      ? '<div class="chr-older">Le mosse più vecchie non sono più mostrate.</div>' : '';
    html += groups.map(g => {
      const head = g.header
        ? `<div class="chr-turn">${Chronicle.toHTML(g.header.text, state, opts)}</div>` : '';
      return `<section class="chr-group">${head}`
        + g.items.map(e => _chronicleEntryHTML(e, state, opts, fresh)).join('')
        + '</section>';
    }).join('');
    body.innerHTML = html || '<div class="chr-older">Ancora nessuna mossa.</div>';
    if (forceBottom || wasAtBottom) body.scrollTop = body.scrollHeight;
  }

  /** aboveOverlay: il pannello va sopra la schermata di fine partita. */
  function openChroniclePanel(state, myPlayerId, cardDefs, aboveOverlay = false) {
    const panel = document.getElementById('chronicle-panel');
    panel.classList.toggle('above-overlay', aboveOverlay);
    panel.classList.remove('hidden');
    document.body.classList.add('chronicle-open');
    placeMusicToggle(_currentScreen);
    renderChroniclePanel(state, myPlayerId, cardDefs, new Set(), true);
  }

  function closeChroniclePanel() {
    document.getElementById('chronicle-panel').classList.add('hidden');
    document.body.classList.remove('chronicle-open');
    placeMusicToggle(_currentScreen);
  }

  function isChroniclePanelOpen() {
    return !document.getElementById('chronicle-panel').classList.contains('hidden');
  }

  // ---------------------------------------------------------------------------
  // Card detail overlay
  // ---------------------------------------------------------------------------

  function showCardDetail(title, bodyHTML, actionLabel, onAction, onDiscard, extraButtons = [], navOptions = null, baseCardId = null, fallbackBaseCardId = null) {
    const overlay = document.getElementById('card-detail-overlay');

    function _setupNav(prevId, nextId) {
      const prevBtn = document.getElementById(prevId);
      const nextBtn = document.getElementById(nextId);
      if (!prevBtn || !nextBtn) return;
      if (navOptions && navOptions.onPrev) {
        prevBtn.onclick = navOptions.onPrev;
        prevBtn.style.visibility = 'visible';
        prevBtn.style.pointerEvents = 'auto';
      } else {
        prevBtn.onclick = null;
        prevBtn.style.visibility = 'hidden';
        prevBtn.style.pointerEvents = 'none';
      }
      if (navOptions && navOptions.onNext) {
        nextBtn.onclick = navOptions.onNext;
        nextBtn.style.visibility = 'visible';
        nextBtn.style.pointerEvents = 'auto';
      } else {
        nextBtn.onclick = null;
        nextBtn.style.visibility = 'hidden';
        nextBtn.style.pointerEvents = 'none';
      }
    }

    function _fillExtraButtons(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';
      extraButtons.forEach(btn => {
        const b = document.createElement('button');
        b.textContent = btn.label;
        b.className = `btn ${btn.className || 'btn-secondary'}`;
        b.disabled = !!btn.disabled;
        b.onclick = btn.onClick;
        container.appendChild(b);
      });
    }

    function _showTextMode() {
      document.getElementById('card-image-wrap').classList.add('hidden');
      document.getElementById('card-detail-box').classList.remove('hidden');

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

      _fillExtraButtons('card-detail-extra-btns');
      _setupNav('card-nav-prev', 'card-nav-next');

      document.getElementById('card-detail-close').onclick = () => overlay.classList.add('hidden');
      overlay.classList.remove('hidden');
      overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
    }

    function _showImageMode(imgSrc) {
      document.getElementById('card-detail-box').classList.add('hidden');
      document.getElementById('card-image-wrap').classList.remove('hidden');

      document.getElementById('card-detail-img').src = imgSrc;

      const actionBtn = document.getElementById('card-img-action');
      if (actionLabel && onAction) {
        actionBtn.textContent = actionLabel;
        actionBtn.onclick = onAction;
        actionBtn.classList.remove('hidden');
      } else {
        actionBtn.classList.add('hidden');
      }

      const discardBtn = document.getElementById('card-img-discard');
      if (onDiscard) {
        discardBtn.onclick = onDiscard;
        discardBtn.classList.remove('hidden');
      } else {
        discardBtn.classList.add('hidden');
      }

      _fillExtraButtons('card-img-extra-btns');
      _setupNav('card-img-prev', 'card-img-next');

      document.getElementById('card-img-close').onclick = () => overlay.classList.add('hidden');
      overlay.classList.remove('hidden');
      overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
    }

    if (baseCardId) {
      const imgUrl = `/card_images/full/${baseCardId}.png`;
      const probe = new window.Image();
      probe.onload = () => _showImageMode(imgUrl);
      probe.onerror = () => {
        // Easter egg (es. obelisco_completo): se il PNG alternativo manca,
        // torna alla carta ufficiale invece di scadere a modalità testo.
        if (fallbackBaseCardId) {
          const fallbackUrl = `/card_images/full/${fallbackBaseCardId}.png`;
          const fallbackProbe = new window.Image();
          fallbackProbe.onload = () => _showImageMode(fallbackUrl);
          fallbackProbe.onerror = () => _showTextMode();
          fallbackProbe.src = fallbackUrl;
        } else {
          _showTextMode();
        }
      };
      probe.src = imgUrl;
    } else {
      _showTextMode();
    }
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
    confirmBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
    // I modali dedicati (Magiscudo, Evelyn, ...) riscrivono le etichette dei
    // pulsanti: ripristinale, sono condivise da tutti i modali.
    confirmBtn.textContent = 'Conferma';
    cancelBtn.textContent = 'Annulla';

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

    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn  = document.getElementById('modal-cancel');
    confirmBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
    confirmBtn.textContent = 'Conferma';
    cancelBtn.textContent = 'Annulla';

    confirmBtn.onclick = () => {
      overlay.classList.add('hidden');
      if (selected !== null) onChoice(selected);
    };
    cancelBtn.onclick = () => {
      overlay.classList.add('hidden');
    };
  }

  // ---------------------------------------------------------------------------
  // Selettori: una modale comune divisa in gruppi (giocatore, oppure
  // "Selezionabili" / "Resto del mazzo") e sottosezioni (Regione, tipo di carta).
  // Tutte le scelte di Guerrieri, Bastioni, Costruzioni e carte passano di qui,
  // così hanno lo stesso aspetto. Parità con pickGrouped & co. del client mobile.
  // ---------------------------------------------------------------------------

  // Simboli monocromi come nella scelta della Regione quando si gioca un Guerriero
  // (︎ forza la resa testuale anche dove il carattere diventerebbe un'emoji)
  const ICON_VANGUARD = '⚔︎';
  const ICON_BASTION  = '🛡︎';

  const PICKER_ZONES = [
    { key: 'vanguard',      icon: ICON_VANGUARD, label: 'Avanscoperta' },
    { key: 'bastion_left',  icon: ICON_BASTION,  label: 'Bastione Sinistro', side: 'left' },
    { key: 'bastion_right', icon: ICON_BASTION,  label: 'Bastione Destro',   side: 'right' },
  ];
  const TARGET_TAG = 'Possibile Bersaglio';

  function _zoneWarriors(player, zoneKey) {
    return zoneKey === 'vanguard'
      ? (player.field.vanguard || [])
      : (player.field[zoneKey].warriors || []);
  }

  function _bastion(player, side) {
    return side === 'left' ? player.field.bastion_left : player.field.bastion_right;
  }

  // Giocatori vivi in ordine di posto, partendo da me.
  function _playersFromMe(state) {
    const ps = state.players;
    const i = Math.max(0, ps.findIndex(p => p.id === _myPlayerId));
    return [...ps.slice(i), ...ps.slice(0, i)].filter(p => (p.lives ?? 0) > 0);
  }

  // true se il Bastione `side` di `player` è un mio possibile bersaglio in Battaglia
  function _isTarget(state, player, side) {
    if (player.id === _myPlayerId) return false;
    return _guerremotoActive(state) || _adjacentKeys(state).has(`${player.id}:${side}`);
  }

  function _playerHead(player) {
    return player.id === _myPlayerId ? 'Tu' : player.name;
  }

  function _plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  /**
   * Modale di scelta a gruppi.
   * opts: {
   *   title, subtitle,
   *   groups: [{ head?, zones: [{ icon?, label?, tag?, rows: [row] }] }],
   *     row: { icon?, name, meta?, note?, tag?, value, disabled? }
   *   onPick(value),
   *   cancelLabel (default 'Annulla'; null = nessun bottone), onCancel,
   *   empty: messaggio (toast) se non c'è nessuna riga selezionabile
   * }
   * Selezione + Conferma, oppure doppio clic. Ritorna false se non c'è niente da scegliere.
   */
  function showPicker(opts) {
    const groups = (opts.groups || []).map(g => ({
      ...g, zones: (g.zones || []).filter(z => z.rows && z.rows.length > 0),
    })).filter(g => g.zones.length > 0);
    const selectable = groups.some(g => g.zones.some(z => z.rows.some(r => !r.disabled)));
    if (!selectable) {
      if (opts.empty) toast(opts.empty, 'error');
      return false;
    }

    const overlay    = document.getElementById('modal-overlay');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn  = document.getElementById('modal-cancel');
    const list = el('div', { className: 'wpick' });
    let selected;
    let hasSelection = false;

    groups.forEach(g => {
      const section = el('div', { className: 'wpick-player' });
      if (g.head) section.appendChild(el('div', { className: 'wpick-player-head' }, [g.head]));
      g.zones.forEach(z => {
        const zone = el('div', { className: 'wpick-zone' });
        if (z.label) {
          const head = el('div', { className: 'wpick-zone-head' });
          if (z.icon) head.appendChild(el('span', { className: 'wpick-zone-icon' }, [z.icon]));
          head.appendChild(el('span', { className: 'wpick-zone-name' }, [z.label]));
          if (z.tag) head.appendChild(el('span', { className: 'wpick-tag' }, [z.tag]));
          zone.appendChild(head);
        }
        z.rows.forEach(r => {
          const row = el('div', { className: `wpick-row${r.disabled ? ' disabled' : ''}` });
          if (r.icon) row.appendChild(el('span', { className: 'wpick-row-icon' }, [r.icon]));
          row.appendChild(el('span', { className: 'wpick-name' }, [r.name]));
          if (r.tag) row.appendChild(el('span', { className: 'wpick-tag' }, [r.tag]));
          if (r.meta) row.appendChild(el('span', { className: 'wpick-stats' }, [r.meta]));
          if (r.note) row.appendChild(el('span', { className: 'wpick-note' }, [r.note]));
          if (!r.disabled) {
            row.addEventListener('click', () => {
              list.querySelectorAll('.wpick-row').forEach(x => x.classList.remove('selected'));
              row.classList.add('selected');
              selected = r.value;
              hasSelection = true;
            });
            row.addEventListener('dblclick', () => { overlay.classList.add('hidden'); opts.onPick(r.value); });
          }
          zone.appendChild(row);
        });
        section.appendChild(zone);
      });
      list.appendChild(section);
    });

    document.getElementById('modal-title').textContent = opts.title;
    const body = document.getElementById('modal-body');
    body.innerHTML = '';
    if (opts.subtitle) body.appendChild(el('p', { className: 'wpick-subtitle' }, [opts.subtitle]));
    body.appendChild(list);
    overlay.classList.remove('hidden');

    confirmBtn.classList.remove('hidden');
    confirmBtn.textContent = 'Conferma';
    confirmBtn.onclick = () => {
      if (!hasSelection) { toast('Scegli prima un\'opzione', 'error'); return; }
      overlay.classList.add('hidden');
      opts.onPick(selected);
    };
    if (opts.cancelLabel === null) {
      cancelBtn.classList.add('hidden');
    } else {
      cancelBtn.classList.remove('hidden');
      cancelBtn.textContent = opts.cancelLabel || 'Annulla';
      cancelBtn.onclick = () => {
        overlay.classList.add('hidden');
        opts.onCancel && opts.onCancel();
      };
    }
    return true;
  }

  // Opzioni comuni ai selettori specializzati, passate così come sono a showPicker
  function _passthrough(opts) {
    const { title, subtitle, cancelLabel, onCancel, empty } = opts;
    return { title, subtitle, cancelLabel, onCancel, empty };
  }

  /**
   * Guerrieri, divisi per giocatore e per Regione.
   * opts: { players (default: tutti i vivi, io per primo), filter(w, p, zoneKey),
   *         note(w, p, zoneKey), onPick(w, p, zoneKey), + opzioni di showPicker }
   */
  function showWarriorPicker(state, opts) {
    const players = opts.players || _playersFromMe(state);
    const onlyMe = players.length === 1 && players[0].id === _myPlayerId;
    const groups = players.map(p => ({
      head: onlyMe ? null : _playerHead(p),
      zones: PICKER_ZONES.map(z => ({
        icon: z.icon,
        label: z.label,
        tag: z.side && _isTarget(state, p, z.side) ? TARGET_TAG : null,
        rows: _zoneWarriors(p, z.key)
          .filter(w => !opts.filter || opts.filter(w, p, z.key))
          .map(w => ({
            name: w.name || w.base_card_id,
            meta: `ATT ${w.att} · GIT ${w.git} · DIF ${w.dif}`,
            note: opts.note ? opts.note(w, p, z.key) : null,
            value: { w, p, zoneKey: z.key },
          })),
      })),
    }));
    return showPicker({
      ..._passthrough(opts),
      groups,
      onPick: (v) => opts.onPick(v.w, v.p, v.zoneKey),
    });
  }

  /**
   * Bastioni, divisi per giocatore.
   * opts: { players, filter(p, side), note(p, side), onPick(p, side), + opzioni di showPicker }
   */
  function showBastionPicker(state, opts) {
    const players = opts.players || _playersFromMe(state);
    const onlyMe = players.length === 1 && players[0].id === _myPlayerId;
    const groups = players.map(p => ({
      head: onlyMe ? null : _playerHead(p),
      zones: [{
        rows: ['left', 'right']
          .filter(side => !opts.filter || opts.filter(p, side))
          .map(side => {
            const b = _bastion(p, side);
            return {
              icon: ICON_BASTION,
              name: `Bastione ${side === 'left' ? 'Sinistro' : 'Destro'}`,
              tag: _isTarget(state, p, side) ? TARGET_TAG : null,
              meta: `${_plural(b.wall_count ?? 0, 'Muro', 'Muri')} · ${_plural((b.warriors || []).length, 'Guerriero', 'Guerrieri')}`,
              note: opts.note ? opts.note(p, side) : null,
              value: { p, side },
            };
          }),
      }],
    }));
    return showPicker({
      ..._passthrough(opts),
      groups,
      onPick: (v) => opts.onPick(v.p, v.side),
    });
  }

  /**
   * Giocatori (es. Bastioncontrario base): una riga per giocatore con i Muri dei due Bastioni.
   * opts: { players, onPick(p), + opzioni di showPicker }
   */
  function showPlayerPicker(state, opts) {
    const players = opts.players || _playersFromMe(state);
    return showPicker({
      ..._passthrough(opts),
      groups: [{ zones: [{ rows: players.map(p => ({
        name: _playerHead(p),
        meta: `Sinistro ${p.field.bastion_left.wall_count ?? 0} · Destro ${p.field.bastion_right.wall_count ?? 0} Muri`,
        value: p,
      })) }] }],
      onPick: (p) => opts.onPick(p),
    });
  }

  /**
   * Costruzioni nel Villaggio, divise per giocatore.
   * opts: { players, filter(b, p), meta(b, p), note(b, p), onPick(b, p), + opzioni di showPicker }
   */
  function showBuildingPicker(state, opts) {
    const players = opts.players || _playersFromMe(state);
    const onlyMe = players.length === 1 && players[0].id === _myPlayerId;
    const groups = players.map(p => ({
      head: onlyMe ? null : _playerHead(p),
      zones: [{
        label: 'Villaggio',
        rows: (p.field.village.buildings || [])
          .filter(b => !opts.filter || opts.filter(b, p))
          .map(b => {
            const def = App.getCardDef ? App.getCardDef(b.instance_id) : null;
            return {
              name: def ? def.name : b.base_card_id,
              meta: opts.meta ? opts.meta(b, p) : (b.completed ? 'Completa' : 'Base'),
              note: opts.note ? opts.note(b, p) : null,
              value: { b, p },
            };
          }),
      }],
    }));
    return showPicker({
      ..._passthrough(opts),
      groups,
      onPick: (v) => opts.onPick(v.b, v.p),
    });
  }

  /**
   * Regione di destinazione di un proprio Guerriero (gioco dalla mano, riposizionamento, Cardo).
   * opts: { exclude: zoneKey da non proporre, note(zoneKey), onPick(zoneKey), + opzioni di showPicker }
   */
  function showRegionPicker(opts) {
    return showPicker({
      ..._passthrough(opts),
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

  function _cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // Riga descrittiva di una carta (tipo, Specie/Scuola, costo), senza emoji
  function cardMeta(def) {
    if (!def) return '';
    if (def.type === 'warrior') return `${def.subtype === 'hero' ? 'Eroe' : 'Recluta'} · ${_cap(def.species)}`;
    if (def.type === 'spell') return `${_cap(def.school)} · ${_plural(def.cost, 'Maga', 'Maghe')}`;
    return `${def.cost} Mana`;
  }

  /**
   * Carte (mano o mazzo), divise per tipo.
   * opts: {
   *   groups: [{ head?, cards: [instance_id], disabled? }]   (oppure cards: [...] per un solo gruppo)
   *   dedupe: raggruppa le copie della stessa carta in una riga "×N" (si sceglie la prima),
   *   note(def, iid), onPick(iid), + opzioni di showPicker
   * }
   */
  function showCardPicker(opts) {
    const srcGroups = opts.groups || [{ cards: opts.cards || [] }];
    const groups = srcGroups.map(g => {
      const entries = [];
      const byBase = new Map();
      g.cards.forEach(iid => {
        const def = App.getCardDef ? App.getCardDef(iid) : null;
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
    });
    return showPicker({ ..._passthrough(opts), groups, onPick: (iid) => opts.onPick(iid) });
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
    const iWon = state.winner_id && state.winner_id === _myPlayerId;
    document.getElementById('gameover-title').textContent = iWon ? 'Vittoria!' : 'Fine Partita';
    document.getElementById('gameover-winner').textContent =
      iWon ? 'Hai conquistato il Barbacane'
        : winner ? `${winner.name} conquista il Barbacane` : 'Nessun vincitore';

    // Riepilogo: classifica e statistiche della partita (chronicle.js)
    const esc = Chronicle.escapeHTML;
    const cols = Chronicle.STAT_COLUMNS;
    const rows = Chronicle.standings(state).map(r => {
      const seat = state.players.indexOf(r.player);
      const me = r.player.id === _myPlayerId;
      return `<tr class="${r.player.id === state.winner_id ? 'winner' : ''}${me ? ' me' : ''}">`
        + `<td class="go-place">${r.place}°</td>`
        + `<td class="go-name"><span class="chr-player chr-seat-${seat}">${esc(r.player.name)}</span>${me ? ' <span class="go-you">(tu)</span>' : ''}`
        + `<div class="go-outcome">${esc(r.outcome)}</div></td>`
        + cols.map(c => `<td class="go-num">${r.stats[c.key] || 0}</td>`).join('')
        + '</tr>';
    }).join('');
    document.getElementById('gameover-scores').innerHTML =
      `<table class="gameover-table"><thead><tr><th></th><th>Giocatore</th>`
      + cols.map(c => `<th>${c.label}</th>`).join('')
      + `</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------------------------------------------------------------------------
  // Schermate
  // ---------------------------------------------------------------------------

  let _currentScreen = null;

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${name}`);
    if (target) target.classList.add('active');
    if (window.Sparks) Sparks.setScreen(name);
    _currentScreen = name;
    placeMusicToggle(name);
  }

  // In partita, nel catalogo e nelle schermate di scelta tutorial/bot il pulsante
  // musica vive nella barra dell'header (rispettivamente dopo "Esci" e accanto al
  // titolo); altrove resta fisso in alto a destra. Con la cronaca aperta sta
  // nella sua intestazione, accanto alla ✕ (il pannello copre l'header).
  const MUSIC_HOME_CLASSES = ['in-header', 'in-catalog-header', 'in-chronicle'];

  function placeMusicToggle(name) {
    const btn = document.getElementById('btn-music-toggle');
    if (!btn) return;

    // Nella splash la musica è ancora muta finché non si preme il logo: il
    // pulsante non ha senso finché non parte, quindi resta nascosto.
    btn.hidden = (name === 'splash');

    let target = null;
    let cls = null;
    if (name === 'game') {
      target = document.querySelector('#game-header .header-right');
      cls = 'in-header';
    } else if (name === 'catalog') {
      target = document.getElementById('catalog-header');
      cls = 'in-catalog-header';
    } else if (name === 'tutorial-list') {
      target = document.getElementById('tutorial-list-header');
      cls = 'in-catalog-header';
    } else if (name === 'bot-difficulty') {
      target = document.getElementById('bot-difficulty-header');
      cls = 'in-catalog-header';
    } else if (name === 'multiplayer') {
      target = document.getElementById('multiplayer-header');
      cls = 'in-catalog-header';
    } else if (name === 'waiting') {
      target = document.getElementById('waiting-header');
      cls = 'in-catalog-header';
    }
    if (isChroniclePanelOpen()) {
      target = document.querySelector('#chronicle-panel .chronicle-head');
      cls = 'in-chronicle';
    }

    if (target) {
      if (cls === 'in-chronicle') target.insertBefore(btn, document.getElementById('chronicle-close'));
      else if (btn.parentElement !== target) target.appendChild(btn);
      MUSIC_HOME_CLASSES.forEach(c => btn.classList.toggle(c, c === cls));
    } else if (MUSIC_HOME_CLASSES.some(c => btn.classList.contains(c))) {
      document.body.appendChild(btn);
      MUSIC_HOME_CLASSES.forEach(c => btn.classList.remove(c));
    }
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
      action: 'Azioni', reposition: 'Schieramento', schieramento: 'Schieramento',
      horde: 'Orda', battle: 'Battaglia', battaglia: 'Battaglia', draw: 'Pesca', end: 'Fine'
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
    showPicker,
    showWarriorPicker,
    showBastionPicker,
    showPlayerPicker,
    showBuildingPicker,
    showRegionPicker,
    showCardPicker,
    cardMeta,
    showCardDetail,
    closeCardDetail,
    motionCardNode,
    motionBackNode,
    toast,
    showGameOver,
    showTimerWarning,
    hideTimer,
    renderChronicle,
    openChroniclePanel,
    closeChroniclePanel,
    isChroniclePanelOpen,
    el,
    livesText,
  };
})();
