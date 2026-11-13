import importlib.util
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_data', ROOT / 'tools/build_data.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildDataTests(unittest.TestCase):
    def test_open_chains_are_not_polygons(self):
        self.assertEqual(build.stitch([[1, 2, 3, 4], [7, 8]]), [])
        self.assertEqual(build.stitch([[1, 2, 3], [1, 4, 3]]), [[1, 2, 3, 4, 1]])

    def test_osm_lengths_accept_only_finite_metric_measurements(self):
        for value, expected in [('4', 4), ('3.5 m', 3.5), ('0', 0)]:
            self.assertEqual(build.metres(value), expected)
        for value in [None, '', '-1', 'nan', 'inf', '3;4', '4,2', '12 ft']:
            self.assertIsNone(build.metres(value))

    def test_invalid_building_levels_do_not_make_nonfinite_geometry(self):
        ring = [(0, 0), (20, 0), (20, 10), (0, 10)]
        for levels in ['nan', 'inf', '-1', '0', '1;2', '2 m']:
            with self.subTest(levels=levels):
                actual = build.building_profile({'building:levels': levels}, ring, (10, 5))
                self.assertEqual(actual, build.building_profile({}, ring, (10, 5)))

    def test_enrichment_preserves_order_and_coordinates(self):
        old = {'meta': {'attribution': 'OSM'}, 'roads': [{'p': [0, 0, 5, 5], 'c': 'path'}, {'p': [1, 1, 2, 2], 'c': 'service'}], 'areas': []}
        new = {'meta': {'sources': [{'sha256': 'abc'}]}, 'roads': [{'p': [1, 1, 2, 2], 'c': 'service', 's': 'paving_stones'}, {'p': [0, 0, 5, 5], 'c': 'path', 'w': 4}], 'areas': []}
        result = build.enrich_existing(old, new, [])
        self.assertEqual([r['p'] for r in result['roads']], [r['p'] for r in old['roads']])
        self.assertEqual(result['roads'][0]['w'], 4)
        self.assertEqual(result['roads'][1]['s'], 'paving_stones')
        self.assertEqual(result['meta']['attribution'], 'OSM')
        self.assertEqual(result['meta']['sources'], new['meta']['sources'])
        with self.assertRaises(ValueError):
            build.enrich_existing(old, {**new, 'roads': []}, [])

    def test_repair_requires_exact_source_vertices(self):
        old_area = {'k': 'forest', 'r': [[0, 0, 10, 0, 10, 10]]}
        repaired = {'k': 'forest', 'r': [[0, 0, 10, 0, 10, 10, 0, 10]]}
        old = {'meta': {}, 'areas': [old_area]}
        new = {'meta': {'sources': []}, 'areas': [repaired]}
        source = {(0, 0), (10, 0), (10, 10), (0, 10)}
        self.assertEqual(build.enrich_existing(old, new, [(repaired, source)])['areas'], [repaired])
        with self.assertRaises(ValueError):
            build.enrich_existing(old, new, [(repaired, {(0, 0), (10, 0)})])

    def test_enrichment_does_not_replace_legacy_building_estimates(self):
        building = {'id': '1', 'r': [0, 0, 1, 0, 1, 1], 'h': 7, 'roof': 'flat', 'm': 'brick'}
        old = {'meta': {}, 'areas': [], 'buildings': [building]}
        fresh = {**building, 'h': 12, 'roof': 'gable', 'levels': 2}
        new = {'meta': {'sources': []}, 'areas': [], 'buildings': [fresh]}
        self.assertEqual(build.enrich_existing(old, new, [])['buildings'][0], {**building, 'levels': 2})
        fresh['r'] = [0, 0, 2, 0, 2, 2]
        with self.assertRaises(ValueError):
            build.enrich_existing(old, new, [])

    def test_source_tags_reach_generated_contract(self):
        xml = '''<osm version="0.6"><bounds minlat="55.49" minlon="22.18" maxlat="55.50" maxlon="22.20"/>
        <node id="1" lat="55.4904" lon="22.1862"/><node id="2" lat="55.4904" lon="22.1864"/><node id="3" lat="55.4906" lon="22.1864"/><node id="4" lat="55.4906" lon="22.1862"/>
        <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="width" v="4 m"/><tag k="lanes" v="1"/><tag k="surface" v="paving_stones"/><tag k="bridge" v="viaduct"/></way>
        <way id="11"><nd ref="2"/><nd ref="3"/><tag k="waterway" v="stream"/><tag k="tunnel" v="culvert"/><tag k="layer" v="-1"/></way>
        <way id="12"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/><tag k="height" v="12 m"/><tag k="roof:height" v="0"/></way></osm>'''
        with tempfile.TemporaryDirectory() as directory:
            cache = pathlib.Path(directory)
            (cache / 'test.osm').write_text(xml)
            output = cache / 'out.json'
            subprocess.run([sys.executable, str(ROOT / 'tools/build_data.py'), str(cache), '--out', str(output)], check=True, capture_output=True)
            data = json.loads(output.read_text())
        road = data['roads'][0]
        self.assertEqual((road['s'], road['lanes'], road['w'], road['br']), ('paving_stones', 1, 4, 1))
        self.assertEqual(data['waterways'][0]['covered'], 1)
        self.assertEqual(data['buildings'][0]['height'], 12)
        self.assertEqual(data['buildings'][0]['rh'], 0)
        source = data['meta']['sources'][0]
        self.assertEqual(source['bbox'], [22.18, 55.49, 22.20, 55.50])
        self.assertEqual(len(source['sha256']), 64)
        self.assertEqual(source['sha256'], hashlib.sha256(xml.encode()).hexdigest())
        self.assertIn('retrievedAt', source)

    def test_real_town_has_factual_surface_and_culvert_tags(self):
        data = json.loads((ROOT / 'data/silale.json').read_text())
        self.assertEqual(sum(r.get('s') == 'paving_stones' for r in data['roads']), 56)
        self.assertEqual(sum('lanes' in r for r in data['roads']), 71)
        self.assertEqual(sum(r.get('covered') == 1 for r in data['waterways']), 29)
        self.assertEqual([r['w'] for r in data['roads'] if 'w' in r], [4])
        self.assertFalse(any('height' in b or 'rh' in b for b in data['buildings']))
        self.assertEqual(len(data['buildings']), 3362)
        self.assertEqual(data['meta']['bounds'], [-2450, -1750, 2450, 2100])
        self.assertIn('OpenStreetMap', data['meta']['attribution'])
        self.assertEqual(len(data['meta']['sources']), 3)

    def test_real_osm_excerpt_preserves_measured_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'out.json'
            subprocess.run([sys.executable, str(ROOT / 'tools/build_data.py'), str(ROOT / 'tests/fixtures'), '--out', str(output)], check=True, capture_output=True)
            data = json.loads(output.read_text())
        self.assertEqual(len(data['roads']), 3)
        self.assertEqual(sorted(r.get('s', '') for r in data['roads']), ['', 'asphalt', 'paving_stones'])
        self.assertEqual([r['w'] for r in data['roads'] if 'w' in r], [4])
        self.assertEqual([r['lanes'] for r in data['roads'] if 'lanes' in r], [3])
        # Rounded local-metre endpoints of source ways 212760644, 294504775,
        # and 403173579. Keep each tag bundle attached to its actual geometry.
        expected = [
            ((-317.3, 227.5, 87.2, 160.7), ('path', 'paving_stones', None, None)),
            ((125.8, -100.5, 207.1, -136.9), ('secondary', 'asphalt', None, 3)),
            ((-48.8, 499.1, -206.4, 425.7), ('residential', None, 4, None)),
        ]
        roads = {tuple(r['p'][:2] + r['p'][-2:]): r for r in data['roads']}
        self.assertEqual(set(roads), {endpoints for endpoints, _ in expected})
        for endpoints, attributes in expected:
            road = roads[endpoints]
            self.assertEqual(tuple(road.get(key) for key in ('c', 's', 'w', 'lanes')), attributes)
        self.assertEqual(data['waterways'][0]['covered'], 1)
        self.assertEqual(data['buildings'][0]['id'], '291605405')
        self.assertEqual(data['buildings'][0]['levels'], 1)


if __name__ == '__main__':
    unittest.main()
