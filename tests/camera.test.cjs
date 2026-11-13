const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function viewer(loading = false) {
  let now = 0;
  const frames = [], elements = new Map(), draws = [], workers = [], errors = [];
  const timers = new Map();
  let timerId = 0;
  const context = { setTransform() {}, clearRect: (...args) => draws.push(['clear', ...args]), drawImage: (...args) => draws.push(['draw', ...args]) };
  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      const classes = new Set();
      elements.set(id, {
        hidden: true, style: {}, dataset: {}, value: '', tagName: 'CANVAS',
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle() {}, contains: (name) => classes.has(name) },
        addEventListener: (name, fn) => listeners.set(name, fn),
        dispatch: (name, fields = {}) => listeners.get(name)?.({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 400, clientY: 300, preventDefault() {}, ...fields }),
        getContext: () => context, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {},
      });
    }
    return elements.get(id);
  }
  const window = element('window');
  Object.assign(window, { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
  const sandbox = {
    window, document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    navigator: {}, performance: { now: () => now }, console: { error: (...args) => errors.push(args) },
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
  const keys = ['summer/0/0/0', 'summer/0/1/0', 'summer/0/2/0'];
  v.want(keys);
  const failed = v.pending.get(keys[0]);
  failed.onerror(new Error('worker crashed'));
  assert.equal(v.errors.length, 1);
  assert.equal(failed.terminated, true);
  assert.notEqual(v.pending.get(keys[0]), failed);
  assert.ok(v.pending.has(keys[0]));
});
