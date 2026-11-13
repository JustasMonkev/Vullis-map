const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { SIL } = require('../js/shared.js');
const atlas = require('../tiles/atlas.json');
const { meta } = require('../data/silale.json');

test('shipped overviews match the renderer version and cover every season and overview level', () => {
  assert.equal(atlas.version, SIL.VERSION, 'rebake tiles after changing the renderer');
  assert.equal(atlas.tile, SIL.ISO.TILE);
  for (let level = 3; level < SIL.ISO.LEVELS; level++) {
    const range = SIL.levelRange(SIL.isoBoundsOf(meta), level);
    assert.deepEqual(atlas.levels[level], {
      tx0: range.tx0, ty0: range.ty0,
      cols: range.tx1 - range.tx0 + 1, rows: range.ty1 - range.ty0 + 1,
    });
    for (const season of Object.keys(SIL.THEMES)) {
      const name = `${season}-L${level}.webp`;
      assert.equal(atlas.files[`${season}-L${level}`], name);
      const bytes = fs.readFileSync(path.join(__dirname, '..', 'tiles', name));
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      assert.ok(bytes.length > 100);
    }
  }
});
