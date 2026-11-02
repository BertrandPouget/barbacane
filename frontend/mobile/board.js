/**
 * board.js — Il campo del client mobile: le Regioni sono triangoli dipinti su
 * un terreno, come in una mappa.
 *
 * La tavola è un rettangolo diviso in quattro triangoli con la punta in comune,
 * uno per giocatore: in basso il giocatore osservato (di solito io), a destra
 * il suo vicino di destra, in alto quello di fronte, a sinistra il vicino di
 * sinistra (render.js assegna i posti). Ogni triangolo è diviso nelle quattro
 * Regioni del giocatore: l'Avanscoperta in punta, verso il centro, il Villaggio
 * in mezzo, i Bastioni sul bordo. I Bastioni di due vicini si toccano in un
 * angolo, il destro dell'uno col sinistro dell'altro, come nell'adiacenza.
 *
 * Tutto è disegnato in unità di tavola (W×H) e scala con #board:
 * - #board-art: Regioni dipinte. Non cambia mai e si costruisce una volta
 *   sola: i filtri SVG che danno la grana costano, non vanno ricalcolati a
 *   ogni aggiornamento;
 * - #board-live: le sagome toccabili (zone in cui trascinare le carte,
 *   evidenziazioni, con gli id usati dal tutorial) e i Muri di pietra;
 * - #board-ov: i numeri di ogni Regione, in HTML posizionato in percentuale.
 * I nomi dei vicini stanno in verticale fuori dalla tavola, nel margine dello
 * schermo che #board lascia ai lati (mobile.css).
 */

'use strict';

const Board = (() => {
  const W = 390, H = 420;
  const G = 4;              // margine della tavola ai lati
  const R = 10;             // raggio degli angoli dei triangoli
  const O = [195, 184];     // punta comune, poco sopra il centro: il mio triangolo è il più grande
  const GAP_SEAT = 5, GAP = 4;  // rientro dei triangoli dei giocatori e delle Regioni

  // Posti: angoli di base [sinistro, destro] visti da chi ci sta, guardando il centro
  const SEATS = {
    c: [[G, H], [W - G, H]],
    r: [[W - G, H], [W - G, 0]],
    t: [[W - G, 0], [G, 0]],
    l: [[G, 0], [G, H]],
  };

  // Vertici in unità di tavola, per <posto>_<regione>; I = incentro, da cui
  // partono i numeri
  const SHAPES = buildShapes();
  const SLOTS = Object.keys(SHAPES);

  // Id delle sagome: quelli delle mie Regioni sono gli stessi dei vecchi tasselli
  // (tutorial: _MOBILE_HIGHLIGHT_MAP in engine/tutorial.py; transizioni in app.js);
  // chi sta di fronte (l'avversario del tutorial) ha quelli dei vecchi vicini
  const IDS = {
    c_vanguard: 'fld-vanguard', c_village: 'tw-village', c_bastion_left: 'tw-left', c_bastion_right: 'tw-right',
    t_bastion_right: 'opp-bl', t_bastion_left: 'opp-br', t_vanguard: 'opp-vl', t_village: 'opp-tl',
  };
  SLOTS.forEach(k => { IDS[k] = IDS[k] || `q-${k.replace('_', '-')}`; });

  // Colori delle Regioni (centro e bordo della sfumatura): le mie più accese
  // (e con alone e bordo d'oro), quelle degli altri più cupe
  const PALETTE = {
    'vanguard':     ['#a33a22', '#742316'],
    'bastion':      ['#c3a279', '#937350'],
    'village':      ['#3f6339', '#2a462a'],
    'opp-vanguard': ['#64221a', '#451610'],
    'opp-bastion':  ['#6a5545', '#4c3b2f'],
    'opp-village':  ['#2e442c', '#1e2f1e'],
  };

  // Muri di pietra: lungo il lato del Bastione sulla diagonale, di fronte al
  // Bastione del vicino, tra t0 e t1 del lato (da `from` a `to`). I Muri di due
  // vicini si fronteggiano nella stessa striscia: pietre piccole
  const WALL_EDGES = buildWallEdges();
  const WALL_ROWS = { offs: [2.5, 5.6, 8.7], step: 5, k: 0.65 };

  let mounted = false;
  const shapes = {}, overlays = {}, stones = {}, arts = {};
  const sigs = {}, datas = {}, owners = {};
  let tapHandler = null;

  // ---------------------------------------------------------------------------
  // Geometria
  // ---------------------------------------------------------------------------

  const f1 = n => (Math.round(n * 10) / 10).toString();

  // Incentro e raggio del cerchio inscritto
  function incircle(pts) {
    const [a, b, c] = pts;
    const la = Math.hypot(b[0] - c[0], b[1] - c[1]), lb = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const lc = Math.hypot(a[0] - b[0], a[1] - b[1]), p = la + lb + lc;
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    return { x: (la * a[0] + lb * b[0] + lc * c[0]) / p, y: (la * a[1] + lb * b[1] + lc * c[1]) / p, r: 2 * area / p };
  }

  // Il triangolo rimpicciolito verso l'incentro: ogni lato rientra di d
  function shrink(pts, d) {
    const { x, y, r } = incircle(pts), k = (r - d) / r;
    return pts.map(([px, py]) => [x + (px - x) * k, y + (py - y) * k]);
  }

  function buildShapes() {
    const out = {};
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    Object.entries(SEATS).forEach(([seat, [L0, R0]]) => {
      const [A, L, Rr] = shrink([O, L0, R0], GAP_SEAT);
      const mL = mid(A, L), mR = mid(A, Rr), mB = mid(L, Rr);
      const regions = {
        vanguard: [A, mR, mL], village: [mL, mR, mB],
        bastion_left: [mL, mB, L], bastion_right: [mR, Rr, mB],
      };
      Object.entries(regions).forEach(([region, pts]) => {
        const p = shrink(pts, GAP).map(v => v.map(n => Math.round(n * 10) / 10));
        const pal = (seat === 'c' ? '' : 'opp-') + (region.startsWith('bastion') ? 'bastion' : region);
        out[`${seat}_${region}`] = { region, seat, pal, pts: p, I: incircle(p) };
      });
    });
    return out;
  }

  function buildWallEdges() {
    const out = {};
    Object.keys(SEATS).forEach(seat => {
      const l = SHAPES[`${seat}_bastion_left`].pts, r = SHAPES[`${seat}_bastion_right`].pts;
      out[`${seat}_bastion_left`] = { from: l[0], to: l[2], t0: 0.08, t1: 0.92 };
      out[`${seat}_bastion_right`] = { from: r[0], to: r[1], t0: 0.08, t1: 0.92 };
    });
    return out;
  }

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

  // Numeri pseudocasuali ripetibili: le pietre sono sempre le stesse
  function rng(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Disegno fisso: terreno, Regioni dipinte
  // ---------------------------------------------------------------------------

  function artMarkup() {
    // Sfumature centrate sull'incentro (i triangoli puntano in quattro direzioni)
    const grads = SLOTS.map(k => {
      const s = SHAPES[k];
      const [inner, outer] = PALETTE[s.pal];
      const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
      const cx = f1((s.I.x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs)));
      const cy = f1((s.I.y - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys)));
      return `<radialGradient id="ba-g-${k}" cx="${cx}" cy="${cy}" r="0.6">` +
        `<stop offset="0" stop-color="${inner}"/><stop offset="1" stop-color="${outer}"/></radialGradient>`;
    }).join('');

    const mine = k => k.startsWith('c_');
    const regions = SLOTS.map((k, i) =>
      `<path d="${roughPath(SHAPES[k].pts, 7000 + i)}" data-slot="${k}" fill="url(#ba-g-${k})"${mine(k) ? ' class="mine"' : ''}/>`).join('');
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
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 1  0 0 0 0 0.92  0 0 0 0 0.78  0 0 0 0.16 -0.07" result="specks"/>
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
    const { offs, step, k } = WALL_ROWS;
    let rows = '';
    offs.forEach((off, row) => {
      let shadow = '', body = '';
      for (let s = len * e.t0 + (row % 2) * step / 2; s < len * e.t1; s += step) {
        const l = (6.2 + rand() * 1.4) * k, w = (4.4 + rand() * 0.9) * k;
        const o = off + (rand() - 0.5) * 1.2 * k;
        const x = e.from[0] + ux * s + nx * o, y = e.from[1] + uy * s + ny * o;
        const rot = f1(angle + (rand() - 0.5) * 10);
        const r = `x="${f1(-l / 2)}" y="${f1(-w / 2)}" width="${f1(l)}" height="${f1(w)}" rx="1.2"`;
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
    // data-spot-*: il contorno che lo spotlight del tutorial segue (spotlight.js).
    // Il raggio è quello dell'arco equivalente all'angolo più acuto arrotondato
    // da roundedPath: con R l'anello taglierebbe le punte
    const spot = pts => `data-spot-points="${pts.map(p => p.join(',')).join(' ')}" data-spot-radius="4"`;
    const hits = SLOTS.map(k =>
      `<path id="${IDS[k]}" class="rg-shape${k.startsWith('c_') ? ' center' : ''}" data-slot="${k}" ` +
      `d="${roundedPath(SHAPES[k].pts)}" ${spot(SHAPES[k].pts)}/>`).join('');
    // Le mie Regioni e quelle di chi sta di fronte (tutorial: «il tuo campo»,
    // «gli avversari»): sagome invisibili, lo spotlight ne prende l'inviluppo convesso
    const field = seat => SLOTS.filter(k => k.startsWith(`${seat}_`)).flatMap(k => SHAPES[k].pts);
    const box = (id, pts) => `<polygon id="${id}" points="${pts.join(' ')}" fill="none" ${spot(pts)}/>`;
    return `<svg id="board-live" viewBox="0 0 ${W} ${H}" focusable="false">
      ${walls}
      ${box('board-center-box', field('c'))}
      ${box('board-front-box', field('t'))}
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
  const wall = (x, y, n) => `<span class="ov ov-wall${n ? '' : ' zero'}" style="${pos(x, y)}">${WALL_SVG}<b>${n}</b></span>`;
  const title = (x, y, text) => `<span class="ov ov-title" style="${pos(x, y)}">${text}</span>`;
  const tower = (x, y, n, done) =>
    `<span class="ov ov-tower${done ? ' done' : ''}${n ? '' : ' zero'}" style="${pos(x, y)}">${TOWER_SVG}<b>${n}</b></span>`;
  // Pallini delle Specie, in riga o in colonna (vert)
  function dots(x, y, species, max = 5, vert = false) {
    if (!species.length) return '';
    const shown = species.slice(0, max).map(s => `<i class="sp-${s || 'umano'}"></i>`).join('');
    const more = species.length > max ? `<em>+${species.length - max}</em>` : '';
    return `<span class="ov ov-dots${vert ? ' vert' : ''}" style="${pos(x, y)}">${shown}${more}</span>`;
  }

  // Corda verticale del triangolo alla x data: [alto, basso]
  function vchord(pts, x) {
    const ys = [];
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % 3];
      if (a[0] !== b[0] && (x - a[0]) * (x - b[0]) <= 0) ys.push(a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
    });
    return [Math.min(...ys), Math.max(...ys)];
  }

  // Contenuto di una Regione, in unità di tavola, a righe dal suo lato dritto.
  // In basso (le mie) e in alto i triangoli sono simmetrici: tutto sull'asse,
  // il Muro da solo su una riga, centrato, dove il triangolo è stretto, e le
  // torri del Villaggio una sopra l'altra (incompiute, poi completate). Di
  // lato le Caratteristiche in colonna vicino al lato dritto, centrata sulla
  // sua altezza, e il Muro verso la punta. Le Specie verso il bordo esterno,
  // come le mie ruotate: in riga in alto per chi sta di fronte, in colonna ai
  // lati. Le mie Regioni con titolo ed etichette delle Caratteristiche (Muri e
  // torri si leggono da soli), quelle degli altri più piccole (CSS:
  // .ov-slot.opp). Misure provate perché tutto stia dentro il triangolo:
  // cambiando la geometria o le misure dei simboli vanno ricontrollate.
  function overlayHTML(slot, d) {
    const s = SHAPES[slot], p = s.pts;
    const ys = p.map(q => q[1]).sort((a, b) => a - b), xs = p.map(q => q[0]).sort((a, b) => a - b);
    if (s.seat === 'c' || s.seat === 't') {
      const x = (p[0][0] + p[1][0] + p[2][0]) / 3;
      if (ys[1] - ys[0] < 1) {  // lato dritto in alto
        const t = ys[0];
        if (s.seat === 'c') {
          return title(x, t + 8, 'Villaggio') +
            tower(x, t + 28, d.incomplete, false) + tower(x, t + 55, d.complete, true);
        }
        if (s.region === 'vanguard') {
          return dots(x, t + 7, d.species) + dia(x - 14, t + 23, d.att) + dia(x + 14, t + 23, d.git) +
            lbl(x - 14, t + 40, 'ATT') + lbl(x + 14, t + 40, 'GIT');
        }
        return dots(x, t + 7, d.species) + dia(x - 14, t + 23, d.dif) + dia(x + 14, t + 23, d.git) +
          lbl(x - 14, t + 40, 'DIF') + lbl(x + 14, t + 40, 'GIT') + wall(x, t + 55, d.walls);
      }
      const b = ys[2];  // lato dritto in basso
      if (s.seat === 't') return tower(x, b - 42, d.incomplete, false) + tower(x, b - 17, d.complete, true);
      if (s.region === 'vanguard') {
        return dia(x - 20, b - 48, d.att) + dia(x + 20, b - 48, d.git) +
          lbl(x - 20, b - 30, 'ATT') + lbl(x + 20, b - 30, 'GIT') + dots(x, b - 20, d.species) +
          title(x, b - 10, 'Avanscoperta');
      }
      return wall(x, b - 71, d.walls) +
        dia(x - 20, b - 48, d.dif) + dia(x + 20, b - 48, d.git) +
        lbl(x - 20, b - 30, 'DIF') + lbl(x + 20, b - 30, 'GIT') + dots(x, b - 20, d.species) +
        title(x, b - 10, s.region === 'bastion_left' ? 'Bastione SX' : 'Bastione DX');
    }
    const flatLeft = xs[1] - xs[0] < 1;
    const k = flatLeft ? 1 : -1;  // dal lato dritto verso la punta
    const flat = flatLeft ? xs[0] : xs[2];
    const cx = flat + k * 24;
    const [lo, hi] = vchord(p, cx), cy = (lo + hi) / 2;
    if (s.region === 'village') return tower(cx, cy - 15, d.incomplete, false) + tower(cx, cy + 15, d.complete, true);
    const [n1, n2] = s.region === 'vanguard' ? ['ATT', 'GIT'] : ['DIF', 'GIT'];
    const col = dia(cx, cy - 26, s.region === 'vanguard' ? d.att : d.dif) + lbl(cx, cy - 9, n1) +
      dia(cx, cy + 10, d.git) + lbl(cx, cy + 27, n2) + dots(flat + k * 7, cy - 8, d.species, 5, true);
    if (s.region === 'vanguard') return col;
    // Il Muro verso la punta, alla stessa altezza del punto tra i due rombi
    const tip = p.find(q => Math.abs(q[0] - flat) > 1);
    return col + wall(tip[0] - k * 26, cy - 8, d.walls);
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
    const ov = SLOTS.map(k => `<div class="ov-slot${k.startsWith('c_') ? '' : ' opp'}" data-slot="${k}"></div>`).join('');
    boardEl.insertAdjacentHTML('afterbegin', artMarkup() + liveMarkup() + `<div id="board-ov">${ov}</div>`);
    SLOTS.forEach(k => {
      shapes[k] = boardEl.querySelector(`.rg-shape[data-slot="${k}"]`);
      overlays[k] = boardEl.querySelector(`.ov-slot[data-slot="${k}"]`);
      arts[k] = boardEl.querySelector(`.ba-regions path[data-slot="${k}"]`);
      shapes[k].addEventListener('click', () => { if (tapHandler && owners[k]) tapHandler(k); });
    });
    Object.keys(WALL_EDGES).forEach(k => { stones[k] = boardEl.querySelector(`.bl-wall[data-slot="${k}"]`); });
  }

  /**
   * Aggiorna numeri, Muri ed evidenziazioni.
   * slots: { slot: { ownerId, data } | null } — data dipende dalla Regione:
   *   vanguard { att, git, species[] }, bastion { walls, dif, git, species[] },
   *   village { incomplete, complete }
   * flags: { hot: Set di slot (Guerrieri da riposizionare), target: Set di slot
   *   (Bastioni attaccabili ora), quiet: Set di slot che non si illuminano se
   *   cambiano (le mie Regioni nel mio turno: lì si illuminano all'arrivo delle carte),
   *   vacant: Set di posti senza giocatori vivi (Regioni spente) }
   */
  function update(slots, flags = {}) {
    if (!mounted) return;
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
      arts[k].classList.toggle('vacant', !!(flags.vacant && flags.vacant.has(SHAPES[k].seat)));
    });
  }

  /** Proprietario e Regione mostrati da uno slot. */
  function slotInfo(slot) {
    return { ownerId: owners[slot] || null, region: SHAPES[slot] ? SHAPES[slot].region : null };
  }

  /** Posizione (CSS, dentro #opp-rail) del nome di chi sta di lato: appena fuori dalla tavola, a metà altezza. */
  function seatLabelStyle(seat) {
    const x = seat === 'l' ? '-6px' : 'calc(100cqw + 6px)';
    return `left:${x};top:calc(var(--band) + ${f1(H / 2 / W * 100)}cqw)`;
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

  return { SLOTS, mount, update, slotInfo, shape, contains, flash, seatLabelStyle };
})();
