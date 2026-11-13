# Isometric Šilalė

A pixel-art isometric map of Šilalė, Lithuania, inspired by Justin Chavez's
[Isometric SF](https://isometricsf.com) ([how it was made](https://www.justinchavez.com/blog/isometric-sf/)).

Isometric SF painted San Francisco with AI image models. This map takes another route:
your browser paints every tile from OpenStreetMap data. That covers 3,362 buildings, roads,
fields, the Lokysta river and its ponds, and about 190,000 trees scattered through forests,
yards and field edges. Each tile is snapped to a fixed palette, which gives the hard pixel edges.

## Features

- Pan, zoom and glide around a floating diorama of the town and nearby villages
- Gable and hip roofs inferred from house footprints, Soviet-era apartment blocks with
  balconies, and both churches with towers and spires
- **Summer, Winter and Night** seasons (press `S`): snow and ice, or lit windows and street lamps
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

## Layout

| Path | What it does |
| --- | --- |
| `index.html`, `styles.css` | Page and UI chrome |
| `js/app.js` | Camera, tile scheduling, labels, search, building cards, sharing |
| `js/worker.js` | Tile painter. Runs in 1–4 Web Workers with `OffscreenCanvas` |
| `js/shared.js` | Projection, themes and palettes, shared geometry helpers |
| `data/silale.json` | Town data extracted from OpenStreetMap, in local metres |
| `tools/build_data.py` | Rebuilds `data/silale.json` from OSM |
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

There are seven zoom levels, like an image pyramid. The finest level uses 0.4 iso units per
art pixel. The viewer always picks a level that magnifies art pixels by 1–2× and falls back
to coarser tiles while finer ones are painted.

## Rebuilding the data

```sh
python3 tools/build_data.py --download osm_cache/   # fetch fresh OSM data (16 small API calls)
python3 tools/build_data.py osm_cache/              # convert an existing cache
```

OpenStreetMap records almost no building heights for Šilalė, so heights and roof shapes are
estimated from each footprint's size, shape, tags and distance from the centre.

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL 1.0.
The concept comes from Isometric SF by Justin Chavez.
