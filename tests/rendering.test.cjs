'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'js/shared.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'js/worker.js'), 'utf8');

function workerContext(input = {}) {
  const context = vm.createContext({ self: {}, ...input, OffscreenCanvas: class { getContext() { return {}; } } });
  context.importScripts = () => vm.runInContext(shared, context);
  vm.runInContext(worker, context);
  return context;
}

function prepared(roads, waterways = []) {
  const context = workerContext({ roads, waterways });
  return JSON.parse(vm.runInContext(`
    D = { meta: { bounds: [-100, -100, 100, 100], lon0: 0, lat0: 0, mLon: 1, mLat: 1 },
      landcover: { crs: 'EPSG:4326', width: 1, height: 1, transform: [-100, 200, 0, 100, 0, -200], encoding: 'rle-count-value', data: [1, 30] },
      roads, waterways, buildings: [], areas: [], barriers: [] };
    makeTrees = () => { TR = { n: 0 }; };
    prepare();
    JSON.stringify({ roads: ROADS, waterways: WATERWAYS, lamps: LAMPS });
  `, context));
}

test('road widths use measurements, then lanes, then existing class defaults', () => {
  const p = [-50, 0, 50, 0];
  const result = prepared([
    { c: 'secondary', p, w: 4, lanes: 2, s: 'asphalt' },
    { c: 'secondary', p, lanes: 2 },
    { c: 'secondary', p },
    { c: 'footway', p, lanes: 2 },
    { c: 'footway', p, w: 3 },
    { c: 'residential', p, w: -1, lanes: 0 },
  ]);
  const road = (c, predicate) => result.roads.find((r) => r.c === c && predicate(r));
  assert.equal(road('secondary', (r) => r.s === 'asphalt').w, 4);
  assert.equal(road('secondary', (r) => r.widthSource === 'lanes').w, 6);
  assert.equal(road('secondary', (r) => r.widthSource === 'class').w, 8);
  assert.deepEqual(result.roads.filter((r) => r.c === 'footway').map((r) => r.w), [1.8, 3]);
  assert.equal(road('residential', () => true).w, 6);
  assert.ok(result.lamps.some((lamp) => lamp[1] === 2.8));
});

test('underground culverts are omitted while measured open water widths survive', () => {
  const p = [-50, 0, 50, 0];
  const result = prepared([], [{ c: 'stream', p, covered: 1 }, { c: 'stream', p, w: 5 }]);
  assert.equal(result.waterways.length, 1);
  assert.equal(result.waterways[0].w, 5);
});

test('canopy follows north-down source pixels, excluding non-tree classes, nodata and outside coverage', () => {
  const context = workerContext();
  const actual = JSON.parse(vm.runInContext(`
    const lc = { crs: 'EPSG:4326', width: 2, height: 2, nodata: 0,
      transform: [-10, 10, 0, 10, 0, -10], encoding: 'rle-count-value', data: [1, 10, 1, 40, 1, 0, 1, 10] };
    const canopy = prepareCanopy(lc, { lon0: 0, lat0: 0, mLon: 1, mLat: 1 });
    JSON.stringify({ cells: [[-5,5],[5,5],[-5,-5],[5,-5],[-11,5],[5,-11]].map(([e,n]) => canopy.at(e,n)), runs: canopy.runs });
  `, context));
  assert.deepEqual(actual.cells, [true, false, false, true, false, false]);
  assert.deepEqual(actual.runs, [[-10, 0, 0, 10], [0, -10, 10, 0]]);
  assert.throws(() => vm.runInContext(`prepareCanopy({ ...lc, width: 2000001, height: 1, data: [2000001, 10] }, {})`, context), /Invalid land-cover grid/);
  assert.throws(() => vm.runInContext(`prepareCanopy({ ...lc, data: [3, 10] }, {})`, context), /Incomplete land-cover grid/);
  assert.throws(() => vm.runInContext(`prepareCanopy({ ...lc, data: [5, 10] }, {})`, context), /Invalid land-cover run/);
});

test('inferred trees require source canopy while explicit mapped trees survive outside it', () => {
  const context = workerContext();
  const result = JSON.parse(vm.runInContext(`
    D = { trees: [[50, 0]], treeRows: [] };
    bounds = [-100, -100, 100, 100]; AREAS = [];
    CANOPY = prepareCanopy({ crs: 'EPSG:4326', width: 2, height: 1, nodata: 0,
      transform: [-100, 100, 0, 100, 0, -200], encoding: 'rle-count-value', data: [1, 10, 1, 40] },
      { lon0: 0, lat0: 0, mLon: 1, mLat: 1 });
    occupancy = () => () => 0;
    makeTrees();
    JSON.stringify(Array.from(TR.e, (e, i) => ({ e, n: TR.n_[i], forest: TR.f[i] })));
  `, context));
  const inferred = result.filter((tree) => tree.forest);
  assert.ok(inferred.length > 500);
  assert.ok(inferred.every((tree) => tree.e < 0));
  assert.deepEqual(result.filter((tree) => !tree.forest), [{ e: 50, n: 0, forest: 0 }]);
});
