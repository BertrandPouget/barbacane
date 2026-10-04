/**
 * session.js — Partita in corso salvata nel browser, link d'invito e nome
 * del giocatore, condivisi dai client desktop e mobile.
 */

'use strict';

const SavedGame = (() => {
  // localStorage: sopravvive alla chiusura del browser (pulsante "Riprendi").
  // sessionStorage: solo questa scheda, per riprendere da sola dopo un ricaricamento.
  const KEY = 'barb_game';

  function _read(storage) {
    try { return JSON.parse(storage.getItem(KEY) || 'null'); } catch (_) { return null; }
  }

  /** data: {gameId, token, playerId, lobbyCode, mode} */
  function save(data) {
    const value = JSON.stringify({ ...data, savedAt: Date.now() });
    try { localStorage.setItem(KEY, value); } catch (_) {}
    try { sessionStorage.setItem(KEY, value); } catch (_) {}
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
    try { sessionStorage.removeItem(KEY); } catch (_) {}
  }

  /** La partita salvata da questa scheda (ricaricamento) o, con anyTab, anche da altre sessioni. */
  function load(anyTab = false) {
    return _read(sessionStorage) || (anyTab ? _read(localStorage) : null);
  }

  /**
   * Controlla sul server che la partita salvata sia ancora in corso e che il
   * giocatore sia ancora in gioco. Ritorna lo stato pubblico, o null (e in
   * quel caso dimentica la partita).
   */
  async function check(saved) {
    if (!saved || !saved.gameId || !saved.token) return null;
    try {
      const res = await fetch(`/game/${encodeURIComponent(saved.gameId)}?session_token=${encodeURIComponent(saved.token)}`);
      if (!res.ok) { clear(); return null; }
      const state = await res.json();
      // Il giocatore "visibile" (mano non oscurata) è il proprietario del token
      const mine = state && state.players && state.players.find(p => p.hand !== null && p.hand !== undefined);
      if (!state || state.winner_id || !mine || mine.lives <= 0) { clear(); return null; }
      return state;
    } catch (_) {
      return null;  // rete assente: non dimenticare la partita
    }
  }

  return { save, clear, load, check };
})();

const Invite = {
  /** Link che apre il gioco con il codice lobby già inserito. */
  link(code) {
    return `${location.origin}/?join=${encodeURIComponent(code)}`;
  },

  /** Testo dell'invito da condividere (uguale su desktop e mobile). */
  TEXT: 'Unisciti alla mia partita di Barbacane:',
  message(code) {
    return `${this.TEXT} ${this.link(code)}`;
  },

  /** Codice lobby passato con ?join=, rimosso dall'indirizzo per non riusarlo al ricaricamento. */
  takeFromURL() {
    const qs = new URLSearchParams(location.search);
    const code = (qs.get('join') || '').trim().toUpperCase();
    if (!code) return null;
    qs.delete('join');
    const rest = qs.toString();
    try { history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash); } catch (_) {}
    return /^BARB-[A-Z0-9]{4}$/.test(code) ? code : null;
  },
};

const PlayerName = {
  KEY: 'barb_name',
  get() {
    try { return localStorage.getItem(this.KEY) || ''; } catch (_) { return ''; }
  },
  set(name) {
    try { if (name) localStorage.setItem(this.KEY, name); } catch (_) {}
  },
};
