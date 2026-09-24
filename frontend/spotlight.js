/**
 * spotlight.js — "Occhio di bue" dei tutorial, condiviso da desktop e mobile.
 *
 * Scurisce tutto lo schermo tranne gli elementi evidenziati: una maschera SVG
 * con un buco per ogni elemento (a differenza di un unico box-shadow, regge
 * più zone evidenziate insieme) e un anello dorato attorno a ciascuno. Quando
 * cambia il passo, buchi e anelli scivolano dalla vecchia alla nuova posizione.
 * Il pannello del tutorial viene piazzato accanto alla zona evidenziata, dal
 * lato con più spazio libero, e scivola anche lui.
 *
 * Tutto lo strato è "click-through" (pointer-events: none): il campo resta
 * giocabile sotto. Lo stile (colori, z-index) è nel CSS di ciascun client.
 */

const Spotlight = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAD = 6;          // margine attorno all'elemento evidenziato
  const GAP = 14;         // distanza tra zona evidenziata e pannello
  const EDGE = 12;        // margine minimo del pannello dal bordo schermo
  const DURATION = 380;   // durata dello scivolamento, ms

  let root = null, maskGroup = null, ringLayer = null;
  let targets = [];       // id degli elementi DOM da evidenziare
  let panel = null;       // pannello da posizionare accanto
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
        </mask></defs>
        <rect x="0" y="0" width="100%" height="100%" mask="url(#spotlight-mask)"></rect>
      </svg>
      <div class="spotlight-rings"></div>`;
    document.body.appendChild(root);
    maskGroup = root.querySelector('mask g');
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
    const kids = [...el.children]
      .map(c => c.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
    if (!kids.length) return box;
    const left = Math.max(box.left, Math.min(...kids.map(r => r.left)));
    const right = Math.min(box.right, Math.max(...kids.map(r => r.right)));
    const top = Math.max(box.top, Math.min(...kids.map(r => r.top)));
    const bottom = Math.min(box.bottom, Math.max(...kids.map(r => r.bottom)));
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function measure() {
    return targets
      .map(targetRect)
      .filter(Boolean)
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => ({ x: r.left - PAD, y: r.top - PAD, w: r.width + 2 * PAD, h: r.height + 2 * PAD }));
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

  // Piazza il pannello dove non copre nessuna zona evidenziata. Si provano
  // prima le posizioni sotto/sopra le zone (l'insieme, poi ciascuna: utile
  // quando due zone lontane lasciano spazio in mezzo) con il pannello centrato
  // nello schermo; poi le stesse allineate alla zona; poi ai lati; infine ai
  // bordi dello schermo. Se nessun posto è libero, sceglie quello che copre
  // meno. Senza zone evidenziate: al centro.
  function placePanel(rects) {
    if (!panel) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const clampX = x => Math.max(EDGE, Math.min(vw - pw - EDGE, x));
    const clampY = y => Math.max(EDGE, Math.min(vh - ph - EDGE, y));
    let best = { left: (vw - pw) / 2, top: (vh - ph) / 2 };
    if (rects.length) {
      const u = rects.reduce((a, r) => ({
        x: Math.min(a.x, r.x), y: Math.min(a.y, r.y),
        r: Math.max(a.r, r.x + r.w), b: Math.max(a.b, r.y + r.h),
      }), { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity });
      const zones = [
        { l: u.x, t: u.y, r: u.r, b: u.b },
        ...rects.map(r => ({ l: r.x, t: r.y, r: r.x + r.w, b: r.y + r.h })),
      ];
      const screenCx = (vw - pw) / 2;
      const vertical = (z, left) => [
        { left, top: z.b + GAP },
        { left, top: z.t - GAP - ph },
      ];
      const candidates = [
        ...zones.flatMap(z => vertical(z, screenCx)),
        ...zones.flatMap(z => vertical(z, (z.l + z.r) / 2 - pw / 2)),
        ...zones.flatMap(z => [
          { left: z.r + GAP, top: (z.t + z.b) / 2 - ph / 2 },
          { left: z.l - GAP - pw, top: (z.t + z.b) / 2 - ph / 2 },
        ]),
        { left: screenCx, top: vh - ph - EDGE },
        { left: screenCx, top: EDGE },
      ].map(c => ({ left: clampX(c.left), top: clampY(c.top) }));
      const overlap = c => rects.reduce((sum, r) => {
        const w = Math.min(c.left + pw, r.x + r.w) - Math.max(c.left, r.x);
        const h = Math.min(c.top + ph, r.y + r.h) - Math.max(c.top, r.y);
        return sum + (w > 0 && h > 0 ? w * h : 0);
      }, 0);
      let bestOverlap = Infinity;
      for (const c of candidates) {
        const o = overlap(c);
        if (o < bestOverlap) { best = c; bestOverlap = o; }
        if (o === 0) break;
      }
    }
    panel.style.left = `${Math.round(clampX(best.left))}px`;
    panel.style.top = `${Math.round(clampY(best.top))}px`;
  }

  // Ricalcola le posizioni: il layout del campo cambia a ogni aggiornamento di
  // stato (carte giocate, modali, resize), quindi si controlla anche a intervalli.
  function refresh(instant) {
    if (!visible) return;
    const next = measure();
    if (!same(next, goal)) animateTo(next, instant ? 0 : DURATION);
    placePanel(next);
  }

  function show(ids, panelEl) {
    build();
    targets = (ids || []).filter(Boolean);
    const wasVisible = visible;
    if (panel && panel !== panelEl) panel.classList.remove('spotlight-panel-placed');
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

  return { show, hide, refresh: () => refresh(false) };
})();
