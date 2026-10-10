/**
 * dice.js — Lancio del D10 a schermo, condiviso da desktop e mobile.
 *
 * Quando una carta del giocatore lancia un D10 (Estrattore, Granaio, Fucina,
 * Obelisco), il server aggiunge a `recent_events` un evento `d10` con un
 * `roll_id` univoco. Qui ogni tiro proprio viene mostrato una volta sola in
 * una finestra (stile delle finestre di gioco) con il nome della carta, il motivo del lancio (il testo della
 * carta) e un dado tridimensionale che rotola e si ferma sul numero uscito.
 * I tiri degli avversari restano solo nella cronaca.
 *
 * Il dado è un vero D10 (trapezoedro pentagonale) disegnato su canvas con
 * proiezione ortografica: niente librerie. Lo stile della finestra (classi
 * .dice-*) è nel CSS di ciascun client; i colori del dado sono qui sotto,
 * presi dalla palette delle carte (esagono del Mana, inchiostro, bordo).
 */

const Dice = (() => {
  const COLORS = {
    face:  [236, 168, 44],    // ambra dell'esagono del Mana
    edge:  '#5a3518',         // --hex-border
    ink:   '#3a1d06',         // numeri
    glow:  'rgba(251, 196, 2, 0.55)',
  };
  const ROLL_MS = 1500;       // durata del rotolamento
  const HOLD_MS = 2300;       // permanenza dopo l'esito (salvo clic)
  // Canvas in px CSS. Nel layout occupa solo BOX_W × BOX_H (margini negativi):
  // il resto serve al dado che rimbalza, che può passare sopra il testo.
  const CW = 320, CH = 260, BOX_W = 230, BOX_H = 176;

  // ---------------------------------------------------------------------------
  // Geometria: due apici sull'asse y e un anello di 10 vertici a zig-zag.
  // Con H = Z0 (1 + cos36°) / (1 − cos36°) le facce (aquiloni) sono piane.
  // ---------------------------------------------------------------------------

  const R = 1, Z0 = 0.108;
  const C36 = Math.cos(Math.PI / 5);
  const H = Z0 * (1 + C36) / (1 - C36);
  const TOP = [0, H, 0], BOTTOM = [0, -H, 0];
  const RING = Array.from({ length: 10 }, (_, k) => {
    const a = k * Math.PI / 5;
    return [R * Math.cos(a), k % 2 ? -Z0 : Z0, R * Math.sin(a)];
  });
  // Numeri delle facce superiori e inferiori (opposte in modo da alternarsi)
  const UPPER_NUMS = [1, 7, 3, 9, 5];
  const LOWER_NUMS = [6, 2, 8, 4, 10];

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));

  // Ogni faccia: vertici [apice, lato, punta, lato], normale esterna, e una
  // terna (centro, destra, su) su cui disegnare il numero, dritto verso l'apice.
  const FACES = [];
  function makeFace(apex, s1, far, s2, num) {
    let n = norm(cross(sub(s1, apex), sub(s2, apex)));
    const centroid = mul(add(add(apex, s1), add(far, s2)), 0.25);
    if (dot(n, centroid) < 0) n = mul(n, -1);
    const sideMid = mul(add(s1, s2), 0.5);
    let up = sub(apex, far);
    up = norm(sub(up, mul(n, dot(up, n))));
    const right = cross(up, n);
    const center = add(mul(sideMid, 0.82), mul(apex, 0.18));
    FACES.push({ pts: [apex, s1, far, s2], n, up, right, center, num });
  }
  for (let i = 0; i < 5; i++) {
    makeFace(TOP, RING[2 * i], RING[2 * i + 1], RING[(2 * i + 2) % 10], UPPER_NUMS[i]);
    makeFace(BOTTOM, RING[2 * i + 1], RING[(2 * i + 2) % 10], RING[(2 * i + 3) % 10], LOWER_NUMS[i]);
  }

  // Matrici 3×3 come array di righe
  const mmul = (A, B) => A.map(row => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  const mvec = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
  const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  function rotAxis(axis, a) {
    const [x, y, z] = axis, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [
      [t * x * x + c,     t * x * y - s * z, t * x * z + s * y],
      [t * x * y + s * z, t * y * y + c,     t * y * z - s * x],
      [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ];
  }

  // Orientamento finale: la faccia del numero di fronte, con l'apice in alto,
  // inclinata di 15° verso lo spettatore così da vedere sotto le due facce
  // inferiori; simmetrica rispetto all'asse verticale.
  function restingMatrix(num) {
    const f = FACES.find(x => x.num === num) || FACES[0];
    return mmul(rotX(-15 * Math.PI / 180), [f.right, f.up, f.n]);
  }

  // Riquadro che contiene la sagoma del dado
  function silhouetteCenter(M) {
    const pts = [TOP, BOTTOM, ...RING].map(p => mvec(M, p));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    // [x, y] del centro e semialtezza
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2,
            (Math.max(...ys) - Math.min(...ys)) / 2];
  }

  const LIGHT = norm([0, 0.6, 1]);  // dall'alto e di fronte: ombreggiatura simmetrica

  function draw(ctx, M, cx, cy, S, highlight) {
    for (const f of FACES) {
      const n = mvec(M, f.n);
      if (n[2] <= 0.001) continue;  // faccia nascosta (il solido è convesso)
      const pts = f.pts.map(p => mvec(M, p));
      const diffuse = Math.max(0, dot(n, LIGHT));
      const spec = Math.pow(Math.max(0, n[2] * 0.6 + dot(n, LIGHT) * 0.4), 18) * 0.35;
      const k = 0.48 + 0.6 * diffuse;
      const [r, g, b] = COLORS.face.map(c => Math.min(255, Math.round(c * k + 255 * spec)));
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = cx + p[0] * S, y = cy - p[1] * S;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.edge;
      ctx.stroke();

      // Numero: trasformazione affine dal piano della faccia allo schermo
      // (le unità del testo sono centesimi di raggio)
      const P = mvec(M, f.center), RR = mvec(M, f.right), UU = mvec(M, f.up);
      const u = S / 100;
      ctx.save();
      ctx.transform(u * RR[0], -u * RR[1], -u * UU[0], u * UU[1], cx + P[0] * S, cy - P[1] * S);
      ctx.globalAlpha = Math.min(1, n[2] * 2.2);
      ctx.fillStyle = (highlight && highlight === f.num) ? '#000' : COLORS.ink;
      ctx.font = `bold ${f.num === 10 ? 34 : 42}px Caudex, Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(f.num), 0, 2);
      if (f.num === 6 || f.num === 9) ctx.fillRect(-11, 25, 22, 4);  // distingue 6 da 9
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // Animazione
  // ---------------------------------------------------------------------------

  function reducedMotion() {
    return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function animate(canvas, num, onLand) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(CW * dpr);
    canvas.height = Math.round(CH * dpr);
    canvas.style.width = CW + 'px';
    canvas.style.height = CH + 'px';
    canvas.style.margin = `${(BOX_H - CH) / 2}px ${(BOX_W - CW) / 2}px`;
    const ctx = canvas.getContext('2d');
    const rest = restingMatrix(num);
    const axis = norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
    const turns = (3 + Math.random() * 1.5) * Math.PI * 2;
    const S = BOX_H * 0.4, cx = CW / 2, cy = CH / 2;
    // A fine corsa la sagoma del dado sta al centro del canvas
    const fc = silhouetteCenter(rest);
    const restX = cx - fc[0] * S, restY = cy + fc[1] * S;
    const groundY = cy + fc[2] * S - 2;  // sotto la punta inferiore a riposo
    // Entra da un lato o dal basso (mai dall'alto, dove c'è il testo) e scivola al centro
    const ang = Math.random() * Math.PI * 2;
    const driftX = Math.cos(ang) * BOX_W * 0.16, driftY = Math.abs(Math.sin(ang)) * BOX_H * 0.12;
    const start = performance.now();
    let raf = 0, landed = false;

    function frame(now) {
      const t = reducedMotion() ? 1 : Math.min(1, Math.max(0, (now - start) / ROLL_MS));
      const ease = 1 - Math.pow(1 - t, 3);
      const M = mmul(rest, rotAxis(axis, turns * (1 - ease)));
      // Rimbalzi sempre più bassi, con l'ombra a terra che si stringe quando
      // il dado è in aria
      const lift = Math.abs(Math.sin(Math.PI * 3.2 * Math.pow(t, 0.75))) * Math.pow(1 - t, 1.6);
      const slide = Math.pow(1 - t, 3);
      const x = restX + driftX * slide, y = restY + driftY * slide - lift * S * 0.55;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, CW, CH);
      ctx.fillStyle = `rgba(0, 0, 0, ${0.45 - 0.25 * lift})`;
      ctx.beginPath();
      ctx.ellipse(restX + driftX * slide, groundY + driftY * slide, S * (0.75 - 0.25 * lift), S * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      if (t >= 1) {
        ctx.shadowColor = COLORS.glow;
        ctx.shadowBlur = 22;
      }
      draw(ctx, M, x, y, S, t >= 1 ? num : 0);
      ctx.shadowBlur = 0;

      if (t < 1) {
        raf = requestAnimationFrame(frame);
      } else if (!landed) {
        landed = true;
        onLand();
      }
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }

  // ---------------------------------------------------------------------------
  // Finestra e coda
  // ---------------------------------------------------------------------------

  const OUTCOMES = {
    estrattore: (ev) => ev.triggered ? `Ottieni ${ev.mana_gained > 1 ? ev.mana_gained + ' Mana aggiuntivi' : 'un Mana aggiuntivo'}` : 'Nessun Mana aggiuntivo',
    granaio:    (ev) => ev.triggered ? 'La mano massima aumenta di uno' : 'La mano massima non cambia',
    fucina:     (ev) => ev.extra_action ? "Ottieni un'Azione aggiuntiva" : "Nessuna Azione aggiuntiva",
    obelisco:   (ev) => ev.returned ? 'La Magia torna nella tua mano' : 'La Magia va negli scarti',
  };
  const SUCCESS = {
    estrattore: (ev) => ev.triggered,
    granaio:    (ev) => ev.triggered,
    fucina:     (ev) => ev.extra_action,
    obelisco:   (ev) => ev.returned,
  };

  const seen = new Set();
  let queue = [];
  let root = null, current = null;
  let idleCallbacks = [];

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'dice-overlay';
    root.hidden = true;
    root.innerHTML = `
      <div class="dice-panel" role="dialog" aria-live="polite">
        <div class="dice-title"></div>
        <div class="dice-reason"></div>
        <canvas class="dice-canvas" aria-hidden="true"></canvas>
        <div class="dice-result"><span class="dice-num"></span><span class="dice-outcome"></span></div>
      </div>`;
    root.addEventListener('click', () => close());
    document.body.appendChild(root);
  }

  function reasonText(ev, def) {
    if (!def) return 'Lancio di un D10.';
    // L'Obelisco completato tira con la soglia ridotta: vale il testo da completato
    if (ev.card === 'obelisco' && ev.threshold === 6 && def.complete_effect) return def.complete_effect;
    return def.base_effect || '';
  }

  function open(item) {
    build();
    const { ev, def } = item;
    const ok = (SUCCESS[ev.card] || ((e) => e.roll >= 6))(ev);
    const outcome = (OUTCOMES[ev.card] || (() => ''))(ev);
    root.querySelector('.dice-title').textContent = def ? def.name : ev.card;
    root.querySelector('.dice-reason').textContent = reasonText(ev, def);
    const result = root.querySelector('.dice-result');
    result.classList.remove('shown', 'ok', 'ko');
    result.querySelector('.dice-num').textContent = ev.roll;
    result.querySelector('.dice-outcome').textContent = outcome;
    root.hidden = false;

    const state = { timer: 0, stop: null };
    current = state;
    state.stop = animate(root.querySelector('.dice-canvas'), ev.roll, () => {
      if (current !== state) return;
      result.classList.add('shown', ok ? 'ok' : 'ko');
      state.timer = setTimeout(close, HOLD_MS);
    });
  }

  function close() {
    if (!current) return;
    clearTimeout(current.timer);
    if (current.stop) current.stop();
    current = null;
    root.hidden = true;
    if (queue.length) setTimeout(() => { if (!current && queue.length) open(queue.shift()); }, 180);
    else runIdle();
  }

  function runIdle() {
    const cbs = idleCallbacks;
    idleCallbacks = [];
    cbs.forEach(fn => fn());
  }

  /** Esegue `fn` quando non ci sono più dadi da mostrare (subito se nessuno). */
  function afterRolls(fn) {
    if (current || queue.length) idleCallbacks.push(fn);
    else fn();
  }

  /** Mostra i tiri di D10 del giocatore arrivati con questo stato. `delay`
   *  lascia finire prima il banner del cambio turno; `silent` segna i tiri
   *  come visti senza mostrarli (ingresso in partita, riconnessione: sono
   *  tiri già avvenuti). */
  function fromState(state, myPlayerId, cardDefs, opts = {}) {
    const rolls = (state.recent_events || []).filter(ev => ev.type === 'd10' && ev.roll_id);
    const mine = rolls.filter(ev => !seen.has(ev.roll_id) && ev.player_id === myPlayerId);
    rolls.forEach(ev => seen.add(ev.roll_id));
    if (opts.silent || !mine.length) return;
    queue.push(...mine.map(ev => ({ ev, def: cardDefs && cardDefs[ev.card] })));
    if (current) return;
    setTimeout(() => { if (!current && queue.length) open(queue.shift()); }, opts.delay || 0);
  }

  return { fromState, afterRolls };
})();
