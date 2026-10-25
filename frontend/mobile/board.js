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
 * - #board-art: Regioni dipinte. Non cambia mai e si costruisce una volta
 *   sola: i filtri SVG che danno la grana costano, non vanno ricalcolati a
 *   ogni aggiornamento;
 * - #board-trees: gli alberi, ripiantati quando le scritte cambiano posto;
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
  // al centro più accese (e con alone e bordo d'oro), quelle dei vicini più cupe
  const PALETTE = {
    'vanguard':     ['#c66a3e', '#94432a'],
    'bastion':      ['#c3a279', '#937350'],
    'village':      ['#5f9035', '#446826'],
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

  // Come roundedPath, ma con i lati frastagliati: punti ogni ~7 unità spostati a
  // caso (sempre gli stessi) di poco verso l'interno o l'esterno
  function roughPath(pts, seed) {
    const rand = rng(seed);
    const corners = pts.map((v, i) => {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[(i + 1) % pts.length];
      return [toward(v, p), v, toward(v, q)];
    });
    let d = '';
    corners.forEach(([a, v, b], i) => {
      d += `${i ? 'L' : 'M'}${f1(a[0])} ${f1(a[1])} Q${v[0]} ${v[1]} ${f1(b[0])} ${f1(b[1])} `;
      const e = corners[(i + 1) % corners.length][0];
      const dx = e[0] - b[0], dy = e[1] - b[1], len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.round(len / 7));
      for (let j = 1; j < n; j++) {
        const t = j / n, o = (rand() - 0.5) * 1.4;
        d += `L${f1(b[0] + dx * t - dy / len * o)} ${f1(b[1] + dy * t + dx / len * o)} `;
      }
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
  let unitsPerPx = 1;                    // unità di tavola in un pixel
  let diaPx = 27;                        // lato dei rombi delle Caratteristiche (CSS: max(20px, 7cqw))

  // Corda orizzontale del triangolo all'altezza y: [sinistra, destra] o null
  function chord(slot, y) {
    const pts = SHAPES[slot].pts;
    const xs = [];
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % 3];
      if (a[1] !== b[1] && (y - a[1]) * (y - b[1]) <= 0) xs.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
    });
    return xs.length ? [Math.min(...xs), Math.max(...xs)] : null;
  }

  // Centro della parte visibile del triangolo all'altezza y. Con halfPx, per un
  // simbolo alto 2·halfPx centrato lì: la corda più stretta tra il suo bordo in
  // alto e quello in basso, così il simbolo sta tutto dentro il triangolo
  function midX(slot, y, halfPx = 0) {
    const m = chord(slot, y);
    if (!m) return (SHAPES[slot].pts.reduce((s, p) => s + p[0], 0)) / 3;
    const [lo, hi] = span(slot, y, halfPx, m);
    return hi > lo ? (lo + hi) / 2 : (m[0] + m[1]) / 2;
  }

  // Fascia visibile del triangolo che contiene per intero un simbolo alto
  // 2·halfPx centrato all'altezza y
  function span(slot, y, halfPx, m = chord(slot, y)) {
    const hu = halfPx * unitsPerPx;
    const a = chord(slot, y - hu), b = chord(slot, y + hu);
    return [Math.max(a ? a[0] : m[0], b ? b[0] : m[0], visible[0]),
            Math.min(a ? a[1] : m[1], b ? b[1] : m[1], visible[1])];
  }

  // Una sola x per una colonna di simboli alle altezze ys: il centro della
  // fascia che li contiene tutti (se non c'è, quello del simbolo più stretto)
  function columnX(slot, ys, halfPx) {
    let lo = -Infinity, hi = Infinity;
    ys.forEach(y => {
      const m = chord(slot, y);
      if (!m) return;
      const [l, h] = span(slot, y, halfPx, m);
      lo = Math.max(lo, l); hi = Math.min(hi, h);
    });
    return hi > lo ? (lo + hi) / 2 : midX(slot, ys[ys.length - 1], halfPx);
  }

  // Parte della tavola dentro lo schermo (la schermata di gioco), con un margine,
  // e misure dei simboli in unità di tavola
  function measure(live) {
    const r = live.getBoundingClientRect();
    if (!r.width) return;
    const scr = (live.closest('#scr-game') || document.documentElement).getBoundingClientRect();
    unitsPerPx = W / r.width;
    diaPx = Math.max(20, 0.07 * r.width);
    visible = [(scr.left - r.left) * unitsPerPx + 4, (scr.right - r.left) * unitsPerPx - 4];
  }

  // Distanza di un punto dal triangolo (0 se è dentro)
  function distance(pts, x, y) {
    const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const s = [side(pts[0], pts[1]), side(pts[1], pts[2]), side(pts[2], pts[0])];
    if (s.every(v => v >= 0) || s.every(v => v <= 0)) return 0;
    return Math.min(...pts.map((a, i) => segDistance(a, pts[(i + 1) % 3], x, y)));
  }

  // Distanza di un punto dal segmento a–b
  function segDistance(a, b, x, y) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
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

    const mine = k => k.startsWith('c_');
    const regions = SLOTS.map((k, i) =>
      `<path d="${roughPath(SHAPES[k].pts, 7000 + i)}" fill="url(#ba-g-${k})"${mine(k) ? ' class="mine"' : ''}/>`).join('');
    const glow = SLOTS.filter(mine).map(k => `<path d="${roundedPath(SHAPES[k].pts)}"/>`).join('');

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
      <g class="ba-glow" filter="url(#ba-blur)">${glow}</g>
      <g class="ba-regions" filter="url(#ba-paint)">${regions}</g>
    </svg>`;
  }

  // ---------------------------------------------------------------------------
  // Alberi
  // ---------------------------------------------------------------------------

  // Sparsi a caso su tutto il campo: sul terreno e nei Villaggi, appena sopra il
  // bordo delle altre Regioni, mai sui Muri né vicino alle scritte (numeri,
  // nomi degli avversari, intestazione). Le scritte si spostano con lo schermo,
  // quindi gli alberi si ripiantano dopo ogni aggiornamento in cui cambiano
  // posto. I candidati hanno sempre lo stesso ordine (seme fisso): uno
  // spostamento piccolo cambia solo gli alberi lì vicino. Su un SVG a parte,
  // per non ricalcolare i filtri delle Regioni.
  const TREE_DENSITY = 0.00026;  // alberi per unità² di campo, prima delle esclusioni
  const TEXT_GAP = 4;            // unità libere attorno ai numeri delle Regioni
  const TOP_GAP = 30;            // px liberi sotto l'intestazione e attorno ai nomi
  let treesSvg = null, treeSig = '', treeFrame = 0;

  function scheduleTrees() {
    cancelAnimationFrame(treeFrame);
    treeFrame = requestAnimationFrame(plantTrees);
  }

  function plantTrees() {
    const r = treesSvg.getBoundingClientRect();
    const field = treesSvg.closest('#field'), top = document.getElementById('topbar');
    if (!r.width || !field) return;
    const k = W / r.width;  // unità di tavola in un pixel
    const toU = (b, g) => [(b.left - r.left) * k - g, (b.top - r.top) * k - g,
                           (b.right - r.left) * k + g, (b.bottom - r.top) * k + g];
    const f = field.getBoundingClientRect();
    const [x0, , x1, y1] = toU(f, 0);
    const y0 = ((top ? top.getBoundingClientRect().bottom : f.top) - r.top) * k + TOP_GAP * k;
    const boxes = [];
    const add = (sel, g) => treesSvg.parentNode.querySelectorAll(sel).forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.width && b.height) boxes.push(toU(b, g));
    });
    add('#board-ov .ov', TEXT_GAP);
    add('#opp-rail .opp-label', TOP_GAP * k);

    const sig = [x0, y0, x1, y1, ...boxes.flat()].map(Math.round).join(',');
    if (sig === treeSig) return;
    treeSig = sig;

    const rand = rng(20251022);
    const want = Math.round((x1 - x0) * (y1 - y0) * TREE_DENSITY);
    const trees = [];
    const clear = (x, y, rr) =>
      // niente scritte sotto la chioma
      boxes.every(([a, b, c, d]) => Math.hypot(Math.max(a - x, 0, x - c), Math.max(b - y, 0, y - d)) >= rr) &&
      // le Regioni (tranne i Villaggi) appena sfiorate
      SLOTS.every(s => SHAPES[s].region === 'village' || distance(SHAPES[s].pts, x, y) >= rr * 0.55) &&
      // lontano dalle pietre dei Muri
      Object.values(WALL_EDGES).every(e => segDistance(e.from, e.to, x, y) >= rr + 20) &&
      // due chiome possono toccarsi, non entrare una nell'altra
      trees.every(([a, b, s]) => Math.hypot(x - a, y - b) >= rr + s);
    for (let i = 0; i < want * 4 && trees.length < want; i++) {
      const x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0), rr = 5.2 + rand() * 3.6;
      if (clear(x, y, rr)) trees.push([x, y, rr]);
    }
    trees.sort((a, b) => a[1] - b[1]);  // quelli più in basso sopra gli altri
    treesSvg.innerHTML =
      '<g class="ba-tree-shadows">' + trees.map(([x, y, rr]) =>
        `<ellipse cx="${f1(x + 1.6)}" cy="${f1(y + 2.4)}" rx="${f1(rr * 1.05)}" ry="${f1(rr * 0.92)}"/>`).join('') +
      '</g><g class="ba-trees">' + trees.map(([x, y, rr]) =>
        `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rr)}" class="ba-crown"/>` +
        `<circle cx="${f1(x - rr * 0.3)}" cy="${f1(y - rr * 0.32)}" r="${f1(rr * 0.48)}" class="ba-light"/>`).join('') +
      '</g>';
  }

  // ---------------------------------------------------------------------------
  // Livello vivo: sagome toccabili e Muri di pietra
  // ---------------------------------------------------------------------------

  // Pietre in tre file lungo un lato, fuori dal triangolo: se ne vedono una,
  // due o tre secondo i Muri (wallRows)
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
    let rows = '';
    [5.4, 11.6, 17.8].forEach((off, row) => {
      let shadow = '', body = '';
      for (let s = len * e.t0 + (row % 2) * step / 2; s < len * e.t1; s += step) {
        const l = 6.2 + rand() * 1.4, w = 4.4 + rand() * 0.9;
        const o = off + (rand() - 0.5) * 1.2;
        const x = e.from[0] + ux * s + nx * o, y = e.from[1] + uy * s + ny * o;
        const rot = f1(angle + (rand() - 0.5) * 10);
        const r = `x="${f1(-l / 2)}" y="${f1(-w / 2)}" width="${f1(l)}" height="${f1(w)}" rx="1.7"`;
        shadow += `<rect ${r} transform="translate(${f1(x + 0.7)} ${f1(y + 1.1)}) rotate(${rot})"/>`;
        body += `<rect ${r} transform="translate(${f1(x)} ${f1(y)}) rotate(${rot})"/>`;
      }
      rows += `<g class="bl-row" data-row="${row + 1}"><g class="bl-stone-shadows">${shadow}</g><g class="bl-stones">${body}</g></g>`;
    });
    return `<g class="bl-wall" data-slot="${slot}">${rows}</g>`;
  }

  // File di sassi per i Muri: 1–5 una, 6–10 due, da 11 tre
  const wallRows = n => (n <= 0 ? 0 : n <= 5 ? 1 : n <= 10 ? 2 : 3);

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
  // Titoli a distanza fissa dal bordo dritto del triangolo (in basso per quelli
  // con la punta in su, in alto per il Villaggio): la y è quella del bordo
  const titleAt = (x, y, text, edge) => `<span class="ov ov-title at-${edge}" style="${pos(x, y)}">${text}</span>`;
  const wall = (x, y, n) => `<span class="ov ov-wall${n ? '' : ' zero'}" style="${pos(x, y)}">${WALL_SVG}<b>${n}</b></span>`;
  const tower = (x, y, n, done) =>
    `<span class="ov ov-tower${done ? ' done' : ''}${n ? '' : ' zero'}" style="${pos(x, y)}">${TOWER_SVG}<b>${n}</b></span>`;
  // Pallini delle Specie; con onTitle poggiano sul titolo in fondo (y = bordo)
  function dots(x, y, species, onTitle = false, max = 5) {
    if (!species.length) return '';
    const shown = species.slice(0, max).map(s => `<i class="sp-${s || 'umano'}"></i>`).join('');
    const more = species.length > max ? `<em>+${species.length - max}</em>` : '';
    return `<span class="ov ov-dots${onTitle ? ' on-title' : ''}" style="${pos(x, y)}">${shown}${more}</span>`;
  }

  // Contenuto di una Regione, in unità di tavola. Le mie (al centro) con
  // etichette e titolo; quelle dei vicini solo i numeri che contano per me.
  function overlayHTML(slot, d) {
    // Punto al centro del triangolo all'altezza y, spostato di dx
    const c = (y, dx = 0) => [midX(slot, y) + dx, y];
    // Rombi e torri dei vicini: in colonna, interi dentro la parte visibile del triangolo
    const col = ys => columnX(slot, ys, diaPx / 2);
    const base = SHAPES[slot].pts[1][1];  // bordo dritto delle mie Regioni
    switch (slot) {
      case 'c_vanguard':
        return dia(...c(145), d.att) + lbl(...c(169), 'ATT') + dia(...c(194), d.git) + lbl(...c(218), 'GIT') +
          dots(...c(base), d.species, true) + titleAt(...c(base), 'Avanscoperta', 'base');
      case 'c_village':
        return titleAt(...c(base), 'Villaggio', 'top') +
          tower(...c(327), d.incomplete, false) + lbl(...c(351), 'Incompl.') +
          tower(...c(376), d.complete, true) + lbl(...c(400), 'Compl.');
      case 'c_bastion_left':
      case 'c_bastion_right':
        return wall(...c(369), d.walls) + lbl(...c(390), 'Muri') +
          dia(...c(417, -19), d.dif) + dia(...c(417, 19), d.git) +
          lbl(...c(440, -19), 'DIF') + lbl(...c(440, 19), 'GIT') +
          dots(...c(base), d.species, true) +
          titleAt(...c(base), slot === 'c_bastion_left' ? 'Bastione SX' : 'Bastione DX', 'base');
      case 'l_bastion':
      case 'r_bastion':
        return dia(...c(99, -19), d.dif) + dia(...c(99, 19), d.git) +
          lbl(...c(122, -19), 'DIF') + lbl(...c(122, 19), 'GIT') + wall(...c(151), d.walls) + lbl(...c(172), 'Muri');
      // Regioni che escono dallo schermo: in colonna, al centro di ciò che se ne vede
      // (ogni etichetta sotto il suo rombo)
      case 'l_village':
      case 'r_village':
      {
        const x = col([170, 222]);
        return tower(x, 170, d.incomplete, false) + lbl(x, 194, 'Incompl.') +
          tower(x, 222, d.complete, true) + lbl(x, 246, 'Compl.');
      }
      case 'l_vanguard':
      case 'r_vanguard': {
        // Il triangolo punta in giù: la colonna sta in alto, dove è più largo
        const x = col([306, 352]);
        return dia(x, 306, d.att) + lbl(x, 329, 'ATT') + dia(x, 352, d.git) + lbl(x, 375, 'GIT');
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
    const treesMarkup = `<svg id="board-trees" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false"></svg>`;
    boardEl.insertAdjacentHTML('afterbegin', artMarkup() + treesMarkup + liveMarkup() + `<div id="board-ov">${ov}</div>`);
    treesSvg = boardEl.querySelector('#board-trees');
    // Le scritte cambiano misura quando arriva il font
    if (document.fonts) document.fonts.ready.then(() => { treeSig = ''; scheduleTrees(); });
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
    measure(liveSvg);
    scheduleTrees();  // dopo i nomi degli avversari (render.js li disegna subito dopo)
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
      if (stones[k]) stones[k].dataset.rows = s ? wallRows(s.data.walls) : 0;
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
