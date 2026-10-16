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
 * keepVisible(ids): elementi sempre scoperti (es. «Abbandona»), con un buco
 * fermo e senza anello: non sono parte del passo, restano solo usabili.
 */

const Spotlight = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAD = 6;          // margine attorno all'elemento evidenziato
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
  let current = [];       // rettangoli attualmente disegnati [{x,y,w,h}]
  let goal = [];          // rettangoli verso cui si sta animando
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
      <div class="spotlight-rings"></div>`;
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
  function targetRect(spec) {
    const own = spec.startsWith('>');
    const el = document.getElementById(own ? spec.slice(1) : spec);
    if (!el) return null;
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

  // Il margine attorno all'elemento non esce dallo schermo: le zone larghe
  // quanto la finestra (il tuo campo, gli avversari) restano incorniciate.
  function measure() {
    const vw = window.innerWidth, vh = window.innerHeight;
    return targets
      .map(targetRect)
      .filter(Boolean)
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => {
        const x = Math.max(INSET, r.left - PAD), y = Math.max(INSET, r.top - PAD);
        const right = Math.min(vw - INSET, r.left + r.width + PAD);
        const bottom = Math.min(vh - INSET, r.top + r.height + PAD);
        return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
      });
  }

  const collapsed = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 });
  const center = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2, w: 0, h: 0 });
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const same = (a, b) => a.length === b.length && a.every((r, i) =>
    Math.abs(r.x - b[i].x) < 1 && Math.abs(r.y - b[i].y) < 1 &&
    Math.abs(r.w - b[i].w) < 1 && Math.abs(r.h - b[i].h) < 1);

  function draw(rects) {
    while (maskGroup.children.length < rects.length) {
      const hole = document.createElementNS(SVG_NS, 'rect');
      hole.setAttribute('fill', 'black');
      hole.setAttribute('rx', '10');
      maskGroup.appendChild(hole);
      const ring = document.createElement('div');
      ring.className = 'spotlight-ring';
      ringLayer.appendChild(ring);
    }
    [...maskGroup.children].forEach((hole, i) => {
      const r = rects[i];
      const ring = ringLayer.children[i];
      if (!r || r.w < 1 || r.h < 1) {
        hole.setAttribute('width', '0');
        hole.setAttribute('height', '0');
        ring.style.display = 'none';
        return;
      }
      hole.setAttribute('x', r.x);
      hole.setAttribute('y', r.y);
      hole.setAttribute('width', r.w);
      hole.setAttribute('height', r.h);
      Object.assign(ring.style, {
        display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
      });
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
      from.push(current[i] || (src ? { ...src } : collapsed(next[i] || center())));
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
        x: lerp(a.x, to[i].x, k), y: lerp(a.y, to[i].y, k),
        w: lerp(a.w, to[i].w, k), h: lerp(a.h, to[i].h, k),
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
    placePanel(next);
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
    placePanel(next);
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
