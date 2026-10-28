/**
 * spotlight.js — "Occhio di bue" dei tutorial, condiviso da desktop e mobile.
 *
 * Scurisce tutto lo schermo tranne gli elementi evidenziati: una maschera SVG
 * con un buco per ogni elemento (a differenza di un unico box-shadow, regge
 * più zone evidenziate insieme) e un anello dorato attorno a ciascuno. Quando
 * cambia il passo, buchi e anelli scivolano dalla vecchia alla nuova posizione.
 * Il pannello del tutorial sta al centro, o dov'era, finché non copre le zone
 * evidenziate né le informazioni utili indicate dal client (opts.avoid);
 * altrimenti scivola nel posto libero più vicino (placePanel).
 *
 * Tutto lo strato è "click-through" (pointer-events: none): il campo resta
 * giocabile sotto. Lo stile (colori, z-index) è nel CSS di ciascun client.
 *
 * Ogni zona è un poligono convesso con gli angoli ad arco: il rettangolo
 * dell'elemento o, per una sagoma SVG con `data-spot-points` ("x,y x,y …"
 * nelle sue unità, più `data-spot-radius` per il raggio dei suoi angoli),
 * la sagoma stessa (i triangoli del campo mobile). Due zone vicine si
 * dividono lo spazio tra loro: gli anelli, tagliati dal lato del vicino, non
 * si toccano.
 *
 * keepVisible(ids): elementi sempre scoperti (es. «Abbandona»), con un buco
 * fermo e senza anello: non sono parte del passo, restano solo usabili.
 */

const Spotlight = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAD = 6;          // margine attorno all'elemento evidenziato
  const RADIUS = 4;       // raggio degli angoli di un rettangolo, prima del margine
  const SEP = 6;          // distanza minima tra due anelli
  const OVERLAP = 4;      // zone sovrapposte di più (una dentro l'altra): i loro anelli non si tagliano
  const SAMPLES = 160;    // punti di un contorno durante lo scivolamento
  const ARC_STEP = Math.PI / 24; // passo degli archi agli angoli
  const INSET = 4;        // distanza minima dell'anello dal bordo dello schermo
  const GAP = 14;         // distanza tra zona evidenziata e pannello
  const EDGE = 12;        // margine minimo del pannello dal bordo schermo
  const DURATION = 380;   // durata dello scivolamento, ms
  const GRID = 16;        // passo della griglia di posizioni provate per il pannello
  const STAY_SLACK = 0.25; // quanto si accetta di coprire in più per tornare al centro, in pannelli
  const IMPORTANT = 20;    // peso (opts.avoid) da cui un'informazione coperta fa spostare il pannello
  const NEAR_MID = 80;     // entro questa distanza dal centro, il pannello conta come centrato
  const MOVE_COST = 15;    // area (px², pesata) che vale un pixel di spostamento del pannello

  let root = null, maskGroup = null, keepGroup = null, ringLayer = null;
  let targets = [];       // id degli elementi DOM da evidenziare
  let keepIds = [];       // id degli elementi sempre scoperti (keepVisible)
  let panel = null;       // pannello da posizionare accanto
  let centered = false;   // pannello fermo al centro anche con zone evidenziate
  let atTop = false;      // pannello in cima (true) o subito sotto l'elemento con quell'id
  let avoidSel = [];      // selettori delle informazioni da non coprire (opts.avoid)
  let preferCenter = false; // torna al centro appena lì non copre l'importante (opts.preferCenter)
  let placed = null;      // ultima posizione del pannello {left, top}: ci resta finché non copre le zone
  let current = [];       // contorni attualmente disegnati [{pts, poly?, box?}]
  let goal = [];          // contorni verso cui si sta animando
  let anim = null;
  let pollTimer = null;
  let visible = false;

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'spotlight';
    root.hidden = true;
    root.innerHTML = `
      <svg class="spotlight-shade" width="100%" height="100%" aria-hidden="true">
        <defs><mask id="spotlight-mask" maskUnits="userSpaceOnUse">
          <rect x="0" y="0" width="100%" height="100%" fill="white"></rect>
          <g></g>
          <g class="spotlight-keep"></g>
        </mask></defs>
        <rect x="0" y="0" width="100%" height="100%" mask="url(#spotlight-mask)"></rect>
      </svg>
      <svg class="spotlight-rings" width="100%" height="100%" aria-hidden="true"></svg>`;
    document.body.appendChild(root);
    maskGroup = root.querySelector('mask g:not(.spotlight-keep)');
    keepGroup = root.querySelector('mask g.spotlight-keep');
    ringLayer = root.querySelector('.spotlight-rings');
    window.addEventListener('resize', () => refresh(true));
    document.addEventListener('scroll', () => refresh(true), true);
  }

  // Gli elementi si ricercano per id a ogni misura: parte dell'interfaccia
  // (es. i pulsanti del dock mobile) viene ricreata a ogni aggiornamento di
  // stato, e un riferimento diretto punterebbe a un nodo ormai staccato.
  // Un id preceduto da ">" (es. ">hand-cards") evidenzia solo l'ingombro dei
  // figli, ritagliato sul contenitore: la mano è una fascia larga quanto lo
  // schermo, ma va illuminata solo dove ci sono le carte.
  function targetRect(el, own) {
    const box = el.getBoundingClientRect();
    if (!own) return box;
    // Con i figli diretti dei figli: il badge del costo sporge dalla carta
    const kids = [...el.children]
      .flatMap(c => [c, ...c.children])
      .map(c => c.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
    if (!kids.length) return box;
    const left = Math.max(box.left, Math.min(...kids.map(r => r.left)));
    const right = Math.min(box.right, Math.max(...kids.map(r => r.right)));
    const top = Math.max(box.top, Math.min(...kids.map(r => r.top)));
    const bottom = Math.min(box.bottom, Math.max(...kids.map(r => r.bottom)));
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  // Zona di un elemento in pixel dello schermo: {pts (poligono convesso), rc
  // (raggio dei suoi angoli)}. Una sagoma SVG con data-spot-points dà i suoi
  // vertici, portati sullo schermo; il resto il suo rettangolo.
  function targetShape(spec) {
    const own = spec.startsWith('>');
    const el = document.getElementById(own ? spec.slice(1) : spec);
    if (!el) return null;
    const spot = !own && el.dataset && el.dataset.spotPoints;
    if (spot && el.getScreenCTM) {
      const box = el.getBoundingClientRect(), m = el.getScreenCTM();
      if (!m || !box.width || !box.height) return null;
      const pts = spot.trim().split(/\s+/).map(p => {
        const [x, y] = p.split(',').map(Number);
        const q = new DOMPoint(x, y).matrixTransform(m);
        return [q.x, q.y];
      });
      return { pts: hull(pts), rc: (+el.dataset.spotRadius || 0) * Math.hypot(m.a, m.b) };
    }
    const r = targetRect(el, own);
    if (!r.width || !r.height) return null;
    const right = r.left + r.width, bottom = r.top + r.height;
    return {
      pts: [[r.left, r.top], [right, r.top], [right, bottom], [r.left, bottom]],
      rc: Math.min(RADIUS, r.width / 2, r.height / 2),
    };
  }

  // Contorni delle zone evidenziate. Due zone vicine (es. Mana e Azioni) si
  // dividono lo spazio tra loro: ciascun anello è tagliato, solo dal lato del
  // vicino, a SEP/2 dalla linea di mezzo; sugli altri lati tiene il margine
  // pieno. Quelle che si sovrappongono davvero (una dentro l'altra) restano intere.
  function measure() {
    const raw = targets.map(targetShape).filter(Boolean);
    const cuts = raw.map(() => []);  // semipiani [n, limite]: si tiene p·n ≤ limite
    raw.forEach((a, i) => raw.forEach((b, j) => {
      if (j <= i) return;
      const s = separation(a.pts, b.pts);
      if (s.gap < -OVERLAP) return;
      const mid = (s.from + s.to) / 2;
      cuts[i].push([s.n, mid - SEP / 2]);
      cuts[j].push([[-s.n[0], -s.n[1]], -(mid + SEP / 2)]);
    }));
    return raw.map((s, i) => outline(s, cuts[i])).filter(Boolean);
  }

  // Contorno a distanza PAD dalla zona, con angoli ad arco di raggio rc + PAD,
  // tagliato dai semipiani `cuts` e sullo schermo: le zone larghe quanto la
  // finestra (il tuo campo, gli avversari) o che ne escono restano
  // incorniciate. poly è il contorno fitto da disegnare, pts lo stesso in
  // SAMPLES punti (per lo scivolamento), box il rettangolo che lo contiene
  // (per il pannello).
  function outline(s, cuts) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const screen = [[[-1, 0], -INSET], [[1, 0], vw - INSET], [[0, -1], -INSET], [[0, 1], vh - INSET]];
    const poly = cuts.concat(screen).reduce((p, [n, lim]) => cut(p, n, lim),
      around(inset(s.pts, s.rc), s.rc + PAD));
    if (poly.length < 3 || Math.abs(signedArea(poly)) < 1) return null;
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { poly, pts: resample(poly), box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
  }

  // ---------------------------------------------------------------------------
  // Geometria dei poligoni convessi (punti [x, y] in pixel dello schermo)
  // ---------------------------------------------------------------------------

  // Area con segno: il segno dice il verso dei vertici
  const signedArea = pts => pts.reduce((sum, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

  const centroid = pts => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];

  // Inviluppo convesso (catena monotona)
  function hull(pts) {
    const ps = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = list => {
      const out = [];
      for (const p of list) {
        while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
        out.push(p);
      }
      out.pop();
      return out;
    };
    return half(ps).concat(half(ps.slice().reverse()));
  }

  // Normale verso l'esterno del lato a→b, in un poligono di verso s (±1)
  function outward(a, b, s) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    return [s * dy / len, -s * dx / len];
  }

  // Incontro delle rette [punto, direzione] (null se parallele)
  function meet([p, u], [q, v]) {
    const den = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den;
    return [p[0] + u[0] * t, p[1] + u[1] * t];
  }

  // Il poligono con i lati spostati verso l'interno di d; se così si
  // rovescerebbe (zona troppo piccola), d si dimezza
  function inset(pts, d) {
    const s = Math.sign(signedArea(pts)) || 1;
    for (let k = 0; k < 8 && d > 0.1; k++, d /= 2) {
      const lines = pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length], n = outward(a, b, s);
        return [[a[0] - n[0] * d, a[1] - n[1] * d], [b[0] - a[0], b[1] - a[1]]];
      });
      const out = lines.map((l, i) => meet(lines[(i + lines.length - 1) % lines.length], l));
      if (out.every(Boolean) && signedArea(out) * s > 1) return out;
    }
    return pts;
  }

  // Contorno a distanza rad dal poligono: lati paralleli e archi agli angoli
  function around(core, rad) {
    const s = Math.sign(signedArea(core)) || 1, n = core.length, out = [];
    core.forEach((v, i) => {
      const n1 = outward(core[(i + n - 1) % n], v, s), n2 = outward(v, core[(i + 1) % n], s);
      const a1 = Math.atan2(n1[1], n1[0]);
      let turn = Math.atan2(n2[1], n2[0]) - a1;
      turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
      const steps = Math.max(1, Math.ceil(Math.abs(turn) / ARC_STEP));
      for (let k = 0; k <= steps; k++) {
        const a = a1 + turn * k / steps;
        out.push([v[0] + rad * Math.cos(a), v[1] + rad * Math.sin(a)]);
      }
    });
    return out;
  }

  // La parte del poligono con p·n ≤ lim
  function cut(poly, n, lim) {
    const side = p => p[0] * n[0] + p[1] * n[1] - lim;
    const out = [];
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
      if (sp <= 0) out.push(p);
      if ((sp <= 0) !== (sq <= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    });
    return out;
  }

  // Miglior asse separatore tra due poligoni convessi: {gap, n, from, to}, con
  // n da a verso b, from = sporgenza massima di a lungo n, to = minima di b e
  // gap = to − from (negativo se si sovrappongono; mai più della distanza vera)
  function separation(a, b) {
    let best = null;
    [[a, b, 1], [b, a, -1]].forEach(([p, q, k]) => {
      const s = Math.sign(signedArea(p)) || 1;
      p.forEach((v, i) => {
        const o = outward(v, p[(i + 1) % p.length], s);
        const proj = pt => pt[0] * o[0] + pt[1] * o[1];
        const gap = Math.min(...q.map(proj)) - Math.max(...p.map(proj));
        if (best && gap <= best.gap) return;
        const n = [k * o[0], k * o[1]];
        const along = pt => pt[0] * n[0] + pt[1] * n[1];
        best = { gap, n, from: Math.max(...a.map(along)), to: Math.min(...b.map(along)) };
      });
    });
    return best;
  }

  // SAMPLES punti equidistanti sul contorno, sempre nello stesso verso e a
  // partire da quello sopra il centro: nello scivolamento una zona si deforma
  // nell'altra senza torcersi
  function resample(poly) {
    let pts = signedArea(poly) < 0 ? poly.slice().reverse() : poly;
    const c = centroid(pts);
    let start = 0, best = Infinity;
    pts.forEach((p, i) => {
      const a = Math.abs(Math.atan2(p[0] - c[0], c[1] - p[1]));
      if (a < best) { best = a; start = i; }
    });
    pts = pts.slice(start).concat(pts.slice(0, start));
    const lens = [0];
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      lens.push(lens[i] + Math.hypot(q[0] - p[0], q[1] - p[1]));
    });
    const total = lens[pts.length], out = [];
    let j = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const at = total * k / SAMPLES;
      while (j < pts.length - 1 && lens[j + 1] < at) j++;
      const p = pts[j], q = pts[(j + 1) % pts.length], seg = lens[j + 1] - lens[j];
      const t = seg ? (at - lens[j]) / seg : 0;
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Disegno e scivolamento
  // ---------------------------------------------------------------------------

  const collapsed = s => { const c = centroid(s.pts); return { pts: s.pts.map(() => c) }; };
  const center = () => ({ pts: Array(SAMPLES).fill([window.innerWidth / 2, window.innerHeight / 2]) });
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const same = (a, b) => a.length === b.length && a.every((s, i) => s.pts.every((p, j) =>
    Math.abs(p[0] - b[i].pts[j][0]) < 1 && Math.abs(p[1] - b[i].pts[j][1]) < 1));
  const pathOf = pts => `M${pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z`;

  // Fermi si disegna il contorno fitto (poly), durante lo scivolamento i punti
  // ricampionati
  function draw(shapes) {
    while (maskGroup.children.length < shapes.length) {
      const hole = document.createElementNS(SVG_NS, 'path');
      hole.setAttribute('fill', 'black');
      maskGroup.appendChild(hole);
      const ring = document.createElementNS(SVG_NS, 'path');
      ring.setAttribute('class', 'spotlight-ring');
      ringLayer.appendChild(ring);
    }
    [...maskGroup.children].forEach((hole, i) => {
      const s = shapes[i];
      const ring = ringLayer.children[i];
      const pts = s && (s.poly || s.pts);
      if (!pts || Math.abs(signedArea(pts)) < 1) {
        hole.setAttribute('d', '');
        ring.setAttribute('d', '');
        ring.style.display = 'none';
        return;
      }
      const d = pathOf(pts);
      hole.setAttribute('d', d);
      ring.setAttribute('d', d);
      ring.style.display = '';
    });
  }

  // Buchi fermi per gli elementi sempre scoperti (keepVisible), senza anello
  function drawKeep() {
    if (!keepGroup) return;
    const rects = keepIds.map(id => document.getElementById(id))
      .filter(Boolean).map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
    keepGroup.replaceChildren(...rects.map(r => {
      const hole = document.createElementNS(SVG_NS, 'rect');
      hole.setAttribute('fill', 'black');
      hole.setAttribute('rx', '6');
      hole.setAttribute('x', r.left - 3);
      hole.setAttribute('y', r.top - 3);
      hole.setAttribute('width', r.width + 6);
      hole.setAttribute('height', r.height + 6);
      return hole;
    }));
  }

  function keepVisible(ids) {
    keepIds = (ids || []).filter(Boolean);
    if (visible) drawKeep();
  }

  // Anima da `current` a `next`. Un buco nuovo nasce dall'ultimo buco già
  // aperto (o, se non ce n'erano, si apre dal proprio centro); uno che
  // sparisce si richiude su sé stesso.
  function animateTo(next, duration) {
    if (anim) cancelAnimationFrame(anim);
    const n = Math.max(current.length, next.length);
    const from = [], to = [];
    for (let i = 0; i < n; i++) {
      const src = current[i] || current[current.length - 1];
      to.push(next[i] || collapsed(current[i]));
      from.push(current[i] || (src ? { pts: src.pts } : collapsed(next[i] || center())));
    }
    goal = next;
    if (!duration) {
      current = next.slice();
      draw(current);
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = ease(t);
      current = from.map((a, i) => ({
        pts: a.pts.map((p, j) => [lerp(p[0], to[i].pts[j][0], k), lerp(p[1], to[i].pts[j][1], k)]),
      }));
      draw(current);
      if (t < 1) {
        anim = requestAnimationFrame(step);
      } else {
        anim = null;
        current = next.slice();
        draw(current);
      }
    };
    anim = requestAnimationFrame(step);
  }

  // Rettangoli delle informazioni da non coprire se si può (opts.avoid: un
  // selettore, o [selettore, peso] per ciò che conta di più, come i pulsanti):
  // nascosti e vuoti non contano
  function measureAvoid() {
    return avoidSel.flatMap(item => {
      const [sel, weight] = Array.isArray(item) ? item : [item, 1];
      return [...document.querySelectorAll(sel)]
        .filter(el => el !== panel && !panel.contains(el))
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ x: r.left, y: r.top, w: r.width, h: r.height, k: weight }));
    });
  }

  // Piazza il pannello. Le zone evidenziate non si coprono mai, se c'è un
  // posto libero; le informazioni utili indicate dal client (opts.avoid: carte
  // in campo, Mana e Azioni, pulsanti…) il meno possibile. Vince il centro se
  // lì non copre nulla (con opts.preferCenter, se non copre zone evidenziate né
  // informazioni importanti, o il posto così più vicino al centro); se no il
  // pannello resta dov'era, finché non copre zone
  // evidenziate o informazioni importanti; solo allora si sposta, nel posto
  // che copre meno vicino a dov'era, o al centro se copre poco di più (freeSpot). Senza zone evidenziate, o con `center`: al centro
  // (così il pannello non salta tra passi di spiegazione consecutivi). Con
  // `top`: in cima allo schermo, per lasciare libere mano e pulsanti in basso;
  // se `top` è l'id di un elemento, subito sotto di esso (che resta visibile).
  function placePanel(rects) {
    if (!panel) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const clampX = x => Math.max(EDGE, Math.min(vw - pw - EDGE, x));
    const clampY = y => Math.max(EDGE, Math.min(vh - ph - EDGE, y));
    let topY = EDGE;
    const anchor = typeof atTop === 'string' && document.getElementById(atTop);
    if (anchor) topY = anchor.getBoundingClientRect().bottom + GAP;
    let best = { left: (vw - pw) / 2, top: atTop ? topY : (vh - ph) / 2 };
    // Già quasi al centro: resta dov'è, così non scatta quando cambia altezza
    if (!atTop && placed && Math.hypot(clampX(placed.left) - clampX(best.left),
      clampY(placed.top) - clampY(best.top)) < NEAR_MID) best = placed;
    if (rects.length && !centered && !atTop) best = freeSpot(rects, measureAvoid(), pw, ph, clampX, clampY);
    placed = { left: Math.round(clampX(best.left)), top: Math.round(clampY(best.top)) };
    panel.style.left = `${placed.left}px`;
    panel.style.top = `${placed.top}px`;
  }

  function freeSpot(rects, soft, pw, ph, clampX, clampY) {
    const vw = window.innerWidth, vh = window.innerHeight;
    // Area coperta dal pannello in c, con un margine m attorno ai rettangoli
    const area = (c, list, m) => list.reduce((sum, r) => {
      const w = Math.min(c.left + pw, r.x + r.w + m) - Math.max(c.left, r.x - m);
      const h = Math.min(c.top + ph, r.y + r.h + m) - Math.max(c.top, r.y - m);
      return sum + (w > 0 && h > 0 ? w * h * (r.k || 1) : 0);
    }, 0);
    // Delle zone evidenziate conta la parte coperta di ciascuna, non l'area: un
    // pulsante coperto tutto è peggio del bordo di un riquadro grande
    const covered = c => rects.reduce((sum, r) => sum + area(c, [r], GAP / 2) / Math.max(1, r.w * r.h), 0);
    const cost = c => covered(c) * 1e9 + area(c, soft, 4);
    let mid = { left: clampX((vw - pw) / 2), top: clampY((vh - ph) / 2) };
    const stay = placed && { left: clampX(placed.left), top: clampY(placed.top) };
    // Già quasi al centro: il centro è dov'è (cambiando altezza non scatta)
    if (stay && Math.hypot(stay.left - mid.left, stay.top - mid.top) < NEAR_MID) mid = stay;
    // Informazioni importanti: peso IMPORTANT (es. Azioni, Mana, pulsanti)
    const important = soft.filter(r => (r.k || 1) >= IMPORTANT);
    const keeps = c => area(c, rects, GAP / 2) === 0 && area(c, important, 4) === 0;
    const steps = (lo, hi) => {
      const out = [];
      for (let v = lo; v < hi; v += GRID) out.push(v);
      out.push(Math.max(lo, hi));
      return out;
    };
    const grid = [];
    for (const top of steps(EDGE, vh - ph - EDGE)) {
      for (const left of steps(EDGE, vw - pw - EDGE)) grid.push({ left: clampX(left), top: clampY(top) });
    }
    const dist = (a, b) => Math.hypot(a.left - b.left, a.top - b.top);
    // Con preferCenter il pannello tende al centro: il centro se non copre
    // l'importante, se no il posto che non lo copre più vicino al centro (la
    // posizione di prima, se è lì vicino, così non scatta)
    if (preferCenter) {
      if (keeps(mid)) return mid;
      let near = null;
      for (const c of grid) if (keeps(c) && (!near || dist(c, mid) < dist(near, mid))) near = c;
      if (near) return stay && keeps(stay) && dist(stay, near) < NEAR_MID ? stay : near;
    }
    for (const c of [mid, stay]) if (c && cost(c) === 0) return c;
    // La posizione di prima si tiene finché non copre zone evidenziate né
    // informazioni importanti: il resto (carte, riquadri, avversari) non basta a
    // far spostare il pannello
    if (stay && keeps(stay)) return stay;
    // Nessun posto pulito: quello che copre meno sulla griglia. Il tragitto pesa
    // anche lui (MOVE_COST per pixel): tra posti quasi uguali si sceglie il più
    // vicino, invece di attraversare lo schermo
    const ref = stay || mid;
    let best = ref, bestCost = Infinity, bestScore = Infinity;
    for (const c of grid) {
      const k = cost(c);
      const score = k + MOVE_COST * dist(c, ref);
      if (score < bestScore) { best = c; bestCost = k; bestScore = score; }
    }
    // Dovendo spostarsi, torna al centro se lì non copre zone evidenziate e copre
    // poco più che nel posto migliore
    if (area(mid, rects, GAP / 2) === 0 && cost(mid) <= bestCost * 3 + STAY_SLACK * pw * ph) return mid;
    return best;
  }

  // Ricalcola le posizioni: il layout del campo cambia a ogni aggiornamento di
  // stato (carte giocate, modali, resize), quindi si controlla anche a intervalli.
  function refresh(instant) {
    if (!visible) return;
    const next = measure();
    if (!same(next, goal)) animateTo(next, instant ? 0 : DURATION);
    drawKeep();
    placePanel(next.map(s => s.box));
  }

  function show(ids, panelEl, opts = {}) {
    build();
    centered = !!opts.center;
    atTop = opts.top || false;
    avoidSel = opts.avoid || [];
    preferCenter = !!opts.preferCenter;
    targets = (ids || []).filter(Boolean);
    const wasVisible = visible;
    if (panel && panel !== panelEl) {
      panel.classList.remove('spotlight-panel-placed');
      placed = null;
    }
    panel = panelEl || null;
    // Il pannello deve stare sopra lo strato scuro: se vive dentro uno schermo
    // con un proprio contesto di sovrapposizione (z-index/transform), il suo
    // z-index non basterebbe, quindi lo si porta nel <body> accanto allo strato.
    if (panel && panel.parentNode !== document.body) document.body.appendChild(panel);
    visible = true;
    root.hidden = false;
    // Primo ingresso: i buchi si aprono dal centro dello schermo.
    if (!wasVisible) { current = []; goal = []; }
    const next = measure();
    animateTo(next, DURATION);
    drawKeep();
    placePanel(next.map(s => s.box));
    // La transizione CSS del pannello parte solo dopo il primo piazzamento,
    // così non "vola" dall'angolo in alto a sinistra quando appare.
    if (panel) requestAnimationFrame(() => panel && panel.classList.add('spotlight-panel-placed'));
    if (!pollTimer) pollTimer = setInterval(() => refresh(false), 300);
  }

  function hide() {
    visible = false;
    targets = [];
    current = [];
    goal = [];
    if (anim) { cancelAnimationFrame(anim); anim = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (panel) panel.classList.remove('spotlight-panel-placed');
    panel = null;
    if (root) {
      root.hidden = true;
      draw([]);
    }
  }

  return { show, hide, keepVisible, refresh: () => refresh(false) };
})();
