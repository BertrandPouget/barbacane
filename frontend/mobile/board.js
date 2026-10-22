/**
 * board.js — Il campo del client mobile: le Regioni sono triangoli dipinti su
 * un terreno, come in una mappa.
 *
 * Al centro le quattro Regioni del giocatore osservato (di solito io): in alto
 * l'Avanscoperta, sotto il Villaggio, ai lati i due Bastioni. Attorno, le
 * Regioni dei suoi vicini vivi: accanto all'Avanscoperta i loro Bastioni
 * esposti (quelli che si possono attaccare), accanto ai Bastioni le loro
 * Avanscoperte (che possono attaccarli), ai lati i loro Villaggi. Il vicino di
 * sinistra espone il suo Bastione destro, quello di destra il sinistro (vedi
 * l'adiacenza in render.js). In una partita a due l'avversario è vicino da
 * entrambi i lati e compare due volte.
 *
 * Tutto è disegnato in unità di tavola (W×H, la misura di un telefono) e scala
 * con #board:
 * - #board-art: terreno, alberi e Regioni dipinte. Non cambia mai e si
 *   costruisce una volta sola: i filtri SVG che danno la grana costano, non
 *   vanno ricalcolati a ogni aggiornamento;
 * - #board-live: le sagome toccabili (zone in cui trascinare le carte,
 *   evidenziazioni, con gli id usati dal tutorial) e i Muri di pietra;
 * - #board-ov: i numeri di ogni Regione, in HTML posizionato in percentuale.
 * Le Regioni che escono dai lati (i vicini) sono tagliate dal bordo dello schermo.
 */

'use strict';

const Board = (() => {
  const W = 390, H = 500;
  const R = 11;  // raggio degli angoli dei triangoli

  // Vertici in unità di tavola. c_* = Regioni del giocatore al centro, l_*/r_* =
  // del suo vicino vivo a sinistra/destra (region: la Regione che mostrano).
  const SHAPES = {
    c_vanguard:      { region: 'vanguard',      pal: 'vanguard',     pts: [[195, 77], [273, 268], [117, 268]] },
    c_village:       { region: 'village',       pal: 'village',      pts: [[116, 286], [274, 286], [195, 480]] },
    c_bastion_left:  { region: 'bastion_left',  pal: 'bastion',      pts: [[96, 294], [185, 493], [32, 493]] },
    c_bastion_right: { region: 'bastion_right', pal: 'bastion',      pts: [[294, 294], [358, 493], [205, 493]] },
    l_bastion:       { region: 'bastion_right', pal: 'opp-bastion',  pts: [[30, 67], [162, 67], [96, 231]] },
    r_bastion:       { region: 'bastion_left',  pal: 'opp-bastion',  pts: [[228, 67], [360, 67], [294, 231]] },
    l_village:       { region: 'village',       pal: 'opp-village',  pts: [[20, 81], [100, 268], [-60, 268]] },
    r_village:       { region: 'village',       pal: 'opp-village',  pts: [[370, 81], [450, 268], [290, 268]] },
    l_vanguard:      { region: 'vanguard',      pal: 'opp-vanguard', pts: [[-70, 286], [70, 286], [0, 465]] },
    r_vanguard:      { region: 'vanguard',      pal: 'opp-vanguard', pts: [[320, 286], [460, 286], [390, 465]] },
  };
  const SLOTS = Object.keys(SHAPES);

  // Id delle sagome: quelli delle mie Regioni sono gli stessi dei vecchi tasselli
  // (tutorial: _MOBILE_HIGHLIGHT_MAP in engine/tutorial.py; transizioni in app.js)
  const IDS = {
    c_vanguard: 'fld-vanguard', c_village: 'tw-village', c_bastion_left: 'tw-left', c_bastion_right: 'tw-right',
    l_bastion: 'opp-bl', r_bastion: 'opp-br', l_village: 'opp-tl', r_village: 'opp-tr',
    l_vanguard: 'opp-vl', r_vanguard: 'opp-vr',
  };

  // Colori delle Regioni (centro e bordo della sfumatura): quelle del giocatore
  // al centro più accese, quelle dei vicini più cupe
  const PALETTE = {
    'vanguard':     ['#d06d44', '#a2492c'],
    'bastion':      ['#b49169', '#876646'],
    'village':      ['#699a3b', '#4a7029'],
    'opp-vanguard': ['#8b3b2b', '#64281c'],
    'opp-bastion':  ['#6a5545', '#4c3b2f'],
    'opp-village':  ['#5c7432', '#3e5224'],
  };

  // Muri di pietra: lungo il lato del Bastione rivolto all'Avanscoperta che lo
  // minaccia, tra t0 e t1 del lato (da `from` a `to`)
  const WALL_EDGES = {
    c_bastion_left:  { from: [96, 294],  to: [32, 493],  t0: 0.09, t1: 0.95 },
    c_bastion_right: { from: [294, 294], to: [358, 493], t0: 0.09, t1: 0.95 },
    l_bastion:       { from: [162, 67],  to: [96, 231],  t0: 0.05, t1: 0.88 },
    r_bastion:       { from: [228, 67],  to: [294, 231], t0: 0.05, t1: 0.88 },
  };

  // Gruppi di alberi [x, y, quanti] sul terreno attorno alle Regioni (anche
  // sopra e sotto la tavola: lo SVG non è ritagliato)
  const TREES = [
    [128, 8, 3], [151, 27, 3], [176, 4, 2], [215, 5, 2], [239, 25, 3], [263, 7, 3],
    [62, 6, 2], [95, 22, 2], [26, 24, 2], [298, 18, 2], [334, 4, 2], [370, 24, 2],
    [116, 52, 2], [276, 52, 2], [6, 62, 2], [386, 66, 2],
    [170, 120, 1], [220, 118, 1], [176, 196, 1], [214, 200, 1],
    [113, 256, 2], [277, 256, 2], [98, 276, 1], [292, 276, 1],
    [4, 486, 2], [388, 490, 2], [195, 496, 1],
    [28, 522, 3], [84, 540, 2], [146, 524, 3], [198, 546, 2], [250, 526, 3], [308, 542, 2], [360, 522, 3],
  ];

  // Ciuffi d'erba attorno al mio Villaggio [x, y]
  const GRASS = [
    [118, 284], [266, 284], [134, 302], [252, 300], [160, 372], [222, 378],
    [178, 440], [207, 452], [150, 334], [236, 338],
  ];

  let mounted = false;
  const shapes = {}, overlays = {}, stones = {};
  const sigs = {}, datas = {}, owners = {};
  let liveSvg = null;
  let last = null;  // ultimo aggiornamento, rifatto se cambia la misura dello schermo
  let tapHandler = null;

  // ---------------------------------------------------------------------------
  // Geometria
  // ---------------------------------------------------------------------------

  const f1 = n => (Math.round(n * 10) / 10).toString();

  // Triangolo con gli angoli arrotondati (curve quadratiche sui vertici)
  function roundedPath(pts) {
    let d = '';
    pts.forEach((v, i) => {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[(i + 1) % pts.length];
      const a = toward(v, p), b = toward(v, q);
      d += `${i ? 'L' : 'M'}${f1(a[0])} ${f1(a[1])} Q${v[0]} ${v[1]} ${f1(b[0])} ${f1(b[1])} `;
    });
    return d + 'Z';
  }

  function toward(v, p) {
    const dx = p[0] - v[0], dy = p[1] - v[1], len = Math.hypot(dx, dy);
    const k = Math.min(R, len / 2) / len;
    return [v[0] + dx * k, v[1] + dy * k];
  }

  // Punta in su (un vertice in alto) o in giù
  function pointsUp(pts) {
    const ys = pts.map(p => p[1]).sort((a, b) => a - b);
    return ys[0] < ys[1];
  }

  // Centro della parte visibile del triangolo all'altezza y: metà della corda
  // orizzontale, ritagliata sulla parte di tavola dentro lo schermo (le Regioni
  // dei vicini escono dai lati: i loro numeri stanno in ciò che se ne vede)
  let visible = [-Infinity, Infinity];  // unità di tavola dentro lo schermo
  function midX(slot, y) {
    const pts = SHAPES[slot].pts;
    const xs = [];
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % 3];
      if (a[1] !== b[1] && (y - a[1]) * (y - b[1]) <= 0) xs.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
    });
    if (!xs.length) return (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
    const lo = Math.max(Math.min(...xs), visible[0]), hi = Math.min(Math.max(...xs), visible[1]);
    return hi > lo ? (lo + hi) / 2 : (Math.min(...xs) + Math.max(...xs)) / 2;
  }

  // Parte della tavola dentro lo schermo (la schermata di gioco), con un margine
  function measureVisible(live) {
    const r = live.getBoundingClientRect();
    const scr = (live.closest('#scr-game') || document.documentElement).getBoundingClientRect();
    if (!r.width) return [-Infinity, Infinity];
    const k = W / r.width;
    return [(scr.left - r.left) * k + 4, (scr.right - r.left) * k - 4];
  }

  // Distanza di un punto dal triangolo (0 se è dentro)
  function distance(pts, x, y) {
    const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const s = [side(pts[0], pts[1]), side(pts[1], pts[2]), side(pts[2], pts[0])];
    if (s.every(v => v >= 0) || s.every(v => v <= 0)) return 0;
    return Math.min(...pts.map((a, i) => {
      const b = pts[(i + 1) % 3];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
    }));
  }

  // Numeri pseudocasuali ripetibili: alberi e pietre sono sempre gli stessi
  function rng(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Disegno fisso: terreno, alberi, Regioni dipinte
  // ---------------------------------------------------------------------------

  function artMarkup() {
    const grads = SLOTS.map(k => {
      const s = SHAPES[k];
      const [inner, outer] = PALETTE[s.pal];
      return `<radialGradient id="ba-g-${k}" cx="0.5" cy="${pointsUp(s.pts) ? 0.64 : 0.36}" r="0.6">` +
        `<stop offset="0" stop-color="${inner}"/><stop offset="1" stop-color="${outer}"/></radialGradient>`;
    }).join('');

    // Radura: terra battuta attorno alle Regioni, più la strada che sale dall'Avanscoperta
    const clearing = SLOTS.map(k => `<path d="${roundedPath(SHAPES[k].pts)}"/>`).join('') +
      '<path d="M195 -90 L195 100" fill="none"/>';

    const rand = rng(20251022);
    const trees = [];
    TREES.forEach(([cx, cy, n]) => {
      for (let i = 0; i < n; i++) {
        trees.push([cx + (rand() - 0.5) * 18, cy + (rand() - 0.5) * 12, 5.2 + rand() * 3.6]);
      }
    });
    trees.sort((a, b) => a[1] - b[1]);  // quelli più in basso sopra gli altri
    const treeShadows = trees.map(([x, y, r]) =>
      `<ellipse cx="${f1(x + 1.6)}" cy="${f1(y + 2.4)}" rx="${f1(r * 1.05)}" ry="${f1(r * 0.92)}"/>`).join('');
    const treeCrowns = trees.map(([x, y, r]) =>
      `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" class="ba-crown"/>` +
      `<circle cx="${f1(x - r * 0.3)}" cy="${f1(y - r * 0.32)}" r="${f1(r * 0.48)}" class="ba-light"/>`).join('');

    const regions = SLOTS.map(k =>
      `<path d="${roundedPath(SHAPES[k].pts)}" fill="url(#ba-g-${k})"/>`).join('');

    const grass = GRASS.map(([x, y]) =>
      `<path d="M${x} ${y} l-2.2 -4.6 M${x + 1.6} ${y} l0.4 -5.6 M${x + 3.2} ${y} l2.4 -4.2"/>`).join('');

    return `<svg id="board-art" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">
      <defs>
        ${grads}
        <filter id="ba-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
        <filter id="ba-paint" x="-4%" y="-4%" width="108%" height="108%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="3" seed="11" result="noise"/>
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.04  0 0 0 0 0  0 0 0 0.8 -0.34" result="blots"/>
          <feComposite in="blots" in2="SourceAlpha" operator="in" result="blotsIn"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="1" seed="5" result="grain"/>
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 0.92  0 0 0 0 0.78  0 0 0 0.45 -0.17" result="specks"/>
          <feComposite in="specks" in2="SourceAlpha" operator="in" result="specksIn"/>
          <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="soft"/>
          <feComposite in="SourceAlpha" in2="soft" operator="out" result="rim"/>
          <feFlood flood-color="#1c0d03" flood-opacity="0.85"/>
          <feComposite in2="rim" operator="in" result="rimShade"/>
          <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="blotsIn"/><feMergeNode in="specksIn"/><feMergeNode in="rimShade"/></feMerge>
        </filter>
      </defs>
      <g class="ba-clearing" filter="url(#ba-blur)">${clearing}</g>
      <g class="ba-tree-shadows">${treeShadows}</g>
      <g class="ba-trees">${treeCrowns}</g>
      <g class="ba-regions" filter="url(#ba-paint)">${regions}</g>
      <g class="ba-grass">${grass}</g>
    </svg>`;
  }

  // ---------------------------------------------------------------------------
  // Livello vivo: sagome toccabili e Muri di pietra
  // ---------------------------------------------------------------------------

  // Pietre in due file lungo un lato, fuori dal triangolo
  function stonesMarkup(slot) {
    const e = WALL_EDGES[slot];
    const pts = SHAPES[slot].pts;
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    const dx = e.to[0] - e.from[0], dy = e.to[1] - e.from[1], len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    let nx = -uy, ny = ux;
    const mx = (e.from[0] + e.to[0]) / 2, my = (e.from[1] + e.to[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const angle = Math.atan2(uy, ux) * 180 / Math.PI;
    const rand = rng(slot.length * 7919 + Math.round(e.from[0]));
    const step = 7.4;
    let shadow = '', body = '';
    [5.4, 11.6].forEach((off, row) => {
      for (let s = len * e.t0 + row * step / 2; s < len * e.t1; s += step) {
        const l = 6.2 + rand() * 1.4, w = 4.4 + rand() * 0.9;
        const o = off + (rand() - 0.5) * 1.2;
        const x = e.from[0] + ux * s + nx * o, y = e.from[1] + uy * s + ny * o;
        const rot = f1(angle + (rand() - 0.5) * 10);
        const r = `x="${f1(-l / 2)}" y="${f1(-w / 2)}" width="${f1(l)}" height="${f1(w)}" rx="1.7"`;
        shadow += `<rect ${r} transform="translate(${f1(x + 0.7)} ${f1(y + 1.1)}) rotate(${rot})"/>`;
        body += `<rect ${r} transform="translate(${f1(x)} ${f1(y)}) rotate(${rot})"/>`;
      }
    });
    return `<g class="bl-wall" data-slot="${slot}"><g class="bl-stone-shadows">${shadow}</g><g class="bl-stones">${body}</g></g>`;
  }

  function liveMarkup() {
    const walls = Object.keys(WALL_EDGES).map(stonesMarkup).join('');
    const hits = SLOTS.map(k =>
      `<path id="${IDS[k]}" class="rg-shape${k.startsWith('c_') ? ' center' : ''}" data-slot="${k}" d="${roundedPath(SHAPES[k].pts)}"/>`).join('');
    // Ingombro delle Regioni al centro (tutorial: «il tuo campo»)
    return `<svg id="board-live" viewBox="0 0 ${W} ${H}" focusable="false">
      ${walls}
      <rect id="board-center-box" x="32" y="77" width="326" height="416" fill="none"/>
      ${hits}
    </svg>`;
  }

  // ---------------------------------------------------------------------------
  // Numeri delle Regioni (HTML sopra la tavola)
  // ---------------------------------------------------------------------------

  const TOWER_PATH = 'M5 7 L5 4 L7 4 L7 6 L9 6 L9 4 L11 4 L11 6 L13 6 L13 4 L15 4 L15 6 L17 6 L17 4 L19 4 L19 7 L16.8 9 L16.3 14.5 L18.5 16.5 L19.5 20.5 L4.5 20.5 L5.5 16.5 L7.7 14.5 L7.2 9 Z';
  const TOWER_SVG = `<svg viewBox="3.5 2.6 17 19" aria-hidden="true"><path d="${TOWER_PATH}"/></svg>`;
  const WALL_SVG = '<svg viewBox="0 0 30 24" aria-hidden="true"><rect x="1" y="1" width="28" height="22" rx="1.6"/>' +
    '<path d="M7 1v22M23 1v22M1 8.3h6M1 15.7h6M23 8.3h6M23 15.7h6"/></svg>';

  const pos = (x, y) => `left:${f1(x / W * 100)}%;top:${f1(y / H * 100)}%`;
  const dia = (x, y, n) => `<span class="ov ov-dia${n ? '' : ' zero'}" style="${pos(x, y)}"><b>${n}</b></span>`;
  const lbl = (x, y, text) => `<span class="ov ov-lbl" style="${pos(x, y)}">${text}</span>`;
  const title = (x, y, text) => `<span class="ov ov-title" style="${pos(x, y)}">${text}</span>`;
  const wall = (x, y, n) => `<span class="ov ov-wall${n ? '' : ' zero'}" style="${pos(x, y)}">${WALL_SVG}<b>${n}</b></span>`;
  const tower = (x, y, n, done) =>
    `<span class="ov ov-tower${done ? ' done' : ''}${n ? '' : ' zero'}" style="${pos(x, y)}">${TOWER_SVG}<b>${n}</b></span>`;
  function dots(x, y, species, max = 5) {
    if (!species.length) return '';
    const shown = species.slice(0, max).map(s => `<i class="sp-${s || 'umano'}"></i>`).join('');
    const more = species.length > max ? `<em>+${species.length - max}</em>` : '';
    return `<span class="ov ov-dots" style="${pos(x, y)}">${shown}${more}</span>`;
  }

  // Contenuto di una Regione, in unità di tavola. Le mie (al centro) con
  // etichette e titolo; quelle dei vicini solo i numeri che contano per me.
  function overlayHTML(slot, d) {
    // Punto al centro del triangolo all'altezza y, spostato di dx
    const c = (y, dx = 0) => [midX(slot, y) + dx, y];
    switch (slot) {
      case 'c_vanguard':
        return dia(...c(153), d.att) + lbl(...c(176), 'ATT') + dia(...c(203), d.git) + lbl(...c(224), 'GIT') +
          dots(...c(242), d.species) + title(...c(260), 'Avanscoperta');
      case 'c_village':
        return title(...c(301), 'Villaggio') +
          tower(...c(327), d.incomplete, false) + lbl(...c(351), 'Incompl.') +
          tower(...c(380), d.complete, true) + lbl(...c(400), 'Compl.');
      case 'c_bastion_left':
      case 'c_bastion_right':
        return wall(...c(369), d.walls) + lbl(...c(390), 'Muri') +
          dia(...c(417, -19), d.dif) + dia(...c(417, 19), d.git) +
          lbl(...c(440, -19), 'DIF') + lbl(...c(440, 19), 'GIT') +
          dots(...c(457), d.species) +
          title(...c(475), slot === 'c_bastion_left' ? 'Bastione SX' : 'Bastione DX');
      case 'l_bastion':
      case 'r_bastion':
        return dia(...c(99, -19), d.dif) + dia(...c(99, 19), d.git) +
          lbl(...c(120, -19), 'DIF') + lbl(...c(120, 19), 'GIT') + wall(...c(148), d.walls);
      // Regioni che escono dallo schermo: in colonna, al centro di ciò che se ne vede
      // (ogni etichetta sotto il suo rombo)
      case 'l_village':
      case 'r_village':
        return tower(...c(200), d.incomplete, false) + tower(...c(236), d.complete, true);
      case 'l_vanguard':
      case 'r_vanguard': {
        const [xa] = c(318), [xg] = c(364);
        return dia(xa, 318, d.att) + lbl(xa, 339, 'ATT') + dia(xg, 364, d.git) + lbl(xg, 385, 'GIT');
      }
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  /**
   * Costruisce la tavola dentro `boardEl` (una volta sola).
   * opts.onTap(slot): tocco su una Regione.
   */
  function mount(boardEl, opts = {}) {
    tapHandler = opts.onTap || null;
    if (mounted) return;
    mounted = true;
    const ov = SLOTS.map(k => `<div class="ov-slot" data-slot="${k}"></div>`).join('');
    boardEl.insertAdjacentHTML('afterbegin', artMarkup() + liveMarkup() + `<div id="board-ov">${ov}</div>`);
    SLOTS.forEach(k => {
      shapes[k] = boardEl.querySelector(`.rg-shape[data-slot="${k}"]`);
      overlays[k] = boardEl.querySelector(`.ov-slot[data-slot="${k}"]`);
      shapes[k].addEventListener('click', () => { if (tapHandler && owners[k]) tapHandler(k); });
    });
    Object.keys(WALL_EDGES).forEach(k => { stones[k] = boardEl.querySelector(`.bl-wall[data-slot="${k}"]`); });
    liveSvg = boardEl.querySelector('#board-live');
    // Cambia la parte di tavola che si vede: i numeri dei vicini si ricentrano
    window.addEventListener('resize', () => { if (last) update(last.slots, { ...last.flags, quiet: null }); });
  }

  /**
   * Aggiorna numeri, Muri ed evidenziazioni.
   * slots: { slot: { ownerId, data } | null } — data dipende dalla Regione:
   *   vanguard { att, git, species[] }, bastion { walls, dif, git, species[] },
   *   village { incomplete, complete }
   * flags: { hot: Set di slot (Guerrieri da riposizionare), target: Set di slot
   *   (Bastioni attaccabili ora), quiet: Set di slot che non si illuminano se
   *   cambiano (le mie Regioni nel mio turno: lì si illuminano all'arrivo delle carte) }
   */
  function update(slots, flags = {}) {
    if (!mounted) return;
    last = { slots, flags };
    visible = measureVisible(liveSvg);
    SLOTS.forEach(k => {
      const s = slots[k] || null;
      const shape = shapes[k];
      const owner = s ? s.ownerId : null;
      shape.classList.toggle('empty', !s);
      shape.classList.toggle('hot', !!(flags.hot && flags.hot.has(k)));
      shape.classList.toggle('target', !!(flags.target && flags.target.has(k)));
      const html = s ? overlayHTML(k, s.data) : '';
      const sig = `${owner}|${html}`;
      if (sig !== sigs[k]) {
        overlays[k].innerHTML = html;
        sigs[k] = sig;
      }
      // Numeri cambiati per una mossa (non per un cambio di vista): la Regione si illumina
      const data = s ? JSON.stringify(s.data) : '';
      if (data !== datas[k] && datas[k] !== undefined && owner && owners[k] === owner &&
          !(flags.quiet && flags.quiet.has(k))) flash(shape);
      datas[k] = data;
      owners[k] = owner;
      if (stones[k]) stones[k].classList.toggle('on', !!(s && s.data.walls > 0));
    });
  }

  /** Proprietario e Regione mostrati da uno slot. */
  function slotInfo(slot) {
    return { ownerId: owners[slot] || null, region: SHAPES[slot] ? SHAPES[slot].region : null };
  }

  /** La sagoma toccabile di uno slot. */
  function shape(slot) { return shapes[slot] || null; }

  /** Il punto (x, y) dello schermo cade nella Regione (o a meno di `margin` unità)? */
  function contains(slot, x, y, margin = 9) {
    const live = shapes[slot] && shapes[slot].ownerSVGElement;
    if (!live) return false;
    const r = live.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return distance(SHAPES[slot].pts, (x - r.left) * W / r.width, (y - r.top) * H / r.height) <= margin;
  }

  /** Breve bagliore su una Regione (carta arrivata, numeri cambiati). */
  function flash(el) {
    if (!el || !el.animate || (typeof Motion !== 'undefined' && Motion.reducedMotion())) return;
    el.animate([
      { fill: 'rgba(255, 214, 110, 0)', stroke: 'rgba(255, 214, 110, 0)' },
      { fill: 'rgba(255, 214, 110, 0.22)', stroke: 'rgba(255, 214, 110, 0.9)', offset: 0.3 },
      { fill: 'rgba(255, 214, 110, 0)', stroke: 'rgba(255, 214, 110, 0)' },
    ], { duration: 900, easing: 'ease-out' });
  }

  return { SLOTS, mount, update, slotInfo, shape, contains, flash };
})();
