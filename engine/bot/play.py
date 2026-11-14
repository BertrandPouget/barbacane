"""
IA dei Bot di Barbacane.

Come ragiona: a ogni mossa il Bot prova su una copia dello stato le azioni
che può fare (giocare, evolvere, completare, murare, Magie con i bersagli
sensati, Arena), guarda una mossa più avanti, e tiene quella che porta alla
posizione migliore a fine turno. "Migliore" lo dice un modello appreso da
decine di migliaia di partite del Bot contro se stesso (eval.py, pesi in
weights.json, addestramento in bot_factory/): stima la probabilità di
vincere dalla posizione a fine turno, dopo aver scelto in aritmetica lo
Schieramento e la Battaglia migliori. Tutto in Python puro e leggero: una
copia dello stato e una piccola rete (32 neuroni) per ogni azione provata.

Tre livelli, con lo stesso cervello e limiti diversi (PROFILES):
- "easy":   guarda una sola azione alla volta, usa solo le Magie semplici
            e valuta in modo molto impreciso (rumore sul giudizio): gioca in
            modo sensato ma sbaglia spesso e in punti sempre diversi.
- "normal": pianifica due azioni insieme con un raggio di ricerca stretto,
            tutte le carte, giudizio leggermente impreciso.
- "hard":   ricerca larga, nessuna imprecisione, usa ogni risorsa (Arena,
            Cardo, Magiscudo in risposta).
L'imprecisione è rumore casuale sul valore delle mosse, non un difetto
fisso: nessun livello ripete sempre lo stesso errore.

Il Bot non bara: prima di cercare rimescola mazzo e mani avversarie nella
copia (non vede le carte coperte né le prossime pescate).

Se una sua Magia aspetta la risposta di un umano (Magiscudo, Malcomune) il
turno si ferma lì: run_bot_turn ritorna senza chiuderlo e alla chiamata
successiva riprende dal punto in cui era.
"""

from __future__ import annotations
import random
import time
from typing import Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel

from engine.models import GameState, Player, WallInstance, WarriorInstance
from engine.cards import CARD_REGISTRY, WarriorCard, SpellCard, BuildingCard
from engine.deck import get_base_card_id
from engine.actions import (
    ActionError,
    _faust_free_action,
    _joseph_free_action,
    _madeleine_free_action,
    activate_horde,
    add_wall,
    arena_activate,
    building_complete_error,
    complete_building,
    decimo_take_error,
    decimo_take_fossato,
    eracle_destroy,
    evolve_warrior,
    giulio_search,
    giulio_search_error,
    hand_play_error,
    play_building,
    play_spell,
    play_warrior,
    recast_spell,
    reposition_warrior,
    spell_prodigy_ready,
)
from engine.battle import adjacent_bastions, attacker_stats, get_valid_attack_targets
from engine.game import check_fucina_after_action, do_battle, end_turn
from engine.pending import (
    resolve_agilpesca,
    resolve_biblioteca,
    resolve_cardo_move,
    resolve_magiscudo_counter,
    resolve_malcomune,
    resolve_search,
    resolve_velocemento,
)
from engine.bot.eval import Ctx, Model, WIN, ZONES, default_model, style_vectors

ActionSpec = Tuple

# Tempo di riflessione per turno (la CPU del server è condivisa tra le
# partite). Oltre THINK_SECONDS il Bot smette di guardare una mossa più avanti;
# oltre STOP_SECONDS smette anche di provare altre azioni e chiude il turno con
# la migliore trovata. In condizioni normali un turno dura decimi di secondo.
THINK_SECONDS = 3.0
STOP_SECONDS = 6.0

# Magie che 'easy' sa usare: quelle senza bersagli da combinare
_SIMPLE_SPELLS = frozenset({
    "ardolancio_effect", "agilpesca_effect", "investimento_effect", "divinazione_effect",
    "magiscudo_effect", "incendifesa_effect", "guerremoto_effect", "vitalflusso_effect",
    "cercapersone_effect", "cambiamente_effect",
})


class Profile:
    """Limiti di un livello di difficoltà."""

    def __init__(self, depth: int, beam1: int, beam2: int, noise: float, layout_noise: float,
                 spells: Optional[frozenset] = None, extras: bool = True, counter: float = 1.0,
                 model: Optional[Model] = None, leaf_top: int = 3, deploy_top: int = 12,
                 style: Optional[Dict[str, float]] = None):
        self.depth = depth              # azioni pianificate insieme (1 o 2)
        self.beam1 = beam1              # prime azioni di cui si esplora il seguito
        self.beam2 = beam2              # seconde azioni provate per ognuna
        self.noise = noise              # imprecisione (in logit) sul valore di un'azione
        self.layout_noise = layout_noise  # imprecisione sullo Schieramento
        self.spells = spells            # Magie conosciute (None: tutte)
        self.extras = extras            # usa Arena e Cardo+Decumano
        self.counter = counter          # probabilità di rispondere con Magiscudo
        self.leaf_top = leaf_top        # Schieramenti giudicati per ogni posizione provata
        self.deploy_top = deploy_top    # Schieramenti giudicati allo Schieramento vero
        self.style = style_vectors(style) if style else None  # preferenze aggiunte al giudizio (solo train.py)
        self._model = model

    @property
    def model(self) -> Model:
        return self._model or default_model()

    def layout_noise_fn(self) -> Optional[Callable[[], float]]:
        if self.layout_noise <= 0:
            return None
        sigma = self.layout_noise
        return lambda: random.gauss(0.0, sigma)


PROFILES: Dict[str, Profile] = {
    "easy": Profile(depth=1, beam1=0, beam2=0, noise=1.8, layout_noise=0.9,
                    spells=_SIMPLE_SPELLS, extras=False, counter=0.3),
    "normal": Profile(depth=2, beam1=3, beam2=4, noise=0.5, layout_noise=0.25, counter=0.7),
    "hard": Profile(depth=2, beam1=8, beam2=8, noise=0.0, layout_noise=0.0),
}
# Taratura (bot_factory/train.py arena, 330 partite a 2): hard batte normal ~2 volte su
# 3, normal batte easy ~5 su 6, easy batte 'random' (mosse utili a caso) ~2 su 3.
# Dopo un riaddestramento vanno rimisurati: il rumore è in logit del modello.
# Partite salvate prima del passaggio da 4 a 3 livelli
_LEGACY_DIFFICULTY = {"expert": "hard"}

# Solo per bot_factory/train.py: profilo per singolo giocatore e registrazione delle
# posizioni di fine turno (addestramento).
PLAYER_PROFILES: Dict[str, Profile] = {}
RECORDER: Optional[Callable[[GameState, int], None]] = None


def _profile(state: GameState, player_id: str, difficulty=None) -> Profile:
    if player_id in PLAYER_PROFILES:
        return PLAYER_PROFILES[player_id]
    name = difficulty or state.bot_difficulty
    return PROFILES.get(_LEGACY_DIFFICULTY.get(name, name), PROFILES["normal"])


# ---------------------------------------------------------------------------
# Turno
# ---------------------------------------------------------------------------

def run_bot_turn(state: GameState, difficulty="normal", on_step=None) -> None:
    """Gioca (o riprende) il turno del giocatore corrente, che deve essere un
    Bot. `on_step` viene chiamata dopo ogni mossa sullo stato reale: serve a
    mostrare al tavolo il turno un passo alla volta. Ritorna senza chiudere il
    turno solo se resta in attesa della risposta di un umano."""
    step = on_step or (lambda: None)
    idx = state.current_player_index
    player = state.players[idx]
    pid = player.id
    prof = _profile(state, pid, difficulty)
    deadline = time.monotonic() + THINK_SECONDS

    if not settle_pending(state) or state.winner_id or state.current_player.id != pid:
        return
    _use_horde_buttons(state, pid)
    if not settle_pending(state):
        return
    step()

    banned: set = set()
    for _ in range(14):
        if time.monotonic() > deadline + STOP_SECONDS - THINK_SECONDS:
            break
        spec = _choose_step(state, idx, prof, deadline, banned)
        if spec is None:
            break
        try:
            _apply_spec(state, pid, spec)
        except ActionError:
            banned.add(spec)
            continue
        check_fucina_after_action(state, player)
        step()
        if not settle_pending(state) or state.winner_id:
            return

    _deploy(state, idx, prof)
    step()
    _battle(state, idx, prof)
    step()
    if state.winner_id:
        return
    if RECORDER is not None:
        RECORDER(state, idx)
    end_turn(state)
    settle_pending(state)  # Cardo + Decumano: lo spostamento chiude il turno


def waiting_for_human(state: GameState) -> bool:
    """True se una ricerca o un'interazione in sospeso tocca a un umano: il
    turno del Bot non può proseguire finché non risponde."""
    owner = _pending_owner(state)
    return owner is not None and not state.is_bot(owner)


def _pending_owner(state: GameState) -> Optional[str]:
    if state.pending_search:
        return state.pending_search.get("player_id")
    if state.current_player.pending_velocemento_buildings:
        return state.current_player.id
    if state.pending_interactions:
        return state.pending_interactions[0].get("player_id")
    return None


# ---------------------------------------------------------------------------
# Copie di simulazione
# ---------------------------------------------------------------------------

_SIM_SKIP = ("chronicle", "recent_events", "match_stats", "eliminations")


_ATOMS = (str, int, bool, float, type(None), tuple)


def _clone(obj):
    """Copia profonda dei modelli del motore, molto più rapida di
    model_copy(deep=True): niente memo, niente validazione."""
    t = type(obj)
    if t in _ATOMS:
        return obj
    if t is list:
        if not obj:
            return []
        # id di carte e Muri (mai modificati dopo la creazione): basta la lista
        first = type(obj[0])
        if first is str or first is WallInstance:
            return obj[:]
        return [_clone(x) for x in obj]
    if t is dict:
        return {k: (v if type(v) in _ATOMS else _clone(v)) for k, v in obj.items()} if obj else {}
    if isinstance(obj, BaseModel):
        d = obj.__dict__
        nd = d.copy()
        for k, v in d.items():
            if type(v) not in _ATOMS:
                nd[k] = _clone(v)
        new = t.__new__(t)
        object.__setattr__(new, "__dict__", nd)
        object.__setattr__(new, "__pydantic_fields_set__", obj.__pydantic_fields_set__)
        object.__setattr__(new, "__pydantic_extra__", None)
        object.__setattr__(new, "__pydantic_private__", None)
        return new
    if t is set:
        return set(obj)
    raise TypeError(f"_clone: tipo non previsto {t}")


def _sim_copy(state: GameState) -> GameState:
    """Copia per la simulazione, senza cronaca né eventi. Il log è sostituito
    da segnaposto della stessa lunghezza: open_wall_slots ne usa solo la
    lunghezza, e copiarlo a ogni mossa dominerebbe il costo della ricerca."""
    new = GameState.__new__(GameState)
    d = {}
    for k, v in state.__dict__.items():
        if k == "log":
            d[k] = [None] * len(v)
        elif k in _SIM_SKIP:
            d[k] = type(v)()
        else:
            d[k] = _clone(v)
    object.__setattr__(new, "__dict__", d)
    object.__setattr__(new, "__pydantic_fields_set__", state.__pydantic_fields_set__)
    object.__setattr__(new, "__pydantic_extra__", None)
    object.__setattr__(new, "__pydantic_private__", None)
    return new


def _determinize(state: GameState, me_idx: int) -> GameState:
    """Copia in cui le carte che il Bot non vede (mazzo e mani avversarie)
    sono rimescolate tra loro: la ricerca non può sbirciare."""
    sim = _sim_copy(state)
    others = [p for i, p in enumerate(sim.players) if i != me_idx]
    pool = list(sim.deck)
    for p in others:
        pool += p.hand
    random.shuffle(pool)
    for p in others:
        n = len(p.hand)
        p.hand, pool = pool[:n], pool[n:]
    sim.deck = pool
    return sim


# ---------------------------------------------------------------------------
# Scelta dell'azione
# ---------------------------------------------------------------------------

def _leaf(sim: GameState, me_idx: int, prof: Profile, memo: dict) -> Tuple[float, Optional[Ctx]]:
    """Valore della posizione se il turno finisse qui: i migliori Schieramenti
    (con la loro Battaglia), poi il giudizio del modello. `memo`: conti già
    fatti in questa ricerca (molte posizioni provate hanno lo stesso campo)."""
    if sim.winner_id:
        return (WIN if sim.winner_id == sim.players[me_idx].id else -WIN), None
    ctx = Ctx(sim, me_idx, prof.model, memo)
    key = ctx.layout_key()
    candidates = memo.get(key)
    if candidates is None:
        candidates = memo[key] = ctx.layouts(prof.leaf_top)
    return ctx.judge(candidates, style=prof.style)[0], ctx


def _try(sim: GameState, pid: str, spec: ActionSpec) -> bool:
    try:
        _apply_spec(sim, pid, spec)
    except ActionError:
        return False
    settle_pending(sim, everyone=True)
    return True


def _choose_step(state: GameState, me_idx: int, prof: Profile, deadline: float, banned: set) -> Optional[ActionSpec]:
    """Prossima azione da giocare, o None se conviene fermarsi. Prova ogni
    azione su una copia; con depth 2 esplora anche il seguito delle più
    promettenti, perché la coppia migliore non è sempre fatta dalle due
    azioni migliori prese da sole (Recluta + Evoluzione, Mana + carta cara)."""
    pid = state.players[me_idx].id
    root = _determinize(state, me_idx)
    memo: dict = {}
    stop_value, ctx = _leaf(root, me_idx, prof, memo)
    cands = [c for c in _candidates(root, me_idx, prof, ctx) if c not in banned]
    if not cands:
        return None

    first = []
    stop = deadline + STOP_SECONDS - THINK_SECONDS
    for spec in cands:
        if first and time.monotonic() > stop:
            break
        sim = _sim_copy(root)
        if _try(sim, pid, spec):
            value, sctx = _leaf(sim, me_idx, prof, memo)
            first.append([value, spec, sim, sctx])
    if not first:
        return None
    first.sort(key=lambda e: e[0], reverse=True)

    if prof.depth >= 2 and first[0][0] < WIN:
        root_value = {e[1]: e[0] for e in first}
        for entry in first[:prof.beam1]:
            if time.monotonic() > deadline:
                break
            _, spec, sim, sctx = entry
            if sctx is None or sim.current_player_index != me_idx:
                continue
            children = [c for c in _candidates(sim, me_idx, prof, sctx) if c not in banned]
            # prima le azioni che la prima ha reso possibili, poi le migliori da sole
            children.sort(key=lambda c: root_value.get(c, WIN), reverse=True)
            for child in children[:prof.beam2]:
                sim2 = _sim_copy(sim)
                if _try(sim2, pid, child):
                    value = _leaf(sim2, me_idx, prof, memo)[0]
                    if value > entry[0]:
                        entry[0] = value

    # Solo le azioni che migliorano davvero la posizione: l'imprecisione dei
    # livelli facili sceglie male TRA le mosse utili, non fa passare il turno.
    useful = [e for e in first if e[0] > stop_value + 1e-9]
    if not useful:
        return None
    if prof.noise > 0:
        return max(useful, key=lambda e: e[0] + random.gauss(0.0, prof.noise))[1]
    return max(useful, key=lambda e: e[0])[1]


# ---------------------------------------------------------------------------
# Azioni candidate
# ---------------------------------------------------------------------------

def _is_free(player: Player, spec: ActionSpec) -> bool:
    """True se lo spec non consuma Azioni (carta Eterea, Orde di Madeleine,
    Faust e Joseph, Cardo con Decumano, Arena)."""
    kind = spec[0]
    if kind == "arena":
        return True
    if kind in ("warrior", "spell", "building") and player.ethereal_card == spec[1]:
        return True
    if kind == "spell":
        return _madeleine_free_action(player, CARD_REGISTRY[get_base_card_id(spec[1])])
    if kind == "building":
        return _faust_free_action(player)
    if kind == "complete":
        if player.ethereal_complete == spec[1] or _joseph_free_action(player):
            return True
        return get_base_card_id(spec[1]) == "cardo" and any(
            b.base_card_id == "decumano" for b in player.field.village.buildings)
    return False


def _candidates(state: GameState, me_idx: int, prof: Profile, ctx: Ctx) -> List[ActionSpec]:
    """Azioni tentabili ora, come "spec" indipendenti dallo stato (si
    applicano tali e quali allo stato reale o a una copia)."""
    p = state.players[me_idx]
    acts = p.actions_remaining
    out: List[ActionSpec] = []

    def add(spec: ActionSpec) -> None:
        if acts > 0 or _is_free(p, spec):
            out.append(spec)

    on_board = {}
    for w in p.all_warriors():
        on_board.setdefault(w.base_card_id, w)
    seen = set()
    for iid in p.hand:
        base = get_base_card_id(iid)
        if base in seen and p.ethereal_card != iid:
            continue
        seen.add(base)
        card = CARD_REGISTRY[base]
        if isinstance(card, WarriorCard):
            if card.subtype == "hero":
                recruit = on_board.get(card.evolves_from)
                if recruit is not None and p.mana_remaining >= card.cost:
                    add(("evolve", recruit.instance_id, iid))
            elif hand_play_error(state, p, iid) is None:
                add(("warrior", iid))
        elif isinstance(card, BuildingCard):
            if hand_play_error(state, p, iid) is None:
                if base == "trono":
                    for target in _trono_targets(p)[:2]:
                        add(("building", iid, target))
                else:
                    add(("building", iid, None))
        elif isinstance(card, SpellCard):
            if prof.spells is not None and card.effect_id not in prof.spells:
                continue
            spec0 = ("spell", iid, ())
            if not (acts > 0 or _is_free(p, spec0)) or hand_play_error(state, p, iid) is not None:
                continue
            for kwargs in _spell_options(state, me_idx, card, spell_prodigy_ready(p, iid), ctx)[:6]:
                out.append(("spell", iid, tuple(sorted(kwargs.items()))))

    done = set()
    for b in p.field.village.buildings:
        if not b.completed and b.base_card_id not in done and building_complete_error(p, b.instance_id) is None:
            done.add(b.base_card_id)
            out.append(("complete", b.instance_id))

    if acts > 0 and p.hand:
        out += _wall_specs(p, ctx)
    if prof.extras:
        out += _arena_specs(state, me_idx)
    return out


def _wall_specs(p: Player, ctx: Ctx) -> List[ActionSpec]:
    """Muri: le carte che vale meno tenere, sul Bastione più sguarnito,
    sull'altro, o divise."""
    cards = sorted(p.hand, key=lambda iid: ctx.hand_value(get_base_card_id(iid)))[:3]
    wl, wr = len(p.field.bastion_left.walls), len(p.field.bastion_right.walls)
    weak, other = ("left", "right") if wl <= wr else ("right", "left")
    specs = [("walls", tuple((iid, weak) for iid in cards)),
             ("walls", tuple((iid, other) for iid in cards))]
    if len(cards) >= 2:
        specs.append(("walls", tuple((iid, weak if k < len(cards) - 1 else other) for k, iid in enumerate(cards))))
        specs.append(("walls", tuple((iid, other if k < len(cards) - 1 else weak) for k, iid in enumerate(cards))))
        # meno Muri, per tenere in mano le carte buone per i prossimi turni
        specs.append(("walls", ((cards[0], weak),)))
        if len(cards) >= 3:
            specs.append(("walls", tuple((iid, weak) for iid in cards[:2])))
    return specs


def _trono_targets(p: Player) -> List[str]:
    """Guerrieri a cui dare il Trono (rende sempre attivo il loro effetto
    Orda): senza già un Trono, i più forti per primi."""
    taken = {b.assigned_warrior for b in p.field.village.buildings if b.base_card_id == "trono"}
    ws = [w for w in p.all_warriors()
          if w.instance_id not in taken and CARD_REGISTRY[w.base_card_id].horde_effect_id]
    ws.sort(key=_unit_value, reverse=True)
    return [w.instance_id for w in ws]


def _unit_value(w: WarriorInstance) -> float:
    return (w.effective_att() + w.effective_git() + w.effective_dif()
            + (3 if CARD_REGISTRY[w.base_card_id].subtype == "hero" else 0))


def _arena_specs(state: GameState, me_idx: int) -> List[ActionSpec]:
    """Arena: sacrifica il proprio Guerriero più debole per scartare il più
    forte tra quelli avversari con una Caratteristica più bassa."""
    p = state.players[me_idx]
    used = {e.get("building_instance_id") for e in p.active_effects if e.get("type") == "arena_used"}
    arena = next((b for b in p.field.village.buildings
                  if b.base_card_id == "arena" and b.instance_id not in used), None)
    mine = [w for w in p.all_warriors() if not w.horde_active]
    if arena is None or not mine:
        return []
    own = min(mine, key=_unit_value)
    own_stats = (own.effective_att(), own.effective_git(), own.effective_dif())
    specs = []
    for o in state.players:
        if o.id == p.id or not o.is_alive:
            continue
        eligible = [w for w in o.all_warriors()
                    if any(t < s for t, s in zip((w.effective_att(), w.effective_git(), w.effective_dif()), own_stats))]
        if eligible:
            target = max(eligible, key=_unit_value)
            if _unit_value(target) > _unit_value(own):
                specs.append(("arena", arena.instance_id, own.instance_id, target.instance_id, o.id))
    return specs


def _spell_options(state: GameState, me_idx: int, card: SpellCard, prodigy: bool, ctx: Ctx) -> List[dict]:
    """Bersagli sensati per una Magia: pochi insiemi di parametri, tra cui
    sceglie la simulazione. Lista vuota: ora la Magia non serve a nulla."""
    me = state.players[me_idx]
    eff = card.effect_id
    adj = adjacent_bastions(me_idx, state.players)
    near = {adj["left_attacks"][0], adj["right_attacks"][0]}
    opps = [o for i, o in sorted(enumerate(state.players), key=lambda t: t[0] not in near)
            if i != me_idx and o.is_alive]
    open_opps = [o for o in opps if not any(e.get("type") == "spell_immune" for e in o.active_effects)]
    mine = me.all_warriors()

    def bastion(player: Player, side: str):
        return player.field.bastion_left if side == "left" else player.field.bastion_right

    if eff in ("ardolancio_effect", "incendifesa_effect"):
        out = []
        for o in open_opps[:2]:
            in_bastions = len(o.field.bastion_left.warriors) + len(o.field.bastion_right.warriors)
            for side in ("left", "right"):
                b = bastion(o, side)
                if not b.walls:
                    continue
                if eff == "incendifesa_effect" and not (in_bastions if prodigy else b.warriors):
                    continue
                out.append({"target_player_id": o.id, "target_bastion_side": side})
        return out

    if eff == "magiscudo_effect":
        return [] if ctx.me.immune else [{}]
    if eff == "guerremoto_effect":
        return [{}] if mine and state.battles_remaining > 0 else []
    if eff == "dazipazzi_effect":
        kinds = ("scrigno", "estrattore") if prodigy else ("scrigno",)
        hit = any(b.completed and b.base_card_id in kinds for o in open_opps for b in o.field.village.buildings)
        return [{}] if hit else []
    if eff == "cercapersone_effect":
        has = any(getattr(CARD_REGISTRY[get_base_card_id(i)], "subtype", None) == "recruit" for i in state.deck)
        return [{}] if has else []
    if eff in ("vitalflusso_effect", "agilpesca_effect", "investimento_effect",
               "divinazione_effect", "velocemento_effect"):
        return [{}]

    if eff == "equipotenza_effect":
        if not mine:
            return []
        own = sorted(mine, key=lambda w: abs(w.effective_att() - w.effective_dif()), reverse=True)[:2]
        if not prodigy:
            return [{"own_warrior_iid": w.instance_id} for w in own if w.effective_att() != w.effective_dif()]
        foes = sorted((w for o in open_opps for w in o.all_warriors()),
                      key=lambda w: abs(w.effective_att() - w.effective_dif()), reverse=True)[:2]
        out = [{"own_warrior_iid": w.instance_id, "enemy_warrior_iid": f.instance_id} for w in own[:1] for f in foes]
        return out or [{"own_warrior_iid": own[0].instance_id}]

    if eff == "regicidio_effect":
        return [{"target_player_id": o.id, "target_trono_iid": b.instance_id}
                for o in open_opps for b in o.field.village.buildings if b.base_card_id == "trono"]

    if eff == "arrampicarta_effect":
        if not mine:
            return []
        side = "left" if len(me.field.bastion_left.walls) >= len(me.field.bastion_right.walls) else "right"
        walls = bastion(me, side).walls
        if not walls:
            return []
        wall = min(walls, key=lambda w: ctx.hand_value(w.base_card_id))
        picks = {max(mine, key=lambda w: w.effective_git()).instance_id,
                 max(mine, key=lambda w: w.effective_att()).instance_id}
        return [{"wall_instance_id": wall.instance_id, "warrior_iid": iid, "bastion_side": side} for iid in picks]

    if eff == "cuordipietra_effect":
        out = []
        for o in open_opps[:2]:
            foes = [w for w in o.all_warriors()
                    if prodigy or CARD_REGISTRY[w.base_card_id].subtype == "recruit"]
            for w in sorted(foes, key=_unit_value, reverse=True)[:2]:
                if prodigy:
                    side = "left" if len(me.field.bastion_left.walls) <= len(me.field.bastion_right.walls) else "right"
                    out.append({"target_player_id": o.id, "target_warrior_iid": w.instance_id, "dest_bastion_side": side})
                else:
                    for side in ("left", "right"):
                        out.append({"target_player_id": o.id, "target_warrior_iid": w.instance_id,
                                    "dest_bastion_side": side})
        return out

    if eff == "bastioncontrario_effect":
        out = []
        for pl in [me] + open_opps:
            if len(pl.field.bastion_left.walls) != len(pl.field.bastion_right.walls):
                out.append({"player1_id": pl.id, "side1": "left", "player2_id": pl.id, "side2": "right"})
        if prodigy:
            mine_side = "left" if len(me.field.bastion_left.walls) <= len(me.field.bastion_right.walls) else "right"
            for o in open_opps:
                their = "left" if len(o.field.bastion_left.walls) >= len(o.field.bastion_right.walls) else "right"
                if len(bastion(o, their).walls) > len(bastion(me, mine_side).walls):
                    out.insert(0, {"player1_id": me.id, "side1": mine_side, "player2_id": o.id, "side2": their})
        return out

    if eff == "malcomune_effect":
        out = []
        for species in {CARD_REGISTRY[w.base_card_id].species for w in mine}:
            if not any(CARD_REGISTRY[w.base_card_id].species == species for o in open_opps for w in o.all_warriors()):
                continue
            own = min((w for w in mine if CARD_REGISTRY[w.base_card_id].species == species), key=_unit_value)
            out.append({"own_warrior_iid": own.instance_id})
        return out

    if eff == "telecinesi_effect":
        out = []
        if prodigy:  # ruba Muri al Bastione avversario adiacente
            for (o_idx, o_side), my_side in ((adj["right_attacks"], "right"), (adj["left_attacks"], "left")):
                o = state.players[o_idx]
                if o_idx != me_idx and o in open_opps and bastion(o, o_side).walls:
                    out.append({"source_player_id": o.id, "source_side": o_side,
                                "dest_player_id": me.id, "dest_side": my_side, "count": 3})
        for src, dst in (("left", "right"), ("right", "left")):
            if len(bastion(me, src).walls) > len(bastion(me, dst).walls):
                out.append({"source_player_id": me.id, "source_side": src,
                            "dest_player_id": me.id, "dest_side": dst, "count": 3})
        return out

    if eff in ("plasmattone_effect", "plasmarmo_effect"):
        out = []
        for side in ("left", "right"):
            walls = bastion(me, side).walls
            if walls:
                kwargs = {"bastion_side": side}
                if prodigy or eff == "plasmarmo_effect":
                    kwargs["wall_instance_id"] = max(walls, key=lambda w: ctx.hand_value(w.base_card_id)).instance_id
                out.append(kwargs)
        return out

    if eff == "cambiamente_effect":
        return [{"target_player_id": o.id, "target_warrior_iid": w.instance_id}
                for o in open_opps[:2] for w in sorted(o.all_warriors(), key=_unit_value, reverse=True)[:2]]

    return []


def _apply_spec(state: GameState, pid: str, spec: ActionSpec) -> None:
    """Esegue uno spec sullo stato dato (reale o copia). Propaga ActionError."""
    p = state.get_player(pid)
    kind = spec[0]
    # Stessa regola delle route: l'Eterea decade se si fa un'altra Azione
    if kind != "arena":
        playing = spec[1] if kind in ("warrior", "spell", "building") else None
        if p.ethereal_card and playing != p.ethereal_card:
            p.ethereal_card = None
        if p.ethereal_complete and not (kind in ("complete", "building") and spec[1] == p.ethereal_complete):
            p.ethereal_complete = None

    if kind == "warrior":
        card = CARD_REGISTRY[get_base_card_id(spec[1])]
        if card.att + card.git > card.dif:
            region = "vanguard"
        else:
            f = p.field
            region = "bastion_left" if len(f.bastion_left.warriors) <= len(f.bastion_right.warriors) else "bastion_right"
        play_warrior(state, pid, spec[1], region)
    elif kind == "evolve":
        evolve_warrior(state, pid, spec[1], spec[2])
    elif kind == "building":
        play_building(state, pid, spec[1], spec[2])
    elif kind == "complete":
        complete_building(state, pid, spec[1])
    elif kind == "spell":
        play_spell(state, pid, spec[1], **dict(spec[2]))
    elif kind == "walls":
        add_wall(state, pid, [{"instance_id": iid, "bastion": side} for iid, side in spec[1]])
    elif kind == "arena":
        arena_activate(state, pid, spec[1], spec[2], spec[3], spec[4])
    else:
        raise ValueError(f"spec sconosciuto: {kind}")


# ---------------------------------------------------------------------------
# Schieramento, Orde, Battaglia
# ---------------------------------------------------------------------------

def _deploy(state: GameState, idx: int, prof: Profile) -> None:
    """Schiera i Guerrieri e attiva le Orde secondo Ctx.layouts e Ctx.judge: la
    disposizione resta fino al prossimo turno, quindi la stessa scelta decide
    l'attacco di ora e la difesa di dopo."""
    p = state.players[idx]
    p.ethereal_card = None
    p.ethereal_complete = None
    if not p.all_warriors():
        return
    ctx = Ctx(state, idx, prof.model)
    _, plan = ctx.judge(ctx.layouts(prof.deploy_top), prof.layout_noise_fn(), prof.style)
    current = {u.iid: u.zone for u in ctx.me.units}
    for iid, zone in plan.zones.items():
        if current.get(iid) != zone:
            try:
                reposition_warrior(state, p.id, iid, ZONES[zone])
            except ActionError:
                pass
    by_iid = {w.instance_id: w for w in p.all_warriors()}
    for zone, species, iid, _ in plan.hordes:
        w = by_iid.get(iid)
        if w is None or (w.horde_active and f"{ZONES[zone]}:{species}" in p.hordes_activated_this_turn):
            continue
        try:
            activate_horde(state, p.id, w.base_card_id, iid, zone=ZONES[zone])
        except ActionError:
            pass
    # Orde formate senza volerlo: un effetto in più non costa nulla
    flag = prof.model.flag
    for horde in p.check_horde_with_zones():
        if f"{horde['zone']}:{horde['species']}" in p.hordes_activated_this_turn:
            continue
        ws = [w for w in horde["warriors"]
              if CARD_REGISTRY[w.base_card_id].horde_effect_id and not p.has_active_trono(w.instance_id)]
        if ws:
            w = max(ws, key=lambda w: flag[CARD_REGISTRY[w.base_card_id].horde_effect_id])
            try:
                activate_horde(state, p.id, w.base_card_id, w.instance_id, zone=horde["zone"])
            except ActionError:
                pass


def _battle(state: GameState, idx: int, prof: Profile) -> None:
    p = state.players[idx]
    if state.battles_remaining <= 0 or not p.field.vanguard:
        return
    ctx = Ctx(state, idx, prof.model)
    att, git = attacker_stats(p)
    target = ctx._attack(att, git)[1]
    if target is None or target not in get_valid_attack_targets(state):
        return
    try:
        result = do_battle(state, p.id, target[0], target[1])
    except ActionError:
        return
    if result.get("eracle_destroy_triggered") and not state.winner_id:
        defender = state.players[target[0]]
        building = ctx.best_eracle_target(defender)
        if building:
            try:
                eracle_destroy(state, p.id, building, defender.id)
            except ActionError:
                pass


def _use_horde_buttons(state: GameState, pid: str) -> None:
    """Effetti Orda a pulsante, solo prima dello Schieramento e prima delle
    Azioni (Giulio II appena preso si può già giocare). Decimo: toglie agli
    avversari i Fossati, i completi per primi, e li mette nel Bastione con
    meno Muri. Giulio: la ricerca la chiude settle_pending."""
    p = state.get_player(pid)
    for _ in range(4):
        if decimo_take_error(state, p) is not None:
            break
        fossati = [(b, o) for o in state.players if o.id != pid and o.is_alive
                   for b in o.field.village.buildings if b.base_card_id == "fossato"]
        if not fossati:
            break
        building, owner = max(fossati, key=lambda item: item[0].completed)
        side = "left" if len(p.field.bastion_left.walls) <= len(p.field.bastion_right.walls) else "right"
        decimo_take_fossato(state, pid, building.instance_id, owner.id, side)
    for _ in range(4):
        if giulio_search_error(state, p) is not None or state.pending_search:
            break
        giulio_search(state, pid)
        if not settle_pending(state):
            break


# ---------------------------------------------------------------------------
# Scelte in sospeso (ricerche, scarti, risposte)
# ---------------------------------------------------------------------------

def settle_pending(state: GameState, everyone: bool = False) -> bool:
    """Chiude le ricerche e le interazioni in sospeso che toccano a un Bot
    (a tutti, con `everyone`: nelle simulazioni). Ritorna False se la prossima
    tocca a un umano: bisogna aspettarlo."""
    for _ in range(40):
        if state.winner_id:
            return True
        owner = _pending_owner(state)
        if owner is None:
            return True
        if not (everyone or state.is_bot(owner)):
            return False
        player = state.get_player(owner)
        try:
            if state.pending_search:
                resolve_search(state, owner, _pick_search(state, player))
            elif state.current_player.pending_velocemento_buildings:
                # la Costruzione più cara: è quella su cui l'Eterea fa risparmiare di più
                best = max(player.pending_velocemento_buildings, key=lambda iid: (
                    CARD_REGISTRY[get_base_card_id(iid)].cost + CARD_REGISTRY[get_base_card_id(iid)].completion_cost))
                resolve_velocemento(state, owner, {"building_instance_id": best})
            else:
                _settle_interaction(state, player, state.pending_interactions[0], everyone)
        except ActionError:
            # Scelta non più valida: l'interazione si chiude senza effetto
            if state.pending_search:
                resolve_search(state, owner, None)
            elif state.current_player.pending_velocemento_buildings:
                state.current_player.pending_velocemento_buildings = []
            elif state.pending_interactions:
                state.pending_interactions.pop(0)
    return True


def _settle_interaction(state: GameState, player: Player, pending: dict, sim: bool) -> None:
    kind = pending.get("type")
    pid = player.id
    idx = state.players.index(player)
    prof = _profile(state, pid)

    if kind in ("biblioteca_discard", "agilpesca_discard", "biblioteca_wall"):
        if not player.hand:
            if kind == "agilpesca_discard":
                state.pending_interactions.pop(0)
            else:
                resolve_biblioteca(state, pid, {})
            return
        ctx = Ctx(state, idx, prof.model)
        iid = min(player.hand, key=lambda i: ctx.hand_value(get_base_card_id(i)))
        if kind == "agilpesca_discard":
            resolve_agilpesca(state, pid, {"discard_iid": iid})
        elif kind == "biblioteca_discard":
            resolve_biblioteca(state, pid, {"discard_iid": iid})
        else:
            f = player.field
            side = "left" if len(f.bastion_left.walls) <= len(f.bastion_right.walls) else "right"
            resolve_biblioteca(state, pid, {"wall_card_iid": iid, "wall_bastion_side": side})
    elif kind == "cardo_move":
        move = Ctx(state, idx, prof.model).best_single_move() if prof.extras else None
        params = {"warrior_iid": move[0], "destination": ZONES[move[1]]} if move else {}
        resolve_cardo_move(state, pid, params)
    elif kind == "magiscudo_counter":
        accept = not sim and _spell_hurts(state, player, pending) and random.random() < prof.counter
        resolve_magiscudo_counter(state, pid, {"accept": accept})
    elif kind == "malcomune_discard":
        species = pending.get("species")
        ws = [w for w in player.all_warriors() if CARD_REGISTRY[w.base_card_id].species == species]
        if ws:
            resolve_malcomune(state, pid, {"warrior_iid": min(ws, key=_unit_value).instance_id})
        else:
            state.pending_interactions.pop(0)
    elif kind == "evelyn_recast":
        card = CARD_REGISTRY[pending["base_card_id"]]
        ctx = Ctx(state, idx, prof.model)
        options = _spell_options(state, idx, card, True, ctx)
        if options:
            recast_spell(state, pid, card.id, **options[0])
        else:
            recast_spell(state, pid, card.id, skip=True)
    else:
        state.pending_interactions.pop(0)


def _spell_hurts(state: GameState, player: Player, pending: dict) -> bool:
    """Vale la pena spendere Magiscudo contro questa Magia? No se toglie
    Muri a un Bastione che non ne ha."""
    if pending.get("effect_id") in ("ardolancio_effect", "incendifesa_effect"):
        side = (pending.get("kwargs") or {}).get("target_bastion_side", "left")
        bastion = player.field.bastion_left if side == "left" else player.field.bastion_right
        return len(bastion.walls) >= 2
    return True


def _pick_search(state: GameState, player: Player) -> Optional[str]:
    """Carta da prendere con una ricerca nel mazzo (None: nessuna adatta)."""
    ps = state.pending_search
    cond = ps["condition"]
    if cond.get("type") == "base_card_id":
        return next((i for i in state.deck if get_base_card_id(i) == cond.get("value")), None)

    recruits = {}
    for iid in state.deck:
        base = get_base_card_id(iid)
        card = CARD_REGISTRY[base]
        if isinstance(card, WarriorCard) and card.subtype == cond.get("value"):
            recruits.setdefault(base, iid)
    if not recruits:
        return None
    hand = [CARD_REGISTRY[get_base_card_id(i)] for i in player.hand]
    field = [CARD_REGISTRY[w.base_card_id] for w in player.all_warriors()]
    ethereal = ps.get("context") == "cercapersone_prodigio"
    mana_next = state.mana_for_turn(state.turn + 1)

    def score(base: str) -> float:
        card = CARD_REGISTRY[base]
        s = (card.att + card.git + card.dif) * 0.3
        if any(isinstance(c, WarriorCard) and c.evolves_from == base for c in hand) \
                and not any(c.id == base for c in field):
            s += 4.0  # sblocca un Eroe che ho in mano
        if card.species == "maga" and not any(c.species == "maga" for c in field) \
                and any(isinstance(c, SpellCard) for c in hand):
            s += 3.0  # sblocca le Magie che ho in mano
        if sum(1 for c in field if c.species == card.species) == 2:
            s += 2.0  # completa un'Orda
        if ethereal:
            s += card.cost  # gratis: meglio la più cara
        elif card.cost > mana_next:
            s -= 3.0
        return s

    return recruits[max(recruits, key=score)]
