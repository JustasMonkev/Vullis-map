#!/usr/bin/env python3
"""Build data/silale.json for Isometric Šilalė from OpenStreetMap.

Usage:
    python3 tools/build_data.py --download osm_cache/   # fetch raw OSM tiles first
    python3 tools/build_data.py osm_cache/              # convert cached tiles

Data © OpenStreetMap contributors, ODbL 1.0.
"""
import argparse, glob, json, math, os, re, subprocess, sys, hashlib
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

LAT0, LON0 = 55.4904281, 22.1862680          # Šilalė town node
M_LAT = 111333.0                              # metres per degree latitude here
M_LON = 111412.84 * math.cos(math.radians(LAT0)) - 93.5 * math.cos(math.radians(3 * LAT0))
# The diorama: a rectangle in local metres (east, north) around the centre.
E_MIN, E_MAX = -2450.0, 2450.0
N_MIN, N_MAX = -1750.0, 2100.0
DL_BBOX = (55.474, 55.510, 22.146, 22.226)


def proj(lat, lon):
    return ((lon - LON0) * M_LON, (lat - LAT0) * M_LAT)


def download(dest):
    os.makedirs(dest, exist_ok=True)
    lat0, lat1, lon0, lon1 = DL_BBOX
    n = 4
    for i in range(n):
        for j in range(n):
            a = lat0 + (lat1 - lat0) * i / n; b = lat0 + (lat1 - lat0) * (i + 1) / n
            c = lon0 + (lon1 - lon0) * j / n; d = lon0 + (lon1 - lon0) * (j + 1) / n
            url = f"https://api.openstreetmap.org/api/0.6/map?bbox={c:.5f},{a:.5f},{d:.5f},{b:.5f}"
            out = os.path.join(dest, f"t{i}{j}.osm")
            subprocess.run(["curl", "-sS", "-m", "120", "-A", "isometric-town-map/0.1", "-o", out, url], check=True)
            print("downloaded", out)


# ---------------------------------------------------------------- geometry
def area(r):
    s = 0.0
    for i in range(len(r)):
        x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
        s += x1 * y2 - x2 * y1
    return s / 2


def centroid(r):
    a = area(r)
    if abs(a) < 1e-6:
        return (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
    cx = cy = 0.0
    for i in range(len(r)):
        x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
        f = x1 * y2 - x2 * y1
        cx += (x1 + x2) * f; cy += (y1 + y2) * f
    return (cx / (6 * a), cy / (6 * a))


def pip(pt, r):
    x, y = pt; inside = False
    j = len(r) - 1
    for i in range(len(r)):
        xi, yi = r[i]; xj, yj = r[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def dp(pts, tol):
    """Douglas-Peucker simplification."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / L
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def ring_out(r, tol=0.0):
    if len(r) > 1 and r[0] == r[-1]:
        r = r[:-1]
    if tol:
        r2 = dp(r + [r[0]], tol)[:-1]
        if len(r2) >= 3:
            r = r2
    flat = []
    for x, y in r:
        flat += [round(x, 1), round(y, 1)]
    return flat


def line_out(r, tol=0.0):
    if tol:
        r = dp(r, tol)
    flat = []
    for x, y in r:
        flat += [round(x, 1), round(y, 1)]
    return flat


def stitch(ways):
    """Join way node lists into closed rings."""
    ways = [list(w) for w in ways if len(w) > 1]
    rings = []
    while ways:
        cur = ways.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[::-1][1:]
                elif w[-1] == cur[0]:
                    cur = w + cur[1:]
                elif w[0] == cur[0]:
                    cur = w[::-1] + cur[1:]
                else:
                    continue
                ways.pop(i); changed = True
                break
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
    return rings


def hsh(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def in_box(x, y, pad=0):
    return E_MIN - pad <= x <= E_MAX + pad and N_MIN - pad <= y <= N_MAX + pad


def metres(value):
    if value is None or not re.fullmatch(r'\d+(?:\.\d+)?(?: m)?', value):
        return None
    result = float(value.split(' ')[0])
    return result if math.isfinite(result) else None


def enrich_existing(existing, generated, area_sources):
    result = dict(existing)
    result['meta'] = {**existing['meta'], 'sources': generated['meta']['sources']}
    fields = {'buildings': ('height', 'rh', 'levels'), 'roads': ('s', 'lanes', 'w', 'br', 'u'),
              'waterways': ('covered', 'w')}
    for section in ('buildings', 'roads', 'waterways'):
        if section not in existing:
            continue
        key = (lambda item: item['id']) if section == 'buildings' else (lambda item: tuple(item['p']))
        by_key = {key(item): item for item in generated[section]}
        result[section] = []
        for item in existing[section]:
            fresh = by_key.get(key(item))
            if fresh is None:
                raise ValueError(f'No exact source match for {section}: {key(item)}')
            if section == 'buildings' and item['r'] != fresh['r']:
                raise ValueError('Building footprint changed during enrichment')
            retained = {field: value for field, value in item.items()
                        if field not in fields[section] or field in fresh}
            result[section].append({**retained, **{field: fresh[field] for field in fields[section] if field in fresh}})
    unchanged = {json.dumps(item, sort_keys=True) for item in generated['areas']}
    result['areas'] = []
    for item in existing['areas']:
        if json.dumps(item, sort_keys=True) in unchanged:
            result['areas'].append(item)
            continue
        vertices = set(zip(item['r'][0][::2], item['r'][0][1::2]))
        candidates = [fresh for fresh, source in area_sources
                      if fresh['k'] == item['k'] and len(vertices) >= 3 and vertices <= source]
        if len(candidates) != 1:
            raise ValueError('Changed area requires one exact source vertex match')
        result['areas'].append(candidates[0])
    return result


# ---------------------------------------------------------------- classification
AREA_KIND = {
    ('landuse', 'forest'): 'forest', ('natural', 'wood'): 'forest',
    ('natural', 'scrub'): 'scrub', ('natural', 'wetland'): 'wetland',
    ('landuse', 'meadow'): 'meadow', ('landuse', 'grass'): 'grass', ('natural', 'grassland'): 'meadow',
    ('landuse', 'farmland'): 'farmland', ('landuse', 'orchard'): 'orchard', ('landuse', 'allotments'): 'orchard',
    ('landuse', 'residential'): 'residential', ('landuse', 'industrial'): 'industrial',
    ('landuse', 'commercial'): 'commercial', ('landuse', 'retail'): 'commercial', ('landuse', 'garages'): 'paved',
    ('landuse', 'cemetery'): 'cemetery', ('amenity', 'grave_yard'): 'cemetery',
    ('leisure', 'park'): 'park', ('leisure', 'garden'): 'park', ('leisure', 'playground'): 'playground',
    ('leisure', 'pitch'): 'pitch', ('leisure', 'stadium'): 'stadium', ('leisure', 'track'): 'track',
    ('amenity', 'parking'): 'paved', ('amenity', 'fuel'): 'paved', ('amenity', 'school'): 'school',
    ('amenity', 'kindergarten'): 'school', ('amenity', 'hospital'): 'school',
    ('natural', 'water'): 'water', ('landuse', 'basin'): 'water', ('landuse', 'reservoir'): 'water',
    ('waterway', 'riverbank'): 'water', ('landuse', 'construction'): 'dirt', ('landuse', 'brownfield'): 'dirt',
    ('man_made', 'wastewater_plant'): 'industrial',
}
ROAD_W = {
    'primary': 9, 'primary_link': 7, 'secondary': 8, 'secondary_link': 6, 'tertiary': 7, 'tertiary_link': 6,
    'unclassified': 6, 'residential': 6, 'living_street': 5, 'service': 3.6, 'track': 3, 'pedestrian': 5,
    'footway': 1.8, 'path': 1.4, 'cycleway': 2, 'steps': 2, 'bridleway': 1.4,
}
WATER_W = {'river': 12, 'stream': 3, 'canal': 6, 'ditch': 1.6, 'drain': 1.6}


def building_profile(t, poly, ctr):
    """Guess height (m), roof style and material for a footprint. OSM here has no heights."""
    b = t.get('building', 'yes')
    a = abs(area(poly))
    seed = hsh(str(ctr))
    lv = t.get('building:levels')
    dist = math.hypot(*ctr)
    # oriented-box aspect
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    asp = 1.0
    best = None
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        ang = math.atan2(y2 - y1, x2 - x1); c, s = math.cos(ang), math.sin(ang)
        us = [p[0] * c + p[1] * s for p in poly]; vs = [-p[0] * s + p[1] * c for p in poly]
        w, h = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * h < best:
            best = w * h; asp = max(w, h) / max(1e-3, min(w, h))
    rect = a / best if best else 0
    roof = 'flat'; mat = 'plaster'
    if b in ('church', 'chapel', 'cathedral'):
        return 15.0, 'church', 'brick'
    if b in ('garage', 'garages', 'shed', 'carport', 'kiosk'):
        h = 2.6; mat = 'garage'
    elif b in ('roof',):
        h = 4.0; mat = 'canopy'
    elif b == 'ruins':
        h = 2.0; mat = 'ruins'
    elif b in ('school', 'public', 'hospital', 'civic', 'government', 'college', 'kindergarten', 'townhall'):
        h = 9.5 if a > 500 else 7.0; mat = 'civic'
        if a < 500 and rect > 0.85:
            roof = 'gable'
    elif b in ('industrial', 'warehouse', 'service', 'farm_auxiliary', 'barn'):
        h = 7.0 + seed * 3; mat = 'metal'
        if b in ('barn', 'farm_auxiliary') and rect > 0.85:
            roof = 'gable'
    elif b in ('commercial', 'retail', 'supermarket', 'office'):
        h = 6.0 + seed * 2; mat = 'commercial'
    elif b in ('apartments', 'residential') or (b == 'yes' and a > 280 and asp > 2.0 and dist < 1300):
        h = 15.0 if seed > 0.35 else 12.0; mat = 'panel'
        if a < 330:
            h = 9.0
    elif a < 32:
        h = 2.6; mat = 'shed'
        if rect > 0.85 and seed > 0.4:
            roof = 'gable'
    elif a < 260:
        h = 3.2 if seed < 0.45 else 5.6
        mat = 'house'
        if rect > 0.8:
            roof = 'gable' if seed < 0.8 else 'hip'
    elif a < 900:
        h = 6.5 + seed * 3; mat = 'commercial' if dist < 900 else 'metal'
        if rect > 0.9 and a < 450:
            roof = 'gable'; mat = 'house' if dist > 500 else 'civic'
    else:
        h = 7.5 + seed * 2; mat = 'metal'
    if lv is not None and re.fullmatch(r'\d+(?:\.\d+)?', lv):
        levels = metres(lv)
        if levels is not None and levels > 0:
            h = levels * 3.0 + 0.6
    return round(h, 1), roof, mat


POI_KEYS = ('amenity', 'shop', 'tourism', 'historic', 'leisure', 'office', 'craft', 'healthcare', 'man_made')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cache')
    ap.add_argument('--download', action='store_true')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'silale.json'))
    ap.add_argument('--enrich-existing')
    args = ap.parse_args()
    if args.download:
        download(args.cache)

    nodes, ntags, ways, rels = {}, {}, {}, {}
    sources = []
    for f in sorted(glob.glob(os.path.join(args.cache, '*.osm'))):
        root = ET.parse(f).getroot()
        with open(f, 'rb') as raw:
            digest = hashlib.sha256(raw.read()).hexdigest()
        source = {'file': os.path.basename(f), 'sha256': digest,
                  'retrievedAt': datetime.fromtimestamp(os.path.getmtime(f), timezone.utc).isoformat()}
        bounds = root.find('bounds')
        if bounds is not None:
            bbox = [float(bounds.get(k)) for k in ('minlon', 'minlat', 'maxlon', 'maxlat')]
            source.update(bbox=bbox, url='https://api.openstreetmap.org/api/0.6/map?bbox=' + ','.join(map(str, bbox)))
        elif len(root.findall('relation')) == 1:
            source['url'] = 'https://api.openstreetmap.org/api/0.6/relation/' + root.find('relation').get('id') + '/full'
        sources.append(source)
        for el in root:
            t = {c.get('k'): c.get('v') for c in el.findall('tag')}
            i = el.get('id')
            if el.tag == 'node':
                nodes[i] = proj(float(el.get('lat')), float(el.get('lon')))
                if t:
                    ntags[i] = t
            elif el.tag == 'way':
                ways[i] = ([n.get('ref') for n in el.findall('nd')], t)
            elif el.tag == 'relation':
                rels[i] = ([(m.get('type'), m.get('ref'), m.get('role')) for m in el.findall('member')], t)

    def coords(refs):
        return [nodes[r] for r in refs if r in nodes]

    out = {
        'meta': {
            'name': 'Šilalė', 'lat0': LAT0, 'lon0': LON0, 'mLat': M_LAT, 'mLon': M_LON,
            'bounds': [E_MIN, N_MIN, E_MAX, N_MAX],
            'attribution': 'Map data © OpenStreetMap contributors (ODbL)',
            'sources': sources,
        },
        'areas': [], 'buildings': [], 'roads': [], 'waterways': [], 'treeRows': [], 'trees': [],
        'pois': [], 'places': [], 'streets': [], 'barriers': [],
    }

    def area_kind(t):
        for (k, v), kind in AREA_KIND.items():
            if t.get(k) == v:
                return kind
        if t.get('natural') == 'water' or 'water' in t:
            return 'water'
        return None

    # --- areas from closed ways
    for wid, (refs, t) in ways.items():
        if 'building' in t or refs[0] != refs[-1] or len(refs) < 4:
            continue
        kind = area_kind(t)
        if not kind:
            continue
        r = coords(refs)
        c = centroid(r)
        if not any(in_box(x, y, 50) for x, y in r):
            continue
        out['areas'].append({'k': kind, 'r': [ring_out(r, 0.6)], 'a': round(abs(area(r)))})

    area_sources = []
    # --- multipolygon relations
    for rid, (mem, t) in rels.items():
        if t.get('type') != 'multipolygon':
            continue
        kind = area_kind(t)
        if not kind or 'building' in t:
            continue
        outer = [ways[m[1]][0] for m in mem if m[0] == 'way' and m[1] in ways and m[2] != 'inner']
        inner = [ways[m[1]][0] for m in mem if m[0] == 'way' and m[1] in ways and m[2] == 'inner']
        orings = [coords(r) for r in stitch(outer)]
        irings = [coords(r) for r in stitch(inner)]
        for o in orings:
            if len(o) < 3 or not any(in_box(x, y, 50) for x, y in o):
                continue
            holes = [h for h in irings if len(h) >= 3 and pip(h[0], o)]
            record = {'k': kind, 'r': [ring_out(o, 0.6)] + [ring_out(h, 0.6) for h in holes],
                      'a': round(abs(area(o)))}
            out['areas'].append(record)
            area_sources.append((record, set(zip(ring_out(o)[::2], ring_out(o)[1::2]))))

    # --- buildings
    poi_nodes = [(nodes[i], t) for i, t in ntags.items() if i in nodes and 'name' in t and any(k in t for k in POI_KEYS)]
    named_area = [(coords(refs), t) for refs, t in ways.values()
                  if 'name' in t and 'building' not in t and refs[0] == refs[-1] and any(k in t for k in POI_KEYS)]
    bset = []
    for wid, (refs, t) in ways.items():
        if 'building' not in t or refs[0] != refs[-1] or len(refs) < 4:
            continue
        if t.get('building') in ('no', 'construction', 'proposed'):
            continue
        r = coords(refs)[:-1]
        if len(r) < 3:
            continue
        if area(r) < 0:
            r = r[::-1]
        c = centroid(r)
        if not in_box(*c):
            continue
        bset.append((wid, r, c, t))
    for rid, (mem, t) in rels.items():
        if 'building' in t and t.get('type') == 'multipolygon':
            outer = [ways[m[1]][0] for m in mem if m[0] == 'way' and m[1] in ways and m[2] == 'outer']
            for o in stitch(outer):
                r = coords(o)[:-1]
                if len(r) >= 3:
                    if area(r) < 0:
                        r = r[::-1]
                    c = centroid(r)
                    if in_box(*c):
                        bset.append(('r' + rid, r, c, t))

    for wid, r, c, t in bset:
        h, roof, mat = building_profile(t, r, c)
        name = t.get('name')
        kind = t.get('amenity') or t.get('shop') or t.get('tourism') or t.get('office')
        if not name:
            for (p, pt) in poi_nodes:
                if abs(p[0] - c[0]) < 80 and abs(p[1] - c[1]) < 80 and pip(p, r):
                    name = pt['name']; kind = kind or next((pt[k] for k in POI_KEYS if k in pt), None)
                    break
        if not name:
            for (ar, at) in named_area:
                if pip(c, ar) and abs(area(ar)) < 4 * abs(area(r)) + 200:
                    name = at['name']; kind = kind or next((at[k] for k in POI_KEYS if k in at), None)
                    break
        b = {'r': ring_out(r), 'h': h, 'roof': roof, 'm': mat, 'id': wid}
        for tag, field in (('height', 'height'), ('roof:height', 'rh'), ('building:levels', 'levels')):
            value = metres(t.get(tag))
            if field == 'levels' and not re.fullmatch(r'\d+(?:\.\d+)?', t.get(tag, '')):
                value = None
            if value is not None and (value > 0 or field == 'rh'):
                b[field] = value
        if t.get('building') not in ('yes', None):
            b['t'] = t['building']
        if name:
            b['n'] = name
        if kind:
            b['kind'] = kind
        if t.get('addr:street') and t.get('addr:housenumber'):
            b['ad'] = f"{t['addr:street']} {t['addr:housenumber']}"
        elif t.get('addr:place') and t.get('addr:housenumber'):
            b['ad'] = f"{t['addr:place']} {t['addr:housenumber']}"
        if t.get('start_date'):
            b['y'] = t['start_date']
        if t.get('denomination'):
            b['den'] = t['denomination']
        out['buildings'].append(b)

    # --- roads, waterways, rows, barriers
    streets = {}
    for wid, (refs, t) in ways.items():
        r = coords(refs)
        if len(r) < 2 or not any(in_box(x, y, 30) for x, y in r):
            continue
        hw = t.get('highway')
        if hw in ROAD_W:
            rd = {'c': hw, 'p': line_out(r, 0.3)}
            if t.get('bridge') not in (None, 'no'):
                rd['br'] = 1
            if t.get('surface'):
                rd['s'] = t['surface']
            if t.get('lanes', '').isdigit() and int(t['lanes']) > 0:
                rd['lanes'] = int(t['lanes'])
            width = metres(t.get('width'))
            if width is not None and width > 0:
                rd['w'] = width
            if t.get('surface') in ('unpaved', 'gravel', 'dirt', 'ground', 'compacted', 'fine_gravel', 'sand', 'grass'):
                rd['u'] = 1
            out['roads'].append(rd)
            if t.get('name'):
                L = sum(math.dist(r[i], r[i + 1]) for i in range(len(r) - 1))
                s = streets.setdefault(t['name'], {'len': 0, 'pts': []})
                s['len'] += L; s['pts'].append((L, r))
        ww = t.get('waterway')
        if ww in WATER_W:
            water = {'c': ww, 'p': line_out(r, 0.4), 'n': t.get('name')}
            if t.get('tunnel') in ('yes', 'culvert'):
                water['covered'] = 1
            width = metres(t.get('width'))
            if width is not None and width > 0:
                water['w'] = width
            out['waterways'].append(water)
        if t.get('natural') == 'tree_row':
            out['treeRows'].append(line_out(r, 0.5))
        if t.get('barrier') in ('hedge', 'fence', 'wall'):
            out['barriers'].append({'c': t['barrier'], 'p': line_out(r, 0.3), 'cl': 1 if refs[0] == refs[-1] else 0})

    for name, s in streets.items():
        L, pts = max(s['pts'], key=lambda q: q[0])
        # point halfway along the longest piece
        half = L / 2; acc = 0; mid = pts[0]
        for i in range(len(pts) - 1):
            d = math.dist(pts[i], pts[i + 1])
            if acc + d >= half:
                f = (half - acc) / d if d else 0
                mid = (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f)
                break
            acc += d
        if in_box(*mid):
            out['streets'].append({'n': name, 'x': round(mid[0], 1), 'y': round(mid[1], 1), 'len': round(s['len'])})

    # --- single trees, POIs, places
    for i, t in ntags.items():
        if i not in nodes:
            continue
        x, y = nodes[i]
        if not in_box(x, y):
            continue
        if t.get('natural') == 'tree':
            out['trees'].append([round(x, 1), round(y, 1)])
        if 'place' in t and t.get('name'):
            out['places'].append({'n': t['name'], 'k': t['place'], 'x': round(x, 1), 'y': round(y, 1)})
        elif 'name' in t and any(k in t for k in POI_KEYS):
            k = next(t[k] for k in POI_KEYS if k in t)
            out['pois'].append({'n': t['name'], 'k': k, 'x': round(x, 1), 'y': round(y, 1)})
    for refs, t in ways.values():
        if 'name' in t and any(k in t for k in POI_KEYS) and 'highway' not in t:
            r = coords(refs)
            if len(r) < 3:
                continue
            c = centroid(r[:-1] if r[0] == r[-1] else r)
            if in_box(*c):
                k = next(t[k] for k in POI_KEYS if k in t)
                out['pois'].append({'n': t['name'], 'k': k, 'x': round(c[0], 1), 'y': round(c[1], 1)})
    # water names (rivers / ponds)
    for refs, t in ways.values():
        if t.get('name') and (t.get('waterway') in ('river', 'stream') or t.get('natural') == 'water'):
            r = coords(refs)
            inside = [p for p in r if in_box(*p, -100)]
            if inside:
                p = inside[len(inside) // 2]
                out['pois'].append({'n': t['name'], 'k': 'water', 'x': round(p[0], 1), 'y': round(p[1], 1)})
    # de-duplicate POIs by name, keep first
    seen = set(); pois = []
    for p in out['pois']:
        if p['n'] in seen:
            continue
        seen.add(p['n']); pois.append(p)
    out['pois'] = pois

    order = ['farmland', 'meadow', 'residential', 'industrial', 'commercial', 'school', 'dirt', 'grass', 'orchard',
             'park', 'cemetery', 'scrub', 'wetland', 'forest', 'stadium', 'pitch', 'track', 'playground', 'paved', 'water']
    out['areas'].sort(key=lambda a: (order.index(a['k']), -a['a']))
    for a in out['areas']:
        del a['a']

    if args.enrich_existing:
        with open(args.enrich_existing, encoding='utf-8') as existing:
            out = enrich_existing(json.load(existing), out, area_sources)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print({k: len(v) for k, v in out.items() if isinstance(v, list)}, os.path.getsize(args.out) // 1024, 'KB')


if __name__ == '__main__':
    main()
