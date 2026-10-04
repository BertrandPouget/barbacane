/**
 * chronicle.js — Cronaca e riepilogo di fine partita, condivisi dai client
 * desktop e mobile.
 *
 * Il server (engine/chronicle.py) invia in state.chronicle frasi già pronte e
 * già filtrate per chi guarda, con due segnaposto: {p:player_id} per un
 * giocatore e {c:base_card_id} per una carta. Qui diventano HTML.
 */

'use strict';

const Chronicle = (() => {

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /**
   * Converte una frase della cronaca in HTML.
   * opts.cardDefs: {base_card_id: def} per i nomi delle carte.
   * opts.myPlayerId: il proprio nome è evidenziato.
   * opts.interactive: le carte diventano pulsanti (class "chr-card", data-card).
   */
  function toHTML(text, state, opts = {}) {
    const players = (state && state.players) || [];
    const defs = opts.cardDefs || {};
    return escapeHTML(text)
      .replace(/\{p:([^}]+)\}/g, (_, pid) => {
        const seat = players.findIndex(p => p.id === pid);
        const name = seat >= 0 ? players[seat].name : pid;
        const me = pid === opts.myPlayerId ? ' chr-me' : '';
        return `<span class="chr-player chr-seat-${Math.max(0, seat)}${me}">${escapeHTML(name)}</span>`;
      })
      .replace(/\{c:([^}]+)\}/g, (_, base) => {
        const name = escapeHTML((defs[base] && defs[base].name) || base);
        return opts.interactive
          ? `<button type="button" class="chr-card" data-card="${escapeHTML(base)}">${name}</button>`
          : `<span class="chr-card">${name}</span>`;
      });
  }

  /** Testo semplice (senza HTML), per le notifiche. */
  function toText(text, state, cardDefs = {}) {
    const players = (state && state.players) || [];
    return String(text)
      .replace(/\{p:([^}]+)\}/g, (_, pid) => (players.find(p => p.id === pid) || {}).name || pid)
      .replace(/\{c:([^}]+)\}/g, (_, base) => (cardDefs[base] && cardDefs[base].name) || base);
  }

  function entries(state) {
    return (state && state.chronicle) || [];
  }

  function lastId(state) {
    const list = entries(state);
    return list.length ? list[list.length - 1].id : 0;
  }

  /** Voci comparse in `next` rispetto a `prevLastId` (id dell'ultima voce già vista). */
  function newSince(prevLastId, next) {
    return entries(next).filter(e => e.id > prevLastId);
  }

  /** Raggruppa le voci per turno: [{header: voce "turn" | null, items: [...]}]. */
  function groupByTurn(list) {
    const groups = [];
    let current = null;
    list.forEach(e => {
      if (e.kind === 'turn' || !current) {
        current = { header: e.kind === 'turn' ? e : null, items: [] };
        groups.push(current);
        if (e.kind === 'turn') return;
      }
      current.items.push(e);
    });
    return groups;
  }

  // ---------------------------------------------------------------------------
  // Riepilogo di fine partita
  // ---------------------------------------------------------------------------

  const STAT_COLUMNS = [
    { key: 'warriors', label: 'Guerrieri' },
    { key: 'spells', label: 'Magie' },
    { key: 'buildings', label: 'Costruzioni' },
    { key: 'walls', label: 'Muri' },
    { key: 'battles', label: 'Battaglie' },
    { key: 'damage', label: 'Danni inflitti' },
    { key: 'lives_taken', label: 'Vite tolte' },
  ];

  /**
   * Classifica finale: vincitore in testa, poi gli eliminati dall'ultimo al
   * primo (chi è uscito più tardi è arrivato più avanti).
   * Ritorna [{player, place, outcome, stats}].
   */
  function standings(state) {
    const players = state.players || [];
    const elim = state.eliminations || [];
    const elimIndex = pid => elim.findIndex(e => e.player_id === pid);
    const sorted = [...players].sort((a, b) => {
      if (a.id === state.winner_id) return -1;
      if (b.id === state.winner_id) return 1;
      return elimIndex(b.id) - elimIndex(a.id);
    });
    return sorted.map((p, i) => {
      const e = elim.find(x => x.player_id === p.id);
      let outcome = 'In gioco';
      if (p.id === state.winner_id) outcome = 'Vincitore';
      else if (e && e.abandoned) outcome = `Ritirato al turno ${e.turn}`;
      else if (e) outcome = `Eliminato al turno ${e.turn}`;
      const stats = (state.match_stats || {})[p.id] || {};
      return { player: p, place: i + 1, outcome, stats };
    });
  }

  return { escapeHTML, toHTML, toText, entries, lastId, newSince, groupByTurn, standings, STAT_COLUMNS };
})();
