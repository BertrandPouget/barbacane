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

  const handlers = {};

  function connect(gId, pId) {
    gameId = gId;
    playerId = pId;
    _open();
  }

  function _open() {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/ws/${gameId}/${playerId}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log('[WS] Connesso');
      reconnectDelay = 1000;
      clearTimeout(reconnectTimer);
      _dispatch('connected', {});
    };

    socket.onclose = (e) => {
      console.log('[WS] Disconnesso', e.code);
      _dispatch('disconnected', { code: e.code });
      _scheduleReconnect();
    };

    socket.onerror = (e) => {
      console.error('[WS] Errore', e);
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        _dispatch(msg.type, msg);
      } catch (err) {
        console.error('[WS] Messaggio non valido', e.data);
      }
    };
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

  function disconnect() {
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
    socket = null;
  }

  return { connect, send, sendAction, on, off, disconnect };
})();
