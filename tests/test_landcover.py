"""Offline regression checks for the shipped native WorldCover crop.

Run: python3 -m unittest discover -s tests -p 'test_landcover.py'
"""
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('landcover', ROOT / 'tools/build_landcover.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class LandcoverTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cover = json.loads((ROOT / 'data/landcover.json').read_text())
        cls.values = bytes(value for count, value in zip(cls.cover['data'][::2], cls.cover['data'][1::2])
                           for _ in range(count))

    def test_native_crop_round_trip_and_source_checksum(self):
        cover = self.cover
        self.assertEqual(cover['encoding'], 'rle-count-value')
        self.assertEqual(len(cover['data']) % 2, 0)
        self.assertTrue(all(count > 0 for count in cover['data'][::2]))
        self.assertEqual(len(self.values), cover['width'] * cover['height'])
        self.assertEqual(builder.encode(self.values), cover['data'])
        self.assertEqual(hashlib.sha256(self.values).hexdigest(), cover['source']['sha256'])
        self.assertEqual(dict(Counter(self.values)), {int(k): v for k, v in cover['counts'].items()})
        self.assertEqual(cover['nodata'], 0)
        self.assertNotIn(0, self.values)  # This particular crop has complete source coverage.

    def test_native_source_pixel_samples(self):
        # Independently queried with gdallocationinfo on the remote native tile.
        # Includes every class in this crop, to catch class remapping or row flips.
        x0, y0, _, _ = self.cover['source']['nativeWindow']
        for x, y, value in [(13783, 17888, 10), (13770, 17888, 30),
                            (13896, 17888, 40), (14222, 17888, 50),
                            (14229, 18057, 60), (14610, 17902, 80),
                            (14003, 17998, 90)]:
            self.assertEqual(self.values[(y - y0) * self.cover['width'] + x - x0], value)

    def test_map_corners_are_covered_with_native_pixel_alignment(self):
        cover = self.cover
        meta = json.loads((ROOT / 'data/silale.json').read_text())['meta']
        west, dx, rx, north, ry, dy = cover['transform']
        self.assertEqual(cover['crs'], 'EPSG:4326')
        self.assertEqual((rx, ry), (0, 0))
        self.assertAlmostEqual(dx, 1 / 12000, places=14)
        self.assertAlmostEqual(dy, -1 / 12000, places=14)
        for east in (meta['bounds'][0], meta['bounds'][2]):
            for n in (meta['bounds'][1], meta['bounds'][3]):
                x = math.floor((meta['lon0'] + east / meta['mLon'] - west) / dx)
                y = math.floor((meta['lat0'] + n / meta['mLat'] - north) / dy)
                self.assertTrue(0 <= x < cover['width'])
                self.assertTrue(0 <= y < cover['height'])
        x, y, width, height = cover['source']['nativeWindow']
        self.assertAlmostEqual(west, 21 + x * dx)
        self.assertAlmostEqual(north, 57 + y * dy)
        self.assertEqual((width, height), (cover['width'], cover['height']))

    def test_window_rounds_outward_and_rejects_missing_source_coverage(self):
        meta = {'lon0': 5, 'lat0': 5, 'mLon': 1, 'mLat': 1,
                'bounds': [-1.2, -1.2, 1.2, 1.2]}
        self.assertEqual(builder.native_window(meta, [0, 1, 0, 10, 0, -1], [10, 10]), [3, 3, 4, 4])
        meta['bounds'][0] = -6
        with self.assertRaisesRegex(ValueError, 'outside'):
            builder.native_window(meta, [0, 1, 0, 10, 0, -1], [10, 10])

    def test_no_data_is_preserved_in_run_encoding(self):
        self.assertEqual(builder.encode(bytes([0, 0, 10, 10, 10, 0])), [2, 0, 3, 10, 1, 0])
        self.assertEqual(builder.encode(b''), [])


if __name__ == '__main__':
    unittest.main()
