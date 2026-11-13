/* Isometric Šilalė — viewer: camera, tile scheduling, labels, search, sharing. */
(function () {
  'use strict';
  const { ISO, isoX, isoY, prepBuilding, Grid, makeSeen, worldToLatLon, latLonToWorld, isoToWorld, hash32 } = window.SIL;
  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MAXL = ISO.LEVELS - 1;
  const Z_OFF = 17;                 // displayed zoom = Z_OFF + log2(css px per iso unit)
  const S_MIN = 0.06, S_MAX = 12;

  let D = null, META = null, BLD = [], bGrid = null, bSeen = null;
  let W = 0, H = 0, DPR = 1;
  const view = { x: 0, y: 0, s: 0.2 };
  let season = 'summer';
  let dirty = true;
  let hover = -1, selected = -1;
  let note = null;                 // {e, n, text}
  let isoBounds = null;

  // ------------------------------------------------------------ workers & tiles
  const NW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const workers = [];
  const cache = new Map();         // key -> {bmp, used}
  const pending = new Map();       // key -> worker index
  const failedTiles = new Map();
  const CACHE_MAX = Math.round(110 + 150 * Math.min(1, (navigator.deviceMemory || 4) / 8));

  /* Painted tiles are kept in IndexedDB, so a second visit (or panning back after the
     memory cache let a tile go) shows them at once. Keys carry the renderer version. */
  const store = {
    db: null, state: new Map(),
    open() {
      return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('isometric-silale', 1); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => req.result.createObjectStore('tiles');
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction('tiles', 'readwrite'), os = tx.objectStore('tiles');
            const vr = os.get('__version');
            vr.onsuccess = () => {
              if (vr.result !== window.SIL.VERSION) { os.clear(); os.put(window.SIL.VERSION, '__version'); }
              else {
                const cr = os.count();
                cr.onsuccess = () => { if (cr.result > 6000) { os.clear(); os.put(window.SIL.VERSION, '__version'); } };
              }
            };
            tx.oncomplete = () => { this.db = db; resolve(db); };
            tx.onerror = () => resolve(null);
          } catch (e) { resolve(null); }
        };
      });
    },
    get(key) {
      return new Promise((resolve) => {
        try {
          const r = this.db.transaction('tiles').objectStore('tiles').get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    queue: [], timer: 0,
    put(key, blob) {
      if (!this.db) return;
      this.queue.push([key, blob]);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const items = this.queue.splice(0);
        try {
          const os = this.db.transaction('tiles', 'readwrite').objectStore('tiles');
          for (const [k, b] of items) os.put(b, k);
        } catch (e) { /* quota or private mode: ignore */ }
      }, 400);
    },
  };
  let workersReady = 0, frameNo = 0;
  const tileKey = (L, tx, ty) => season + '/' + L + '/' + tx + '/' + ty;

  function startWorkers(dataUrl) {
    return new Promise((resolve, reject) => {
      for (let i = 0; i < NW; i++) {
        const w = new Worker('js/worker.js');
        w.inflight = 0;
        const fail = (error) => {
          console.error(error);
          w.failed = true; w.inflight = 0;
          w.terminate();
          for (const [key, owner] of pending) if (owner === w) pending.delete(key);
          reject(error);
          pump();
        };
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') {
            w.ready = true;
            workersReady++;
            if (i === 0) $('stat-t').textContent = m.trees.toLocaleString('en-US');
            if (workersReady === NW) resolve();
          } else if (m.type === 'tile') {
            w.inflight--;
            pending.delete(m.key);
            if (m.bitmap) {
              failedTiles.delete(m.key);
              if (m.key.startsWith(season + '/')) cache.set(m.key, { bmp: m.bitmap, used: frameNo });
              else m.bitmap.close();                    // finished after a season switch
            } else failedTiles.set(m.key, (failedTiles.get(m.key) || 0) + 1);
            dirty = true;
            pump();
          } else if (m.type === 'blob') {
            store.put(m.key, m.blob);
          } else if (m.type === 'error') {
            if (!w.ready) fail(new Error(m.message));
            else console.error('[worker]', m.message);
          }
        };
        w.onerror = fail;
        w.postMessage({ type: 'init', dataUrl });
        workers.push(w);
      }
    });
  }

  /* Pre-painted zoomed-out levels (tools/bake_overview.js): one image per level and season.
     Their tiles go straight into the cache, so far zoom levels never wait for a worker. */
  const baked = { meta: null, bmp: {}, loading: {}, failed: {} };
  async function loadAtlasMeta() {
    try {
      const r = await fetch(new URL('tiles/atlas.json', location.href).href);
      if (!r.ok) return;
      const a = await r.json();
      if (a.version === window.SIL.VERSION) baked.meta = a;    // stale bakes are ignored
    } catch (e) { /* no atlas: everything is painted live */ }
  }
  const bakedLevel = (L) => baked.meta && baked.meta.levels[L];
  function loadBaked(sz, L) {
    const id = sz + '-L' + L, lv = bakedLevel(L);
    if (!lv || baked.failed[id]) return Promise.resolve();
    if (!baked.loading[id]) {
      baked.loading[id] = fetch(new URL('tiles/' + baked.meta.files[id], location.href).href)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then((blob) => createImageBitmap(blob))
        .then((bmp) => {
          if (sz !== season) { bmp.close(); delete baked.loading[id]; return; }
          baked.bmp[id] = bmp;
          for (let r = 0; r < lv.rows; r++) for (let c = 0; c < lv.cols; c++)
            cache.set(tileKey(L, lv.tx0 + c, lv.ty0 + r), { bmp, sx: c * ISO.TILE, sy: r * ISO.TILE, baked: true, used: frameNo });
          dirty = true;
        })
        .catch(() => { baked.failed[id] = true; delete baked.loading[id]; pump(); });
    }
    return baked.loading[id];
  }
  // coarsest first: it is tiny and covers everything
  const loadBakedSeason = (sz) => Promise.all(Object.keys((baked.meta && baked.meta.levels) || {}).map(Number).sort((a, b) => b - a).map((L) => loadBaked(sz, L)));

  let wanted = [], wantedSet = new Set();
  let lookups = 0;
  function pump() {
    for (const key of wanted) {
      if (cache.has(key) || pending.has(key) || failedTiles.get(key) >= 2) continue;
      const kl = +key.split('/')[1];
      if (bakedLevel(kl) && !baked.failed[season + '-L' + kl]) { loadBaked(season, kl); continue; }
      const st = store.state.get(key);
      if (st === 'checking') continue;
      if (st === undefined && store.db) {
        if (lookups >= 6) continue;
        lookups++;
        store.state.set(key, 'checking');
        store.get(key).then(async (blob) => {
          let bmp = null;
          if (blob) { try { bmp = await createImageBitmap(blob); } catch (e) { bmp = null; } }
          lookups--;
          if (bmp && !key.startsWith(season + '/')) { bmp.close(); bmp = null; store.state.delete(key); }
          else if (bmp) { cache.set(key, { bmp, used: frameNo }); store.state.delete(key); dirty = true; }
          else store.state.set(key, 'miss');
          pump();
        });
        continue;
      }
      let best = null;
      for (const w of workers) if (!w.failed && w.inflight < 2 && (!best || w.inflight < best.inflight)) best = w;
      if (!best) return;
      const [theme, L, tx, ty] = key.split('/');     // the key names its own season
      best.inflight++;
      pending.set(key, best);
      best.postMessage({ type: 'tile', key, L: +L, tx: +tx, ty: +ty, theme, persist: !!store.db });
    }
  }

  // Live tiles (painted or loaded from IndexedDB) are capped at CACHE_MAX. Baked and overview
  // tiles don't count, and tiles the scheduler still wants are never evicted, so a tile can't
  // be dropped and immediately requested again.
  const isLive = (k, v) => !v.baked && +k.split('/')[1] < MAXL - 1;
  function evict() {
    const live = [];
    for (const [k, v] of cache) if (isLive(k, v)) live.push([k, v]);
    let excess = live.length - CACHE_MAX;
    if (excess <= 0) return;
    live.sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of live) {
      if (excess <= 0) break;
      if (v.used === frameNo || wantedSet.has(k)) continue;
      v.bmp.close && v.bmp.close();
      cache.delete(k);
      excess--;
    }
  }

  const levelFor = (s) => Math.max(0, Math.min(MAXL, Math.ceil(Math.log2(1 / (ISO.A0 * s)) - 1e-9)));

  // ------------------------------------------------------------ drawing
  function setPlaceholder() {
    $('q').placeholder = window.innerWidth > 640 ? 'Search Šilalė: a place, street or address' : 'Search Šilalė';
  }
  function resize() {
    setPlaceholder();
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    dirty = true;
  }

  const toScreen = (X, Y) => [(X - view.x) * view.s + W / 2, (Y - view.y) * view.s + H / 2];
  const toIso = (sx, sy) => [(sx - W / 2) / view.s + view.x, (sy - H / 2) / view.s + view.y];

  function tileRange(L, v, margin) {
    v = v || view; margin = margin || 0;
    const span = ISO.TILE * ISO.A0 * (1 << L);
    const hw = W / 2 / v.s + margin * span, hh = H / 2 / v.s + margin * span;
    const bx0 = Math.max(v.x - hw, isoBounds[0]), by0 = Math.max(v.y - hh, isoBounds[1]);
    const bx1 = Math.min(v.x + hw, isoBounds[2]), by1 = Math.min(v.y + hh, isoBounds[3]);
    return { span, tx0: Math.floor(bx0 / span), ty0: Math.floor(by0 / span), tx1: Math.floor(bx1 / span), ty1: Math.floor(by1 / span), empty: bx0 > bx1 || by0 > by1 };
  }
  const childrenCached = (L, tx, ty) => {
    if (L === 0) return false;
    for (let q = 0; q < 4; q++) if (!cache.has(tileKey(L - 1, tx * 2 + (q & 1), ty * 2 + (q >> 1)))) return false;
    return true;
  };

  /* Decide what the workers paint next, most useful first:
     1. the overview level (always kept, it is the fallback for everything),
     2. half-resolution parents of missing on-screen tiles, so gaps fill fast,
     3. on-screen tiles at the right level, nearest the centre first,
     4. a ring of tiles just off screen, so short pans are already painted.
     While gliding, plan for where the camera is going, not where it is. */
  function schedule() {
    const v = anim ? anim.target : view;
    const L = levelFor(v.s);
    const out = [];
    const RO = tileRange(MAXL, { x: 0, y: 0, s: 1e-6 });
    for (let ty = RO.ty0; ty <= RO.ty1; ty++) for (let tx = RO.tx0; tx <= RO.tx1; tx++) out.push(tileKey(MAXL, tx, ty));
    const R = tileRange(L, v);
    if (!R.empty) {
      const cx = v.x / R.span, cy = v.y / R.span;
      const vis = [], parents = new Map();
      for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) {
        const key = tileKey(L, tx, ty), d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
        vis.push([d, key]);
        if (L < MAXL - 1 && !cache.has(key) && !childrenCached(L, tx, ty)) {
          const pk = tileKey(L + 1, tx >> 1, ty >> 1);
          if (!parents.has(pk) || parents.get(pk) > d) parents.set(pk, d);
        }
      }
      [...parents].sort((a, b) => a[1] - b[1]).forEach(([k]) => out.push(k));
      vis.sort((a, b) => a[0] - b[0]).forEach(([, k]) => out.push(k));
      if (!anim) {
        const RR = tileRange(L, v, 1), ring = [];
        for (let ty = RR.ty0; ty <= RR.ty1; ty++) for (let tx = RR.tx0; tx <= RR.tx1; tx++) {
          if (tx >= R.tx0 && tx <= R.tx1 && ty >= R.ty0 && ty <= R.ty1) continue;
          ring.push([Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy), tileKey(L, tx, ty)]);
        }
        // prefetch only as many as the live-tile budget has room for
        const liveWanted = out.filter((k) => { const kl = +k.split('/')[1]; return !bakedLevel(kl) && kl < MAXL - 1; }).length;
        const room = Math.max(0, CACHE_MAX - liveWanted - 4);
        ring.sort((a, b) => a[0] - b[0]).slice(0, room).forEach(([, k]) => out.push(k));
      }
    }
    wanted = out;
    wantedSet = new Set(out);
    pump();
  }

  function drawTileImage(bmp, sx, sy, sw, sh, X, Y, span) {
    const k = view.s * DPR;
    const dx0 = Math.round(((X - view.x) * view.s + W / 2) * DPR), dy0 = Math.round(((Y - view.y) * view.s + H / 2) * DPR);
    const dx1 = Math.round(((X + span - view.x) * view.s + W / 2) * DPR), dy1 = Math.round(((Y + span - view.y) * view.s + H / 2) * DPR);
    if (dx1 <= dx0 || dy1 <= dy0 || k <= 0) return;
    ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx.drawImage(bmp, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
  }

  function render() {
    frameNo++;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    if (!isoBounds) return;
    const L = levelFor(view.s);
    const R = tileRange(L);
    if (!R.empty) {
      for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) {
        const key = tileKey(L, tx, ty);
        const X = tx * R.span, Y = ty * R.span;
        const hit = cache.get(key);
        if (hit) { hit.used = frameNo; drawTileImage(hit.bmp, hit.sx || 0, hit.sy || 0, ISO.TILE, ISO.TILE, X, Y, R.span); continue; }
        // Not painted yet. Stand-in: the nearest coarser tile, softened when it is stretched a lot
        // (blocky pixels several times bigger than the art read as broken, blur reads as loading)…
        for (let d = 1; L + d <= MAXL; d++) {
          const a = cache.get(tileKey(L + d, tx >> d, ty >> d));
          if (!a) continue;
          const sub = ISO.TILE >> d;
          if (sub < 1) break;
          a.used = frameNo;
          const stretch = (R.span * view.s * DPR) / sub;
          ctx.imageSmoothingEnabled = stretch > 2.5;
          drawTileImage(a.bmp, (a.sx || 0) + (tx - ((tx >> d) << d)) * sub, (a.sy || 0) + (ty - ((ty >> d) << d)) * sub, sub, sub, X, Y, R.span);
          ctx.imageSmoothingEnabled = false;
          break;
        }
        // …with any finer tiles that are already painted laid on top (when zooming out).
        if (L > 0) {
          const half = R.span / 2;
          for (let q = 0; q < 4; q++) {
            const c = cache.get(tileKey(L - 1, tx * 2 + (q & 1), ty * 2 + (q >> 1)));
            if (!c) continue;
            c.used = frameNo;
            drawTileImage(c.bmp, c.sx || 0, c.sy || 0, ISO.TILE, ISO.TILE, X + (q & 1) * half, Y + (q >> 1) * half, half);
          }
        }
      }
    }

    schedule();
    evict();

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawHighlight();
    drawLabels();
    placeNote();
    updateReadout();
  }

  function loop() {
    if (anim) stepAnim();
    if (dirty) { dirty = false; render(); }
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ buildings: hit testing & highlight
  function hullOf(points) {
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of points) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = points.length - 1; i >= 0; i--) { const p = points[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  function buildingHull(b) {
    const pts = [];
    const r = b.r;
    const zTop = b.kind === 'flat' ? b.h : b.h;
    for (let i = 0; i < r.length; i += 2) {
      pts.push([isoX(r[i], r[i + 1]), isoY(r[i], r[i + 1], 0)]);
      pts.push([isoX(r[i], r[i + 1]), isoY(r[i], r[i + 1], zTop)]);
    }
    if (b.box && b.kind !== 'flat') {
      for (const [e, n] of window.SIL.boxCorners(b.box, 0.6)) {
        pts.push([isoX(e, n), isoY(e, n, 0)]);
        pts.push([isoX(e, n), isoY(e, n, b.h)]);
      }
      const { c, u, l } = b.box;
      for (const s of [-0.5, 0.5]) { const e = c[0] + u[0] * l * s, n = c[1] + u[1] * l * s; pts.push([isoX(e, n), isoY(e, n, b.h + b.rise)]); }
    }
    if (b.tower) { const t = b.tower; pts.push([isoX(t.c[0], t.c[1]), isoY(t.c[0], t.c[1], t.h + t.spire)]); }
    return hullOf(pts);
  }
  function inConvex(h, x, y) {
    let sign = 0;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length];
      const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false; }
    }
    return true;
  }
  function pick(sx, sy) {
    const [X, Y] = toIso(sx, sy);
    bSeen.stamp++;
    const ids = bGrid.query(X, Y, X, Y, [], bSeen);
    let best = -1, bd = Infinity;
    for (const id of ids) {
      const b = BLD[id];
      if (X < b.bbox[0] || X > b.bbox[2] || Y < b.bbox[1] || Y > b.bbox[3]) continue;
      if (!b.hull) b.hull = buildingHull(b);
      if (inConvex(b.hull, X, Y) && b.depth < bd) { bd = b.depth; best = id; }
    }
    return best;
  }
  function drawHighlight() {
    for (const [id, strong] of [[hover, false], [selected, true]]) {
      if (id < 0) continue;
      const b = BLD[id];
      if (!b.hull) b.hull = buildingHull(b);
      ctx.beginPath();
      b.hull.forEach((p, i) => { const [x, y] = toScreen(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = strong ? 'rgba(253,185,19,0.22)' : 'rgba(253,185,19,0.12)';
      ctx.fill();
      ctx.lineWidth = strong ? 3 : 2;
      ctx.strokeStyle = '#fdb913';
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ labels
  let LABELS = [];
  function buildLabels() {
    const L = [];
    for (const p of D.places) {
      L.push({ t: p.n, X: isoX(p.x, p.y), Y: isoY(p.x, p.y, 0), zmin: p.k === 'town' ? 0 : 15.2, zmax: p.k === 'town' ? 17.4 : 18.6, size: p.k === 'town' ? 26 : 15, pri: p.k === 'town' ? 0 : 1 });
    }
    const usedNames = new Set();
    const PRI = { place_of_worship: 2, townhall: 2, museum: 2, school: 3, hospital: 3, bus_station: 3, library: 3, stadium: 3, park: 3, water: 3 };
    BLD.forEach((b) => {
      if (!b.name) return;
      usedNames.add(b.name);
      const top = b.tower ? b.tower.h + b.tower.spire + 4 : b.h + b.rise + 2;
      L.push({ t: b.name, X: isoX(b.c[0], b.c[1]), Y: isoY(b.c[0], b.c[1], top), zmin: (PRI[b.kindName] || 4) <= 2 ? 17.8 : 18.9, zmax: 99, size: 13, pri: PRI[b.kindName] || 4, b: b.i });
    });
    for (const p of D.pois) {
      if (usedNames.has(p.n)) continue;
      const pri = PRI[p.k] || 5;
      L.push({ t: p.n, X: isoX(p.x, p.y), Y: isoY(p.x, p.y, 0), zmin: p.k === 'water' ? 16.8 : pri <= 3 ? 18.4 : 19.2, zmax: p.k === 'water' ? 19.2 : 99, size: p.k === 'water' ? 13 : 12, pri, water: p.k === 'water' });
    }
    for (const s of D.streets) {
      L.push({ t: s.n, X: isoX(s.x, s.y), Y: isoY(s.x, s.y, 0), zmin: s.len > 600 ? 18.6 : 19.3, zmax: 99, size: 11, pri: 6, street: true });
    }
    L.sort((a, b) => a.pri - b.pri);
    LABELS = L;
  }
  function drawLabels() {
    const z = Z_OFF + Math.log2(view.s);
    const placed = [];
    const dark = season === 'night';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const lb of LABELS) {
      if (z < lb.zmin || z >= lb.zmax) continue;
      const [x, y] = toScreen(lb.X, lb.Y);
      if (x < -200 || x > W + 200 || y < -40 || y > H + 40) continue;
      const big = lb.size >= 20;
      ctx.font = `${big || lb.pri <= 1 ? 700 : 600} ${lb.size}px "Pixelify Sans", ui-monospace, monospace`;
      let text = lb.t;
      if (text.length > 34) text = text.slice(0, 32) + '…';
      const w = ctx.measureText(text).width + 8, h = lb.size + 6;
      const r = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
      if (placed.some((p) => !(r[2] < p[0] || r[0] > p[2] || r[3] < p[1] || r[1] > p[3]))) continue;
      placed.push(r);
      ctx.lineWidth = big ? 5 : 3.5;
      if (lb.street) {
        ctx.strokeStyle = dark ? 'rgba(10,14,28,.85)' : 'rgba(255,255,255,.9)';
        ctx.fillStyle = dark ? '#c9d2e8' : '#3d4640';
      } else if (lb.water) {
        ctx.strokeStyle = dark ? 'rgba(10,14,28,.85)' : 'rgba(255,255,255,.85)';
        ctx.fillStyle = dark ? '#8fb8e8' : '#21598a';
      } else {
        ctx.strokeStyle = '#1d2620';
        ctx.fillStyle = lb.pri <= 2 ? '#fdb913' : '#ffffff';
      }
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }

  // ------------------------------------------------------------ camera
  function clampView() {
    view.s = Math.max(S_MIN, Math.min(S_MAX, view.s));
    if (!isoBounds) return;
    const m = 60;
    view.x = Math.max(isoBounds[0] - m, Math.min(isoBounds[2] + m, view.x));
    view.y = Math.max(isoBounds[1] - m, Math.min(isoBounds[3] + m, view.y));
  }
  let userMoved = false;
  function zoomAt(sx, sy, f) {
    cancelGesture();
    anim = null; inertia = null; userMoved = true; cancelCardSoon();
    const [X, Y] = toIso(sx, sy);
    view.s *= f; clampView();
    const [X2, Y2] = toIso(sx, sy);
    view.x += X - X2; view.y += Y - Y2; clampView();
    dirty = true; scheduleHash();
  }
  function homeView() {
    const w = isoBounds[2] - isoBounds[0], h = isoBounds[3] - isoBounds[1];
    const s = Math.min((W - 40) / w, (H - 150) / h);
    return { x: (isoBounds[0] + isoBounds[2]) / 2, y: (isoBounds[1] + isoBounds[3]) / 2 + 10, s: Math.max(S_MIN, s) };
  }

  let anim = null;
  function flyTo(target, ms) {
    anim = null; inertia = null;
    target = Object.assign({}, target);
    if (reduceMotion) { Object.assign(view, target); clampView(); dirty = true; scheduleHash(); return; }
    const from = { x: view.x, y: view.y, s: view.s };
    const dist = Math.hypot(target.x - from.x, target.y - from.y);
    const sFit = Math.min(W, H) / (dist * 1.4 + 1);
    const l0 = Math.log2(from.s), l1 = Math.log2(target.s);
    const lMid = Math.log2(Math.min(from.s, target.s, sFit));
    const bump = Math.max(0, (l0 + l1) / 2 - lMid);
    anim = { from, target, bump, t0: performance.now(), ms: ms || Math.min(2600, 900 + bump * 320 + Math.abs(l1 - l0) * 120) };
  }
  function stepAnim() {
    const a = anim;
    let t = (performance.now() - a.t0) / a.ms;
    if (t >= 1) { t = 1; anim = null; }
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const l = Math.log2(a.from.s) + (Math.log2(a.target.s) - Math.log2(a.from.s)) * e - a.bump * Math.sin(Math.PI * e);
    // move in screen-consistent terms: progress of position follows scale so far-away glides feel even
    view.x = a.from.x + (a.target.x - a.from.x) * e;
    view.y = a.from.y + (a.target.y - a.from.y) * e;
    view.s = Math.pow(2, l);
    clampView();
    dirty = true;
    if (!anim) scheduleHash();
  }

  // ------------------------------------------------------------ URL hash: #zoom/lat/lon[/note]
  let hashTimer = 0;
  function centerLatLon() {
    const [e, n] = isoToWorld(view.x, view.y);
    return worldToLatLon(META, e, n);
  }
  /* #zoom/lat/lon[/@pinLat,pinLon][/note]. Without "@", the note pin sits at the view centre
     (what Share produces). After panning away from a note, its own position is kept with "@". */
  function viewHash(withNote, pin) {
    const [lat, lon] = centerLatLon();
    const z = (Z_OFF + Math.log2(view.s)).toFixed(2);
    let h = `#${z}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
    if (withNote && pin) h += `/@${pin[0].toFixed(5)},${pin[1].toFixed(5)}`;
    if (withNote) h += '/' + encodeURIComponent(withNote);
    return h;
  }
  function scheduleHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const h = note && note.keep ? viewHash(note.text, worldToLatLon(META, note.e, note.n)) : viewHash(null);
      try { history.replaceState(null, '', h); } catch (e) { /* sandboxed */ }
    }, 350);
  }
  function readHash() {
    const parts = (location.hash || '').replace(/^#/, '').split('/');
    const num = /^-?\d+(?:\.\d+)?$/;
    if (parts.length < 3 || !parts.slice(0, 3).every((p) => num.test(p))) return null;
    const [z, lat, lon] = parts.slice(0, 3).map(Number);
    const [e, n] = latLonToWorld(META, lat, lon);
    const v = { x: isoX(e, n), y: isoY(e, n, 0), s: Math.pow(2, z - Z_OFF) };
    let rest = parts.slice(3), pe = e, pn = n;
    const pin = rest.length && rest[0].match(/^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (pin) { [pe, pn] = latLonToWorld(META, +pin[1], +pin[2]); rest = rest.slice(1); }
    let text = rest.join('/');
    try { text = decodeURIComponent(text); } catch (err) { /* keep it raw */ }
    note = text.trim() ? { e: pe, n: pn, text: text.slice(0, 140), keep: true } : null;
    return v;
  }
  function updateReadout() {
    const [lat, lon] = centerLatLon();
    $('readout').textContent = `${lat.toFixed(5)}° N · ${lon.toFixed(5)}° E · z${(Z_OFF + Math.log2(view.s)).toFixed(1)}`;
  }
  function placeNote() {
    const pin = $('note-pin');
    if (!note) { pin.hidden = true; return; }
    const [x, y] = toScreen(isoX(note.e, note.n), isoY(note.e, note.n, 0));
    const t = $('note-text');
    if (t.textContent !== note.text) t.textContent = note.text;
    pin.hidden = false;
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
  }

  // ------------------------------------------------------------ input: mouse, touch, pen
  /* Gestures:
     drag = pan (with momentum) · pinch = zoom around the fingers (and pan with them)
     double-tap / double-click = zoom in · two-finger tap = zoom out
     tap, then hold and slide up/down = one-handed zoom · tap = building details */
  const pointers = new Map();
  let gesture = null, lastTap = null, inertia = null;
  const SLOP = 10;
  const pts = () => [...pointers.values()];
  const centroid = () => { const p = pts(); return [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]; };
  const spread = () => { const p = pts(); return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1; };
  const holdPoint = (anchor, sx, sy) => { view.x = anchor[0] - (sx - W / 2) / view.s; view.y = anchor[1] - (sy - H / 2) / view.s; };
  function beginPan(x, y, moved) {
    gesture = { type: 'pan', x, y, x0: x, y0: y, moved: moved || 0, vx: 0, vy: 0, t: performance.now() };
  }
  function beginPinch() {
    const [cx, cy] = centroid();
    gesture = { type: 'pinch', d0: spread(), s0: view.s, anchor: toIso(cx, cy), t0: performance.now(), change: 0, c0: [cx, cy], moved: 0 };
  }
  function zoomToward(sx, sy, f) {        // animated zoom that keeps (sx, sy) under the finger
    const anchor = toIso(sx, sy);
    const s = Math.max(S_MIN, Math.min(S_MAX, view.s * f));
    flyTo({ x: anchor[0] - (sx - W / 2) / s, y: anchor[1] - (sy - H / 2) / s, s }, 320);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    anim = null; inertia = null; userMoved = true; cancelCardSoon();
    hideHint();
    if (pointers.size === 1) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        gesture = { type: 'tapzoom', x: e.clientX, y: e.clientY, s0: view.s, anchor: toIso(e.clientX, e.clientY), moved: 0 };
      } else beginPan(e.clientX, e.clientY);
      canvas.classList.add('dragging');
    } else if (pointers.size === 2) beginPinch();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && isoBounds) {
        const id = pick(e.clientX, e.clientY);
        if (id !== hover) { hover = id; dirty = true; canvas.classList.toggle('pointing', id >= 0); }
      }
      return;
    }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (!gesture) return;
    anim = null; inertia = null;
    if (gesture.type === 'pinch' && pointers.size >= 2) {
      const [cx, cy] = centroid(), d = spread();
      view.s = Math.max(S_MIN, Math.min(S_MAX, gesture.s0 * d / gesture.d0));
      holdPoint(gesture.anchor, cx, cy);
      gesture.change = Math.max(gesture.change, Math.abs(d - gesture.d0));
      gesture.moved = Math.max(gesture.moved, Math.hypot(cx - gesture.c0[0], cy - gesture.c0[1]));
      clampView(); dirty = true;
    } else if (gesture.type === 'tapzoom') {
      const dy = e.clientY - gesture.y;
      gesture.moved = Math.max(gesture.moved, Math.abs(dy));
      if (gesture.moved > SLOP) {
        view.s = Math.max(S_MIN, Math.min(S_MAX, gesture.s0 * Math.exp(dy * 0.012)));
        holdPoint(gesture.anchor, gesture.x, gesture.y);
        clampView(); dirty = true;
      }
    } else if (gesture.type === 'pan') {
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
      gesture.x = e.clientX; gesture.y = e.clientY;
      gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0));
      const now = performance.now(), dt = Math.max(1, now - gesture.t);
      gesture.vx = gesture.vx * 0.6 + (dx / dt) * 0.4; gesture.vy = gesture.vy * 0.6 + (dy / dt) * 0.4;
      gesture.t = now;
      view.x -= dx / view.s; view.y -= dy / view.s;
      clampView(); dirty = true;
    }
  });
  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const g = gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (pointers.size === 1) {
        // a quick two-finger tap zooms out; otherwise carry on panning with the remaining finger
        if (performance.now() - g.t0 < 300 && g.change < 18 && g.moved < 18) zoomToward(W / 2, H / 2, 1 / 2);
        const [p] = pts(); beginPan(p[0], p[1], 99);
      }
      if (pointers.size === 0) { gesture = null; canvas.classList.remove('dragging'); scheduleHash(); }
      return;
    }
    if (pointers.size > 0) return;
    canvas.classList.remove('dragging');
    gesture = null;
    if (g.type === 'tapzoom') {
      lastTap = null;
      if (g.moved <= SLOP) zoomToward(g.x, g.y, 2);
      else scheduleHash();
      return;
    }
    if (g.moved < SLOP) {
      lastTap = { t: performance.now(), x: e.clientX, y: e.clientY };
      onTap(e.clientX, e.clientY);
    } else {
      lastTap = null;
      if (!reduceMotion && performance.now() - g.t < 80 && Math.hypot(g.vx, g.vy) > 0.15) inertia = { vx: g.vx, vy: g.vy, t: performance.now() };
      scheduleHash();
    }
  };
  function cancelGesture() {
    if (!gesture && !inertia) return;
    const active = [...pointers.keys()];
    pointers.clear();
    gesture = null; lastTap = null; anim = null; inertia = null;
    canvas.classList.remove('dragging');
    for (const id of active) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (META) scheduleHash();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (e) => { if (pointers.has(e.pointerId)) cancelGesture(); });
  canvas.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) cancelGesture(); });
  window.addEventListener('blur', cancelGesture);
  canvas.addEventListener('pointerleave', () => { if (hover >= 0 && !gesture) { hover = -1; dirty = true; } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)));
  }, { passive: false });
  // Safari's own pinch events would zoom the page instead of the map
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  (function inertiaLoop() {
    if (inertia) {
      const now = performance.now(), dt = now - inertia.t; inertia.t = now;
      view.x -= (inertia.vx * dt) / view.s; view.y -= (inertia.vy * dt) / view.s;
      const decay = Math.pow(0.992, dt);
      inertia.vx *= decay; inertia.vy *= decay;
      clampView(); dirty = true;
      if (Math.hypot(inertia.vx, inertia.vy) < 0.02) { inertia = null; scheduleHash(); }
    }
    requestAnimationFrame(inertiaLoop);
  })();
  function flyToPoint([X, Y], s) { flyTo({ x: X, y: Y, s: Math.max(S_MIN, Math.min(S_MAX, s)) }); }

  // first touch visit: a one-time hint about the gestures
  function hideHint() {
    const h = $('hint');
    if (h.hidden) return;
    h.hidden = true;
    try { localStorage.setItem('silale-hint', '1'); } catch (e) { /* ignore */ }
  }
  function maybeHint() {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    try { if (localStorage.getItem('silale-hint')) return; } catch (e) { /* show it anyway */ }
    $('hint').hidden = false;
  }
  $('hint-ok').onclick = hideHint;

  function onTap(sx, sy) {
    const id = pick(sx, sy);
    if (id >= 0) showCard(id); else hideCard();
  }

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') { if (e.target.closest('.modal')) closeModals(); else e.target.blur(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(Arrow(Left|Right|Up|Down)|[aAdDwWhH])$/.test(e.key)) cancelCardSoon();
    const step = 140 / view.s;
    switch (e.key) {
      case '/': e.preventDefault(); $('q').focus(); break;
      case 'h': case 'H': flyTo(homeView()); break;
      case 'r': case 'R': surprise(); break;
      case 's': case 'S': setSeason({ summer: 'winter', winter: 'night', night: 'summer' }[season]); break;
      case '+': case '=': zoomAt(W / 2, H / 2, 1.6); break;
      case '-': case '_': zoomAt(W / 2, H / 2, 1 / 1.6); break;
      case 'ArrowLeft': case 'a': case 'A': flyTo({ x: view.x - step, y: view.y, s: view.s }, 260); break;
      case 'ArrowRight': case 'd': case 'D': flyTo({ x: view.x + step, y: view.y, s: view.s }, 260); break;
      case 'ArrowUp': case 'w': case 'W': flyTo({ x: view.x, y: view.y - step, s: view.s }, 260); break;
      case 'ArrowDown': flyTo({ x: view.x, y: view.y + step, s: view.s }, 260); break;
      case 'Escape': hideCard(); closeModals(); break;
      default: return;
    }
  });

  $('zin').onclick = () => zoomAt(W / 2, H / 2, 1.8);
  $('zout').onclick = () => zoomAt(W / 2, H / 2, 1 / 1.8);
  $('home').onclick = () => flyTo(homeView());
  $('dice').onclick = () => surprise();

  // ------------------------------------------------------------ seasons
  function setSeason(sz) {
    if (!sz || sz === season) return;
    season = sz;
    failedTiles.clear();
    wanted = []; wantedSet = new Set();           // nothing from the old season gets requested again
    document.body.dataset.season = sz;
    document.querySelectorAll('.season button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.season === sz)));
    // drop tiles of other seasons, keeping memory in check
    for (const [k, v] of cache) if (!k.startsWith(sz + '/')) { if (!v.baked && v.bmp.close) v.bmp.close(); cache.delete(k); }
    for (const id of Object.keys(baked.bmp)) if (!id.startsWith(sz + '-')) { baked.bmp[id].close(); delete baked.bmp[id]; delete baked.loading[id]; }
    if (baked.meta) loadBakedSeason(sz);
    try { localStorage.setItem('silale-season', sz); } catch (e) { /* storage unavailable */ }
    dirty = true;
  }
  document.querySelectorAll('.season button').forEach((b) => (b.onclick = () => setSeason(b.dataset.season)));

  // ------------------------------------------------------------ card
  const KIND = {
    place_of_worship: 'Church', townhall: 'Town hall', school: 'School', kindergarten: 'Kindergarten',
    supermarket: 'Supermarket', convenience: 'Shop', fuel: 'Fuel station', courthouse: 'Courthouse', police: 'Police',
    hospital: 'Hospital', library: 'Library', museum: 'Museum', bus_station: 'Bus station', post_office: 'Post office',
    bank: 'Bank', cafe: 'Café', restaurant: 'Restaurant', fast_food: 'Fast food', hotel: 'Hotel', guest_house: 'Guest house',
    sports_hall: 'Sports hall', fire_station: 'Fire station', doityourself: 'Hardware store', bakery: 'Bakery',
    government: 'Government office', car_repair: 'Car repair', veterinary: 'Vet', pharmacy: 'Pharmacy',
  };
  const BTYPE = {
    house: 'House', detached: 'House', apartments: 'Apartment block', residential: 'Apartment block', garage: 'Garage', garages: 'Garages',
    shed: 'Shed', church: 'Church', school: 'School', commercial: 'Commercial building', retail: 'Shop', supermarket: 'Supermarket',
    industrial: 'Industrial building', public: 'Public building', hospital: 'Hospital', roof: 'Canopy', ruins: 'Ruins', kiosk: 'Kiosk', service: 'Service building',
  };
  const MATK = { panel: 'Apartment block', house: 'House', shed: 'Outbuilding', garage: 'Garages', metal: 'Industrial building', commercial: 'Commercial building', civic: 'Public building', brick: 'Church', ruins: 'Ruins', canopy: 'Canopy' };
  const pretty = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';
  function describe(b) {
    return KIND[b.kindName] || (b.kindName && pretty(b.kindName)) || BTYPE[b.btype] || MATK[b.m] || 'Building';
  }
  /* Search results and "surprise me" open their card once the glide has mostly landed.
     Only one such card can be pending, and any newer choice or interruption cancels it,
     so a stale card can't replace what the user picked (or pull the camera back on phones). */
  let cardTimer = 0;
  function showCardSoon(id, ms) {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { cardTimer = 0; showCard(id); }, ms);
  }
  function cancelCardSoon() { clearTimeout(cardTimer); cardTimer = 0; }

  function showCard(id) {
    cancelCardSoon();
    selected = id; dirty = true;
    const b = BLD[id];
    $('card-kind').textContent = describe(b);
    $('card-title').textContent = b.name || b.addr || describe(b);
    const facts = [];
    if (b.addr && b.name) facts.push(['Address', b.addr]);
    else if (b.addr) facts.push(['Town', 'Šilalė']);
    if (b.year) facts.push(['Built', b.year]);
    if (b.den) facts.push(['Faith', pretty(b.den)]);
    const top = b.tower ? b.tower.h + b.tower.spire : b.h + b.rise;
    facts.push(['Height', `≈ ${Math.round(top)} m${b.tower ? ' (tower)' : ''}`]);
    facts.push(['Footprint', `${Math.round(b.area).toLocaleString('en-US')} m²`]);
    const [lat, lon] = worldToLatLon(META, b.c[0], b.c[1]);
    facts.push(['Location', `${lat.toFixed(5)}, ${lon.toFixed(5)}`]);
    const dl = $('card-facts'); dl.textContent = '';
    for (const [k, v] of facts) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
    const osm = $('card-osm');
    const id2 = String(b.osm || '');
    osm.href = id2.startsWith('r') ? `https://www.openstreetmap.org/relation/${id2.slice(1)}` : `https://www.openstreetmap.org/way/${id2}`;
    $('card').hidden = false;
    document.body.classList.add('card-open');
    revealBehindCard(b);
  }
  function hideCard() {
    cancelCardSoon();
    if (selected >= 0) { selected = -1; dirty = true; }
    $('card').hidden = true;
    document.body.classList.remove('card-open');
  }
  // On a phone the card covers the lower part of the screen: glide so the building stays visible.
  function revealBehindCard(b) {
    if (W > 640) return;
    requestAnimationFrame(() => {
      const top = 70, bottom = H - $('card').offsetHeight - 16;
      const tgt = anim ? anim.target : view;
      const X = isoX(b.c[0], b.c[1]), Y = isoY(b.c[0], b.c[1], b.h * 0.5);
      const sy = (Y - tgt.y) * tgt.s + H / 2, sx = (X - tgt.x) * tgt.s + W / 2;
      if (sy > top + 40 && sy < bottom - 40 && sx > 70 && sx < W - 70) return;
      const want = (top + bottom) / 2;
      flyTo({ x: X, y: Y - (want - H / 2) / tgt.s, s: tgt.s }, 420);
    });
  }
  $('card-share').onclick = () => {
    const b = BLD[selected];
    if (!b) return;
    const [lat, lon] = worldToLatLon(META, b.c[0], b.c[1]);
    shareTarget = { lat, lon, z: Math.max(19, Z_OFF + Math.log2(view.s)) };
    $('share-note').value = b.name || b.addr || '';
    $('share-h').textContent = 'Share this place';
    $('share-link').value = shareUrl();
    openModal('share');
  };
  // swipe a sheet down to close it
  document.querySelectorAll('.sheet').forEach((sh) => {
    let y0 = null, dy = 0;
    sh.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || sh.scrollTop > 0 || e.target.closest('input, textarea, a, button')) return;
      y0 = e.clientY; dy = 0;
    });
    sh.addEventListener('pointermove', (e) => {
      if (y0 === null) return;
      dy = Math.max(0, e.clientY - y0);
      sh.style.transform = dy ? `translateY(${dy}px)` : '';
    });
    const end = () => {
      if (y0 === null) return;
      y0 = null; sh.style.transform = '';
      if (dy > 70) { if (sh.id === 'card') hideCard(); else closeModals(); }
    };
    sh.addEventListener('pointerup', end);
    sh.addEventListener('pointercancel', end);
  });
  $('card-close').onclick = hideCard;

  // ------------------------------------------------------------ surprise
  function surprise() {
    const named = BLD.filter((b) => b.name);
    const pool = Math.random() < 0.45 ? named : BLD.filter((b) => b.area > 60);
    const b = pool[(Math.random() * pool.length) | 0];
    note = null;
    flyTo({ x: isoX(b.c[0], b.c[1]), y: isoY(b.c[0], b.c[1], b.h * 0.6), s: 3.2 + Math.random() * 2.5 });
    showCardSoon(b.i, reduceMotion ? 0 : 900);
  }

  // ------------------------------------------------------------ search
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[„“"]/g, '');
  let INDEX = [];
  function buildIndex() {
    const I = [];
    const seenAddr = new Set();
    BLD.forEach((b) => {
      if (b.name) I.push({ label: b.name, kind: describe(b), e: b.c[0], n: b.c[1], b: b.i, pri: 0 });
      if (b.addr && !seenAddr.has(b.addr)) { seenAddr.add(b.addr); I.push({ label: b.addr, kind: b.name ? 'Address' : describe(b), e: b.c[0], n: b.c[1], b: b.i, pri: 2 }); }
    });
    const named = new Set(I.map((x) => x.label));
    for (const p of D.pois) if (!named.has(p.n)) I.push({ label: p.n, kind: p.k === 'water' ? 'Water' : (KIND[p.k] || pretty(p.k)), e: p.x, n: p.y, pri: 1 });
    for (const s of D.streets) I.push({ label: s.n, kind: 'Street', e: s.x, n: s.y, pri: 1, street: true });
    for (const p of D.places) I.push({ label: p.n, kind: p.k === 'town' ? 'Town' : 'Village', e: p.x, n: p.y, pri: 0, place: p.k });
    I.forEach((x) => (x.key = norm(x.label)));
    INDEX = I;
  }
  function search(q) {
    const nq = norm(q.trim());
    if (!nq) return [];
    const coord = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    const out = [];
    if (coord) out.push({ label: `${(+coord[1]).toFixed(5)}, ${(+coord[2]).toFixed(5)}`, kind: 'Coordinates', coord: [+coord[1], +coord[2]] });
    const words = nq.split(/\s+/);
    const scored = [];
    for (const it of INDEX) {
      let sc = 0;
      if (it.key.startsWith(nq)) sc = 4;
      else if (it.key.split(/[\s.,-]+/).some((w) => w.startsWith(nq))) sc = 3;
      else if (words.every((w) => it.key.includes(w))) sc = 2;
      else continue;
      scored.push([sc * 10 - it.pri - it.label.length / 100, it]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, it] of scored.slice(0, 8)) out.push(it);
    return out;
  }
  const qEl = $('q'), resEl = $('results');
  let results = [], sel = -1;
  function renderResults() {
    resEl.textContent = '';
    if (!qEl.value.trim()) { resEl.hidden = true; qEl.setAttribute('aria-expanded', 'false'); return; }
    if (!results.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = 'No match. Try a street name like “Vytauto” or “Nepriklausomybės 8”.';
      resEl.append(li);
    }
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option'); li.id = 'res-' + i;
      li.setAttribute('aria-selected', String(i === sel));
      const t = document.createElement('span'); t.className = 't'; t.textContent = r.label;
      const k = document.createElement('span'); k.className = 'k'; k.textContent = r.kind;
      li.append(t, k);
      li.onmousedown = (ev) => { ev.preventDefault(); choose(r); };
      resEl.append(li);
    });
    resEl.hidden = false; qEl.setAttribute('aria-expanded', 'true');
  }
  function choose(r) {
    cancelCardSoon();
    qEl.value = r.label; resEl.hidden = true; qEl.blur(); note = null;
    $('q-clear').hidden = false;
    if (r.coord) {
      const [e, n] = latLonToWorld(META, r.coord[0], r.coord[1]);
      note = { e, n, text: r.label, keep: false };
      flyToPoint([isoX(e, n), isoY(e, n, 0)], 3.5);
      return;
    }
    const s = r.place === 'town' ? 0.6 : r.place ? 1.2 : r.street ? 2.2 : 4;
    if (r.b !== undefined) {
      const b = BLD[r.b];
      flyToPoint([isoX(b.c[0], b.c[1]), isoY(b.c[0], b.c[1], b.h * 0.6)], s);
      showCardSoon(r.b, reduceMotion ? 0 : 700);
    } else {
      hideCard();
      flyToPoint([isoX(r.e, r.n), isoY(r.e, r.n, 0)], s);
    }
  }
  qEl.addEventListener('input', () => {
    results = search(qEl.value); sel = results.length ? 0 : -1; renderResults();
    $('q-clear').hidden = !qEl.value;
  });
  $('q-clear').onclick = () => { qEl.value = ''; $('q-clear').hidden = true; results = []; renderResults(); qEl.focus(); };
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); renderResults(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderResults(); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); choose(results[sel]); }
  });
  qEl.addEventListener('blur', () => setTimeout(() => (resEl.hidden = true), 120));
  qEl.addEventListener('focus', () => { if (qEl.value.trim()) renderResults(); });

  // ------------------------------------------------------------ share & about
  function openModal(id) {
    $(id).hidden = false;
    // on touch screens, focusing a field would pop the keyboard over the sheet
    const f = window.matchMedia('(pointer: coarse)').matches ? $(id).querySelector('.close') : $(id).querySelector('textarea, input, button');
    f && f.focus();
  }
  function closeModals() { document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); });
  });
  let shareTarget = null;
  function shareUrl() {
    const base = location.href.split('#')[0];
    const noteText = $('share-note').value.trim() || null;
    if (shareTarget) {
      let h = `#${shareTarget.z.toFixed(2)}/${shareTarget.lat.toFixed(5)}/${shareTarget.lon.toFixed(5)}`;
      if (noteText) h += '/' + encodeURIComponent(noteText);
      return base + h;
    }
    return base + viewHash(noteText);
  }
  $('share-btn').onclick = () => {
    shareTarget = null;
    $('share-h').textContent = 'Share this view';
    $('share-note').value = '';
    $('share-link').value = shareUrl();
    openModal('share');
  };
  if (navigator.share) {
    $('send-btn').hidden = false;
    $('send-btn').onclick = () => {
      const url = shareUrl();
      navigator.share({ title: 'Isometric Šilalė', text: $('share-note').value.trim() || 'Šilalė in pixels', url })
        .catch((err) => { if (err && err.name !== 'AbortError') toast('Copy the link instead'); });
    };
  }
  $('share-note').addEventListener('input', () => ($('share-link').value = shareUrl()));
  $('copy-btn').onclick = () => {
    const v = shareUrl();
    $('share-link').value = v;
    const done = () => toast('Link copied');
    try {
      navigator.clipboard.writeText(v).then(done, () => { $('share-link').select(); toast('Press Ctrl+C to copy'); });
    } catch (e) { $('share-link').select(); toast('Press Ctrl+C to copy'); }
  };
  $('about-btn').onclick = () => openModal('about');
  $('about-btn-2').onclick = () => openModal('about');
  let toastT = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 1800);
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    resize();
    window.addEventListener('resize', resize);
    try { const s = localStorage.getItem('silale-season'); if (s && s !== 'summer' && ['winter', 'night'].includes(s)) setSeason(s); } catch (e) { /* ignore */ }
    const dataUrl = new URL('data/silale.json', location.href).href;
    const bar = $('loadbar');
    bar.style.width = '15%';
    await Promise.race([store.open(), new Promise((r) => setTimeout(r, 1500))]);
    // Workers load the data in parallel; saved tiles can show before they are ready.
    const workersP = startWorkers(dataUrl);
    workersP.catch((err) => { console.error(err); toast('This browser could not paint new tiles.'); });
    const atlasP = loadAtlasMeta().then(() => loadBakedSeason(season));
    const data = await fetch(dataUrl).then((r) => r.json());
    D = data; META = D.meta;
    bar.style.width = '55%';
    const [e0, n0, e1, n1] = META.bounds;
    isoBounds = window.SIL.isoBoundsOf(META);
    BLD = D.buildings.map((raw, i) => {
      const b = prepBuilding(raw, i);
      b.name = raw.n; b.addr = raw.ad; b.year = raw.y; b.den = raw.den; b.kindName = raw.kind; b.btype = raw.t; b.osm = raw.id;
      return b;
    });
    $('stat-b').textContent = BLD.length.toLocaleString('en-US');
    bGrid = new Grid(40); bSeen = makeSeen(BLD.length);
    for (const b of BLD) bGrid.insert(b.i, b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]);
    buildLabels();
    buildIndex();
    const fromHash = readHash();
    Object.assign(view, fromHash || homeView());
    clampView();
    window.addEventListener('hashchange', () => { const v = readHash(); if (v) { cancelCardSoon(); flyTo(v); } });
    await Promise.race([atlasP, new Promise((r) => setTimeout(r, 4000))]);
    requestAnimationFrame(loop);
    // wait until the first screenful is painted (or give up after a few seconds)
    const t0 = performance.now();
    await new Promise((res) => {
      const check = () => {
        const L = levelFor(view.s), R = tileRange(L);
        let total = 0, ready = 0;
        for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) { total++; if (cache.has(tileKey(L, tx, ty))) ready++; }
        bar.style.width = (55 + (45 * ready) / Math.max(1, total)) + '%';
        if (ready >= total || performance.now() - t0 > 9000) res(); else setTimeout(check, 120);
      };
      check();
    });
    $('loader').classList.add('done');
    setTimeout(maybeHint, 3600);
    setTimeout(() => ($('loader').hidden = true), 600);
    // opening move: glide from the whole diorama down into the town centre
    if (!fromHash && !reduceMotion) setTimeout(() => { if (!anim && !gesture && !inertia && !userMoved) flyTo({ x: 0, y: 0, s: Math.pow(2, 16.7 - Z_OFF) }, 2600); }, 700);
  }
  boot().catch((err) => {
    console.error(err);
    const p = document.querySelector('#loader p');
    p.textContent = 'This browser could not paint the map. Try a current Chrome, Firefox or Safari.';
  });
})();
