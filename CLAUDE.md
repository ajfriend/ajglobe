# ajglobe — session kickoff

**Read `PLAN.md` first.** It is the source of truth: thesis, current status,
architecture, API, roadmap, decisions, gotchas, and dev/test notes.

## One-line thesis
Correct, fast orthographic-globe rendering of polygons/lines. Never parameterize
to 2D — vertices are points on the unit sphere, fills triangulate by ring
*topology* (index fan), back hemisphere hidden by a depth sphere. So the
antimeridian and poles are correct *by construction*, no hacks.

## Where things stand
- **M1 (spike): done** — WebGL2, zero deps, ~460 lines. Verified on ivea7h r6
  (1.18M cells / 7M verts) at 60 FPS; pole cell fills; antimeridian clean.
- **M2 is next:** the composition surface — `project()`/`unproject()` + an event
  emitter (`on('hover'|'click'|'viewchange')`), then `layer.update()`, per-cell
  opacity, and large-cell fill subdivision. See PLAN §6.

## Run the example (the torture test / acceptance test)
```sh
uv run -m http.server 8080 -d .     # then open /examples/dggs-globe.html
```
Needs `examples/data/` binaries (gitignored). They persist locally; to
regenerate from scratch see PLAN §9 (skar_py gen scripts).

## House rules
- Minimal rendering core; all UI (buttons/legends/tooltips) is app code on top of
  the canvas — see PLAN §3. Don't add DOM chrome to `src/`.
- Zero runtime deps, vanilla ESM, WebGL2, no dev build step. JS + JSDoc, no TS.
- Headless benchmarking is finicky — use the detached-spin trick in PLAN §8.
