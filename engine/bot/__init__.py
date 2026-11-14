"""
Bot di Barbacane: il codice che gira in partita.

    play.py       il turno del Bot: azioni candidate, ricerca, Schieramento,
                  Battaglia, risposte alle scelte in sospeso; i tre livelli
    eval.py       valutazione delle posizioni: caratteristiche del tavolo,
                  i due modelli appresi (lineare e piccola rete),
                  Schieramento migliore in aritmetica
    weights.json  pesi dei modelli

I pesi li produce bot_factory/ (addestramento e misure, solo in locale): vedi
il suo README. Il server usa solo le tre funzioni esportate qui sotto.
"""

from engine.bot.play import run_bot_turn, settle_pending, waiting_for_human

__all__ = ["run_bot_turn", "settle_pending", "waiting_for_human"]
