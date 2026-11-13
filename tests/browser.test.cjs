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
async function screenshot(page, name) {
  if (!artifacts) return;
  await require('node:fs/promises').mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, name + '.png') });
}

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
      window.decodedAtlases++;
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
  await page.waitForFunction((count) => window.decodedAtlases === count, levelCount * 2);
  await page.waitForFunction((expected) => document.querySelector('#map').toDataURL() === expected, summer);
  let decoded = levelCount * 2;
  for (const season of ['night', 'winter']) {
    await Promise.all(held.get(season).routes.map((route) => route.continue()));
    decoded += levelCount;
    await page.waitForFunction((count) => window.decodedAtlases === count, decoded);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await canvasImage(page), summer, `late ${season} atlas must not repaint summer`);
  }
  assert.equal(await page.locator('body').getAttribute('data-season'), 'summer');
  assert.equal(await page.getByRole('radio', { name: 'Summer' }).getAttribute('aria-checked'), 'true');
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
    assert.equal(await page.locator('#note-text').textContent(), 'Zoom check & Šilalė');
    assert.match(await page.locator('#readout').textContent(), /^55\.49408.*22\.18031/);
    await painted(page); await screenshot(page, mobile ? 'mobile-search-share' : 'desktop-search-share');
  });
}
