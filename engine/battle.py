"""
Logica di Battaglia di Barbacane.

Flusso:
1. L'attaccante sceglie un Bastione avversario adiacente.
2. Si calcolano ATT/GIT dell'attaccante e DIF/GIT del difensore.
3. Si calcolano i danni.
4. Si applicano i danni al Bastione (rimozione Muri → perdita Vita).

Fossato (REGOLE CORRETTE):
- Base: "Non puoi essere bersaglio di attacchi con meno di 1 GIT."
- Complete: "Non puoi essere bersaglio di attacchi con meno di 3 GIT."
  Se l'ATT GIT è inferiore alla soglia, l'attacco è BLOCCATO.
"""

from __future__ import annotations
from typing import List, Optional, Tuple

from engine.models import (
    Bastion,
    GameState,
    Player,
    WarriorInstance,
)
from engine.cards import get_card, BuildingCard


class ActionError(Exception):
    """Eccezione per azioni non valide."""
    pass


# ---------------------------------------------------------------------------
# Adiacenza
# ---------------------------------------------------------------------------

def adjacent_bastions(attacker_index: int, num_players: int) -> dict:
    """
    Ritorna un dizionario con gli indici dei bastioni adiacenti.

    Il Bastione destro del giocatore X è adiacente al Bastione sinistro del
    giocatore X+1 (seduto alla sua destra).
    Il Bastione sinistro del giocatore X è adiacente al Bastione destro del
    giocatore X-1 (seduto alla sua sinistra).

    Ritorna:
    {
        "right_attacks": (defender_index, "left"),   # il mio destro attacca il sinistro del vicino di destra
        "left_attacks":  (defender_index, "right"),  # il mio sinistro attacca il destro del vicino di sinistra
    }
    """
    right = (attacker_index + 1) % num_players
    left = (attacker_index - 1) % num_players
    return {
        "right_attacks": (right, "left"),
        "left_attacks": (left, "right"),
    }


def get_valid_attack_targets(state: GameState) -> List[Tuple[int, str]]:
    """
    Ritorna la lista dei bersagli validi per il giocatore corrente.
    Ogni bersaglio è (player_index, bastion_side) dove bastion_side è "left" o "right".
    Esclude i giocatori eliminati.

    Verifica anche il Fossato: se il difensore ha un Fossato attivo e l'attaccante
    non ha GIT sufficiente, quel bersaglio è escluso.
    """
    attacker_index = state.current_player_index
    attacker = state.players[attacker_index]

    # Senza guerrieri in Avanscoperta non si può attaccare
    if not attacker.field.vanguard:
        return []

    adj = adjacent_bastions(attacker_index, len(state.players))

    # Controlla se Guerremoto è attivo (può attaccare qualsiasi bastione)
    guerremoto_active = any(
        e.get("type") == "guerremoto" and e.get("any_target")
        for e in attacker.active_effects
    )

    # Calcola GIT attaccante (usato per verifica Fossato)
    _, att_git = attacker_stats(attacker)

    if guerremoto_active:
        # Può attaccare qualsiasi bastione di qualsiasi avversario vivo
        targets = []
        for i, p in enumerate(state.players):
            if i == attacker_index or not p.is_alive:
                continue
            if p.turns_completed < 1:
                continue
            for side in ["left", "right"]:
                if not _fossato_blocks(p, side, att_git):
                    targets.append((i, side))
        return targets

    targets = []
    for direction, (defender_index, side) in adj.items():
        if defender_index == attacker_index:
            continue
        defender = state.players[defender_index]
        if not defender.is_alive:
            continue
        if defender.turns_completed < 1:
            continue
        # Verifica Fossato
        if _fossato_blocks(defender, side, att_git):
            continue
        targets.append((defender_index, side))
    return targets


def _fossato_blocks(defender: Player, bastion_side: str, attacker_git: int) -> bool:
    """
    Controlla se il Fossato del difensore blocca l'attacco dato il GIT dell'attaccante.

    - Fossato base: blocca se attacker_git < 1
    - Fossato completato: blocca se attacker_git < 3
    """
    for b_inst in defender.field.village.buildings:
        if b_inst.base_card_id == "fossato":
            threshold = 3 if b_inst.completed else 1
            if attacker_git < threshold:
                return True
    return False


# ---------------------------------------------------------------------------
# Calcolo statistiche da campo
# ---------------------------------------------------------------------------

def _effective_att(w: WarriorInstance) -> int:
    return w.effective_att()


def _effective_git(w: WarriorInstance) -> int:
    return w.effective_git()


def _effective_dif(w: WarriorInstance) -> int:
    return w.effective_dif()


def attacker_stats(attacker: Player) -> Tuple[int, int]:
    """
    Ritorna (max_ATT, max_GIT) tra tutti i Guerrieri in Avanscoperta,
    applicando i bonus da Costruzioni attive (Ariete, Catapulta).
    """
    warriors = attacker.field.vanguard
    max_att = max((_effective_att(w) for w in warriors), default=0)
    max_git = max((_effective_git(w) for w in warriors), default=0)

    # Bonus da costruzioni: Ariete (+ATT), Catapulta (+GIT)
    att_bonus = 0
    git_bonus = 0
    for b_inst in attacker.field.village.buildings:
        card = get_card(b_inst.base_card_id)
        if not isinstance(card, BuildingCard):
            continue
        if b_inst.base_card_id == "ariete":
            att_bonus += 2 if b_inst.completed else 1
        elif b_inst.base_card_id == "catapulta":
            git_bonus += 2 if b_inst.completed else 1

    return max_att + att_bonus, max_git + git_bonus


def defender_stats(defender: Player, bastion_side: str) -> Tuple[int, int]:
    """
    Ritorna (max_DIF, max_GIT) tra i Guerrieri nel Bastione bersaglio,
    applicando i bonus da Costruzioni (Saracinesca, Catapulta in difesa).
    """
    if bastion_side == "left":
        bastion: Bastion = defender.field.bastion_left
    else:
        bastion: Bastion = defender.field.bastion_right

    warriors = bastion.warriors
    max_dif = max((_effective_dif(w) for w in warriors), default=0)
    max_git = max((_effective_git(w) for w in warriors), default=0)

    # Bonus temporaneo sul bastione (da Saracinesca, Equipotenza, ecc.)
    max_dif += bastion.dif_bonus

    # Saracinesca: bonus DIF passivo da costruzione
    # Catapulta: bonus GIT anche in difesa
    for b_inst in defender.field.village.buildings:
        card = get_card(b_inst.base_card_id)
        if not isinstance(card, BuildingCard):
            continue
        if b_inst.base_card_id == "saracinesca":
            max_dif += 2 if b_inst.completed else 1
        elif b_inst.base_card_id == "catapulta":
            max_git += 2 if b_inst.completed else 1

    return max_dif, max_git


# ---------------------------------------------------------------------------
# Calcolo danni
# ---------------------------------------------------------------------------

def calculate_damage(
    att_att: int, att_git: int,
    def_dif: int, def_git: int,
) -> Tuple[int, int, int]:
    """
    Ritorna (danno_attacco, danno_gittata, danno_totale).

    - Danno da Attacco  = max(ATT_att - DIF_dif, 0)
    - Danno da Gittata  = max(GIT_att - GIT_dif, 0)
    - Danno Totale      = Danno Attacco + Danno Gittata
    """
    dmg_att = max(att_att - def_dif, 0)
    dmg_git = max(att_git - def_git, 0)
    return dmg_att, dmg_git, dmg_att + dmg_git


# ---------------------------------------------------------------------------
# Applicazione danni al Bastione
# ---------------------------------------------------------------------------

def apply_damage_to_bastion(
    state: GameState,
    defender: Player,
    bastion_side: str,
    total_damage: int,
) -> dict:
    """
    Applica `total_damage` Danni al Bastione.
    - Rimuove Muri finché il danno è assorbito (ogni Muro assorbe durability danni).
    - Se i Muri non bastano → il difensore perde 1 Vita.

    Ritorna un dict con i dettagli: walls_destroyed, life_lost.
    """
    if bastion_side == "left":
        bastion = defender.field.bastion_left
    else:
        bastion = defender.field.bastion_right

    walls_destroyed = 0
    life_lost = 0

    if total_damage <= 0:
        return {"walls_destroyed": 0, "life_lost": 0}

    remaining = total_damage
    walls_to_destroy = []

    for wall in bastion.walls:
        if remaining <= 0:
            break
        remaining -= wall.durability
        walls_to_destroy.append(wall)

    # Rimuovi i muri distrutti
    for wall in walls_to_destroy:
        bastion.walls.remove(wall)
        state.discard_pile.append(wall.instance_id)
        walls_destroyed += 1

    # Se rimangono danni dopo aver esaurito i muri → perde 1 Vita (scarta la prima carta-vita)
    if remaining > 0 and defender.life_cards:
        lost_card = defender.life_cards.pop(0)
        state.discard_pile.append(lost_card)
        life_lost = 1

    return {"walls_destroyed": walls_destroyed, "life_lost": life_lost}


def resolve_battle(
    state: GameState,
    attacker_player_index: int,
    defender_player_index: int,
    defender_bastion_side: str,
) -> dict:
    """
    Risolve una Battaglia completa.
    Verifica il Fossato prima di procedere.
    Ritorna un dict con il resoconto completo.
    """
    attacker = state.players[attacker_player_index]
    defender = state.players[defender_player_index]

    # Serve almeno un Guerriero in Avanscoperta per attaccare
    if not attacker.field.vanguard:
        raise ActionError("Non puoi attaccare senza Guerrieri in Avanscoperta.")

    if defender.turns_completed < 1:
        raise ActionError("Non puoi attaccare un giocatore che non ha ancora completato almeno un turno.")

    # Statistiche attaccante
    att_att, att_git = attacker_stats(attacker)

    # Controlla Guerremoto per bonus danni
    damage_bonus = 0
    for eff in attacker.active_effects:
        if eff.get("type") == "guerremoto":
            damage_bonus += eff.get("damage_bonus", 0)

    # Controlla decimo_anti_fossato: se il difensore ha Fossato, raddoppia la GIT dell'orda
    for eff in attacker.active_effects:
        if eff.get("type") == "decimo_anti_fossato":
            has_fossato = any(
                b.base_card_id == "fossato"
                for b in defender.field.village.buildings
            )
            if has_fossato:
                att_git *= 2

    # Verifica Fossato: blocca l'attacco se il GIT è insufficiente
    if _fossato_blocks(defender, defender_bastion_side, att_git):
        raise ActionError("Il Fossato blocca attacchi con GIT insufficiente")

    # Statistiche difensore
    def_dif, def_git = defender_stats(defender, defender_bastion_side)

    # Danni
    dmg_att, dmg_git, total_dmg = calculate_damage(att_att, att_git, def_dif, def_git)
    total_dmg += damage_bonus

    walls_destroyed = 0
    life_lost = 0

    if total_dmg > 0:
        battle_result = apply_damage_to_bastion(state, defender, defender_bastion_side, total_dmg)
        walls_destroyed = battle_result["walls_destroyed"]
        life_lost = battle_result["life_lost"]

    # Eracle horde: if damage >= 3 and effect is active, offer building destruction
    eracle_destroy_triggered = False
    eracle_targets = []
    if total_dmg >= 3:
        eracle_eff = next(
            (e for e in attacker.active_effects if e.get("type") == "eracle_destroy_building"),
            None,
        )
        if eracle_eff and defender.field.village.buildings:
            eracle_destroy_triggered = True
            eracle_targets = [
                {"instance_id": b.instance_id, "base_card_id": b.base_card_id}
                for b in defender.field.village.buildings
            ]

    result = {
        "attacker_id": attacker.id,
        "defender_id": defender.id,
        "defender_bastion": defender_bastion_side,
        "att_att": att_att,
        "att_git": att_git,
        "def_dif": def_dif,
        "def_git": def_git,
        "dmg_attack": dmg_att,
        "dmg_ranged": dmg_git,
        "total_damage": total_dmg,
        "damage_bonus": damage_bonus,
        "walls_destroyed": walls_destroyed,
        "life_lost": life_lost,
        "eracle_destroy_triggered": eracle_destroy_triggered,
        "eracle_targets": eracle_targets,
    }

    state.add_log(
        attacker.id,
        "battle",
        **result,
    )

    return result
