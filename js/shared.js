/* Isometric Šilalė — code shared by the viewer and the tile-painting workers.
 *
 * World space: metres east (e) and north (n) of the town node, z up.
 * Iso space:   X = e - n,  Y = -(e + n) / 2 - z * H   (2:1 pixel-art dimetric,
 *              camera in the south-west looking north-east).
 */
(function (root) {
  'use strict';

  const ISO = {
    H: 1.225,          // iso units per vertical metre (true 2:1 dimetric)
    A0: 0.4,           // iso units per art pixel at the finest level
    TILE: 256,         // art pixels per tile edge
    LEVELS: 7,         // level L paints one art pixel per A0 * 2^L iso units
    SLAB: 34,          // diorama slab depth in metres
  };

  const isoX = (e, n) => e - n;
  const isoY = (e, n, z) => -(e + n) / 2 - (z || 0) * ISO.H;

  // ------------------------------------------------------------ hashing
  function hash32(x) {
    x = (x | 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
  }
  const rnd = (i, salt) => hash32(i * 7919 + (salt || 0) * 104729) / 4294967296;
  const rnd2 = (x, y, salt) => hash32(hash32(x | 0) ^ Math.imul(y | 0, 0x27d4eb2d) ^ ((salt || 0) * 0x165667b1)) / 4294967296;

  // ------------------------------------------------------------ colour
  function hexToRgb(h) {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbToHex(r, g, b) {
    const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  // Shading steps used everywhere. Keeping them discrete keeps the palette small.
  const SHADES = { hi: 1.12, base: 1, mid: 0.86, low: 0.72, line: 0.55 };
  const shadeCache = new Map();
  function shade(hex, f) {
    if (f === 1) return hex;
    const key = hex + f;
    let v = shadeCache.get(key);
    if (!v) {
      const [r, g, b] = hexToRgb(hex);
      v = f > 1 ? rgbToHex(r + (255 - r) * (f - 1) * 1.6, g + (255 - g) * (f - 1) * 1.6, b + (255 - b) * (f - 1) * 1.6)
                : rgbToHex(r * f, g * f * 0.98 + 2, b * f * 1.02 + 4);
      shadeCache.set(key, v);
    }
    return v;
  }

  // ------------------------------------------------------------ themes
  const SUMMER = {
    bg: '#8fb35a', bgSpeck: ['#83a852', '#9cc066'],
    farmland: '#c2b86a', farmStripe: '#ada35c',
    meadow: '#9cbc5c', grass: '#88b553', park: '#7aad4f', residential: '#a1bd66', school: '#9fbf66',
    cemetery: '#7f9f57', scrub: '#76a04a', wetland: '#86a77a', orchard: '#8db552',
    forest: '#4e7a3b', forestSpeck: ['#5d8b44', '#3f6635'],
    industrial: '#b7b2a4', commercial: '#c7bfae', paved: '#a8a49c', dirt: '#b8a07a',
    pitch: '#66ad4b', pitchLine: '#e8efe0', track: '#c0674a', stadium: '#7ab352', playground: '#d8c08a',
    water: '#4b8dc0', waterLight: '#7db7e0', waterEdge: '#3c6f98', waterDeep: '#3f7cae',
    road: '#8c8a87', roadCase: '#625f5c', roadMain: '#9b9893', marking: '#ece4c8',
    roadDirt: '#b39b70', path: '#d9d0b6', bridge: '#a9a39a',
    hedge: '#3f6a35', fence: '#8a7a64',
    slabTop: '#6d9a45', soil: '#8a5f3c', soil2: '#a07048', rock: '#7d7a78',
    window: '#3d566e', windowLit: '#ffd77a', glass: '#6f97b3', door: '#6b4a32',
    lamp: '#ffe9a8', smoke: '#e6e6e6',
    decid: ['#4f8a3b', '#5f9a40', '#6aa040', '#7a9e3c'], bush: ['#5f9a40', '#6aa040', '#4f8a3b'], birch: '#7fae48', conifer: ['#2f5d3a', '#3b6b40'],
    trunk: '#6b4a32', birchTrunk: '#e8e4da', treeHi: '#9cc75a', snow: '#f2f5f7',
    walls: {
      house: ['#ece2c8', '#f1efe7', '#e8d39a', '#cfdbe0', '#c9ab8c', '#dcc8b4', '#e6c3a4'],
      panel: ['#d6d2c8', '#cfc8b8', '#dcd6cb', '#e0d3bd'],
      commercial: ['#e5e0d4', '#d5dee3', '#efe3c3', '#e3d0c2'],
      civic: ['#eadfc4', '#d8cdb5', '#f0e7d2'],
      metal: ['#bcc2c6', '#c9c6bd', '#aeb8b1'],
      garage: ['#c9c2b4', '#bdb7ad'], shed: ['#9b7752', '#8a6a4a', '#b0a084'],
      brick: ['#a9533c'], ruins: ['#a09a90'], canopy: ['#cfcfcf'],
    },
    roofs: {
      house: ['#b4513b', '#93492f', '#6f7479', '#4f6b55', '#7a3f33', '#5d6470', '#a8643c'],
      panel: ['#8e8b86', '#97938c'], commercial: ['#9a9893', '#a8a39a', '#8f9395'],
      civic: ['#a0503c', '#8b8f93', '#6d7a70'], metal: ['#8d969c', '#a0a6a8', '#7f8a86'],
      garage: ['#6f6c68'], shed: ['#5f5a54', '#6e6a62', '#7d4a38'],
      brick: ['#5b6a68'], ruins: ['#8f877c'], canopy: ['#9fa5a8'],
    },
  };

  function themed(base, over) {
    const t = JSON.parse(JSON.stringify(base));
    for (const k in over) t[k] = over[k];
    return t;
  }

  const SNOW = '#eef2f5';
  const WINTER = themed(SUMMER, {
    bg: '#e9eef2', bgSpeck: ['#dde5ec', '#f6f8fa'],
    farmland: '#e5eaee', farmStripe: '#d6dee5', meadow: '#e4eaef', grass: '#e6ecf0', park: '#e1e8ed',
    residential: '#e8edf1', school: '#e6ebef', cemetery: '#dfe6eb', scrub: '#d9e1e5', wetland: '#d4dfe6',
    orchard: '#e3e9ed', forest: '#d6dfe5', forestSpeck: ['#c9d4dc', '#e8eef2'],
    stadium: '#e4eaee', pitch: '#e7ecf0', pitchLine: '#c7d2da', playground: '#e6e9ec', dirt: '#d9dde0',
    water: '#c6dbe7', waterLight: '#e6f0f6', waterEdge: '#9cb8c9', waterDeep: '#b5cfdf',
    road: '#9c9b9a', roadMain: '#a5a4a2', roadCase: '#787673', roadDirt: '#c4bcb0', path: '#e0e3e5', marking: '#d8d6cf',
    slabTop: SNOW, hedge: '#5b6e5a',
    decid: ['#7d6d5f', '#8b7a69', '#6e6155', '#7f7466'], bush: ['#c9d1d7', '#bfc8cf', '#d3dade'], birch: '#9a8d80', conifer: ['#2c4e3b', '#365a44'],
    treeHi: SNOW,
  });
  for (const k in WINTER.roofs) WINTER.roofs[k] = WINTER.roofs[k].map((c, i) => (i % 3 === 2 ? mix(c, SNOW, 0.55) : SNOW));
  WINTER.roofs.metal = ['#e4e9ec', '#dfe5e9']; WINTER.roofs.brick = ['#e9eef1'];

  const NIGHT_INK = '#16203a';
  const nightify = (h) => mix(shade(h, 0.42), NIGHT_INK, 0.38);
  function mapColors(t, fn, keep) {
    const out = {};
    for (const k in t) {
      const v = t[k];
      if (keep.includes(k)) out[k] = v;
      else if (typeof v === 'string') out[k] = fn(v);
      else if (Array.isArray(v)) out[k] = v.map(fn);
      else out[k] = mapColors(v, fn, keep);
    }
    return out;
  }
  const NIGHT = mapColors(SUMMER, nightify, ['windowLit', 'lamp']);
  NIGHT.windowLit = '#ffcf6b'; NIGHT.lamp = '#ffe39a'; NIGHT.lampGlow = '#5e5540';
  NIGHT.window = '#1d2740';

  const THEMES = { summer: SUMMER, winter: WINTER, night: NIGHT };

  function collectPalette(theme) {
    const set = new Set();
    const add = (v) => {
      if (typeof v === 'string' && v[0] === '#') for (const f of Object.values(SHADES)) set.add(shade(v, f));
      else if (Array.isArray(v)) v.forEach(add);
      else if (v && typeof v === 'object') Object.values(v).forEach(add);
    };
    add(theme);
    return [...set].map(hexToRgb);
  }

  // ------------------------------------------------------------ geometry
  function ringArea(r) {
    let s = 0;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const j = (i + 1) % n;
      s += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
    }
    return s / 2;
  }
  function ringCentroid(r) {
    let cx = 0, cy = 0, a = 0;
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const f = r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
      cx += (r[2 * i] + r[2 * j]) * f; cy += (r[2 * i + 1] + r[2 * j + 1]) * f; a += f;
    }
    if (Math.abs(a) < 1e-6) {
      for (let i = 0; i < n; i++) { cx += r[2 * i]; cy += r[2 * i + 1]; }
      return [cx / n, cy / n];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }
  function pointInRing(x, y, r) {
    let inside = false;
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // Minimum-area oriented box: {c:[cx,cy], u:[ux,uy] (long axis), v, l (long), w (short)}
  function obb(r) {
    const n = r.length / 2;
    let best = null;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let dx = r[2 * j] - r[2 * i], dy = r[2 * j + 1] - r[2 * i + 1];
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      dx /= L; dy /= L;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const x = r[2 * k], y = r[2 * k + 1];
        const u = x * dx + y * dy, v = -x * dy + y * dx;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const A = (u1 - u0) * (v1 - v0);
      if (!best || A < best.A) best = { A, dx, dy, u0, u1, v0, v1 };
    }
    const { dx, dy, u0, u1, v0, v1 } = best;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const c = [cu * dx - cv * dy, cu * dy + cv * dx];
    let lu = u1 - u0, lv = v1 - v0;
    let U = [dx, dy], V = [-dy, dx];
    if (lv > lu) { [lu, lv] = [lv, lu]; [U, V] = [V, [-U[0], -U[1]]]; }
    return { c, u: U, v: V, l: lu, w: lv };
  }

  // Corners of an oriented box, grown by `pad` metres on every side.
  function boxCorners(box, pad) {
    const { c, u, v } = box, hl = box.l / 2 + pad, hw = box.w / 2 + pad;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c[0] + u[0] * hl * a + v[0] * hw * b, c[1] + u[1] * hl * a + v[1] * hw * b]);
  }

  /* Turn a raw building record into a render-ready one.
     kind: 'flat' (extruded footprint) | 'gable' | 'hip' | 'church' */
  function applyProfiles(data, landmarks) {
    if (!Array.isArray(landmarks.profiles)) throw new Error('Invalid landmark profiles');
    const buildings = new Map(data.buildings.map((b) => [b.id, b]));
    const seen = new Set();
    for (const p of landmarks.profiles) {
      if (!buildings.has(p.id) || seen.has(p.id)) throw new Error('Unknown or duplicate landmark ID: ' + p.id);
      if (!Number.isFinite(p.height) || p.height <= 0 || !p.heightSource || p.heightSource.quality !== 'approximate' || typeof p.heightSource.url !== 'string' || !/^https:\/\//.test(p.heightSource.url) || !URL.canParse(p.heightSource.url) || typeof p.heightSource.label !== 'string' || !p.heightSource.label.length) throw new Error('Invalid landmark height source: ' + p.id);
      seen.add(p.id);
    }
    for (const p of landmarks.profiles) Object.assign(buildings.get(p.id), { height: p.height, heightSource: p.heightSource });
    return data;
  }

  async function loadMapData(dataUrl) {
    const urls = [dataUrl, new URL('landmarks.json', dataUrl).href, new URL('landcover.json', dataUrl).href];
    const [data, landmarks, landcover] = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Map source ' + url + ': HTTP ' + response.status);
      return response.json();
    }));
    data.landcover = landcover;
    return applyProfiles(data, landmarks);
  }

  function prepBuilding(b, i) {
    const r = b.r;
    const area = Math.abs(ringArea(r));
    const c = ringCentroid(r);
    const seed = hash32(i * 2654435761 + 17);
    const m = b.m || 'house';
    let kind = b.roof === 'church' ? 'church' : (b.roof === 'gable' || b.roof === 'hip') ? b.roof : 'flat';
    let box = kind === 'flat' && m !== 'panel' ? null : obb(r);
    if ((kind === 'gable' || kind === 'hip') && area / (box.l * box.w) < 0.95) {
      kind = 'flat';
      box = null;
    }
    const height = Number.isFinite(b.height) && b.height > 0 ? b.height : null;
    const roofHeight = Number.isFinite(b.rh) && b.rh >= 0 ? b.rh : null;
    const heightSource = height === null ? { quality: 'inferred', label: 'Estimated from footprint and building type' } : b.heightSource || { quality: 'osm', label: 'OSM height; geometry is schematic' };
    if (height !== null && !b.heightSource && /^r?\d+$/.test(b.id)) heightSource.url = 'https://www.openstreetmap.org/' + (b.id[0] === 'r' ? 'relation/' + b.id.slice(1) : 'way/' + b.id);
    let h = height === null ? b.h : height, top = h, rise = 0;
    if (kind === 'gable' || kind === 'hip') {
      rise = roofHeight === null ? Math.min(5.5, box.w * 0.5 * (m === 'shed' ? 0.5 : 0.85)) : roofHeight;
      if (height !== null) {
        rise = Math.min(rise, roofHeight === null ? height / 2 : height);
        h = height - rise;
      }
      top = h + rise;
    }
    let tower = null;
    if (kind === 'church') {
      const big = area > 300;
      const eave = big ? 12 : 7;
      rise = roofHeight === null ? Math.min(8, box.w * 0.5 * 1.1) : roofHeight;
      // Tower at the end of the long axis that faces south (towards the camera).
      const sgn = box.u[1] > 0 ? -1 : 1;
      const tw = Math.min(box.w * (big ? 0.62 : 0.7), big ? 8 : 4.5);
      const tc = [box.c[0] + box.u[0] * sgn * (box.l / 2 - tw / 2), box.c[1] + box.u[1] * sgn * (box.l / 2 - tw / 2)];
      const shaft = big ? 31 : 15, spire = big ? 17 : 9;
      const cross = height === null ? 2.6 : Math.min(2.6, height / 10);
      const scale = height === null ? 1 : (height - cross) / (shaft + spire);
      tower = { c: tc, w: tw, h: shaft * scale, spire: spire * scale, cross };
      top = height === null ? shaft + spire + cross : height;
      h = Math.min(eave, tower.h);
      rise = Math.min(rise, top - h);
    }
    // depth: larger = farther from camera (drawn first)
    let dmin = Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const grow = (e, nn) => {
      const X = isoX(e, nn), Y = isoY(e, nn, 0);
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y > y1) y1 = Y; if (Y < y0) y0 = Y;
    };
    for (let k = 0; k < r.length; k += 2) {
      const e = r[k], nn = r[k + 1];
      const d = e + nn; if (d < dmin) dmin = d;
      grow(e, nn);
    }
    // Pitched roofs and churches are drawn from their oriented box plus eaves, which can
    // reach past the footprint: bound what is actually drawn, or tile culling clips it.
    if (box) for (const [e, nn] of boxCorners(box, 0.6)) grow(e, nn);
    if (tower) for (const [e, nn] of boxCorners({ c: tower.c, u: [1, 0], v: [0, 1], l: tower.w, w: tower.w }, 0.2)) grow(e, nn);
    y0 -= top * ISO.H + 2;
    const depth = ((c[0] + c[1]) + dmin) / 2;
    return {
      i, r, c, area, kind, box, h, rise, top, tower, m, heightSource,
      wi: hash32(seed + 1), ri: hash32(seed + 2),
      seed, depth, bbox: [x0 - 1, y0, x1 + 1, y1 + 1],
      chimney: (m === 'house' && kind !== 'flat' && (seed % 10) < 6),
    };
  }

  // Simple uniform grid over iso space.
  class Grid {
    constructor(cell) { this.cell = cell; this.map = new Map(); }
    insert(id, x0, y0, x1, y1) {
      const c = this.cell;
      for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++)
        for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy++) {
          const k = gx * 100003 + gy;
          let a = this.map.get(k);
          if (!a) this.map.set(k, (a = []));
          a.push(id);
        }
    }
    query(x0, y0, x1, y1, out, seen) {
      const c = this.cell;
      for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++)
        for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy++) {
          const a = this.map.get(gx * 100003 + gy);
          if (!a) continue;
          for (let i = 0; i < a.length; i++) {
            const id = a[i];
            if (seen[id] === seen.stamp) continue;
            seen[id] = seen.stamp; out.push(id);
          }
        }
      return out;
    }
  }
  function makeSeen(n) { const s = new Uint32Array(n); s.stamp = 0; return s; }

  function worldToLatLon(meta, e, n) { return [meta.lat0 + n / meta.mLat, meta.lon0 + e / meta.mLon]; }
  function latLonToWorld(meta, lat, lon) { return [(lon - meta.lon0) * meta.mLon, (lat - meta.lat0) * meta.mLat]; }
  // iso (ground) -> world
  function isoToWorld(X, Y) { // e - n = X ; e + n = -2Y
    const s = -2 * Y;
    return [(X + s) / 2, (s - X) / 2];
  }

  // Iso-space box that holds the whole diorama (ground, tallest towers, slab).
  function isoBoundsOf(meta) {
    const [e0, n0, e1, n1] = meta.bounds;
    return [isoX(e0, n1), isoY(e1, n1, 60), isoX(e1, n0), isoY(e0, n0, -ISO.SLAB)];
  }
  // Tiles of level L that cover the whole diorama.
  function levelRange(ib, L) {
    const span = ISO.TILE * ISO.A0 * (1 << L);
    return { span, tx0: Math.floor(ib[0] / span), ty0: Math.floor(ib[1] / span), tx1: Math.floor(ib[2] / span), ty1: Math.floor(ib[3] / span) };
  }

  // Bump whenever the renderer or the data changes: browsers drop tiles saved by older versions.
  const VERSION = 'r5';

  const api = {
    VERSION, ISO, isoBoundsOf, levelRange, boxCorners, isoX, isoY, hash32, rnd, rnd2, hexToRgb, rgbToHex, mix, shade, SHADES, THEMES, collectPalette,
    ringArea, ringCentroid, pointInRing, obb, applyProfiles, loadMapData, prepBuilding, Grid, makeSeen,
    worldToLatLon, latLonToWorld, isoToWorld,
  };
  root.SIL = api;
})(typeof self !== 'undefined' ? self : this);
