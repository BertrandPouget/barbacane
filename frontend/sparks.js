/**
 * sparks.js — Brandelli di brace che salgono davanti allo schermo.
 * Presenti nei menu, molto più radi durante la partita.
 */

const Sparks = (() => {

  // Rampa di temperatura del brandello: arancio-rosso saturo e vivo, si scurisce
  // solo negli ultimi istanti (mai il marrone/grigio spento a metà vita).
  const RAMP = [
    [0.00, [70,  20,   6]],
    [0.25, [150,  45,  10]],
    [0.50, [200,  70,  14]],
    [0.75, [235, 100,  20]],
    [1.00, [255, 150,  40]],
  ];

  const SPRITE_SIZE  = 96;
  const SPRITE_STEPS = 14;

  const CONFIG = {
    high: { spawnIntervalMs: 190, maxParticles: 26, sizeMin: 5.5, sizeMax: 12.5,
            speedMin: 110, speedMax: 230, lifeMin: 3200, lifeMax: 6000, maxAlpha: 1.0 },
    low:  { spawnIntervalMs: 900, maxParticles:  6, sizeMin: 4.8, sizeMax: 10.0,
            speedMin:  95, speedMax: 190, lifeMin: 2800, lifeMax: 4800, maxAlpha: 0.85 },
  };

  let canvas, ctx, w, h;
  let chunkMask = null;
  let sprites = [];
  let particles = [];
  let intensity = 'high';
  let running = false;
  let rafId = null;
  let lastTime = 0;
  let spawnAccumulator = 0;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function init() {
    canvas = document.getElementById('sparks-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    buildSprites();
    resize();
    prime();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (!prefersReducedMotion()) start();
    });
    if (!prefersReducedMotion()) start();
  }

  function emberRGB(heat) {
    const t = Math.max(0, Math.min(1, heat));
    let i = 1;
    while (i < RAMP.length - 1 && t > RAMP[i][0]) i++;
    const [h0, c0] = RAMP[i - 1];
    const [h1, c1] = RAMP[i];
    const k = (t - h0) / (h1 - h0);
    return [
      Math.round(c0[0] + (c1[0] - c0[0]) * k),
      Math.round(c0[1] + (c1[1] - c0[1]) * k),
      Math.round(c0[2] + (c1[2] - c0[2]) * k),
    ];
  }

  // Forma irregolare condivisa (alpha soltanto): alcuni lobi sovrapposti in
  // posizioni fisse così il brandello sembra un frammento, non un pallino.
  function buildChunkMask() {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE_SIZE;
    const cx = c.getContext('2d');
    const half = SPRITE_SIZE / 2;
    const lobes = [
      { dx: 0,            dy: 0,           r: half * 0.60 },
      { dx: -half * 0.34, dy:  half * 0.16, r: half * 0.42 },
      { dx:  half * 0.30, dy: -half * 0.18, r: half * 0.38 },
      { dx:  half * 0.08, dy:  half * 0.38, r: half * 0.30 },
      { dx: -half * 0.10, dy: -half * 0.36, r: half * 0.26 },
    ];
    cx.globalCompositeOperation = 'lighter';
    for (const lobe of lobes) {
      const g = cx.createRadialGradient(half + lobe.dx, half + lobe.dy, 0, half + lobe.dx, half + lobe.dy, lobe.r);
      g.addColorStop(0.0, 'rgba(255,255,255,1)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.9)');
      g.addColorStop(1.0, 'rgba(255,255,255,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(half + lobe.dx, half + lobe.dy, lobe.r, 0, Math.PI * 2);
      cx.fill();
    }
    return c;
  }

  // Un brandello colorato per gradino di temperatura: nucleo un filo più
  // caldo del bordo, ritagliato sulla forma irregolare del brandello.
  function buildSprites() {
    chunkMask = buildChunkMask();
    sprites = [];
    for (let i = 0; i < SPRITE_STEPS; i++) {
      const heat = i / (SPRITE_STEPS - 1);
      const [r, g, b] = emberRGB(heat);
      const [rc, gc, bc] = emberRGB(Math.min(1, heat + 0.55));
      const half = SPRITE_SIZE / 2;
      const c = document.createElement('canvas');
      c.width = c.height = SPRITE_SIZE;
      const cx = c.getContext('2d');
      const grad = cx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0.0, `rgba(${rc},${gc},${bc},1)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},1)`);
      grad.addColorStop(1.0, `rgba(${r},${g},${b},1)`);
      cx.fillStyle = grad;
      cx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
      cx.globalCompositeOperation = 'destination-in';
      cx.drawImage(chunkMask, 0, 0);
      sprites.push(c);
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setScreen(name) {
    intensity = (name === 'game') ? 'low' : 'high';
  }

  function makeParticle(cfg) {
    const big = Math.random() < 0.16;
    const size = (cfg.sizeMin + Math.random() * (cfg.sizeMax - cfg.sizeMin)) * (big ? 1.5 : 1);
    const speed = (cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin)) * (big ? 0.85 : 1);
    return {
      x: Math.random() * w,
      y: h + 16,
      vx: 0,
      vy: -speed,
      vyEnd: -speed * 0.35,
      slow: 1.5 + Math.random() * 1.8,
      swayAmp: 10 + Math.random() * 22,
      swayFreq: 0.5 + Math.random() * 1.1,
      swayPhase: Math.random() * Math.PI * 2,
      rotation: Math.random() * Math.PI * 2,
      flip: Math.random() < 0.5,
      size,
      life: cfg.lifeMin + Math.random() * (cfg.lifeMax - cfg.lifeMin),
      age: 0,
      maxAlpha: cfg.maxAlpha * (0.75 + Math.random() * 0.25),
      flickerFreq: 6 + Math.random() * 8,
      flickerPhase: Math.random() * Math.PI * 2,
    };
  }

  function spawnParticle() {
    const cfg = CONFIG[intensity];
    if (particles.length >= cfg.maxParticles) return;
    particles.push(makeParticle(cfg));
  }

  // All'avvio il campo è vuoto: pre-distribuiamo qualche brandello già in volo.
  function prime() {
    const cfg = CONFIG[intensity];
    const n = Math.floor(cfg.maxParticles * 0.5);
    for (let i = 0; i < n; i++) {
      const p = makeParticle(cfg);
      p.y = Math.random() * h;
      p.age = p.life * (1 - p.y / h) * 0.6;
      particles.push(p);
    }
  }

  function step(ts) {
    if (!running) return;
    if (!lastTime) lastTime = ts;
    const dt = Math.min(ts - lastTime, 50);
    lastTime = ts;
    const dts = dt / 1000;

    const cfg = CONFIG[intensity];
    spawnAccumulator += dt;
    while (spawnAccumulator > cfg.spawnIntervalMs) {
      spawnAccumulator -= cfg.spawnIntervalMs;
      spawnParticle();
    }

    const gust = Math.sin(ts / 3100) * 12 + Math.sin(ts / 1700) * 7;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    particles = particles.filter(p => p.age < p.life && p.y > -40);
    for (const p of particles) {
      p.age += dt;
      const t = p.age / 1000;

      p.vy += (p.vyEnd - p.vy) * Math.min(1, dts / p.slow);
      p.vx = Math.sin(t * p.swayFreq + p.swayPhase) * p.swayAmp + gust;
      p.x += p.vx * dts;
      p.y += p.vy * dts;

      const lifeRatio = p.age / p.life;

      // Cresce all'inizio, resta un pezzo di brace vivo, poi si raggrinza e
      // si spegne: niente coda lunga a bassa opacità (sembrerebbe sporco).
      let sizeScale = 1;
      if (lifeRatio < 0.08) sizeScale = lifeRatio / 0.08;
      else if (lifeRatio > 0.6) sizeScale = Math.max(0.12, 1 - ((lifeRatio - 0.6) / 0.4) * 0.88);

      let alphaScale = 1;
      if (lifeRatio < 0.08) alphaScale = lifeRatio / 0.08;
      else if (lifeRatio > 0.78) alphaScale = Math.max(0, (1 - lifeRatio) / 0.22);

      const flicker = 0.88 + 0.12 * Math.sin(t * p.flickerFreq + p.flickerPhase);
      // Resta incandescente per quasi tutta la vita, si raffredda di colpo solo alla fine.
      const heat = Math.max(0, 1 - Math.pow(lifeRatio, 1.8)) * flicker;
      const alpha = p.maxAlpha * alphaScale * flicker;
      if (alpha <= 0.01 || sizeScale <= 0.01) continue;

      const sprite = sprites[Math.round(heat * (SPRITE_STEPS - 1))];
      const rad = p.size * sizeScale * 1.15;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      if (p.flip) ctx.scale(-1, 1);
      ctx.drawImage(sprite, -rad, -rad, rad * 2, rad * 2);
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
    rafId = requestAnimationFrame(step);
  }

  function start() {
    if (running) return;
    running = true;
    lastTime = 0;
    rafId = requestAnimationFrame(step);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  return { init, setScreen };
})();
