const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { setImmediate } = require('node:timers/promises');

function viewer(loading = false, options = {}) {
  let now = 0;
  const frames = [], elements = new Map(), draws = [], workers = [], errors = [];
  const timers = new Map();
  let timerId = 0;
  const context = { setTransform() {}, clearRect: (...args) => draws.push(['clear', ...args]), drawImage: (...args) => draws.push(['draw', ...args]) };
  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      const classes = new Set();
      const captures = new Set();
      elements.set(id, {
        hidden: true, style: {}, dataset: {}, value: '', tagName: 'CANVAS',
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle() {}, contains: (name) => classes.has(name) },
        addEventListener: (name, fn) => listeners.set(name, fn),
        dispatch: (name, fields = {}) => listeners.get(name)?.({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 400, clientY: 300, preventDefault() {}, ...fields }),
        getContext: () => context, setPointerCapture: (pointerId) => captures.add(pointerId),
        hasPointerCapture: (pointerId) => captures.has(pointerId), releasePointerCapture: (pointerId) => captures.delete(pointerId),
      });
    }
    return elements.get(id);
  }
  const window = element('window');
  Object.assign(window, { innerWidth: options.width || 800, innerHeight: options.height || 600, devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
  const sandbox = {
    window, document: { getElementById: element, querySelectorAll: () => [], body: element('body'), addEventListener() {} },
    navigator: { deviceMemory: options.memory }, performance: { now: () => now }, console: { error: (...args) => errors.push(args) },
    Worker: class {
      constructor() { this.messages = []; workers.push(this); }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated = true; }
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    localStorage: { setItem() {} },
  };
  vm.createContext(sandbox);
  const root = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'js/shared.js'), 'utf8'), sandbox);
  window.SIL = sandbox.SIL;
  const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8').replace('  boot().catch((err) => {', `
  globalThis.camera = {
    view, cache, toIso, render, flyTo, zoomAt, startWorkers, pending,
    schedule, evict, waitForPreparedTiles, setSeason, cacheMax: CACHE_MAX,
    plan: () => ({ wanted: [...wanted], prepared: [...prepared] }),
    bounds(value) { isoBounds = value; },
    focus(value) { openingFocus = value; },
    atlas(levels, failures) { baked.meta = { levels }; for (const id of failures) baked.failed[id] = true; },
    want(keys) { wanted = keys; wantedSet = new Set(keys); pump(); },
    state: () => ({ anim, inertia, gesture, pointers: pointers.size, lastTap }),
    init(loading) {
      resize(); isoBounds = [-10000, -10000, 10000, 10000];
      META = loading ? null : { lat: 55.49, lon: 22.18 };
      bSeen = { stamp: 0 }; bGrid = { query: () => [] };
    },
  };
  if (false) boot().catch((err) => {`);
  vm.runInContext(source, sandbox);
  const api = sandbox.camera;
  api.init(loading);
  return {
    ...api, draws, workers, timers, errors, canvas: element('map'), element, window,
    tick(ms = 16) { now += ms; for (const fn of frames.splice(0)) fn(); },
    time(ms) { now += ms; },
    runTimers(ms = 120) {
      now += ms;
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    },
  };
}

function drag(v) {
  v.canvas.dispatch('pointerdown');
  v.time(16);
  v.canvas.dispatch('pointermove', { clientX: 500 });
}

test('rapid wheel, buttons and keys zoom out immediately, stop glides and keep the pointer anchor', () => {
  const v = viewer();
  Object.assign(v.view, { x: 20, y: 30, s: 4 });
  v.flyTo({ x: 1000, y: 1000, s: 6 });
  const anchor = v.toIso(470, 350);
  v.canvas.dispatch('wheel', { clientX: 470, clientY: 350, deltaY: 180, deltaMode: 0 });
  assert.deepEqual(v.toIso(470, 350), anchor);
  assert.equal(v.state().anim, null);
  const scale = v.view.s;
  for (let i = 0; i < 10; i++) v.element('zout').onclick();
  assert.equal(v.view.s, 0.06);
  v.tick(3000);
  assert.equal(v.view.s, 0.06);
  assert.ok(scale < 4);
  v.window.dispatch('keydown', { key: '+', target: {} });
  assert.ok(v.view.s > 0.06);
  v.window.dispatch('keydown', { key: '-', target: {} });
  assert.equal(v.view.s, 0.06);
});

test('Home replaces pan momentum with one camera animation', () => {
  const v = viewer();
  drag(v);
  v.canvas.dispatch('pointerup', { clientX: 500 });
  assert.ok(v.state().inertia);
  v.element('home').onclick();
  assert.equal(v.state().inertia, null);
  assert.ok(v.state().anim);
});

for (const [name, zoom, factor] of [
  ['wheel', (v) => v.canvas.dispatch('wheel', { deltaY: Math.log(2) / 0.0022, deltaMode: 0 }), 0.5],
  ['button', (v) => v.element('zout').onclick(), 1 / 1.8],
  ['key', (v) => v.window.dispatch('keydown', { key: '-', target: {} }), 1 / 1.6],
]) {
  test(`${name} zoom ends an active pinch so stale moves cannot restore its scale`, () => {
    const v = viewer();
    v.canvas.dispatch('pointerdown', { clientX: 200 });
    v.canvas.dispatch('pointerdown', { pointerId: 2, clientX: 600 });
    v.canvas.dispatch('pointermove', { clientX: 250 });
    const scale = v.view.s * factor;
    zoom(v);
    assert.equal(v.view.s, scale);
    v.canvas.dispatch('pointermove', { clientX: 250 });
    assert.equal(v.view.s, scale);
    assert.equal(v.state().gesture, null);
    assert.equal(v.state().pointers, 0);
    assert.equal(v.canvas.hasPointerCapture(1), false);
    assert.equal(v.canvas.hasPointerCapture(2), false);
    v.canvas.dispatch('pointerup');
    v.canvas.dispatch('pointerup', { pointerId: 2 });
    assert.equal(v.state().anim, null);
    v.canvas.dispatch('pointerdown', { pointerId: 3 });
    assert.equal(v.state().gesture.type, 'pan');
  });
}

test('remaining finger interrupts the quick two-finger zoom before panning', () => {
  const v = viewer();
  v.canvas.dispatch('pointerdown', { clientX: 300 });
  v.canvas.dispatch('pointerdown', { pointerId: 2, clientX: 500 });
  v.canvas.dispatch('pointerup', { pointerId: 2, clientX: 500 });
  assert.ok(v.state().anim);
  v.time(16);
  v.canvas.dispatch('pointermove', { clientX: 330 });
  assert.equal(v.state().anim, null);
  assert.equal(v.view.x, -150);
});

test('pinch zoom-out retains the midpoint anchor and hands off to a fresh pan', () => {
  const v = viewer();
  v.canvas.dispatch('pointerdown', { clientX: 200 });
  v.canvas.dispatch('pointerdown', { pointerId: 2, clientX: 600 });
  v.canvas.dispatch('pointermove', { clientX: 300 });
  v.canvas.dispatch('pointermove', { pointerId: 2, clientX: 500 });
  assert.equal(v.view.s, 0.1);
  assert.deepEqual(Array.from(v.toIso(400, 300)), [0, 0]);
  v.canvas.dispatch('pointerup', { pointerId: 2, clientX: 500 });
  assert.equal(v.state().anim, null);
  v.canvas.dispatch('pointermove', { clientX: 310 });
  assert.equal(v.view.x, -100);
});

for (const action of ['pointercancel', 'lostpointercapture', 'blur']) {
  test(`${action} clears a drag without momentum or tap actions`, () => {
    const v = viewer();
    drag(v);
    (action === 'blur' ? v.window : v.canvas).dispatch(action);
    assert.equal(v.state().inertia, null);
    assert.equal(v.state().gesture, null);
    assert.equal(v.state().pointers, 0);
    assert.equal(v.state().lastTap, null);
    v.canvas.dispatch('pointerdown', { pointerId: 3 });
    assert.equal(v.state().gesture.type, 'pan');
  });
}

test('cancelling a two-finger tap does not start a zoom', () => {
  const v = viewer();
  v.canvas.dispatch('pointerdown', { clientX: 300 });
  v.canvas.dispatch('pointerdown', { pointerId: 2, clientX: 500 });
  v.canvas.dispatch('pointercancel', { pointerId: 2 });
  assert.equal(v.state().anim, null);
  assert.equal(v.state().pointers, 0);
});

test('blur before map metadata arrives cannot queue an invalid hash update', () => {
  const v = viewer(true);
  v.window.dispatch('blur');
  assert.equal(v.timers.size, 0);
  drag(v);
  v.window.dispatch('blur');
  assert.equal(v.state().gesture, null);
  assert.equal(v.timers.size, 0);
});

test('transparent finer fallback tiles replace the old coarse geometry', () => {
  const v = viewer();
  Object.assign(v.view, { x: 100, y: 100, s: 0.4 });
  const coarse = { name: 'coarse' }, finer = { name: 'transparent-finer' };
  v.cache.set('summer/4/0/0', { bmp: coarse, used: 0 });
  v.cache.set('summer/2/0/0', { bmp: finer, used: 0 });
  v.render();
  const index = v.draws.findIndex(([kind, bitmap]) => kind === 'draw' && bitmap === finer);
  assert.ok(index > 0);
  const draw = v.draws[index];
  assert.deepEqual(v.draws[index - 1], ['clear', ...draw.slice(6)]);
});

test('repeated tile failures stop retrying and leave capacity for other tiles', () => {
  const v = viewer();
  v.startWorkers('data.json').catch(() => {});
  const key = 'summer/0/0/0';
  v.want([key]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const worker = v.pending.get(key);
    worker.onmessage({ data: { type: 'tile', key, bitmap: null } });
  }
  assert.equal(v.pending.has(key), false);
  assert.equal(v.workers.flatMap((worker) => worker.messages).filter((message) => message.key === key).length, 2);
  v.want([key, 'summer/0/1/0']);
  assert.equal(v.pending.has('summer/0/1/0'), true);
});

test('a crashed worker releases its pending tiles for the surviving workers', () => {
  const v = viewer();
  v.startWorkers('data.json').catch(() => {});
  const keys = ['summer/0/0/0', 'summer/0/1/0', 'summer/0/2/0', 'summer/0/3/0'];
  v.want(keys);
  const failed = v.pending.get(keys[0]);
  assert.equal(v.pending.get(keys[3]), failed);
  failed.onerror(new Error('worker crashed'));
  assert.equal(v.errors.length, 1);
  assert.equal(failed.terminated, true);
  assert.notEqual(v.pending.get(keys[0]), failed);
  assert.ok(v.pending.has(keys[0]));
  assert.notEqual(v.pending.get(keys[3]), failed);
  assert.ok(v.pending.has(keys[3]));
  const requestCount = failed.messages.length;
  v.want([...keys, 'summer/0/4/0']);
  assert.equal(failed.messages.length, requestCount);
});

test('detail preparation covers every zoom band before optional pan tiles', () => {
  const v = viewer();
  Object.assign(v.view, { x: 0, y: 0, s: 4 });
  v.schedule();
  const { wanted, prepared } = v.plan();
  assert.equal(new Set(wanted).size, wanted.length, 'each tile is requested once');
  const visible = ['summer/0/-1/-1', 'summer/0/0/-1', 'summer/0/-1/0', 'summer/0/0/0'];
  const firstOptional = wanted.findIndex((key) => /^summer\/[012]\//.test(key) && !visible.includes(key) && !/^summer\/1\/(-1|0)\/(-1|0)$/.test(key));
  assert.ok(visible.every((key) => wanted.indexOf(key) < firstOptional), 'current detail wins over speculative zoom work');
  for (let level = 0; level <= 2; level++) {
    for (let y = -2; y <= 1; y++) for (let x = -2; x <= 1; x++) {
      assert.ok(prepared.includes(`summer/${level}/${x}/${y}`), `the widest screenful at detail level ${level} must be prepared`);
    }
  }
  assert.ok(wanted.slice(prepared.length).every((key) => !prepared.includes(key)), 'the pan ring must not duplicate protected zoom tiles');
});

test('optional preparation obeys a low-memory budget and town edges', () => {
  const v = viewer(false, { width: 4096, height: 4096, memory: 1 });
  v.view.s = 0.06;
  v.schedule();
  const live = v.plan().wanted.filter((key) => +key.split('/')[1] < 5);
  assert.ok(live.length > 0, 'preparation must run on low-memory devices');
  assert.ok(live.length <= v.cacheMax - 4, 'zoom and pan work share one bounded live-tile budget');
  v.bounds([0, 0, 100, 100]);
  Object.assign(v.view, { x: 50, y: 50, s: 4 });
  v.schedule();
  assert.deepEqual(Array.from(v.plan().prepared.filter((key) => +key.split('/')[1] <= 2)).sort(), [
    'summer/0/0/0', 'summer/1/0/0', 'summer/2/0/0',
  ]);
});

test('prepared detail tiles survive eviction and repeated zoom changes', () => {
  const v = viewer();
  v.view.s = 0.625;
  v.schedule();
  const prepared = Array.from(v.plan().prepared).filter((key) => +key.split('/')[1] <= 2);
  let closed = 0;
  for (const key of prepared) v.cache.set(key, { bmp: { close() { throw new Error('prepared tile was discarded'); } }, used: -1 });
  for (let x = 100; x < 100 + v.cacheMax * 2; x++) v.cache.set(`summer/0/${x}/0`, { bmp: { close() { closed++; } }, used: -1 });
  for (const scale of [1.25, 2.5, 12, 0.625, 12, 1.25]) {
    v.view.s = scale;
    v.schedule();
    v.evict();
    assert.ok(prepared.every((key) => v.cache.has(key)), `prepared levels remain usable at scale ${scale}`);
  }
  assert.ok(closed > 0, 'stale live tiles must actually be evicted');
  assert.ok([...v.cache.keys()].filter((key) => +key.split('/')[1] < 5).length <= v.cacheMax);
});

test('startup waits for missing zoom detail and completes when preparation is cached', async () => {
  const v = viewer();
  v.view.s = 4;
  v.schedule();
  const prepared = Array.from(v.plan().prepared);
  const missing = prepared.find((key) => key.startsWith('summer/2/'));
  assert.ok(missing);
  for (const key of prepared) if (key !== missing) v.cache.set(key, { bmp: {}, used: 0 });
  let complete = false;
  const waiting = v.waitForPreparedTiles().then(() => { complete = true; });
  await setImmediate();
  assert.equal(complete, false, 'a painted initial screen is insufficient while another zoom band is missing');
  assert.ok(parseFloat(v.element('loadbar').style.width) < 100);
  v.cache.set(missing, { bmp: {}, used: 0 });
  v.runTimers();
  await waiting;
  assert.equal(complete, true);
  assert.equal(v.element('loadbar').style.width, '100%');
  assert.equal(v.timers.size, 0, 'successful preparation leaves no poll behind');
});

test('unavailable tiles cannot hold startup past its preparation deadline', async () => {
  const v = viewer();
  v.schedule();
  let complete = false;
  const waiting = v.waitForPreparedTiles().then(() => { complete = true; });
  v.runTimers(14999);
  await setImmediate();
  assert.equal(complete, false, 'startup should use the available preparation time');
  v.runTimers(1);
  await waiting;
  assert.equal(complete, true, 'stalled or repeatedly failed tiles must release the loader');
  assert.equal(v.timers.size, 0, 'deadline completion leaves no poll behind');
});

test('season changes replace protected zoom work and reject stale painted tiles', () => {
  const v = viewer();
  v.startWorkers('data.json').catch(() => {});
  v.view.s = 4;
  v.schedule();
  const oldKey = [...v.pending.keys()][0], worker = v.pending.get(oldKey);
  v.setSeason('winter');
  v.schedule();
  const { wanted, prepared } = v.plan();
  assert.ok(prepared.some((key) => key.startsWith('winter/2/')));
  assert.ok(wanted.every((key) => key.startsWith('winter/')));
  let closed = false;
  worker.onmessage({ data: { type: 'tile', key: oldKey, bitmap: { close() { closed = true; } } } });
  assert.equal(closed, true, 'late previous-season output must release its bitmap');
  assert.equal(v.cache.has(oldKey), false);
  assert.ok(v.plan().prepared.every((key) => key.startsWith('winter/')));
});

test('failed baked levels share the same live budget as zoom preparation', () => {
  const v = viewer(false, { width: 2048, height: 2048, memory: 1 });
  v.atlas({ 4: {} }, ['summer-L4']);
  v.view.s = 0.2;
  v.schedule();
  const live = v.plan().wanted.filter((key) => +key.split('/')[1] < 5);
  assert.ok(live.some((key) => key.startsWith('summer/4/')), 'failed overview tiles must be generated live');
  assert.ok(live.some((key) => key.startsWith('summer/0/')), 'remaining capacity should still prepare detail');
  assert.ok(live.length <= v.cacheMax - 4, 'failed atlas fallback cannot hide its memory use from the budget');
});

test('the opening move prepares the landing point as well as the initial view', () => {
  const v = viewer();
  Object.assign(v.view, { x: 1200, y: 500, s: 0.1 });
  v.focus({ x: 0, y: 0 });
  v.schedule();
  for (let level = 0; level <= 2; level++) {
    for (let y = -2; y <= 1; y++) for (let x = -2; x <= 1; x++) {
      assert.ok(v.plan().prepared.includes(`summer/${level}/${x}/${y}`), `landing detail level ${level} must be ready before the automatic glide`);
    }
  }
  v.focus(null);
  v.schedule();
  assert.equal(v.plan().prepared.includes('summer/0/0/0'), false, 'finished startup must not keep warming an abandoned opening target');
});
