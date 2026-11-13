#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { resolve, extname } = require('node:path');
const { chromium } = require('playwright');

const root = resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--baseline' || !/^[a-f0-9]{40}$/.test(args[1]))) {
  throw new Error('Usage: npm run benchmark [-- --baseline <40-character commit SHA>]');
}
const baseline = args[1];
const samples = 3;
const timeout = 90000;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp' };
const seam = '  boot().catch((err) => {';
const probe = `
  let measured = null;
  const drawForBenchmark = drawTileImage;
  drawTileImage = (...args) => {
    drawForBenchmark(...args);
    if (measured && season === measured.season && frameNo > measured.frame && measured.firstPaintMs === null)
      measured.firstPaintMs = performance.now() - measured.start;
  };
  window.mapBenchmark = {
    begin(action, value) {
      measured = { action, season: action === 'season' ? value : season, start: performance.now(), frame: frameNo, firstPaintMs: null, requests: window.benchmarkRequests.length };
      if (action === 'season') setSeason(value);
      else if (action === 'zoom') zoomAt(W / 2, H / 2, value / view.s);
    },
    sample() {
      if (!isoBounds) return null;
      const L = levelFor(view.s), R = tileRange(L), keys = [];
      if (!R.empty) for (let ty = R.ty0; ty <= R.ty1; ty++) for (let tx = R.tx0; tx <= R.tx1; tx++) keys.push(tileKey(L, tx, ty));
      const exact = keys.length > 0 && keys.every(key => cache.has(key));
      if (!measured) return { exact, liveTiles: [...cache].filter(([key, value]) => isLive(key, value)).length };
      if (measured.firstPaintMs === null || season !== measured.season || !exact || frameNo <= measured.frame || dirty) return null;
      return {
        firstPaintMs: measured.firstPaintMs, exactViewMs: performance.now() - measured.start,
        paintRequests: window.benchmarkRequests.length - measured.requests,
        visiblePaintRequests: window.benchmarkRequests.slice(measured.requests).filter(key => keys.includes(key)).length,
        visibleTiles: keys.length, liveTiles: [...cache].filter(([key, value]) => isLive(key, value)).length,
        decodedTiles: cache.size, pendingTiles: pending.size,
      };
    },
  };
`;

async function main() {
  const current = await readFile(resolve(root, 'js/app.js'), 'utf8');
  const variants = baseline ? [
    { name: 'baseline', commit: baseline, source: execFileSync('git', ['show', baseline + ':js/app.js'], { cwd: root, encoding: 'utf8' }) },
    { name: 'candidate', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), source: current },
  ] : [{ name: 'candidate', source: current }];
  for (const variant of variants) assert.ok(variant.source.includes(seam), 'benchmark boot seam exists in ' + variant.name);
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser;
  const rows = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
    for (const mobile of [false, true]) for (let sample = 1; sample <= samples; sample++) for (const variant of variants) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: mobile ? 4 : 1 });
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
        await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript', body: variant.source.replace(seam, probe + seam) }));
        await page.addInitScript(({ mobile }) => {
          localStorage.setItem('silale-hint', '1');
          Object.defineProperty(navigator, 'deviceMemory', { get: () => mobile ? 4 : 8 });
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => mobile ? 4 : 8 });
          const post = Worker.prototype.postMessage;
          window.benchmarkRequests = [];
          Worker.prototype.postMessage = function (message, ...args) {
            if (message.type === 'tile') window.benchmarkRequests.push(message.key);
            return post.call(this, message, ...args);
          };
        }, { mobile });
        await page.goto(`http://127.0.0.1:${server.address().port}/#19/55.49043/22.18627`);
        await page.locator('#loader').waitFor({ state: 'hidden', timeout });
        await page.waitForFunction(() => window.mapBenchmark?.sample()?.exact, null, { timeout });
        const startup = await page.evaluate(() => ({ coldLoadMs: performance.now(), paintRequests: window.benchmarkRequests.length, ...window.mapBenchmark.sample() }));
        const actions = [];
        for (const [action, value] of [['season', 'winter'], ['season', 'night'], ['season', 'winter'], ['season', 'night'], ['zoom', 0.625], ['zoom', 2.5], ['zoom', 12], ['zoom', 0.625]]) {
          await page.evaluate(({ action, value }) => window.mapBenchmark.begin(action, value), { action, value });
          await page.waitForFunction(() => window.mapBenchmark.sample(), null, { timeout });
          actions.push({ action, value, ...await page.evaluate(() => window.mapBenchmark.sample()) });
        }
        assert.deepEqual(errors, [], 'benchmark browser exceptions');
        rows.push({ variant: variant.name, device: mobile ? 'mobile' : 'desktop', sample, startup, actions });
        console.log(JSON.stringify({ variant: variant.name, device: mobile ? 'mobile' : 'desktop', sample, coldLoadMs: Math.round(startup.coldLoadMs), winterToNightMs: Math.round(actions[1].exactViewMs), repeatWinterToNightMs: Math.round(actions[3].exactViewMs) }));
      } finally { await context.close(); }
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summary = [];
    for (const device of ['desktop', 'mobile']) for (const variant of variants) {
      const selected = rows.filter(row => row.device === device && row.variant === variant.name);
      summary.push({ variant: variant.name, device,
        coldLoadMs: median(selected.map(row => row.startup.coldLoadMs)),
        actions: selected[0].actions.map((action, index) => ({ action: action.action, value: action.value,
          firstPaintMs: median(selected.map(row => row.actions[index].firstPaintMs)),
          exactViewMs: median(selected.map(row => row.actions[index].exactViewMs)),
          paintRequests: median(selected.map(row => row.actions[index].paintRequests)),
          visiblePaintRequests: median(selected.map(row => row.actions[index].visiblePaintRequests)),
          liveTiles: median(selected.map(row => row.actions[index].liveTiles)),
        })),
      });
    }
    const output = { samples, browser: await browser.version(), baseline: baseline || null,
      conditions: { desktop: '1280x900, 1x CPU, 8 GB memory hint, 4 workers', mobile: '390x844 touch emulation, 4x main-thread CPU throttling, 4 GB memory hint, 3 workers', network: 'localhost, unthrottled; each sample starts in a fresh browser context', scope: 'Baseline and candidate viewer source use identical renderer/data/assets. First paint means a new current-season tile draw; exact view means all visible selected-level tiles cached and rendered.' },
      summary, rows,
    };
    const directory = process.env.TEST_ARTIFACTS || resolve(root, 'test-results');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'performance.json'), JSON.stringify(output, null, 2) + '\n');
    console.log('BENCHMARK_SUMMARY ' + JSON.stringify(summary));
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
