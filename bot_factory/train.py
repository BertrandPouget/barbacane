"""
Laboratorio dei Bot: partite Bot contro Bot, addestramento e misure.
Non serve al server: si usa in locale (numpy e scipy, vedi requirements.txt)
quando cambiano le carte, le regole o le caratteristiche del modello. Ricetta,
taratura dei livelli e lezioni imparate stanno nel README.md qui accanto.

Si lancia dalla radice del progetto:

    python -m bot_factory.train selfplay --games 4000 --out bot_factory/lab/d1.npz [--league PESI...]
    python -m bot_factory.train fit --data bot_factory/lab/d1.npz [...] --out bot_factory/lab/w1.json
    python -m bot_factory.train arena A B --games 330 [--players 3]
    python -m bot_factory.train prior --out bot_factory/lab/w0.json

A e B di `arena` sono un livello ('easy', 'normal', 'hard'), un livello con un
altro rumore ('normal@0.6'), 'random', oppure un file di pesi (anche
'pesi.json+aggressivo': quei pesi con uno stile di STYLES).
"""

from __future__ import annotations
import argparse
import json
import multiprocessing as mp
import os
import random
import time
from typing import List

from engine.bot import play as bot
from engine.bot.play import Profile, PROFILES
from engine.bot.eval import BUILDINGS, FEATURES, SPECIES, Ctx, Model, default_model
from engine.game import create_game

MAX_TURNS = 240  # turni di gioco oltre i quali la partita è abbandonata (pari)


def play_game(profiles: List[Profile], record: bool = False):
    """Una partita tra Bot, uno per profilo. Ritorna (indice del vincitore o
    None, campioni [(indice giocatore, caratteristiche)], secondi per turno)."""
    state = create_game([f"B{i}" for i in range(len(profiles))])
    state.bot_player_ids = [p.id for p in state.players]
    bot.PLAYER_PROFILES = {p.id: prof for p, prof in zip(state.players, profiles)}
    samples = []
    if record:
        bot.RECORDER = lambda st, idx: samples.append(
            (idx, Ctx(st, idx, profiles[idx].model).features()))
    times = [[] for _ in profiles]
    try:
        for _ in range(MAX_TURNS):
            if state.winner_id:
                break
            idx = state.current_player_index
            t = time.perf_counter()
            bot.run_bot_turn(state)
            times[idx].append(time.perf_counter() - t)
    finally:
        bot.RECORDER = None
        bot.PLAYER_PROFILES = {}
    winner = next((i for i, p in enumerate(state.players) if p.id == state.winner_id), None)
    return winner, samples, times


# Stili di gioco per gli avversari di allenamento: lo stesso modello, con una
# preferenza in più. Giocando solo contro se stesso il Bot si assesta su
# abitudini che nessuno gli punisce (es. murarsi per turni senza schierare
# Guerrieri): avversari che giocano diversamente gliele fanno pagare.
STYLES = {
    "aggressivo": {"me_n": 1.0, "me_att": 0.8, "me_git": 0.8, "me_heroes": 0.6, "off_dmg": 1.0,
                   "op_walls_sum": -1.0, "op_walls_min": -0.5, "op_l1": 1.0, "op_l2": 0.5},
    "difensivo": {"me_walls_sum": 1.0, "me_walls_min": 1.0, "breach_l1": -1.5, "breach_l2": -1.5,
                  "breach_l3": -1.5, "me_d1": 0.5, "me_d2": 0.8, "safe_bastions": 0.5},
    "costruttore": {**{f"me_c_{b}": 0.4 for b in BUILDINGS}, **{f"me_b_{b}": 0.15 for b in BUILDINGS},
                    "mana_extra": 0.3},
    "orde": {**{f"me_sp_{sp}": 0.8 for sp in SPECIES}, "me_hordes": 1.0, "me_n": 0.6},
}


def _named(name: str) -> Profile:
    """Un livello ('easy', 'normal', 'hard'), un livello con un altro rumore
    ('normal@0.5'), 'random' (mosse utili scelte a caso: il termine di
    paragone per 'easy') o un file di pesi, giocato come 'hard'."""
    if name in PROFILES:
        return PROFILES[name]
    if "@" in name:  # "normal@0.5": quel livello con un altro rumore, per tararlo
        level, _, noise = name.partition("@")
        base = PROFILES[level]
        return Profile(depth=base.depth, beam1=base.beam1, beam2=base.beam2, noise=float(noise),
                       layout_noise=float(noise) / 2, spells=base.spells, extras=base.extras, counter=base.counter)
    if name == "random":
        return Profile(depth=1, beam1=0, beam2=0, noise=100.0, layout_noise=100.0, extras=False, counter=0.5)
    hard = PROFILES["hard"]
    path, _, style = name.partition("+")  # "pesi.json+aggressivo": quei pesi con uno stile di STYLES
    return Profile(depth=hard.depth, beam1=hard.beam1, beam2=hard.beam2, noise=0.0, layout_noise=0.0,
                   model=Model.load(path), style=STYLES[style] if style else None)


# ----- partite per l'addestramento ------------------------------------------

def _selfplay_chunk(args):
    seed, games, weights_path, league_paths = args
    import numpy as np
    random.seed(seed)
    model = Model.load(weights_path) if weights_path else default_model()
    league = [Model.load(path) for path in league_paths]

    def student(noise: float) -> Profile:
        return Profile(depth=2, beam1=4, beam2=5, noise=noise, layout_noise=noise / 2, model=model)

    xs, ys = [], []
    for _ in range(games):
        n = random.choices((2, 3, 4), weights=(70, 15, 15))[0]
        # Quasi tutti i posti giocano bene: il valore di una posizione va
        # imparato contro avversari che puniscono gli errori, altrimenti il
        # modello sottovaluta la difesa. Un po' di rumore e qualche avversario
        # debole servono a vedere posizioni varie, come quelle degli umani.
        seats = []
        for _ in range(n):
            r = random.random()
            if league and r < 0.15:
                # Campionato: pesi di giri precedenti, che giocano con uno stile
                # diverso. Senza, il Bot impara a battere solo se stesso.
                seats.append(Profile(depth=2, beam1=4, beam2=5, noise=0.1, layout_noise=0.05,
                                     model=random.choice(league)))
            elif r < 0.40:
                seats.append(Profile(depth=2, beam1=4, beam2=5, noise=0.1, layout_noise=0.05, model=model,
                                     style=random.choice(list(STYLES.values()))))
            elif r < 0.85:
                seats.append(student(random.choice((0.05, 0.1, 0.2))))
            elif r < 0.93:
                seats.append(student(0.8))
            else:
                seats.append(Profile(depth=1, beam1=0, beam2=0, noise=1.2, layout_noise=0.6, model=model))
        winner, samples, _ = play_game(seats, record=True)
        # Una partita che non finisce è una sconfitta per tutti: il modello
        # impara a non accontentarsi di difendere.
        for idx, feats in samples:
            xs.append(feats)
            ys.append(1.0 if idx == winner else 0.0)
    return np.asarray(xs, dtype=np.float32), np.asarray(ys, dtype=np.float32)


def cmd_selfplay(a) -> None:
    import numpy as np
    procs = a.procs or max(1, (os.cpu_count() or 2) - 1)
    chunk = 20
    jobs = [(a.seed + i, chunk, a.weights, a.league) for i in range(max(1, a.games // chunk))]
    xs, ys = [], []
    t0 = time.time()
    with mp.Pool(procs) as pool:
        for k, (x, y) in enumerate(pool.imap_unordered(_selfplay_chunk, jobs), 1):
            xs.append(x)
            ys.append(y)
            if k % 50 == 0 or k == len(jobs):
                print(f"  {k * chunk} partite, {sum(len(v) for v in ys)} posizioni, {time.time() - t0:.0f}s", flush=True)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    np.savez_compressed(a.out, x=np.concatenate(xs), y=np.concatenate(ys))


# ----- regressione logistica -------------------------------------------------

def _fit_linear(np, xt, yt, xv, yv, l2: float):
    from scipy.optimize import minimize

    def loss(w, xs_, ys_, reg):
        z = xs_ @ w
        ll = np.mean(np.logaddexp(0, z) - ys_ * z)
        grad = xs_.T @ (1 / (1 + np.exp(-z)) - ys_) / len(ys_)
        if reg:
            ll += reg / 2 * np.sum(w[1:] ** 2)
            grad[1:] += reg * w[1:]
        return ll, grad

    w = minimize(loss, np.zeros(xt.shape[1]), args=(xt, yt, l2), jac=True, method="L-BFGS-B",
                 options={"maxiter": 500}).x
    return w, loss(w, xv, yv, 0)[0]


def _fit_mlp(np, xt, yt, xv, yv, hidden: int, epochs: int, l2: float = 1e-5, batch: int = 512):
    """Rete a uno strato nascosto (ReLU), Adam, in numpy. Tiene i pesi
    dell'epoca con la log-loss migliore sulle posizioni di controllo."""
    rng = np.random.default_rng(0)
    n, k = xt.shape
    base = float(np.mean(yt))
    params = [
        rng.normal(0, np.sqrt(2.0 / 50), (k, hidden)).astype(np.float32),  # ~50 caratteristiche attive
        np.zeros(hidden, np.float32),
        rng.normal(0, np.sqrt(1.0 / hidden), hidden).astype(np.float32),
        np.array(np.log(base / (1 - base)), np.float32),
    ]
    m = [np.zeros_like(q) for q in params]
    v = [np.zeros_like(q) for q in params]

    def val_loss(ps):
        z = np.maximum(xv @ ps[0] + ps[1], 0) @ ps[2] + ps[3]
        return float(np.mean(np.logaddexp(0, z) - yv * z))

    best, best_params, step = float("inf"), None, 0
    for epoch in range(epochs):
        lr = 2e-3 * (0.5 ** (epoch // 6))
        order = rng.permutation(n)
        for start in range(0, n, batch):
            idx = order[start:start + batch]
            xb, yb = xt[idx], yt[idx]
            w1, b1, w2, b2 = params
            z1 = xb @ w1 + b1
            act = np.maximum(z1, 0)
            g = (1 / (1 + np.exp(-(act @ w2 + b2))) - yb) / len(yb)
            ga = np.outer(g, w2) * (z1 > 0)
            grads = [xb.T @ ga + l2 * w1, ga.sum(0), act.T @ g + l2 * w2, g.sum()]
            step += 1
            for i, gr in enumerate(grads):
                m[i] = 0.9 * m[i] + 0.1 * gr
                v[i] = 0.999 * v[i] + 0.001 * gr * gr
                params[i] = params[i] - lr * (m[i] / (1 - 0.9 ** step)) / (np.sqrt(v[i] / (1 - 0.999 ** step)) + 1e-8)
        current = val_loss(params)
        if current < best:
            best, best_params = current, [q.copy() for q in params]
    return best_params, best


def cmd_fit(a) -> None:
    import numpy as np
    xs, ys = [], []
    for path in a.data:
        d = np.load(path)
        xs.append(d["x"])
        ys.append(d["y"])
    x, y = np.concatenate(xs), np.concatenate(ys)
    n, k = x.shape
    assert k == len(FEATURES), f"dati con {k} caratteristiche, il modello ne ha {len(FEATURES)}"
    test = np.random.default_rng(0).random(n) < 0.1
    xt, yt, xv, yv = x[~test], y[~test], x[test], y[test]
    base = np.mean(yt)
    null = -(base * np.log(base) + (1 - base) * np.log(1 - base))

    w, linear_loss = _fit_linear(np, xt.astype(np.float64), yt.astype(np.float64),
                                 xv.astype(np.float64), yv.astype(np.float64), a.l2)
    out = {"weights": {name: round(float(v), 4) for name, v in zip(FEATURES, w)}}
    report = f"{n} posizioni, {k} caratteristiche; log-loss di controllo: lineare {linear_loss:.4f}"
    if a.hidden > 0:
        (w1, b1, w2, b2), mlp_loss = _fit_mlp(np, xt, yt, xv, yv, a.hidden, a.epochs)
        out["mlp"] = {
            "w1": {name: [round(float(v), 4) for v in row] for name, row in zip(FEATURES, w1)},
            "b1": [round(float(v), 4) for v in b1],
            "w2": [round(float(v), 4) for v in w2],
            "b2": round(float(b2), 4),
        }
        report += f", rete {mlp_loss:.4f}"
    print(report + f" (senza modello {null:.4f})")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))


# ----- pesi di partenza scritti a mano ---------------------------------------

def cmd_prior(a) -> None:
    w = dict(
        me_l1=-1.5, me_l2=-0.4, me_l3=0.3, me_l4=0.9, op_l1=1.5, op_l2=0.4, op_l3=-0.3, op_l4=-0.9,
        me_walls_min=0.5, me_walls_sum=0.9, op_walls_min=-0.5, op_walls_sum=-0.9,
        breach_l1=-3.0, breach_l2=-1.3, breach_l3=-0.9, slack0=-0.35, slack1=-0.2, slack2=-0.1,
        wall_loss=-0.6, breach_both=-0.8, safe_bastions=0.3, def_att_margin=0.25, def_git_margin=0.2,
        me_n=1.2, me_att=1.2, me_git=0.9, me_d1=0.5, me_d2=0.8, me_g2=0.4,
        off_att=0.4, off_git=0.3, off_blocked=-0.5, me_hordes=0.3,
        op_n=-1.2, op_att=-1.2, op_git=-0.9, op_d1=-0.5, op_d2=-0.8, op_g2=-0.4, op_mages=-0.2, op_hordes=-0.3,
        me_mages=0.3, me_heroes=0.3, mana_extra=0.3,
        hand_recruit=0.15, hand_hero=0.5, hand_hero_dead=0.05, hand_spell=0.2, hand_spell_dead=0.02,
        hand_building=0.1,
    )
    for b in BUILDINGS:
        w[f"me_b_{b}"], w[f"me_c_{b}"], w[f"op_b_{b}"], w[f"op_c_{b}"] = 0.12, 0.3, -0.12, -0.3
    for b in ("estrattore", "fucina", "fossato"):
        w[f"me_c_{b}"], w[f"op_c_{b}"] = 0.55, -0.55
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"weights": w}, f, separators=(",", ":"))


# ----- confronto --------------------------------------------------------------

def _arena_chunk(args):
    seed, games, name_a, name_b, players = args
    random.seed(seed)
    pa, pb = _named(name_a), _named(name_b)
    wins = [0, 0, 0]
    ta, tb = [], []
    for g in range(games):
        # A in un posto a rotazione, B in tutti gli altri
        seat_a = g % players
        seats = [pa if i == seat_a else pb for i in range(players)]
        winner, _, times = play_game(seats)
        for i, ts in enumerate(times):
            (ta if i == seat_a else tb).extend(ts)
        wins[2 if winner is None else 0 if winner == seat_a else 1] += 1
    return wins, ta, tb


def cmd_arena(a) -> None:
    procs = a.procs or max(1, (os.cpu_count() or 2) - 1)
    chunk = max(1, a.games // (procs * 4))
    jobs = [(a.seed + i, chunk, a.a, a.b, a.players) for i in range(a.games // chunk)]
    wins, ta, tb = [0, 0, 0], [], []
    with mp.Pool(procs) as pool:
        for w, xa, xb in pool.imap_unordered(_arena_chunk, jobs):
            wins = [p + q for p, q in zip(wins, w)]
            ta += xa
            tb += xb
    total = sum(wins)

    def ms(ts):
        ts.sort()
        return f"turno medio {1000 * sum(ts) / len(ts):.0f} ms, p95 {1000 * ts[int(len(ts) * .95)]:.0f} ms"

    print(f"{a.a} {wins[0]} ({100 * wins[0] / total:.1f}%) - {a.b} {wins[1]} - pari {wins[2]}"
          f"  [{a.players} giocatori: A da solo contro {a.players - 1} B, atteso {100 / a.players:.0f}%]")
    print(f"  {a.a}: {ms(ta)}\n  {a.b}: {ms(tb)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("selfplay")
    s.add_argument("--games", type=int, default=2000)
    s.add_argument("--out", required=True)
    s.add_argument("--weights", default=None)
    s.add_argument("--league", nargs="*", default=[], help="pesi di giri precedenti, come avversari")
    s.add_argument("--seed", type=int, default=int(time.time()) % 100000)
    s.add_argument("--procs", type=int, default=0)
    s.set_defaults(fn=cmd_selfplay)
    s = sub.add_parser("fit")
    s.add_argument("--data", nargs="+", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--l2", type=float, default=1e-4)
    s.add_argument("--hidden", type=int, default=32, help="neuroni della rete (0: solo il lineare)")
    s.add_argument("--epochs", type=int, default=18)
    s.set_defaults(fn=cmd_fit)
    s = sub.add_parser("prior")
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_prior)
    s = sub.add_parser("arena")
    s.add_argument("a")
    s.add_argument("b")
    s.add_argument("--games", type=int, default=200)
    s.add_argument("--players", type=int, default=2)
    s.add_argument("--seed", type=int, default=1)
    s.add_argument("--procs", type=int, default=0)
    s.set_defaults(fn=cmd_arena)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
