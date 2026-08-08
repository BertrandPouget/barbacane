"""
Modalità Tutorial di Barbacane.

Ogni Tutorial è una partita in solitaria completamente scriptata: il giocatore
umano ("player_1") ha sempre la stessa mano/campo prestabiliti, ed è affiancato
da un "Manichino" (player_2) che non gioca mai — serve solo da bersaglio per la
Battaglia. Non c'è pescaggio dal mazzo comune: ogni passo (step) del tutorial
prepara direttamente mano/campo/risorse tramite `setup`.

Uno step è di due tipi:
- "info"   (action=None): puramente esplicativo, si avanza con l'azione
            "tutorial_next" (bottone "Avanti" in UI).
- "action" (action={"action": ..., "match": ...}): richiede che il giocatore
            compia una specifica azione di gioco reale (stessa validazione del
            motore) per avanzare allo step successivo.

`validate_action` viene chiamata da server/routes.py PRIMA di eseguire
l'azione, per rifiutare mosse fuori copione. `advance_after_action` viene
chiamata DOPO che l'azione è stata eseguita con successo, per far avanzare lo
step (e applicarne il setup).
"""

from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Union

from engine.models import GameState, Player
from engine.deck import make_warrior_instance, make_building_instance, make_wall_instance
from engine.actions import ActionError

MatchType = Union[Dict[str, Any], Callable[[dict], bool]]


# ---------------------------------------------------------------------------
# Definizione degli step/tutorial
# ---------------------------------------------------------------------------

class TutorialStep:
    def __init__(
        self,
        step_id: str,
        title: str,
        text: str,
        highlight: Optional[List[str]] = None,
        action: Optional[str] = None,
        match: Optional[MatchType] = None,
        hint: Optional[str] = None,
        setup: Optional[Callable[[GameState], None]] = None,
    ):
        self.step_id = step_id
        self.title = title
        self.text = text
        self.highlight = highlight or []
        self.action = action              # None per gli step "info"
        self.match = match or {}
        self.hint = hint or "Non è l'azione richiesta da questo passo del tutorial."
        self.setup = setup

    def to_dict(self) -> dict:
        mobile_ids: List[str] = []
        for hid in self.highlight:
            mid = _MOBILE_HIGHLIGHT_MAP.get(hid)
            if mid and mid not in mobile_ids:
                mobile_ids.append(mid)
        return {
            "id": self.step_id,
            "title": self.title,
            "text": self.text,
            "highlight": self.highlight,
            "highlight_mobile": mobile_ids,
            "requires_action": self.action,
        }


# Il frontend mobile usa ID DOM diversi (layout a tasselli invece che regioni
# fisse): questa mappa deriva automaticamente gli highlight mobile da quelli
# desktop, così ogni TutorialStep si scrive una volta sola.
_MOBILE_HIGHLIGHT_MAP: Dict[str, str] = {
    "hand-area": "hand-wrap",
    "hdr-deck": "tb-deck",
    "my-life-deck": "st-lives",
    "my-vanguard": "fld-vanguard",
    "my-bastion-left": "tw-left",
    "my-bastion-right": "tw-right",
    "my-village": "tw-village",
    "my-stats": "statusbar",
    "action-panel": "dock",
    "banner-btn-wall": "dock",
    "banner-btn-play": "dock",
    "banner-btn-complete": "dock",
    "btn-next-phase": "dock",
    "btn-horde": "dock",
    "btn-battle": "dock",
    "top-opponents": "opp-rail",
}


class TutorialDef:
    def __init__(self, tutorial_id: str, title: str, description: str, order: int, steps: List[TutorialStep]):
        self.tutorial_id = tutorial_id
        self.title = title
        self.description = description
        self.order = order
        self.steps = steps

    def meta(self) -> dict:
        return {
            "id": self.tutorial_id,
            "title": self.title,
            "description": self.description,
            "order": self.order,
            "step_count": len(self.steps),
        }

    def to_dict(self) -> dict:
        d = self.meta()
        d["steps"] = [s.to_dict() for s in self.steps]
        return d


# ---------------------------------------------------------------------------
# Helper per popolare mano/campo in modo scriptato
# ---------------------------------------------------------------------------

DUMMY_NAME = "Manichino"

# Vite del giocatore umano nei tutorial: 3 carte di specie diverse, così da non
# dare l'impressione (falsa) che il mazzo sia fatto solo di copie ripetute
# della stessa carta (es. 3 Giulio). Il contenuto non ha alcun effetto di
# gioco: nei tutorial le Vite non vengono mai pescate né rivelate.
_HUMAN_LIFE_CARDS = ["decimo_1", "madeleine_1", "eracle_1"]

# Carte "di scena" con cui riempire il Mazzo comune nei tutorial: servono solo
# a mostrare un numero di carte rimanenti verosimile nell'intestazione (il
# Mazzo non viene mai davvero pescato in un tutorial scriptato). Scelte tra
# le carte NON usate da nessuno script di tutorial, per non creare doppioni
# con mano/campo/Vite.
_DECK_FILLER_BASE_IDS = [
    "san_patrizio", "von_reinhold", "the_pyric", "orfeus", "giulio_ii",
    "doktor_faustus", "the_briny", "polemarco", "polemarcos", "pio_decimo",
    "kaiser_joseph", "the_nemoral", "eracles",
    "vitalflusso", "magiscudo", "equipotenza", "regicidio", "agilpesca",
    "guerremoto", "arrampicarta", "investimento", "cuordipietra",
    "bastioncontrario", "divinazione", "malcomune", "telecinesi",
    "cercapersone", "incendifesa", "dazipazzi", "plasmattone", "cambiamente",
    "velocemento", "plasmarmo",
    "fucina", "biblioteca", "ariete", "catapulta", "saracinesca", "sorgiva",
    "arena", "fossato", "scrigno", "obelisco", "decumano", "trono",
]

# 200 carte nel Mazzo comune - 6 in mano e 3 Vite per ciascuno dei 2
# giocatori = un numero verosimile di carte rimanenti da mostrare in testata.
_TUTORIAL_DECK_SIZE = 182


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


def _set_hand(player: Player, ids: List[str]) -> None:
    player.hand = list(ids)


def _set_vanguard(player: Player, ids: List[str]) -> None:
    player.field.vanguard = [make_warrior_instance(iid) for iid in ids]


def _set_bastion(player: Player, side: str, warrior_ids: Optional[List[str]] = None, wall_ids: Optional[List[str]] = None) -> None:
    bastion = player.field.bastion_left if side == "left" else player.field.bastion_right
    bastion.warriors = [make_warrior_instance(iid) for iid in (warrior_ids or [])]
    bastion.walls = [make_wall_instance(iid) for iid in (wall_ids or [])]


def _set_village(player: Player, building_ids: List[str]) -> None:
    player.field.village.buildings = [make_building_instance(iid) for iid in building_ids]


def _set_resources(player: Player, mana: Optional[int] = None, actions: Optional[int] = None) -> None:
    if mana is not None:
        player.mana_remaining = mana
    if actions is not None:
        player.actions_remaining = actions


def _reset_field(player: Player) -> None:
    _set_vanguard(player, [])
    _set_bastion(player, "left")
    _set_bastion(player, "right")
    _set_village(player, [])


# ---------------------------------------------------------------------------
# Tutorial 1 — Le Zone del Campo
# ---------------------------------------------------------------------------

def _t1_setup_board(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    _set_vanguard(me, ["patrizio_1"])
    _set_bastion(me, "left", warrior_ids=["patrizio_2"], wall_ids=["reinhold_1"])
    _set_bastion(me, "right", wall_ids=["joseph_1", "joseph_2"])
    _set_village(me, ["estrattore_1"])
    _set_hand(me, ["orfeo_1", "ardolancio_1", "granaio_1"])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=3, actions=2)
    state.phase = "action"


TUTORIAL_ZONE_CAMPO = TutorialDef(
    tutorial_id="zone_campo",
    title="Le Zone del Campo",
    description="Un tour guidato del tuo campo di gioco: Mano, Mazzo, Vite, Avanscoperta, Bastioni e Villaggio.",
    order=1,
    steps=[
        TutorialStep(
            "intro", "Benvenuto a Barbacane!",
            "Ti mostriamo le zone del tuo campo di gioco, una alla volta. Premi «Avanti» per iniziare.",
            highlight=[], setup=_t1_setup_board,
        ),
        TutorialStep(
            "hand", "La Mano",
            "Qui in basso trovi la tua Mano: le carte che puoi giocare durante il tuo turno — Guerrieri, Magie e Costruzioni.",
            highlight=["hand-area"],
        ),
        TutorialStep(
            "deck", "Mazzo e Scarti",
            "In alto vedi quante carte restano nel Mazzo comune a tutti i giocatori. Quando la mano si svuota, ne peschi di nuove a fine turno.",
            highlight=["hdr-deck"],
        ),
        TutorialStep(
            "lives", "Le Vite",
            "Le tue Vite sono carte pescate a faccia in giù: solo tu puoi vedere quali sono, per gli avversari restano nascoste. Quando un avversario sfonda le tue difese ne perdi una: a zero Vite sei eliminato.",
            highlight=["my-life-deck"],
        ),
        TutorialStep(
            "vanguard", "L'Avanscoperta",
            "Qui schieri i Guerrieri che attaccheranno gli avversari, usando il massimo Attacco e la massima Gittata tra quelli presenti.",
            highlight=["my-vanguard"],
        ),
        TutorialStep(
            "bastions", "I Bastioni",
            "Bastione Sinistro e Bastione Destro: qui i tuoi Guerrieri si difendono con Difesa e Gittata, protetti dai Muri (carte piazzate a faccia in giù).",
            highlight=["my-bastion-left", "my-bastion-right"],
        ),
        TutorialStep(
            "village", "Il Villaggio",
            "Nel Villaggio piazzi le tue Costruzioni: danno subito un effetto Base, e uno più forte una volta completate spendendo Mana ed un'Azione.",
            highlight=["my-village"],
        ),
        TutorialStep(
            "resources", "Mana e Azioni",
            "Ogni turno ricevi Mana per pagare le carte e hai a disposizione 2 Azioni: giocare una carta, completare una Costruzione o aggiungere Muri.",
            highlight=["my-stats"],
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Hai completato il tour del campo di gioco. Prova ora il tutorial «Le Tue Prime Azioni» per imparare a giocare le carte.",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 2 — Le Tue Prime Azioni
# ---------------------------------------------------------------------------

def _t2_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    _set_hand(me, ["patrizio_1"])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=2, actions=2)
    state.phase = "action"


def _t2_setup_wall(state: GameState) -> None:
    me = _human(state)
    _set_hand(me, ["joseph_1"])


def _t2_setup_building(state: GameState) -> None:
    me = _human(state)
    _set_hand(me, ["estrattore_1"])
    _set_resources(me, mana=3, actions=2)


def _match_wall(base_iid: str) -> Callable[[dict], bool]:
    return lambda params: any(w.get("instance_id") == base_iid for w in params.get("walls", []))


TUTORIAL_AZIONI_BASE = TutorialDef(
    tutorial_id="azioni_base",
    title="Le Tue Prime Azioni",
    description="Impara a giocare un Guerriero, aggiungere Muri e piazzare una Costruzione.",
    order=2,
    steps=[
        TutorialStep(
            "intro", "2 Azioni a Turno",
            "In ogni turno hai 2 Azioni da spendere: giocare una carta, completare una Costruzione o aggiungere Muri. Iniziamo con un Guerriero: Patrizio.",
            highlight=["hand-area", "action-panel"], setup=_t2_setup_intro,
        ),
        TutorialStep(
            "play_patrizio", "Gioca un Guerriero",
            "Clicca Patrizio in mano e scegli l'Avanscoperta come destinazione. Costa 2 Mana.",
            highlight=["hand-area", "my-vanguard"],
            action="play_warrior", match={"instance_id": "patrizio_1", "region": "vanguard"},
            hint="Gioca Patrizio dalla mano in Avanscoperta.",
        ),
        TutorialStep(
            "walls_intro", "I Muri",
            "Bravo! Ti resta ancora 1 Azione. Qualsiasi carta può diventare un Muro a faccia in giù in un Bastione: assorbe danno in Battaglia.",
            highlight=["banner-btn-wall"], setup=_t2_setup_wall,
        ),
        TutorialStep(
            "add_wall", "Aggiungi un Muro",
            "Aggiungi la carta in mano come Muro nel Bastione Sinistro.",
            highlight=["hand-area", "my-bastion-left"],
            action="add_wall", match=_match_wall("joseph_1"),
            hint="Aggiungi la carta in mano come Muro nel Bastione Sinistro.",
        ),
        TutorialStep(
            "building_intro", "Le Costruzioni",
            "Ultimo passo: le Costruzioni. Ti ridiamo 2 Azioni fresche per esercitarti (in una vera partita dovresti aspettare il turno successivo).",
            highlight=["my-village"], setup=_t2_setup_building,
        ),
        TutorialStep(
            "play_building", "Gioca una Costruzione",
            "Gioca l'Estrattore dalla mano nel Villaggio: darà Mana extra a inizio turno.",
            highlight=["hand-area", "my-village"],
            action="play_building", match={"instance_id": "estrattore_1"},
            hint="Gioca l'Estrattore dalla mano nel Villaggio.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Hai imparato le azioni base: giocare Guerrieri e Costruzioni, e aggiungere Muri. Prova ora «L'Orda» per scoprire un'altra meccanica chiave.",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 3 — L'Orda
# ---------------------------------------------------------------------------

def _t3_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    _set_vanguard(me, ["patrizio_1", "patrizio_2"])
    _set_hand(me, ["giulio_1"])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=2, actions=2)
    state.phase = "action"


TUTORIAL_ORDA = TutorialDef(
    tutorial_id="orda",
    title="L'Orda",
    description="Schiera 3 Guerrieri della stessa Specie nella stessa Zona e attiva il loro effetto Orda.",
    order=3,
    steps=[
        TutorialStep(
            "intro", "Cos'è un'Orda",
            "Quando schieri 3 Guerrieri della stessa Specie nella stessa Zona, formi un'Orda e sblocchi un effetto speciale. "
            "Hai già 2 Patrizio (Elfi) in Avanscoperta.",
            highlight=["my-vanguard"], setup=_t3_setup_intro,
        ),
        TutorialStep(
            "play_third", "Completa l'Orda",
            "Gioca Giulio, un altro Guerriero Elfo, in Avanscoperta: non serve che sia lo stesso Guerriero dei "
            "primi due, basta la stessa Specie per completare l'Orda.",
            highlight=["hand-area", "my-vanguard"],
            action="play_warrior", match={"instance_id": "giulio_1", "region": "vanguard"},
            hint="Gioca Giulio (Elfo) in Avanscoperta.",
        ),
        TutorialStep(
            "phase_intro", "Fase di Schieramento",
            "Orda formata! Le Orde si attivano nella fase di Schieramento. Premi «Avanza Fase» per passare dalla fase Azioni allo Schieramento.",
            highlight=["btn-next-phase"],
            action="next_phase",
            hint="Premi «Avanza Fase» per passare allo Schieramento.",
        ),
        TutorialStep(
            "activate_intro", "Attiva l'Orda",
            "Ora attiva l'Orda: nella finestra che si apre scegli uno dei tuoi due Patrizio. L'effetto Orda di "
            "Patrizio si applica solo al Guerriero che selezioni, non a tutta l'Orda.",
            highlight=["btn-horde"],
            action="horde", match={"horde_card_id": "patrizio"},
            hint="Attiva l'Orda scegliendo uno dei tuoi Patrizio.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Il Patrizio che hai scelto ha ora +2 Gittata: gli altri due Guerrieri dell'Orda restano invariati, "
            "perché l'effetto vale solo per la carta selezionata. Prova «La Battaglia» per imparare ad attaccare.",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 4 — La Battaglia
# ---------------------------------------------------------------------------

def _t4_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    _set_vanguard(me, ["orfeo_1"])
    _set_hand(me, [])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=0, actions=2)
    state.phase = "action"

    dummy = _dummy(state)
    _reset_field(dummy)
    # Bastione Sinistro: nessun difensore (Difesa 0) — il danno passerà.
    _set_bastion(dummy, "left", wall_ids=["patrizio_4"])
    # Bastione Destro: Reinhold ha 3 Difesa, esattamente pari all'Attacco di
    # Orfeo — il danno verrà interamente assorbito.
    _set_bastion(dummy, "right", warrior_ids=["reinhold_1"])
    dummy.life_cards = ["joseph_1", "joseph_2", "joseph_3"]
    dummy.turns_completed = 1


def _t4_setup_second_attack(state: GameState) -> None:
    # Permette una seconda Battaglia nello stesso turno scriptato.
    state.battles_remaining = 1


TUTORIAL_BATTAGLIA = TutorialDef(
    tutorial_id="battaglia",
    title="La Battaglia",
    description="Attacca il Bastione di un avversario: scopri quando il danno passa e quando la Difesa lo blocca del tutto.",
    order=4,
    steps=[
        TutorialStep(
            "intro", "Prepara l'Attacco",
            "Il Danno Totale in Battaglia è max(Attacco − Difesa, 0) + max(Gittata − Gittata, 0). Il tuo Orfeo in "
            "Avanscoperta ha 3 Attacco. Il Manichino ha due Bastioni diversi: proviamo entrambi.",
            highlight=["my-vanguard", "top-opponents"], setup=_t4_setup_intro,
        ),
        TutorialStep(
            "phase_schieramento", "Avanza Fase",
            "Premi «Avanza Fase» per passare dalla fase Azioni alla fase Schieramento.",
            highlight=["btn-next-phase"],
            action="next_phase",
            hint="Premi «Avanza Fase» per passare allo Schieramento.",
        ),
        TutorialStep(
            "phase_battaglia", "Avanza Ancora",
            "Premi ancora «Avanza Fase» per entrare nella fase di Battaglia.",
            highlight=["btn-next-phase"],
            action="next_phase",
            hint="Premi «Avanza Fase» per entrare nella fase di Battaglia.",
        ),
        TutorialStep(
            "weak_intro", "Un Bastione indifeso",
            "Il Bastione Sinistro del Manichino non ha nessun Guerriero a difenderlo: Difesa 0. Il tuo Attacco (3) "
            "supera facilmente la Difesa: il danno passerà.",
            highlight=["btn-battle", "top-opponents"],
        ),
        TutorialStep(
            "attack_weak", "Attacca il lato debole",
            "Premi «Attacca» e scegli il Bastione Sinistro del Manichino.",
            highlight=["btn-battle"],
            action="battle", match={"defender_player_index": 1, "defender_bastion_side": "left"},
            hint="Attacca il Bastione Sinistro (indifeso) del Manichino.",
        ),
        TutorialStep(
            "strong_intro", "Un Bastione difeso",
            "Il danno è passato: il Muro è stato distrutto e il resto del danno ha tolto una Vita. Ora proviamo il "
            "Bastione Destro: qui il Manichino ha schierato Reinhold, con 3 Difesa — esattamente pari al tuo Attacco. "
            "Vediamo cosa succede quando la Difesa regge.",
            highlight=["btn-battle", "top-opponents"], setup=_t4_setup_second_attack,
        ),
        TutorialStep(
            "attack_strong", "Attacca il lato forte",
            "Premi «Attacca» e scegli il Bastione Destro del Manichino.",
            highlight=["btn-battle"],
            action="battle", match={"defender_player_index": 1, "defender_bastion_side": "right"},
            hint="Attacca il Bastione Destro (difeso) del Manichino.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Hai visto entrambi i casi: contro Difesa 0 il danno è passato (Muro distrutto e 1 Vita persa); contro "
            "Difesa 3, pari al tuo Attacco, il danno è stato azzerato e nessun Muro è caduto. Prova ora «Le Magie» "
            "per imparare a lanciarle in versione Base e Prodigio.",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 5 — Le Magie
# ---------------------------------------------------------------------------

def _t5_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    # Evelyn è una Maga, ma di Scuola Sortilegio: paga il costo di Ardolancio
    # (1 Maga qualsiasi) ma NON ne attiva il Prodigio (serve Scuola Anatema).
    _set_vanguard(me, ["evelyn_1"])
    _set_hand(me, ["ardolancio_1", "ardolancio_2"])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=0, actions=2)
    state.phase = "action"

    dummy = _dummy(state)
    _reset_field(dummy)
    # Bastione Sinistro: 2 Muri, per il lancio Base ("scarta fino a 2 Muri").
    _set_bastion(dummy, "left", wall_ids=["joseph_1", "joseph_2"])
    # Bastione Destro: 4 Muri, per il lancio Prodigio ("scarta fino a 4 Muri").
    _set_bastion(dummy, "right", wall_ids=["joseph_3", "joseph_4", "cardo_1", "cardo_2"])
    dummy.turns_completed = 1


def _t5_setup_add_araminta(state: GameState) -> None:
    me = _human(state)
    _set_vanguard(me, ["evelyn_1", "araminta_1"])
    _set_hand(me, ["ardolancio_2"])


TUTORIAL_MAGIE = TutorialDef(
    tutorial_id="magie",
    title="Le Magie",
    description="Lancia la stessa Magia due volte: prima in versione Base, poi in Prodigio, e confronta l'effetto.",
    order=5,
    steps=[
        TutorialStep(
            "intro", "Il Costo delle Magie",
            "Le Magie non si pagano con il Mana, ma con le Maghe che hai schierato in campo! Hai Evelyn (Maga "
            "Sortilegio) in Avanscoperta e due copie di Ardolancio (Anatema) in mano.",
            highlight=["my-vanguard", "hand-area"], setup=_t5_setup_intro,
        ),
        TutorialStep(
            "base_explain", "Effetto Base",
            "Ardolancio costa 1 Maga di qualsiasi Scuola: Evelyn ti permette di pagarlo, ma essendo di Scuola "
            "Sortilegio (non Anatema) NON attiva il Prodigio. Effetto Base: scarta fino a 2 Muri casuali. Lancialo "
            "contro il Bastione Sinistro, che ha esattamente 2 Muri.",
            highlight=["hand-area", "top-opponents"],
        ),
        TutorialStep(
            "cast_base", "Lancia il primo Ardolancio",
            "Gioca il primo Ardolancio scegliendo come bersaglio il Bastione Sinistro del Manichino.",
            highlight=["hand-area", "top-opponents"],
            action="play_spell",
            match={"instance_id": "ardolancio_1", "target_player_id": "player_2", "target_bastion_side": "left"},
            hint="Gioca il primo Ardolancio contro il Bastione Sinistro del Manichino.",
        ),
        TutorialStep(
            "prodigio_explain", "Effetto Prodigio",
            "Fatto: il lancio Base ha scartato 2 Muri su 2! Ora aggiungiamo Araminta, Maga di Scuola Anatema, al tuo "
            "schieramento: essendo proprio la Scuola di Ardolancio, il prossimo lancio attiverà il Prodigio — fino "
            "a 4 Muri invece di 2. Il Bastione Destro del Manichino ha esattamente 4 Muri ad aspettarti.",
            highlight=["my-vanguard"], setup=_t5_setup_add_araminta,
        ),
        TutorialStep(
            "cast_prodigy", "Lancia il secondo Ardolancio",
            "Gioca il secondo Ardolancio, questa volta in Prodigio, contro il Bastione Destro del Manichino.",
            highlight=["hand-area", "top-opponents"],
            action="play_spell",
            match={"instance_id": "ardolancio_2", "target_player_id": "player_2", "target_bastion_side": "right"},
            hint="Gioca il secondo Ardolancio (Prodigio) contro il Bastione Destro del Manichino.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Hai visto la differenza: il lancio Base ha scartato 2 Muri, il Prodigio ne ha scartati 4! Ricorda: il "
            "Prodigio si attiva quando le Maghe della Scuola giusta in campo sono almeno pari al costo della Magia. "
            "Le Magie vengono sempre scartate dopo l'uso (salvo rare eccezioni). Hai completato tutti i tutorial "
            "base: sei pronto per una vera partita!",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------------

TUTORIALS: Dict[str, TutorialDef] = {
    t.tutorial_id: t for t in [
        TUTORIAL_ZONE_CAMPO,
        TUTORIAL_AZIONI_BASE,
        TUTORIAL_ORDA,
        TUTORIAL_BATTAGLIA,
        TUTORIAL_MAGIE,
    ]
}


def get_tutorial(tutorial_id: str) -> Optional[TutorialDef]:
    return TUTORIALS.get(tutorial_id)


def list_tutorials_meta() -> List[dict]:
    return [t.meta() for t in sorted(TUTORIALS.values(), key=lambda t: t.order)]


# ---------------------------------------------------------------------------
# Creazione partita tutorial
# ---------------------------------------------------------------------------

def create_tutorial_game(tutorial_id: str, player_name: str = "Tu", game_id: Optional[str] = None) -> GameState:
    """Crea una partita in solitaria scriptata per il tutorial richiesto."""
    import uuid as _uuid

    tdef = get_tutorial(tutorial_id)
    if tdef is None:
        raise ValueError(f"Tutorial sconosciuto: {tutorial_id}")

    if game_id is None:
        game_id = f"tut-{_uuid.uuid4().hex[:8]}"

    human = Player(id="player_1", name=player_name or "Tu", mana_remaining=0, actions_remaining=2, turns_completed=1)
    dummy = Player(id="player_2", name=DUMMY_NAME, mana_remaining=0, actions_remaining=0, turns_completed=1)
    # Vite di riempimento di default: garantiscono che il Manichino non parta
    # "già eliminato" (0 Vite) nei tutorial che non lo attaccano mai.
    # Non collidono con nessuna carta usata dagli script dei tutorial.
    dummy.life_cards = ["faust_1", "faust_2", "faust_3"]

    state = GameState(
        game_id=game_id,
        turn=1,
        current_player_index=0,
        first_player_index=0,
        phase="action",
        players=[human, dummy],
        deck=_build_filler_deck(_TUTORIAL_DECK_SIZE),
        battles_remaining=1,
        turn_timer=0,
        tutorial={"tutorial_id": tutorial_id, "step_index": 0, "completed": False},
    )
    _apply_step_setup(state, tdef, 0)
    return state


def _apply_step_setup(state: GameState, tdef: TutorialDef, idx: int) -> None:
    step = tdef.steps[idx]
    if step.setup:
        step.setup(state)


def _match_params(match: MatchType, params: dict) -> bool:
    if callable(match):
        return bool(match(params))
    for k, v in (match or {}).items():
        if params.get(k) != v:
            return False
    return True


def validate_action(state: GameState, action: str, params: dict) -> Optional[str]:
    """Ritorna un messaggio d'errore se l'azione non è quella richiesta dallo
    step corrente del tutorial, altrimenti None (azione permessa)."""
    tut = state.tutorial
    if not tut or tut.get("completed"):
        return None
    if action in ("tutorial_next", "leave_game"):
        return None

    tdef = get_tutorial(tut["tutorial_id"])
    if tdef is None:
        return None
    idx = tut["step_index"]
    if idx >= len(tdef.steps):
        return None

    step = tdef.steps[idx]
    if step.action is None:
        return "Premi «Avanti» per continuare il tutorial."
    if action != step.action:
        return step.hint
    if not _match_params(step.match, params):
        return step.hint
    return None


def advance_after_action(state: GameState, action: str, params: dict) -> Optional[dict]:
    """Da chiamare dopo che un'azione di gioco è stata eseguita con successo.
    Se corrisponde allo step "action" corrente, avanza al prossimo step."""
    tut = state.tutorial
    if not tut or tut.get("completed"):
        return None
    tdef = get_tutorial(tut["tutorial_id"])
    if tdef is None:
        return None
    idx = tut["step_index"]
    if idx >= len(tdef.steps):
        return None
    step = tdef.steps[idx]
    if step.action is None or step.action != action:
        return None
    if not _match_params(step.match, params):
        return None
    return _advance(state, tdef)


def advance_info_step(state: GameState) -> dict:
    """Gestisce l'azione "tutorial_next" (bottone Avanti) per uno step informativo."""
    tut = state.tutorial
    if not tut:
        raise ActionError("Questa non è una partita tutorial.")
    if tut.get("completed"):
        return {"tutorial_completed": True}
    tdef = get_tutorial(tut["tutorial_id"])
    if tdef is None:
        raise ActionError("Tutorial sconosciuto.")
    idx = tut["step_index"]
    if idx >= len(tdef.steps):
        tut["completed"] = True
        return {"tutorial_completed": True}
    step = tdef.steps[idx]
    if step.action is not None:
        raise ActionError(step.hint)
    return _advance(state, tdef)


def _advance(state: GameState, tdef: TutorialDef) -> dict:
    tut = state.tutorial
    tut["step_index"] += 1
    if tut["step_index"] >= len(tdef.steps):
        tut["completed"] = True
        return {"tutorial_completed": True}
    _apply_step_setup(state, tdef, tut["step_index"])
    return {"tutorial_step": tut["step_index"]}
