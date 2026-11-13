import copy
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_data', ROOT / 'tools/build_data.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class EnrichmentReplayTests(unittest.TestCase):
    def test_removed_source_fields_clear_without_replacing_existing_records(self):
        building = {'id': '1', 'r': [0, 0, 2, 0, 2, 2], 'h': 7, 'roof': 'flat', 'm': 'brick', 'note': 'keep'}
        road = {'c': 'residential', 'p': [0, 0, 2, 2], 'note': 'keep'}
        water = {'c': 'stream', 'p': [0, 0, 1, 1], 'n': 'Mapped stream', 'note': 'keep'}
        stable = {'buildings': [building], 'roads': [road], 'waterways': [water]}
        stale = {'buildings': {'height': 12, 'rh': 3, 'levels': 3},
                 'roads': {'s': 'gravel', 'lanes': 2, 'w': 6, 'br': 1, 'u': 1},
                 'waterways': {'covered': 1, 'w': 3}}
        old = {'meta': {'attribution': 'OSM', 'sources': ['old']}, 'areas': []}
        fresh = {'meta': {'sources': ['fresh']}, 'areas': []}
        for section, records in stable.items():
            old[section] = [{**record, **stale[section]} for record in records]
            fresh[section] = copy.deepcopy(records)
        fresh['buildings'][0].update(h=99, roof='gable', m='metal')
        snapshot = copy.deepcopy(old)
        result = build.enrich_existing(old, fresh, [])
        for section, records in stable.items():
            with self.subTest(section=section):
                self.assertEqual(result[section], records)
        self.assertEqual(result['meta']['sources'], ['fresh'])
        self.assertEqual(old, snapshot)

    def test_fresh_source_zero_values_replace_stale_values_in_original_order(self):
        buildings = [{'id': str(i), 'r': [i, 0, i + 1, 0, i + 1, 1], 'h': 5, 'rh': 3} for i in (1, 2)]
        old = {'meta': {}, 'areas': [], 'buildings': buildings}
        fresh = {'meta': {'sources': []}, 'areas': [],
                 'buildings': [{**record, 'rh': 0, 'height': 8} for record in reversed(buildings)]}
        result = build.enrich_existing(old, fresh, [])
        self.assertEqual([record['id'] for record in result['buildings']], ['1', '2'])
        self.assertEqual([record['r'] for record in result['buildings']], [record['r'] for record in buildings])
        self.assertEqual([(record['h'], record['rh'], record['height']) for record in result['buildings']], [(5, 0, 8), (5, 0, 8)])


if __name__ == '__main__':
    unittest.main()
