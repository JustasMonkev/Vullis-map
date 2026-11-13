# Isometric Šilalė

A pixel-art isometric map of Šilalė, Lithuania, inspired by Justin Chavez's
[Isometric SF](https://isometricsf.com) ([how it was made](https://www.justinchavez.com/blog/isometric-sf/)).

Isometric SF painted San Francisco with AI image models. This map takes another route:
your browser paints every tile from OpenStreetMap and ESA WorldCover data. That covers
3,362 buildings, roads, fields, the Lokysta river and its ponds. Illustrative tree positions
follow satellite-mapped tree cover, while mapped individual trees and tree rows are retained.
Each tile is snapped to a fixed palette, which gives the hard pixel edges.

## Features

- Pan, zoom and glide around a floating diorama of the town and nearby villages
- Gable and hip roofs inferred from house footprints, Soviet-era apartment blocks with
  balconies, and both churches with towers and spires
- **Summer, Winter and Night** seasons (press `S`): snow and ice, or lit windows and street lamps
- Mapped paving surfaces and bridges, lane-based width estimates, and underground stream sections
- Source-labelled building heights, including the Catholic church's published approximately 60 m tower
- Search places, streets, addresses (`Nepriklausomybės 8`) or coordinates (`55.49, 22.18`)
- Click any building to see its name, address, year built and approximate height
- Phone-friendly: pinch, double-tap to zoom in, two-finger tap to zoom out, tap-hold-slide
  for one-handed zoom; building details, Share and About open as swipe-down bottom sheets
- **Surprise me** (`R`), whole town (`H`), and shareable links with an optional note pin.
  Links look like `#19.00/55.49408/22.18031/My%20note`

## Run it

It's a static site with no build step:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To publish it, push to GitHub Pages or any static host.

## Tests

Development checks use Node.js 24 and Playwright; the site itself still needs no build step.

```sh
npm ci
npx playwright install chromium
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

Camera and geometry tests also run without installed packages:

```sh
node --test tests/atlas.test.cjs tests/buildings.test.cjs tests/camera.test.cjs tests/realism.test.cjs tests/rendering.test.cjs
```

The browser suite uses actual workers and canvas rendering on desktop and mobile-sized
viewports. GitHub Actions runs it and rebuilds the overview images for every season.

## Layout

| Path | What it does |
| --- | --- |
| `index.html`, `styles.css` | Page and UI chrome |
| `js/app.js` | Camera, tile scheduling, labels, search, building cards, sharing |
| `js/worker.js` | Tile painter. Runs in 1–4 Web Workers with `OffscreenCanvas` |
| `js/shared.js` | Projection, themes and palettes, shared geometry helpers |
| `data/silale.json` | Town data extracted from OpenStreetMap, in local metres |
| `data/landcover.json` | Native ESA WorldCover 2021 crop and source attribution |
| `data/landmarks.json` | Published landmark height and provenance |
| `tools/build_data.py` | Rebuilds `data/silale.json` from OSM |
| `tools/build_landcover.py` | Recreates the bounded satellite land-cover crop using GDAL |
| `tools/bake_overview.js` | Pre-paints zoom levels 3–6 for each season into `tiles/` |
| `tiles/` | Pre-painted overview images (≈640 KB per season) and `atlas.json` |

### How a tile is painted

1. **Ground.** Background fields, then land use (forest, meadows, farmland stripes, cemetery
   rows), streams, ponds, road casings and fills, and hedges. Everything is drawn in world
   metres through one affine iso transform.
2. **Shadows.** Building and tree shadows are drawn onto a separate layer, which is then
   composited once at low opacity.
3. **Objects.** Buildings and trees are sorted far to near. Houses are convex solids, so the
   painter only draws faces that point at the camera. Other buildings are extruded footprints.
4. **Palette snap.** Every pixel is mapped to the nearest colour in the season's palette, which
   removes anti-aliasing.

Tiles are painted in parallel by up to four workers. The viewer asks for them in priority
order: the overview first, then half-resolution parents of empty on-screen tiles (so gaps fill
quickly), then on-screen tiles from the centre outwards, then a ring just off screen. During a
glide it plans for where the camera is going. Painted tiles are also saved to IndexedDB, so
repeat visits load almost instantly. Bump `VERSION` in `js/shared.js` whenever the renderer
or data changes, so old saved tiles are thrown away.

The four most zoomed-out levels are pre-painted with the same worker code
(`node tools/bake_overview.js`) and shipped as lossless WebP images, so zooming out is instant
and every closer level has a sharp stand-in nearby. Until a tile is painted, the viewer shows
the nearest coarser tile, softly blurred when it is stretched a lot, with any finer tiles
already painted laid on top. Re-bake after changing the renderer or data, and bump `VERSION`.
The atlas also records a SHA-256 fingerprint of the renderer and all three datasets.
CI rejects shipped overview images whose version or source fingerprint is stale.

There are seven zoom levels, like an image pyramid. The finest level uses 0.4 iso units per
art pixel. The viewer always picks a level that magnifies art pixels by 1–2× and falls back
to coarser tiles while finer ones are painted.

## Rebuilding the data

```sh
python3 tools/build_data.py --download osm_cache/   # fetch fresh OSM data (16 small API calls)
python3 tools/build_data.py osm_cache/              # convert an existing cache
```

To reproduce the current enrichment without changing existing feature order, place these
three OSM responses in a cache directory:

- `town.osm`: `https://api.openstreetmap.org/api/0.6/map?bbox=22.146,55.474,22.226,55.510`
- `relation-5699192.osm`: `https://api.openstreetmap.org/api/0.6/relation/5699192/full`
- `relation-6293075.osm`: `https://api.openstreetmap.org/api/0.6/relation/6293075/full`

```sh
python3 tools/build_data.py osm_cache/ --enrich-existing data/silale.json --out data/silale.json
python3 tools/build_landcover.py  # requires gdalinfo and gdal_translate
npm run bake
```

The source responses, retrieval times and checksums are recorded in the generated metadata.
Full forest relations replace incomplete chains and retain their mapped holes. The WorldCover
tool reads a bounded native-pixel window through HTTP byte ranges; it does not resample it.

OpenStreetMap records almost no building heights for Šilalė, so heights and roof shapes are
estimated from each footprint's size, shape, tags and distance from the centre. Irregular
footprints keep their actual outline instead of being expanded into rectangular houses.
Inferred trees are constrained by WorldCover's tree-cover class and avoid mapped buildings,
roads and open water. Individual positions, species and density remain illustrative. The
931 × 416 native-pixel crop represents land cover in 2021, not current tree measurements.
Small trees and changes since 2021 may be absent. Explicit OSM trees and rows are retained.

The Catholic church's overall tower height follows the municipality's approximately 60 m
description. Its shaft, spire and cross proportions remain schematic. Other building heights
are estimated unless an explicit source height is available. Road widths use mapped width
first, then an estimated 3 m per mapped lane, then class defaults. Bridge decks indicate
mapped crossings; physical bridge elevation and town terrain have not been surveyed here.

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL 1.0.
Land cover © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021)
processed by ESA WorldCover consortium, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Source: [WorldCover 2021 v200](https://doi.org/10.5281/zenodo.7254221). The native crop is
losslessly run-length encoded; the source attribution and decoded-pixel checksum are included.
Catholic tower height: [Šilalė municipality](https://silale.lt/en/tourism/).
The concept comes from Isometric SF by Justin Chavez.
