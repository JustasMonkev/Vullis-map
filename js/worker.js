/* Isometric Šilalė — tile painter. Runs in a Web Worker with an OffscreenCanvas.
 * Each tile is painted from vector OSM data, then snapped to the theme palette
 * so every edge stays a hard pixel edge. */
'use strict';
importScripts('shared.js');
const { ISO, isoX, isoY, hash32, rnd, rnd2, shade, THEMES, collectPalette, ringArea, pointInRing,
  prepBuilding, Grid, makeSeen } = self.SIL;

const T = ISO.TILE;
let D = null;            // raw data
let B = [];              // prepared buildings
let AREAS = [], ROADS = [], WATERWAYS = [], BARRIERS = [];
let objGrid = null, seen = null;
let TR = null;           // trees: {e, n, kind, v, forest}
let LAMPS = [];
let bounds;

// ------------------------------------------------------------ init
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      const res = await fetch(msg.dataUrl);
      D = await res.json();
      const t0 = performance.now();
      prepare();
      readyResolve();
      self.postMessage({ type: 'ready', trees: TR.n, prepMs: performance.now() - t0 });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }
  await ready;            // tile requests that arrive early wait for the data
  if (msg.type === 'perf') {
    self.postMessage({ type: 'perf', perf: PERF });
  } else if (msg.type === 'tile') {
    let bitmap = null, blobP = null;
    try {
      paintTile(msg.L, msg.tx, msg.ty, msg.theme);
      // convertToBlob copies the pixels synchronously; encoding finishes in the background
      if (msg.persist && canvas.convertToBlob) blobP = canvas.convertToBlob({ type: 'image/png' });
      bitmap = canvas.transferToImageBitmap();
    } catch (err) { self.postMessage({ type: 'error', message: 'tile ' + msg.key + ': ' + err.message }); }
    self.postMessage({ type: 'tile', key: msg.key, bitmap }, bitmap ? [bitmap] : []);
    if (blobP) blobP.then((blob) => self.postMessage({ type: 'blob', key: msg.key, blob }), () => {});
  }
};

function bboxOf(flat) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i], y = flat[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const ROAD_W = {
  primary: 9, primary_link: 7, secondary: 8, secondary_link: 6, tertiary: 7, tertiary_link: 6,
  unclassified: 6, residential: 6, living_street: 5, service: 3.6, track: 3, pedestrian: 5,
  footway: 1.8, path: 1.4, cycleway: 2, steps: 2, bridleway: 1.4,
};
const MAIN = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
const MINOR = new Set(['unclassified', 'residential', 'living_street', 'pedestrian']);
const PATHS = new Set(['footway', 'path', 'cycleway', 'steps', 'bridleway']);
const roadRank = (c) => (PATHS.has(c) ? 0 : c === 'track' ? 1 : c === 'service' ? 2 : MINOR.has(c) ? 3 : 4);
const WATER_W = { river: 12, stream: 3, canal: 6, ditch: 1.6, drain: 1.6 };

function prepare() {
  bounds = D.meta.bounds;
  AREAS = D.areas.map((a) => ({ k: a.k, r: a.r, bb: bboxOf(a.r[0]) }));
  ROADS = D.roads.map((r) => ({ c: r.c, p: r.p, u: r.u, br: r.br, w: ROAD_W[r.c] || 4, bb: bboxOf(r.p), rank: roadRank(r.c) }))
    .sort((a, b) => a.rank - b.rank);
  WATERWAYS = D.waterways.map((w) => ({ c: w.c, p: w.p, w: WATER_W[w.c] || 2, bb: bboxOf(w.p) }));
  BARRIERS = D.barriers.map((b) => ({ c: b.c, p: b.p, bb: bboxOf(b.p) }));
  B = D.buildings.map((b, i) => prepBuilding(b, i));
  makeTrees();
  makeLamps();

  const nB = B.length;
  objGrid = new Grid(48);
  seen = makeSeen(nB + TR.n);
  for (const b of B) objGrid.insert(b.i, b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]);
  for (let i = 0; i < TR.n; i++) {
    const e = TR.e[i], n = TR.n_[i];
    const X = isoX(e, n), Y = isoY(e, n, 0);
    objGrid.insert(nB + i, X - 4, Y - 18 * ISO.H, X + 4, Y + 1.5);
  }
}

// ------------------------------------------------------------ trees
/* Occupancy raster (2 m cells): red = buildings, green = roads / water / paved. */
function occupancy() {
  const S = 2, [e0, n0, e1, n1] = bounds;
  const W = Math.ceil((e1 - e0) / S), H = Math.ceil((n1 - n0) / S);
  const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
  g.setTransform(1 / S, 0, 0, -1 / S, -e0 / S, n1 / S);
  g.fillStyle = '#00ff00'; g.strokeStyle = '#00ff00'; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const a of AREAS) {
    if (a.k !== 'water' && a.k !== 'paved' && a.k !== 'pitch' && a.k !== 'track' && a.k !== 'stadium') continue;
    g.beginPath(); for (const r of a.r) ringPath(g, r); g.fill('evenodd');
  }
  for (const r of ROADS) {
    if (PATHS.has(r.c)) continue;
    g.lineWidth = r.w + 3; g.beginPath(); linePath(g, r.p); g.stroke();
  }
  for (const w of WATERWAYS) { g.lineWidth = w.w + 2; g.beginPath(); linePath(g, w.p); g.stroke(); }
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = '#ff0000'; g.strokeStyle = '#ff0000'; g.lineWidth = 3.5;
  for (const b of B) { g.beginPath(); ringPath(g, b.r); g.fill(); g.stroke(); }
  const px = g.getImageData(0, 0, W, H).data;
  const occ = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) occ[i] = (px[i * 4] > 80 ? 1 : 0) | (px[i * 4 + 1] > 80 ? 2 : 0);
  return (e, n) => {
    const x = ((e - e0) / S) | 0, y = ((n1 - n) / S) | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return 3;
    return occ[y * W + x];
  };
}

function makeTrees() {
  const E = [], N = [], K = [], V = [], F = [];
  const occ = occupancy();
  const [e0, n0, e1, n1] = bounds;
  const add = (e, n, kind, forest) => {
    if (e < e0 + 1 || e > e1 - 1 || n < n0 + 1 || n > n1 - 1) return;
    E.push(e); N.push(n); K.push(kind); V.push(hash32((e * 10) | 0 ^ ((n * 10) | 0) * 31) % 9); F.push(forest);
  };
  // Scanline fill of an area on a jittered grid.
  const scatter = (a, sp, prob, kinds, forest, salt) => {
    const [ax0, ay0, ax1, ay1] = a.bb;
    for (let gy = Math.floor(ay0 / sp); gy <= Math.ceil(ay1 / sp); gy++) {
      const y = gy * sp;
      const xs = [];
      for (const r of a.r) {
        const m = r.length / 2;
        for (let i = 0, j = m - 1; i < m; j = i++) {
          const yi = r[2 * i + 1], yj = r[2 * j + 1];
          if ((yi > y) !== (yj > y)) xs.push(r[2 * i] + ((y - yi) / (yj - yi)) * (r[2 * j] - r[2 * i]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        for (let gx = Math.ceil(xs[s] / sp); gx * sp <= xs[s + 1]; gx++) {
          if (rnd2(gx, gy, salt) > prob) continue;
          const e = gx * sp + (rnd2(gx, gy, salt + 1) - 0.5) * sp * 0.9;
          const n = y + (rnd2(gx, gy, salt + 2) - 0.5) * sp * 0.9;
          if (occ(e, n)) continue;
          const t = rnd2(gx, gy, salt + 3);
          let kind = 0;
          for (let q = 0, acc = 0; q < kinds.length; q++) { acc += kinds[q]; if (t < acc) { kind = q; break; } }
          add(e, n, kind, forest);
        }
      }
    }
  };
  // kinds: [deciduous, conifer, birch, bush]
  for (const a of AREAS) {
    switch (a.k) {
      case 'forest': scatter(a, 4.6, 0.93, [0.3, 0.55, 0.15, 0], 1, 11); break;
      case 'scrub': scatter(a, 5.5, 0.5, [0.15, 0.1, 0.1, 0.65], 0, 12); break;
      case 'wetland': scatter(a, 8, 0.22, [0.2, 0, 0.4, 0.4], 0, 13); break;
      case 'park': scatter(a, 8, 0.5, [0.7, 0.12, 0.18, 0], 0, 14); break;
      case 'cemetery': scatter(a, 8, 0.45, [0.45, 0.45, 0.1, 0], 0, 15); break;
      case 'residential': scatter(a, 9, 0.3, [0.55, 0.15, 0.12, 0.18], 0, 16); break;
      case 'grass': scatter(a, 10, 0.2, [0.6, 0.1, 0.2, 0.1], 0, 17); break;
      case 'school': scatter(a, 10, 0.25, [0.7, 0.1, 0.2, 0], 0, 18); break;
      case 'orchard': scatter(a, 6, 0.8, [0, 0, 0, 1], 0, 19); break;
      case 'meadow': scatter(a, 30, 0.12, [0.5, 0.1, 0.2, 0.2], 0, 20); break;
    }
  }
  // Lone field trees across the countryside.
  scatter({ r: [[e0, n0, e1, n0, e1, n1, e0, n1]], bb: [e0, n0, e1, n1] }, 38, 0.1, [0.55, 0.1, 0.25, 0.1], 0, 21);
  // Tree rows along roads and field edges.
  for (const row of D.treeRows) {
    let carry = 0;
    for (let i = 0; i + 3 < row.length; i += 2) {
      const ax = row[i], ay = row[i + 1], bx = row[i + 2], by = row[i + 3];
      const L = Math.hypot(bx - ax, by - ay);
      for (let d = carry; d < L; d += 7) {
        const e = ax + ((bx - ax) * d) / L, n = ay + ((by - ay) * d) / L;
        if (!(occ(e, n) & 1)) add(e, n, rnd2(e | 0, n | 0, 5) < 0.75 ? 0 : 2, 0);
      }
      carry = (carry - L) % 7; if (carry < 0) carry += 7;
    }
  }
  for (const [e, n] of D.trees) add(e, n, 0, 0);
  const n = E.length;
  TR = { n, e: Float32Array.from(E), n_: Float32Array.from(N), k: Uint8Array.from(K), v: Uint8Array.from(V), f: Uint8Array.from(F) };
}

function makeLamps() {
  for (const r of ROADS) {
    if (!(MAIN.has(r.c) || MINOR.has(r.c))) continue;
    const p = r.p;
    let carry = 12;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.01) continue;
      const nx = -(by - ay) / L, ny = (bx - ax) / L;
      for (let d = carry; d < L; d += 32) {
        const off = r.w / 2 + 0.8;
        LAMPS.push([ax + ((bx - ax) * d) / L + nx * off, ay + ((by - ay) * d) / L + ny * off]);
      }
      carry = ((carry - L) % 32 + 32) % 32;
    }
  }
}

// ------------------------------------------------------------ path helpers (world coords)
function ringPath(g, r) {
  g.moveTo(r[0], r[1]);
  for (let i = 2; i < r.length; i += 2) g.lineTo(r[i], r[i + 1]);
  g.closePath();
}
function linePath(g, p) {
  g.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
}
const hit = (bb, w) => !(bb[2] < w[0] || bb[0] > w[2] || bb[3] < w[1] || bb[1] > w[3]);

// ------------------------------------------------------------ patterns & sprites (per theme)
const themeCache = {};
function themeAssets(name) {
  if (themeCache[name]) return themeCache[name];
  const th = THEMES[name];
  const pal = collectPalette(th);
  const A = { th, name, pal, qcache: new Map(), pat: {}, sprites: {} };
  const ctx0 = new OffscreenCanvas(1, 1).getContext('2d');
  const speck = (base, cols, dens, salt, size = 64) => {
    const c = new OffscreenCanvas(size, size), g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = rnd2(x, y, salt);
      if (r < dens) { g.fillStyle = cols[(rnd2(x, y, salt + 9) * cols.length) | 0]; g.fillRect(x, y, 1, 1); }
    }
    return ctx0.createPattern(c, 'repeat');
  };
  const P = A.pat;
  P.bg = speck(th.bg, th.bgSpeck, 0.07, 1);
  for (const k of ['meadow', 'grass', 'park', 'residential', 'school', 'scrub', 'orchard', 'stadium']) {
    P[k] = speck(th[k], [shade(th[k], 0.86), shade(th[k], 1.12)], 0.06, k.length * 7);
  }
  P.wetland = speck(th.wetland, [th.water, shade(th.wetland, 0.86), th.grass], 0.12, 31);
  P.dirt = speck(th.dirt, [shade(th.dirt, 0.86), shade(th.dirt, 1.12)], 0.12, 33);
  P.paved = speck(th.paved, [shade(th.paved, 0.86)], 0.05, 34);
  P.industrial = speck(th.industrial, [shade(th.industrial, 0.86)], 0.05, 35);
  P.commercial = speck(th.commercial, [shade(th.commercial, 0.86)], 0.04, 36);
  // Farmland: plough lines following the iso diagonal.
  {
    const c = new OffscreenCanvas(64, 64), g = c.getContext('2d');
    g.fillStyle = th.farmland; g.fillRect(0, 0, 64, 64);
    g.fillStyle = th.farmStripe;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (((x + 2 * y) & 7) === 0) g.fillRect(x, y, 1, 1);
    P.farmland = ctx0.createPattern(c, 'repeat');
  }
  // Cemetery: rows of little grey grave stones.
  {
    const c = new OffscreenCanvas(32, 16), g = c.getContext('2d');
    g.fillStyle = th.cemetery; g.fillRect(0, 0, 32, 16);
    g.fillStyle = shade(th.paved, 1.12);
    for (let i = 0; i < 4; i++) { g.fillRect(i * 8 + 2, 4 + (i % 2) * 8, 2, 2); }
    g.fillStyle = shade(th.paved, 0.72);
    for (let i = 0; i < 4; i++) { g.fillRect(i * 8 + 3, 5 + (i % 2) * 8, 1, 1); }
    P.cemetery = ctx0.createPattern(c, 'repeat');
  }
  // Forest canopy texture for far zoom levels.
  {
    const c = new OffscreenCanvas(64, 64), g = c.getContext('2d');
    g.fillStyle = th.forest; g.fillRect(0, 0, 64, 64);
    const cols = [th.conifer[0], th.decid[0], th.conifer[1], th.decid[1], shade(th.conifer[0], 0.72)];
    for (let i = 0; i < 260; i++) {
      const x = (rnd(i, 41) * 64) | 0, y = (rnd(i, 42) * 64) | 0, s = 1 + ((rnd(i, 43) * 2) | 0);
      g.fillStyle = cols[(rnd(i, 44) * cols.length) | 0];
      for (const [dx, dy] of [[0, 0], [64, 0], [0, 64], [64, 64], [-64, 0], [0, -64]]) g.fillRect(x + dx, y + dy, s + 1, s);
    }
    P.forest = ctx0.createPattern(c, 'repeat');
  }
  P.forestFloor = speck(th.forest, th.forestSpeck, 0.18, 47);
  // Water: glints.
  {
    const c = new OffscreenCanvas(64, 64), g = c.getContext('2d');
    g.fillStyle = th.water; g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 14; i++) {
      const x = (rnd(i, 51) * 64) | 0, y = (rnd(i, 52) * 64) | 0, w = 2 + ((rnd(i, 53) * 3) | 0);
      g.fillStyle = i % 3 ? th.waterLight : th.waterDeep;
      g.fillRect(x, y, w, 1); if (x + w > 64) g.fillRect(x - 64, y, w, 1);
    }
    P.water = ctx0.createPattern(c, 'repeat');
  }
  themeCache[name] = A;
  return A;
}

/* Tree sprites per theme, level, kind and size variant.
   kind: 0 deciduous, 1 conifer, 2 birch, 3 bush. Returns {c, ax, ay}. */
function treeSprite(A, L, kind, v) {
  const key = L + ':' + kind + ':' + v;
  let s = A.sprites[key];
  if (s) return s;
  const th = A.th;
  const k = 1 / (ISO.A0 * (1 << L));
  const size = 0.85 + (v % 3) * 0.15;
  const col = (v / 3) | 0;
  const pad = 3;
  let w, h, draw;
  const winter = A.name === 'winter';
  if (kind === 1) {               // spruce / pine
    const ht = (9 + (v % 3) * 2.5) * ISO.H * k, rw = 2.4 * size * k;
    w = Math.ceil(rw * 2) + pad * 2; h = Math.ceil(ht) + pad * 2;
    draw = (g, ax, ay) => {
      const base = th.conifer[col % 2];
      g.fillStyle = th.trunk; g.fillRect(Math.round(ax - Math.max(0.5, k * 0.25)), Math.round(ay - ht * 0.18), Math.max(1, Math.round(k * 0.5)), Math.round(ht * 0.18));
      const tiers = Math.max(1, Math.min(4, Math.round(ht / 6)));
      for (let t = 0; t < tiers; t++) {
        const f0 = 0.12 + (t / tiers) * 0.62, f1 = Math.min(1, f0 + 0.5);
        const wid = rw * (1 - t / (tiers + 0.6));
        const yb = ay - ht * f0, yt = ay - ht * f1;
        g.fillStyle = shade(base, 0.72);
        g.beginPath(); g.moveTo(ax - wid, yb); g.lineTo(ax, yt); g.lineTo(ax + wid, yb); g.closePath(); g.fill();
        g.fillStyle = base;
        g.beginPath(); g.moveTo(ax - wid, yb - 0.5); g.lineTo(ax, yt); g.lineTo(ax + wid * 0.15, yb - 0.5); g.closePath(); g.fill();
        if (winter) { g.fillStyle = th.snow; g.fillRect(Math.round(ax - wid * 0.7), Math.round(yb - 1), Math.max(1, Math.round(wid * 0.8)), 1); }
      }
      if (winter) { g.fillStyle = th.snow; g.fillRect(Math.round(ax - 0.5), Math.round(ay - ht), 1, 1); }
    };
  } else if (kind === 3) {        // bush
    const r = 1.3 * size * k;
    w = Math.ceil(r * 2.6) + pad * 2; h = Math.ceil(r * 2.4) + pad * 2;
    draw = (g, ax, ay) => {
      const base = th.bush[col % th.bush.length];
      blob(g, ax, ay - r * 0.9, r * 1.15, r, base, th.treeHi, winter);
    };
  } else {                        // deciduous / birch
    const birch = kind === 2;
    const r = (birch ? 1.6 : 2.7) * size * k;
    const hc = (birch ? 4.6 : 3.9) * size * ISO.H * k;
    w = Math.ceil(r * 2.4) + pad * 2; h = Math.ceil(hc + r * 2.2) + pad * 2;
    draw = (g, ax, ay) => {
      const base = birch ? th.birch : th.decid[col % th.decid.length];
      g.fillStyle = birch ? th.birchTrunk : th.trunk;
      const tw = Math.max(1, Math.round(k * (birch ? 0.35 : 0.5)));
      g.fillRect(Math.round(ax - tw / 2), Math.round(ay - hc), tw, Math.round(hc));
      if (winter) {
        // bare crown: a few branches
        g.strokeStyle = birch ? th.birchTrunk : th.trunk; g.lineWidth = Math.max(1, k * 0.2);
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.45;
          g.beginPath(); g.moveTo(ax, ay - hc * 0.7); g.lineTo(ax + Math.cos(a) * r, ay - hc + Math.sin(a) * r * 0.9); g.stroke();
        }
        g.fillStyle = shade(base, 0.86);
        g.globalAlpha = 1;
        blobDots(g, ax, ay - hc, r, base);
      } else {
        blob(g, ax, ay - hc, r, r * (birch ? 1.7 : 1.05), base, th.treeHi, false);
      }
    };
  }
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  const ax = Math.round(w / 2), ay = h - pad;
  draw(g, ax, ay);
  s = { c: c.transferToImageBitmap ? c.transferToImageBitmap() : c, ax, ay };
  A.sprites[key] = s;
  return s;
}
function blob(g, x, y, rx, ry, base, hi, snow) {
  g.fillStyle = shade(base, 0.55);
  ell(g, x, y, rx + 0.7, ry + 0.7);
  g.fillStyle = shade(base, 0.72);
  ell(g, x, y, rx, ry);
  g.fillStyle = base;
  ell(g, x - rx * 0.18, y - ry * 0.2, rx * 0.78, ry * 0.74);
  g.fillStyle = snow ? hi : shade(base, 1.12);
  ell(g, x - rx * 0.38, y - ry * 0.42, rx * 0.32, ry * 0.26);
}
function blobDots(g, x, y, r, base) {
  g.fillStyle = shade(base, 0.86);
  for (let i = 0; i < 6; i++) g.fillRect(Math.round(x + (rnd(i, 3) - 0.5) * r * 1.6), Math.round(y + (rnd(i, 4) - 0.5) * r * 1.2), 1, 1);
}
function ell(g, x, y, rx, ry) { g.beginPath(); g.ellipse(x, y, Math.max(0.6, rx), Math.max(0.6, ry), 0, 0, Math.PI * 2); g.fill(); }

// ------------------------------------------------------------ tile painting
const canvas = new OffscreenCanvas(T, T);
const g = canvas.getContext('2d', { willReadFrequently: true });
const shadowCanvas = new OffscreenCanvas(T, T);
const sg = shadowCanvas.getContext('2d');
const TO_CAM = [-0.6124, -0.6124, 0.5];
const SUN = [0.62, -0.26];           // ground shadow offset per metre of height (towards east-south-east)

const PERF = { ground: 0, shadow: 0, objects: 0, quant: 0, n: 0 };
function paintTile(L, tx, ty, themeName) {
  let tq = performance.now();
  const lap = (k) => { const t = performance.now(); PERF[k] += t - tq; tq = t; };
  const A = themeAssets(themeName);
  const th = A.th;
  const a = ISO.A0 * (1 << L), k = 1 / a;
  const X0 = tx * T * a, Y0 = ty * T * a, X1 = X0 + T * a, Y1 = Y0 + T * a;
  const night = themeName === 'night';
  // world bbox of the tile's ground diamond
  const W = [(X0 - 2 * Y1) / 2 - 2, (-2 * Y1 - X1) / 2 - 2, (X1 - 2 * Y0) / 2 + 2, (-2 * Y0 - X0) / 2 + 2];
  const [be0, bn0, be1, bn1] = bounds;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, T, T);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.lineCap = 'round'; g.lineJoin = 'round'; g.setLineDash([]);
  const world = () => g.setTransform(k, -k / 2, -k, -k / 2, -X0 * k, -Y0 * k);
  const screen = () => g.setTransform(1, 0, 0, 1, 0, 0);
  // projection helpers into tile pixels
  const px = (e, n) => (e - n - X0) * k;
  const py = (e, n, z) => (-(e + n) / 2 - z * ISO.H - Y0) * k;
  const minW = (pxw) => (pxw / k) * 1.25;   // world width that renders at least pxw pixels

  // ---- diorama slab (sides first; the top face clips everything else)
  paintSlab(th, px, py);

  // ---- ground
  g.save();
  world();
  g.beginPath(); g.rect(be0, bn0, be1 - be0, bn1 - bn0); g.clip();
  const fillPath = (style) => { g.save(); screen(); g.fillStyle = style; g.fill('evenodd'); g.restore(); };
  g.beginPath(); g.rect(be0, bn0, be1 - be0, bn1 - bn0); fillPath(A.pat.bg);

  for (const ar of AREAS) {
    if (!hit(ar.bb, W)) continue;
    g.beginPath(); for (const r of ar.r) ringPath(g, r);
    const kd = ar.k;
    if (kd === 'water') continue;
    let style = A.pat[kd] || th[kd] || th.grass;
    if (kd === 'forest') style = L >= 3 ? A.pat.forest : A.pat.forestFloor;
    if (kd === 'pitch') style = th.pitch;
    if (kd === 'track') style = th.track;
    if (kd === 'playground') style = th.playground;
    fillPath(style);
    if (kd === 'pitch' && L <= 2) { g.lineWidth = Math.max(0.35, minW(0.8)); g.strokeStyle = th.pitchLine; g.stroke(); }
    if ((kd === 'paved' || kd === 'industrial' || kd === 'commercial') && L <= 1) { g.lineWidth = 0.4; g.strokeStyle = shade(th[kd], 0.72); g.stroke(); }
  }
  // streams and rivers
  g.strokeStyle = th.water;
  for (const w of WATERWAYS) {
    if (!hit(w.bb, W)) continue;
    if (w.c === 'ditch' || w.c === 'drain') { if (L > 2) continue; g.strokeStyle = th.waterEdge; }
    else g.strokeStyle = th.water;
    g.lineWidth = Math.max(w.w, minW(w.c === 'river' ? 1.6 : 1));
    g.beginPath(); linePath(g, w.p); g.stroke();
  }
  // still water
  for (const ar of AREAS) {
    if (ar.k !== 'water' || !hit(ar.bb, W)) continue;
    g.beginPath(); for (const r of ar.r) ringPath(g, r);
    fillPath(A.pat.water);
    g.lineWidth = Math.max(0.8, minW(1)); g.strokeStyle = th.waterEdge; g.stroke();
  }
  // roads: casings, then fills, then markings
  const vis = ROADS.filter((r) => hit(r.bb, [W[0] - 10, W[1] - 10, W[2] + 10, W[3] + 10]) &&
    !(L >= 3 && (PATHS.has(r.c) || r.c === 'service' || r.c === 'track')) && !(L >= 5 && MINOR.has(r.c)));
  for (const r of vis) {
    if (PATHS.has(r.c) || r.u || r.c === 'track') continue;
    g.strokeStyle = th.roadCase;
    g.lineWidth = Math.max(r.w + 1.6, minW(MAIN.has(r.c) ? 2.4 : 1.6));
    g.beginPath(); linePath(g, r.p); g.stroke();
  }
  for (const r of vis) {
    const path = PATHS.has(r.c);
    g.strokeStyle = path ? th.path : (r.u || r.c === 'track') ? th.roadDirt : MAIN.has(r.c) ? th.roadMain : th.road;
    g.lineWidth = Math.max(r.w, minW(path ? 0.8 : MAIN.has(r.c) ? 1.4 : 1));
    if (r.c === 'steps') g.setLineDash([0.5, 0.5]);
    g.beginPath(); linePath(g, r.p); g.stroke();
    if (r.c === 'steps') g.setLineDash([]);
  }
  if (L <= 1) {
    g.strokeStyle = th.marking; g.lineWidth = 0.3; g.setLineDash([3, 5]); g.lineCap = 'butt';
    for (const r of vis) if (r.c === 'primary' || r.c === 'secondary') { g.beginPath(); linePath(g, r.p); g.stroke(); }
    g.setLineDash([]); g.lineCap = 'round';
  }
  // hedges and fences
  if (L <= 2) for (const b of BARRIERS) {
    if (!hit(b.bb, W)) continue;
    g.strokeStyle = b.c === 'hedge' ? th.hedge : th.fence;
    g.lineWidth = b.c === 'hedge' ? Math.max(1.2, minW(1)) : Math.max(0.3, minW(0.6));
    g.beginPath(); linePath(g, b.p); g.stroke();
  }
  // street lamps at night: pools of light
  if (night && L <= 3) {
    for (const [e, n] of LAMPS) {
      if (e < W[0] - 8 || e > W[2] + 8 || n < W[1] - 8 || n > W[3] + 8) continue;
      g.fillStyle = th.lampGlow; g.beginPath(); g.arc(e, n, 3.6, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = th.lamp;
    for (const [e, n] of LAMPS) {
      if (e < W[0] - 2 || e > W[2] + 2 || n < W[1] - 2 || n > W[3] + 2) continue;
      g.beginPath(); g.arc(e, n, Math.max(0.5, minW(0.7)), 0, Math.PI * 2); g.fill();
    }
  }

  // ---- objects (buildings + trees), far to near
  screen();
  seen.stamp++;
  const ids = objGrid.query(X0 - 24, Y0, X1, Y1 + 60, [], seen);
  const nB = B.length;
  const showTrees = L <= 3;
  const list = [], shadowList = [];
  for (const id of ids) {
    if (id < nB) {
      const b = B[id];
      if (b.bbox[2] < X0 - 24 || b.bbox[0] > X1 || b.bbox[3] < Y0 || b.bbox[1] > Y1 + 24) continue;
      shadowList.push(id);
      if (b.bbox[2] < X0 || b.bbox[0] > X1 || b.bbox[3] < Y0 || b.bbox[1] > Y1) continue;
      list.push(id);
    } else {
      if (!showTrees) continue;
      const t = id - nB;
      if (L === 3 && TR.f[t]) continue;
      list.push(id); shadowList.push(id);
    }
  }
  lap('ground');
  const depthOf = (id) => (id < nB ? B[id].depth : TR.e[id - nB] + TR.n_[id - nB]);
  list.sort((p, q) => depthOf(q) - depthOf(p));

  // ground shadows (one opaque layer composited at low alpha so overlaps don't stack)
  if (!night && L <= 3) {
    sg.setTransform(1, 0, 0, 1, 0, 0); sg.clearRect(0, 0, T, T);
    sg.fillStyle = '#000';
    sg.setTransform(k, -k / 2, -k, -k / 2, -X0 * k, -Y0 * k);
    // The layer is opaque, so overlapping fills are harmless: fill in small batches,
    // which rasterises far faster than one huge path.
    sg.beginPath();
    let batch = 0;
    for (const id of shadowList) {
      if (++batch % 24 === 0) { sg.fill('nonzero'); sg.beginPath(); }
      if (id < nB) {
        const b = B[id];
        const hh = b.kind === 'church' ? b.h + 3 : b.h + b.rise * 0.5;
        shadowOf(sg, b.r, hh);
        if (b.tower) {
          const t = b.tower, hw = t.w / 2;
          shadowOf(sg, [t.c[0] - hw, t.c[1] - hw, t.c[0] + hw, t.c[1] - hw, t.c[0] + hw, t.c[1] + hw, t.c[0] - hw, t.c[1] + hw], t.h + t.spire * 0.4);
        }
      } else {
        const t = id - nB, kd = TR.k[t];
        const hh = kd === 1 ? 6 : kd === 3 ? 1 : 4.5, r = kd === 3 ? 1.3 : kd === 1 ? 2 : 2.3;
        const cx = TR.e[t] + SUN[0] * hh, cy = TR.n_[t] + SUN[1] * hh;
        sg.moveTo(cx + r, cy); sg.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2);
      }
    }
    sg.fill('nonzero');
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = A.name === 'winter' ? 0.16 : 0.24;
    g.drawImage(shadowCanvas, 0, 0);
    g.restore();
  }
  g.restore();   // drop ground clip
  lap('shadow');

  const ctxB = { g, px, py, k, L, th, night, A };
  for (const id of list) {
    if (id < nB) drawBuilding(ctxB, B[id]);
    else {
      const t = id - nB;
      const s = treeSprite(A, L, TR.k[t], TR.v[t]);
      const e = TR.e[t], n = TR.n_[t];
      g.drawImage(s.c, Math.round(px(e, n) - s.ax), Math.round(py(e, n, 0) - s.ay));
    }
  }

  lap('objects');
  quantize(A);
  lap('quant'); PERF.n++;
}

// Adds a building's ground shadow to the current path. Every piece is wound the same way
// (counter-clockwise in world space) so one nonzero fill gives their union.
function shadowOf(sg, r, h) {
  const dx = SUN[0] * h, dy = SUN[1] * h;
  const n = r.length / 2;
  sg.moveTo(r[0] + dx, r[1] + dy);
  for (let i = 1; i < n; i++) sg.lineTo(r[2 * i] + dx, r[2 * i + 1] + dy);
  sg.closePath();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
    if ((bx - ax) * dy - (by - ay) * dx >= 0) {
      sg.moveTo(ax, ay); sg.lineTo(bx, by); sg.lineTo(bx + dx, by + dy); sg.lineTo(ax + dx, ay + dy);
    } else {
      sg.moveTo(ax, ay); sg.lineTo(ax + dx, ay + dy); sg.lineTo(bx + dx, by + dy); sg.lineTo(bx, by);
    }
    sg.closePath();
  }
}

function paintSlab(th, px, py) {
  const [e0, n0, e1, n1] = bounds;
  const bands = [[0, -1.0, th.slabTop], [-1.0, -9, th.soil2], [-9, -19, th.soil], [-19, -ISO.SLAB, th.rock]];
  const faces = [
    { a: [e0, n0], b: [e1, n0], f: SIL.SHADES.mid },   // south face
    { a: [e0, n1], b: [e0, n0], f: SIL.SHADES.base },  // west face
  ];
  for (const F of faces) {
    for (const [z0, z1, col] of bands) {
      g.fillStyle = shade(col, F.f);
      g.beginPath();
      g.moveTo(px(...F.a), py(...F.a, z0)); g.lineTo(px(...F.b), py(...F.b, z0));
      g.lineTo(px(...F.b), py(...F.b, z1)); g.lineTo(px(...F.a), py(...F.a, z1));
      g.closePath(); g.fill();
    }
    // pebbles in the soil
    const len = Math.hypot(F.b[0] - F.a[0], F.b[1] - F.a[1]);
    g.fillStyle = shade(th.rock, F.f * 1.0);
    for (let d = 0; d < len; d += 9) {
      const t = d / len, i = (d * 13) | 0;
      const e = F.a[0] + (F.b[0] - F.a[0]) * t, n = F.a[1] + (F.b[1] - F.a[1]) * t;
      const z = -3 - rnd(i, 7) * 14;
      const x = px(e, n), y = py(e, n, z);
      if (x < -4 || x > T + 4 || y < -4 || y > T + 4) continue;
      g.fillRect(Math.round(x), Math.round(y), 2, 1);
    }
    g.strokeStyle = shade(th.rock, SIL.SHADES.line); g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px(...F.a), py(...F.a, -ISO.SLAB)); g.lineTo(px(...F.b), py(...F.b, -ISO.SLAB)); g.stroke();
  }
}

// ------------------------------------------------------------ buildings
function wallShade(nx, ny) {
  // sun from the west-north-west: west walls bright, south walls in half shade
  const t = ny - nx;  // +1.41 west/north-west ... -1.41 south/east
  return t > 0.55 ? SIL.SHADES.base : t > -0.55 ? SIL.SHADES.mid : SIL.SHADES.low;
}
const wallColor = (th, b) => { const a = th.walls[b.m] || th.walls.house; return a[b.wi % a.length]; };
const roofColor = (th, b) => { const a = th.roofs[b.m] || th.roofs.house; return a[b.ri % a.length]; };

function poly(g, pts, fill, stroke, lw) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
}

function drawBuilding(C, b) {
  if (b.kind === 'flat') drawFlat(C, b);
  else if (b.kind === 'church') drawChurch(C, b);
  else drawPitched(C, b);
}

// Windows and doors on a wall from P to Q (ground points), facing (nx, ny).
function wallDetails(C, b, P, Q, nx, ny, h, f, opts) {
  const { g, px, py, L, th, night } = C;
  if (L > 1) return;
  const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
  if (len < 2.2) return;
  const m = b.m;
  const at = (t, z) => {
    const e = P[0] + (Q[0] - P[0]) * t, n = P[1] + (Q[1] - P[1]) * t;
    return [px(e, n), py(e, n, z)];
  };
  const quad = (t0, t1, z0, z1, col) => poly(g, [at(t0, z0), at(t1, z0), at(t1, z1), at(t0, z1)], col);
  const glass = (i) => (night ? (rnd(b.seed + i, 77) < 0.42 ? th.windowLit : th.window) : shade(th.window, f));
  if (m === 'metal' || m === 'canopy') {
    if (L > 0) return;
    g.strokeStyle = shade(wallColor(th, b), f * 0.86); g.lineWidth = 1;
    for (let d = 1.5; d < len - 0.5; d += 1.5) {
      const [x0, y0] = at(d / len, 0.2), [x1, y1] = at(d / len, h - 0.2);
      g.beginPath(); g.moveTo(Math.round(x0) + 0.5, y0); g.lineTo(Math.round(x1) + 0.5, y1); g.stroke();
    }
    if (len > 8) { const t = 0.5 - 2 / len; quad(t, t + 4 / len, 0, Math.min(h - 1, 4), shade(th.window, f * 0.86)); }
    return;
  }
  if (m === 'garage') {
    for (let d = 0.4; d + 2.6 < len; d += 3.2) quad(d / len, (d + 2.6) / len, 0, 2.1, shade(th.door, f));
    return;
  }
  if (m === 'shed' || m === 'ruins' || m === 'brick') return;
  const floorH = m === 'panel' ? 2.8 : 3.0;
  const floors = Math.max(1, Math.floor((h - 0.4) / floorH));
  const spacing = m === 'panel' ? 2.9 : m === 'commercial' ? 3.6 : 3.3;
  const ww = m === 'commercial' ? 2.2 : 1.15;
  const count = Math.floor(len / spacing);
  if (count < 1) return;
  const margin = (len - count * spacing) / 2;
  let wi = 0;
  for (let fl = 0; fl < floors; fl++) {
    const z0 = fl * floorH + (fl === 0 ? 0.9 : 0.8), z1 = z0 + (m === 'commercial' && fl === 0 ? 1.9 : 1.35);
    if (z1 > h - 0.25) break;
    if (m === 'commercial' && fl === 0) { quad(0.06, 0.94, 0.3, 2.6, glass(wi++)); continue; }
    for (let i = 0; i < count; i++) {
      const c = margin + spacing * (i + 0.5);
      quad((c - ww / 2) / len, (c + ww / 2) / len, z0, z1, glass(wi++));
      if (m === 'panel' && L === 0 && fl > 0 && i % 2 === 0) {     // balcony slab
        quad((c - ww / 2 - 0.3) / len, (c + ww / 2 + 0.3) / len, z0 - 0.45, z0 - 0.15, shade(wallColor(th, b), f * 0.86));
      }
    }
  }
  if (opts && opts.door && len > 4) {
    const c = len * (0.3 + rnd(b.seed, 3) * 0.4);
    quad((c - 0.5) / len, (c + 0.5) / len, 0, 2.0, shade(th.door, f));
  }
}

function drawFlat(C, b) {
  const { g, px, py, L, th } = C;
  const r = b.r, n = r.length / 2, h = b.h;
  const wall = wallColor(th, b), roof = roofColor(th, b);
  const walls = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
    const dx = bx - ax, dy = by - ay;
    if (dx - dy <= 0) continue;            // faces away from the camera
    const len = Math.hypot(dx, dy) || 1;
    walls.push({ ax, ay, bx, by, nx: dy / len, ny: -dx / len, d: (ax + bx + ay + by) / 2 });
  }
  walls.sort((p, q) => q.d - p.d);
  const outline = L <= 2;
  for (const w of walls) {
    const f = wallShade(w.nx, w.ny);
    const col = shade(wall, f);
    poly(g, [[px(w.ax, w.ay), py(w.ax, w.ay, 0)], [px(w.bx, w.by), py(w.bx, w.by, 0)],
      [px(w.bx, w.by), py(w.bx, w.by, h)], [px(w.ax, w.ay), py(w.ax, w.ay, h)]], col, outline ? shade(col, SIL.SHADES.low) : null, 1);
    wallDetails(C, b, [w.ax, w.ay], [w.bx, w.by], w.nx, w.ny, h, f, { door: b.m !== 'panel' });
  }
  const top = [];
  for (let i = 0; i < n; i++) top.push([px(r[2 * i], r[2 * i + 1]), py(r[2 * i], r[2 * i + 1], h)]);
  poly(g, top, roof, outline ? shade(roof, SIL.SHADES.line) : null, 1);
  if (L <= 1 && b.area > 60) {
    // parapet highlight on the far edges
    g.strokeStyle = shade(roof, SIL.SHADES.hi); g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = r[2 * j] - r[2 * i], dy = r[2 * j + 1] - r[2 * i + 1];
      if (dx - dy > 0) continue;
      g.moveTo(top[i][0], top[i][1] + 1); g.lineTo(top[j][0], top[j][1] + 1);
    }
    g.stroke();
  }
  // rooftop stair houses on apartment blocks
  if (b.m === 'panel' && b.box && L <= 2) {
    const { c, u, l } = b.box;
    const cnt = Math.max(1, Math.round(l / 18));
    for (let i = 0; i < cnt; i++) {
      const t = (i + 0.5) / cnt - 0.5;
      boxAt(C, c[0] + u[0] * l * t, c[1] + u[1] * l * t, 1.3, h, h + 1.8, shade(wall, SIL.SHADES.mid), roof);
    }
  }
}

// Axis-aligned little box (chimneys, roof exits)
function boxAt(C, e, n, hw, z0, z1, wall, roof) {
  const { g, px, py } = C;
  const P = (de, dn, z) => [px(e + de, n + dn), py(e + de, n + dn, z)];
  poly(g, [P(-hw, -hw, z0), P(hw, -hw, z0), P(hw, -hw, z1), P(-hw, -hw, z1)], shade(wall, SIL.SHADES.mid));   // south
  poly(g, [P(-hw, hw, z0), P(-hw, -hw, z0), P(-hw, -hw, z1), P(-hw, hw, z1)], wall);                         // west
  poly(g, [P(-hw, -hw, z1), P(hw, -hw, z1), P(hw, hw, z1), P(-hw, hw, z1)], roof);
}

/* Convex solid made of faces [{pts:[[e,n,z]..], col, wall?:{P,Q,nx,ny,h}}]. Draw only faces
   that point at the camera: on a convex body those never overlap, so no sorting is needed. */
function drawSolid(C, faces, centre, outline) {
  const { g, px, py } = C;
  const drawn = [];
  for (const F of faces) {
    const p = F.pts;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b2 = p[(i + 1) % p.length];
      nx += (a[1] - b2[1]) * (a[2] + b2[2]);
      ny += (a[2] - b2[2]) * (a[0] + b2[0]);
      nz += (a[0] - b2[0]) * (a[1] + b2[1]);
    }
    // orient outward
    let cx = 0, cy = 0, cz = 0;
    for (const q of p) { cx += q[0]; cy += q[1]; cz += q[2]; }
    cx /= p.length; cy /= p.length; cz /= p.length;
    if (nx * (cx - centre[0]) + ny * (cy - centre[1]) + nz * (cz - centre[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    if (nx * TO_CAM[0] + ny * TO_CAM[1] + nz * TO_CAM[2] <= 0.001) continue;
    drawn.push({ F, nx, ny, nz, roof: !F.wall });
  }
  drawn.sort((p, q) => p.roof - q.roof);
  for (const d of drawn) {
    const { F } = d;
    let f;
    if (F.wall) f = wallShade(d.nx, d.ny);
    else { const t = d.ny - d.nx; f = t > 0.25 ? SIL.SHADES.hi : t > -0.25 ? SIL.SHADES.base : SIL.SHADES.mid; }
    const col = shade(F.col, f);
    const pts = F.pts.map((q) => [px(q[0], q[1]), py(q[0], q[1], q[2])]);
    poly(C.g, pts, col, outline ? shade(col, F.wall ? SIL.SHADES.low : SIL.SHADES.line) : null, 1);
    if (F.wall) wallDetails(C, F.b, F.wall.P, F.wall.Q, d.nx, d.ny, F.wall.h, f, F.wall.opts);
    else if (F.tiles && C.L === 0) {
      // roof tile courses
      g.strokeStyle = shade(col, SIL.SHADES.mid); g.lineWidth = 1;
      const [a0, a1, b1, b0] = F.tiles;   // eave a0-a1, ridge b0-b1
      for (let s = 1; s < 4; s++) {
        const t = s / 4;
        const p0 = a0.map((v, i) => v + (b0[i] - v) * t), p1 = a1.map((v, i) => v + (b1[i] - v) * t);
        g.beginPath(); g.moveTo(px(p0[0], p0[1]), Math.round(py(p0[0], p0[1], p0[2])) + 0.5);
        g.lineTo(px(p1[0], p1[1]), Math.round(py(p1[0], p1[1], p1[2])) + 0.5); g.stroke();
      }
    }
  }
}

function pitchedFaces(b, box, h, rise, wall, roof, hip, overhang) {
  const { c, u, v, l, w } = box;
  const P = (su, sv, z, ou = 0, ov = 0) => [c[0] + u[0] * (su * l / 2 + ou) + v[0] * (sv * w / 2 + ov), c[1] + u[1] * (su * l / 2 + ou) + v[1] * (sv * w / 2 + ov), z];
  const A0 = P(-1, -1, 0), B0 = P(1, -1, 0), C0 = P(1, 1, 0), D0 = P(-1, 1, 0);
  const Ah = P(-1, -1, h), Bh = P(1, -1, h), Ch = P(1, 1, h), Dh = P(-1, 1, h);
  const inset = hip ? Math.min(l / 2 - 0.3, w / 2) : 0;
  const R1 = P(-1, 0, h + rise, inset), R2 = P(1, 0, h + rise, -inset);
  const o = overhang, dz = (o * rise) / (w / 2);
  const E = (su, sv) => P(su, sv, h - dz, su * (hip ? o : o * 0.6), sv * o);
  const wallF = (pts, P0, Q0, opts) => ({ pts, col: wall, b, wall: { P: P0, Q: Q0, h, opts } });
  const faces = [
    wallF([A0, B0, Bh, Ah], A0, B0, { door: true }),
    wallF([C0, D0, Dh, Ch], C0, D0, { door: true }),
  ];
  if (hip) {
    faces.push(wallF([B0, C0, Ch, Bh], B0, C0), wallF([D0, A0, Ah, Dh], D0, A0));
    const R1o = hip ? [R1[0] - u[0] * o * 0.3, R1[1] - u[1] * o * 0.3, R1[2]] : R1;
    const R2o = hip ? [R2[0] + u[0] * o * 0.3, R2[1] + u[1] * o * 0.3, R2[2]] : R2;
    faces.push({ pts: [E(-1, -1), E(1, -1), R2o, R1o], col: roof, tiles: [E(-1, -1), E(1, -1), R2o, R1o] });
    faces.push({ pts: [E(1, 1), E(-1, 1), R1o, R2o], col: roof, tiles: [E(1, 1), E(-1, 1), R1o, R2o] });
    faces.push({ pts: [E(1, -1), E(1, 1), R2o], col: roof });
    faces.push({ pts: [E(-1, 1), E(-1, -1), R1o], col: roof });
  } else {
    faces.push(wallF([B0, C0, Ch, R2, Bh], B0, C0));
    faces.push(wallF([D0, A0, Ah, R1, Dh], D0, A0));
    const R1o = P(-1, 0, h + rise, -o * 0.6), R2o = P(1, 0, h + rise, o * 0.6);
    faces.push({ pts: [E(-1, -1), E(1, -1), R2o, R1o], col: roof, tiles: [E(-1, -1), E(1, -1), R2o, R1o] });
    faces.push({ pts: [E(1, 1), E(-1, 1), R1o, R2o], col: roof, tiles: [E(1, 1), E(-1, 1), R1o, R2o] });
  }
  return { faces, centre: [c[0], c[1], h / 2] };
}

function drawPitched(C, b) {
  const { th, L } = C;
  const wall = wallColor(th, b), roof = roofColor(th, b);
  const { faces, centre } = pitchedFaces(b, b.box, b.h, b.rise, wall, roof, b.kind === 'hip', L <= 1 ? 0.35 : 0);
  drawSolid(C, faces, centre, L <= 2);
  if (b.chimney && L <= 1) {
    const { c, u, l } = b.box;
    const t = (rnd(b.seed, 9) - 0.5) * 0.5;
    const e = c[0] + u[0] * l * t, n = c[1] + u[1] * l * t;
    boxAt(C, e, n, 0.35, b.h + b.rise * 0.6, b.h + b.rise + 0.9, th.walls.brick[0], shade(th.walls.brick[0], SIL.SHADES.low));
  }
}

function drawChurch(C, b) {
  const { th, L, g, px, py } = C;
  const wall = th.walls.brick[0], roof = th.roofs.brick[0];
  const nave = pitchedFaces(b, b.box, b.h, b.rise, wall, roof, false, L <= 1 ? 0.4 : 0);
  const t = b.tower, hw = t.w / 2;
  const tc = t.c;
  const P = (de, dn, z) => [tc[0] + de, tc[1] + dn, z];
  const tower = [
    { pts: [P(-hw, -hw, 0), P(hw, -hw, 0), P(hw, -hw, t.h), P(-hw, -hw, t.h)], col: wall, b, wall: { P: [tc[0] - hw, tc[1] - hw], Q: [tc[0] + hw, tc[1] - hw], h: t.h } },
    { pts: [P(hw, -hw, 0), P(hw, hw, 0), P(hw, hw, t.h), P(hw, -hw, t.h)], col: wall, b, wall: { P: [tc[0] + hw, tc[1] - hw], Q: [tc[0] + hw, tc[1] + hw], h: t.h } },
    { pts: [P(hw, hw, 0), P(-hw, hw, 0), P(-hw, hw, t.h), P(hw, hw, t.h)], col: wall, b, wall: { P: [tc[0] + hw, tc[1] + hw], Q: [tc[0] - hw, tc[1] + hw], h: t.h } },
    { pts: [P(-hw, hw, 0), P(-hw, -hw, 0), P(-hw, -hw, t.h), P(-hw, hw, t.h)], col: wall, b, wall: { P: [tc[0] - hw, tc[1] + hw], Q: [tc[0] - hw, tc[1] - hw], h: t.h } },
    { pts: [P(-hw, -hw, t.h), P(hw, -hw, t.h), P(0, 0, t.h + t.spire)], col: roof },
    { pts: [P(hw, -hw, t.h), P(hw, hw, t.h), P(0, 0, t.h + t.spire)], col: roof },
    { pts: [P(hw, hw, t.h), P(-hw, hw, t.h), P(0, 0, t.h + t.spire)], col: roof },
    { pts: [P(-hw, hw, t.h), P(-hw, -hw, t.h), P(0, 0, t.h + t.spire)], col: roof },
  ];
  const navePlain = nave.faces.map((f) => (f.wall ? Object.assign({}, f, { wall: null, isWall: true }) : f));
  // treat nave walls as walls for shading but skip window rows: churches get tall lancet windows instead
  const solid = (faces, centre) => {
    drawSolid(C, faces.map((f) => (f.isWall ? Object.assign({}, f, { wall: { P: [0, 0], Q: [0, 0], h: 0 } }) : f)), centre, L <= 2);
  };
  const towerFirst = (tc[0] + tc[1]) > (b.box.c[0] + b.box.c[1]);
  const drawTower = () => {
    drawSolid(C, tower.map((f) => (f.wall ? Object.assign({}, f, { wall: { P: f.wall.P, Q: f.wall.Q, h: 0 } }) : f)), [tc[0], tc[1], t.h / 2], L <= 2);
    if (L <= 2) {
      // belfry openings + cross
      for (const [Pp, Qq] of [[[tc[0] - hw, tc[1] - hw], [tc[0] + hw, tc[1] - hw]], [[tc[0] - hw, tc[1] + hw], [tc[0] - hw, tc[1] - hw]]]) {
        const at = (s, z) => { const e = Pp[0] + (Qq[0] - Pp[0]) * s, n = Pp[1] + (Qq[1] - Pp[1]) * s; return [px(e, n), py(e, n, z)]; };
        poly(g, [at(0.35, t.h - 6), at(0.65, t.h - 6), at(0.65, t.h - 2), at(0.35, t.h - 2)], shade(th.window, 0.72));
        poly(g, [at(0.38, 4), at(0.62, 4), at(0.62, 9), at(0.38, 9)], shade(th.window, 0.86));
      }
      const top = t.h + t.spire;
      g.strokeStyle = th.marking === '#ece4c8' ? '#d8b04a' : shade('#d8b04a', 0.6); g.lineWidth = Math.max(1, C.k * 0.25);
      g.beginPath(); g.moveTo(px(tc[0], tc[1]), py(tc[0], tc[1], top)); g.lineTo(px(tc[0], tc[1]), py(tc[0], tc[1], top + 2.6)); g.stroke();
      g.beginPath(); g.moveTo(px(tc[0] - 0.7, tc[1] + 0.7), py(tc[0] - 0.7, tc[1] + 0.7, top + 1.8)); g.lineTo(px(tc[0] + 0.7, tc[1] - 0.7), py(tc[0] + 0.7, tc[1] - 0.7, top + 1.8)); g.stroke();
    }
  };
  if (towerFirst) drawTower();
  solid(navePlain, nave.centre);
  if (L <= 1) {
    // lancet windows along the visible long wall
    const { c, u, v, l, w } = b.box;
    for (const sv of [-1, 1]) {
      const nx = v[0] * sv, ny = v[1] * sv;
      if (-nx - ny <= 0) continue;
      const P0 = [c[0] - u[0] * l / 2 + nx * w / 2, c[1] - u[1] * l / 2 + ny * w / 2];
      const Q0 = [c[0] + u[0] * l / 2 + nx * w / 2, c[1] + u[1] * l / 2 + ny * w / 2];
      for (let s = 0.2; s < 0.85; s += 0.13) {
        const at = (q, z) => { const e = P0[0] + (Q0[0] - P0[0]) * q, n = P0[1] + (Q0[1] - P0[1]) * q; return [px(e, n), py(e, n, z)]; };
        const col = C.night ? th.windowLit : shade(th.glass, 0.86);
        poly(g, [at(s, 2.5), at(s + 0.035, 2.5), at(s + 0.035, b.h - 2.5), at(s, b.h - 2.5)], col);
      }
    }
  }
  if (!towerFirst) drawTower();
}

// ------------------------------------------------------------ palette snap
function quantize(A) {
  if (!A.lut) {
    A.lut = new Int16Array(1 << 18).fill(-1);
    A.palU32 = new Uint32Array(A.pal.length);
    A.pal.forEach((q, i) => {
      A.palU32[i] = (255 << 24 | q[2] << 16 | q[1] << 8 | q[0]) >>> 0;
      A.lut[(q[0] >> 2) | ((q[1] >> 2) << 6) | ((q[2] >> 2) << 12)] = i;   // exact colours win their bucket
    });
  }
  const lut = A.lut, pal = A.pal, palU32 = A.palU32;
  const img = g.getImageData(0, 0, T, T);
  const u = new Uint32Array(img.data.buffer);
  let lastIn = -1, lastOut = 0;
  for (let i = 0; i < u.length; i++) {
    const v = u[i];
    if (v === lastIn) { u[i] = lastOut; continue; }
    if ((v >>> 24) < 110) { u[i] = 0; continue; }
    const r = v & 255, gg = (v >>> 8) & 255, b = (v >>> 16) & 255;
    const key = (r >> 2) | ((gg >> 2) << 6) | ((b >> 2) << 12);
    let c = lut[key];
    if (c < 0) {
      let best = 1e9;
      for (let p = 0; p < pal.length; p++) {
        const q = pal[p];
        const dr = r - q[0], dg = gg - q[1], db = b - q[2];
        const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (dist < best) { best = dist; c = p; }
      }
      lut[key] = c;
    }
    lastIn = v; lastOut = palU32[c];
    u[i] = lastOut;
  }
  g.putImageData(img, 0, 0);
}
