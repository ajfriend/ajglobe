# ajglobe — project plan

A living plan to execute against across sessions. Update the status boxes as work
lands. Keep it honest: record decisions and why, not just intentions.

## 1. What & why

A small JS library for **correct, fast orthographic-globe rendering of polygons
and lines**, with the antimeridian and the poles handled *by construction*.

The recurring pain: every general mapping lib (d3-geo, deck.gl, …) breaks at the
±180° seam and at the poles, because somewhere it parameterizes geometry to 2D
`lng/lat` — to clip, triangulate (earcut), or project — and those are exactly the
singular places. A polygon on a sphere has no seams.

**The thesis (the one idea everything rests on):** never go to 2D.
- A vertex is a point on the unit sphere (`lng/lat → xyz`, once).
- A filled polygon (a DGGS cell, a country, anything) is triangulated by ring
  **topology** — a fan over vertex indices (`s, j, j+1`), which is coordinate-free
  — so it is immune to the seam, and a pole *inside* a convex ring is covered like
  any other interior point.
- The back hemisphere is hidden by an opaque depth sphere (also gives a solid
  globe + kills see-through gaps).

Result: antimeridian and pole correctness are *consequences*, not features.

## 2. Status

**Milestone 1 (spike): DONE.** WebGL2, zero dependencies, ~460 lines.
Verified in-browser on an M3 against every ivea7h cell:
- r5 (168,072 cells): builds ~45 ms, 60 FPS.
- r6 (1,176,492 cells / 7.06M verts): builds ~385 ms, **60 FPS** (16.7 ms median).
- The **pole cell fills** (deck.gl left a hole there) — zero special-casing.
- Antimeridian clean at all orientations.
- Direct arcball drag + scroll zoom + keyboard rotation (arrows/WASD tilt+spin,
  Q/E + ←/→ roll, Shift = bigger step; scoped to the focused canvas). (Inertia
  fling removed — see §8.)

Not yet committed to git (waiting on the go-ahead).

## 3. Design principles — minimal core, compose on top

**Settled.** The library is rendering + interaction + projection math only. It
owns nothing visual beyond the single `<canvas>` you hand it. All UI (buttons,
dialogs, legends, tooltips, color scales, data loading, layout) is app code,
built as ordinary DOM/framework siblings to the canvas — exactly like the HUD in
`examples/dggs-globe.html`, which is ~30 lines of plain DOM calling public
methods and required **zero** library involvement.

**Primitives & styling (the data model).** The core renders GeoJSON-shaped
primitives — **points, lines, polygons** (+ Multi forms) — and nothing more
specific. The unit of identity and style is the **feature** (one point/line/
polygon), *never* the "cell". DGGS cells, coastlines, country borders, and
choropleths are all *applications* — layers of these primitives with data-driven
style, built on top. Styling and identity ride one shared, per-feature substrate,
so restyle, per-feature opacity, and hover picking are the *same* mechanism for
every primitive type — and restyle never touches geometry. (Mechanism and the
cost argument: §4 / §7.)

**The library owns** (all coupled to render/projection math; "solve it once"):
- Layers of primitives: `points()`, `lines()`, `polygons()`, plus
  `layer.update({style})` / `layer.remove()`. Style is per-feature.
- Camera: `lookAt()`, get/set `rotation`/`zoom`, arcball drag + wheel zoom +
  keyboard rotation (canvas-scoped).
- Interaction *results* as events: `on('hover'|'click', (i, {lng,lat}) => …)`,
  `on('viewchange', …)`.
- Coordinate helpers: `project(lng,lat) → {x,y,visible}`,
  `unproject(x,y) → {lng,lat}`.

**The library does NOT own:** buttons, dialogs, legends, tooltips, color scales,
layout, data loading, framework bindings.

**Why `project`/`unproject` + events are the linchpin:** once app code can ask
"where on screen is this lng/lat?" and "what's under the cursor?", every overlay
is trivial DOM — HTML tooltips/labels positioned via `project()` (hidden when
`!visible`, i.e. back hemisphere), legends/sliders/linked charts calling `orb`
methods, and thin React/Svelte wrappers. This is the official composition
surface and the foundation picking/tooltips build on.

`examples/` holds reusable-but-optional UI snippets (HUD, legend, tooltip) to
copy — never bundled into core.

## 4. Architecture

```
src/glmath.js   vec3 / quat / mat4 (column-major) + lnglatToVec3  — vendored, no deps
src/camera.js   orientation quaternion + zoom; arcball drag; wheel zoom; mvp()
src/orb.js      WebGL2: program/shader helpers, UV depth-sphere, polygons() (topology
                fan fills), render loop (dirty-flag), resize/DPR; public API
examples/dggs-globe.html   the ivea7h r5/r6 torture test (+ HUD, viridis, data load)
examples/data/  ivea7h_r{5,6}_{pos.f32,idx.u32,ar.f32}  (gitignored; see §9)
test/           (empty — geometry unit tests to come)
```

Render order each frame (only when dirty): opaque depth sphere (radius 0.998) →
polygon fills (radius 1.0) → strokes (radius 1.0015) → point discs (radius 1.002),
all depth-tested against the sphere → back hemisphere occluded. Geometry is built
once per layer; rotation is just a uniform.

**Core substrates (shared, primitive-agnostic — build once, reuse everywhere).**
Two things live *below* the primitive renderers and are consumed identically by
points/lines/polygons; both are coordinate-free, so they're seam/pole-immune by
construction. Neither exists in `src/` yet — they land with M2 (module layout
TBD); the design rationale and trade-offs are the §7 decisions:
- **Per-feature style + identity** — `featureId` attribute + per-feature style
  buffer read in-shader by id. Serves restyle, opacity, and picking. (§7)
- **Geodesic path** — slerp-in-xyz densification of unit-sphere anchors into a
  great-circle polyline; consumed by polygon-fill *boundaries*, strokes (M3), and
  `lines()` (M5) alike. Slerp is the fixed mechanism; segment count is a pluggable
  policy. (§7)

## 5. Public API

Current:
```js
const orb = new Orb(canvas, { background:'#0b0e13', sphere:'#11151c' });
const layer = orb.polygons({ lnglat|xyz, starts, fill: i => [r,g,b,a] });
layer.update({ fill });            // restyle in place (no re-tessellation)
layer.remove();
orb.lines({ lnglat|xyz, starts, color, width });   // thick AA great-circle strokes
orb.points({ lnglat|xyz, color, size });           // round disc markers (per-feature)
orb.lookAt(lng, lat);              // center a point, north up
orb.getView();                     // -> {lng, lat, roll, zoom, q}  readable + exact
orb.setView({ lng, lat, roll?, zoom? } | { q, zoom? });   // human or exact; idempotent
orb.project(lng, lat);             // -> {x, y, visible}  (canvas CSS px)
orb.unproject(x, y);               // -> {lng, lat} | null
orb.pick(x, y);                    // -> {layer, index} | null  (GPU color picking)
orb.highlight(index);              // tint one fill feature (-1 = none)
orb.on('hover'|'click'|'viewchange', cb);          // hover/click: {x,y,lng,lat,index,layer}
await orb.snapshot({ width, height, supersample, transparent, type });  // -> PNG Blob
orb.stats;                         // {cells, verts}
orb.destroy();                     // stop the loop, detach listeners, free all GPU resources
```
Planned additions (per-feature stroke width; `points()` outline/size-update; labels).

## 6. Roadmap

The three GeoJSON primitives (§3) land across milestones: **polygons** (M1, fills;
strokes M3), **lines** (M5), **points** (M6). All share the per-feature style
substrate from M2.

- [x] **M1 — spike:** fills + depth sphere + arcball + zoom; pole/antimeridian
      proven on ivea7h r5/r6 at 60 FPS. *(polygons primitive — fills)*
- [x] **M2 — core API + composition surface** — done; verified headless on r1–r6.
  - [x] **per-feature style substrate** — `featureId` (uint) attribute + an RGBA8
        per-feature texture sampled in-shader by id (`texelFetch`, NEAREST). The
        foundation the next items + M4 picking all share; restyle rewrites
        `nFeatures` texels and never re-tessellates. (decision: §7) — verified on
        ivea7h r5/r6 (1.18M features, style tex 4096×288), glError 0.
  - [x] `project(lng,lat)→{x,y,visible}` / `unproject(x,y)→{lng,lat}` — ortho
        ray ∩ unit sphere; inv(MVP) lands in object space directly. Verified:
        project∘unproject roundtrips to err 0; back-hemisphere `visible:false`.
  - [x] `getView()→{lng,lat,roll,zoom,q}` / `setView({lng,lat,roll,zoom} | {q,zoom})` —
        a view as both a human-readable chart (center + screen twist + zoom, for
        hard-coding a view found interactively) and the exact quaternion `q` (lossless
        round-trip; q wins on input). `lookAt` is north-up sugar (roll 0). `setView`
        is idempotent (re-applying the current view no-ops), so a `viewchange`→`setView`
        sync loop self-terminates without a guard flag. Roll read from where local
        north lands in view space; lng/roll degenerate at the poles, q does not.
        Verified: round-trip + roll + idempotence unit tests; two-globe headless sync.
  - [x] event emitter: `on('hover'|'click'|'viewchange', cb)` → unsubscribe fn.
        hover/click payload `{x,y,lng,lat,index}` (lng/lat null off-globe; index
        reserved for M4 picking). Example: DOM pin via `project()` + cursor readout.
  - [x] `layer.update({fill})` — restyle without re-tessellating (rewrites the
        style texture via `texSubImage2D`; fill's alpha is carried per-feature)
  - [x] per-feature opacity — alpha rides in the style texture; `gl.BLEND` with
        straight alpha over the depth sphere (cells don't overlap → no sorting).
        Verified: faded cell == cell·α + sphere·(1−α).
  - [x] large-cell fill subdivision (§8) — fan triangles whose apex-spoke angle
        trips a gate (>0.06 rad) are subdivided and the new verts projected onto
        the sphere, so coarse cells stay above the depth sphere. r5/r6 keep the
        flat fast path untouched (build still ~382 ms / 7.06M verts). Verified on
        ivea7h r2 (492 cells → 14,676 verts, full coverage, no sag holes).
  - [ ] document `xyz` vs `lnglat` input (README/JSDoc — deferred to M5 polish)
- [x] **M3 — thick AA strokes** (any open or closed path) — `lines()` expands
      each segment to a screen-space quad of constant pixel width; the fragment
      shader feathers the edges (1px alpha ramp) for AA at any width/angle/zoom.
      Long segments are slerp-densified (geodesic-path substrate, §4/§7) so they
      follow the great circle. Depth-tested overlay (depth-write off). Verified:
      width 2↔6 px, AA edges, 90° edge → 32 arc segments, back hemisphere hidden.
      *Deferred:* round/miter joins (shallow densified corners look fine); per-
      feature width/color (one color+width per layer for now).
- [x] **M4 — GPU hover picking** — `pick(x,y) → {layer, index} | null`, and
      `index`/`layer` now populated in `on('hover'|'click')` (was null). A second
      program draws the fill VAOs with `featureId+idBase+1` encoded as an RGBA8
      color into an offscreen FBO (id 0 = nothing); the depth sphere is drawn first
      so back-hemisphere cells are occluded, blend off so ids are exact. The
      id-buffer is rendered lazily (only when the view/layers/size change) then read
      1px per pointer. Shared `featureId` attribute (needed `layout(location)` so the
      pick program reuses the fill VAOs) + reused `_renderTarget`/`readPixels`.
      Bonus: `highlight(index)` tints the hovered feature via a `u_hoverId` uniform
      (no texture rebuild). Verified r5+r6 (1.18M cells): in-range distinct indices,
      off-globe → null, highlight + demo readout, snapshot still intact, glError 0.
- [x] **`snapshot({width,height,supersample,transparent,type}) → PNG Blob`** —
      renders the current view to an offscreen FBO at any resolution (supersampled
      for AA), independent of the on-screen canvas; transparent-background option.
      For shareable stills + headless batch capture. Example has a "save PNG"
      button. Verified headless: 1600×1200 PNG, transparent alpha, strokes scale
      with output res, live canvas untouched.
- [ ] **M5 — reference-geometry helpers + polish**
  - [x] `lines()` primitive over open polylines — done with M3 (thick AA strokes
        + slerp densification). Coastline overlay demo in the example.
  - [x] **`coastlines(opts)` / `borders(opts)` — CDN-backed, zero bundled data.**
        One call: fetch Natural Earth GeoJSON from jsDelivr (pinned NE release;
        `baseUrl` overridable) → `geojsonLines()` → `lines()`. `detail: 110m|50m|10m`,
        no geo bytes bundled (decision §7). `coastlines()` = `coastline` lines;
        `borders()` = **`admin_0_countries` polygons** drawn as ring outlines, so
        borders read as complete country shapes alone (not just inter-country land
        boundaries, which leave gaps at every coast). `geojsonLines()` flattens
        LineString/MultiLineString **and** Polygon/MultiPolygon rings.
  - [x] **antimeridian/pole splits un-cut via geoStitch** (default for `borders()`).
        GeoJSON polygons are split at ±180° and closed at the poles for 2D validity
        (Russia → a dateline edge, Antarctica → a polar stub). `borders()` lazily
        loads **`d3-geo-projection`'s `geoStitch`** from a CDN (pay-per-use; the core
        ships no dep) and un-cuts them back into spherical rings before drawing —
        `stitch:false` skips it, `stitch: fn` injects your own (offline). Verified:
        Antarctica is a clean polar ring (stub gone) and the Bering/Pacific is clean.
  - [x] demo: `examples/reference-detail.html` — single globe, coastlines/borders
        toggles + 110m/50m/10m detail + view presets (Aegean/Britain/Europe/world).
  - [ ] more examples, README, `dist/` esbuild bundle, basic geometry unit tests
- [x] **M6 — `points()` primitive** — the third GeoJSON primitive. Each point is a
      screen-space round disc of constant pixel size at its unit-sphere position,
      billboarded in the vertex shader (offset `clip.xy`, keep the center's depth) so
      it depth-tests against the background sphere — **back-hemisphere points hidden,
      agreeing with `project().visible`**. Per-feature **color/alpha via the M2 style
      texture** (`update({color})` restyles), per-feature **radius via a vertex
      attribute** (`size`). **Pickable** through the M4 id-buffer, with fills + points
      sharing one global id space. Built as **expanded quads (4 verts/point), not
      instanced** — mirrors `lines()`, reuses `_attrib`/style-texture/pick infra, adds
      no new GL concept. Verified headless on city markers: clean AA discs, picking
      (`pick`/`on('hover')`), back hemisphere hidden, recolor, z-order over fills/
      strokes/coastlines, `glError 0`. Demo: `cities` toggle in `reference-detail.html`.
- [ ] **Later:** time-normalized momentum (opt-in), concave polygon fills
      (spherical ear-clip), perspective/deep zoom, reuse the 3D core for 2D map
      projections, publish to npm

## 7. Decisions log

- **Standalone repo** at `/Users/aj/work/ajglobe`; name `ajglobe`. MIT.
- **WebGL2**, **zero runtime deps**, vanilla ESM, no dev build step; `esbuild`
  only to emit `dist/` later. JS + JSDoc (no TS toolchain).
- Math vendored (no gl-matrix).
- **General GPU engine (luma.gl / three.js)? — deferred to a WebGPU decision, not
  before.** These are general 3D engines (deck.gl is built on luma.gl), so the
  question is "engine vs raw WebGL2", independent of the map stuff we reject. For
  v1 it's a net loss: the engine would dwarf a few-hundred-line core in bundle
  size, force a build step (killing load-as-plain-ESM), and add scene-graph/per-
  object friction exactly at the 1M-vert hot path we need to own — while only
  replacing plumbing we've already minimized (`_attrib`/`program`), never the
  bespoke parts (topology fan, depth sphere, stroke quads, slerp). The real
  trigger to reconsider is **WebGPU**: if we ever want a WebGPU backend, a
  backend-abstraction engine (luma.gl v9) earns its weight there. Lighter middle
  ground if GL plumbing gets gnarly first (M4 FBO picking, M6 instancing): **twgl
  or regl** (tiny, ESM, no build step) — not a full engine.
- **No bundled geographic data; reference geometry is a CDN-backed convenience.**
  The library ships **zero** geo bytes (the 10m tier alone is ~3.8 MB — it would
  dwarf a few-hundred-line core, and §3 says the core owns no data loading). But
  `coastlines()`/`borders()` keep it *one call*: they fetch Natural Earth GeoJSON
  from jsDelivr (pinned NE release; `baseUrl` overridable) and draw via `lines()`.
  So: trivially easy by default, nothing in `dist/`. *Why GeoJSON, not our binary:*
  no infra needed (jsDelivr already mirrors NE); the cost is heavier transfer (10m
  ≈ 10 MB, ~2–3 MB gzipped by the CDN) + on-demand parse. *Production weight* is the
  app's call: pre-convert to the parse-free `pos/idx` binary, self-host, point
  `baseUrl` there (or feed `lines()` directly). Ship the mechanism, not the payload.
  Same pattern for the one optional code dep: `borders()` lazily imports
  `d3-geo-projection`'s `geoStitch` from a CDN on first use (un-cut antimeridian/
  polar splits) — `package.json` stays zero-dep, nothing in `dist/`, and only
  callers of stitched `borders()` pay for it (`stitch:false`/`stitch:fn` to opt out).
- v1 must-haves: fills, thick AA strokes, solid background sphere, hover picking,
  reference outlines (**coastlines + country borders**). **Orthographic only** for v1.
- Fill triangulation = **topology fan** (convex rings only — true of DGGS cells,
  country borders, etc.); concave fills later.
- **Minimal rendering core; UI composed on top** (§3).
- **Per-feature styling & identity substrate.** Style/identity is keyed by
  **feature** (point/line/polygon), not by "cell". One mechanism — a `featureId`
  vertex attribute + a per-feature style buffer the shader samples by id — serves
  restyle, per-feature opacity, and hover picking, identically across all three
  primitive types. *Why:* baking style per-vertex makes restyle an `nVerts`-sized
  geometry re-upload (~28 MB at ivea7h r6) and gives picking no id to read; the
  substrate makes restyle an `nFeatures` upload (~6× smaller, zero geometry
  touched) and M4 picking nearly falls out of it. *Consequence:* the core data
  model is GeoJSON-shaped primitives; cells/coastlines/borders are apps on top,
  not core concepts. Decided before M2 — retrofitting it later means rewriting the
  vertex format + both shaders + the upload path.
- **Geodesic-path substrate.** A line — standalone, or a polygon-boundary edge —
  is *always* a great-circle arc, represented by **slerp-in-xyz densification** of
  its unit-sphere anchors. One densifier feeds three consumers: polygon-fill
  boundaries, strokes (M3), and `lines()` (M5). *Why coordinate-free:* slerping
  unit vectors never touches lng/lat, so arcs are antimeridian/pole-immune by
  construction — same reason the topology fan is. Interpolating in lng/lat (the
  usual approach) is exactly what breaks at the seam; we never do it.
  - *Mechanism vs. policy:* slerp is the fixed mechanism; "how many segments" is a
    pluggable policy. **Default: static, angle-based**, sized so worst-case-zoom
    sag is sub-pixel — cheap (only long edges subdivide; ~1° DGGS edges get
    ~nothing), view-independent, preserves "build geometry once." **View-adaptive/
    dynamic LOD is deferred** (breaks build-once, needs hysteresis; profile first).
  - *CPU-at-upload, not GPU-at-draw (for now):* CPU densification yields real
    vertices that fills *and* strokes share; GPU vertex-shader slerp (segments as a
    uniform) would make dynamic LOD trivial and save memory but splits the fill and
    stroke paths. Keep the seam so a GPU/dynamic policy can replace the stroke
    path later without changing callers.
  - *Distinct from interior subdivision:* densifying a ring fixes the fill
    *silhouette*; it does **not** fix interior fan chords sinking below the depth
    sphere (§8). Two consumers of the same util, two different problems.

## 8. Known issues / gotchas

- **Inertia removed.** The first fling used a constant per-frame decay seeded with
  the *cumulative* drag delta, so a tiny drag coasted ~12× its length into a
  disorienting spin. Direct drag now (stops on release). A correct version must be
  **time-normalized** (angular velocity = Δangle/Δt, decay over a real time
  constant, capped, flick-threshold), and is deferred/opt-in.
- **Large-cell fills sinking below the depth sphere — FIXED in M2.** Flat fan
  triangles chord *inside* the unit sphere; sag ≈ 1−cos(θ/2). r5/r6 cells (θ≈1°)
  are fine; cells spanning ≳5° would dip below radius 0.998 and get occluded.
  `polygons()` now gates on the apex-spoke angle (folded into the fid pass) and,
  only when some cell trips it, subdivides those fan triangles and projects the
  new verts onto the sphere. r5/r6 stay on the flat fast path (build ~382 ms,
  unchanged). *Remaining limitation:* subdivision is uniform per triangle, so very
  coarse neighbours can leave hairline T-junctions (cosmetic; fine for fills).
- **Convex-only fills.** Topology fan assumes convexity (true for DGGS cells).
  Continents are **outline-only** (lines, no fill) so this isn't blocking;
  concave fills need spherical ear-clipping (later).
- **No explicit draw-order / `zIndex` (future improvement).** Stacking is fixed
  bands: background sphere → polygon **fills** → **lines** (lines always over fills;
  see `_renderScene`). Within a band, order = creation order, but the two bands
  behave differently: **lines** are a pure overlay (`depthMask(false)`) so they
  painter's-blend — *last created wins*; **fills** write depth at the same radius
  (1.0), so overlapping fills are governed by `depthFunc(LESS)` — *first-drawn wins*
  with z-fighting risk. Fine for non-overlapping tilings (DGGS cells, country
  polygons) and outline-over-fill, which is all we do today. Stacking
  **semi-transparent fills** (heatmap over a base choropleth) is the case that
  needs real work: add a per-layer `zIndex` and either a small per-layer radius
  offset, or make fills painter's-order (drop fill depth-write) like the lines.
  Reorder today by `remove()` + re-add in the desired order.
- **Headless benchmarking is finicky.** Driving a render loop from a single long
  `puppeteer evaluate` trips the protocol timeout / "promise collected". Use a
  *detached* spin that writes frame deltas to a global, let wall-clock pass (a
  screenshot works as a delay), then read with a plain sync `evaluate`. Also
  expose the instance (`window.orb`) for console/bench access.

## 9. Dev & test notes

- Serve (ESM + fetch need http, not file://):
  `uv run -m http.server 8080 -d /Users/aj/work/ajglobe` → `/examples/dggs-globe.html`
  (or `just test`). Examples import `../src/orb.js` directly — no build needed to dev.
- **Unit tests:** `just unit` (= `node --test`) — Node's built-in runner, zero deps.
  `test/` covers the pure geometry: `glmath` (slerp, quat, mat4-invert, lng/lat
  roundtrip), `geojsonLines`, and `Camera.project∘unproject` (headless via a stub
  canvas). Browser-only behavior (rendering/picking) stays covered by the headless
  example + the dist smoke test.
- **Build:** one-time `npm install` (pulls the only dev dep, **esbuild**), then
  `just build` (= `npm run build`) → `dist/ajglobe.min.js` (ESM) + `…iife.min.js`
  (+ sourcemaps), ~28 KB each, gitignored. The lazy `d3-geo-projection` CDN import
  stays external (`--external:https://*`) so the bundle is still zero-runtime-dep.
  `npm pack`/publish rebuilds `dist/` via `prepack`. `geojsonLines` is a public export.
- **Torture-test data** (`examples/data/`, gitignored) is generated by skar_py:
  `scripts/dggs_cache/web/gen_ivea7h_full_geom.py` (Rosetta/DGGAL, every cell) +
  `build_ivea7h_full_ar.py` (native skar → AR), then copied into `examples/data/`.
  Binary layout per resolution: `_pos.f32` = Float32 `[lng,lat,…]` (antimeridian-
  unwrapped, but xyz is periodic so it doesn't matter), `_idx.u32` = Uint32 ring
  start indices (len = nCells+1), `_ar.f32` = Float32 aspect ratio per cell.
- The ivea7h pole cell + antimeridian + 1.18M-cell perf is the permanent
  acceptance test: if it renders right and fast, the library is doing its job.
- **Two-globe demo** `examples/dggs-compare.html`: two rotationally + zoom synced
  globes (H3 res 1 vs res 2), cells colored by skar AR, hover → HUD with the H3 cell
  id + AR. Shows multi-`Orb` use, GPU picking, and view-sync on the public API:
  `a.on('viewchange', () => b.setView(a.getView()))` both ways — the idempotent
  `setView` swallows the echo, so no guard flag. Data from `scripts/`:
  `gen_cells_geom.py` (native H3 → `h3_r{n}_pos.f32`/`_idx.u32`/`_ids.json`) +
  `gen_cells_ar.py` (skar AR → `_ar.f32`, run in skar_py's env). All gitignored.

## 10. Open questions

- Stroke styling model: per-feature width/color vs per-layer only for v1?
- Picking at 1M+ cells: id-color FBO precision (24-bit ok) and read-back cadence.
- Reference assets: which Natural Earth resolution (110m default, 50m option?) for
  coastlines AND admin-0 country borders, and the build step to convert them to the
  vendored binary `pos/idx` layout.
- Eventual npm package name / scope.
