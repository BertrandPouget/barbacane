"""
Valutazione delle posizioni per i Bot (play.py).

Il Bot non usa regole scritte a mano per decidere quanto vale una posizione:
la stima con un modello appreso giocando decine di migliaia di partite contro
se stesso (bot_factory/train.py). Il modello legge un vettore di caratteristiche del
tavolo a FINE TURNO del Bot, prima della pesca, e ne ricava la probabilità di
vincere la partita. I pesi stanno in weights.json e si valutano in
Python puro: nessuna dipendenza, costo trascurabile anche su un server minimo.

Le caratteristiche sono di due tipi:
- STATIC: non dipendono da come il Bot schiera i Guerrieri (Vite, Muri,
  Costruzioni, mano, forze dell'avversario);
- DYN: dipendono dallo Schieramento e dalla Battaglia di questo turno (Vite
  e Muri tolti all'avversario, quanto restano esposti i propri Bastioni,
  Orde attive).

I modelli sono due, addestrati sugli stessi dati:
- uno LINEARE (regressione logistica). Essendo lineare, il punteggio di uno
  Schieramento è la somma dei pesi delle sole caratteristiche DYN: i
  migliori Schieramenti si trovano in pura aritmetica (Ctx.layouts), senza
  copiare lo stato. È ciò che rende il Bot leggero: una copia dello stato
  per ogni azione provata, non per ogni disposizione;
- una piccola RETE (uno strato nascosto), che coglie ciò che il lineare non
  vede (quanto pesa un Bastione scoperto dipende dalle Vite rimaste, da chi
  sta vincendo la corsa ai Danni...). Dà il giudizio finale sulla posizione,
  scegliendo tra i pochi Schieramenti proposti dal lineare (Ctx.judge).
"""

from __future__ import annotations
import json
import os
from typing import Callable, Dict, List, Optional, Tuple

from engine.cards import CARD_REGISTRY, WarriorCard, SpellCard, BuildingCard
from engine.deck import get_base_card_id
from engine.models import GameState, Player
from engine.battle import adjacent_bastions

ZONES = ("vanguard", "bastion_left", "bastion_right")
WIN = 50.0  # valore (in logit) di una partita vinta

BUILDINGS = sorted(c.id for c in CARD_REGISTRY.values() if isinstance(c, BuildingCard))
CARDS = sorted(CARD_REGISTRY)
EFFECTS = sorted({c.horde_effect_id for c in CARD_REGISTRY.values()
                  if isinstance(c, WarriorCard) and c.horde_effect_id})
WARRIORS = sorted(c.id for c in CARD_REGISTRY.values() if isinstance(c, WarriorCard))
SPECIES = sorted({c.species for c in CARD_REGISTRY.values() if isinstance(c, WarriorCard)})

# Effetti Orda che cambiano le Caratteristiche del Guerriero scelto (ATT, GIT, DIF).
# Polemarco dipende dal numero di Umani: calcolato in _horde_configs.
_STAT_EFFECTS = {"patrizio_horde": (0, 2, 0), "orfeo_horde": (1, 0, 1), "polemarco_horde": None}

# --- Nomi delle caratteristiche (l'ordine conta solo dentro questo modulo:
# i pesi sono salvati per nome) ---------------------------------------------

_OPP = ["op_l1", "op_l2", "op_l3", "op_l4", "op_walls_min", "op_walls_sum", "n_opp2", "n_opp3"]
_DEF = ["breach_l1", "breach_l2", "breach_l3", "slack0", "slack1", "slack2", "wall_loss",
        "breach_both", "safe_bastions", "def_att_margin", "def_git_margin", "slack_n"]
_ROSTER = ["me_n", "me_att", "me_git", "me_d1", "me_d2", "me_g2", "off_att", "off_git",
           "off_blocked", "me_hordes", "off_dmg", "off_dmg7", "def_dmg", "def_dmg7"]     + [f"me_h_{e}" for e in EFFECTS]
_N_ROSTER_BASE = 14
DYN = _OPP + _DEF + _ROSTER

STATIC = (
    ["bias", "me_l1", "me_l2", "me_l3", "me_l4", "me_walls_min", "me_walls_sum", "me_walls_big",
     "op_n", "op_att", "op_git", "op_d1", "op_d2", "op_g2", "op_mages", "op_hordes", "op_hand", "op_immune",
     "me_mages", "me_anatema", "me_sortilegio", "me_incantesimo", "me_heroes", "me_immune",
     "mana_next", "mana_extra", "turn",
     "hand_n", "hand_recruit", "hand_hero", "hand_hero_dead", "hand_spell", "hand_spell_dead", "hand_building"]
    + [f"me_b_{b}" for b in BUILDINGS] + [f"me_c_{b}" for b in BUILDINGS]
    + [f"op_b_{b}" for b in BUILDINGS] + [f"op_c_{b}" for b in BUILDINGS]
    + [f"hand_{c}" for c in CARDS]
    # Guerrieri in campo, per carta e per Specie: senza, il modello non vede
    # che due Elfi sono a un passo da un'Orda o che una Recluta aspetta il suo Eroe
    + [f"me_sp_{s}" for s in SPECIES] + [f"op_sp_{s}" for s in SPECIES]
    + [f"me_w_{w}" for w in WARRIORS] + [f"op_w_{w}" for w in WARRIORS]
)
FEATURES = STATIC + DYN

_S = {name: i for i, name in enumerate(STATIC)}
_B = {b: i for i, b in enumerate(BUILDINGS)}
_C = {c: i for i, c in enumerate(CARDS)}
_E = {e: i for i, e in enumerate(EFFECTS)}
_W = {w: i for i, w in enumerate(WARRIORS)}
_SP = {s: i for i, s in enumerate(SPECIES)}
_NB = len(BUILDINGS)
_N_OPP, _N_DEF, _N_ROSTER = len(_OPP), len(_DEF), len(_ROSTER)


def _dot(a: List[float], b: List[float]) -> float:
    s = 0.0
    for x, y in zip(a, b):
        if x:
            s += x * y
    return s


class Model:
    """Pesi dei due modelli: il lineare per nome di caratteristica, la rete
    (facoltativa: senza, giudica il lineare) come righe per caratteristica."""

    def __init__(self, weights: Dict[str, float], mlp: Optional[dict] = None):
        self.weights = dict(weights)
        g = self.weights.get
        self.ws = [g(n, 0.0) for n in STATIC]
        self.w_opp = [g(n, 0.0) for n in _OPP]
        self.w_def = [g(n, 0.0) for n in _DEF]
        self.w_roster = [g(n, 0.0) for n in _ROSTER]
        self.w_dyn = self.w_opp + self.w_def + self.w_roster
        self.flag = {e: g(f"me_h_{e}", 0.0) for e in EFFECTS}
        self.hand = {c: g(f"hand_{c}", 0.0) for c in CARDS}
        self.opp_building = {b: (g(f"op_b_{b}", 0.0), g(f"op_c_{b}", 0.0)) for b in BUILDINGS}
        self.mlp = None
        if mlp:
            # w1[nome] = pesi verso lo strato nascosto; caratteristiche che la
            # rete non conosce (carte aggiunte dopo l'addestramento) pesano zero
            zero = [0.0] * len(mlp["b1"])
            rows = [mlp["w1"].get(n, zero) for n in FEATURES]
            self.mlp = (rows[:len(STATIC)], rows[len(STATIC):], mlp["b1"], mlp["w2"], mlp["b2"])
            self._zero = zero

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Model":
        path = path or os.path.join(os.path.dirname(__file__), "weights.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return cls(data["weights"], data.get("mlp"))

    def hidden(self, static: List[float]) -> List[float]:
        """Strato nascosto della rete prima dell'attivazione, con le sole
        caratteristiche STATIC."""
        return self._add(self.mlp[2], self.mlp[0], static)

    def hidden_from(self, ref_hidden: List[float], ref_static: List[float], static: List[float]) -> List[float]:
        """Come `hidden`, ma partendo da quello di una posizione vicina: tra
        le posizioni provate in una ricerca cambiano poche caratteristiche,
        e aggiornare solo quelle costa una frazione."""
        rows = self.mlp[0]
        h = ref_hidden
        for i, (x, x0) in enumerate(zip(static, ref_static)):
            if x != x0:
                d = x - x0
                h = [u + d * v for u, v in zip(h, rows[i])]
        return h

    def dyn_hidden(self, dyn: List[float], start: int = 0) -> List[float]:
        """Contributo allo strato nascosto delle caratteristiche DYN, o di
        un loro tratto che comincia alla posizione `start`."""
        return self._add(self._zero, self.mlp[1][start:start + len(dyn)], dyn)

    @staticmethod
    def _add(h: List[float], rows: list, feats: List[float]) -> List[float]:
        for x, row in zip(feats, rows):
            if x:
                if x == 1.0:
                    h = [u + v for u, v in zip(h, row)]
                else:
                    h = [u + x * v for u, v in zip(h, row)]
        return h

    def output(self, hidden: List[float], dyn_hidden: List[float]) -> float:
        """Logit della rete da `hidden` (STATIC) e `dyn_hidden` (DYN)."""
        out = self.mlp[4]
        for u, d, v in zip(hidden, dyn_hidden, self.mlp[3]):
            u += d
            if u > 0.0:
                out += u * v
        return out


def style_vectors(style: Dict[str, float]) -> Tuple[List[float], List[float]]:
    """Uno stile di gioco: pesi aggiunti al giudizio del modello, per nome di
    caratteristica (es. più valore ai Guerrieri, o ai Muri). Lo usa
    bot_factory/train.py per dare stili diversi agli avversari di allenamento."""
    return [style.get(n, 0.0) for n in STATIC], [style.get(n, 0.0) for n in DYN]


_default_model: Optional[Model] = None


def default_model() -> Model:
    global _default_model
    if _default_model is None:
        _default_model = Model.load()
    return _default_model


# ---------------------------------------------------------------------------
# Riassunto di un giocatore
# ---------------------------------------------------------------------------

class Unit:
    """Un Guerriero in campo. `att/git/dif` sono i valori attuali; `hb` è il
    bonus che gli dà l'Orda di cui è la carta scelta (None se non lo è), da
    togliere se l'Orda si scioglie."""
    __slots__ = ("iid", "base", "att", "git", "dif", "species", "zone", "effect", "center", "lit", "hb", "hero")

    def __init__(self, iid, base, att, git, dif, species, zone, effect, center, lit, hb, hero):
        self.iid, self.base, self.att, self.git, self.dif = iid, base, att, git, dif
        self.species, self.zone, self.effect = species, zone, effect
        self.center, self.lit, self.hb, self.hero = center, lit, hb, hero


class Side:
    """Ciò che conta di un giocatore per la valutazione."""
    __slots__ = ("player", "lives", "units", "b_att", "b_git", "b_dif", "wl", "wr", "fossato",
                 "built", "done", "immune", "mages", "schools", "att", "git", "d1", "d2", "g2")

    def __init__(self, p: Player):
        self.player = p
        self.lives = len(p.life_cards)
        f = p.field
        self.wl, self.wr = len(f.bastion_left.walls), len(f.bastion_right.walls)
        b_att = b_git = b_dif = fossato = 0
        built: Dict[str, int] = {}
        done: Dict[str, int] = {}
        trono = None
        for b in f.village.buildings:
            bid = b.base_card_id
            if b.completed:
                done[bid] = done.get(bid, 0) + 1
            else:
                built[bid] = built.get(bid, 0) + 1
            if bid == "ariete":
                b_att += 2 if b.completed else 1
            elif bid == "catapulta":
                b_git += 2 if b.completed else 1
            elif bid == "saracinesca":
                b_dif += 2 if b.completed else 1
            elif bid == "fossato":
                fossato = max(fossato, 3 if b.completed else 1)
            elif bid == "trono" and b.completed and b.assigned_warrior:
                trono = trono or set()
                trono.add(b.assigned_warrior)
        self.b_att, self.b_git, self.b_dif, self.fossato = b_att, b_git, b_dif, fossato
        self.built, self.done = built, done

        horde_bonus = None
        self.immune = False
        for e in p.active_effects:
            t = e.get("type")
            if t == "horde_stat_bonus" and not e.get("trono_warrior"):
                horde_bonus = horde_bonus or {}
                horde_bonus[e.get("warrior_iid")] = (e.get("att", 0), e.get("git", 0), e.get("dif", 0))
            elif t == "spell_immune":
                self.immune = True

        units: List[Unit] = []
        mages = 0
        schools = None
        reg = CARD_REGISTRY
        for z, lst in enumerate((f.vanguard, f.bastion_left.warriors, f.bastion_right.warriors)):
            for w in lst:
                card = reg[w.base_card_id]
                tm = w.temp_modifiers
                if tm:
                    att, git, dif = card.att + tm.get("att", 0), card.git + tm.get("git", 0), card.dif + tm.get("dif", 0)
                else:
                    att, git, dif = card.att, card.git, card.dif
                iid = w.instance_id
                throned = trono is not None and iid in trono
                center = w.horde_active and not throned
                units.append(Unit(
                    iid, w.base_card_id, att, git, dif, card.species, z,
                    None if throned else card.horde_effect_id, center, w.horde_active,
                    horde_bonus.get(iid) if (center and horde_bonus) else None,
                    card.subtype == "hero",
                ))
                if card.species == "maga":
                    mages += 1
                    schools = schools or set()
                    schools.add(card.school)
        self.units, self.mages, self.schools = units, mages, schools or ()

        # Forze "potenziali": chi gioca può rischierare tutti i suoi Guerrieri,
        # quindi contano i massimi su tutto il campo, non la disposizione attuale.
        if units:
            self.att = max(u.att for u in units) + b_att
            self.git = max(u.git for u in units) + b_git
            difs = sorted((u.dif for u in units), reverse=True)
            gits = sorted((u.git for u in units), reverse=True)
            self.d1 = difs[0] + b_dif
            self.d2 = difs[1] + b_dif if len(difs) > 1 else 0
            self.g2 = gits[1] + b_git if len(gits) > 1 else 0
        else:
            self.att = self.git = self.d1 = self.d2 = self.g2 = 0


class Plan:
    """Schieramento scelto: zona di ogni Guerriero, Orde da attivare
    [(zona, specie, instance_id, effetto)] e bersaglio della Battaglia
    (indice giocatore, lato) o None."""
    __slots__ = ("zones", "hordes", "target")

    def __init__(self, zones, hordes, target):
        self.zones, self.hordes, self.target = zones, hordes, target


def next_turn_mana(state: GameState, idx: int) -> int:
    """Mana del giocatore `idx` al suo prossimo turno, visto dal turno corrente."""
    player = state.players[idx]
    if player.skip_mana_next_turn:
        return 0
    n = len(state.players)
    turn, j = state.turn, state.current_player_index
    while True:
        j = (j + 1) % n
        if j == state.first_player_index:
            turn += 1
        if j == idx:
            break
    return state.mana_for_turn(turn)


def _clip4(x: int) -> float:
    return (4 if x > 4 else -4 if x < -4 else x) / 4.0


# ---------------------------------------------------------------------------
# Contesto di valutazione: lo stato visto dal giocatore `me_idx`
# ---------------------------------------------------------------------------

class Ctx:
    def __init__(self, state: GameState, me_idx: int, model: Model, memo: Optional[dict] = None):
        """`memo` (facoltativo): dizionario condiviso tra i contesti di una
        stessa ricerca, per non rifare i conti della difesa su campi uguali."""
        self.state, self.me_idx, self.model, self.memo = state, me_idx, model, memo
        players = state.players
        self.me = me = Side(players[me_idx])
        self.opp_idx = [i for i, p in enumerate(players) if i != me_idx and p.life_cards]
        self.opps = [Side(players[i]) for i in self.opp_idx]
        slot = {i: k for k, i in enumerate(self.opp_idx)}

        adj = adjacent_bastions(me_idx, players)
        left_i, right_i = adj["left_attacks"][0], adj["right_attacks"][0]
        self.two = left_i != right_i
        # Minaccia su ogni mio Bastione: (ATT, GIT) che il vicino può portare
        # in Avanscoperta al suo prossimo turno, (-1, -1) se non può attaccarmi.
        self.thr = (self._threat(left_i, slot), self._threat(right_i, slot))

        me_p = me.player
        guerremoto = strip = 0
        self.eracle = False
        for e in me_p.active_effects:
            t = e.get("type")
            if t == "guerremoto" and e.get("any_target"):
                guerremoto = 1
                strip += e.get("discard_walls", 0)
            elif t == "eracle_destroy_building":
                self.eracle = True
        self.strip = strip
        # Bastioni attaccabili in Battaglia: (slot avversario, lato 0/1, DIF, GIT)
        targets = []
        if state.battles_remaining > 0:
            if guerremoto:
                pairs = [(i, s) for i in self.opp_idx for s in ("left", "right")]
            else:
                pairs = [adj["right_attacks"], adj["left_attacks"]]
            for i, s in pairs:
                if i not in slot or players[i].turns_completed < 1:
                    continue
                o = self.opps[slot[i]]
                b = o.player.field.bastion_left if s == "left" else o.player.field.bastion_right
                if b.warriors:
                    tm = [(CARD_REGISTRY[w.base_card_id], w.temp_modifiers) for w in b.warriors]
                    d = max(c.dif + m.get("dif", 0) for c, m in tm) + o.b_dif
                    g = max(c.git + m.get("git", 0) for c, m in tm) + o.b_git
                else:
                    d = g = 0
                t = (slot[i], 0 if s == "left" else 1, d, g)
                if t not in targets:
                    targets.append(t)
        self.targets = targets
        self._atk: Dict[Tuple[int, int], tuple] = {}
        dkey = (me.b_dif, me.b_git, me.wl, me.wr, me.lives, self.thr, self.two)
        self._dfn: Dict[Tuple[int, int, int, int], float] = {} if memo is None else memo.setdefault(("dfn", dkey), {})
        self._dfh: Dict[Tuple[int, int, int, int], List[float]] = {} if memo is None else memo.setdefault(("dfh", dkey), {})
        self._base_opp: Optional[tuple] = None
        self._hand: Optional[set] = None

    def _threat(self, idx: int, slot: Dict[int, int]) -> Tuple[int, int]:
        if idx not in slot:
            return (-1, -1)
        o = self.opps[slot[idx]]
        # Anche a campo vuoto il vicino può giocare una Recluta e attaccare subito
        fa, fg = (2, 1) if next_turn_mana(self.state, idx) >= 2 else (1, 1)
        a = max([fa] + [u.att for u in o.units]) + o.b_att
        g = max([fg] + [u.git for u in o.units]) + o.b_git
        if g < self.me.fossato:
            return (-1, -1)
        return (a, g)

    # ----- caratteristiche STATIC -------------------------------------------

    def static_feats(self) -> List[float]:
        f = [0.0] * len(STATIC)
        S = _S
        me, state = self.me, self.state
        p = me.player
        f[0] = 1.0
        f[S["me_l1"] + min(me.lives, 4) - 1] = 1.0
        f[S["me_walls_min"]] = min(me.wl, me.wr, 8) / 6.0
        f[S["me_walls_sum"]] = min(me.wl + me.wr, 18) / 12.0
        # oltre i 18 Muri: senza, per il modello i Muri in più non valgono
        # nulla e perderne dieci a turno non gli costa
        f[S["me_walls_big"]] = min(max(me.wl + me.wr - 18, 0), 24) / 24.0

        opps = self.opps
        n = len(opps) or 1
        ob, oc = S["op_b_" + BUILDINGS[0]], S["op_c_" + BUILDINGS[0]]
        ow, osp = S["op_w_" + WARRIORS[0]], S["op_sp_" + SPECIES[0]]
        mw, msp = S["me_w_" + WARRIORS[0]], S["me_sp_" + SPECIES[0]]
        count = [0] * len(SPECIES)
        for u in me.units:
            f[mw + _W[u.base]] += 1.0
            count[_SP[u.species]] += 1
        for k, c in enumerate(count):
            f[msp + k] = min(c, 3) / 3.0
        for o in opps:
            f[S["op_n"]] += min(len(o.units), 6) / 6.0 / n
            f[S["op_att"]] += o.att / 8.0 / n
            f[S["op_git"]] += o.git / 6.0 / n
            f[S["op_d1"]] += o.d1 / 8.0 / n
            f[S["op_d2"]] += o.d2 / 8.0 / n
            f[S["op_g2"]] += o.g2 / 6.0 / n
            f[S["op_mages"]] += min(o.mages, 3) / 3.0 / n
            f[S["op_hordes"]] += sum(1 for u in o.units if u.lit) / 2.0 / n
            f[S["op_hand"]] += min(len(o.player.hand), 8) / 6.0 / n
            if o.immune:
                f[S["op_immune"]] += 1.0 / n
            for bid, c in o.built.items():
                f[ob + _B[bid]] += c / n
            for bid, c in o.done.items():
                f[oc + _B[bid]] += c / n
            count = [0] * len(SPECIES)
            for u in o.units:
                f[ow + _W[u.base]] += 1.0 / n
                count[_SP[u.species]] += 1
            for k, c in enumerate(count):
                f[osp + k] += min(c, 3) / 3.0 / n

        f[S["me_mages"]] = min(me.mages, 3) / 3.0
        for school in me.schools:
            f[S["me_" + school]] = 1.0
        f[S["me_heroes"]] = min(sum(1 for u in me.units if u.hero), 3) / 3.0
        if me.immune:
            f[S["me_immune"]] = 1.0
        mb, mc = S["me_b_" + BUILDINGS[0]], S["me_c_" + BUILDINGS[0]]
        for bid, c in me.built.items():
            f[mb + _B[bid]] = c
        for bid, c in me.done.items():
            f[mc + _B[bid]] = c

        mana_next = state.mana_for_turn(state.turn + 1)
        f[S["mana_next"]] = mana_next / 5.0
        extra = 0
        for e in p.active_effects:
            t = e.get("type")
            if t == "investimento_deferred":
                extra += e.get("mana", 2)
            elif t == "divinazione_base":
                extra += 1
            elif t == "divinazione_all_mage":
                extra += me.mages
        f[S["mana_extra"]] = min(extra, 6) / 3.0
        f[S["turn"]] = min(state.turn, 12) / 12.0

        f[S["hand_n"]] = min(len(p.hand), 8) / 6.0
        hc = S["hand_" + CARDS[0]]
        for iid in p.hand:
            base = get_base_card_id(iid)
            name = self._hand_kind(base, mana_next)
            if name:
                f[S[name]] += 1.0 / 3.0
            f[hc + _C[base]] += 1.0
        return f

    def _hand_kind(self, base: str, mana_next: int) -> Optional[str]:
        card = CARD_REGISTRY[base]
        me = self.me
        if isinstance(card, WarriorCard):
            if card.subtype == "hero":
                # giocabile anche se la Recluta è ancora in mano: murare l'Eroe
                # ora vuol dire rinunciarci proprio mentre sta per servire
                if any(u.base == card.evolves_from for u in me.units) or card.evolves_from in self._hand_bases():
                    return "hand_hero"
                return "hand_hero_dead"
            return "hand_recruit" if card.cost <= mana_next else None
        if isinstance(card, SpellCard):
            return "hand_spell" if me.mages >= card.cost else "hand_spell_dead"
        return "hand_building"

    def _hand_bases(self) -> set:
        bases = self._hand
        if bases is None:
            bases = self._hand = {get_base_card_id(iid) for iid in self.me.player.hand}
        return bases

    def hand_value(self, base: str) -> float:
        """Quanto vale tenere in mano questa carta (per scegliere cosa
        scartare o murare): il suo peso nel modello."""
        model = self.model
        name = self._hand_kind(base, self.state.mana_for_turn(self.state.turn + 1))
        return model.hand.get(base, 0.0) + (model.ws[_S[name]] / 3.0 if name else 0.0)

    def static_score(self) -> float:
        return _dot(self.static_feats(), self.model.ws)

    # ----- caratteristiche DYN ----------------------------------------------

    def _opp_feats(self, lives: List[int], walls: List[Tuple[int, int]]) -> List[float]:
        n = len(lives)
        c = [0.0, 0.0, 0.0, 0.0]
        wmin = wsum = 0
        for lv, (a, b) in zip(lives, walls):
            c[min(lv, 4) - 1] += 1.0
            wmin += min(a, b, 8)
            wsum += min(a + b, 18)
        return [c[0] / n, c[1] / n, c[2] / n, c[3] / n, wmin / (6.0 * n), wsum / (12.0 * n),
                1.0 if n == 2 else 0.0, 1.0 if n == 3 else 0.0]

    def _def_feats(self, dl: int, gl: int, dr: int, gr: int) -> List[float]:
        """Esposizione dei miei Bastioni. dl/gl/dr/gr: DIF e GIT massime dei
        Guerrieri a difesa (senza bonus Costruzioni), -1 se il Bastione è vuoto."""
        me = self.me
        if dl < 0:
            dl = gl = 0
        else:
            dl += me.b_dif
            gl += me.b_git
        if dr < 0:
            dr = gr = 0
        else:
            dr += me.b_dif
            gr += me.b_git
        (al, agl), (ar, agr) = self.thr
        dmg_l = (max(al - dl, 0) + max(agl - gl, 0)) if al >= 0 else 0
        dmg_r = (max(ar - dr, 0) + max(agr - gr, 0)) if ar >= 0 else 0
        sl, sr = me.wl - dmg_l, me.wr - dmg_r
        worst, other = (sl, sr) if sl <= sr else (sr, sl)
        f = [0.0] * _N_DEF
        if worst < 0:
            f[min(me.lives, 3) - 1] = 1.0
        elif worst <= 2:
            f[3 + worst] = 1.0
        f[6] = (min(dmg_l, me.wl) + min(dmg_r, me.wr)) / 12.0
        if self.two and other < 0:
            f[7] = 1.0
        f[8] = ((dmg_l == 0) + (dmg_r == 0)) / 2.0
        f[9] = _clip4(min(dl - al if al >= 0 else 4, dr - ar if ar >= 0 else 4))
        f[10] = _clip4(min(gl - agl if al >= 0 else 4, gr - agr if ar >= 0 else 4))
        # Muri che restano al Bastione più debole dopo l'attacco atteso
        f[11] = min(max(worst, 0), 12) / 12.0
        return f

    def _defense(self, dl: int, gl: int, dr: int, gr: int) -> float:
        key = (dl, gl, dr, gr)
        v = self._dfn.get(key)
        if v is None:
            v = self._dfn[key] = _dot(self._def_feats(dl, gl, dr, gr), self.model.w_def)
        return v

    def _roster_feats(self, stats: List[Tuple[int, int, int]], flags) -> List[float]:
        me = self.me
        n = len(stats)
        if n:
            a = max(s[0] for s in stats) + me.b_att
            g = max(s[1] for s in stats) + me.b_git
            difs = sorted((s[2] for s in stats), reverse=True)
            gits = sorted((s[1] for s in stats), reverse=True)
            d1 = difs[0] + me.b_dif
            d2 = difs[1] + me.b_dif if n > 1 else 0
            g2 = gits[1] + me.b_git if n > 1 else 0
        else:
            a = g = d1 = d2 = g2 = 0
        f = [0.0] * _N_ROSTER
        f[0], f[1], f[2], f[3], f[4], f[5] = min(n, 6) / 6.0, a / 8.0, g / 6.0, d1 / 8.0, d2 / 8.0, g2 / 6.0
        opps = self.opps
        if opps:
            k = len(opps)
            f[6] = sum(_clip4(a - o.d2) for o in opps) / k
            f[7] = sum(_clip4(g - o.g2) for o in opps) / k
            f[8] = sum(1.0 for o in opps if g < o.fossato) / k
            # Danni "strutturali" per turno: i miei contro la sua miglior difesa
            # su due Bastioni, e i suoi contro la mia. Oltre 6 l'avversario non
            # riesce più a rimurare con le sue due Azioni.
            for o in opps:
                mine = (max(a - o.d2, 0) + max(g - o.g2, 0)) if n and g >= o.fossato else 0
                his = (max(o.att - d2, 0) + max(o.git - g2, 0)) if o.units and o.git >= me.fossato else 0
                f[10] += min(mine, 10) / 8.0 / k
                f[11] += (mine >= 7) / k
                f[12] += min(his, 10) / 8.0 / k
                f[13] += (his >= 7) / k
        f[9] = len(flags) / 2.0
        for e in flags:
            f[_N_ROSTER_BASE + _E[e]] = 1.0
        return f

    def _attack(self, a: int, g: int) -> Tuple[float, Optional[tuple], Optional[List[float]]]:
        """Miglior esito della Battaglia con (ATT, GIT) in Avanscoperta:
        (punteggio lineare delle caratteristiche dell'avversario dopo la
        Battaglia, bersaglio (indice giocatore, lato) o None se non si
        attacca, quelle caratteristiche; None se la Battaglia vince la partita)."""
        key = (a, g)
        hit = self._atk.get(key)
        if hit is not None:
            return hit
        model, opps = self.model, self.opps
        if self._base_opp is None:
            if opps:
                feats = self._opp_feats([o.lives for o in opps], [(o.wl, o.wr) for o in opps])
                self._base_opp = (_dot(feats, model.w_opp), None, feats)
            else:
                self._base_opp = (WIN, None, None)
        best, best_t, best_f = self._base_opp
        if a >= 0:
            for k, side, d, gd in self.targets:
                o = opps[k]
                if g < o.fossato:
                    continue
                dmg = max(a - d, 0) + max(g - gd, 0)
                if dmg <= 0:
                    continue
                w = max(0, (o.wr if side else o.wl) - self.strip)
                lives = [x.lives for x in opps]
                walls = [(x.wl, x.wr) for x in opps]
                if dmg > w:
                    lives[k] -= 1
                    w = 0
                else:
                    w -= dmg
                walls[k] = (walls[k][0], w) if side else (w, walls[k][1])
                target = (self.opp_idx[k], "right" if side else "left")
                if lives[k] <= 0:
                    if len(opps) == 1:
                        best, best_t, best_f = WIN, target, None
                        break
                    del lives[k], walls[k]
                    feats = self._opp_feats(lives, walls)
                    score = _dot(feats, model.w_opp) + 1.0
                else:
                    feats = self._opp_feats(lives, walls)
                    score = _dot(feats, model.w_opp)
                    if self.eracle and dmg >= 3:
                        score += self._eracle_gain(o)
                if score > best or best_t is None:
                    best, best_t, best_f = score, target, feats
        hit = self._atk[key] = (best, best_t, best_f)
        return hit

    def _eracle_gain(self, o: Side) -> float:
        """Guadagno dallo scartare la Costruzione migliore del difensore."""
        ob = self.model.opp_building
        n = len(self.opps)
        gains = [-ob[b][0] for b in o.built] + [-ob[b][1] for b in o.done]
        return max(gains, default=0.0) / n if gains else 0.0

    def best_eracle_target(self, opp: Player) -> Optional[str]:
        ob = self.model.opp_building
        best, best_v = None, float("-inf")
        for b in opp.field.village.buildings:
            v = -ob[b.base_card_id][1 if b.completed else 0] + (0.01 if b.completed else 0.0)
            if v > best_v:
                best, best_v = b.instance_id, v
        return best

    # ----- vettore completo (per l'addestramento) ---------------------------

    def features(self) -> List[float]:
        """Caratteristiche dello stato così com'è (Schieramento e Battaglia
        già fatti): è ciò che il modello impara a valutare."""
        me, opps = self.me, self.opps
        zone_max = [[-1, -1], [-1, -1], [-1, -1]]
        for u in me.units:
            m = zone_max[u.zone]
            if u.dif > m[0]:
                m[0] = u.dif
            if u.git > m[1]:
                m[1] = u.git
        opp = self._opp_feats([o.lives for o in opps], [(o.wl, o.wr) for o in opps]) if opps else [0.0] * _N_OPP
        dfn = self._def_feats(zone_max[1][0], zone_max[1][1], zone_max[2][0], zone_max[2][1])
        flags = {CARD_REGISTRY[u.base].horde_effect_id for u in me.units if u.lit}
        flags.discard(None)
        roster = self._roster_feats([(u.att, u.git, u.dif) for u in me.units], flags)
        return self.static_feats() + opp + dfn + roster

    def value(self) -> float:
        """Logit della probabilità di vittoria dello stato così com'è."""
        m = self.model
        f = self.features()
        ns = len(STATIC)
        if m.mlp is not None:
            return m.output(m.hidden(f[:ns]), m.dyn_hidden(f[ns:]))
        return _dot(f[:ns], m.ws) + _dot(f[ns:], m.w_dyn)

    # ----- Schieramento ------------------------------------------------------

    def _horde_options(self):
        """Orde possibili. Ritorna (caratteristiche dei Guerrieri senza bonus
        d'Orda, effetti sempre attivi per i Troni, opzioni), con un'opzione
        per Specie che ha almeno 3 Guerrieri: (specie, indici dei tre che la
        formano, indice del Guerriero scelto, effetto, bonus alle sue
        Caratteristiche o None)."""
        units = self.me.units
        stats0: List[Tuple[int, int, int]] = []
        perm = set()
        by_species: Dict[str, List[int]] = {}
        for i, u in enumerate(units):
            a, g, d = u.att, u.git, u.dif
            if u.center:
                if u.hb:
                    a, g, d = a - u.hb[0], g - u.hb[1], d - u.hb[2]
            elif u.lit:
                eff = CARD_REGISTRY[u.base].horde_effect_id
                if eff:
                    perm.add(eff)  # Trono: effetto sempre attivo
            stats0.append((a, g, d))
            by_species.setdefault(u.species, []).append(i)

        options = []
        if len(units) >= 3:
            # Un solo effetto per Specie (provarli tutti in ogni zona costerebbe
            # troppo): il migliore secondo il peso del modello, contando ~0,15
            # per ogni punto di Caratteristica guadagnato dal Guerriero scelto.
            flag_w = self.model.flag
            umani = len(by_species.get("umano", ()))
            for sp, idxs in by_species.items():
                if len(idxs) < 3:
                    continue
                pick = None
                for i in idxs:
                    e = units[i].effect
                    if not e:
                        continue
                    v = flag_w[e]
                    if e in _STAT_EFFECTS:
                        delta = _STAT_EFFECTS[e] or (umani, 0, 0)
                        v += 0.15 * sum(delta) + 0.01 * (stats0[i][1] if e == "patrizio_horde" else stats0[i][0])
                    if pick is None or v > pick[0]:
                        pick = (v, e, i)
                if pick is not None:  # None: nessun effetto attivabile (tutti col Trono)
                    _, e, i = pick
                    delta = (_STAT_EFFECTS[e] or (umani, 0, 0)) if e in _STAT_EFFECTS else None
                    # L'Orda impegna tre Guerrieri: quello scelto e i due più
                    # deboli. Gli altri della Specie restano liberi di andare
                    # dove servono (un quarto nella stessa zona non dà nulla).
                    mates = sorted((j for j in idxs if j != i), key=lambda j: sum(stats0[j]))[:2]
                    options.append((sp, [i] + mates, i, e, delta))
        return stats0, frozenset(perm), options

    @staticmethod
    def _horde_config(stats0, perm, chosen) -> tuple:
        """Configurazione con le Orde `chosen` [(opzione, zona)]: (caratteristiche,
        zone obbligate {indice: zona}, Orde [(zona, specie, indice, effetto)],
        effetti attivi)."""
        if not chosen:
            return (stats0, {}, [], perm)
        stats = list(stats0)
        fixed: Dict[int, int] = {}
        hordes = []
        flags = set(perm)
        for (sp, idxs, i, e, delta), z in chosen:
            if delta:
                stats[i] = (stats[i][0] + delta[0], stats[i][1] + delta[1], stats[i][2] + delta[2])
            for j in idxs:
                fixed[j] = z
            hordes.append((z, sp, i, e))
            flags.add(e)
        return (stats, fixed, hordes, frozenset(flags))

    def layout_key(self) -> tuple:
        """Tutto ciò da cui dipende `layouts`: due posizioni con la stessa
        chiave (es. diverse solo per la mano o per una Costruzione senza
        effetti in Battaglia) hanno lo stesso Schieramento migliore."""
        me = self.me
        return (
            tuple((u.iid, u.att, u.git, u.dif, u.zone, u.effect, u.center, u.lit, u.hb) for u in me.units),
            me.b_att, me.b_git, me.b_dif, me.wl, me.wr, me.lives, self.thr, self.two,
            tuple(self.targets), self.strip,
            tuple((o.lives, o.wl, o.wr, o.d2, o.g2, o.fossato) for o in self.opps),
            tuple((tuple(o.built), tuple(o.done)) for o in self.opps) if self.eracle else None,
        )

    def layouts(self, top: int = 1) -> list:
        """I `top` migliori Schieramenti per la parte DYN del modello lineare,
        dal migliore: [(punteggio, caratteristiche DYN o None se la Battaglia
        vince la partita, Plan, contributo DYN allo strato nascosto della
        rete)]. Schieramenti con lo stesso effetto (stesso attacco, stessa
        difesa dei due Bastioni) contano una volta sola."""
        me = self.me
        units = me.units
        n = len(units)
        b_att, b_git = me.b_att, me.b_git
        w_roster = self.model.w_roster
        can_attack = bool(self.targets)
        cur = [u.zone for u in units]
        dfn, defense, attack = self._dfn, self._defense, self._attack
        found: Dict[tuple, tuple] = {}

        def evaluate(config, ci: int) -> float:
            """Disposizioni dei Guerrieri liberi per una configurazione di
            Orde; ritorna il punteggio della migliore."""
            stats, fixed, hordes, flags = config
            roster = self._roster_feats(stats, flags)
            rs = _dot(roster, w_roster)
            rkey = tuple(roster)
            fz: List[List[int]] = [[], [], []]
            stay_fixed = 0
            for i, z in fixed.items():
                fz[z].append(i)
                stay_fixed += cur[i] == z
            free = [i for i in range(n) if i not in fixed]
            by_dif = sorted(free, key=lambda i: stats[i][2], reverse=True)
            by_git = sorted(free, key=lambda i: stats[i][1], reverse=True)
            vsets = self._vanguard_sets(free, stats, by_git) if can_attack else [[]]
            best = float("-inf")
            for vset in vsets:
                vg = fz[0] + vset
                if vg and can_attack:
                    ag = (max(stats[i][0] for i in vg) + b_att, max(stats[i][1] for i in vg) + b_git)
                else:
                    ag = (-1, -1)
                a_score = attack(ag[0], ag[1])[0]
                crowd = 3e-4 * len(vg)
                rest = [i for i in free if i not in vset] if vset else free
                # Solo i 2 con più DIF e i 2 con più GIT possono decidere la
                # difesa dei due Bastioni: gli altri restano dove sono (o a sinistra).
                if len(rest) <= 3:
                    keys, fill = rest, ()
                else:
                    keys = [i for i in by_dif if i not in vset][:2]
                    seen = 0
                    for i in by_git:
                        if i in vset:
                            continue
                        if i not in keys:
                            keys.append(i)
                        seen += 1
                        if seen >= 2:
                            break
                    fill = [(i, cur[i] or 1) for i in rest if i not in keys]
                stay_base = stay_fixed + sum(1 for i in vset if cur[i] == 0) + sum(1 for i, z in fill if cur[i] == z)
                bdl = bgl = bdr = bgr = -1
                for i in fz[1] + [i for i, z in fill if z == 1]:
                    if stats[i][2] > bdl:
                        bdl = stats[i][2]
                    if stats[i][1] > bgl:
                        bgl = stats[i][1]
                for i in fz[2] + [i for i, z in fill if z == 2]:
                    if stats[i][2] > bdr:
                        bdr = stats[i][2]
                    if stats[i][1] > bgr:
                        bgr = stats[i][1]
                for mask in range(1 << len(keys)):
                    dl, gl, dr, gr = bdl, bgl, bdr, bgr
                    stay = stay_base
                    for j, i in enumerate(keys):
                        _, g, d = stats[i]
                        if mask >> j & 1:
                            if d > dr:
                                dr = d
                            if g > gr:
                                gr = g
                            stay += cur[i] == 2
                        else:
                            if d > dl:
                                dl = d
                            if g > gl:
                                gl = g
                            stay += cur[i] == 1
                    dkey = (dl, gl, dr, gr)
                    d_score = dfn.get(dkey)
                    if d_score is None:
                        d_score = defense(dl, gl, dr, gr)
                    # a parità, meno Guerrieri in Avanscoperta (chi non alza
                    # l'attacco non ha motivo di starci), poi meno spostamenti
                    total = rs + a_score + d_score + 1e-4 * stay - crowd
                    if total > best:
                        best = total
                    key = (ci, ag, dkey)
                    old = found.get(key)
                    if old is None or total > old[0]:
                        found[key] = (total, config, roster, ag, dkey, vset, keys, mask, fill, rkey)
            return best

        # Senza Orde; poi ogni Specie da sola, in ognuna delle tre zone; infine,
        # se le Specie da Orda sono più d'una, le scelte migliori messe insieme.
        # (Provare tutte le combinazioni costerebbe 4^Specie configurazioni.)
        stats0, perm, options = self._horde_options()
        evaluate(self._horde_config(stats0, perm, ()), 0)
        winners = []
        ci = 0
        for option in options:
            top_z = None
            for z in (0, 1, 2):
                ci += 1
                score = evaluate(self._horde_config(stats0, perm, [(option, z)]), ci)
                if top_z is None or score > top_z[0]:
                    top_z = (score, z)
            winners.append((option, top_z[1]))
        if len(winners) > 1:
            evaluate(self._horde_config(stats0, perm, winners), ci + 1)

        # Via gli Schieramenti dominati: a parità di attacco, di Orde e di forze
        # in campo, più DIF e GIT su un Bastione non possono far danno. Il
        # modello non lo sa da solo (con tanti Muri dà alla difesa un peso quasi
        # nullo, a volte del segno sbagliato) e lascerebbe i Bastioni sguarniti
        # per mandare in Avanscoperta Guerrieri che non aggiungono nulla.
        groups: Dict[tuple, List[tuple]] = {}
        for c in found.values():
            groups.setdefault((c[9], c[3]), []).append(c[4])
        picks = []
        for c in sorted(found.values(), key=lambda c: c[0], reverse=True):
            dl, gl, dr, gr = d = c[4]
            for o in groups[(c[9], c[3])]:
                if o[0] >= dl and o[1] >= gl and o[2] >= dr and o[3] >= gr and o != d:
                    break
            else:
                picks.append(c)
                if len(picks) >= top:
                    break
        out = []
        model = self.model
        parts: dict = {}
        def_parts = self._dfh
        for total, config, roster, ag, dkey, vset, keys, mask, fill, _ in picks:
            _, fixed, hordes, _ = config
            zones: Dict[str, int] = {}
            for i, z in fixed.items():
                zones[units[i].iid] = z
            for i in vset:
                zones[units[i].iid] = 0
            for i, z in fill:
                zones[units[i].iid] = z
            for j, i in enumerate(keys):
                zones[units[i].iid] = 2 if mask >> j & 1 else 1
            _, target, opp = attack(ag[0], ag[1])
            dyn = dyn_hidden = None
            if opp is not None:
                dfeats = self._def_feats(*dkey)
                dyn = opp + dfeats + roster
                if model.mlp is not None:
                    # i tre tratti (avversario, difesa, forze) si ripetono tra i
                    # candidati: il loro contributo alla rete si calcola una volta
                    ho = parts.get(ag)
                    if ho is None:
                        ho = parts[ag] = model.dyn_hidden(opp)
                    hd = def_parts.get(dkey)
                    if hd is None:
                        hd = def_parts[dkey] = model.dyn_hidden(dfeats, _N_OPP)
                    hr = parts.get(id(roster))
                    if hr is None:
                        hr = parts[id(roster)] = model.dyn_hidden(roster, _N_OPP + _N_DEF)
                    dyn_hidden = [x + y + z for x, y, z in zip(ho, hd, hr)]
            out.append((total, dyn, Plan(zones, [(z, sp, units[i].iid, e) for z, sp, i, e in hordes], target),
                        dyn_hidden))
        return out

    def judge(self, candidates: list, noise: Optional[Callable[[], float]] = None,
              style: Optional[Tuple[List[float], List[float]]] = None) -> Tuple[float, Plan]:
        """Giudizio finale sulla posizione: tra gli Schieramenti candidati
        (da `layouts`) ritorna (valore, Plan) del migliore secondo la rete, o
        secondo il lineare se la rete non c'è. `noise`, se dato, sporca il
        valore di ogni candidato: è l'imprecisione dei livelli più facili.
        `style` (da style_vectors) aggiunge al valore una preferenza personale."""
        model = self.model
        static = self.static_feats()
        taste = _dot(static, style[0]) if style else 0.0
        if model.mlp is not None:
            base = 0.0
            # la prima posizione giudicata in una ricerca fa da riferimento alle altre
            ref = self.memo.get("ref") if self.memo is not None else None
            if ref is None:
                hidden = model.hidden(static)
                if self.memo is not None:
                    self.memo["ref"] = (hidden, static)
            else:
                hidden = model.hidden_from(ref[0], ref[1], static)
        else:
            hidden = None
            base = _dot(static, model.ws)
        best, best_plan, best_noisy = None, None, None
        for score, dyn, plan, dyn_hidden in candidates:
            if dyn is None:
                value = WIN
            elif hidden is not None:
                value = model.output(hidden, dyn_hidden)
            else:
                value = base + score
            if style and dyn is not None:
                value += taste + _dot(dyn, style[1])
            noisy = value + noise() if noise is not None else value
            if best_noisy is None or noisy > best_noisy:
                best, best_plan, best_noisy = value, plan, noisy
        return best, best_plan

    @staticmethod
    def _vanguard_sets(free: List[int], stats, by_git: List[int]) -> List[List[int]]:
        """Gruppi di Guerrieri da mandare in Avanscoperta: in Battaglia
        contano solo ATT e GIT massime, quindi bastano nessuno, uno, o la
        coppia (miglior ATT, miglior GIT)."""
        sets: List[List[int]] = [[]]
        singles = []
        for i in free:
            a, g, d = stats[i]
            if a <= 0 and g <= 0:
                continue
            dominated = False
            for j in free:
                if j == i:
                    continue
                a2, g2, d2 = stats[j]
                if a2 >= a and g2 >= g and d2 <= d and ((a2, g2, -d2) != (a, g, -d) or j < i):
                    dominated = True
                    break
            if not dominated:
                singles.append(i)
        if len(singles) > 4:  # i 4 attaccanti più forti
            singles = sorted(singles, key=lambda i: stats[i][0] + stats[i][1], reverse=True)[:4]
        sets += [[i] for i in singles]
        if len(free) >= 2:
            by_att = sorted(free, key=lambda i: stats[i][0], reverse=True)[:2]
            for x in by_att:
                for y in by_git[:2]:
                    if x != y and stats[y][1] > stats[x][1] and stats[x][0] > stats[y][0]:
                        sets.append([x, y])
        return sets

    def best_single_move(self) -> Optional[Tuple[str, int]]:
        """Cardo + Decumano: lo spostamento di un solo Guerriero, a Battaglia
        fatta, che migliora di più la difesa. (instance_id, zona) o None."""
        units = self.me.units

        def score(moved: Optional[Unit], zone: int) -> float:
            m = [[-1, -1], [-1, -1], [-1, -1]]
            for u in units:
                z = zone if u is moved else u.zone
                if u.dif > m[z][0]:
                    m[z][0] = u.dif
                if u.git > m[z][1]:
                    m[z][1] = u.git
            return self._defense(m[1][0], m[1][1], m[2][0], m[2][1])

        best, best_move = score(None, 0) + 1e-6, None
        for u in units:
            if u.center or u.lit:
                continue  # non sciogliere un'Orda attiva
            for z in (1, 2):
                if z != u.zone:
                    v = score(u, z)
                    if v > best:
                        best, best_move = v, (u.iid, z)
        return best_move
