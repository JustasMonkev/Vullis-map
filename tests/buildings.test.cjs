'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(root, 'js/shared.js'), 'utf8'), context);
const S = context.SIL;
const town = JSON.parse(fs.readFileSync(path.join(root, 'data/silale.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'data/landmarks.json'), 'utf8'));
const source = profiles.profiles[0].heightSource;
const rectangle = { id: '1', r: [0, 0, 20, 0, 20, 10, 0, 10], h: 5.6, roof: 'gable', m: 'house' };

test('published Catholic tower height includes its drawn cross and fits its bounds', () => {
  const raw = town.buildings.find((b) => b.id === '212787870');
  const data = { buildings: [{ ...raw }] };
  S.applyProfiles(data, profiles);
  const prepared = S.prepBuilding(data.buildings[0], 0);
  assert.equal(prepared.top, 60);
  assert.equal(prepared.tower.h + prepared.tower.spire + prepared.tower.cross, 60);
  assert.equal(prepared.heightSource.quality, 'approximate');
  assert.equal(prepared.heightSource.url, source.url);
  assert.deepEqual(prepared.r, raw.r);
  assert.ok(prepared.bbox[1] <= S.isoY(...prepared.tower.c, prepared.top));
});

test('explicit total height is not added to pitched roof rise and zero rise survives', () => {
  const roof = S.prepBuilding({ ...rectangle, height: 10, rh: 2 }, 0);
  assert.equal(roof.h, 8);
  assert.equal(roof.rise, 2);
  assert.equal(roof.top, 10);
  assert.equal(roof.heightSource.quality, 'osm');
  assert.equal(roof.heightSource.label, 'OSM height; geometry is schematic');
  assert.equal(S.prepBuilding({ ...rectangle, id: 'r42', height: 10 }, 0).heightSource.url, 'https://www.openstreetmap.org/relation/42');
  const flat = S.prepBuilding({ ...rectangle, height: 10, rh: 0 }, 0);
  assert.equal(flat.h, 10);
  assert.equal(flat.rise, 0);
  assert.equal(flat.top, 10);
  const short = S.prepBuilding({ ...rectangle, height: 1 }, 0);
  assert.ok(short.h > 0);
  assert.equal(short.top, 1);
});

test('invalid explicit heights use the existing inferred eave height', () => {
  for (const height of [0, -1, NaN, Infinity, '10']) {
    const prepared = S.prepBuilding({ ...rectangle, height }, 0);
    assert.equal(prepared.h, rectangle.h);
    assert.equal(prepared.top, rectangle.h + prepared.rise);
    assert.equal(prepared.heightSource.quality, 'inferred');
    assert.equal(prepared.heightSource.label, 'Estimated from footprint and building type');
  }
});

test('irregular sourced footprints retain the flat safeguard and total height', () => {
  const raw = town.buildings.find((b) => b.id === '402623712');
  const prepared = S.prepBuilding({ ...raw, height: 8, rh: 3 }, 0);
  assert.equal(prepared.kind, 'flat');
  assert.equal(prepared.h, 8);
  assert.equal(prepared.top, 8);
  assert.deepEqual(prepared.r, raw.r);
});

test('profile validation rejects unknown IDs, duplicate IDs and false source precision before mutation', () => {
  for (const invalid of [
    { profiles: [{ ...profiles.profiles[0], id: 'missing' }] },
    { profiles: [...profiles.profiles, ...profiles.profiles] },
    { profiles: [{ ...profiles.profiles[0], height: 0 }] },
    { profiles: [{ ...profiles.profiles[0], heightSource: { ...source, quality: 'measured' } }] },
    { profiles: [{ ...profiles.profiles[0], heightSource: { ...source, url: 'javascript:alert(1)' } }] },
    { profiles: [{ ...profiles.profiles[0], heightSource: { ...source, url: 'https://' } }] },
  ]) {
    const data = { buildings: [{ id: '212787870', h: 15 }] };
    assert.throws(() => S.applyProfiles(data, invalid), /landmark/);
    assert.equal(data.buildings[0].height, undefined);
  }
});

test('bundled loader waits for all source files and applies landmark profiles', async () => {
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(url);
    const data = url.endsWith('landmarks.json') ? profiles : url.endsWith('landcover.json') ? { areas: [] } : { buildings: [{ id: '212787870', h: 15 }] };
    return { ok: true, json: async () => data };
  };
  const result = await S.loadMapData('https://example.test/data/silale.json');
  assert.equal(result.buildings[0].height, 60);
  assert.ok(Array.isArray(result.landcover.areas));
  assert.deepEqual(fetched.sort(), ['https://example.test/data/landcover.json', 'https://example.test/data/landmarks.json', 'https://example.test/data/silale.json']);
  context.fetch = async (url) => ({ ok: !url.endsWith('landmarks.json'), status: 404, json: async () => ({ buildings: [] }) });
  await assert.rejects(S.loadMapData('https://example.test/data/silale.json'), /landmarks.json.*404/);
});
