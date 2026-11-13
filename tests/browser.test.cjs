const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve, extname } = require('node:path');
const { chromium } = require('playwright');

const root = resolve(__dirname, '..');
const artifacts = process.env.TEST_ARTIFACTS || resolve(root, 'test-results');
let browser, server, baseURL;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp' };
before(async () => {
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox'],
  });
});
after(async () => {
  await browser?.close();
  await new Promise((done) => server ? server.close(done) : done());
});

async function openMap(t, options = {}, hash = '#19/55.49043/22.18627') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && message.text().includes('[worker]')) errors.push(message.text()); });
  t.after(() => assert.deepEqual(errors, [], 'app and worker exceptions'));
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ body: '' }));
  await page.addInitScript(() => localStorage.setItem('silale-hint', '1'));
  return { page, context, async ready() {
    await page.goto(baseURL + '/' + hash);
    await page.locator('#loader').waitFor({ state: 'hidden', timeout: 30000 });
    await page.waitForFunction(() => /z\d/.test(document.querySelector('#readout').textContent));
  } };
}
async function zoom(page) {
  return Number((await page.locator('#readout').textContent()).match(/z([\d.]+)/)[1]);
}
async function painted(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#map');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let covered = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i]) covered++;
    return covered > 100;
  }, null, { timeout: 30000 });
}
async function canvasImage(page) {
  return page.locator('#map').evaluate((canvas) => canvas.toDataURL());
}
async function observeSeasonCache(page) {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    window.tilePaintRequests = [];
    window.withholdPaint = false;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'tile') {
        window.tilePaintRequests.push(message.key);
        if (window.withholdPaint) return;
      }
      return post.call(this, message, ...args);
    };
  });
  await page.route('**/js/app.js', async (route) => {
    const source = await readFile(resolve(root, 'js/app.js'), 'utf8');
    const seam = '  boot().catch((err) => {';
    assert.ok(source.includes(seam));
    const probe = `
      window.seasonCache = {
        snapshot() {
          const L = levelFor(view.s), R = tileRange(L), keys = [];
          for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) keys.push(tileKey(L, tx, ty));
          return { season, keys, exact: keys.every(key => cache.has(key)), dirty, paints: [...window.tilePaintRequests] };
        },
        saved: key => store.get(key),
        miss: key => store.state.get(key),
        has: key => cache.has(key),
        evict(key) { cache.get(key).bmp.close(); cache.delete(key); dirty = true; },
      };
    `;
    await route.fulfill({ contentType: 'text/javascript', body: source.replace(seam, probe + seam) });
  });
}
async function screenshot(page, name) {
  if (!artifacts) return;
  await require('node:fs/promises').mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, name + '.png') });
}

async function runPainter(page, body) {
  const source = await readFile(resolve(root, 'js/worker.js'), 'utf8');
  const seam = "importScripts('shared.js');";
  assert.ok(source.includes(seam), 'worker imports the shared renderer');
  return page.evaluate(({ source, body }) => new Promise((done, reject) => {
    const shared = new URL('/js/shared.js', location.href).href;
    const script = `'use strict';\nimportScripts(${JSON.stringify(shared)});\n${source}\n` +
      `(async () => { ${body} })().then(result => self.postMessage({ type: 'acceptance', result }), error => self.postMessage({ type: 'acceptance-error', message: error.stack || error.message }));`;
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const finish = (error, result) => {
      clearTimeout(deadline); worker.terminate(); URL.revokeObjectURL(url);
      if (error) reject(error); else done(result);
    };
    const deadline = setTimeout(() => finish(new Error('renderer acceptance worker timed out')), 30000);
    worker.onerror = (event) => finish(new Error(event.message));
    worker.onmessage = ({ data }) => {
      if (data.type === 'acceptance') finish(null, data.result);
      if (data.type === 'acceptance-error') finish(new Error(data.message));
    };
  }), { source: source.replace(seam, ''), body });
}

async function openPainter(t) {
  const { page } = await openMap(t, { viewport: { width: 800, height: 600 } });
  await page.route('**/painter-fixture', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Renderer acceptance</title><body style="margin:0;background:#e8e8e0">',
  }));
  await page.goto(baseURL + '/painter-fixture');
  return page;
}

test('source canopy trees respect real canvas occupancy and leave covered culverts underground', { timeout: 45000 }, async (t) => {
  const page = await openPainter(t);
  const result = await runPainter(page, `
    D = {
      meta: { bounds: [-100, -100, 100, 100], lat0: 0, lon0: 0, mLat: 1, mLon: 1 },
      landcover: { crs: 'EPSG:4326', width: 2, height: 1, transform: [-100, 100, 0, 100, 0, -200], nodata: 0, encoding: 'rle-count-value', data: [1, 10, 1, 30] },
      areas: [
        { k: 'forest', r: [[-90, -90, 90, -90, 90, 90, -90, 90]] },
        { k: 'water', r: [[-80, 35, -35, 35, -35, 65, -80, 65]] }
      ],
      buildings: [{ r: [-60, -10, -30, -10, -30, 20, -60, 20], h: 6, roof: 'flat', m: 'house' }],
      roads: [{ c: 'residential', p: [-90, -40, 90, -40], w: 12 }],
      waterways: [
        { c: 'stream', p: [-15, -70, -15, 70], w: 8 },
        { c: 'stream', p: [-75, -80, -75, -50], w: 10, covered: 1 }
      ],
      barriers: [], trees: [], treeRows: []
    };
    prepare();
    const trees = Array.from(TR.e, (e, i) => [e, TR.n_[i]]);
    const preview = new OffscreenCanvas(512, 512), ctx = preview.getContext('2d');
    for (let ty = -1; ty <= 0; ty++) for (let tx = -1; tx <= 0; tx++) {
      paintTile(1, tx, ty, 'summer'); ctx.drawImage(canvas, (tx + 1) * 256, (ty + 1) * 256);
    }
    return { trees, image: new FileReaderSync().readAsDataURL(await preview.convertToBlob()) };
  `);
  assert.ok(result.trees.length > 100, 'canopy must produce enough trees to exercise exclusions');
  for (const [e, n] of result.trees) {
    assert.ok(e < 0, 'grass-class pixels must not grow inferred canopy');
    assert.ok(!(e > -88 && e < 88 && Math.abs(n + 40) < 6), 'the full 12 m measured road carriageway stays clear');
    assert.ok(!(e > -60 && e < -30 && n > -10 && n < 20), 'building interior stays clear');
    assert.ok(!(e > -80 && e < -35 && n > 35 && n < 65), 'open water stays clear');
    assert.ok(!(Math.abs(e + 15) < 4 && n > -68 && n < 68), 'the full 8 m measured open stream stays clear');
  }
  assert.ok(result.trees.some(([e, n]) => e > -79 && e < -71 && n > -78 && n < -55), 'covered stream must not cut a visible clearing through canopy');
  await page.evaluate((image) => { const img = document.createElement('img'); img.src = image; document.body.append(img); return img.decode(); }, result.image);
  await screenshot(page, 'source-canopy-occupancy');
});

test('real pixels distinguish bridge decks, mapped road surfaces and underground water', { timeout: 45000 }, async (t) => {
  const page = await openPainter(t);
  const result = await runPainter(page, `
    const base = {
      meta: { bounds: [-100, -100, 200, 100], lat0: 0, lon0: 0, mLat: 1, mLon: 1 },
      landcover: { crs: 'EPSG:4326', width: 1, height: 1, transform: [-100, 300, 0, 100, 0, -200], nodata: 0, encoding: 'rle-count-value', data: [1, 30] },
      areas: [], buildings: [], roads: [], waterways: [], barriers: [], trees: [], treeRows: []
    };
    const images = {}, centers = {}, preview = new OffscreenCanvas(768, 512), ctx = preview.getContext('2d');
    const road = { c: 'residential', p: [64, -65, 64, 65], w: 10 };
    const water = { c: 'stream', p: [-20, 0, 150, 0], w: 18 };
    const scenes = [
      ['asphalt', [{ ...road, s: 'asphalt' }], []],
      ['paving', [{ ...road, s: 'paving_stones' }], []],
      ['gravel', [{ ...road, s: 'gravel' }], []],
      ['covered', [{ ...road, s: 'asphalt' }], [{ ...water, covered: 1 }]],
      ['open', [{ ...road, s: 'asphalt' }], [water]],
      ['ordinary', [{ c: 'footway', p: road.p, w: 8, s: 'asphalt' }, { c: 'primary', p: water.p, w: 12, s: 'gravel' }], [water]],
      ['bridge', [{ c: 'footway', p: road.p, w: 8, s: 'asphalt', br: 1 }, { c: 'primary', p: water.p, w: 12, s: 'gravel' }], [water]]
    ];
    for (let i = 0; i < scenes.length; i++) {
      const [name, roads, waterways] = scenes[i];
      D = { ...base, roads, waterways }; prepare(); paintTile(0, 0, -1, 'summer');
      images[name] = new FileReaderSync().readAsDataURL(await canvas.convertToBlob());
      centers[name] = Array.from(g.getImageData(160, 176, 1, 1).data);
      if (name === 'asphalt' || name === 'paving' || name === 'gravel') ctx.drawImage(canvas, i * 256, 0);
      if (name === 'ordinary' || name === 'bridge') ctx.drawImage(canvas, (i - 5) * 256, 256);
    }
    return { images, centers, preview: new FileReaderSync().readAsDataURL(await preview.convertToBlob()) };
  `);
  assert.notEqual(result.images.asphalt, result.images.paving, 'paving must paint its mapped surface');
  assert.notEqual(result.images.asphalt, result.images.gravel, 'gravel must paint its mapped surface');
  assert.notEqual(result.images.paving, result.images.gravel);
  assert.equal(result.images.covered, result.images.asphalt, 'covered water must leave no visible stream pixels');
  assert.notEqual(result.images.open, result.images.covered, 'open water must remain visible outside the crossing');
  assert.notDeepEqual(result.centers.bridge, result.centers.ordinary, 'the bridge deck must paint above the intersecting ground road');
  assert.deepEqual(result.centers.bridge, result.centers.asphalt, 'the bridge keeps its mapped asphalt across the crossing');
  await page.evaluate((image) => { const img = document.createElement('img'); img.src = image; document.body.append(img); return img.decode(); }, result.preview);
  await screenshot(page, 'bridge-surface-culvert-pixels');
});

test('the published church tower height survives loading and appears with its source in every season', { timeout: 60000 }, async (t) => {
  const { page, ready } = await openMap(t, { reducedMotion: 'reduce' });
  await page.route('**/js/app.js', async (route) => {
    const source = await readFile(resolve(root, 'js/app.js'), 'utf8');
    const seam = '  boot().catch((err) => {';
    assert.ok(source.includes(seam), 'test seam must match the app boot call');
    const settled = `
      window.isMapSettled = () => {
        if (!isoBounds || dirty || anim) return false;
        const L = levelFor(view.s), R = tileRange(L);
        for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) {
          if (!cache.has(tileKey(L, tx, ty))) return false;
        }
        return true;
      };
    `;
    await route.fulfill({ contentType: 'text/javascript', body: source.replace(seam, settled + seam) });
  });
  await ready();
  const landmark = await page.evaluate(async () => {
    const data = await window.SIL.loadMapData(new URL('data/silale.json', location.href).href);
    const index = data.buildings.findIndex((building) => building.id === '212787870');
    const raw = data.buildings[index], model = window.SIL.prepBuilding(raw, index);
    return { name: raw.n, top: model.top, towerTip: model.tower.h + model.tower.spire + model.tower.cross, source: model.heightSource };
  });
  assert.equal(landmark.top, 60);
  assert.equal(landmark.towerTip, 60, 'the cross must fit inside the published total tower height');
  assert.equal(landmark.source.quality, 'approximate');
  const towerPixels = await runPainter(page, `
    D = {
      meta: { bounds: [-30, -20, 30, 20], lat0: 0, lon0: 0, mLat: 1, mLon: 1 },
      landcover: { crs: 'EPSG:4326', width: 1, height: 1, transform: [-30, 60, 0, 20, 0, -40], nodata: 0, encoding: 'rle-count-value', data: [1, 30] },
      areas: [], buildings: [], roads: [], waterways: [], barriers: [], trees: [], treeRows: []
    };
    // A simple, isolated footprint keeps ground, nave and shadows below this
    // fixed upper-tower window. At L0 the 60 m tip is near pixel (40, 52);
    // a default 50.6 m church or a 20 m church cannot reach rows 50..60.
    const church = { r: [-20, -8, 20, -8, 20, 8, -20, 8], h: 12, roof: 'church', m: 'brick' };
    const result = {};
    for (const season of ['summer', 'winter', 'night']) {
      const counts = [];
      for (const buildings of [[], [church], [{ ...church, height: 20 }], [{ ...church, height: 60 }]]) {
        D.buildings = buildings; prepare(); paintTile(0, 0, -1, season);
        const pixels = g.getImageData(35, 50, 11, 11).data;
        let count = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 128) count++;
        counts.push(count);
      }
      result[season] = counts;
    }
    return result;
  `);
  for (const [season, [empty, inferred, short, measured]] of Object.entries(towerPixels)) {
    assert.deepEqual([empty, inferred, short], [0, 0, 0], `${season}: upper tower window is clear without a 60 m tower`);
    assert.ok(measured >= 5, `${season}: the painter draws the measured 60 m tower in its elevated window`);
  }
  await page.locator('#q').fill(landmark.name);
  await page.locator('#q').press('Enter');
  await page.locator('#card').waitFor({ state: 'visible' });
  const facts = await page.locator('#card-facts').evaluate((list) => Object.fromEntries([...list.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling.textContent])));
  assert.equal(facts.Height, '≈ 60 m (tower)');
  assert.equal(facts['Height basis'], landmark.source.label);
  assert.equal(await page.locator('#card-height-source').getAttribute('href'), 'https://silale.lt/en/tourism/');
  assert.equal(await page.locator('#card-height-source').isVisible(), true);
  await painted(page);
  await page.waitForFunction(() => window.isMapSettled());
  await screenshot(page, 'source-church-summer');
  for (const season of ['winter', 'night']) {
    const previous = await canvasImage(page);
    await page.getByRole('radio', { name: season[0].toUpperCase() + season.slice(1) }).click();
    await page.waitForFunction((previous) => document.querySelector('#map').toDataURL() !== previous, previous);
    await painted(page);
    assert.equal(await page.locator('body').getAttribute('data-season'), season);
    await page.waitForFunction(() => window.isMapSettled());
    await screenshot(page, 'source-church-' + season);
  }
  await page.locator('#card-close').click();
  await page.getByRole('radio', { name: 'Summer' }).click();
  await page.locator('#q').fill('55.490626, 22.173438');
  await page.locator('#q').press('Enter');
  await page.waitForFunction(() => document.querySelector('#readout').textContent.startsWith('55.49063'));
  await painted(page);
  await page.waitForFunction(() => window.isMapSettled());
  await screenshot(page, 'source-bridge');
});

// Execute the actual painter in Chromium. Only the boot and unrelated UI are
// suppressed; the regression exercises real alpha compositing, not a canvas mock.
test('transparent finer tiles replace stale coarser pixels', async (t) => {
  const { page } = await openMap(t, { viewport: { width: 800, height: 600 } });
  await page.route('**/js/app.js', async (route) => {
    const source = await readFile(resolve(root, 'js/app.js'), 'utf8');
    const seam = '  boot().catch((err) => {';
    assert.ok(source.includes(seam), 'test seam must match the app boot call');
    const injected = `
      window.tileCompositionCheck = async function () {
        W = 800; H = 600; DPR = 1; canvas.width = W; canvas.height = H;
        isoBounds = [-10000, -10000, 10000, 10000];
        Object.assign(view, { x: 100, y: 100, s: .4 });
        schedule = evict = drawHighlight = drawLabels = placeNote = updateReadout = () => {};
        const coarse = new OffscreenCanvas(ISO.TILE, ISO.TILE);
        coarse.getContext('2d').fillStyle = '#ff0000'; coarse.getContext('2d').fillRect(0, 0, ISO.TILE, ISO.TILE);
        const fine = new OffscreenCanvas(ISO.TILE, ISO.TILE);
        fine.getContext('2d').fillStyle = '#0000ff'; fine.getContext('2d').fillRect(0, 0, 32, 32);
        cache.set('summer/4/0/0', { bmp: await createImageBitmap(coarse), used: 0 });
        cache.set('summer/2/0/0', { bmp: await createImageBitmap(fine), used: 0 });
        render();
        const sample = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
        return { marker: sample(370, 270), empty: sample(400, 300), coarse: sample(550, 300) };
      };
      if (false) boot().catch((err) => {`;
    await route.fulfill({ contentType: 'text/javascript', body: source.replace(seam, injected) });
  });
  await page.goto(baseURL);
  const pixels = await page.evaluate(() => window.tileCompositionCheck());
  await screenshot(page, 'tile-composition');
  assert.deepEqual(pixels.marker, [0, 0, 255, 255]);
  assert.equal(pixels.empty[3], 0, 'transparent child area must erase stale parent geometry');
  assert.deepEqual(pixels.coarse, [255, 0, 0, 255], 'uncovered parent still provides fallback');
});

for (const mobile of [false, true]) {
  test(`startup prepares zoom detail for immediate reuse on ${mobile ? 'mobile' : 'desktop'}`, { timeout: 60000 }, async (t) => {
    const { page } = await openMap(t, {
      reducedMotion: 'reduce', viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 },
      isMobile: mobile, hasTouch: mobile,
    });
    await page.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      const held = [];
      let holdNextDetail = true;
      window.paintRequests = [];
      window.heldZoomTile = null;
      window.releaseZoomTile = () => {
        for (const [worker, args] of held.splice(0)) post.apply(worker, args);
      };
      Worker.prototype.postMessage = function (message, ...args) {
        if (message.type === 'tile') {
          window.paintRequests.push(message.key);
          if (holdNextDetail && message.L === 2) {
            holdNextDetail = false;
            window.heldZoomTile = message.key;
            held.push([this, [message, ...args]]);
            return;
          }
        }
        return post.call(this, message, ...args);
      };
    });
    await page.route('**/js/app.js', async (route) => {
      const source = await readFile(resolve(root, 'js/app.js'), 'utf8');
      const seam = '  boot().catch((err) => {';
      assert.ok(source.includes(seam), 'test seam must match the app boot call');
      const injected = `
        function visibleKeys(scale) {
          const L = levelFor(scale), R = tileRange(L, { ...view, s: scale });
          const keys = [];
          for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) keys.push(tileKey(L, tx, ty));
          return keys;
        }
        window.zoomPreparation = {
          initialReady: () => isoBounds && visibleKeys(view.s).every(key => cache.has(key)),
          snapshot: () => ({ prepared: [...prepared], cached: [...cache.keys()], paints: [...window.paintRequests], ms: performance.now() }),
          zoom(scale) {
            const keys = visibleKeys(scale);
            const missing = keys.filter(key => !cache.has(key));
            zoomAt(W / 2, H / 2, scale / view.s);
            render();
            return { keys, missing };
          },
        };
      `;
      await route.fulfill({ contentType: 'text/javascript', body: source.replace(seam, injected + seam) });
    });
    await page.goto(baseURL + '/#19/55.49043/22.18627');
    await page.waitForFunction(() => window.heldZoomTile && window.zoomPreparation.initialReady());
    assert.equal(await page.locator('#loader').isVisible(), true, 'the loader must wait for another zoom band after the opening screen is painted');
    await page.evaluate(() => window.releaseZoomTile());
    await page.locator('#loader').waitFor({ state: 'hidden', timeout: 30000 });
    await painted(page);
    const initial = await page.evaluate(() => window.zoomPreparation.snapshot());
    assert.ok(initial.prepared.every((key) => initial.cached.includes(key)), 'startup must cache its complete bounded preparation set');
    const results = [];
    for (let cycle = 0; cycle < 2; cycle++) for (const scale of [0.625, 1.25, 2.5, 12]) {
      const result = await page.evaluate((scale) => window.zoomPreparation.zoom(scale), scale);
      assert.deepEqual(result.missing, [], `scale ${scale} must have exact detail before the zoom frame`);
      assert.ok(result.keys.length > 0);
      results.push(...result.keys);
    }
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const after = await page.evaluate(() => window.zoomPreparation.snapshot());
    const repaintedVisible = after.paints.slice(initial.paints.length).filter((key) => results.includes(key));
    assert.deepEqual(repaintedVisible, [], 'repeated prepared zooms must send no visible tile back to a painter');
    t.diagnostic(JSON.stringify({ device: mobile ? 'mobile' : 'desktop', coldLoadMs: Math.round(initial.ms), preparedTiles: initial.prepared.length, startupPaintRequests: initial.paints.length, zoomVisibleMisses: 0, zoomVisibleRepaints: repaintedVisible.length }));
    await screenshot(page, mobile ? 'mobile-prepared-zoom' : 'desktop-prepared-zoom');
  });
}

test('rapid wheel and button zoom keeps rendering and interrupts a home glide', { timeout: 45000 }, async (t) => {
  const { page, ready } = await openMap(t);
  await ready(); await painted(page); await screenshot(page, 'desktop-close');
  const closeImage = await canvasImage(page);
  const control = await openMap(t, {}, '#12.9/55.49043/22.18627');
  await control.ready(); await painted(control.page);
  const overviewImage = await canvasImage(control.page);
  assert.notEqual(closeImage, overviewImage, 'close and overview views must paint different geometry');
  await page.mouse.move(640, 450);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('#readout').textContent.endsWith('z12.9'));
  await page.locator('#zin').hover();
  await page.waitForFunction((expected) => document.querySelector('#map').toDataURL() === expected, overviewImage, { timeout: 30000 });
  await painted(page); await screenshot(page, 'desktop-rapid-zoom-out');
  for (let i = 0; i < 5; i++) await page.locator('#zin').click({ delay: 5 });
  await page.waitForTimeout(100);
  assert.ok(await zoom(page) > 16.5);
  for (let i = 0; i < 7; i++) await page.locator('#zout').click({ delay: 5 });
  await page.waitForTimeout(100);
  assert.equal(await zoom(page), 12.9);
  await page.locator('#zin').click();
  await page.locator('#home').click();
  await page.waitForTimeout(80);
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);
  const interrupted = await zoom(page);
  await page.waitForTimeout(2800);
  assert.equal(await zoom(page), interrupted, 'a cancelled fly must not resume after direct zoom');
  await painted(page);
});

test('touch pinch cancellation releases gestures; dragging cancels an active fly', { timeout: 45000 }, async (t) => {
  const { page, context, ready } = await openMap(t, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ready();
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y], id) => ({ id, x, y, radiusX: 1, radiusY: 1, force: 1 })),
  });
  const initial = await zoom(page);
  await touch('touchStart', [[60, 400], [330, 400]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[60 + i * 15, 400], [330 - i * 15, 400]]);
  await touch('touchCancel', []);
  await page.waitForTimeout(100);
  assert.ok(await zoom(page) < initial - 1, 'pinching inward zooms out');
  const cancelled = await zoom(page);
  await page.waitForTimeout(600);
  assert.equal(await zoom(page), cancelled, 'cancellation must not trigger a two-finger tap zoom');
  await touch('touchStart', [[100, 400], [290, 400]]);
  await touch('touchCancel', []);
  await page.waitForTimeout(600);
  assert.equal(await zoom(page), cancelled, 'a cancelled stationary pinch is not a two-finger tap');
  await page.locator('#home').click();
  await page.waitForTimeout(70);
  await touch('touchStart', [[180, 420]]);
  await touch('touchMove', [[220, 420]]);
  await page.waitForTimeout(120); // Release without momentum, isolating glide cancellation.
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
  const panned = await page.locator('#readout').textContent();
  await page.waitForTimeout(2800);
  assert.equal(await page.locator('#readout').textContent(), panned);
  assert.equal(await page.locator('#map').evaluate((el) => el.classList.contains('dragging')), false);
  await painted(page); await screenshot(page, 'mobile-after-pinch');
});

test('late season atlases cannot replace the selected summer rendering', { timeout: 45000 }, async (t) => {
  const { page, ready } = await openMap(t, {}, '#13/55.49043/22.18627');
  await page.addInitScript(() => {
    const decode = window.createImageBitmap;
    window.decodedAtlases = 0;
    window.createImageBitmap = async (...args) => {
      const bitmap = await decode(...args);
      if (args[0] instanceof Blob && args[0].type === 'image/webp') window.decodedAtlases++;
      return bitmap;
    };
  });
  const held = new Map(['winter', 'night'].map((season) => {
    let ready;
    const requested = new Promise((resolve) => { ready = resolve; });
    return [season, { routes: [], requested, ready }];
  }));
  const atlas = JSON.parse(await readFile(resolve(root, 'tiles/atlas.json'), 'utf8'));
  const levelCount = Object.keys(atlas.levels).length;
  await page.route('**/tiles/*.webp', async (route) => {
    const season = new URL(route.request().url()).pathname.split('/').pop().split('-')[0];
    const gate = held.get(season);
    if (!gate) { await route.continue(); return; }
    gate.routes.push(route);
    if (gate.routes.length === levelCount) gate.ready();
  });
  await ready();
  await page.waitForFunction((count) => window.decodedAtlases === count, levelCount);
  const summer = await canvasImage(page);
  await page.getByRole('radio', { name: 'Winter' }).click();
  await held.get('winter').requested;
  await page.getByRole('radio', { name: 'Night' }).click();
  await held.get('night').requested;
  await page.getByRole('radio', { name: 'Summer' }).click();
  await page.waitForFunction((count) => window.decodedAtlases === count, levelCount);
  await page.waitForFunction((expected) => document.querySelector('#map').toDataURL() === expected, summer);
  let decoded = levelCount;
  for (const season of ['night', 'winter']) {
    await Promise.all(held.get(season).routes.map((route) => route.continue()));
    decoded += levelCount;
    await page.waitForFunction((count) => window.decodedAtlases === count, decoded);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await canvasImage(page), summer, `late ${season} atlas must not repaint summer`);
  }
  assert.equal(await page.locator('body').getAttribute('data-season'), 'summer');
  assert.equal(await page.getByRole('radio', { name: 'Summer' }).getAttribute('aria-checked'), 'true');
  for (const season of ['Winter', 'Night', 'Summer']) {
    await page.getByRole('radio', { name: season, exact: true }).click();
    if (season === 'Summer') await page.waitForFunction((expected) => document.querySelector('#map').toDataURL() === expected, summer);
    else await page.waitForFunction((expected) => document.querySelector('#map').toDataURL() !== expected, summer);
  }
  assert.equal(await page.evaluate(() => window.decodedAtlases), levelCount * 3, 'retained seasonal overviews must not be decoded again');
});

for (const mobile of [false, true]) {
  test(`first and repeated Winter to Night switches reuse visible tiles on ${mobile ? 'mobile' : 'desktop'}`, { timeout: 60000 }, async (t) => {
    const { page, ready } = await openMap(t, {
      reducedMotion: 'reduce', viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 },
      isMobile: mobile, hasTouch: mobile,
    });
    await observeSeasonCache(page);
    await ready();
    await page.waitForFunction(() => { const state = window.seasonCache.snapshot(); return state.exact && !state.dirty; });
    const images = { Summer: await canvasImage(page) };
    for (const name of ['Winter', 'Night', 'Winter', 'Night', 'Summer']) {
      const before = await page.evaluate(() => window.seasonCache.snapshot());
      await page.getByRole('radio', { name, exact: true }).click();
      await page.waitForFunction((season) => {
        const state = window.seasonCache.snapshot();
        return state.season === season && state.exact && !state.dirty;
      }, name.toLowerCase());
      const after = await page.evaluate(() => window.seasonCache.snapshot());
      assert.ok(after.keys.length > 0);
      assert.deepEqual(after.paints.slice(before.paints.length).filter((key) => after.keys.includes(key)), [], 'a prepared season must paint no visible tile again');
      const image = await canvasImage(page);
      if (images[name]) assert.equal(image, images[name], 'revisiting a season must reproduce its own pixels');
      else {
        assert.ok(Object.values(images).every((previous) => previous !== image), 'a season switch must change actual map pixels');
        images[name] = image;
      }
    }
    await screenshot(page, mobile ? 'mobile-cached-seasons' : 'desktop-cached-seasons');
  });
}

test('a saved tile is read again after same-session memory eviction without repainting', { timeout: 45000 }, async (t) => {
  const { page, ready } = await openMap(t, { reducedMotion: 'reduce' });
  await observeSeasonCache(page);
  await ready();
  const state = await page.evaluate(() => window.seasonCache.snapshot());
  const key = state.keys[0];
  assert.ok(key.startsWith('summer/0/'), 'the check must use live detail, not a bundled overview');
  await page.waitForFunction(async (key) => (await window.seasonCache.saved(key)) instanceof Blob && window.seasonCache.miss(key) === undefined, key);
  await page.waitForFunction(() => !window.seasonCache.snapshot().dirty);
  const image = await canvasImage(page);
  const requests = await page.evaluate((key) => {
    window.withholdPaint = true;
    const count = window.tilePaintRequests.filter((paint) => paint === key).length;
    window.seasonCache.evict(key);
    return count;
  }, key);
  await page.waitForFunction((key) => window.seasonCache.has(key) && !window.seasonCache.snapshot().dirty, key);
  assert.equal(await page.evaluate((key) => window.tilePaintRequests.filter((paint) => paint === key).length, key), requests, 'the saved tile must not be sent to a painter after eviction');
  assert.equal(await canvasImage(page), image, 'restored storage pixels must match the original tile');
});

test('reload paints a known saved tile while worker regeneration is withheld', { timeout: 45000 }, async (t) => {
  const { page, ready } = await openMap(t, {}, '#17/55.49043/22.18627');
  await page.route('**/tiles/atlas.json', (route) => route.fulfill({ status: 404, body: '' }));
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    window.withheldTiles = 0;
    Worker.prototype.postMessage = function (message, ...args) {
      if (sessionStorage.getItem('withhold-tiles') && message.type === 'tile') {
        window.withheldTiles++;
        return;
      }
      return post.call(this, message, ...args);
    };
  });
  await ready(); await painted(page);
  const { meta } = JSON.parse(await readFile(resolve(root, 'data/silale.json'), 'utf8'));
  const key = await page.evaluate((meta) => {
    const { ISO, latLonToWorld, isoX, isoY } = window.SIL;
    const [e, n] = latLonToWorld(meta, 55.49043, 22.18627);
    const span = ISO.TILE * ISO.A0 * 4;
    return `summer/2/${Math.floor(isoX(e, n) / span)}/${Math.floor(isoY(e, n, 0) / span)}`;
  }, meta);
  await page.waitForFunction((key) => new Promise((resolveTile, rejectTile) => {
    const request = indexedDB.open('isometric-silale', 1);
    request.onerror = () => rejectTile(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tile = db.transaction('tiles').objectStore('tiles').get(key);
      tile.onsuccess = () => { db.close(); resolveTile(tile.result instanceof Blob); };
      tile.onerror = () => { db.close(); rejectTile(tile.error); };
    };
  }), key);
  await page.evaluate(async (key) => {
    const marker = new OffscreenCanvas(256, 256);
    const ctx = marker.getContext('2d');
    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 256, 256);
    const blob = await marker.convertToBlob();
    await new Promise((done, reject) => {
      const request = indexedDB.open('isometric-silale', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('tiles', 'readwrite');
        const tiles = tx.objectStore('tiles');
        tiles.clear();
        tiles.put(window.SIL.VERSION, '__version');
        tiles.put(blob, key);
        tx.oncomplete = () => { db.close(); done(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    sessionStorage.setItem('withhold-tiles', '1');
  }, key);
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#map');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255 && data[i + 3] === 255) magenta++;
    }
    return magenta > 100 && window.withheldTiles > 0;
  });
  assert.equal(await page.locator('body').getAttribute('data-season'), 'summer');
  await screenshot(page, 'reloaded-summer');
});

test('missing atlas uses live workers and leaves the map usable', { timeout: 45000 }, async (t) => {
  const { page, ready } = await openMap(t, { reducedMotion: 'reduce' }, '#14/55.49043/22.18627');
  let workers = 0;
  page.on('worker', () => workers++);
  await page.route('**/tiles/atlas.json', (route) => route.fulfill({ status: 404, body: '' }));
  await ready(); await painted(page);
  assert.ok(workers > 0, 'fallback must use real tile workers');
  await page.locator('#zin').click();
  await page.waitForTimeout(100);
  assert.ok(await zoom(page) > 14);
  await screenshot(page, 'live-worker-fallback');
});

for (const mobile of [false, true]) {
  test(`search and share preserve view and note on ${mobile ? 'mobile' : 'desktop'}`, { timeout: 45000 }, async (t) => {
    const { page, ready } = await openMap(t, {
      reducedMotion: 'reduce', viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 },
      isMobile: mobile, hasTouch: mobile,
    }, '#17/55.49043/22.18627');
    await ready();
    await page.locator('#q').fill('55.49408, 22.18031');
    await page.locator('#q').press('Enter');
    await page.waitForFunction(() => document.querySelector('#readout').textContent.startsWith('55.49408'));
    await page.locator('#share-btn').click();
    await page.locator('#share-note').fill('Zoom check & Šilalė');
    const url = await page.locator('#share-link').inputValue();
    assert.ok(url.includes('/55.49408/22.18031/'));
    assert.ok(url.endsWith(encodeURIComponent('Zoom check & Šilalė')));
    await page.goto(url);
    await page.locator('#loader').waitFor({ state: 'hidden', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#note-text').textContent === 'Zoom check & Šilalė');
    assert.equal(await page.locator('#note-text').textContent(), 'Zoom check & Šilalė');
    assert.match(await page.locator('#readout').textContent(), /^55\.49408.*22\.18031/);
    await painted(page); await screenshot(page, mobile ? 'mobile-search-share' : 'desktop-search-share');
  });
}
