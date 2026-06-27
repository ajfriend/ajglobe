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
- A filled cell is triangulated by ring **topology** — a fan over vertex indices
  (`s, j, j+1`), which is coordinate-free — so it is immune to the seam, and a
  pole *inside* a convex cell is covered like any other interior point.
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
- Direct arcball drag + scroll zoom. (Inertia fling removed — see §8.)

Not yet committed to git (waiting on the go-ahead).

## 3. Design principles — minimal core, compose on top

**Settled.** The library is rendering + interaction + projection math only. It
owns nothing visual beyond the single `<canvas>` you hand it. All UI (buttons,
dialogs, legends, tooltips, color scales, data loading, layout) is app code,
built as ordinary DOM/framework siblings to the canvas — exactly like the HUD in
`examples/dggs-globe.html`, which is ~30 lines of plain DOM calling public
methods and required **zero** library involvement.

**The library owns** (all coupled to render/projection math; "solve it once"):
- Layers: `polygons()`, `lines()`, `layer.update()`, `layer.remove()`.
- Camera: `lookAt()`, get/set `rotation`/`zoom`, arcball drag + wheel zoom.
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
polygon fills (radius 1.0, depth-tested → back hemisphere occluded) → [strokes,
later]. Geometry is built once on `polygons()`; rotation is just a uniform.

## 5. Public API

Current:
```js
const orb = new Orb(canvas, { background:'#0b0e13', sphere:'#11151c' });
orb.polygons({ lnglat|xyz, starts, fill: i => [r,g,b,a] });  // returns layer{update?,remove}
orb.lookAt(lng, lat);
orb.stats; // {cells, verts}
```
Planned additions (the composition surface + features below).

## 6. Roadmap

- [x] **M1 — spike:** fills + depth sphere + arcball + zoom; pole/antimeridian
      proven on ivea7h r5/r6 at 60 FPS.
- [ ] **M2 — core API + composition surface**
  - [ ] `project(lng,lat)→{x,y,visible}` / `unproject(x,y)→{lng,lat}`
  - [ ] event emitter: `on('hover'|'click'|'viewchange', …)`
  - [ ] `layer.update({fill})` — recolor without re-tessellating
  - [ ] per-cell opacity; document `xyz` vs `lnglat` input
  - [ ] large-cell fill subdivision (see §8) so coarse cells don't sink below the
        depth sphere
- [ ] **M3 — thick AA strokes** (cell outlines): screen-space line quads, variable
      width, edge-alpha AA; great-circle densification for long edges
- [ ] **M4 — GPU hover picking:** offscreen id-color FBO + readPixels → feature
      index; wires into `on('hover'/'click')`
- [ ] **M5 — coastline helper + polish:** bundled low-res coastline asset,
      `coastlines()` helper, more examples, README, `dist/` esbuild bundle, basic
      geometry unit tests
- [ ] **Later:** time-normalized momentum (opt-in), concave polygon fills
      (spherical ear-clip), perspective/deep zoom, reuse the 3D core for 2D map
      projections, publish to npm

## 7. Decisions log

- **Standalone repo** at `/Users/aj/work/ajglobe`; name `ajglobe`. MIT.
- **WebGL2**, **zero runtime deps**, vanilla ESM, no dev build step; `esbuild`
  only to emit `dist/` later. JS + JSDoc (no TS toolchain).
- Math vendored (no gl-matrix).
- v1 must-haves: fills, thick AA strokes, solid background sphere, hover picking,
  continent outlines. **Orthographic only** for v1.
- Fill triangulation = **topology fan** (convex cells only); concave fills later.
- **Minimal rendering core; UI composed on top** (§3).

## 8. Known issues / gotchas

- **Inertia removed.** The first fling used a constant per-frame decay seeded with
  the *cumulative* drag delta, so a tiny drag coasted ~12× its length into a
  disorienting spin. Direct drag now (stops on release). A correct version must be
  **time-normalized** (angular velocity = Δangle/Δt, decay over a real time
  constant, capped, flick-threshold), and is deferred/opt-in.
- **Large-cell fills can sink below the depth sphere.** Flat fan triangles chord
  *inside* the unit sphere; sag ≈ 1−cos(θ/2). For r5/r6 cells (θ≈1°) sag ≪ the
  0.002 sphere gap, so they're fine. Cells spanning ≳5° (coarse DGGS, continents)
  will dip below radius 0.998 and get occluded → need fan-triangle subdivision +
  re-projection to the sphere (planned in M2).
- **Convex-only fills.** Topology fan assumes convexity (true for DGGS cells).
  Continents are **outline-only** (lines, no fill) so this isn't blocking;
  concave fills need spherical ear-clipping (later).
- **Headless benchmarking is finicky.** Driving a render loop from a single long
  `puppeteer evaluate` trips the protocol timeout / "promise collected". Use a
  *detached* spin that writes frame deltas to a global, let wall-clock pass (a
  screenshot works as a delay), then read with a plain sync `evaluate`. Also
  expose the instance (`window.orb`) for console/bench access.

## 9. Dev & test notes

- Serve (ESM + fetch need http, not file://):
  `uv run -m http.server 8080 -d /Users/aj/work/ajglobe` → `/examples/dggs-globe.html`
- **Torture-test data** (`examples/data/`, gitignored) is generated by skar_py:
  `scripts/dggs_cache/web/gen_ivea7h_full_geom.py` (Rosetta/DGGAL, every cell) +
  `build_ivea7h_full_ar.py` (native skar → AR), then copied into `examples/data/`.
  Binary layout per resolution: `_pos.f32` = Float32 `[lng,lat,…]` (antimeridian-
  unwrapped, but xyz is periodic so it doesn't matter), `_idx.u32` = Uint32 ring
  start indices (len = nCells+1), `_ar.f32` = Float32 aspect ratio per cell.
- The ivea7h pole cell + antimeridian + 1.18M-cell perf is the permanent
  acceptance test: if it renders right and fast, the library is doing its job.

## 10. Open questions

- Stroke styling model: per-feature width/color vs per-layer only for v1?
- Picking at 1M+ cells: id-color FBO precision (24-bit ok) and read-back cadence.
- Coastline asset: which resolution (Natural Earth 110m?) and where to vendor it.
- Eventual npm package name / scope.
