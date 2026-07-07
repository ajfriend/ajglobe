# ajglobe

One reusable package for **general, fast orthographic-globe rendering of points,
lines, and polygons** — GeoJSON-style primitives you can style arbitrarily, with
cell visualizations, coastlines, country outlines, etc. built *on top*. Zero
runtime dependencies, WebGL2, plain ESM.

The motivation: stop re-solving the same globe-plotting problems every project —
loop orientation (the "why is everything filled" bug), globe navigation (gimbal
lock, drag drifting out of sync with the mouse), keyboard rotation, country
outlines, great-circle arcs, hover picking. Solve each once, well.

The technical bet: **never parameterize to 2D.**

- A vertex is a point on the unit sphere (`lng/lat → xyz`, once).
- A filled polygon is triangulated by ring **topology** — a fan over vertex
  indices, coordinate-free — and lines densify by slerping unit vectors, never
  touching `lng/lat`. Antimeridian and pole correctness fall out for free: a
  polygon on a sphere has no seam, and a wrongly-wound loop can't fill the
  complement because there's no 2D winding to get wrong.
- The back hemisphere is hidden by an opaque depth sphere, which also gives a
  solid globe and removes see-through gaps.

Just as important, the globe **lives on the GPU as persistent 3D geometry** —
`lng/lat → xyz` once at build, after which rotating or zooming is a uniform
update, not a redraw: no per-frame reprojection, clipping, or path generation.
That's what holds 60 FPS at DGGS scale — 1.18M cells / 7M vertices — with true
depth, a solid globe, and GPU picking.

Scope is deliberately small (no basemaps, tiles, or labels): draw lots of
polygons (e.g. DGGS cells) with fills + outlines + color/opacity, draw reference
lines (coastlines), and drag/zoom — done right, once.

> Working on this repo? See [PLAN.md](PLAN.md) for status, roadmap, decisions, and
> gotchas — it's the source of truth.

## Status

**Milestone 1 (spike):** filled convex polygons + background sphere + arcball drag
+ scroll zoom, in WebGL2, zero dependencies. Proven against every ivea7h cell at
r5 (168k) and r6 (1.18M) — the pole cell fills, the antimeridian is clean.

Since then, all three GeoJSON primitives — `polygons()`, `lines()`, `points()` —
plus per-feature styling + opacity, `project`/`unproject` + hover/click events, GPU
hover picking, `snapshot()` PNG export, `coastlines()`/`borders()`, keyboard
rotation, `dist/` bundles, geometry unit tests, and `destroy()`. Next: npm. See
[PLAN.md](PLAN.md).

**Controls:** drag to rotate, scroll to zoom. With the globe focused (click it),
the keyboard rotates too — arrows / `WASD` tilt and spin, `Q`/`E` (and `←`/`→`)
roll, `Shift` for a bigger step.

## Use

```js
import { Orb } from './src/orb.js';
const orb = new Orb(canvas, { background: '#0b0e13', sphere: '#11151c' });
orb.polygons({
  lnglat,           // Float32Array [lng,lat, ...]  (or xyz: [x,y,z,...])
  starts,           // Uint32Array ring start indices (len = nCells + 1)
  fill: i => [r,g,b,a],   // per-cell color, or a constant [r,g,b,a]
});
orb.points({
  lnglat,                 // Float32Array [lng,lat, ...]  (or xyz)
  color: i => [r,g,b,a],  // per-point color (or a constant / '#rrggbb')
  size: 6,                // disc radius in CSS px (per-point fn or constant)
});
orb.lookAt(180, 0);   // center a lng/lat under the viewer
orb.on('hover', e => { /* e.index = feature under the cursor (GPU picking) */ });

orb.getView();              // -> { q, zoom }   the exact, fast view
orb.setView({ q, zoom });   // apply it; idempotent (re-applying the current view no-ops)
```

**`lnglat` vs `xyz`:** every geometry-taking call (`polygons`, `lines`, `points`)
accepts either `lnglat` — a Float32Array of `[lng, lat, …]` in degrees, converted
to unit vectors once at build — or `xyz` — a Float32Array of `[x, y, z, …]` that
must already be **unit-length** (points on the unit sphere; that's the renderer's
native format, so nothing is converted). Use `xyz` when you precompute or cache
geometry (binary pipelines, workers); use `lnglat` everywhere else. Pass exactly
one of the two.

A view is `{ q, zoom }` — `q` is the exact orientation (a unit quaternion), `zoom` the
orthographic zoom. For a **human-readable** form, compose with the pure converters
(`import { lnglatToQuat, quatToLngLat } from 'ajglobe'`), which translate just the
rotation to/from `{ lng, lat, roll }` (center point + screen twist in degrees, 0 = north
up):

```js
orb.setView({ q: lnglatToQuat(-3, 55, 0), zoom: 5 });   // set a view from lng/lat
orb.lookAt(-3, 55);                                      // …or this for the common case

const { q, zoom } = orb.getView();                       // save a view you found by dragging:
console.log({ ...quatToLngLat(q), zoom });               // { lng, lat, roll, zoom } — hard-code it
```

And **syncing two globes** is a two-liner — no internals, no re-entrancy guard (the
idempotent `setView` swallows the echo):

```js
a.on('viewchange', () => b.setView(a.getView()));
b.on('viewchange', () => a.setView(b.getView()));
```

## Reference geometry (coastlines / borders)

The library bundles **no** geographic data. Two helpers make it one call anyway —
they fetch Natural Earth from a CDN (jsDelivr, pinned) and draw via `lines()`:

```js
await orb.coastlines();                 // detail defaults to '50m'
await orb.borders({ detail: '10m', color: '#c2185b' });   // full country outlines
```

`coastlines()` draws Natural Earth coastlines; `borders()` draws admin-0 country
*polygons* as outlines (complete country shapes, coast included). `detail` is
`'110m' | '50m' | '10m'`; both return a layer (`.remove()` to toggle). `borders()`
also un-cuts the antimeridian/polar splits that GeoJSON polygons carry (Russia,
Antarctica) — it lazily loads `d3-geo-projection`'s `geoStitch` from a CDN on first
use (no bundled dep; `stitch:false` to skip, `stitch: fn` to inject offline). See
`examples/reference-detail.html` for a live detail comparison.
Want it lighter or offline? Pass `baseUrl` to self-hosted GeoJSON, or feed your own
data straight to `orb.lines({ lnglat, starts, color, width })` — the renderer takes
plain typed arrays, so the data source is entirely yours.

## Examples

`examples/dggs-globe.html` renders every ivea7h cell at r5/r6. It expects the
binaries in `examples/data/` (generated by skar_py's
`scripts/dggs_cache/web/build_ivea7h_full_ar.py`). Serve and open:

```sh
uv run -m http.server 8080 -d .   # then open /examples/dggs-globe.html
```

`examples/dggs-compare.html` shows **two rotationally-synced globes** (H3 res 1 vs
res 2), cells colored by **skar aspect ratio**; hover a cell for its H3 id + AR.
Generate its data first (H3 is native; the AR needs skar from
[skar_py](https://github.com/ajfriend)):

```sh
uv run scripts/gen_cells_geom.py                              # H3 geometry + ids
cd ~/work/skar_py && uv run --no-sync ~/work/ajglobe/scripts/gen_cells_ar.py   # skar AR
```

## Develop

No build step is needed to use or hack on it — examples import `src/orb.js` directly.

```sh
just unit     # geometry unit tests (node --test; zero deps)
npm install   # one-time, pulls the only dev dep: esbuild
just build    # -> dist/ajglobe.min.js (ESM) + dist/ajglobe.iife.min.js
```

The `dist/` bundles are for shipping (npm/CDN) and stay zero-runtime-dependency —
`borders()`'s `d3-geo-projection` is still a lazy CDN import, never bundled.
