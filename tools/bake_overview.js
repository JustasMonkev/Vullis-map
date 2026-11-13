#!/usr/bin/env node
/* Pre-paints the zoomed-out levels (3–6) of every season into one image per level,
 * so far zoom levels show instantly instead of being painted on the phone.
 *
 *   node tools/bake_overview.js          (needs Playwright + Chromium, and python3 with Pillow)
 *
 * Re-run after changing the renderer or the data, together with bumping VERSION in js/shared.js.
 * Writes tiles/<season>-L<level>.webp and tiles/atlas.json. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tiles');
const LEVELS = [3, 4, 5, 6];
const SEASONS = ['summer', 'winter', 'night'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>bake</title>'); return; }
  const file = path.join(ROOT, path.normalize(url));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto(origin + '/');
  await page.addScriptTag({ url: '/js/shared.js' });
  fs.mkdirSync(OUT, { recursive: true });
  const atlas = await page.evaluate(async ({ LEVELS, SEASONS }) => {
    const meta = (await (await fetch('/data/silale.json')).json()).meta;
    const ib = SIL.isoBoundsOf(meta);
    const w = new Worker('/js/worker.js');
    const waiters = new Map();
    w.onmessage = (e) => { const m = e.data; const f = waiters.get(m.key || m.type); if (f) { waiters.delete(m.key || m.type); f(m); } };
    const ask = (key, msg) => new Promise((r) => { waiters.set(key, r); w.postMessage(msg); });
    await ask('ready', { type: 'init', dataUrl: location.origin + '/data/silale.json' });
    const out = { version: SIL.VERSION, tile: SIL.ISO.TILE, levels: {}, images: {} };
    for (const L of LEVELS) {
      const R = SIL.levelRange(ib, L);
      const cols = R.tx1 - R.tx0 + 1, rows = R.ty1 - R.ty0 + 1;
      out.levels[L] = { tx0: R.tx0, ty0: R.ty0, cols, rows };
      for (const season of SEASONS) {
        const c = new OffscreenCanvas(cols * 256, rows * 256), g = c.getContext('2d');
        for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) {
          const key = [season, L, tx, ty].join('/');
          const m = await ask(key, { type: 'tile', key, L, tx, ty, theme: season });
          if (m.bitmap) g.drawImage(m.bitmap, (tx - R.tx0) * 256, (ty - R.ty0) * 256);
        }
        const blob = await c.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        out.images[season + '-L' + L] = btoa(bin);
        console.log(`painted ${season} L${L}: ${cols}x${rows} tiles`);
      }
    }
    w.terminate();
    return out;
  }, { LEVELS, SEASONS });

  const files = {};
  for (const [name, b64] of Object.entries(atlas.images)) {
    const png = path.join(OUT, name + '.png');
    fs.writeFileSync(png, Buffer.from(b64, 'base64'));
    // lossless WebP is several times smaller than the PNG the browser wrote
    execFileSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
im.save(sys.argv[2], 'WEBP', lossless=True, method=6, exact=False)
`, png, path.join(OUT, name + '.webp')]);
    fs.unlinkSync(png);
    files[name] = name + '.webp';
    console.log(name + '.webp', Math.round(fs.statSync(path.join(OUT, name + '.webp')).size / 1024) + ' KB');
  }
  delete atlas.images;
  atlas.files = files;
  fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify(atlas, null, 1) + '\n');
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
