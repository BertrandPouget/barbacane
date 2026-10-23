"""
Modalità Tutorial di Barbacane.

Il Tutorial è una breve partita scriptata di 4 turni contro il "Manichino"
(player_2): il giocatore ("player_1") gioca con le Maghe e deve togliergli la
sua unica Vita, con una sola Battaglia all'ultimo turno. Le regole si scoprono facendo: ogni passo chiede al giocatore uno o più
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
from engine.actions import ActionError, play_warrior

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
        battle_diagram: Optional[Dict[str, Any]] = None,
        show_opponents: bool = False,
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
        # Schema della Battaglia (frontend/tutorial_diagram.js): il client lo
        # mostra quando il giocatore sceglie di attaccare il Bastione `side`, e
        # manda l'attacco solo dopo la conferma
        self.battle_diagram = battle_diagram
        # Mobile: il pannello sta sotto la riga degli avversari invece che sotto la
        # barra in alto, per lasciarli vedere senza evidenziarli
        self.show_opponents = show_opponents


# Il frontend mobile usa ID DOM diversi (campo a triangoli, frontend/mobile/board.js):
# questa mappa deriva automaticamente gli highlight mobile da quelli
# desktop, così ogni passo si scrive una volta sola. Un ID desktop può
# corrispondere a più ID mobile (una lista): lo Spotlight li evidenzia tutti.
_MOBILE_HIGHLIGHT_MAP: Dict[str, Union[str, List[str]]] = {
    ">hand-cards": ">hand",
    "hdr-deck": "tb-deck",
    "my-life-deck": "st-lives",
    "my-field": "board-center-box",
    "my-vanguard": "fld-vanguard",
    "my-bastion-left": "tw-left",
    "my-bastion-right": "tw-right",
    "my-village": "tw-village",
    # Solo Mana e Azioni: nella riga delle risorse ci sono anche Vite ed Effetti.
    "my-stats": ["st-mana", "st-actions"],
    "my-mana": "st-mana",
    "my-actions": "st-actions",
    "action-panel": "dock",
    "btn-next-phase": "dock-next",
    "btn-horde": "dock-horde",
    "btn-battle": "dock-attack",
    "btn-end-turn": "dock-end-turn",
    "phase-bar": "tb-phase",
    "my-active-cards": "st-fx",
    # I nomi degli avversari (solo dove ci sono) e i loro Bastioni esposti
    "top-opponents": [">opp-rail", "opp-bl", "opp-br"],
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

# Riquadri delle sezioni sulle immagini delle carte (card_factory/output/full/*.webp),
# in percentuale della carta: [x, y, larghezza, altezza]. Misurati sul layout
# di card_factory/assets/card.html (carta 744x1039px) con un piccolo margine
# attorno a ogni sezione: se card.html cambia layout vanno rimisurati.
_RECT_NAME_TYPE = [16.3, 2.9, 67.5, 13.2]      # nastro del nome + riga del tipo
_RECT_COST = [82.5, 2.7, 13.2, 9.4]            # gemma (Mana) / stella (Maghe)
_RECT_RECRUIT_STATS = [30.9, 46.8, 38.2, 11.4]
_RECT_RECRUIT_SPECIES = [10.6, 59.5, 78.9, 6.3]  # righe Specie, Scuola, Evolve in (Recluta Maga)
_RECT_RECRUIT_SCHOOL = [10.6, 65.8, 78.9, 6.0]
_RECT_RECRUIT_EVOLVE = [10.6, 71.8, 78.9, 6.0]
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
         "Evelyn è un Guerriero, nello specifico una Recluta. È la forma base e potrà evolvere in un Eroe."),
        (_RECT_COST, "Il costo in Mana",
         "La gemma indica il costo in Mana. Giocare Evelyn costa 2 Mana."),
        (_RECT_RECRUIT_STATS, "Le Caratteristiche",
         "L'Attacco (ATT) conta quando attacchi dall'Avanscoperta, la Difesa (DIF) quando difendi un Bastione, "
         "la Gittata (GIT) in entrambi i casi."),
        (_RECT_RECRUIT_SPECIES, "La Specie",
         "Evelyn è una Maga, una delle quattro Specie con Umani, Elfi e Nani. Guerrieri della stessa Specie "
         "possono formare un'Orda."),
        (_RECT_RECRUIT_SCHOOL, "La Scuola",
         "La Scuola ce l'hanno solo le Maghe e le Magie. Lanciando una Magia con in campo una Maga della stessa "
         "Scuola si attiva il Prodigio, una versione potenziata dell'effetto."),
        (_RECT_RECRUIT_EVOLVE, "L'Evoluzione",
         "Ogni Recluta può evolvere in un Eroe, un Guerriero dalle Caratteristiche più potenti. Quello di Evelyn "
         "è The Briny."),
        (_RECT_RECRUIT_HORDE, "L'effetto Orda",
         "Con 3 Guerrieri della stessa Specie nella stessa Regione formi un'Orda, e nello Schieramento ne "
         "attivi l'effetto."),
    ),
    "ardolancio": _sections(
        (_RECT_NAME_TYPE, "Una Magia",
         "Una Magia produce il suo effetto e va negli scarti. Alcune durano di più, ma sempre per un tempo "
         "limitato. Accanto a «Magia» c'è la Scuola, in questo caso Anatema."),
        (_RECT_COST, "Le Maghe richieste",
         "Le Magie non costano Mana. La stella indica quante Maghe, di qualsiasi Scuola, devi avere in campo, "
         "in questo caso una. Lanciata la Magia, le Maghe restano in campo."),
        (_RECT_EFFECT_TOP, "Effetto Base",
         "La stella vuota segna l'effetto Base, quello che ottieni senza Prodigio."),
        (_RECT_EFFECT_BOTTOM, "Effetto Prodigio",
         "Se una tua Maga in campo è della stessa Scuola della Magia, scatta il Prodigio e ottieni questo "
         "effetto invece del Base. Se il testo inizia con «&», ottieni sia il Base che questo."),
    ),
    "catapulta": _sections(
        (_RECT_NAME_TYPE, "Una Costruzione",
         "Una Costruzione si gioca nel Villaggio e il suo effetto resta nel tempo."),
        (_RECT_COST, "Il costo in Mana",
         "Come per i Guerrieri, la gemma è il costo in Mana."),
        (_RECT_EFFECT_TOP, "Effetto Base",
         "La torre vuota segna l'effetto Base, che vale finché la Costruzione non è completa."),
        (_RECT_EFFECT_BOTTOM, "Effetto Completo",
         "Con un'Azione e il Mana della piccola gemma la completi, e da allora vale questo effetto invece del "
         "Base. Se il testo inizia con «&», valgono entrambi."),
    ),
    "the_pyric": _sections(
        (_RECT_NAME_TYPE, "Un Eroe",
         "The Pyric è l'Eroe di Araminta. Non si gioca da solo, ma sopra la sua Recluta in campo, pagandone il "
         "costo in Mana. Questo si chiama evolvere."),
        (_RECT_HERO_STATS, "Caratteristiche più alte",
         "ATT 4, GIT 1, DIF 3, contro i 2, 0 e 2 di Araminta."),
        (_RECT_HERO_INFO, "Evolve da",
         "Indica la sua Recluta, da cui l'Eroe eredita effetto Orda e carte assegnate. Se l'Eroe viene "
         "scartato, la Recluta resta in campo."),
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

# Ogni meccanica si prova una volta, e la Battaglia è una sola, all'ultimo
# turno, dove si spiega per intera. I numeri tornano con le regole vere, senza
# Mana né Azioni regalati:
#   Turno 1 (turno 4, 2 Mana): Evelyn (2 Mana) → Ardolancio col Base (Evelyn è
#     Sortilegio) scarta 2 dei 3 Muri del Bastione sinistro. Niente Battaglia.
#   Manichino: passa.
#   Turno 2 (turno 5, 3 Mana): Araminta (2 Mana) → Cuordipietra (2 Maghe) in
#     Prodigio grazie ad Araminta (Anatema): Reinhold, il difensore più forte
#     del Bastione sinistro, diventa un tuo Muro (resta Patrizio). Niente
#     Battaglia.
#   Manichino: schiera Joseph (DIF 3) a difesa del Bastione sinistro.
#   Turno 3 (turno 6, 3 Mana): Madeleine (2 Mana) → 3 Maghe per Velocemento,
#     in Prodigio grazie a Evelyn (Sortilegio) → Catapulta giocata e completata
#     gratis → Schieramento e Orda delle Maghe. Niente Battaglia.
#   Manichino: Orfeo (ATT 3) sfonda il tuo Bastione destro (al massimo 2 Muri,
#     sguarnito dopo lo spostamento di Madeleine): perdi 1 Vita.
#   Turno 4 (turno 7, 4 Mana): The Pyric (2 Mana) + Muri → Battaglia:
#     ATT 4 contro la DIF 3 di Joseph passa 1, GIT 1+2 contro la GIT 1 di
#     Patrizio passa 2: 3 Danni contro 1 Muro, il Manichino perde la sua Vita
#     (una sola, anche se avanzano 2 Danni).

_START_TURN = 4


def _setup_start(state: GameState) -> None:
    me = _human(state)
    me.hand = ["evelyn_1", "ardolancio_1", "catapulta_1"]
    me.life_cards = ["decimo_1", "eracle_1", "faust_2"]
    me.mana_remaining = state.mana_for_turn(state.turn)
    me.actions_remaining = 2

    dummy = _dummy(state)
    dummy.field.vanguard = [make_warrior_instance("orfeo_1")]
    _set_bastion(dummy, "left", warrior_ids=["reinhold_1", "patrizio_1"],
                 wall_ids=["joseph_4", "joseph_5", "giulio_1"])
    _set_bastion(dummy, "right",
                 wall_ids=["cardo_1", "cardo_2", "cardo_3", "giulio_3", "giulio_4", "joseph_6"])
    dummy.life_cards = ["faust_1"]
    dummy.hand = [state.deck.pop() for _ in range(6)]


def _dummy_turn(state: GameState, defender: Optional[str] = None, attack_side: Optional[str] = None) -> None:
    """Dopo il "Fine Turno" del giocatore tocca al Manichino: eventualmente
    schiera un difensore nel Bastione sinistro, eventualmente attacca, poi
    passa il turno. Usa le funzioni vere del motore, così la Cronaca lo racconta."""
    from engine.game import do_battle, end_turn
    dummy = _dummy(state)
    if defender:
        dummy.hand.insert(0, defender)
        play_warrior(state, dummy.id, defender, "bastion_left")
    if attack_side:
        state.phase = "battaglia"
        do_battle(state, dummy.id, 0, attack_side)
    end_turn(state)


def _setup_dummy_turn_1(state: GameState) -> None:
    _give_hand(state, ["araminta_1", "cuordipietra_1", "catapulta_1"])
    _dummy_turn(state)


def _setup_dummy_turn_2(state: GameState) -> None:
    _give_hand(state, ["madeleine_1", "velocemento_1", "catapulta_1"])
    _dummy_turn(state, defender="joseph_7")


def _setup_dummy_turn_3(state: GameState) -> None:
    _give_hand(state, ["the_pyric_1"] + _WALL_FODDER)
    _dummy_turn(state, attack_side="right")


def _phase_is(phase: str) -> Callable[[GameState], bool]:
    return lambda state: state.phase == phase


def _to_phase(phase: str, label: str, feedback: Optional[str] = None, after: Optional[str] = None) -> Goal:
    return Goal(
        f"to_{phase}", label, "next_phase",
        done=_phase_is(phase),
        hint=f"{label} con il pulsante evidenziato.",
        after=[after] if after else [],
        highlight=["btn-next-phase"],
        feedback=feedback,
    )


def _end_turn(after: str) -> Goal:
    return Goal(
        "end_turn", "Termina il turno", "end_turn",
        hint="Premi «Fine Turno».",
        after=[after],
        wait_hint="«Fine Turno» si preme in Battaglia, l'ultima fase, quindi prima passa alla Battaglia.",
        highlight=["btn-end-turn"],
    )


def _match_walls(params: dict) -> bool:
    walls = params.get("walls", [])
    return 1 <= len(walls) <= 3 and all(w.get("instance_id") != "the_pyric_1" for w in walls)


def _walls_raised(state: GameState) -> bool:
    """I Muri si posano uno alla volta: l'obiettivo è fatto quando sono su tutti e 3."""
    return not any(iid in _human(state).hand for iid in _WALL_FODDER)


TUTORIAL_PARTITA = TutorialDef(
    tutorial_id="partita",
    title="La tua prima partita",
    outro={
        "title": "Vittoria!",
        "text": "Hai tolto l'ultima Vita al Manichino. Ora sei pronto. Da «Gioca» puoi sfidare amici o Bot.",
    },
    steps=[
        TutorialStep(
            "welcome", "Benvenuto", "Benvenuto su Barbacane!",
            "In un mondo di Umani, Elfi, Nani e Maghe, tutti di sangue Goblin, ogni "
            "giocatore difende la propria fortezza e prova ad abbattere quelle degli altri.",
            setup=_setup_start,
        ),
        TutorialStep(
            "goal", "Benvenuto", "Le Vite",
            "Le Vite sono carte coperte, tenute da parte. Proteggi le tue e togli quelle degli avversari. Vince "
            "l'ultimo a cui ne resta almeno una. In questo tutorial affronti un Manichino che ne ha una sola.",
            highlight=["my-life-deck"],
        ),
        TutorialStep(
            "field", "Benvenuto", "Il tuo campo",
            "Il tuo campo ha 4 Regioni, ognuna con il suo scopo. Dall'Avanscoperta attacchi, i due Bastioni sono "
            "difesi da Muri e Guerrieri e il Villaggio ospita le Costruzioni.",
            highlight=["my-field"],
        ),
        # --- Turno 1 ---
        TutorialStep(
            "cards", "Turno 1 di 4", "Le carte",
            "Le carte sono di tre tipi e la cornice li distingue. È rossa per i Guerrieri, blu per le Magie e "
            "verde per le Costruzioni. Le vedrai tutte in azione.",
            highlight=[">hand-cards"],
        ),
        TutorialStep(
            "actions", "Turno 1 di 4", "Le Azioni",
            "A ogni turno hai 2 Azioni. Un'Azione può essere giocare una carta, completare una Costruzione o "
            "aggiungere fino a 3 Muri. Le proverai tutte durante il tutorial.",
            highlight=["my-actions"],
        ),
        TutorialStep(
            "mana", "Turno 1 di 4", "Il Mana",
            "Il Mana serve a giocare Guerrieri e Costruzioni, e a completare le Costruzioni. Ne ricevi a ogni "
            "turno, sempre di più. Ora ne hai 2.",
            highlight=["my-mana"],
        ),
        TutorialStep(
            "t1_actions", "Turno 1 di 4", "Le prime carte",
            "Tocca Evelyn per scoprire cosa fa, poi trascinala in Avanscoperta. Userai 2 Mana e un'Azione.",
            goals=[
                Goal(
                    "evelyn", "Gioca Evelyn in Avanscoperta", "play_warrior",
                    match={"instance_id": "evelyn_1", "region": "vanguard"},
                    hint="Trascina Evelyn dalla mano in Avanscoperta.",
                    highlight=[">hand-cards", "my-vanguard", "my-stats"],
                    feedback="Tocca Ardolancio per scoprire cosa fa, poi trascinalo verso il campo e scegli il "
                             "Bastione sinistro del Manichino. Indebolirlo ti servirà per l'attacco finale.",
                ),
                Goal(
                    "ardolancio", "Lancia Ardolancio sul Bastione sinistro", "play_spell",
                    match={"instance_id": "ardolancio_1", "target_player_id": "player_2",
                           "target_bastion_side": "left"},
                    hint="Trascina Ardolancio verso il campo e scegli il Bastione sinistro del Manichino.",
                    after=["evelyn"],
                    wait_hint="Per lanciare una Magia ti serve almeno una Maga in campo, quindi prima gioca Evelyn.",
                    highlight=[">hand-cards", "top-opponents"],
                ),
            ],
        ),
        TutorialStep(
            "t1_end", "Turno 1 di 4", "Fine del turno",
            "2 Muri giù. Dopo le Azioni vengono lo Schieramento e la Battaglia, quindi avanza fino alla "
            "Battaglia.",
            show_opponents=True,  # si vede che al Manichino sono rimasti meno Muri
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="Attaccare non è obbligatorio e qui lo farai solo all'ultimo turno. Ora termina il "
                             "turno.",
                ),
                _end_turn("to_battaglia"),
            ],
        ),
        TutorialStep(
            "dummy_1", "Turno del Manichino", "Tocca al Manichino",
            "A fine turno si pesca da un mazzo comune fino a 6 carte in mano (qui ti lasciamo solo quelle utili). "
            "Il Manichino ha passato il turno.",
            highlight=[">hand-cards"],
            setup=_setup_dummy_turn_1,
        ),
        # --- Turno 2 ---
        TutorialStep(
            "t2_actions", "Turno 2 di 4", "Una seconda Maga",
            "Il Mana è salito a 3 e le Azioni tornano 2. Schiera una seconda Maga.",
            goals=[
                Goal(
                    "araminta", "Gioca Araminta in Avanscoperta", "play_warrior",
                    match={"instance_id": "araminta_1", "region": "vanguard"},
                    hint="Trascina Araminta dalla mano in Avanscoperta.",
                    highlight=[">hand-cards", "my-vanguard"],
                    feedback="Reinhold è il difensore avversario più forte, quindi toglilo di mezzo. "
                             "Cuordipietra richiede 2 Maghe e Araminta ne condivide la Scuola, Anatema, quindi "
                             "uscirà in Prodigio.",
                ),
                Goal(
                    "cuordipietra", "Lancia Cuordipietra su Reinhold", "play_spell",
                    match={"instance_id": "cuordipietra_1", "target_player_id": "player_2",
                           "target_warrior_iid": "reinhold_1"},
                    hint="Trascina Cuordipietra verso il campo e scegli Reinhold, il difensore del Manichino.",
                    after=["araminta"],
                    wait_hint="Cuordipietra richiede 2 Maghe in campo, quindi prima gioca Araminta.",
                    highlight=[">hand-cards", "top-opponents"],
                ),
            ],
        ),
        TutorialStep(
            "t2_end", "Turno 2 di 4", "Fine del turno",
            "Reinhold ora è un tuo Muro. Col Base sarebbe finito tra quelli del Manichino. Il Mana che avanza si "
            "perde a fine turno.",
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="Anche stavolta niente attacco. Termina il turno.",
                ),
                _end_turn("to_battaglia"),
            ],
        ),
        TutorialStep(
            "dummy_2", "Turno del Manichino", "Un nuovo difensore",
            "Il Manichino ha schierato Joseph (DIF 3) nel Bastione sinistro, che ora è difeso anche da Patrizio.",
            highlight=["top-opponents"],
            setup=_setup_dummy_turn_2,
        ),
        # --- Turno 3 ---
        TutorialStep(
            "t3_actions", "Turno 3 di 4", "Tre Maghe",
            "Velocemento chiede 3 Maghe. Orfeo, nell'Avanscoperta del Manichino, minaccia i tuoi Bastioni: "
            "schiera Madeleine a difesa del destro.",
            goals=[
                Goal(
                    "madeleine", "Schiera Madeleine nel Bastione destro", "play_warrior",
                    match={"instance_id": "madeleine_1", "region": "bastion_right"},
                    hint="Trascina Madeleine dalla mano nel tuo Bastione destro.",
                    highlight=[">hand-cards", "my-bastion-right"],
                    feedback="Tre Maghe in campo. Ora puoi lanciare Velocemento.",
                ),
                Goal(
                    "velocemento", "Lancia Velocemento", "play_spell",
                    match={"instance_id": "velocemento_1"},
                    hint="Trascina Velocemento dalla mano verso il campo.",
                    after=["madeleine"],
                    wait_hint="Velocemento richiede 3 Maghe in campo, quindi prima schiera Madeleine.",
                    highlight=[">hand-cards"],
                    feedback="La Catapulta ora è Eterea (bordo bianco). Si gioca gratis e senza Azioni, ma "
                             "va giocata subito, altrimenti l'effetto svanisce. Tocca la Catapulta per scoprire "
                             "cosa fa, poi trascinala nel Villaggio.",
                ),
                Goal(
                    "play_catapulta", "Gioca la Catapulta", "play_building",
                    match={"instance_id": "catapulta_1"},
                    hint="Trascina la Catapulta Eterea nel Villaggio.",
                    after=["velocemento"],
                    highlight=[">hand-cards", "my-village"],
                    feedback="Completare costa di solito un'Azione e il Mana della piccola gemma, ma il Prodigio "
                             "di Velocemento lo rende gratis. Tocca la Catapulta nel Villaggio e premi «Completa».",
                ),
                Goal(
                    "complete_catapulta", "Completa la Catapulta", "complete_building",
                    match={"building_instance_id": "catapulta_1"},
                    hint="Tocca la Catapulta nel Villaggio e premi «Completa».",
                    after=["play_catapulta"],
                    highlight=["my-village"],
                ),
            ],
        ),
        TutorialStep(
            "t3_deploy", "Turno 3 di 4", "Lo Schieramento",
            "Catapulta completa. In Battaglia i tuoi Guerrieri hanno +2 GIT.",
            goals=[
                _to_phase(
                    "schieramento", "Passa allo Schieramento",
                    feedback="Nello Schieramento sposti i Guerrieri tra Avanscoperta e Bastioni, gratis e quante "
                             "volte vuoi.",
                ),
                Goal(
                    "reposition", "Sposta Madeleine in Avanscoperta", "reposition",
                    match={"warrior_instance_id": "madeleine_1", "destination": "vanguard"},
                    hint="Sposta Madeleine dal Bastione destro all'Avanscoperta.",
                    after=["to_schieramento"],
                    highlight=["my-bastion-right", "my-vanguard"],
                    feedback="Tre Guerrieri della stessa Specie nella stessa Regione, anche se carte diverse, "
                             "formano un'Orda, come le tue tre Maghe. Ne attivi un effetto, a scelta tra quelli "
                             "dei tre.",
                ),
                Goal(
                    "horde", "Attiva un effetto Orda", "horde",
                    hint="Premi «Orda» e scegli un effetto.",
                    after=["reposition"],
                    highlight=["btn-horde", "my-vanguard"],
                    feedback="L'Orda resta attiva finché le tre Maghe stanno insieme, e scegliendo un altro "
                             "effetto il vecchio si spegne. Passa alla Battaglia e termina il turno, l'attacco è "
                             "per il prossimo.",
                ),
                _to_phase("battaglia", "Passa alla Battaglia", after="horde",
                          feedback="Termina il turno, al prossimo attacchi."),
                _end_turn("to_battaglia"),
            ],
        ),
        TutorialStep(
            "dummy_3", "Turno del Manichino", "Il contrattacco",
            "Orfeo (ATT 3) ha attaccato il tuo Bastione destro. Senza Madeleine e con pochi Muri, hai perso una "
            "Vita.",
            highlight=["my-bastion-right", "my-life-deck", "top-opponents"],
            setup=_setup_dummy_turn_3,
        ),
        # --- Turno 4 ---
        TutorialStep(
            "t4_actions", "Turno 4 di 4", "Il colpo finale",
            "Ogni Muro assorbe un Danno e qualsiasi carta può diventarlo. Tocca rapidamente due volte una carta "
            "per girarla, poi trascinala in un tuo Bastione. Usa Polemarco, Agilpesca e Fucina, e tieni The Pyric "
            "per l'attacco.",
            goals=[
                Goal(
                    "walls", "Alza 3 Muri", "add_wall",
                    match=_match_walls,
                    hint="Tocca rapidamente due volte Polemarco, Agilpesca e Fucina per girarle, poi trascinale "
                         "nei Bastioni. The Pyric ti serve per evolvere.",
                    done=_walls_raised,
                    highlight=[">hand-cards", "my-bastion-left", "my-bastion-right"],
                    feedback="Fino a 3 Muri alzati di seguito valgono una sola Azione, anche in Bastioni "
                             "diversi, e non costano Mana. Una carta messa a Muro non serve ad altro. Ora tocca "
                             "The Pyric per scoprire cosa fa, poi evolvi Araminta.",
                ),
                Goal(
                    "evolve", "Evolvi Araminta in The Pyric", "evolve",
                    match={"hero_instance_id": "the_pyric_1"},
                    hint="Trascina The Pyric dalla mano sopra Araminta.",
                    after=["walls"],
                    wait_hint="Prima alza i Muri, poi pensa all'attacco.",
                    highlight=[">hand-cards", "my-vanguard"],
                ),
            ],
        ),
        TutorialStep(
            "t4_battle", "Turno 4 di 4", "La Battaglia",
            "The Pyric ha ATT 4 e ha ereditato l'Orda di Araminta. Puoi attaccare solo i Bastioni che confinano "
            "con i tuoi, e in due li hai tutti a portata.",
            goals=[
                _to_phase(
                    "battaglia", "Passa alla Battaglia",
                    feedback="Attacca il Bastione sinistro del Manichino. Prima di confermare vedrai come si "
                             "calcola la Battaglia.",
                ),
                Goal(
                    "battle", "Attacca il Bastione sinistro", "battle",
                    match={"defender_player_index": 1, "defender_bastion_side": "left"},
                    hint="Attacca il Bastione sinistro del Manichino.",
                    after=["to_battaglia"],
                    highlight=["btn-battle", "top-opponents"],
                ),
            ],
            battle_diagram={
                "title": "Come si calcola la Battaglia",
                "side": "left",
                "sides": [
                    {"title": "Il tuo attacco",
                     "sub": "ATT e GIT più alti della tua Avanscoperta",
                     "stats": [["ATT", 4, "The Pyric"], ["GIT", 3, "The Pyric, +2 della Catapulta"]]},
                    {"title": "La sua difesa",
                     "sub": "DIF e GIT più alte del suo Bastione bersaglio",
                     "stats": [["DIF", 3, "Joseph"], ["GIT", 1, "Patrizio"]]},
                ],
                "clashes": [["ATT", 4, "DIF", 3, 1], ["GIT", 3, "GIT", 1, 2]],
                "damage": 3,
                "split_rule": "Ogni Danno distrugge un Muro. Se ci sono Danni rimanenti, il difensore perde una "
                              "Vita.",
                "split": [["1 Danno", "1 Muro distrutto"], ["2 Danni rimanenti", "1 Vita tolta"]],
            },
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
        return "Premi › per continuare il tutorial."

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
        # Avanzamento (1-based) mostrato in cima al pannello, es. «5 di 17»
        "number": tut["step_index"] + 1,
        "total": len(tdef.steps),
        "chapter": step.chapter,
        "title": step.title,
        "text": step.text,
        "feedback": tut.get("feedback"),
        "goals": [{"label": g.label, "done": g.goal_id in done} for g in step.goals],
        "highlight": highlight,
        "highlight_mobile": _mobile_ids(highlight),
        "panel_center": step.panel_center,
        "battle_diagram": step.battle_diagram,
        "show_opponents": step.show_opponents,
    }
    return view
