"""
Cronaca della partita: racconta in italiano cosa succede al tavolo.

Il motore registra le mosse in `state.log` (ActionLog) e le loro conseguenze
in `state.recent_events` (D10, Danni da Magia, Orde...). `sync()` trasforma
ciò che non è ancora stato raccontato in voci di `state.chronicle`, una volta
sola, e aggiorna le statistiche del riepilogo di fine partita.

Ogni voce è un dict:
    {"id", "turn", "kind", "player_id", "text", "private_for", "private_text"}
- kind: "turn" (intestazione di un turno) | "action" | "battle" | "event" | "system"
- text: frase pubblica. Contiene segnaposto che i client trasformano in nomi
  evidenziati: {p:player_id} per un giocatore, {c:base_card_id} per una carta.
- private_for / private_text: versione per il solo giocatore indicato, che
  può vedere le carte coperte (es. le carte pescate, i propri Muri).

`view()` restituisce le ultime voci per un certo giocatore, con il testo
privato già sostituito: nessuno riceve informazioni che non potrebbe vedere.
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional

from engine.cards import CARD_REGISTRY
from engine.deck import get_base_card_id
from engine.models import ActionLog, GameState

MAX_ENTRIES = 250   # voci conservate nello stato salvato
VIEW_ENTRIES = 120  # voci inviate ai client a ogni aggiornamento

_REGION = {
    "vanguard": "in Avanscoperta",
    "bastion_left": "nel Bastione sinistro",
    "bastion_right": "nel Bastione destro",
}
_REGION_PLAIN = {
    "vanguard": "Avanscoperta",
    "bastion_left": "Bastione sinistro",
    "bastion_right": "Bastione destro",
}
_SIDE = {"left": "sinistro", "right": "destro"}

STAT_KEYS = ("warriors", "spells", "buildings", "walls", "battles", "damage", "lives_taken", "hordes")


# ---------------------------------------------------------------------------
# Segnaposto
# ---------------------------------------------------------------------------

def _p(player_id: Optional[str]) -> str:
    return f"{{p:{player_id}}}" if player_id else "qualcuno"


def _c(iid_or_base: Optional[str]) -> str:
    if not iid_or_base:
        return "una carta"
    base = iid_or_base if iid_or_base in CARD_REGISTRY else get_base_card_id(iid_or_base)
    return f"{{c:{base}}}"


def _to_card(iid_or_base: Optional[str]) -> str:
    """"a {carta}", o "ad {carta}" se il nome comincia per A (ad Araminta)."""
    base = iid_or_base if iid_or_base in CARD_REGISTRY else get_base_card_id(iid_or_base or "")
    card = CARD_REGISTRY.get(base)
    prep = "ad" if card and card.name[:1].lower() == "a" else "a"
    return f"{prep} {_c(iid_or_base)}"


def _cards(iids: List[str]) -> str:
    names = [_c(i) for i in iids]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " e " + names[-1]


def _n(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def _bastion(player_id: Optional[str], side: Optional[str]) -> str:
    return f"il Bastione {_SIDE.get(side or '', side or '')} di {_p(player_id)}"


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def sync(state: GameState) -> None:
    """Racconta tutto ciò che è successo dall'ultima chiamata. Idempotente:
    le voci di log sono tracciate da `chronicle_cursor`, gli eventi vengono
    marcati (`_told`) perché `recent_events` non sempre viene svuotato tra
    un'azione e l'altra (es. durante il turno di un Bot)."""
    if state.chronicle_cursor < 0:
        # Cronaca mai avviata: si salta lo storico (distribuzione iniziale o
        # partita salvata prima della cronaca) e si parte dal turno corrente.
        state.chronicle_cursor = len(state.log)
    if not state.chronicle:
        _add(state, "turn", state.current_player.id, f"Turno {state.turn} · {_p(state.current_player.id)}")

    for entry in state.log[state.chronicle_cursor:]:
        _tell_log(state, entry)
    state.chronicle_cursor = len(state.log)

    for ev in state.recent_events:
        if ev.get("_told"):
            continue
        ev["_told"] = True
        _tell_event(state, ev)

    _check_eliminations(state)

    if len(state.chronicle) > MAX_ENTRIES:
        del state.chronicle[: len(state.chronicle) - MAX_ENTRIES]


def view(state: GameState, viewer_id: Optional[str]) -> List[Dict[str, Any]]:
    """Ultime voci della cronaca come le vede `viewer_id`."""
    out = []
    for e in state.chronicle[-VIEW_ENTRIES:]:
        text = e["private_text"] if e.get("private_for") and e["private_for"] == viewer_id else e["text"]
        out.append({"id": e["id"], "turn": e["turn"], "kind": e["kind"],
                    "player_id": e.get("player_id"), "text": text})
    return out


def start(state: GameState) -> None:
    """Avvia la cronaca di una partita appena creata, saltando la distribuzione
    iniziale delle carte."""
    state.chronicle = []
    state.chronicle_cursor = len(state.log)


# ---------------------------------------------------------------------------
# Voci e statistiche
# ---------------------------------------------------------------------------

def _add(state: GameState, kind: str, player_id: Optional[str], text: str,
         private_for: Optional[str] = None, private_text: Optional[str] = None,
         turn: Optional[int] = None) -> None:
    last_id = state.chronicle[-1]["id"] if state.chronicle else 0
    entry = {"id": last_id + 1, "turn": state.turn if turn is None else turn,
             "kind": kind, "player_id": player_id, "text": text}
    if private_for and private_text:
        entry["private_for"] = private_for
        entry["private_text"] = private_text
    state.chronicle.append(entry)


def _stat(state: GameState, player_id: Optional[str], key: str, amount: int = 1) -> None:
    if not player_id or not amount:
        return
    stats = state.match_stats.setdefault(player_id, {k: 0 for k in STAT_KEYS})
    stats[key] = stats.get(key, 0) + amount


def _check_eliminations(state: GameState) -> None:
    gone = {e["player_id"] for e in state.eliminations}
    for p in state.players:
        if p.is_alive or p.id in gone:
            continue
        state.eliminations.append({"player_id": p.id, "turn": state.turn, "abandoned": False})
        _add(state, "system", p.id, f"{_p(p.id)} perde l'ultima Vita ed è fuori dalla partita.")


# ---------------------------------------------------------------------------
# Log delle mosse
# ---------------------------------------------------------------------------

def _tell_log(state: GameState, entry: ActionLog) -> None:
    pid, a, d = entry.player_id, entry.action, entry.detail
    who = _p(pid)

    if a == "start_turn":
        _add(state, "turn", pid, f"Turno {d.get('turn', entry.turn)} · {who}", turn=d.get("turn", entry.turn))

    elif a == "skip_mana":
        _add(state, "event", pid, f"{who} non riceve Mana in questo turno.")

    elif a == "play_warrior":
        _stat(state, pid, "warriors")
        _add(state, "action", pid, f"{who} schiera {_c(d.get('card'))} {_REGION.get(d.get('region'), '')}.".replace(" .", "."))

    elif a == "evolve_warrior":
        _stat(state, pid, "warriors")
        _add(state, "action", pid, f"{who} evolve {_c(d.get('recruit'))} in {_c(d.get('hero'))}.")

    elif a == "play_spell":
        _stat(state, pid, "spells")
        prodigy = " con Prodigio" if d.get("prodigy") else ""
        _add(state, "action", pid, f"{who} lancia {_c(d.get('card'))}{prodigy}.")

    elif a == "recast_spell":
        prodigy = " con Prodigio" if d.get("prodigy") else ""
        _add(state, "action", pid, f"{who} rilancia {_c(d.get('card'))}{prodigy} (Orda di {_c('evelyn')}).")

    elif a == "recast_spell_skipped":
        _add(state, "action", pid, f"{who} rinuncia a rilanciare {_c(d.get('card'))}.")

    elif a == "play_building":
        _stat(state, pid, "buildings")
        done = " già completata" if d.get("completed") else ""
        _add(state, "action", pid, f"{who} costruisce {_c(d.get('card'))}{done}.")

    elif a == "complete_building":
        how = f" gratis (grazie al {_c('decumano')})" if d.get("decumano_free") else ""
        _add(state, "action", pid, f"{who} completa {_c(d.get('card'))}{how}.")

    elif a == "add_wall":
        walls = d.get("walls") or []
        _stat(state, pid, "walls", len(walls))
        by_side = {s: [w["card"] for w in walls if w.get("bastion") == s] for s in ("left", "right")}
        sides = [s for s, v in by_side.items() if v]
        if len(sides) == 1:
            public = f"{who} alza {_n(len(walls), 'Muro', 'Muri')} nel Bastione {_SIDE[sides[0]]}."
            private = f"{who} alza {_n(len(walls), 'Muro', 'Muri')} nel Bastione {_SIDE[sides[0]]}: {_cards(by_side[sides[0]])}."
        else:
            public = (f"{who} alza {_n(len(walls), 'Muro', 'Muri')}: "
                      f"{len(by_side['left'])} nel Bastione sinistro e {len(by_side['right'])} nel destro.")
            private = (f"{who} alza {_n(len(walls), 'Muro', 'Muri')}: {_cards(by_side['left'])} nel Bastione "
                       f"sinistro e {_cards(by_side['right'])} nel destro.")
        _add(state, "action", pid, public, pid, private)

    elif a == "reposition":
        _add(state, "action", pid,
             f"{who} sposta {_c(d.get('warrior'))} da {_REGION_PLAIN.get(d.get('from_region'), '?')} "
             f"a {_REGION_PLAIN.get(d.get('to_region'), '?')}.")

    elif a == "activate_horde":
        _stat(state, pid, "hordes")
        zone = _REGION.get(d.get("zone"), "")
        _add(state, "action", pid, f"{who} attiva l'Orda di {_c(d.get('horde_card'))} {zone}.".replace(" .", "."))

    elif a == "arena_activate":
        _add(state, "action", pid, f"{who} usa l'{_c('arena')}.")

    elif a == "eracle_destroy":
        _add(state, "action", pid,
             f"{who} distrugge {_c(d.get('building'))} di {_p(d.get('from_player'))} (Orda di {_c('eracle')}).")

    elif a == "battle":
        _tell_battle(state, pid, d)

    elif a == "draw":
        cards = d.get("cards") or []
        if cards:
            _add(state, "event", pid, f"{who} pesca {_n(len(cards), 'carta', 'carte')}.",
                 pid, f"{who} pesca {_cards(cards)}.")

    elif a == "search":
        _add(state, "event", pid, f"{who} prende una carta dal mazzo.",
             pid, f"{who} prende {_c(d.get('card'))} dal mazzo.")

    elif a == "biblioteca_suppressed":
        _add(state, "event", pid, f"La {_c('biblioteca')} di {who} resta ferma (Orda di {_c('faust')}).")

    elif a in ("biblioteca_discard", "agilpesca_discard"):
        source = "biblioteca" if a == "biblioteca_discard" else "agilpesca"
        _add(state, "event", pid, f"{who} scarta una carta ({_c(source)}).",
             pid, f"{who} scarta {_c(d.get('card'))} ({_c(source)}).")

    elif a == "biblioteca_wall":
        side = _SIDE.get(d.get("bastion"), "")
        _stat(state, pid, "walls")
        _add(state, "event", pid, f"{who} alza un Muro nel Bastione {side} ({_c('biblioteca')}).",
             pid, f"{who} alza {_c(d.get('card'))} come Muro nel Bastione {side} ({_c('biblioteca')}).")

    elif a == "velocemento_ethereal":
        _add(state, "event", pid, f"{who} rende Eterea una Costruzione in mano ({_c('velocemento')}).",
             pid, f"{who} rende Eterea {_c(d.get('building'))} ({_c('velocemento')}).")

    elif a == "magiscudo_counter":
        _add(state, "event", pid,
             f"{who} risponde con {_c('magiscudo')}: {_c(d.get('spell'))} non ha effetto.")

    elif a == "malcomune_discard":
        _add(state, "event", pid, f"{who} scarta {_c(d.get('warrior'))} ({_c('malcomune')}).")

    elif a == "abandon":
        state.eliminations.append({"player_id": pid, "turn": state.turn, "abandoned": True})
        _add(state, "system", pid, f"{who} abbandona la partita.")

    elif a == "game_over":
        _add(state, "system", pid, f"{who} conquista il Barbacane!")

    # receive_mana, magiscudo_counter_declined: nessuna voce (il Mana è nella
    # barra del giocatore, il rifiuto di Magiscudo si vede dall'effetto che segue)


def _tell_battle(state: GameState, pid: str, d: Dict[str, Any]) -> None:
    attacker, defender = _p(pid), d.get("defender_id")
    total = d.get("total_damage", 0)
    walls = d.get("walls_destroyed", 0)
    life = d.get("life_lost", 0)
    _stat(state, pid, "battles")
    _stat(state, pid, "damage", total)
    _stat(state, pid, "lives_taken", life)

    stats = f"ATT {d.get('att_att')} contro DIF {d.get('def_dif')}, GIT {d.get('att_git')} contro {d.get('def_git')}"
    text = f"{attacker} attacca {_bastion(defender, d.get('defender_bastion'))} ({stats}): "
    if total <= 0:
        text += "nessun Danno."
    else:
        outcome = [_n(total, "Danno", "Danni")]
        if walls:
            outcome.append(f"{_n(walls, 'Muro distrutto', 'Muri distrutti')}")
        if life:
            outcome.append(f"{_p(defender)} perde una Vita")
        text += ", ".join(outcome) + "."
    if d.get("walls_discarded_guerremoto"):
        text += f" Prima dello scontro {_c('guerremoto')} fa crollare {_n(d['walls_discarded_guerremoto'], 'Muro', 'Muri')}."
    _add(state, "battle", pid, text)


# ---------------------------------------------------------------------------
# Eventi (conseguenze delle carte)
# ---------------------------------------------------------------------------

def _tell_event(state: GameState, ev: Dict[str, Any]) -> None:
    t, card, pid = ev.get("type"), ev.get("card"), ev.get("player_id")
    who = _p(pid)

    if t == "d10":
        roll = ev.get("roll")
        if card == "estrattore":
            outcome = f"+{ev.get('mana_gained', 1)} Mana" if ev.get("triggered") else "niente Mana"
        elif card == "granaio":
            outcome = "una carta in più" if ev.get("triggered") else "nessuna carta in più"
        elif card == "obelisco":
            outcome = ("la Magia torna in mano" if ev.get("returned") else "la Magia va negli scarti") \
                + f" (serviva {ev.get('threshold')} o più)"
        elif card == "fucina":
            outcome = "un'Azione in più" if ev.get("extra_action") else "nessuna Azione in più"
        else:
            outcome = ""
        _add(state, "event", pid, f"{who} · {_c(card)}: D10 = {roll}, {outcome}.".replace(", .", "."))

    elif t == "mana":
        _add(state, "event", pid, f"{who} · {_c(card)}: +{ev.get('mana_gained', 0)} Mana.")

    elif t == "damage":
        damage = ev.get("damage", 0)
        target = ev.get("target_player_id")
        _stat(state, pid, "damage", damage)
        _stat(state, pid, "lives_taken", ev.get("life_lost", 0))
        text = f"{_c(card)} infligge {_n(damage, 'Danno', 'Danni')} a {_bastion(target, ev.get('target_bastion_side'))}"
        if ev.get("walls_destroyed"):
            text += f": {_n(ev['walls_destroyed'], 'Muro distrutto', 'Muri distrutti')}"
        if ev.get("life_lost"):
            text += f", {_p(target)} perde una Vita"
        _add(state, "event", pid, text + ".")

    elif t == "life_gained":
        gained = ev.get("lives_gained", 0)
        text = f"{who} · {_c(card)}: +{_n(gained, 'Vita', 'Vite')}." if gained else f"{who} · {_c(card)}: nessuna Vita guadagnata."
        if ev.get("enemy_sorgive_discarded"):
            text += f" Scartate {_n(len(ev['enemy_sorgive_discarded']), 'Sorgiva', 'Sorgive')} avversarie."
        _add(state, "event", pid, text)

    elif t == "magiscudo_blocked":
        _add(state, "event", pid,
             f"{_c(card)} di {who} non colpisce {_p(ev.get('blocked_player'))}, protetto da {_c('magiscudo')}.")

    elif t == "warrior_discarded":
        if card == "arena":
            text = f"{_c('arena')}: {who} sacrifica {_c(ev.get('own_discarded'))}"
            if ev.get("target_discarded"):
                text += f" e scarta {_c(ev['target_discarded'])}"
            _add(state, "event", pid, text + ".")
        elif card == "malcomune":
            parts = []
            if ev.get("own_discarded"):
                parts.append(f"{who} scarta {_c(ev['own_discarded'])}")
            for e in ev.get("enemies_discarded") or []:
                parts.append(f"{_p(e.get('player'))} scarta {_c(e.get('warrior'))}")
            if parts:
                _add(state, "event", pid, f"{_c('malcomune')}: " + "; ".join(parts) + ".")
        elif ev.get("warrior_discarded"):
            _add(state, "event", pid,
                 f"{_c(card)}: {_c(ev['warrior_discarded'])} di {_p(ev.get('from_player'))} va negli scarti.")

    elif t == "warrior_moved":
        _add(state, "event", pid,
             f"{_c(card)}: {who} prende {_c(ev.get('warrior_taken'))} a {_p(ev.get('from_player'))}.")

    elif t == "warrior_to_wall":
        _add(state, "event", pid,
             f"{_c(card)}: {_c(ev.get('warrior_moved'))} di {_p(ev.get('from_player'))} diventa un Muro.")

    elif t == "wall_moved":
        if card == "telecinesi":
            moved = ev.get("moved_walls") or []
            _add(state, "event", pid, f"{_c(card)}: {_n(len(moved), 'Muro spostato', 'Muri spostati')}.")
        elif card == "arrampicarta":
            text = f"{_c(card)}: {who} assegna un Muro {_to_card(ev.get('warrior'))}" if ev.get("warrior") \
                else f"{_c(card)}: Muri riassegnati"
            if ev.get("enemy_assigned_removed"):
                text += ", i Muri assegnati avversari tornano negli scarti"
            _add(state, "event", pid, text + ".")

    elif t == "wall_taken":
        side = _SIDE.get(ev.get("from_bastion"), "")
        extra = " e la rende Eterea" if ev.get("ethereal") else ""
        _add(state, "event", pid, f"{_c(card)}: {who} riprende in mano un Muro dal Bastione {side}{extra}.",
             pid, f"{_c(card)}: {who} riprende in mano {_c(ev.get('wall_taken'))} dal Bastione {side}{extra}.")

    elif t == "discard" and card == "regicidio":
        text = f"{_c(card)}: {_p(ev.get('from_player'))} perde il suo {_c('trono')}"
        if ev.get("warrior_discarded"):
            text += f" e {_c(ev['warrior_discarded'])}"
        _add(state, "event", pid, text + ".")

    elif t == "horde":
        _tell_horde(state, ev)

    elif t == "effect":
        _tell_effect(state, ev)

    # draw, search, ethereal, abandon: raccontati dalle voci di log corrispondenti


def _tell_horde(state: GameState, ev: Dict[str, Any]) -> None:
    card, pid = ev.get("card"), ev.get("player_id")
    if card == "patrizio" and ev.get("target"):
        text = f"{_c(ev['target'])} ottiene +{ev.get('git_bonus', 2)} GIT."
    elif card == "orfeo" and ev.get("target"):
        text = f"{_c(ev['target'])} ottiene +1 ATT e +1 DIF."
    elif card == "polemarco":
        text = f"+{ev.get('att_bonus', 0)} ATT ({_n(ev.get('umani_count', 0), 'Umano', 'Umani')} in campo)."
    elif card == "joseph":
        troni = ev.get("enemy_troni_discarded") or []
        text = f"{_n(len(troni), 'Trono avversario scartato', 'Troni avversari scartati')}." if troni \
            else "i Troni avversari non hanno effetto."
    else:
        return  # l'attivazione dell'Orda è già raccontata dalla voce di log
    _add(state, "event", pid, f"Orda di {_c(card)}: {text}")


def _tell_effect(state: GameState, ev: Dict[str, Any]) -> None:
    card, pid = ev.get("card"), ev.get("player_id")
    who = _p(pid)
    if card == "ardolancio":
        n = ev.get("walls_discarded", 0)
        side = _SIDE.get(ev.get("target_bastion_side"), "")
        target = _p(ev.get("target_player_id"))
        text = (f"{_c(card)} fa crollare {_n(n, 'Muro', 'Muri')} dal Bastione {side} di {target}." if n
                else f"{_c(card)} non trova Muri da abbattere nel Bastione {side} di {target}.")
    elif card == "guerremoto":
        text = f"{_c(card)}: {who} può attaccare qualsiasi Bastione"
        if ev.get("discard_walls"):
            text += f" e farà crollare fino a {_n(ev['discard_walls'], 'Muro', 'Muri')} prima dei Danni"
        text += "."
    elif card == "magiscudo":
        text = f"{who} è immune alle Magie fino al suo prossimo turno."
    elif card == "divinazione":
        text = f"{_c(card)}: {who} riceverà Mana extra all'inizio del prossimo turno."
    elif card == "dazipazzi":
        n = len(ev.get("reset_buildings") or [])
        text = f"{_c(card)}: {_n(n, 'Costruzione avversaria torna incompleta', 'Costruzioni avversarie tornano incomplete')}." \
            if n else f"{_c(card)}: nessuna Costruzione avversaria colpita."
    elif card == "equipotenza":
        text = f"{_c(card)}: statistiche equiparate."
    elif card == "bastioncontrario":
        text = f"{_c(card)}: Muri dei Bastioni scambiati."
    elif card == "trono" and ev.get("assigned_to"):
        text = f"{_c(card)} assegnato {_to_card(ev['assigned_to'])}."
    elif card == "fucina" and ev.get("extra_action"):
        text = f"{who} · {_c(card)}: un'Azione in più."
    elif card == "decumano" and ev.get("cardo_free"):
        text = f"{who} · {_c(card)}: il {_c('cardo')} si completa gratis."
    else:
        return
    _add(state, "event", pid, text)
