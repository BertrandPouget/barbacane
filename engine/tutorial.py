"""
Modalità Tutorial di Barbacane.

Il Tutorial è una breve partita scriptata di 4 turni contro il "Manichino"
(player_2): il giocatore ("player_1") gioca con le Maghe e deve togliergli le
2 Vite. Le regole si scoprono facendo: ogni passo chiede al giocatore uno o più
obiettivi, e il testo commenta le mosse appena fatte. In mano ci sono solo le
carte che servono in quel momento.

Uno step è di due tipi:
- informativo (nessun obiettivo): si avanza con l'azione "tutorial_next"
  (bottone "Avanti" in UI).
- con obiettivi (`goals`): ogni obiettivo è una mossa di gioco reale (stessa
  validazione del motore). Si possono compiere in qualsiasi ordine, salvo le
  dipendenze dichiarate in `after`; lo step avanza quando sono tutti fatti.

Le carte si leggono quando il giocatore le tocca in mano per la prima volta:
`CARD_READS` descrive, sezione per sezione, le carte che vanno spiegate, e il
client le mostra a schermo intero una sezione alla volta prima del dettaglio.

Tornare indietro ("tutorial_prev") è possibile solo verso uno step
informativo e solo se nel passo corrente non è ancora stato spuntato nessun
obiettivo: si ripristina l'istantanea dello stato salvata all'ingresso di
quello step (`tutorial["snapshots"]`). Una mossa già giocata non si annulla mai:
le istantanee si azzerano a ogni obiettivo spuntato.

`validate_action` viene chiamata da server/routes.py PRIMA di eseguire
l'azione, per rifiutare mosse fuori copione. `advance_after_action` viene
chiamata DOPO che l'azione è stata eseguita con successo, per spuntare
l'obiettivo e, se era l'ultimo, passare allo step successivo (e applicarne il
setup). Il turno del Manichino è il setup degli step che seguono un
"Fine Turno": gioca con le funzioni vere del motore, così la Cronaca lo racconta.
"""

from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Union

from engine.models import GameState, Player
from engine.deck import make_warrior_instance, make_wall_instance
from engine.actions import ActionError, add_wall, play_warrior, reposition_warrior

MatchType = Union[Dict[str, Any], Callable[[dict], bool]]


# ---------------------------------------------------------------------------
# Definizione degli step/tutorial
# ---------------------------------------------------------------------------

class Goal:
    def __init__(
        self,
        goal_id: str,
        label: str,
        action: str,
        match: Optional[MatchType] = None,
        hint: Optional[str] = None,
        after: Optional[List[str]] = None,
        wait_hint: Optional[str] = None,
        done: Optional[Callable[[GameState], bool]] = None,
        highlight: Optional[List[str]] = None,
        feedback: Optional[str] = None,
    ):
        self.goal_id = goal_id
        self.label = label                # voce della lista obiettivi
        self.action = action
        self.match = match or {}
        self.hint = hint or "Non è la mossa richiesta dal tutorial."
        self.after = after or []          # obiettivi da completare prima
        self.wait_hint = wait_hint        # errore se si anticipa l'obiettivo
        # Se presente, l'obiettivo si spunta solo quando done(state) è vero
        # (es. next_phase va ripetuto finché non si arriva alla Battaglia).
        self.done = done
        self.highlight = highlight or []
        self.feedback = feedback          # commento mostrato appena fatto


class TutorialStep:
    def __init__(
        self,
        step_id: str,
        chapter: str,
        title: str,
        text: str,
        highlight: Optional[List[str]] = None,
        goals: Optional[List[Goal]] = None,
        setup: Optional[Callable[[GameState], None]] = None,
        panel_center: bool = False,
    ):
        self.step_id = step_id
        self.chapter = chapter            # es. "Turno 1 di 4"
        self.title = title
        self.text = text
        self.highlight = highlight or []  # solo per gli step informativi
        self.goals = goals or []
        self.setup = setup
        # Pannello al centro anche con zone evidenziate, per non farlo saltare
        self.panel_center = panel_center


# Il frontend mobile usa ID DOM diversi (layout a tasselli invece che regioni
# fisse): questa mappa deriva automaticamente gli highlight mobile da quelli
# desktop, così ogni passo si scrive una volta sola. Un ID desktop può
# corrispondere a più ID mobile (una lista): lo Spotlight li evidenzia tutti.
_MOBILE_HIGHLIGHT_MAP: Dict[str, Union[str, List[str]]] = {
    ">hand-cards": ">hand",
    "hdr-deck": "tb-deck",
    "my-life-deck": "st-lives",
    "my-field": "field-grid",
    "my-vanguard": "fld-vanguard",
    "my-bastion-left": "tw-left",
    "my-bastion-right": "tw-right",
    "my-village": "tw-village",
    # Solo Mana e Azioni: nella statusbar mobile ci sono anche Vite ed Effetti.
    "my-stats": ["st-mana", "st-actions"],
    "action-panel": "dock",
    "banner-btn-wall": "dock-wall",
    "banner-btn-play": ">hand",
    "banner-btn-complete": "dock-complete",
    "wall-staging": "wall-tray",
    "btn-next-phase": "dock-next",
    "btn-horde": "dock-horde",
    "btn-battle": "dock-attack",
    "btn-end-turn": "dock-end-turn",
    "phase-bar": "tb-phase",
    "my-active-cards": "st-fx",
    "top-opponents": "opp-rail",
}


def _mobile_ids(ids: List[str]) -> List[str]:
    out: List[str] = []
    for hid in ids:
        mids = _MOBILE_HIGHLIGHT_MAP.get(hid) or []
        for mid in [mids] if isinstance(mids, str) else mids:
            if mid not in out:
                out.append(mid)
    return out


class TutorialDef:
    def __init__(self, tutorial_id: str, title: str, steps: List[TutorialStep], outro: Dict[str, str]):
        self.tutorial_id = tutorial_id
        self.title = title
        self.steps = steps
        self.outro = outro                # {"title", "text"} a tutorial vinto


# ---------------------------------------------------------------------------
# Lettura delle carte
# ---------------------------------------------------------------------------

# Riquadri delle sezioni sulle immagini delle carte (card_factory/output/full/*.png),
# in percentuale della carta: [x, y, larghezza, altezza]. Misurati sul layout
# di card_factory/assets/card.html (carta 744x1039px) con un piccolo margine
# attorno a ogni sezione: se card.html cambia layout vanno rimisurati.
_RECT_NAME_TYPE = [16.3, 2.9, 67.5, 13.2]      # nastro del nome + riga del tipo
_RECT_COST = [82.5, 2.7, 13.2, 9.4]            # ottagono (Mana) / stella (Maghe)
_RECT_RECRUIT_STATS = [30.9, 46.8, 38.2, 11.4]
_RECT_RECRUIT_INFO = [10.6, 59.5, 78.9, 18.0]  # Specie (+ Scuola) + Evolve in
_RECT_RECRUIT_HORDE = [7.8, 79.0, 84.4, 16.6]
_RECT_HERO_STATS = [30.9, 66.4, 38.2, 12.4]
_RECT_HERO_INFO = [10.6, 79.3, 78.9, 17.2]     # Specie (+ Scuola) + Evolve da
_RECT_EFFECT_TOP = [7.8, 49.7, 84.4, 23.1]     # Base (Magie e Costruzioni)
_RECT_EFFECT_BOTTOM = [7.8, 72.4, 84.4, 23.1]  # Prodigio / Completo


def _sections(*items: tuple) -> List[Dict[str, Any]]:
    return [{"rect": rect, "title": title, "text": text} for rect, title, text in items]


# Carte spiegate al primo tocco in mano (una per tipo: le altre carte dello
# stesso tipo si capiscono da queste). Chiave: base_card_id.
CARD_READS: Dict[str, List[Dict[str, Any]]] = {
    "evelyn": _sections(
        (_RECT_NAME_TYPE, "Nome e tipo",
         "Cornice rossa: Evelyn è un Guerriero. È una Recluta, la forma base: più avanti potrà evolvere in un "
         "Eroe."),
        (_RECT_COST, "Il costo in Mana",
         "L'ottagono è il costo in Mana: giocarla costa 2 Mana. Ricevi Mana a ogni turno, sempre di più."),
        (_RECT_RECRUIT_STATS, "Le Caratteristiche",
         "ATT conta quando attacchi dall'Avanscoperta, DIF quando difendi un Bastione, GIT in entrambi i casi."),
        (_RECT_RECRUIT_INFO, "Specie, Scuola, Evoluzione",
         "Evelyn è una Maga di Scuola Sortilegio: la Scuola conta per le Magie. La Specie serve a formare le "
         "Orde. «Evolve in» indica il suo Eroe."),
        (_RECT_RECRUIT_HORDE, "L'effetto Orda",
         "Con 3 Guerrieri della stessa Specie nella stessa Regione formi un'Orda, e nello Schieramento ne "
         "attivi l'effetto."),
    ),
    "ardolancio": _sections(
        (_RECT_NAME_TYPE, "Una Magia",
         "Cornice blu: Ardolancio è una Magia. Agisce subito e poi va negli scarti; altre Magie hanno effetti "
         "che durano più a lungo, ma sempre per un tempo limitato. Accanto alla parola «Magia» trovi la sua "
         "Scuola, qui Anatema."),
        (_RECT_COST, "Le Maghe richieste",
         "Le Magie non costano Mana: la stella dice quante Maghe, di qualsiasi Scuola, devi avere in campo per "
         "lanciarle, qui una sola. Dopo aver lanciato una Magia, le Maghe non vengono scartate: restano in campo, "
         "pronte per la prossima."),
        (_RECT_EFFECT_TOP, "Effetto Base",
         "Quello che ottieni normalmente: scarti fino a 2 Muri."),
        (_RECT_EFFECT_BOTTOM, "Effetto Prodigio",
         "Se almeno una tua Maga in campo è della stessa Scuola della Magia, ottieni questo al posto del Base. "
         "Se il testo inizia con «&», invece, si aggiunge al Base."),
    ),
    "catapulta": _sections(
        (_RECT_NAME_TYPE, "Una Costruzione",
         "Cornice verde: la Catapulta è una Costruzione. Si gioca nel Villaggio e il suo effetto dura turno "
         "dopo turno."),
        (_RECT_COST, "Il costo in Mana",
         "Come per i Guerrieri, l'ottagono è il costo in Mana per giocarla."),
        (_RECT_EFFECT_TOP, "Effetto Base",
         "Appena giocata è incompleta (torre vuota) e vale solo il Base."),
        (_RECT_EFFECT_BOTTOM, "Effetto Completo",
         "Con un'Azione e il Mana del piccolo ottagono la completi, e vale questo al posto del Base. Se inizia "
         "con «&», invece, si aggiunge al Base."),
    ),
    "the_pyric": _sections(
        (_RECT_NAME_TYPE, "Un Eroe",
         "The Pyric è l'Eroe di Araminta. Non si gioca da solo: si mette sopra la sua Recluta in campo pagando "
         "il suo costo in Mana. Si chiama evolvere."),
        (_RECT_HERO_STATS, "Caratteristiche più alte",
         "ATT 4, GIT 1, DIF 3, contro i 2, 0 e 2 di Araminta."),
        (_RECT_HERO_INFO, "Evolve da",
         "Indica la sua Recluta. L'Eroe non ha un effetto Orda suo: eredita quello della Recluta e le sue carte "
         "assegnate. Se viene scartato, la Recluta resta in campo."),
    ),
}


# ---------------------------------------------------------------------------
# Helper per popolare mano/campo in modo scriptato
# ---------------------------------------------------------------------------

DUMMY_NAME = "Manichino"

# Carte "di scena" con cui riempire il Mazzo comune: le pescate di fine turno
# vengono da qui. Scelte tra le carte che il copione non usa, per non creare
# doppioni con mano, campo e Vite.
_DECK_FILLER_BASE_IDS = [
    "von_reinhold", "orfeus", "giulio_ii",
    "doktor_faustus", "the_briny", "polemarco", "polemarcos", "pio_decimo",
    "kaiser_joseph", "the_nemoral", "eracles",
    "vitalflusso", "magiscudo", "equipotenza", "regicidio", "agilpesca",
    "arrampicarta", "investimento", "bastioncontrario", "divinazione",
    "malcomune", "telecinesi", "cercapersone", "incendifesa", "dazipazzi",
    "plasmattone", "cambiamente", "plasmarmo",
    "fucina", "biblioteca", "ariete", "sorgiva",
    "arena", "fossato", "scrigno", "obelisco", "decumano", "trono",
]

# Un numero verosimile di carte rimanenti da mostrare in testata.
_TUTORIAL_DECK_SIZE = 180

# Carte da usare come Muri nell'ultimo turno: fuori dal Mazzo (suffisso alto),
# così non collidono con le carte di scena.
_WALL_FODDER = ["polemarco_9", "agilpesca_9", "fucina_9"]


def _build_filler_deck(count: int) -> List[str]:
    ids: List[str] = []
    n = 1
    while len(ids) < count:
        for base in _DECK_FILLER_BASE_IDS:
            ids.append(f"{base}_{n}")
            if len(ids) >= count:
                break
        n += 1
    return ids


def _human(state: GameState) -> Player:
    return state.players[0]


def _dummy(state: GameState) -> Player:
    return state.players[1]


def _set_bastion(player: Player, side: str, warrior_ids: Optional[List[str]] = None, wall_ids: Optional[List[str]] = None) -> None:
    bastion = player.field.bastion_left if side == "left" else player.field.bastion_right
    bastion.warriors = [make_warrior_instance(iid) for iid in (warrior_ids or [])]
    bastion.walls = [make_wall_instance(iid) for iid in (wall_ids or [])]


def _give_hand(state: GameState, ids: List[str]) -> None:
    """Dopo la pescata di fine turno lascia in mano solo le carte che servono
    al turno successivo: quelle pescate tornano nel Mazzo."""
    me = _human(state)
    state.deck = [c for c in me.hand if c not in ids] + state.deck
    me.hand = list(ids)


# ---------------------------------------------------------------------------
# Il copione: 4 turni con le Maghe
# ---------------------------------------------------------------------------

# I numeri tornano con le regole vere, senza Mana né Azioni regalati:
#   Turno 1 (turno 4, 2 Mana): Evelyn (2 Mana) → Ardolancio col Base (Evelyn è
#     Sortilegio) scarta i 2 Muri del Bastione sinistro → Battaglia: ATT 1 su
#     un Bastione vuoto, il Manichino perde 1 Vita.
#   Manichino: 3 Muri a sinistra e Reinhold (DIF 3) a difenderli.
#   Turno 2 (turno 5, 3 Mana): Araminta (2 Mana) → Cuordipietra (2 Maghe) in
#     Prodigio grazie ad Araminta (Anatema): Reinhold diventa un tuo Muro →
#     Battaglia: ATT 2 contro 3 Muri, ne cadono 2.
#   Manichino: schiera Joseph (DIF 3) a sinistra e alza 2 Muri (3 in tutto).
#   Turno 3 (turno 6, 3 Mana): Madeleine (2 Mana) → 3 Maghe per Velocemento,
#     in Prodigio grazie a Evelyn (Sortilegio) → Catapulta giocata e completata
#     gratis → Orda delle Maghe → Battaglia: (2−3→0) + (1+2−0) = 3, cadono i
#     3 Muri e nessuna Vita.
#   Manichino: 2 Muri a sinistra; Orfeo (ATT 3) sfonda il tuo Bastione destro
#     (al massimo 2 Muri, sguarnito dopo lo spostamento di Madeleine): perdi
#     1 Vita.
#   Turno 4 (turno 7, 4 Mana): The Pyric (2 Mana) + Muri → Battaglia:
#     (4−3) + (3−0) = 4 contro 2 Muri, il Manichino perde l'ultima Vita.

_START_TURN = 4


def _setup_start(state: GameState) -> None:
    me = _human(state)
    _set_bastion(me, "left", wall_ids=["joseph_1", "joseph_2"])
    _set_bastion(me, "right", wall_ids=["joseph_3"])
    me.hand = ["evelyn_1", "ardolancio_1"]
    me.life_cards = ["decimo_1", "eracle_1", "patrizio_1"]
    me.mana_remaining = state.mana_for_turn(state.turn)
    me.actions_remaining = 2

    dummy = _dummy(state)
    dummy.field.vanguard = [make_warrior_instance("orfeo_1")]
    _set_bastion(dummy, "left", wall_ids=["joseph_4", "joseph_5"])
    _set_bastion(dummy, "right", warrior_ids=["reinhold_1"],
                 wall_ids=["cardo_1", "cardo_2", "cardo_3", "giulio_1", "giulio_2", "joseph_6"])
    dummy.life_cards = ["faust_1", "faust_2"]
    dummy.hand = [state.deck.pop() for _ in range(6)]


def _dummy_turn(state: GameState, walls: int, defender: Optional[str] = None,
                attack_side: Optional[str] = None) -> None:
    """Dopo il "Fine Turno" del giocatore tocca al Manichino: eventualmente
    schiera un difensore a sinistra, alza Muri a sinistra (spostandoci Reinhold
    se è ancora a destra), eventualmente attacca, poi passa il turno. Usa le
    funzioni vere del motore, così la Cronaca lo racconta."""
    from engine.game import do_battle, end_turn
    dummy = _dummy(state)
    if defender:
        dummy.hand.insert(0, defender)
        play_warrior(state, dummy.id, defender, "bastion_left")
    add_wall(state, dummy.id, [{"instance_id": iid, "bastion": "left"} for iid in dummy.hand[:walls]])
    if any(w.instance_id == "reinhold_1" for w in dummy.field.bastion_right.warriors):
        reposition_warrior(state, dummy.id, "reinhold_1", "bastion_left")
    if attack_side:
        state.phase = "battaglia"
        do_battle(state, dummy.id, 0, attack_side)
    end_turn(state)


def _setup_dummy_turn_1(state: GameState) -> None:
    _give_hand(state, ["araminta_1", "cuordipietra_1"])
    _dummy_turn(state, walls=3)


def _setup_dummy_turn_2(state: GameState) -> None:
    _give_hand(state, ["madeleine_1", "velocemento_1", "catapulta_1"])
    _dummy_turn(state, walls=2, defender="joseph_7")


def _setup_dummy_turn_3(state: GameState) -> None:
    _give_hand(state, ["the_pyric_1"] + _WALL_FODDER)
    _dummy_turn(state, walls=2, attack_side="right")


def _phase_is(phase: str) -> Callable[[GameState], bool]:
    return lambda state: state.phase == phase


def _to_phase(phase: str, label: str, feedback: Optional[str] = None) -> Goal:
    return Goal(
        f"to_{phase}", label, "next_phase",
        done=_phase_is(phase),
        hint=f"{label} con il pulsante evidenziato.",
        highlight=["btn-next-phase"],
        feedback=feedback,
    )


def _attack_left(after: str, feedback: Optional[str] = None) -> Goal:
    return Goal(
        "battle", "Attacca il Bastione sinistro", "battle",
        match={"defender_player_index": 1, "defender_bastion_side": "left"},
        hint="Attacca il Bastione sinistro del Manichino.",
        after=[after],
        highlight=["btn-battle", "top-opponents"],
        feedback=feedback,
    )


def _end_turn(after: str) -> Goal:
    return Goal(
        "end_turn", "Termina il turno", "end_turn",
        hint="Premi «Fine Turno».",
        after=[after],
        highlight=["btn-end-turn"],
    )


def _match_walls(params: dict) -> bool:
    walls = params.get("walls", [])
    return 1 <= len(walls) <= 3 and all(w.get("instance_id") != "the_pyric_1" for w in walls)


TUTORIAL_PARTITA = TutorialDef(
    tutorial_id="partita",
    title="La tua prima partita",
    outro={
        "title": "Vittoria!",
        "text": "Hai tolto l'ultima Vita al Manichino: vince l'ultimo giocatore che ne ha ancora almeno una. "
                "In partita puoi sempre toccare una carta, in mano o in campo, per leggerla a schermo intero. "
                "Ora sei pronto: da «Gioca» puoi sfidare amici o Bot.",
    },
    steps=[
        TutorialStep(
            "welcome", "Benvenuto", "Benvenuto su Barbacane!",
            "In un mondo di Umani, Elfi, Nani e Maghe (tutti, per motivi a noi ignoti, di sangue Goblin), ogni "
            "giocatore difende la propria fortezza e prova ad abbattere quelle degli altri.",
            setup=_setup_start,
        ),
        TutorialStep(
            "goal", "Benvenuto", "L'obiettivo",
            "Ogni giocatore ha delle Vite: proteggi le tue e togli quelle degli avversari. Vince l'ultimo che ne "
            "ha ancora almeno una.",
            highlight=["my-life-deck"],
            panel_center=True,
        ),
        TutorialStep(
            "field", "Benvenuto", "Il tuo campo",
            "Esistono 3 tipi di Regione. L'Avanscoperta, da cui i tuoi Guerrieri attaccano. I due Bastioni, dove "
            "Muri e Guerrieri ti difendono. Il Villaggio, dove sorgono le Costruzioni.",
            highlight=["my-field"],
        ),
        TutorialStep(
            "intro", "Si comincia", "La tua prima partita",
            "Il Manichino ha 2 Vite: il tuo obiettivo è togliergliele.",
            highlight=["top-opponents"],
        ),
        # --- Turno 1 ---
        TutorialStep(
            "t1_actions", "Turno 1 di 4", "Le prime carte",
            "Tocca Evelyn per scoprire cosa fa, poi giocala. Costa 2 Mana, quelli che hai, e come ogni carta "
            "giocata un'Azione: ne hai 2 per turno.",
            goals=[
                Goal(
                    "evelyn", "Gioca Evelyn in Avanscoperta", "play_warrior",
                    match={"instance_id": "evelyn_1", "region": "vanguard"},
                    hint="Gioca Evelyn dalla mano in Avanscoperta.",
                    highlight=[">hand-cards", "my-vanguard", "my-stats"],
                    feedback="Evelyn è una Maga, e le Maghe in campo servono per lanciare le Magie. Tocca "
                             "Ardolancio per scoprire cosa fa, poi lancialo con la tua seconda Azione.",
                ),
                Goal(
                    "ardolancio", "Lancia Ardolancio sul Bastione sinistro", "play_spell",
                    match={"instance_id": "ardolancio_1", "target_player_id": "player_2",
                           "target_bastion_side": "left"},
                    hint="Lancia Ardolancio sul Bastione sinistro del Manichino.",
                    after=["evelyn"],
                    wait_hint="Per lanciare una Magia ti serve almeno una Maga in campo: prima gioca Evelyn.",
                    highlight=[">hand-cards", "top-opponents"],
                ),
            ],
        ),
        TutorialStep(
            "t1_battle", "Turno 1 di 4", "All'attacco",
            "2 Muri giù: quel Bastione è scoperto. Passa alla Battaglia.",
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="Attacchi un Bastione con due valori: l'ATT più alto e la GIT più alta dei tuoi "
                             "Guerrieri in Avanscoperta. Entrambi diventano Danno. Ogni Danno distrugge un Muro, e "
                             "se i Muri non bastano il difensore perde una Vita.",
                ),
                _attack_left(
                    "to_battaglia",
                    feedback="Il Manichino perde una Vita: una sola per attacco, anche quando avanzano Danni.",
                ),
                _end_turn("battle"),
            ],
        ),
        TutorialStep(
            "dummy_1", "Turno del Manichino", "Tocca al Manichino",
            "A fine turno si pesca da un mazzo comune fino ad avere 6 carte in mano: qui, per semplicità, ti "
            "lasciamo solo quelle che servono. Il Manichino intanto ha alzato 3 Muri a sinistra e ci ha spostato "
            "Reinhold a difenderli.",
            highlight=[">hand-cards", "top-opponents"],
            setup=_setup_dummy_turn_1,
        ),
        # --- Turno 2 ---
        TutorialStep(
            "t2_actions", "Turno 2 di 4", "Una seconda Maga",
            "Nuovo turno: il Mana è salito a 3, e col passare dei turni crescerà ancora. Le Azioni tornano 2. "
            "Schiera una seconda Maga.",
            goals=[
                Goal(
                    "araminta", "Gioca Araminta in Avanscoperta", "play_warrior",
                    match={"instance_id": "araminta_1", "region": "vanguard"},
                    hint="Gioca Araminta dalla mano in Avanscoperta.",
                    highlight=[">hand-cards", "my-vanguard"],
                    feedback="Reinhold (DIF 3) difende il Bastione sinistro: toglilo di mezzo. Cuordipietra "
                             "richiede 2 Maghe, e Araminta è della sua stessa Scuola, Anatema: uscirà in Prodigio.",
                ),
                Goal(
                    "cuordipietra", "Lancia Cuordipietra su Reinhold", "play_spell",
                    match={"instance_id": "cuordipietra_1", "target_player_id": "player_2",
                           "target_warrior_iid": "reinhold_1"},
                    hint="Lancia Cuordipietra su Reinhold, il difensore del Manichino.",
                    after=["araminta"],
                    wait_hint="Cuordipietra richiede 2 Maghe in campo: prima gioca Araminta.",
                    highlight=[">hand-cards", "top-opponents"],
                ),
            ],
        ),
        TutorialStep(
            "t2_battle", "Turno 2 di 4", "Muri da abbattere",
            "Reinhold ora è un tuo Muro! Col Base sarebbe finito tra i Muri del Manichino: il Prodigio lo porta "
            "nei tuoi. Ti avanza 1 Mana: non sei obbligato a spenderlo, ma a fine turno si perde.",
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="Puoi attaccare solo i Bastioni che confinano con i tuoi: in una partita a due "
                             "li hai tutti a portata. Ora hai due Guerrieri: per ATT e GIT si prende il valore più "
                             "alto tra tutti, anche da carte diverse. ATT 2 (Araminta) e GIT 0: 2 Danni contro 3 "
                             "Muri.",
                ),
                _attack_left(
                    "to_battaglia",
                    feedback="Cadono 2 Muri e ne resta 1, quindi il Manichino non perde Vite: più Muri ha un "
                             "Bastione, più Danni assorbe.",
                ),
                _end_turn("battle"),
            ],
        ),
        TutorialStep(
            "dummy_2", "Turno del Manichino", "Un nuovo difensore",
            "Il Manichino ha schierato Joseph (DIF 3) a difesa del Bastione sinistro e ha alzato altri 2 Muri.",
            highlight=["top-opponents"],
            setup=_setup_dummy_turn_2,
        ),
        # --- Turno 3 ---
        TutorialStep(
            "t3_actions", "Turno 3 di 4", "Tre Maghe",
            "Velocemento chiede 3 Maghe in campo: manca Madeleine. Orfeo, nell'Avanscoperta del Manichino, "
            "minaccia i tuoi Bastioni: mettila a difesa del destro.",
            goals=[
                Goal(
                    "madeleine", "Gioca Madeleine nel Bastione destro", "play_warrior",
                    match={"instance_id": "madeleine_1", "region": "bastion_right"},
                    hint="Gioca Madeleine dalla mano nel tuo Bastione destro.",
                    highlight=[">hand-cards", "my-bastion-right"],
                    feedback="Tre Maghe in campo: ora puoi lanciare Velocemento.",
                ),
                Goal(
                    "velocemento", "Lancia Velocemento", "play_spell",
                    match={"instance_id": "velocemento_1"},
                    hint="Lancia Velocemento dalla mano.",
                    after=["madeleine"],
                    wait_hint="Velocemento richiede 3 Maghe in campo: prima gioca Madeleine.",
                    highlight=[">hand-cards"],
                    feedback="La Catapulta ora è Eterea (bordo bianco): si gioca senza "
                             "Mana, Maghe né Azioni, ma va giocata subito, perché svanisce se fai un'altra Azione "
                             "(anche gratuita), dichiari Battaglia o finisci il turno.",
                ),
                Goal(
                    "play_catapulta", "Gioca la Catapulta", "play_building",
                    match={"instance_id": "catapulta_1"},
                    hint="Gioca la Catapulta Eterea nel Villaggio.",
                    after=["velocemento"],
                    highlight=[">hand-cards", "my-village"],
                    feedback="Di solito completare una Costruzione costa un'Azione e il Mana del piccolo "
                             "ottagono: il Prodigio di Velocemento te la fa completare gratis.",
                ),
                Goal(
                    "complete_catapulta", "Completa la Catapulta", "complete_building",
                    match={"building_instance_id": "catapulta_1"},
                    hint="Completa la Catapulta nel Villaggio.",
                    after=["play_catapulta"],
                    highlight=["banner-btn-complete", "my-village"],
                ),
            ],
        ),
        TutorialStep(
            "t3_deploy", "Turno 3 di 4", "Lo Schieramento",
            "Catapulta completa: in Battaglia i tuoi Guerrieri hanno +2 GIT.",
            goals=[
                _to_phase(
                    "schieramento", "Passa allo Schieramento",
                    feedback="Nello Schieramento sposti i Guerrieri tra Avanscoperta e Bastioni, gratis e "
                             "quante volte vuoi.",
                ),
                Goal(
                    "reposition", "Sposta Madeleine in Avanscoperta", "reposition",
                    match={"warrior_instance_id": "madeleine_1", "destination": "vanguard"},
                    hint="Sposta Madeleine dal Bastione destro all'Avanscoperta.",
                    after=["to_schieramento"],
                    highlight=["my-bastion-right", "my-vanguard"],
                    feedback="Tre Maghe nella stessa Regione: è un'Orda (basta la stessa Specie, non la stessa "
                             "carta). Ne attivi UN effetto, a scelta tra quelli delle tre: scegli tu.",
                ),
                Goal(
                    "horde", "Attiva un effetto Orda", "horde",
                    hint="Premi «Orda» e scegli un effetto.",
                    after=["reposition"],
                    highlight=["btn-horde", "my-vanguard"],
                ),
            ],
        ),
        TutorialStep(
            "t3_battle", "Turno 3 di 4", "Muro contro muro",
            "Orda attiva: resta così nei prossimi turni finché le tre Maghe stanno insieme. Se ne sposti via "
            "una si scioglie, e se scegli un altro effetto il vecchio si spegne. Ora a sinistra Joseph (DIF 3) "
            "difende 3 Muri.",
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="Prima di arrivare ai Muri, il tuo attacco si scontra con i Guerrieri del "
                             "Bastione. La loro DIF più alta si oppone al tuo ATT, la loro GIT più alta alla tua "
                             "GIT: di ciascuno passa come Danno solo quanto li supera.",
                ),
                _attack_left(
                    "to_battaglia",
                    feedback="Il tuo ATT 2 non supera la DIF 3 di Joseph: fermato. La tua GIT 3 (Madeleine, +2 "
                             "della Catapulta) contro la sua 0: passano 3 Danni, e cadono 3 Muri.",
                ),
                _end_turn("battle"),
            ],
        ),
        TutorialStep(
            "dummy_3", "Turno del Manichino", "Il contrattacco",
            "Il Manichino ha attaccato con Orfeo (ATT 3) il tuo Bastione destro: senza più Madeleine a "
            "difenderlo, i Muri non sono bastati e hai perso una Vita. Le tue Vite sono carte coperte che "
            "conosci solo tu: a zero sei eliminato. Intanto lui ha alzato altri 2 Muri a sinistra.",
            highlight=["my-bastion-right", "my-life-deck", "top-opponents"],
            setup=_setup_dummy_turn_3,
        ),
        # --- Turno 4 ---
        TutorialStep(
            "t4_actions", "Turno 4 di 4", "Il colpo finale",
            "Ultimo turno, e hai 4 Mana. Rinforza l'attacco e ripara le difese, nell'ordine che preferisci: qualsiasi carta "
            "può diventare un Muro.",
            goals=[
                Goal(
                    "evolve", "Evolvi Araminta in The Pyric", "evolve",
                    match={"hero_instance_id": "the_pyric_1"},
                    hint="Gioca The Pyric dalla mano sopra Araminta.",
                    highlight=[">hand-cards", "my-vanguard"],
                    feedback="The Pyric ha ATT 4 e ha ereditato l'Orda di Araminta: le tre Maghe restano "
                             "un'Orda.",
                ),
                Goal(
                    "walls", "Aggiungi fino a 3 Muri", "add_wall",
                    match=_match_walls,
                    hint="Aggiungi da 1 a 3 carte della mano come Muri (tieni The Pyric per evolvere).",
                    highlight=["banner-btn-wall", "wall-staging", ">hand-cards", "my-bastion-left", "my-bastion-right"],
                    feedback="Con una sola Azione e senza Mana hai alzato fino a 3 Muri, anche in Bastioni "
                             "diversi. Una carta messa a Muro perde ogni altra funzione.",
                ),
            ],
        ),
        TutorialStep(
            "t4_battle", "Turno 4 di 4", "Sfonda!",
            "Ultimo attacco: Joseph difende 2 Muri.",
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="ATT 4 (The Pyric) contro DIF 3: passa 1. GIT 3 contro 0: passano 3. In tutto 4 "
                             "Danni, contro 2 Muri.",
                ),
                _attack_left("to_battaglia"),
            ],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------------

TUTORIALS: Dict[str, TutorialDef] = {t.tutorial_id: t for t in [TUTORIAL_PARTITA]}
DEFAULT_TUTORIAL_ID = TUTORIAL_PARTITA.tutorial_id


def get_tutorial(tutorial_id: str) -> Optional[TutorialDef]:
    return TUTORIALS.get(tutorial_id)


# ---------------------------------------------------------------------------
# Creazione partita tutorial
# ---------------------------------------------------------------------------

def create_tutorial_game(tutorial_id: str = DEFAULT_TUTORIAL_ID, player_name: str = "Tu",
                         game_id: Optional[str] = None) -> GameState:
    """Crea la partita scriptata del tutorial richiesto."""
    import uuid as _uuid

    tdef = get_tutorial(tutorial_id)
    if tdef is None:
        raise ValueError(f"Tutorial sconosciuto: {tutorial_id}")

    if game_id is None:
        game_id = f"tut-{_uuid.uuid4().hex[:8]}"

    human = Player(id="player_1", name=player_name or "Tu", mana_remaining=0, actions_remaining=2,
                   turns_completed=_START_TURN - 1)
    dummy = Player(id="player_2", name=DUMMY_NAME, mana_remaining=0, actions_remaining=0,
                   turns_completed=_START_TURN - 1)

    state = GameState(
        game_id=game_id,
        turn=_START_TURN,
        current_player_index=0,
        first_player_index=0,
        phase="action",
        players=[human, dummy],
        deck=_build_filler_deck(_TUTORIAL_DECK_SIZE),
        battles_remaining=1,
        turn_timer=0,
        tutorial={"tutorial_id": tutorial_id, "step_index": 0, "completed": False,
                  "goals_done": [], "feedback": None, "snapshots": {}},
        mode="tutorial",
    )
    _apply_step_setup(state, tdef, 0)
    _save_snapshot(state, 0)
    return state


def _apply_step_setup(state: GameState, tdef: TutorialDef, idx: int) -> None:
    step = tdef.steps[idx]
    if step.setup:
        step.setup(state)


# ---------------------------------------------------------------------------
# Obiettivi
# ---------------------------------------------------------------------------

def _match_params(match: MatchType, params: dict) -> bool:
    if callable(match):
        return bool(match(params))
    for k, v in (match or {}).items():
        if params.get(k) != v:
            return False
    return True


def _current_step(state: GameState) -> Optional[TutorialStep]:
    tut = state.tutorial
    if not tut or tut.get("completed"):
        return None
    tdef = get_tutorial(tut["tutorial_id"])
    if tdef is None or tut["step_index"] >= len(tdef.steps):
        return None
    return tdef.steps[tut["step_index"]]


def _pending_goals(state: GameState, step: TutorialStep) -> List[Goal]:
    done = set(state.tutorial.get("goals_done") or [])
    return [g for g in step.goals if g.goal_id not in done]


def _ready(state: GameState, goal: Goal) -> bool:
    done = set(state.tutorial.get("goals_done") or [])
    return all(dep in done for dep in goal.after)


# Mosse sempre permesse (se il motore le consente) senza essere obiettivi: non
# compaiono nella lista e non fanno avanzare il copione. La scelta della
# Costruzione di Velocemento è l'unica possibile (c'è solo la Catapulta).
_FREE_ACTIONS = ("resolve_velocemento",)


def validate_action(state: GameState, action: str, params: dict) -> Optional[str]:
    """Ritorna un messaggio d'errore se l'azione non corrisponde a nessun
    obiettivo del passo corrente, altrimenti None (azione permessa)."""
    if action in ("tutorial_next", "tutorial_prev", "leave_game") + _FREE_ACTIONS:
        return None
    step = _current_step(state)
    if step is None:
        return None
    if not step.goals:
        return "Premi «Avanti» per continuare il tutorial."

    pending = _pending_goals(state, step)
    candidates = [g for g in pending if g.action == action]
    for g in candidates:
        if _match_params(g.match, params):
            if _ready(state, g):
                return None
            return g.wait_hint or "Prima completa gli altri obiettivi."
    if candidates:
        return candidates[0].hint
    ready = [g for g in pending if _ready(state, g)]
    return (ready or pending)[0].hint if pending else None


def advance_after_action(state: GameState, action: str, params: dict) -> Optional[dict]:
    """Da chiamare dopo che un'azione di gioco è stata eseguita con successo:
    spunta l'obiettivo corrispondente e, se era l'ultimo, passa allo step dopo."""
    step = _current_step(state)
    if step is None:
        return None
    tut = state.tutorial
    for g in _pending_goals(state, step):
        if g.action != action or not _match_params(g.match, params) or not _ready(state, g):
            continue
        if g.done and not g.done(state):
            return None
        tut.setdefault("goals_done", []).append(g.goal_id)
        tut["feedback"] = g.feedback
        # Dietro una mossa giocata non si torna: le istantanee non servono più.
        tut["snapshots"] = {}
        if _pending_goals(state, step):
            return {"tutorial_goal": g.goal_id}
        return _advance(state)
    return None


def advance_info_step(state: GameState) -> dict:
    """Gestisce l'azione "tutorial_next" (bottone Avanti) per uno step informativo."""
    tut = state.tutorial
    if not tut:
        raise ActionError("Questa non è una partita tutorial.")
    if tut.get("completed"):
        return {"tutorial_completed": True}
    step = _current_step(state)
    if step is None:
        tut["completed"] = True
        return {"tutorial_completed": True}
    if step.goals:
        raise ActionError("Completa gli obiettivi indicati per continuare.")
    return _advance(state)


def _advance(state: GameState) -> dict:
    tut = state.tutorial
    tdef = get_tutorial(tut["tutorial_id"])
    tut["step_index"] += 1
    tut["goals_done"] = []
    tut["feedback"] = None
    if tut["step_index"] >= len(tdef.steps):
        tut["completed"] = True
        return {"tutorial_completed": True}
    _apply_step_setup(state, tdef, tut["step_index"])
    _save_snapshot(state, tut["step_index"])
    return {"tutorial_step": tut["step_index"]}


# ---------------------------------------------------------------------------
# Tornare indietro
# ---------------------------------------------------------------------------

def _save_snapshot(state: GameState, idx: int) -> None:
    state.tutorial.setdefault("snapshots", {})[str(idx)] = state.model_dump(mode="json", exclude={"tutorial"})


def can_go_back(state: GameState) -> bool:
    tut = state.tutorial
    step = _current_step(state)
    if step is None or tut["step_index"] <= 0 or tut.get("goals_done"):
        return False
    tdef = get_tutorial(tut["tutorial_id"])
    prev = str(tut["step_index"] - 1)
    return not tdef.steps[tut["step_index"] - 1].goals and prev in (tut.get("snapshots") or {})


def go_back(state: GameState) -> dict:
    """Gestisce l'azione "tutorial_prev" (bottone Indietro)."""
    if not can_go_back(state):
        raise ActionError("Non puoi tornare indietro da questo passo del tutorial.")
    tut = state.tutorial
    target = tut["step_index"] - 1
    restored = GameState.model_validate(tut["snapshots"][str(target)])
    for name in GameState.model_fields:
        if name != "tutorial":
            setattr(state, name, getattr(restored, name))
    tut["snapshots"] = {k: v for k, v in tut["snapshots"].items() if int(k) <= target}
    tut["step_index"] = target
    tut["goals_done"] = []
    tut["feedback"] = None
    return {"tutorial_step": target}


# ---------------------------------------------------------------------------
# Vista per il client
# ---------------------------------------------------------------------------

def public_view(state: GameState) -> Optional[dict]:
    """Stato del tutorial da mandare al client: il passo corrente già pronto
    (testi, obiettivi spuntati, zone da evidenziare), le carte da spiegare al
    primo tocco e il messaggio finale."""
    tut = state.tutorial
    if not tut:
        return None
    tdef = get_tutorial(tut["tutorial_id"])
    view = {
        "tutorial_id": tut["tutorial_id"],
        "completed": bool(tut.get("completed")),
        "outro": tdef.outro if tdef else None,
        "card_reads": CARD_READS,
        "can_go_back": can_go_back(state),
        "step": None,
    }
    step = _current_step(state)
    if step is None:
        return view

    done = set(tut.get("goals_done") or [])
    if step.goals:
        highlight: List[str] = []
        for g in step.goals:
            if g.goal_id not in done and _ready(state, g):
                highlight += [h for h in g.highlight if h not in highlight]
    else:
        highlight = list(step.highlight)
    view["step"] = {
        "id": step.step_id,
        "chapter": step.chapter,
        "title": step.title,
        "text": step.text,
        "feedback": tut.get("feedback"),
        "goals": [{"label": g.label, "done": g.goal_id in done} for g in step.goals],
        "highlight": highlight,
        "highlight_mobile": _mobile_ids(highlight),
        "panel_center": step.panel_center,
    }
    return view
