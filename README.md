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
