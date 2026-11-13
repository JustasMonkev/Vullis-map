'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({
  self: {},
  OffscreenCanvas: class { getContext() { return {}; } },
});
context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'js/worker.js'), 'utf8'), context);
const S = context.self.SIL;
const town = JSON.parse(fs.readFileSync(path.join(root, 'data/silale.json'), 'utf8'));

function trees(areas, mapped = []) {
  context.inputAreas = areas;
  context.inputTrees = mapped;
  return vm.runInContext(`
    D = { treeRows: [], trees: inputTrees };
    bounds = [-200, -200, 200, 200];
    AREAS = inputAreas.map((a) => ({ ...a, bb: bboxOf(a.r[0]) }));
    CANOPY = prepareCanopy({ crs: 'EPSG:4326', width: 160, height: 160,
      transform: [-80, 1, 0, 80, 0, -1], encoding: 'rle-count-value', data: [25600, 10] },
      { lon0: 0, lat0: 0, mLon: 1, mLat: 1 });
    occupancy = () => () => 0;
    makeTrees();
    Array.from(TR.e, (e, i) => ({ e, n: TR.n_[i], forest: TR.f[i] }));
  `, context);
}

const outer = [-80, -80, 80, -80, 80, 80, -80, 80];
const hole = [-31, -31, 31, -31, 31, 31, -31, 31];
const forest = { k: 'forest', r: [outer, hole] };

test('jittered forest trees stay inside their outer polygon', () => {
  const result = trees([forest]).filter((t) => t.forest);
  assert.ok(result.length > 100);
  assert.ok(result.every((t) => S.pointInRing(t.e, t.n, outer)), 'forest escaped outer boundary');
});

test('jittered forest trees stay outside polygon holes', () => {
  const result = trees([forest]).filter((t) => t.forest);
  assert.ok(result.length > 100);
  assert.ok(result.every((t) => !S.pointInRing(t.e, t.n, hole)), 'forest filled polygon hole');
});

test('overlapping mapped polygons do not duplicate inferred trees', () => {
  const once = trees([forest]);
  const twice = trees([forest, forest]);
  assert.equal(twice.length, once.length);
  assert.equal(new Set(twice.map((t) => `${t.e}:${t.n}`)).size, twice.length);
});

test('mapped trees survive a collision with an inferred location', () => {
  const inferred = trees([forest]).find((t) => t.forest);
  const result = trees([forest], [[inferred.e, inferred.n]]);
  const atMappedLocation = result.filter((t) => t.e === inferred.e && t.n === inferred.n);
  assert.equal(atMappedLocation.length, 1);
  assert.equal(atMappedLocation[0].forest, 0);
});

test('irregular real footprints retain their outline instead of a rectangular solid', () => {
  for (const id of ['402623712', '405844220']) {
    const raw = town.buildings.find((b) => b.id === id);
    const prepared = S.prepBuilding(raw, 0);
    assert.equal(prepared.kind, 'flat', id);
    assert.deepEqual(prepared.r, raw.r);
    assert.equal(prepared.h, raw.h);
  }
});

test('rectangular pitched homes and explicit church models retain their roof styles', () => {
  const rectangle = { r: [0, 0, 20, 0, 20, 10, 0, 10], h: 5.6, roof: 'gable', m: 'house' };
  assert.equal(S.prepBuilding(rectangle, 0).kind, 'gable');
  assert.ok(S.prepBuilding(rectangle, 0).rise > 0);
  for (const raw of town.buildings.filter((b) => b.roof === 'church')) {
    assert.equal(S.prepBuilding(raw, 0).kind, 'church');
    assert.ok(S.prepBuilding(raw, 0).tower);
  }
});

test('mapped footprints fill at least 95 percent of each inferred pitched solid', () => {
  for (let i = 0; i < town.buildings.length; i++) {
    const prepared = S.prepBuilding(town.buildings[i], i);
    if (prepared.kind !== 'gable' && prepared.kind !== 'hip') continue;
    assert.ok(prepared.area / (prepared.box.l * prepared.box.w) >= 0.95, town.buildings[i].id);
  }
});
