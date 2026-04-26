"""
Modelli Pydantic per Barbacane.
Rappresentano carte, istanze, giocatori e stato di gioco.
"""

from __future__ import annotations
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field, computed_field


# ---------------------------------------------------------------------------
# Modelli carte (definizioni statiche dal JSON)
# ---------------------------------------------------------------------------

class WarriorCard(BaseModel):
    id: str
    name: str
    type: str = "warrior"
    subtype: str  # "recruit" | "hero"
    species: str  # "elfo" | "nano" | "maga" | "umano"
    school: Optional[str] = None  # "anatema" | "sortilegio" | "incantesimo" | null
    cost: int
    cost_type: str = "mana"
    att: int
    git: int
    dif: int
    horde_effect: Optional[str] = None
    horde_effect_id: Optional[str] = None
    evolves_from: Optional[str] = None
    evolves_into: Optional[str] = None
    copies: int


class SpellCard(BaseModel):
    id: str
    name: str
    type: str = "spell"
    subtype: str  # "anatema" | "sortilegio" | "incantesimo"
    school: str
    cost: int
    cost_type: str = "maga"
    base_effect: str
    prodigy_effect: str
    prodigy_is_additive: bool
    effect_id: str
    copies: int


class BuildingCard(BaseModel):
    id: str
    name: str
    type: str = "building"
    cost: int
    cost_type: str = "mana"
    completion_cost: int
    base_effect: str
    complete_effect: str
    complete_is_additive: bool = False
    effect_id: str
    auto_complete: bool = False  # Cardo, Decumano
    copies: int


# ---------------------------------------------------------------------------
# Istanze di carte (oggetti in gioco con ID univoco)
# ---------------------------------------------------------------------------

class WallInstance(BaseModel):
    """Un Muro: una carta a faccia in giù in un Bastione."""
    instance_id: str  # ID univoco del muro
    base_card_id: str  # carta usata come muro
    durability: int = 1  # normalmente 1; Plasmattone crea muri da 2


class WarriorInstance(BaseModel):
    """Un Guerriero in campo."""
    instance_id: str
    base_card_id: str
    evolved_from: Optional[str] = None  # instance_id della recluta
    assigned_cards: List[str] = Field(default_factory=list)  # instance_ids (es. Trono)
    horde_active: bool = False  # questa carta è quella "segnalata" nell'Orda
    temp_modifiers: Dict[str, int] = Field(default_factory=dict)  # {"att": +2, "dif": +1, ...}

    def effective_att(self) -> int:
        from engine.cards import CARD_REGISTRY
        base = CARD_REGISTRY[self.base_card_id].att
        return base + self.temp_modifiers.get("att", 0)

    def effective_git(self) -> int:
        from engine.cards import CARD_REGISTRY
        base = CARD_REGISTRY[self.base_card_id].git
        return base + self.temp_modifiers.get("git", 0)

    def effective_dif(self) -> int:
        from engine.cards import CARD_REGISTRY
        base = CARD_REGISTRY[self.base_card_id].dif
        return base + self.temp_modifiers.get("dif", 0)


class BuildingInstance(BaseModel):
    """Una Costruzione nel Villaggio."""
    instance_id: str
    base_card_id: str
    completed: bool = False
    assigned_warrior: Optional[str] = None  # per Trono


# ---------------------------------------------------------------------------
# Regioni del campo
# ---------------------------------------------------------------------------

class Bastion(BaseModel):
    """Bastione sinistro o destro."""
    walls: List[WallInstance] = Field(default_factory=list)
    warriors: List[WarriorInstance] = Field(default_factory=list)
    dif_bonus: int = 0  # bonus temporaneo DIF (da Saracinesca, Equipotenza, ecc.)


class Village(BaseModel):
    """Villaggio: contiene le Costruzioni."""
    buildings: List[BuildingInstance] = Field(default_factory=list)


class PlayerField(BaseModel):
    """Campo di gioco di un giocatore."""
    vanguard: List[WarriorInstance] = Field(default_factory=list)   # Avanscoperta
    bastion_left: Bastion = Field(default_factory=Bastion)
    bastion_right: Bastion = Field(default_factory=Bastion)
    village: Village = Field(default_factory=Village)


# ---------------------------------------------------------------------------
# Giocatore
# ---------------------------------------------------------------------------

class Player(BaseModel):
    id: str
    name: str
    life_cards: List[str] = Field(default_factory=list)  # instance_ids delle carte-vita
    mana: int = 0
    mana_remaining: int = 0
    actions_remaining: int = 2
    hand: List[str] = Field(default_factory=list)  # instance_ids
    field: PlayerField = Field(default_factory=PlayerField)
    active_effects: List[Dict[str, Any]] = Field(default_factory=list)
    skip_mana_next_turn: bool = False  # Dazipazzi
    extra_battles: int = 0  # Eracles horde
    spell_cost_reductions: Dict[str, int] = Field(default_factory=dict)  # school -> reduction
    hordes_activated_this_turn: List[str] = Field(default_factory=list)  # "{zone}:{species}" keys
    turns_completed: int = 0

    @computed_field
    @property
    def lives(self) -> int:
        return len(self.life_cards)

    @property
    def is_alive(self) -> bool:
        return bool(self.life_cards)

    def all_warriors(self) -> List[WarriorInstance]:
        """Tutti i Guerrieri del giocatore: Avanscoperta + entrambi i Bastioni."""
        return (
            list(self.field.vanguard)
            + list(self.field.bastion_left.warriors)
            + list(self.field.bastion_right.warriors)
        )

    def mages_in_field(self) -> List[WarriorInstance]:
        """Tutte le Maghe in campo (species == 'maga')."""
        from engine.cards import CARD_REGISTRY
        return [
            w for w in self.all_warriors()
            if CARD_REGISTRY[w.base_card_id].species == "maga"
        ]

    def mages_by_school(self) -> Dict[str, int]:
        """Conteggio Maghe per scuola."""
        from engine.cards import CARD_REGISTRY
        counts: Dict[str, int] = {}
        for w in self.mages_in_field():
            school = CARD_REGISTRY[w.base_card_id].school or ""
            counts[school] = counts.get(school, 0) + 1
        return counts

    def check_horde_with_zones(self) -> List[Dict]:
        """Ritorna le Orde attive per zona: [{zone, species, warriors}].
        Un'Orda richiede almeno 3 Guerrieri della stessa Specie nella STESSA Zona."""
        from engine.cards import CARD_REGISTRY
        hordes = []
        zone_map = {
            "vanguard": self.field.vanguard,
            "bastion_left": self.field.bastion_left.warriors,
            "bastion_right": self.field.bastion_right.warriors,
        }
        for zone_name, zone_warriors in zone_map.items():
            by_species: Dict[str, List[WarriorInstance]] = {}
            for w in zone_warriors:
                sp = CARD_REGISTRY[w.base_card_id].species
                by_species.setdefault(sp, []).append(w)
            for sp, ws in by_species.items():
                if len(ws) >= 3:
                    hordes.append({"zone": zone_name, "species": sp, "warriors": ws})
        return hordes

    def check_horde(self) -> Dict[str, List[WarriorInstance]]:
        """
        Ritorna le Orde attive: {species: [warriors]} dove i guerrieri
        sono almeno 3 della stessa Specie nella STESSA Zona.
        """
        result: Dict[str, List[WarriorInstance]] = {}
        for h in self.check_horde_with_zones():
            sp = h["species"]
            if sp not in result:
                result[sp] = h["warriors"]
        return result

    def deactivate_broken_horde(self, warrior: "WarriorInstance", source_region: str) -> bool:
        """
        Da chiamare DOPO aver rimosso `warrior` da `source_region`.
        Se l'orda di quella zona era attiva e ora è rotta (<3 della stessa specie),
        disattiva i flag e i bonus stat. Ritorna True se un'orda è stata disattivata.
        """
        from engine.cards import CARD_REGISTRY, WarriorCard
        card = CARD_REGISTRY.get(warrior.base_card_id)
        if not isinstance(card, WarriorCard):
            return False
        species = card.species
        horde_key = f"{source_region}:{species}"
        if horde_key not in self.hordes_activated_this_turn:
            return False

        zone_map = {
            "vanguard": self.field.vanguard,
            "bastion_left": self.field.bastion_left.warriors,
            "bastion_right": self.field.bastion_right.warriors,
        }
        source_list = zone_map.get(source_region, [])
        same_species_remaining = sum(
            1 for w in source_list
            if isinstance(CARD_REGISTRY.get(w.base_card_id), WarriorCard)
            and CARD_REGISTRY[w.base_card_id].species == species
        )
        if same_species_remaining >= 3:
            return False

        # Orda rotta: disattiva
        self.hordes_activated_this_turn.remove(horde_key)
        for w in source_list:
            c = CARD_REGISTRY.get(w.base_card_id)
            if isinstance(c, WarriorCard) and c.species == species:
                w.horde_active = False
        warrior.horde_active = False

        # Rimuovi i bonus stat dell'Orda da active_effects
        to_remove = []
        for eff in self.active_effects:
            if eff.get("type") == "horde_stat_bonus":
                w_iid = eff.get("warrior_iid")
                if w_iid == warrior.instance_id:
                    # Il guerriero rimosso: i suoi bonus spariscono con lui
                    to_remove.append(eff)
                else:
                    for w in source_list:
                        if w.instance_id == w_iid:
                            for stat in ("att", "git", "dif"):
                                bonus = eff.get(stat, 0)
                                if bonus:
                                    w.temp_modifiers[stat] = max(0, w.temp_modifiers.get(stat, 0) - bonus)
                            to_remove.append(eff)
                            break
            elif eff.get("from_horde_key") == horde_key:
                # Effetto non-stat aggiunto da questa Orda (es. reinhold_discount, araminta_return)
                to_remove.append(eff)
        for eff in to_remove:
            if eff in self.active_effects:
                self.active_effects.remove(eff)
        return True


# ---------------------------------------------------------------------------
# Log azione
# ---------------------------------------------------------------------------

class ActionLog(BaseModel):
    turn: int
    player_id: str
    action: str
    detail: Dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Stato di Gioco
# ---------------------------------------------------------------------------

class GameState(BaseModel):
    game_id: str
    turn: int = 1
    current_player_index: int = 0
    phase: str = "action"  # action | reposition | horde | battle | draw | end
    players: List[Player]
    deck: List[str] = Field(default_factory=list)     # instance_ids nel mazzo
    discard_pile: List[str] = Field(default_factory=list)
    log: List[ActionLog] = Field(default_factory=list)
    winner_id: Optional[str] = None
    battle_done_this_turn: bool = False
    battles_remaining: int = 1  # default 1 per turno, può aumentare
    recent_events: List[Dict[str, Any]] = Field(default_factory=list)  # D10 rolls, cleared each action
    pending_search: Optional[Dict[str, Any]] = None  # set when a cerca effect awaits player choice
    turn_timer: int = 120  # secondi per turno; 0 = disattivato

    @property
    def current_player(self) -> Player:
        return self.players[self.current_player_index]

    def get_player(self, player_id: str) -> Optional[Player]:
        for p in self.players:
            if p.id == player_id:
                return p
        return None

    def alive_players(self) -> List[Player]:
        return [p for p in self.players if p.is_alive]

    def mana_for_turn(self, turn: int) -> int:
        """Mana assegnato al giocatore in base al numero di turno."""
        if turn <= 2:
            return 1
        elif turn <= 4:
            return 2
        elif turn <= 6:
            return 3
        elif turn <= 9:
            return 4
        else:
            return 5

    def add_log(self, player_id: str, action: str, **detail: Any) -> None:
        self.log.append(ActionLog(
            turn=self.turn,
            player_id=player_id,
            action=action,
            detail=dict(detail),
        ))
