"""
Modalità Tutorial di Barbacane.

Ogni Tutorial è una partita in solitaria completamente scriptata: il giocatore
umano ("player_1") ha sempre la stessa mano/campo prestabiliti, ed è affiancato
da un "Manichino" (player_2) che non gioca mai — serve solo da bersaglio per la
Battaglia. Ogni passo (step) del tutorial prepara direttamente mano/campo/risorse
tramite `setup`; il Mazzo comune è solo di scena (si pesca soltanto nel tutorial
«Il Turno», che mostra la pesca di fine turno).

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

Tornare indietro ("tutorial_prev") è possibile solo verso uno step "info": tra
uno step "info" e il successivo non si gioca nessuna mossa, quindi basta
ripristinare lo stato com'era all'ingresso di quello step. Per questo si salva
un'istantanea dello stato (`tutorial["snapshots"]`) all'ingresso di ogni step
che la cambia: lo step iniziale, quelli con `setup` e quelli subito dopo una
mossa. Una mossa già giocata non si annulla mai.
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
        card_focus: Optional[Dict[str, Any]] = None,
    ):
        self.step_id = step_id
        self.title = title
        self.text = text
        self.highlight = highlight or []
        self.action = action              # None per gli step "info"
        self.match = match or {}
        self.hint = hint or "Non è l'azione richiesta da questo passo del tutorial."
        self.setup = setup
        # Step "anatomia carta": il frontend mostra la carta a schermo intero
        # ({"card": base_card_id, "rect": [x, y, w, h] in % o None}) invece del
        # campo, evidenziando la sezione indicata da rect.
        self.card_focus = card_focus

    def to_dict(self) -> dict:
        mobile_ids: List[str] = []
        for hid in self.highlight:
            mids = _MOBILE_HIGHLIGHT_MAP.get(hid) or []
            for mid in [mids] if isinstance(mids, str) else mids:
                if mid not in mobile_ids:
                    mobile_ids.append(mid)
        return {
            "id": self.step_id,
            "title": self.title,
            "text": self.text,
            "highlight": self.highlight,
            "highlight_mobile": mobile_ids,
            "requires_action": self.action,
            "card_focus": self.card_focus,
        }


# Il frontend mobile usa ID DOM diversi (layout a tasselli invece che regioni
# fisse): questa mappa deriva automaticamente gli highlight mobile da quelli
# desktop, così ogni TutorialStep si scrive una volta sola. Un ID desktop può
# corrispondere a più ID mobile (una lista): lo Spotlight li evidenzia tutti.
_MOBILE_HIGHLIGHT_MAP: Dict[str, Union[str, List[str]]] = {
    ">hand-cards": ">hand",
    "hdr-deck": "tb-deck",
    "my-life-deck": "st-lives",
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
    "von_reinhold", "the_pyric", "orfeus", "giulio_ii",
    "doktor_faustus", "the_briny", "polemarco", "polemarcos", "pio_decimo",
    "kaiser_joseph", "the_nemoral", "eracles",
    "vitalflusso", "magiscudo", "equipotenza", "regicidio", "agilpesca",
    "arrampicarta", "investimento", "cuordipietra",
    "bastioncontrario", "divinazione", "malcomune", "telecinesi",
    "cercapersone", "incendifesa", "dazipazzi", "plasmattone", "cambiamente",
    "plasmarmo",
    "fucina", "biblioteca", "ariete", "sorgiva",
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
# Tutorial 1 — Anatomia di una Carta
# ---------------------------------------------------------------------------

# Riquadri delle sezioni sulle immagini delle carte (card_factory/output/*.png),
# in percentuale della carta: [x, y, larghezza, altezza]. Misurati sul layout
# di card_factory/assets/card.html (carta 744x1039px) con un piccolo margine
# attorno a ogni sezione: se card.html cambia layout vanno rimisurati.
_RECT_NAME_TYPE = [16.3, 2.9, 67.5, 13.2]      # nastro del nome + riga del tipo
_RECT_COST = [82.5, 2.7, 13.2, 9.4]            # esagono (Mana) / stella (Maghe)
_RECT_RECRUIT_STATS = [30.9, 46.8, 38.2, 11.4]
_RECT_RECRUIT_INFO = [10.6, 59.5, 78.9, 17.5]  # Specie + Evolve in
_RECT_RECRUIT_HORDE = [7.8, 78.8, 84.4, 16.8]
_RECT_HERO_STATS = [30.9, 67.6, 38.2, 11.4]
_RECT_HERO_INFO = [10.6, 78.8, 78.9, 16.0]     # Specie + Evolve da
_RECT_EFFECT_TOP = [7.8, 49.7, 84.4, 23.1]     # Base (Magie e Costruzioni)
_RECT_EFFECT_BOTTOM = [7.8, 72.4, 84.4, 23.1]  # Prodigio / Completo


def _focus(card_id: str, rect: Optional[List[float]] = None) -> Dict[str, Any]:
    return {"card": card_id, "rect": rect}


TUTORIAL_ANATOMIA_CARTA = TutorialDef(
    tutorial_id="anatomia_carta",
    title="Anatomia di una Carta",
    description="Impara a leggere le carte: Recluta, Eroe, Magia e Costruzione, sezione per sezione.",
    order=1,
    steps=[
        # --- Recluta ---
        TutorialStep(
            "intro", "Benvenuto a Barbacane!",
            "Prima di giocare impariamo a leggere le carte. Esistono tre tipi di carte: Guerrieri, Magie e "
            "Costruzioni, e il colore della cornice li distingue a colpo d'occhio: rossa per i Guerrieri, blu per "
            "le Magie, verde per le Costruzioni. Iniziamo da un Guerriero: Patrizio.",
            card_focus=_focus("patrizio"),
        ),
        TutorialStep(
            "recruit_name", "Nome e Tipo",
            "In alto trovi il nome della carta e, subito sotto, il suo tipo. Patrizio è un Guerriero di tipo "
            "Recluta: la forma base dei Guerrieri, che più avanti potrà evolvere in un Eroe.",
            card_focus=_focus("patrizio", _RECT_NAME_TYPE),
        ),
        TutorialStep(
            "recruit_cost", "Il Costo in Mana",
            "L'esagono in alto a destra è il costo in Mana: per giocare Patrizio devi spendere 2 Mana. Ricevi "
            "Mana all'inizio di ogni turno, e ne ricevi sempre di più man mano che la partita avanza.",
            card_focus=_focus("patrizio", _RECT_COST),
        ),
        TutorialStep(
            "recruit_stats", "Le Caratteristiche",
            "I tre rombi sono le Caratteristiche del Guerriero. ATT (Attacco) conta quando attacchi "
            "dall'Avanscoperta, DIF (Difesa) quando difendi un Bastione, GIT (Gittata) conta in entrambi i casi.",
            card_focus=_focus("patrizio", _RECT_RECRUIT_STATS),
        ),
        TutorialStep(
            "recruit_info", "Specie ed Evoluzione",
            "La Specie (qui Elfo) serve a formare le Orde: 3 Guerrieri della stessa Specie nella stessa Regione. "
            "«Evolve in» indica l'Eroe in cui questa Recluta può trasformarsi: San Patrizio.",
            card_focus=_focus("patrizio", _RECT_RECRUIT_INFO),
        ),
        TutorialStep(
            "recruit_horde", "L'Effetto Orda",
            "Sotto le spade c'è l'effetto Orda: quando Patrizio fa parte di un'Orda, puoi scegliere di attivare "
            "questo effetto durante la fase di Schieramento.",
            card_focus=_focus("patrizio", _RECT_RECRUIT_HORDE),
        ),
        # --- Eroe ---
        TutorialStep(
            "hero_type", "Un Eroe",
            "Ecco San Patrizio, l'Eroe di Patrizio. Un Eroe non si gioca da solo: si posiziona sopra la sua Recluta "
            "già in campo, pagando il costo in Mana indicato nell'esagono.",
            card_focus=_focus("san_patrizio", _RECT_NAME_TYPE),
        ),
        TutorialStep(
            "hero_stats", "Caratteristiche Potenziate",
            "L'Eroe ha Caratteristiche più alte della sua Recluta: San Patrizio ha 4 ATT, 3 GIT e 3 DIF, contro "
            "i 2, 1 e 2 di Patrizio.",
            card_focus=_focus("san_patrizio", _RECT_HERO_STATS),
        ),
        TutorialStep(
            "hero_info", "Evolve da",
            "Qui trovi la Recluta da cui l'Eroe evolve. L'Eroe non ha un effetto Orda stampato: eredita quello "
            "della sua Recluta, insieme a eventuali carte assegnate.",
            card_focus=_focus("san_patrizio", _RECT_HERO_INFO),
        ),
        # --- Magia ---
        TutorialStep(
            "spell_type", "Una Magia",
            "Cornice blu: Ardolancio è una Magia. Accanto al tipo trovi la sua Scuola, qui Anatema. Le Magie hanno "
            "un effetto immediato e, salvo eccezioni, vengono scartate dopo l'uso.",
            card_focus=_focus("ardolancio", _RECT_NAME_TYPE),
        ),
        TutorialStep(
            "spell_cost", "Le Maghe Richieste",
            "Le Magie non si pagano con il Mana. Il numero nella stella indica quante Maghe devi avere in campo "
            "per lanciarla (qui 1), di qualsiasi Scuola. Non le spendi: dopo il lancio restano dove sono.",
            card_focus=_focus("ardolancio", _RECT_COST),
        ),
        TutorialStep(
            "spell_base", "Effetto Base",
            "Sotto la stella vuota c'è l'effetto Base: è quello che ottieni lanciando la Magia normalmente.",
            card_focus=_focus("ardolancio", _RECT_EFFECT_TOP),
        ),
        TutorialStep(
            "spell_prodigy", "Effetto Prodigio",
            "Sotto la stella piena c'è l'effetto Prodigio, più potente: lo ottieni al posto del Base se le Maghe "
            "in campo della stessa Scuola della Magia (qui Anatema) sono almeno quante ne indica la stella. Se il "
            "testo inizia "
            "con «&», si aggiunge al Base invece di sostituirlo.",
            card_focus=_focus("ardolancio", _RECT_EFFECT_BOTTOM),
        ),
        # --- Costruzione ---
        TutorialStep(
            "building_type", "Una Costruzione",
            "Cornice verde: la Catapulta è una Costruzione. Si gioca nel Villaggio e il suo effetto resta attivo "
            "turno dopo turno.",
            card_focus=_focus("catapulta", _RECT_NAME_TYPE),
        ),
        TutorialStep(
            "building_cost", "Il Costo in Mana",
            "Come per i Guerrieri, l'esagono in alto a destra è il costo in Mana per giocare la Costruzione: "
            "qui 2.",
            card_focus=_focus("catapulta", _RECT_COST),
        ),
        TutorialStep(
            "building_base", "Effetto Base",
            "Appena giocata, una Costruzione è incompleta (torre vuota) e fornisce solo il suo effetto Base.",
            card_focus=_focus("catapulta", _RECT_EFFECT_TOP),
        ),
        TutorialStep(
            "building_complete", "Effetto Completo",
            "Spendendo un'Azione e il Mana indicato nel piccolo esagono (qui 2) completi la Costruzione: da quel "
            "momento vale l'effetto Completo al posto del Base.",
            card_focus=_focus("catapulta", _RECT_EFFECT_BOTTOM),
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Ora sai leggere ogni carta. In partita puoi sempre toccare una carta, in mano o in campo, per vederla "
            "a schermo intero. Prova ora «Il Campo di Gioco» per scoprire dove si giocano.",
            card_focus=_focus("catapulta"),
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 2 — Il Campo di Gioco
# ---------------------------------------------------------------------------

def _t2_setup_board(state: GameState) -> None:
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


TUTORIAL_CAMPO = TutorialDef(
    tutorial_id="campo",
    title="Il Campo di Gioco",
    description="Un tour guidato del tuo campo: risorse, Mano, Mazzo, Vite, Avanscoperta, Bastioni e Villaggio.",
    order=2,
    steps=[
        TutorialStep(
            "intro", "Il Campo di Gioco",
            "Ti mostriamo le zone del tuo campo di gioco, una alla volta. Premi «Avanti» per iniziare.",
            highlight=[], setup=_t2_setup_board,
        ),
        TutorialStep(
            "resources", "Mana e Azioni",
            "Qui vedi le risorse del tuo turno. Il Mana serve a pagare Guerrieri e Costruzioni. Le Azioni sono 2 "
            "per turno: ognuna ti permette di giocare una carta, completare una Costruzione o aggiungere Muri. "
            "Le vedremo all'opera nel tutorial «Le Azioni di un Turno».",
            highlight=["my-stats"],
        ),
        TutorialStep(
            "hand", "La Mano",
            "Qui in basso c'è la tua Mano: le carte che puoi giocare nel tuo turno. Gli avversari vedono solo "
            "quante ne hai, non quali.",
            highlight=[">hand-cards"],
        ),
        TutorialStep(
            "deck", "Il Mazzo",
            "In alto vedi quante carte restano nel Mazzo, comune a tutti i giocatori. Alla fine di ogni tuo turno "
            "peschi fino ad avere 6 carte in mano. Quando il Mazzo finisce, gli scarti vengono rimescolati e "
            "diventano il nuovo Mazzo.",
            highlight=["hdr-deck"],
        ),
        TutorialStep(
            "lives", "Le Vite",
            "Le tue Vite sono carte a faccia in giù: solo tu sai quali sono. Ogni volta che un avversario sfonda "
            "le tue difese ne perdi una, e a zero Vite sei eliminato. Vince l'ultimo giocatore rimasto con "
            "almeno una Vita.",
            highlight=["my-life-deck"],
        ),
        TutorialStep(
            "vanguard", "L'Avanscoperta",
            "Da qui attacchi: i Guerrieri che metti in Avanscoperta sono quelli che combattono quando dichiari "
            "una Battaglia.",
            highlight=["my-vanguard"],
        ),
        TutorialStep(
            "bastions", "I Bastioni",
            "Qui ti difendi. Ogni Bastione ha i suoi Muri (carte a faccia in giù che assorbono i danni) e può "
            "avere dei Guerrieri a difenderlo. Un avversario può attaccare solo i Bastioni adiacenti ai suoi: la "
            "scritta «Esposto a…» ti dice chi può colpire ciascuno dei tuoi Bastioni.",
            highlight=["my-bastion-left", "my-bastion-right"],
        ),
        TutorialStep(
            "village", "Il Villaggio",
            "Nel Villaggio giochi le Costruzioni, che ti danno effetti turno dopo turno. Il Villaggio non "
            "partecipa mai alla Battaglia.",
            highlight=["my-village"],
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Hai completato il tour del campo di gioco. Prova ora «Le Azioni di un Turno» per giocare i tuoi primi "
            "turni.",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 3 — Le Azioni di un Turno
# ---------------------------------------------------------------------------

# Due turni veri di fila (4 e 5), senza Azioni né Mana regalati, che mostrano
# una per una le tre Azioni possibili. I costi sono scelti perché tutto torni
# con il Mana reale del turno:
#   Turno 4 (2 Mana): gioca San Patrizio sopra Patrizio (2) + Muri (gratis).
#   Turno 5 (3 Mana): completa la Catapulta già nel Villaggio (2) — avanzano
#   1 Azione e 1 Mana, per mostrare che non si è obbligati a usarli.
# La Costruzione è la Catapulta perché è passiva: un Estrattore incompleto
# tirerebbe un D10 a inizio turno e potrebbe dare Mana extra a caso.

def _t3_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    _set_vanguard(me, ["patrizio_1"])
    _set_village(me, ["catapulta_1"])
    _set_hand(me, ["san_patrizio_1", "giulio_1", "joseph_1", "joseph_2", "cardo_1", "ardolancio_1"])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    state.turn = 4
    _set_resources(me, mana=state.mana_for_turn(state.turn), actions=2)
    state.phase = "action"


def _t3_setup_next_turn(state: GameState) -> None:
    # Dopo "Fine Turno" il motore ha già fatto pescare il giocatore e passato
    # il turno al Manichino, che però non gioca: il copione glielo fa saltare
    # e restituisce il turno al giocatore, che riceve Mana come in partita.
    from engine.game import _begin_turn
    state.current_player_index = 0
    state.turn += 1
    _begin_turn(state)


def _match_walls_up_to(count: int) -> Callable[[dict], bool]:
    return lambda params: 1 <= len(params.get("walls", [])) <= count


TUTORIAL_TURNO = TutorialDef(
    tutorial_id="turno",
    title="Le Azioni di un Turno",
    description="Gioca due turni completi e prova le tre Azioni: giocare una carta, completare una Costruzione, aggiungere Muri.",
    order=3,
    steps=[
        # --- Turno 4 ---
        TutorialStep(
            "intro", "Com'è fatto un Turno",
            "Ogni turno segue sempre lo stesso ordine: ricevi Mana, usi fino a 2 Azioni, schieri i Guerrieri, "
            "attacchi se vuoi e infine peschi. Qui vedi a che punto sei. Giochiamo due turni di fila!",
            highlight=["phase-bar"], setup=_t3_setup_intro,
        ),
        TutorialStep(
            "mana", "Il Mana",
            "A inizio turno ricevi Mana in base al numero del turno: 1 nei turni 1–2, 2 nei turni 3–4, 3 nei "
            "turni 5–6, 4 nei turni 7–9 e 5 dal 10° in poi. Siamo al turno 4, quindi hai 2 Mana.",
            highlight=["my-stats"],
        ),
        TutorialStep(
            "three_actions", "Le Tre Azioni",
            "In ogni turno hai 2 Azioni, e ognuna può essere una di queste tre: 1) giocare una carta dalla mano; "
            "2) completare una Costruzione del tuo Villaggio; 3) aggiungere fino a 3 Muri. Le proviamo tutte e tre.",
            highlight=["banner-btn-play", "banner-btn-complete", "banner-btn-wall"],
        ),
        TutorialStep(
            "play_intro", "Azione: Giocare una Carta",
            "Giocare una carta vuol dire metterla in campo pagandone il costo: un Guerriero in una Regione, una "
            "Costruzione nel Villaggio, una Magia sul suo bersaglio. Anche evolvere è giocare una carta: se hai in "
            "campo una Recluta e in mano il suo Eroe, giochi l'Eroe sopra la Recluta pagandone il costo in Mana. "
            "L'Eroe eredita l'effetto Orda e le carte assegnate della Recluta; se poi viene scartato, la Recluta "
            "resta in campo.",
            highlight=[">hand-cards", "my-vanguard"],
        ),
        TutorialStep(
            "evolve", "Evolvi Patrizio",
            "Tocca San Patrizio in mano e fallo evolvere dal Patrizio in Avanscoperta: costa 2 Mana, proprio "
            "quelli che hai.",
            highlight=[">hand-cards", "my-vanguard"],
            action="evolve", match={"hero_instance_id": "san_patrizio_1"},
            hint="Fai evolvere Patrizio giocando San Patrizio dalla mano.",
        ),
        TutorialStep(
            "walls_intro", "Azione: Aggiungere Muri",
            "Qualsiasi carta può diventare un Muro: va a faccia in giù in un Bastione e perde ogni altra funzione. "
            "Con una sola Azione, e senza spendere Mana, puoi aggiungere fino a 3 Muri, anche in Bastioni diversi.",
            highlight=["banner-btn-wall", "my-bastion-left", "my-bastion-right"],
        ),
        TutorialStep(
            "add_walls", "Aggiungi i Muri",
            "Premi «Aggiungi muri», tocca fino a 3 carte qualsiasi della mano, scegli per ognuna il Bastione e "
            "conferma.",
            highlight=["banner-btn-wall", "wall-staging", ">hand-cards", "my-bastion-left", "my-bastion-right"],
            action="add_wall", match=_match_walls_up_to(3),
            hint="Aggiungi da 1 a 3 carte della mano come Muri, con un'unica Azione.",
        ),
        TutorialStep(
            "to_schieramento", "Azioni Finite",
            "Hai usato entrambe le Azioni. Premi il pulsante evidenziato per passare alla fase di Schieramento.",
            highlight=["btn-next-phase"],
            action="next_phase",
            hint="Premi il pulsante evidenziato per passare allo Schieramento.",
        ),
        TutorialStep(
            "schieramento", "Lo Schieramento",
            "Nello Schieramento puoi spostare gratis i tuoi Guerrieri tra Avanscoperta e Bastioni e attivare le "
            "Orde. Lo vedremo nel tutorial «Schieramento e Orde»: per ora andiamo avanti.",
            highlight=["phase-bar"],
        ),
        TutorialStep(
            "to_battaglia", "Passa alla Battaglia",
            "Premi il pulsante evidenziato per passare alla fase di Battaglia.",
            highlight=["btn-next-phase"],
            action="next_phase",
            hint="Premi il pulsante evidenziato per passare alla Battaglia.",
        ),
        TutorialStep(
            "battaglia", "La Battaglia",
            "In Battaglia puoi attaccare un avversario con i Guerrieri in Avanscoperta: lo vedremo nel tutorial "
            "«La Battaglia». Attaccare è facoltativo, e questa volta non lo facciamo.",
            highlight=["btn-battle", "btn-end-turn"],
        ),
        TutorialStep(
            "end_turn", "Fine Turno",
            "Premi «Fine Turno». Alla fine del turno peschi carte dal Mazzo fino ad averne 6 in mano (se ne hai "
            "già 6 o più, non peschi). Poi tocca agli avversari.",
            highlight=["btn-end-turn", ">hand-cards"],
            action="end_turn",
            hint="Premi «Fine Turno».",
        ),
        # --- Turno 5 ---
        TutorialStep(
            "drawn", "Hai Pescato",
            "Hai pescato fino ad avere di nuovo 6 carte in mano. Il Manichino ha passato il suo turno, quindi "
            "tocca di nuovo a te.",
            highlight=[">hand-cards"], setup=_t3_setup_next_turn,
        ),
        TutorialStep(
            "new_mana", "Nuovo Turno, Più Mana",
            "Siamo al turno 5: il Mana del turno è salito da solo a 3, e le tue Azioni sono di nuovo 2.",
            highlight=["my-stats"],
        ),
        TutorialStep(
            "complete_intro", "Azione: Completare una Costruzione",
            "La Catapulta nel tuo Villaggio è incompleta: per ora dà solo il suo effetto Base. Con un'Azione e il "
            "Mana indicato nel piccolo esagono della carta (qui 2) la completi, e da quel momento vale il suo "
            "effetto Completo.",
            highlight=["my-village", "banner-btn-complete"],
        ),
        TutorialStep(
            "complete_building", "Completa la Catapulta",
            "Premi «Completa» e scegli la Catapulta.",
            highlight=["banner-btn-complete", "my-village"],
            action="complete_building", match={"building_instance_id": "catapulta_1"},
            hint="Completa la Catapulta nel tuo Villaggio.",
        ),
        TutorialStep(
            "leftover", "Azioni e Mana Avanzati",
            "Ti restano 1 Azione e 1 Mana. Non sei obbligato a usarli, ma il Mana che non spendi si perde a fine "
            "turno: non si accumula da un turno all'altro.",
            highlight=["my-stats"],
        ),
        TutorialStep(
            "extra_mana", "Più Mana",
            "Oltre al Mana del turno, alcune carte te ne danno altro: per esempio l'Estrattore completo ti dà 1 "
            "Mana in più a ogni inizio turno, e la Magia Investimento te ne dà 2 subito.",
            highlight=["my-stats"],
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Hai giocato due turni completi e provato tutte e tre le Azioni. Prova ora «Maghe e Prodigi» per "
            "scoprire come si lanciano le Magie.",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 5 — Schieramento e Orde
# ---------------------------------------------------------------------------

def _t5_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    _set_vanguard(me, ["patrizio_1", "patrizio_2"])
    _set_bastion(me, "left", warrior_ids=["giulio_1"], wall_ids=["joseph_1"])
    _set_hand(me, [])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=0, actions=0)
    state.phase = "schieramento"


TUTORIAL_SCHIERAMENTO = TutorialDef(
    tutorial_id="schieramento",
    title="Schieramento e Orde",
    description="Sposta i tuoi Guerrieri tra le Regioni e forma un'Orda per attivarne l'effetto.",
    order=5,
    steps=[
        TutorialStep(
            "intro", "Lo Schieramento",
            "Siamo già nella fase di Schieramento, dopo le Azioni. Qui puoi fare due cose, entrambe gratis: "
            "spostare i tuoi Guerrieri e attivare le Orde.",
            highlight=["phase-bar"], setup=_t5_setup_intro,
        ),
        TutorialStep(
            "reposition_intro", "Spostare i Guerrieri",
            "Puoi spostare i Guerrieri tra Avanscoperta e Bastioni quante volte vuoi, senza spendere Azioni. "
            "Hai due Patrizio (Elfi) in Avanscoperta e Giulio, anche lui Elfo, nel Bastione Sinistro.",
            highlight=["my-vanguard", "my-bastion-left"],
        ),
        TutorialStep(
            "reposition", "Sposta Giulio",
            "Tocca Giulio nel Bastione Sinistro, premi «Riposiziona» e scegli l'Avanscoperta.",
            highlight=["my-bastion-left", "my-vanguard"],
            action="reposition", match={"warrior_instance_id": "giulio_1", "destination": "vanguard"},
            hint="Sposta Giulio dal Bastione Sinistro all'Avanscoperta.",
        ),
        TutorialStep(
            "horde_formed", "Orda Formata!",
            "3 Guerrieri della stessa Specie nella stessa Regione formano un'Orda. Non serve che siano la stessa "
            "carta: 2 Patrizio e 1 Giulio sono tutti Elfi.",
            highlight=["my-vanguard"],
        ),
        TutorialStep(
            "horde_choice", "Un Solo Effetto",
            "Un'Orda attiva UN solo effetto Orda, che scegli tu tra quelli dei suoi Guerrieri. Qui puoi scegliere "
            "Patrizio («Questa carta ottiene +2 GIT») oppure Giulio (a inizio turno cerca Giulio II nel Mazzo).",
            highlight=["my-vanguard"],
        ),
        TutorialStep(
            "activate", "Attiva l'Orda",
            "Premi «Orda» e scegli Patrizio. «Questa carta» indica proprio il Patrizio che scegli: sarà lui a "
            "ottenere +2 GIT.",
            highlight=["btn-horde", "my-vanguard"],
            action="horde", match={"horde_card_id": "patrizio"},
            hint="Premi «Orda» e attiva l'effetto di uno dei tuoi Patrizio.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Il Patrizio scelto ha ora 3 GIT invece di 1. L'effetto resta attivo anche nei turni successivi, finché "
            "i 3 Elfi restano insieme: se ne sposti via uno, l'Orda si scioglie e l'effetto sparisce. Se in un "
            "turno successivo scegli un altro effetto per la stessa Orda, quello vecchio si disattiva. Prova ora "
            "«La Battaglia».",
            highlight=["my-vanguard"],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 6 — La Battaglia
# ---------------------------------------------------------------------------

def _t6_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    # ATT massimo da Orfeo (3), GIT massima da Patrizio (1): i valori d'attacco
    # sono i massimi tra tutti i Guerrieri in Avanscoperta, anche di carte diverse.
    _set_vanguard(me, ["orfeo_1", "patrizio_1"])
    _set_hand(me, [])
    me.life_cards = list(_HUMAN_LIFE_CARDS)
    _set_resources(me, mana=0, actions=0)
    state.phase = "battaglia"

    dummy = _dummy(state)
    _reset_field(dummy)
    # Bastione Sinistro: nessun difensore e 1 Muro — Danno 4, il Muro cade e
    # il resto del danno toglie UNA sola Vita.
    _set_bastion(dummy, "left", wall_ids=["patrizio_4"])
    # Bastione Destro: Reinhold (DIF 3, GIT 0) blocca l'ATT 3 di Orfeo, ma non
    # la GIT 1 di Patrizio — Danno 1, assorbito da uno dei 2 Muri.
    _set_bastion(dummy, "right", warrior_ids=["reinhold_1"], wall_ids=["joseph_2", "joseph_3"])
    dummy.life_cards = ["joseph_1", "joseph_4", "cardo_1"]
    dummy.turns_completed = 1


def _t6_setup_second_attack(state: GameState) -> None:
    # Un secondo attacco nello stesso turno: in partita non sarebbe possibile.
    state.battles_remaining = 1


TUTORIAL_BATTAGLIA = TutorialDef(
    tutorial_id="battaglia",
    title="La Battaglia",
    description="Attacca il Manichino: calcola il Danno, distruggi Muri e scopri quando si perde una Vita.",
    order=6,
    steps=[
        TutorialStep(
            "intro", "La Battaglia",
            "Siamo già nella fase di Battaglia, l'ultima del turno. Puoi attaccare una volta per turno, con i "
            "Guerrieri che hai in Avanscoperta.",
            highlight=["my-vanguard"], setup=_t6_setup_intro,
        ),
        TutorialStep(
            "adjacency", "Chi Puoi Attaccare",
            "Puoi attaccare solo i Bastioni avversari adiacenti ai tuoi: il tuo Bastione Destro confina con il "
            "Bastione Sinistro del giocatore alla tua destra, e viceversa. In due giocatori entrambi i Bastioni "
            "del Manichino sono adiacenti ai tuoi. Non puoi attaccare un giocatore che non abbia ancora giocato "
            "almeno un turno.",
            highlight=["top-opponents", "my-bastion-left", "my-bastion-right"],
        ),
        TutorialStep(
            "attack_values", "La Tua Forza d'Attacco",
            "Attacchi con l'ATT più alto e la GIT più alta tra tutti i tuoi Guerrieri in Avanscoperta, anche se "
            "sono di carte diverse: qui ATT 3 (da Orfeo) e GIT 1 (da Patrizio).",
            highlight=["my-vanguard"],
        ),
        TutorialStep(
            "damage", "Il Danno",
            "Il difensore usa la DIF e la GIT più alte tra i Guerrieri nel Bastione attaccato. Danno = (tuo ATT − "
            "sua DIF) + (tua GIT − sua GIT), dove ogni parte negativa vale 0. Ogni punto di Danno distrugge un "
            "Muro; se i Muri non bastano, il difensore perde una Vita. Una sola, anche se avanza altro Danno.",
            highlight=["my-vanguard", "top-opponents"],
        ),
        TutorialStep(
            "weak_intro", "Un Bastione Indifeso",
            "Il Bastione Sinistro del Manichino non ha difensori e ha 1 solo Muro. Danno = (3 − 0) + (1 − 0) = 4: "
            "il Muro cade e avanzano 3 danni. Vediamo quante Vite perde.",
            highlight=["top-opponents"],
        ),
        TutorialStep(
            "attack_weak", "Attacca il Bastione Sinistro",
            "Premi «Attacca» e scegli il Bastione Sinistro del Manichino.",
            highlight=["btn-battle", "top-opponents"],
            action="battle", match={"defender_player_index": 1, "defender_bastion_side": "left"},
            hint="Attacca il Bastione Sinistro (indifeso) del Manichino.",
        ),
        TutorialStep(
            "strong_intro", "Un Bastione Difeso",
            "Il Muro è caduto e il Manichino ha perso una sola Vita, nonostante i 3 danni in più. In partita "
            "potresti attaccare una sola volta per turno: qui ti regaliamo un secondo attacco. Il Bastione Destro "
            "è difeso da Reinhold (DIF 3, GIT 0) e ha 2 Muri. Danno = (3 − 3) + (1 − 0) = 1.",
            highlight=["top-opponents"], setup=_t6_setup_second_attack,
        ),
        TutorialStep(
            "attack_strong", "Attacca il Bastione Destro",
            "Premi «Attacca» e scegli il Bastione Destro del Manichino.",
            highlight=["btn-battle", "top-opponents"],
            action="battle", match={"defender_player_index": 1, "defender_bastion_side": "right"},
            hint="Attacca il Bastione Destro (difeso) del Manichino.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "La DIF di Reinhold ha fermato l'ATT, ma la tua GIT è passata: 1 Danno, 1 Muro distrutto e nessuna "
            "Vita persa, perché restava un altro Muro. Più Muri hai, più Danni assorbi prima di perdere Vite. "
            "Hai completato tutti i tutorial: sei pronto per una vera partita!",
            highlight=["top-opponents"],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Tutorial 4 — Maghe e Prodigi
# ---------------------------------------------------------------------------

def _t7_setup_intro(state: GameState) -> None:
    me = _human(state)
    _reset_field(me)
    # Evelyn è una Maga, ma di Scuola Sortilegio: basta per lanciare Ardolancio
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


def _t7_setup_add_araminta(state: GameState) -> None:
    me = _human(state)
    _set_vanguard(me, ["evelyn_1", "araminta_1"])
    _set_hand(me, ["ardolancio_2"])


def _t7_setup_active(state: GameState) -> None:
    # Un'Azione in più (regalata, e il testo lo dice) per lanciare Guerremoto.
    me = _human(state)
    _set_hand(me, ["guerremoto_1"])
    _set_resources(me, actions=1)


def _t7_setup_ethereal(state: GameState) -> None:
    # Velocemento richiede 3 Maghe: si aggiunge Madeleine. Nessun Mana e una
    # sola Azione, spesa per Velocemento: l'Estrattore si potrà giocare solo
    # perché diventa Etereo.
    me = _human(state)
    _set_vanguard(me, ["evelyn_1", "araminta_1", "madeleine_2"])
    _set_hand(me, ["velocemento_1", "estrattore_1"])
    _set_resources(me, mana=0, actions=1)


TUTORIAL_MAGIE = TutorialDef(
    tutorial_id="magie",
    title="Maghe e Prodigi",
    description="Lancia Magie in versione Base e Prodigio, scopri le Magie attive e le carte Eteree.",
    order=4,
    steps=[
        TutorialStep(
            "intro", "Le Maghe Richieste",
            "Le Magie non si pagano con il Mana: per lanciarle servono Maghe schierate in campo, che non vengono "
            "consumate. Hai Evelyn (Maga di Scuola Sortilegio) in Avanscoperta e due copie di Ardolancio "
            "(Anatema) in mano.",
            highlight=["my-vanguard", ">hand-cards"], setup=_t7_setup_intro,
        ),
        TutorialStep(
            "base_explain", "Effetto Base",
            "Ardolancio richiede 1 Maga di qualsiasi Scuola: Evelyn basta per lanciarlo, ma essendo di Scuola "
            "Sortilegio (non Anatema) NON attiva il Prodigio. Effetto Base: scarta fino a 2 Muri casuali. "
            "Lancialo contro il Bastione Sinistro, che ha esattamente 2 Muri.",
            highlight=[">hand-cards", "top-opponents"],
        ),
        TutorialStep(
            "cast_base", "Lancia il Primo Ardolancio",
            "Gioca il primo Ardolancio scegliendo come bersaglio il Bastione Sinistro del Manichino.",
            highlight=[">hand-cards", "top-opponents"],
            action="play_spell",
            match={"instance_id": "ardolancio_1", "target_player_id": "player_2", "target_bastion_side": "left"},
            hint="Gioca il primo Ardolancio contro il Bastione Sinistro del Manichino.",
        ),
        TutorialStep(
            "prodigio_explain", "Effetto Prodigio",
            "Fatto: il lancio Base ha scartato 2 Muri su 2! Ora aggiungiamo Araminta, Maga di Scuola Anatema: "
            "essendo proprio la Scuola di Ardolancio, il prossimo lancio attiverà il Prodigio, fino a 4 Muri "
            "invece di 2. Il Bastione Destro del Manichino ne ha esattamente 4.",
            highlight=["my-vanguard"], setup=_t7_setup_add_araminta,
        ),
        TutorialStep(
            "cast_prodigy", "Lancia il Secondo Ardolancio",
            "Gioca il secondo Ardolancio, questa volta in Prodigio, contro il Bastione Destro del Manichino.",
            highlight=[">hand-cards", "top-opponents"],
            action="play_spell",
            match={"instance_id": "ardolancio_2", "target_player_id": "player_2", "target_bastion_side": "right"},
            hint="Gioca il secondo Ardolancio (Prodigio) contro il Bastione Destro del Manichino.",
        ),
        TutorialStep(
            "active_intro", "Le Magie Attive",
            "Hai visto la differenza: il lancio Base ha scartato 2 Muri, il Prodigio 4! Quasi tutte le Magie "
            "hanno effetto subito, ma alcune restano attive per un po'. Guerremoto, per esempio: per questo turno "
            "puoi attaccare un Bastione qualsiasi, anche non adiacente. Ti regaliamo un'Azione per lanciarlo.",
            highlight=[">hand-cards"], setup=_t7_setup_active,
        ),
        TutorialStep(
            "cast_guerremoto", "Lancia Guerremoto",
            "Gioca Guerremoto dalla mano. Grazie ad Araminta (Anatema) attivi anche il Prodigio.",
            highlight=[">hand-cards"],
            action="play_spell", match={"instance_id": "guerremoto_1"},
            hint="Gioca Guerremoto dalla mano.",
        ),
        TutorialStep(
            "active_shown", "Dove Trovarle",
            "Le Magie ancora attive compaiono qui: toccale per rileggerne l'effetto e sapere quanto durano. "
            "Guerremoto resta attivo fino alla fine del turno.",
            highlight=["my-active-cards"],
        ),
        TutorialStep(
            "ethereal_intro", "Le Carte Eteree",
            "Alcune carte rendono Eterea un'altra carta in mano: una carta Eterea si gioca gratis, senza pagare "
            "Mana o Maghe e senza usare un'Azione. Velocemento rende Eterea una Costruzione e richiede 3 Maghe: "
            "ti diamo Madeleine e un'Azione per lanciarlo. Non hai Mana.",
            highlight=["my-vanguard", ">hand-cards"], setup=_t7_setup_ethereal,
        ),
        TutorialStep(
            "cast_velocemento", "Lancia Velocemento",
            "Gioca Velocemento dalla mano.",
            highlight=[">hand-cards"],
            action="play_spell", match={"instance_id": "velocemento_1"},
            hint="Gioca Velocemento dalla mano.",
        ),
        TutorialStep(
            "choose_ethereal", "Scegli la Costruzione",
            "Scegli l'Estrattore come Costruzione da rendere Eterea.",
            highlight=[">hand-cards"],
            action="resolve_velocemento", match={"building_instance_id": "estrattore_1"},
            hint="Scegli l'Estrattore come Costruzione da rendere Eterea.",
        ),
        TutorialStep(
            "play_ethereal", "Gioca la Carta Eterea",
            "L'Estrattore ora ha il bordo bianco: è Etereo e il suo costo è 0. Non hai né Mana né Azioni, eppure "
            "puoi giocarlo: fallo nel Villaggio.",
            highlight=[">hand-cards", "my-village"],
            action="play_building", match={"instance_id": "estrattore_1"},
            hint="Gioca l'Estrattore Etereo dalla mano nel Villaggio.",
        ),
        TutorialStep(
            "outro", "Ottimo lavoro!",
            "Una carta resta Eterea solo finché non usi un'Azione, dichiari Battaglia o finisci il turno: va "
            "giocata subito. Ricorda anche che il Prodigio si attiva quando in campo hai almeno tante Maghe della "
            "Scuola giusta quante ne richiede la Magia, e che le Magie vengono scartate dopo l'uso (salvo rare "
            "eccezioni). Prova ora «Schieramento e Orde».",
            highlight=[],
        ),
    ],
)


# ---------------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------------

TUTORIALS: Dict[str, TutorialDef] = {
    t.tutorial_id: t for t in [
        TUTORIAL_ANATOMIA_CARTA,
        TUTORIAL_CAMPO,
        TUTORIAL_TURNO,
        TUTORIAL_MAGIE,
        TUTORIAL_SCHIERAMENTO,
        TUTORIAL_BATTAGLIA,
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
        tutorial={"tutorial_id": tutorial_id, "step_index": 0, "completed": False, "snapshots": {}},
    )
    _apply_step_setup(state, tdef, 0)
    _save_snapshot(state, 0)
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
    if action in ("tutorial_next", "tutorial_prev", "leave_game"):
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
    # Dietro una mossa giocata non si torna: le istantanee precedenti non servono più.
    tut["snapshots"] = {}
    return _advance(state, tdef, after_action=True)


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


def _advance(state: GameState, tdef: TutorialDef, after_action: bool = False) -> dict:
    tut = state.tutorial
    tut["step_index"] += 1
    if tut["step_index"] >= len(tdef.steps):
        tut["completed"] = True
        return {"tutorial_completed": True}
    idx = tut["step_index"]
    _apply_step_setup(state, tdef, idx)
    if after_action or tdef.steps[idx].setup:
        _save_snapshot(state, idx)
    return {"tutorial_step": idx}


# ---------------------------------------------------------------------------
# Tornare indietro
# ---------------------------------------------------------------------------

def _save_snapshot(state: GameState, idx: int) -> None:
    state.tutorial.setdefault("snapshots", {})[str(idx)] = state.model_dump(mode="json", exclude={"tutorial"})


def _snapshot_for(tut: dict, idx: int) -> Optional[dict]:
    """Istantanea valida per lo step idx: la più recente salvata a un indice
    <= idx. Gli step tra quella e idx non hanno setup né mosse, quindi non
    hanno cambiato lo stato."""
    keys = [int(k) for k in (tut.get("snapshots") or {}) if int(k) <= idx]
    return tut["snapshots"][str(max(keys))] if keys else None


def can_go_back(state: GameState) -> bool:
    tut = state.tutorial
    if not tut or tut.get("completed"):
        return False
    tdef = get_tutorial(tut["tutorial_id"])
    idx = tut["step_index"]
    if tdef is None or idx <= 0 or idx >= len(tdef.steps):
        return False
    return tdef.steps[idx - 1].action is None and _snapshot_for(tut, idx - 1) is not None


def go_back(state: GameState) -> dict:
    """Gestisce l'azione "tutorial_prev" (bottone Indietro)."""
    if not can_go_back(state):
        raise ActionError("Non puoi tornare indietro da questo passo del tutorial.")
    tut = state.tutorial
    target = tut["step_index"] - 1
    restored = GameState.model_validate(_snapshot_for(tut, target))
    for name in GameState.model_fields:
        if name != "tutorial":
            setattr(state, name, getattr(restored, name))
    tut["snapshots"] = {k: v for k, v in tut["snapshots"].items() if int(k) <= target}
    tut["step_index"] = target
    return {"tutorial_step": target}


def public_view(state: GameState) -> Optional[dict]:
    """Stato del tutorial da mandare al client: senza istantanee, con can_go_back."""
    tut = state.tutorial
    if not tut:
        return None
    view = {k: v for k, v in tut.items() if k != "snapshots"}
    view["can_go_back"] = can_go_back(state)
    return view
