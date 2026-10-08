/**
 * ws.js — Client WebSocket per Barbacane
 * Gestisce la connessione al server, la riconnessione automatica
 * e il dispatching degli eventi in entrata.
 */

const WS = (() => {
  let socket = null;
  let gameId = null;
  let playerId = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  let keepaliveTimer = null;
  const KEEPALIVE_INTERVAL = 30000;
  let httpKeepaliveTimer = null;
  // Ping HTTP: il traffico WebSocket non azzera il timer di inattività di
  // Render (free tier), quindi serve una richiesta HTTP periodica.
  const HTTP_KEEPALIVE_INTERVAL = 4 * 60 * 1000;
  // Controllo di vitalità: dopo un ping, se il pong non arriva entro questo
  // tempo la connessione è considerata morta. Serve soprattutto sul mobile:
  // quando l'app torna in primo piano il socket risulta ancora OPEN ma spesso
  // è morto, e le azioni inviate si perderebbero finché il sistema non se ne
  // accorge (anche minuti).
  const PONG_TIMEOUT = 6000;
  let lastPong = 0;
  let pongWatchdog = null;

  const handlers = {};

  function connect(gId, pId) {
    // Cambio di partita (es. tutorial -> partita vera): chiudi la vecchia
    // connessione, altrimenti _open() la vedrebbe ancora aperta e le azioni
    // continuerebbero a essere inviate alla partita precedente.
    if (socket && (gameId !== gId || playerId !== pId)) _teardown();
    gameId = gId;
    playerId = pId;
    _open();
  }

  function _open() {
    if (socket && (socket.readyState === WebSocket.OPEN ||
                   socket.readyState === WebSocket.CONNECTING)) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/ws/${gameId}/${playerId}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log('[WS] Connesso');
      reconnectDelay = 1000;
      clearTimeout(reconnectTimer);
      _startKeepalive();
      _dispatch('connected', {});
    };

    socket.onclose = (e) => {
      console.log('[WS] Disconnesso', e.code);
      _stopKeepalive();
      _dispatch('disconnected', { code: e.code });
      _scheduleReconnect();
    };

    socket.onerror = (e) => {
      console.error('[WS] Errore', e);
    };

    socket.onmessage = (e) => {
      lastPong = Date.now();  // qualunque messaggio prova che la linea è viva
      try {
        const msg = JSON.parse(e.data);
        _dispatch(msg.type, msg);
      } catch (err) {
        console.error('[WS] Messaggio non valido', e.data);
      }
    };
  }

  function _startKeepalive() {
    _stopKeepalive();
    keepaliveTimer = setInterval(_checkAlive, KEEPALIVE_INTERVAL);
    httpKeepaliveTimer = setInterval(() => {
      fetch('/health').catch(() => {});
    }, HTTP_KEEPALIVE_INTERVAL);
  }

  // Manda un ping e, se entro PONG_TIMEOUT non arriva nulla, riconnette.
  function _checkAlive() {
    if (!gameId) return;
    if (!socket || socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED) {
      _reconnectNow();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;  // sta già connettendo
    const sentAt = Date.now();
    try {
      socket.send(JSON.stringify({ type: 'ping' }));
    } catch (err) {
      _reconnectNow();
      return;
    }
    clearTimeout(pongWatchdog);
    pongWatchdog = setTimeout(() => {
      if (lastPong < sentAt) {
        console.warn('[WS] Nessuna risposta dal server, riconnessione');
        _reconnectNow();
      }
    }, PONG_TIMEOUT);
  }

  // Butta via la connessione attuale e ne apre subito una nuova (il server,
  // alla connessione, rimanda lo stato della partita).
  function _reconnectNow() {
    if (!gameId) return;
    _teardown();
    reconnectDelay = 1000;
    _open();
  }

  function _stopKeepalive() {
    clearTimeout(pongWatchdog);
    pongWatchdog = null;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    clearInterval(httpKeepaliveTimer);
    httpKeepaliveTimer = null;
  }

  function _scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log(`[WS] Tentativo di riconnessione (${reconnectDelay}ms)...`);
      _open();
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
  }

  function send(type, data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Socket non pronto, messaggio perso:', type);
      // Niente attesa del backoff: si riprova subito a connettersi
      if (gameId && (!socket || socket.readyState !== WebSocket.CONNECTING)) _reconnectNow();
      return;
    }
    socket.send(JSON.stringify({ type, ...data }));
  }

  function sendAction(action, params = {}) {
    send('action', { action, params });
  }

  function on(eventType, handler) {
    if (!handlers[eventType]) handlers[eventType] = [];
    handlers[eventType].push(handler);
  }

  function off(eventType, handler) {
    if (!handlers[eventType]) return;
    handlers[eventType] = handlers[eventType].filter(h => h !== handler);
  }

  function _dispatch(type, data) {
    (handlers[type] || []).forEach(h => h(data));
    (handlers['*'] || []).forEach(h => h(type, data));
  }

  function _teardown() {
    _stopKeepalive();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      // Stacca gli handler prima di chiudere: onclose scatta in modo asincrono
      // e rischierebbe di riprogrammare una riconnessione alla vecchia partita.
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    socket = null;
  }

  function disconnect() {
    _teardown();
    gameId = null;
    playerId = null;
  }

  // Rientro nell'app / nella scheda: i timer erano congelati e il backoff può
  // essere arrivato a 30 s. Si verifica subito la connessione.
  function _onResume() {
    if (document.visibilityState === 'hidden' || !gameId) return;
    _checkAlive();
  }
  document.addEventListener('visibilitychange', _onResume);
  window.addEventListener('pageshow', _onResume);
  window.addEventListener('online', _onResume);

  return { connect, send, sendAction, on, off, disconnect };
})();
