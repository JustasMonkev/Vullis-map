#!/usr/bin/env python3
"""Crop native ESA WorldCover pixels for this map; requires GDAL command-line tools.

python3 tools/build_landcover.py
Uses HTTP byte ranges, never downloads the full 80 MB source tile. No resampling.
"""
import argparse
from collections import Counter
from datetime import date
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ('https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'
          'ESA_WorldCover_10m_2021_v200_N54E021_Map.tif')
CLASSES = {0: 'unknown / no data', 10: 'tree cover', 20: 'shrubland',
           30: 'grassland', 40: 'cropland', 50: 'built-up',
           60: 'bare / sparse vegetation', 70: 'snow and ice',
           80: 'permanent water bodies', 90: 'herbaceous wetland',
           95: 'mangroves', 100: 'moss and lichen'}


def native_window(meta, transform, size):
    """Include every native source cell intersecting the local map bounds."""
    west, dx, rx, north, ry, dy = transform
    if rx != 0 or ry != 0 or dx <= 0 or dy >= 0:
        raise ValueError('Expected a north-up geographic source grid')
    e0, n0, e1, n1 = meta['bounds']
    x0 = math.floor((meta['lon0'] + e0 / meta['mLon'] - west) / dx)
    x1 = math.ceil((meta['lon0'] + e1 / meta['mLon'] - west) / dx)
    y0 = math.floor((meta['lat0'] + n1 / meta['mLat'] - north) / dy)
    y1 = math.ceil((meta['lat0'] + n0 / meta['mLat'] - north) / dy)
    if not (0 <= x0 < x1 <= size[0] and 0 <= y0 < y1 <= size[1]):
        raise ValueError('Map bounds fall outside the fixed WorldCover tile')
    if (x1 - x0) * (y1 - y0) > 2_000_000:
        raise ValueError('Map crop exceeds two million native pixels')
    return [x0, y0, x1 - x0, y1 - y0]


def encode(values):
    runs = []
    for value in values:
        if runs and runs[-1] == value:
            runs[-2] += 1
        else:
            runs.extend((1, value))
    return runs


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--map', type=Path, default=ROOT / 'data/silale.json')
    ap.add_argument('--out', type=Path, default=ROOT / 'data/landcover.json')
    args = ap.parse_args()
    meta = json.loads(args.map.read_text())['meta']
    # Reject a server that ignores Range before passing the COG to GDAL.
    request = urllib.request.Request(SOURCE, headers={'Range': 'bytes=0-16383'})
    with urllib.request.urlopen(request, timeout=40) as response:
        if response.status != 206 or not response.headers.get('Content-Range', '').startswith('bytes 0-16383/'):
            raise ValueError('Source must support bounded HTTP byte ranges')
        response.read(16384)
    remote = '/vsicurl/' + SOURCE
    env = dict(os.environ, GDAL_DISABLE_READDIR_ON_OPEN='TRUE',
               CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_TIMEOUT='40')
    info = json.loads(subprocess.check_output(['gdalinfo', '-json', remote], env=env, timeout=120))
    transform = info['geoTransform']
    window = native_window(meta, transform, info['size'])
    if info['bands'][0].get('noDataValue') != 0 or info['bands'][0]['type'] != 'Byte':
        raise ValueError('Unexpected WorldCover source type or no-data value')
    with tempfile.TemporaryDirectory(prefix='silale-landcover-') as temp:
        raw = Path(temp) / 'window.bin'
        subprocess.run(['gdal_translate', '-q', '-of', 'ENVI', '-ot', 'Byte',
                        '-srcwin', *map(str, window), remote, str(raw)], env=env, check=True, timeout=120)
        values = raw.read_bytes()
    x, y, width, height = window
    if len(values) != width * height or not set(values).issubset(CLASSES):
        raise ValueError('Invalid WorldCover native crop')
    result = {
        'crs': 'EPSG:4326', 'width': width, 'height': height,
        'transform': [transform[0] + x * transform[1], transform[1], 0,
                      transform[3] + y * transform[5], 0, transform[5]],
        'nodata': 0, 'encoding': 'rle-count-value', 'classes': CLASSES,
        'source': {
            'title': 'ESA WorldCover 10 m 2021 v200', 'url': SOURCE,
            'documentation': 'https://esa-worldcover.org/en/data-access',
            'doi': 'https://doi.org/10.5281/zenodo.7254221',
            'license': 'CC BY 4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
            'attribution': '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
            'referenceYear': 2021, 'accessed': date.today().isoformat(),
            'nativeWindow': window, 'nativeSize': info['size'],
            'sha256': hashlib.sha256(values).hexdigest(),
            'processing': 'Native pixel window, no resampling; lossless row-major run-length encoding.',
            'limitations': 'Categorical land cover, not measured canopy density, species, height or individual tree positions. Reference year 2021; small trees and changes since then may be absent.',
        },
        'counts': dict(sorted(Counter(values).items())), 'data': encode(values),
    }
    args.out.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'{width} × {height} native pixels; {args.out.stat().st_size:,} bytes; classes {result["counts"]}')


if __name__ == '__main__':
    main()
