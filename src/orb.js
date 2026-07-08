// ajglobe — correct, fast orthographic globe rendering for polygons, lines & points.
//
// The thesis: never parameterize to 2D. Vertices are points on the unit sphere
// (lng/lat -> xyz once), fills are triangulated by ring TOPOLOGY (a fan over
// vertex indices, coordinate-free), and the back hemisphere is hidden by an
// opaque screen-parallel depth disk. So the antimeridian and the poles need no special cases —
// they're just points, and a pole that lies inside a convex cell is covered by
// that cell's fan like any other interior point.
//
// Per-feature style substrate: each vertex carries a featureId; color lives in a
// per-feature texture sampled by id, so a restyle (layer.update) touches nFeatures
// texels, never the geometry. The same featureId drives GPU picking. Three
// primitives — polygons (fills), lines (thick AA strokes), points (disc markers).

import { lnglatToVec3, lnglatToVec3Into, vec3, quat, DEG, circlePointsInto } from './glmath.js';
import { triangulatePolygon, subdivideTri, fanFillGeometry, COS_SPOKE_GATE } from './tess.js';
import { Camera } from './camera.js';

// Re-export the pure geo helpers so consumers get them from the package entry
// alongside Orb: the view converters (core view format is { q, zoom }; these
// translate the rotation to/from a human-readable { lng, lat, roll }), the
// lng/lat <-> unit-xyz converters (the documented xyz input path needs them),
// the vec3 helpers (slerp/cross/tangent — arrows, centroids, custom geometry),
// and the camera framing MARGIN (framed embeds set zoom: MARGIN to fill the box).
export { lnglatToQuat, quatToLngLat, lnglatToVec3, vec3ToLngLat, vec3 } from './glmath.js';
export { MARGIN } from './camera.js';

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src);
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  // Flag the shaders for deletion: they stay alive inside the linked program and
  // are freed with it (gl.deleteProgram), so they don't leak after the link.
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

// Shared fragment-shader fragments (GLSL has no #include, so concatenate). Keeping
// these in one place stops the fill/point pair from drifting on the per-feature
// style lookup, and the two pick shaders from drifting on the id encoding (the
// pick protocol both must agree on). Each expects the matching uniforms/varyings.
const STYLE_LOOKUP_GLSL = `
  int fid = int(v_fid);
  vec4 c = texelFetch(u_style, ivec2(fid % u_styleW, fid / u_styleW), 0);
  if (fid == u_hoverId) c.rgb = mix(c.rgb, vec3(1.0), 0.5);`;   // u_style/u_styleW/u_hoverId/v_fid -> vec4 c
const PACK_ID_GLSL = `
  uint id = v_fid + u_idBase + 1u;
  o_color = vec4(float(id & 0xFFu), float((id >> 8) & 0xFFu),
                 float((id >> 16) & 0xFFu), float((id >> 24) & 0xFFu)) / 255.0;`;   // v_fid/u_idBase -> RGBA8

// Explicit attribute locations so the fill VAOs can be drawn by the pick program
// too (GPU picking, M4) — both programs must agree on a_pos / a_featureId.
const FILL_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in uint a_featureId;
uniform mat4 u_mvp;
flat out uint v_fid;
void main() {
  v_fid = a_featureId;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

// Color is fetched from the per-feature style texture by id (row-major, width
// u_styleW). texelFetch + NEAREST means an exact lookup, no filtering. The feature
// matching u_hoverId (-1 = none) is tinted toward white for a free hover highlight.
const FILL_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_style;
uniform int u_styleW;
uniform int u_hoverId;
flat in uint v_fid;
out vec4 o_color;
void main() {${STYLE_LOOKUP_GLSL}
  o_color = c;
}`;

// Picking: draw the fills (reusing FILL_VS for the vertex stage) but write each
// feature's id as a color into an offscreen buffer (M4). id = featureId + u_idBase
// + 1, so 0 reads back as "nothing".
const PICK_FS = `#version 300 es
precision highp float;
precision highp int;
uniform uint u_idBase;
flat in uint v_fid;
out vec4 o_color;
void main() {${PACK_ID_GLSL}
}`;

const DISK_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 o_color;
void main() { o_color = u_color; }`;

const DISK_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`;

// Thick AA strokes: expand each segment to a screen-space quad of constant pixel
// width. Project both endpoints, take the screen-space perpendicular, and offset
// this vertex by side * (halfWidth + 1px AA pad). v_dist carries the signed pixel
// distance from the centerline so the fragment shader can feather the edges.
// Strokes and points sit ON the unit sphere (radius 1.0, same surface as fills)
// and win the depth test via a small constant NDC bias applied in the vertex
// shader — NOT a radial lift. A radial lift moves geometry sideways in screen
// space at the limb (lines visibly float off the silhouette) while its depth
// component vanishes there (radial ⊥ view) — weakest exactly where z-fighting
// is worst. The NDC bias displaces nothing and is uniformly effective at every
// view angle. Size: must exceed the worst chord sag of densified stroke
// segments below the sphere ((1−cos(MAX_SEG/2)) ≈ 5e-5 world ≈ 1e-5 NDC at the
// ortho depth scale) plus depth quantization; small enough that the back-
// hemisphere wraparound it allows (view z > −bias/depthScale ≈ −0.0025) stays
// sub-pixel at the limb. MAX_SEG lives here so retuning it confronts this bound.
//
// MAX_SEG sizes the straight screen chords every curve is drawn as. The eye is
// far more sensitive to sub-pixel wobble on mathematically smooth curves
// (graticule circles, range rings) than on irregular ones (coastlines): 0.05
// gave ~3° kinks every ~36 px at zoom 1 and read as aliasing. 0.02 puts chord
// deviation at ~0.04 px (zoom 1) for ~2.5× the vertices on long-segment
// curves — trivial against reference-layer sizes.
const MAX_SEG = 0.02;             // rad; lines() densifies longer edges into arcs
const DEPTH_BIAS_GLSL = `  gl_Position.z -= 0.0005 * gl_Position.w;`;

const STROKE_VS = `#version 300 es
in vec2 a_param;            // per-quad-corner: x: end (0=A, 1=B), y: side (-1/+1)
in vec3 a_pA;               // per-instance (one instance = one segment)
in vec3 a_pB;
in vec2 a_arc;              // cumulative arc length at A and B, radians
uniform mat4 u_mvp;
uniform vec2 u_viewport;    // device px
uniform float u_hw;         // stroke half-width, device px
out float v_dist;
out float v_len;
void main() {
  vec4 ca = u_mvp * vec4(a_pA, 1.0);
  vec4 cb = u_mvp * vec4(a_pB, 1.0);
  vec2 sa = ca.xy / ca.w * u_viewport * 0.5;
  vec2 sb = cb.xy / cb.w * u_viewport * 0.5;
  vec2 dir = sb - sa;
  float len = length(dir);
  vec2 nrm = len > 1e-5 ? vec2(-dir.y, dir.x) / len : vec2(0.0);
  vec4 clip = a_param.x < 0.5 ? ca : cb;
  float w = u_hw + 1.0;     // +1px so the AA ramp has room
  clip.xy += (nrm * a_param.y * w) / (u_viewport * 0.5) * clip.w;
  gl_Position = clip;
${DEPTH_BIAS_GLSL}
  v_dist = a_param.y * w;
  v_len = mix(a_arc.x, a_arc.y, a_param.x);
}`;

// Dashing: u_dash = (period, on-fraction) with lengths in device px; (0,0) =
// solid. v_len is WORLD arc length (radians), scaled to px by u_pxPerRad =
// device px per radian of arc at the globe center — so dashes keep their pixel
// size while zooming, like SVG dasharray. Measured along the great-circle arc,
// not the projected path, so dashes compress a little toward the limb
// (foreshortening); acceptable for annotation strokes.
const STROKE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_hw;
uniform vec2 u_dash;        // (period px, on-fraction); (0,0) = solid
uniform float u_pxPerRad;   // device px per radian of arc at globe center
in float v_dist;
in float v_len;
out vec4 o_color;
void main() {
  if (u_dash.x > 0.0 && fract(v_len * u_pxPerRad / u_dash.x) > u_dash.y) discard;
  float cov = clamp(u_hw + 0.5 - abs(v_dist), 0.0, 1.0);   // 1px edge feather
  if (cov <= 0.0) discard;
  o_color = vec4(u_color.rgb, u_color.a * cov);
}`;

// Points (M6): each marker is a screen-space round disc of constant pixel radius,
// billboarded around its unit-sphere center like a stroke quad — offset clip.xy by
// the corner, keep the center's clip.z/w so the disc takes the center's depth (back
// hemisphere hidden by the depth disk). Explicit attribute locations so the same
// VAO drives both the color and the pick program (like FILL_VS).
const POINT_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;     // unit-quad corner (-1/+1, -1/+1); per-vertex
layout(location = 1) in vec3 a_center;     // unit-sphere xyz; per-instance (one per point)
layout(location = 2) in float a_radius;    // disc radius, CSS px; per-instance
uniform mat4 u_mvp;
uniform vec2 u_viewport;   // device px
uniform float u_dppx;      // device px per CSS px (radius is CSS px)
flat out uint v_fid;
out vec2 v_off;            // device-px offset from the disc center
out float v_rad;           // disc radius, device px
void main() {
  v_fid = uint(gl_InstanceID);   // feature id == point index — no buffer needed
  float rad = a_radius * u_dppx;
  float pad = rad + 1.0;            // +1px so the AA ramp has room
  v_rad = rad;
  v_off = a_corner * pad;
  vec4 clip = u_mvp * vec4(a_center, 1.0);
  clip.xy += (a_corner * pad) / (u_viewport * 0.5) * clip.w;
  gl_Position = clip;
${DEPTH_BIAS_GLSL}
}`;

// Round disc with a 1px radial AA edge (radial analog of STROKE_FS). Color/alpha from
// the per-feature style texture by id (identical lookup to FILL_FS), hover white-tint.
const POINT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_style;
uniform int u_styleW;
uniform int u_hoverId;
flat in uint v_fid;
in vec2 v_off;
in float v_rad;
out vec4 o_color;
void main() {
  float cov = clamp(v_rad + 0.5 - length(v_off), 0.0, 1.0);
  if (cov <= 0.0) discard;${STYLE_LOOKUP_GLSL}
  o_color = vec4(c.rgb, c.a * cov);
}`;

// Pick pass for points: same disc cutoff (so the pickable area == the visible disc),
// then write the shared id encoding.
const POINTPICK_FS = `#version 300 es
precision highp float;
precision highp int;
uniform uint u_idBase;
flat in uint v_fid;
in vec2 v_off;
in float v_rad;
out vec4 o_color;
void main() {
  if (length(v_off) > v_rad + 0.5) discard;${PACK_ID_GLSL}
}`;

function hexRGBA(c) {
  if (Array.isArray(c)) return c.length === 4 ? c : [...c, 255];
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16), 255];
}
// Color -> 0..1 RGBA (GL float color). Coerce a value-or-fn into a fn.
const rgbaF = (c) => hexRGBA(c).map((x) => x / 255);
const asFn = (v) => (typeof v === 'function' ? v : () => v);

// Default CDN for the coastlines()/borders() convenience helpers: Natural Earth
// vector GeoJSON via jsDelivr, pinned to a release. No data is bundled — these are
// fetched on demand. Override with the `baseUrl` option (e.g. self-hosted assets).
const DEFAULT_NE = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson';

// Flatten a GeoJSON FeatureCollection into the layout orb.lines() wants:
// { lnglat:[lng,lat,...], starts:[polyline start indices] }. Lines map directly;
// polygon rings (exterior + holes) each become a closed polyline outline.
export function geojsonLines(gj) {
  const lng = [], starts = [0];
  const push = (coords) => { for (const c of coords) lng.push(c[0], c[1]); starts.push(lng.length / 2); };
  for (const f of (gj.features || [])) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString') push(g.coordinates);
    else if (g.type === 'MultiLineString') for (const line of g.coordinates) push(line);
    else if (g.type === 'Polygon') for (const ring of g.coordinates) push(ring);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const ring of poly) push(ring);
  }
  return { lnglat: new Float32Array(lng), starts: new Uint32Array(starts) };
}

// Closed small circles around a shared center — every point at angular radius
// (degrees) from `center` [lng, lat] — as { xyz, starts } for lines().
// radius: number | number[], one ring per entry, so a range-ring set is one
// call (and one layer). Coordinate-free: rings are sampled in the canonical
// pole frame and rotated onto the center axis (quat.fromUnitVectors owns the
// degenerate antiparallel case) — no lng/lat parameterization, so no
// antimeridian/pole seam. A small circle is NOT a geodesic, and lines() draws
// geodesic chords between anchors, so fidelity comes from the sampling step:
// Δt = MAX_SEG/√sinθ keeps the chords' deviation from the circle within
// MAX_SEG²/8 — the geodesic densifier's own chord budget. One fidelity
// constant owns every curve; at θ = 90° (a great circle) this converges to
// the geodesic policy exactly.
export function smallCircleLines({ center, radius }) {
  const axis = lnglatToVec3(center[0], center[1]);
  const xyz = [], starts = [0];
  for (const deg of Array.isArray(radius) ? radius : [radius]) {
    // clamp to the sphere's valid range: outside it, sin(θ) < 0 poisons the
    // segment count with NaN and the returned buffer with undefined slots
    const th = Math.min(180, Math.max(0, deg)) * DEG;
    const segs = Math.max(8, Math.ceil((2 * Math.PI) * Math.sqrt(Math.sin(th)) / MAX_SEG));
    const ring0 = xyz.length;
    circlePointsInto(xyz, axis, th, segs);
    xyz.push(xyz[ring0], xyz[ring0 + 1], xyz[ring0 + 2]);   // close the ring bitwise
    starts.push(xyz.length / 3);
  }
  return { xyz: new Float32Array(xyz), starts: new Uint32Array(starts) };
}

// Graticule polylines (meridians + parallels) as { xyz, starts }, ready for
// lines(). Pure geometry, no data. Meridians are geodesics, so each is just
// its two endpoints — lines() densifies them like any segment; parallels are
// one multi-radius smallCircleLines call around the pole (its header explains
// the fidelity). Meridians span ±latLimit so they don't pile up at the poles
// (d3-geo's graticule trims the same way); parallels sit at symmetric
// multiples of step, so the equator is always included.
export function graticuleLines({ step = 10, latLimit = 80 } = {}) {
  const xyz = [], starts = [0];
  for (let lng = -180; lng < 180; lng += step) {         // meridians (geodesic)
    xyz.push(...lnglatToVec3(lng, -latLimit), ...lnglatToVec3(lng, latLimit));
    starts.push(xyz.length / 3);
  }
  const latMax = Math.floor(latLimit / step) * step;
  const radii = [];
  for (let lat = -latMax; lat <= latMax; lat += step) radii.push(90 - lat);
  const par = smallCircleLines({ center: [0, 90], radius: radii });
  const base = xyz.length / 3;
  for (const v of par.xyz) xyz.push(v);
  for (let i = 1; i < par.starts.length; i++) starts.push(base + par.starts[i]);
  return { xyz: new Float32Array(xyz), starts: new Uint32Array(starts) };
}

// d3-geo's geoStitch, loaded lazily from a CDN the first time borders() needs it
// (pay-per-use — the core ships no dependency). It un-cuts the antimeridian/polar
// splits that GeoJSON polygons carry for 2D validity (Russia, Antarctica), turning
// them back into proper spherical rings — which is what we draw. Cached after load.
//
// The import goes through new Function so it is OPAQUE TO BUNDLERS: a literal
// import('https://…') in the dist bundle makes webpack fail every consumer's
// build ("Module not found") even if borders() is never called, and esbuild's
// --minify strips any /* webpackIgnore */ comment that could prevent it. The
// indirection only executes when stitching actually runs; environments with a
// strict CSP (no 'unsafe-eval') should pass their own `stitch: fn` instead.
let _stitch;
async function loadStitch() {
  if (!_stitch) {
    const dynamicImport = new Function('u', 'return import(u)');   // built here, not at module load
    _stitch = (await dynamicImport('https://cdn.jsdelivr.net/npm/d3-geo-projection@4/+esm')).geoStitch;
  }
  return _stitch;
}
// Apply a geoStitch fn per feature-geometry (robust across GeoJSON shapes).
function applyStitch(geoStitch, gj) {
  if (gj.type !== 'FeatureCollection') return geoStitch(gj);
  return { type: 'FeatureCollection', features: gj.features.map((f) =>
    f.geometry ? { ...f, geometry: geoStitch(f.geometry) } : f) };
}

// Disk triangle fan in the z=0 plane (the depth disk: drawn without the model
// rotation, so it stays parallel to the screen).
function unitDisk(r, segments = 128) {
  const pos = [0, 0, 0], idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    pos.push(r * Math.cos(a), r * Math.sin(a), 0);
  }
  for (let i = 1; i <= segments; i++) idx.push(0, i, i + 1);
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

export class Orb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    // alpha: false — the canvas owns its background (§3), so it composites as
    // an opaque element. With a transparent-capable canvas the browser treats
    // the framebuffer as PREMULTIPLIED and re-blends it against the page, and
    // normal blending pollutes destination alpha (a 0.3-alpha fill leaves
    // dst_a = 0.3² + 0.7 = 0.79) — every translucent fill/stroke washed toward
    // the page color. Offscreen FBOs (snapshot, picking) are unaffected.
    const gl = canvas.getContext('webgl2', { antialias: true, depth: true, alpha: false });
    if (!gl) throw new Error('WebGL2 required');
    this.gl = gl;
    this.bg = rgbaF(opts.background || '#0b0e13');
    this.diskColor = rgbaF(opts.sphere || '#11151c');   // public key 'sphere' names the visual globe body; drawn as the depth disk

    // Programs + their uniform names (each is `u_<key>` in GLSL), built in one pass
    // and stored as this.<name>Prog / this.<name>U (location maps, resolved once).
    const PROGRAMS = {
      fill:      [FILL_VS, FILL_FS,        ['mvp', 'style', 'styleW', 'hoverId']],
      disk:      [DISK_VS, DISK_FS,        ['mvp', 'color']],
      stroke:    [STROKE_VS, STROKE_FS,    ['mvp', 'viewport', 'hw', 'color', 'dash', 'pxPerRad']],
      pick:      [FILL_VS, PICK_FS,        ['mvp', 'idBase']],          // same vertex stage as fills
      point:     [POINT_VS, POINT_FS,      ['mvp', 'viewport', 'dppx', 'style', 'styleW', 'hoverId']],
      pointPick: [POINT_VS, POINTPICK_FS,  ['mvp', 'viewport', 'dppx', 'idBase']],   // same vertex stage as points
    };
    this._progNames = Object.keys(PROGRAMS);
    for (const [name, [vs, fs, keys]] of Object.entries(PROGRAMS)) {
      const prog = program(gl, vs, fs);
      this[name + 'Prog'] = prog;
      this[name + 'U'] = Object.fromEntries(keys.map((k) => [k, gl.getUniformLocation(prog, 'u_' + k)]));
    }
    this.dpr = 1;
    this._hoverId = -1;        // feature to highlight (-1 = none)
    this._hoverLayer = null;   // layer the highlight is scoped to (null = all)
    this._frameId = 0;         // frame counter (gates pick-buffer rebuilds)
    this._pickFrame = -1;      // frame the pick buffer was last rebuilt in
    this._pick = null;         // offscreen id-buffer { fbo, tex, rbo, w, h }
    this._pickValid = false;   // stale when the view / layers / size change
    this._pickPixel = new Uint8Array(4);   // reused readback scratch (per-pointer)
    this._buildDisk();

    // Shared unit-quad corner buffers for instanced strokes/points, in
    // TRIANGLE_STRIP order. One 4-vertex buffer each for the whole Orb; every
    // stroke/point layer wires it into its VAO at divisor 0 while the real
    // data advances per instance.
    const quad = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return b;
    };
    this._strokeQuad = quad([0, -1, 0, 1, 1, -1, 1, 1]);     // (end, side)
    this._pointQuad = quad([-1, -1, 1, -1, -1, 1, 1, 1]);    // (corner x, y)

    this.layers = [];
    this.lineLayers = [];
    this.pointLayers = [];
    this._handlers = {};   // event buckets are created lazily by on() — see there for the event list
    // One AbortController removes every canvas listener (Orb's + Camera's) on destroy().
    this._destroyed = false;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    // The camera's single notify channel feeds the orb emitter; redraw-on-
    // viewchange is Orb policy, not something the camera knows about.
    this.cam = new Camera(canvas, (type, e) => {
      if (type === 'viewchange') this._invalidate();
      this._emit(type, e);
    }, signal, opts.interaction);
    this._dirty = true;
    // Hover/click are single-cursor concepts: ignore secondary fingers, which
    // would otherwise jitter hover and clobber downAt during a pinch.
    canvas.addEventListener('pointermove', (e) => { if (e.isPrimary === false) return; this._emitPointer('hover', e); }, { signal });
    // 'click' means "the user clicked a spot", not the raw DOM event: the DOM
    // fires click on every press+release pair, including releasing an arcball
    // drag — an artifact of the library's own interaction that every consumer
    // would otherwise have to suppress. Swallow clicks whose pointer travelled.
    let downAt = null;
    canvas.addEventListener('pointerdown', (e) => { if (e.isPrimary === false) return; downAt = [e.offsetX, e.offsetY]; }, { signal });
    canvas.addEventListener('click', (e) => {
      if (downAt && Math.hypot(e.offsetX - downAt[0], e.offsetY - downAt[1]) > 4) return;
      this._emitPointer('click', e);
    }, { signal });

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    // Per-feature opacity: fill's alpha rides in the style texture; blend it over
    // the depth disk. Cells don't overlap, so straight alpha needs no sorting.
    gl.enable(gl.BLEND);
    // separate alpha blend: dst alpha composites 'over' (src_a + dst_a(1−src_a))
    // instead of inheriting the color factors — keeps offscreen-FBO alpha sane
    // (transparent snapshots previously dipped below 255 under AA strokes).
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(...this.bg);

    this._resize();
    this._resizeObs = new ResizeObserver(() => { this._resize(); this._invalidate(); });
    this._resizeObs.observe(canvas);
    const loop = () => { if (this._destroyed) return; this._frame(); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  // Tear down: stop the render loop, detach every listener, and free all GPU
  // resources. Call when removing the globe (component unmount, route change).
  // Idempotent; the Orb is unusable afterwards. The WebGL context is left intact
  // so the same canvas can host a new Orb.
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    this._abort.abort();              // removes all canvas listeners (Orb + Camera)
    this._resizeObs.disconnect();
    const gl = this.gl;
    [...this.layers, ...this.lineLayers, ...this.pointLayers].forEach((l) => l.remove());   // VAOs, buffers, style textures
    if (this._pick) { this._freeTarget(this._pick); this._pick = null; }
    gl.deleteVertexArray(this.diskVAO);
    this._diskBuffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteBuffer(this._strokeQuad);
    gl.deleteBuffer(this._pointQuad);
    for (const n of this._progNames) gl.deleteProgram(this[n + 'Prog']);
  }

  // Free a layer's GPU resources (VAO, attribute/index buffers, style texture if
  // any). Shared teardown for polygons()/lines()/points() remove(); the caller owns
  // dropping the layer from its array and the right invalidation.
  _freeLayer(layer) {
    const gl = this.gl;
    gl.deleteVertexArray(layer.vao);
    layer._buffers.forEach((b) => gl.deleteBuffer(b));
    if (layer.styleTex) gl.deleteTexture(layer.styleTex);
  }

  // Create an ARRAY_BUFFER and wire it to a vertex attribute on the bound VAO.
  // opts: int (vertexAttribIPointer — ids pass through unconverted), divisor
  // (instanced: advance per instance, not per vertex), buf (wire an EXISTING
  // buffer — the shared quad corners — instead of creating one; a shared buffer
  // is owned by the Orb, so don't add it to the layer's _buffers).
  _attrib(prog, name, data, size, { type, int = false, divisor = 0, buf = null } = {}) {
    const gl = this.gl;
    const b = buf ?? gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    if (!buf) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    if (int) gl.vertexAttribIPointer(loc, size, type, 0, 0);
    else gl.vertexAttribPointer(loc, size, type ?? gl.FLOAT, false, 0, 0);
    if (divisor) gl.vertexAttribDivisor(loc, divisor);
    return b;
  }

  // Create an ELEMENT_ARRAY_BUFFER (indices) on the bound VAO.
  _elements(data) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  // Vertex i as unit-sphere xyz, from either an xyz or an lng/lat position array.
  _posAt(xyz, lnglat, i) {
    return xyz ? [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]
      : lnglatToVec3(lnglat[i * 2], lnglat[i * 2 + 1]);
  }

  // Pack one RGBA8 texel per feature from the fill value, row-major into `data`
  // (retained by _makeStyle and rewritten in place on restyle — no per-restyle
  // allocation at DGGS scale). A constant color parses once; only a per-feature
  // fn pays the n× call + parse cost.
  _buildStyle(n, data, fill) {
    const cc = typeof fill === 'function' ? null : hexRGBA(fill);
    for (let c = 0; c < n; c++) {
      const col = cc || hexRGBA(fill(c));
      data[c * 4] = col[0]; data[c * 4 + 1] = col[1];
      data[c * 4 + 2] = col[2]; data[c * 4 + 3] = col[3];
    }
    return data;
  }

  // NEAREST RGBA8 texture used as the per-feature style lookup (sampled by id).
  _styleTexture(W, H, data) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return tex;
  }

  // Per-feature style substrate (shared by polygons() and points()): an RGBA8
  // texture, one texel per feature indexed by id, plus an in-place `restyle(fn)`
  // that rewrites the texels without touching geometry. colorFn/fn: (i) => color.
  _makeStyle(n, colorFn) {
    const gl = this.gl;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const W = Math.min(maxTex, 4096);
    const H = Math.max(1, Math.ceil(n / W));
    if (H > maxTex) throw new Error(`too many features for one style texture: ${n}`);
    const data = new Uint8Array(W * H * 4);      // retained; rewritten in place on restyle
    const tex = this._styleTexture(W, H, this._buildStyle(n, data, colorFn));
    const restyle = (f) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE,
        this._buildStyle(n, data, f));
      this._dirty = true;
    };
    return { tex, W, H, restyle };
  }

  _buildDisk() {
    const gl = this.gl;
    // The depth disk: an opaque unit disk in the screen-parallel plane through
    // the origin (drawn with projection·view only — no model rotation). In
    // orthographic projection the visible/hidden boundary IS that plane, so the
    // disk occludes the back hemisphere exactly (any fragment with view z < 0
    // loses the depth test), supplies the solid globe color, and plugs gaps —
    // everything the old 0.998 depth sphere did, with one less radius constant.
    // Fills can never sink behind it (see subdivideTri's header + PLAN §7 for
    // the convexity argument). Orthographic-only by design (§7: ortho is
    // permanent). Radius COS_SPOKE_GATE = cos(MAX_FILL_EDGE/2) — the worst-case
    // radius of a subdivided fill boundary's chord — so the disk rim always
    // tucks behind the fill rim instead of peeking past it as a hairline of
    // globe color at the silhouette (the old 0.998 sphere's guarantee, derived).
    const m = unitDisk(COS_SPOKE_GATE);
    this.diskCount = m.idx.length;
    this.diskVAO = gl.createVertexArray();
    gl.bindVertexArray(this.diskVAO);
    const pb = this._attrib(this.diskProg, 'a_pos', m.pos, 3);
    const ib = this._elements(m.idx);
    this._diskBuffers = [pb, ib];   // kept so destroy() can free them
    gl.bindVertexArray(null);
  }

  // Add a filled-polygon layer.
  //   xyz | lnglat : Float32Array positions (3/vertex unit xyz, or 2/vertex lng,lat)
  //   starts       : Uint32Array ring start indices (len = nRings + 1); open
  //                  rings — no repeated closing point
  //   polys        : optional ring-group indices into starts (len = nFeatures+1).
  //                  Without it, every ring is one CONVEX feature (the DGGS fast
  //                  path: topology-fan fills). With it, each feature is one
  //                  polygon of one-or-more rings (outer + holes), triangulated
  //                  by src/tess.js — concave shapes and holes render correctly,
  //                  at annotation scale (hundreds of verts per polygon).
  //   fill         : (featureIndex) => [r,g,b,a] | '#rrggbb' | constant
  // Returns the layer; layer.update({fill}) restyles (no re-tessellation),
  // layer.remove() frees it.
  polygons({ xyz, lnglat, starts, polys, fill }) {
    const nFeatures = polys ? polys.length - 1 : starts.length - 1;
    const nVerts = xyz ? xyz.length / 3 : lnglat.length / 2;

    // positions -> unit-sphere xyz
    let pos;
    if (xyz) {
      pos = xyz;
    } else {
      pos = new Float32Array(nVerts * 3);
      for (let v = 0; v < nVerts; v++) {
        lnglatToVec3Into(pos, v * 3, lnglat[v * 2], lnglat[v * 2 + 1]);
      }
    }

    if (polys) return this._polygonsTess({ pos, starts, polys, nFeatures, fill });

    // Fan triangulation + per-cell coarseness dispatch live in tess.js (pure,
    // unit-tested there). Style is NOT baked into the geometry — it lives in a
    // per-feature texture sampled by id, so a restyle rewrites nFeatures texels
    // and never touches these buffers.
    const g = fanFillGeometry(pos, starts, nFeatures);
    return this._fillLayer(g.pos, g.fids, g.idx, nFeatures, fill);
  }

  // Ring-grouped (concave/holed) polygons: triangulate each group with
  // src/tess.js, then push every triangle through subdivideTri like the fan
  // path (curved boundaries + limb coverage are the same need either way).
  _polygonsTess({ pos, starts, polys, nFeatures, fill }) {
    const P = Array.from(pos), F = new Array(pos.length / 3).fill(0), I = [];
    for (let p = 0; p < nFeatures; p++) {
      const rings = [];
      for (let r = polys[p]; r < polys[p + 1]; r++) rings.push([starts[r], starts[r + 1]]);
      if (!rings.length) continue;                    // empty ring group: nothing to fill
      for (let v = rings[0][0]; v < rings[rings.length - 1][1]; v++) F[v] = p;
      const tris = triangulatePolygon(P, rings);      // may append new vertices
      while (F.length < P.length / 3) F.push(p);
      for (let t = 0; t < tris.length; t += 3) subdivideTri(P, F, I, p, tris[t], tris[t + 1], tris[t + 2]);
    }
    return this._fillLayer(new Float32Array(P), new Uint32Array(F), new Uint32Array(I), nFeatures, fill);
  }

  // Shared tail of the fill paths: style texture, VAO, layer handle.
  _fillLayer(pos, fids, idx, nFeatures, fill) {
    const gl = this.gl;
    // Per-feature style: one RGBA8 texel per feature, indexed by id (restyle just
    // rewrites those texels; geometry is untouched).
    const { tex: styleTex, W, H, restyle } = this._makeStyle(nFeatures, fill);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = this._attrib(this.fillProg, 'a_pos', pos, 3);
    const fb = this._attrib(this.fillProg, 'a_featureId', fids, 1, { int: true, type: gl.UNSIGNED_INT });
    const ib = this._elements(idx);
    gl.bindVertexArray(null);

    const layer = {
      vao, count: idx.length, nFeatures, nVerts: pos.length / 3,
      styleTex, styleW: W, styleH: H, _buffers: [pb, fb, ib],
    };
    layer.update = ({ fill: f } = {}) => { if (f != null) restyle(f); return layer; };
    layer.remove = () => {
      this.layers = this.layers.filter((l) => l !== layer);
      this._freeLayer(layer);
      this._invalidate();
    };
    this.layers.push(layer);
    this._invalidate();
    return layer;
  }

  // Add a polyline layer drawn as thick, antialiased great-circle strokes (M3).
  // Each segment is expanded to a screen-space quad of constant pixel width with
  // edges feathered for AA (see STROKE_VS/FS), and long segments are slerp-
  // densified so the stroke follows the great-circle arc. Strokes sit ON the unit
  // sphere, drawn over fills via the shader depth bias (why: see DEPTH_BIAS_GLSL)
  // and depth-tested against the depth disk (back-hemisphere strokes hidden).
  // Coordinate-free: drawn in 3D, so the antimeridian is just adjacent points on
  // the sphere — no unwrap, no seam.
  //   xyz | lnglat : Float32Array positions (3/vertex unit xyz, or 2/vertex lng,lat)
  //   starts       : Uint32Array polyline start indices (len = nLines + 1)
  //   color        : '#rrggbb' | [r,g,b,a]
  //   width        : stroke width in CSS pixels (default 1.5)
  //   dash         : [onPx, offPx] in CSS px (dash phase restarts per polyline;
  //                  measured along the arc — see STROKE_FS), or null for solid
  lines({ xyz, lnglat, starts, color = '#ffffff', width = 1.5, dash = null }) {
    const gl = this.gl;
    const nLines = starts.length - 1;
    const nVerts = xyz ? xyz.length / 3 : lnglat.length / 2;

    // positions -> unit-sphere xyz, once (as polygons() does) — both passes
    // below read this instead of re-deriving per pass
    let pos = xyz;
    if (!pos) {
      pos = new Float32Array(nVerts * 3);
      for (let v = 0; v < nVerts; v++) lnglatToVec3Into(pos, v * 3, lnglat[v * 2], lnglat[v * 2 + 1]);
    }
    const vec = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

    // Instanced: ONE record per drawn segment — both endpoints and, when dashed,
    // the cumulative arc length at each end. The shared 4-corner a_param buffer
    // (divisor 0) expands each instance to a screen-space quad in the vertex
    // shader, so nothing repeats across quad corners and there is no index
    // buffer — ~5x less GPU data than the old 4-vertex + 6-index expansion.
    // Sub-segment lengths come from the densification analytically (slerp is
    // uniform in angle, so each of the n pieces is ang/n). Undashed layers skip
    // the arc buffer entirely: with the attribute array disabled (the VAO
    // default) the shader reads the constant 0, and u_dash = (0,0) never tests
    // it. A counting pass sizes the typed buffers exactly, so there are no JS
    // staging arrays (the 10m coastline's ~400k segments used to stage in
    // plain arrays before conversion); it stashes each edge's angle and piece
    // count so the build pass doesn't recompute them. Measured on the 10m
    // coastline: 61.8 -> 9.8 MB GPU.
    let nSegs = 0;
    const eN = [], eA = [];           // per input edge: slerp piece count, angle
    for (let l = 0; l < nLines; l++) {
      const s = starts[l], e = starts[l + 1];
      if (e - s < 2) continue;
      let prev = vec(s);
      for (let i = s + 1; i < e; i++) {
        const cur = vec(i);
        const ang = vec3.angle(prev, cur);
        const n = Math.max(1, Math.ceil(ang / MAX_SEG));
        eN.push(n); eA.push(ang); nSegs += n;
        prev = cur;
      }
    }

    const PA = new Float32Array(nSegs * 3), PB = new Float32Array(nSegs * 3);
    const ARC = dash ? new Float32Array(nSegs * 2) : null;
    let seg = 0, ei = 0;
    for (let l = 0; l < nLines; l++) {
      const s = starts[l], e = starts[l + 1];
      if (e - s < 2) continue;
      let a = vec(s), arc = 0;        // arc length restarts per polyline (dash phase)
      for (let i = s + 1; i < e; i++) {
        const b = vec(i), n = eN[ei], ang = eA[ei];
        ei++;
        let p0 = a;
        for (let k = 1; k <= n; k++) {
          const p1 = k < n ? vec3.slerp(a, b, k / n) : b;
          PA[seg * 3] = p0[0]; PA[seg * 3 + 1] = p0[1]; PA[seg * 3 + 2] = p0[2];
          PB[seg * 3] = p1[0]; PB[seg * 3 + 1] = p1[1]; PB[seg * 3 + 2] = p1[2];
          if (ARC) { ARC[seg * 2] = arc + (ang * (k - 1)) / n; ARC[seg * 2 + 1] = arc + (ang * k) / n; }
          seg++; p0 = p1;
        }
        arc += ang;
        a = b;
      }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this._attrib(this.strokeProg, 'a_param', null, 2, { buf: this._strokeQuad });
    const pa = this._attrib(this.strokeProg, 'a_pA', PA, 3, { divisor: 1 });
    const pb = this._attrib(this.strokeProg, 'a_pB', PB, 3, { divisor: 1 });
    const pl = ARC ? this._attrib(this.strokeProg, 'a_arc', ARC, 2, { divisor: 1 }) : null;
    gl.bindVertexArray(null);

    const layer = {
      vao, count: nSegs, nLines, width,
      color: rgbaF(color), dash, _buffers: [pa, pb, ...(pl ? [pl] : [])],
    };
    layer.remove = () => {
      this.lineLayers = this.lineLayers.filter((x) => x !== layer);
      this._freeLayer(layer);
      this._dirty = true;           // lines aren't pickable -> no pick-buffer invalidation
    };
    this.lineLayers.push(layer);
    this._dirty = true;
    return layer;
  }

  // Add a point layer: each feature is a screen-space round disc of constant pixel
  // size at its unit-sphere position, depth-tested against the depth disk
  // (back-hemisphere points hidden), pickable, and styled per-feature. Markers draw
  // on top of fills and strokes.
  //   xyz | lnglat : Float32Array positions (3/vertex unit xyz, or 2/vertex lng,lat)
  //   color        : (i) => [r,g,b,a] | '#rrggbb' | constant   (per-feature)
  //   size         : (i) => radiusPx  | number                 (per-feature, CSS px)
  // Returns the layer; layer.update({color}) restyles, layer.remove() frees it.
  points({ xyz, lnglat, color = '#ff3b30', size = 5 }) {
    const gl = this.gl;
    const nPoints = xyz ? xyz.length / 3 : lnglat.length / 2;
    const sizeFn = asFn(size);
    const vec = (i) => this._posAt(xyz, lnglat, i);

    // Instanced: one record per point (center + radius); the shared corner quad
    // billboards it in the vertex shader, and the feature id is just
    // gl_InstanceID — no per-corner repetition, no id buffer, no index buffer.
    const CEN = new Float32Array(nPoints * 3), RAD = new Float32Array(nPoints);
    for (let p = 0; p < nPoints; p++) {
      const v = vec(p);
      CEN[p * 3] = v[0]; CEN[p * 3 + 1] = v[1]; CEN[p * 3 + 2] = v[2];
      RAD[p] = sizeFn(p);
    }

    // Per-feature color/alpha in a style texture sampled by id (same as fills).
    const { tex: styleTex, W, H, restyle } = this._makeStyle(nPoints, color);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    this._attrib(this.pointProg, 'a_corner', null, 2, { buf: this._pointQuad });
    const ceb = this._attrib(this.pointProg, 'a_center', CEN, 3, { divisor: 1 });
    const rab = this._attrib(this.pointProg, 'a_radius', RAD, 1, { divisor: 1 });
    gl.bindVertexArray(null);

    const layer = {
      vao, count: nPoints, nPoints,
      styleTex, styleW: W, styleH: H, _buffers: [ceb, rab],
    };
    layer.update = ({ color: c } = {}) => { if (c != null) restyle(c); return layer; };
    layer.remove = () => {
      this.pointLayers = this.pointLayers.filter((l) => l !== layer);
      this._freeLayer(layer);
      this._invalidate();
    };
    this.pointLayers.push(layer);
    this._invalidate();
    return layer;
  }

  // Graticule overlay: meridians + parallels every `step` degrees (see
  // graticuleLines). Pure geometry — synchronous, no fetch — so unlike
  // coastlines()/borders() it returns the layer directly, not a promise.
  //   step     : grid spacing in degrees (default 10)
  //   latLimit : meridians span ±latLimit; parallels stay within it (default 80)
  //   color, width : as lines() (defaults tuned to read as a quiet backdrop)
  graticule({ step, latLimit, color = '#b7c2cc', width = 1 } = {}) {
    return this.lines({ ...graticuleLines({ step, latLimit }), color, width });
  }

  // GeoJSON convenience layer: draw a FeatureCollection (or Feature / bare
  // geometry) with per-feature styling read from feature.properties, using the
  // SVG/simplestyle-ish vocabulary: fill, fillOpacity, stroke, strokeWidth,
  // strokeOpacity, strokeDasharray ("on off" px), r (point radius px). Hex
  // colors ('#rrggbb') or 'none'. `defaults` overrides the built-in defaults.
  //
  // Deliberately a layer ABOVE the core (like coastlines()/borders()): the
  // core primitives speak typed arrays + style callbacks; this walks objects.
  // All polygons share one polygons() layer (ring-grouped, so concave shapes
  // and holes render correctly via tess.js; each polygon of a MultiPolygon is
  // one pickable feature). Outlines and lines group into one lines() layer per
  // distinct stroke style (line style is per-layer in the core). Points share
  // one points() layer. Returns { layers, remove() }.
  geojson(gj, defaults = {}) {
    const D = {
      fill: '#dc3545', fillOpacity: 0.45,
      stroke: undefined, strokeWidth: 1, strokeOpacity: 0.7, strokeDasharray: null,
      lineStroke: '#dc3545', lineWidth: 2.5, lineOpacity: 0.9,
      r: 5, ...defaults,
    };
    const features = gj.type === 'FeatureCollection' ? gj.features
      : gj.type === 'Feature' ? [gj] : [{ geometry: gj, properties: {} }];

    const rgba = (color, opacity) => {
      const c = hexRGBA(color);
      return [c[0], c[1], c[2], Math.round(c[3] * opacity)];
    };
    // normalize any SVG dasharray to the core's [on, off] contract: odd-length
    // lists repeat (SVG: '4' means 4 4); entries beyond the first pair are
    // dropped (the shader draws a two-phase pattern only)
    const dashOf = (v) => {
      if (v == null) return null;
      const a = (Array.isArray(v) ? v : String(v).trim().split(/[ ,]+/).map(Number)).filter(Number.isFinite);
      if (!a.length) return null;
      if (a.length === 1) a.push(a[0]);
      return a.slice(0, 2);
    };

    const pos = [], starts = [0], polys = [0], polyFill = [];
    const strokeGroups = new Map();
    const pts = [], ptColor = [], ptSize = [];

    const strokePath = (coords, closed, color, width, opacity, dash) => {
      if (coords.length < 2) return;              // degenerate path: nothing to stroke
      if (!color || color === 'none' || opacity <= 0 || width <= 0) return;
      const key = `${color}|${width}|${opacity}|${dash}`;
      let g = strokeGroups.get(key);
      if (!g) strokeGroups.set(key, g = { pos: [], starts: [0], color: rgba(color, opacity), width, dash: dashOf(dash) });
      for (const c of coords) g.pos.push(c[0], c[1]);
      if (closed) g.pos.push(coords[0][0], coords[0][1]);
      g.starts.push(g.pos.length / 2);
    };

    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      const p = f.properties || {};
      if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        const fill = p.fill ?? D.fill;
        const stroke = p.stroke ?? D.stroke ?? (fill === 'none' ? D.fill : fill);   // like SVG, stroke defaults to the fill
        // fill 'none' features contribute outlines only — fills write depth, so
        // even a zero-alpha fill would occlude filled features drawn after it
        const filled = fill !== 'none' && (p.fillOpacity ?? D.fillOpacity) > 0;
        for (const rings of (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)) {
          let ringCount = 0;
          for (const ring of rings) {
            const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0]
              && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
            if (open.length < 2) continue;          // degenerate ring: nothing to draw
            if (filled) {
              for (const c of open) pos.push(c[0], c[1]);
              starts.push(pos.length / 2);
              ringCount++;
            }
            strokePath(open, true, stroke, p.strokeWidth ?? D.strokeWidth,
              p.strokeOpacity ?? D.strokeOpacity, p.strokeDasharray ?? D.strokeDasharray);
          }
          // real-world exports contain empty polygons ([] or [[]]) — a polys
          // entry with zero rings would crash the tessellation downstream
          if (filled && ringCount > 0) {
            polys.push(starts.length - 1);
            polyFill.push(rgba(fill, p.fillOpacity ?? D.fillOpacity));
          }
        }
      } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
        for (const coords of (g.type === 'LineString' ? [g.coordinates] : g.coordinates)) {
          strokePath(coords, false, p.stroke ?? D.lineStroke, p.strokeWidth ?? D.lineWidth,
            p.strokeOpacity ?? D.lineOpacity, p.strokeDasharray ?? D.strokeDasharray);
        }
      } else if (g.type === 'Point' || g.type === 'MultiPoint') {
        const fill = p.fill ?? D.fill;
        if (fill === 'none') continue;            // hexRGBA('none') would NaN → black dot
        for (const c of (g.type === 'Point' ? [g.coordinates] : g.coordinates)) {
          pts.push(c[0], c[1]);
          ptColor.push(rgba(fill, 1));
          ptSize.push(p.r ?? D.r);
        }
      }
    }

    const layers = [];
    if (polys.length > 1) {
      layers.push(this.polygons({
        lnglat: new Float32Array(pos), starts: new Uint32Array(starts),
        polys: new Uint32Array(polys), fill: (i) => polyFill[i],
      }));
    }
    for (const g of strokeGroups.values()) {
      layers.push(this.lines({
        lnglat: new Float32Array(g.pos), starts: new Uint32Array(g.starts),
        color: g.color, width: g.width, dash: g.dash,
      }));
    }
    if (pts.length) {
      layers.push(this.points({
        lnglat: new Float32Array(pts), color: (i) => ptColor[i], size: (i) => ptSize[i],
      }));
    }
    return { layers, remove: () => layers.forEach((l) => l.remove()) };
  }

  // Batteries-included reference geometry (Natural Earth), fetched from a CDN and
  // drawn via lines() — the library bundles no data. detail: '110m' | '50m' | '10m'.
  // baseUrl overrides the default CDN (e.g. self-hosted GeoJSON). Returns the layer.
  async coastlines(opts = {}) {
    return this._neLines({ file: 'coastline', color: '#000000', width: 1.5, stitch: false, ...opts });
  }
  // Full country outlines (admin-0 country polygons → ring polylines), so borders
  // read as complete shapes on their own (coast included), not just inter-country
  // land boundaries. Pair with coastlines() and the shared coast slightly overdraws.
  // Stitched by default (un-cuts the antimeridian/polar splits); `stitch:false` to
  // skip, or `stitch: geoStitch` to inject your own (offline / no CDN).
  async borders(opts = {}) {
    return this._neLines({ file: 'admin_0_countries', color: '#c2185b', width: 1.2, stitch: true, ...opts });
  }

  async _neLines({ file, detail = '50m', color, width, baseUrl, stitch }) {
    const url = `${baseUrl || DEFAULT_NE}/ne_${detail}_${file}.geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ajglobe: failed to load ${url} (${res.status})`);
    let gj = await res.json();
    if (stitch) {
      try { gj = applyStitch(typeof stitch === 'function' ? stitch : await loadStitch(), gj); }
      catch (e) { console.warn('ajglobe: geoStitch unavailable, drawing raw polygons —', e.message); }
    }
    // destroy() may have run while we awaited the network: creating the layer
    // now would allocate GL buffers nothing will ever free (the render loop is
    // dead, so nobody calls remove()). SPA mount/unmount hits this constantly.
    if (this._destroyed) return null;
    const { lnglat, starts } = geojsonLines(gj);
    return this.lines({ lnglat, starts, color, width });
  }

  lookAt(lng, lat) { this.cam.lookAt(lng, lat); }

  // View get/set, delegated to the camera (see camera.js for the { q, zoom } contract +
  // idempotence). For human-readable views, compose with the re-exported lnglatToQuat /
  // quatToLngLat converters.
  getView() { return this.cam.getView(); }
  setView(v) { this.cam.setView(v); }

  // Composition surface (the official overlay API): geo<->screen + events.
  // project(lng,lat) -> { x, y, visible }  (canvas CSS px; visible=false on back)
  // unproject(x,y)   -> { lng, lat } | null (null when the pixel misses the globe)
  project(lng, lat) { return this.cam.project(lng, lat); }
  unproject(x, y) { return this.cam.unproject(x, y); }

  // on('hover'|'click'|'viewchange'|'gesturehint', cb) -> unsubscribe fn.
  // hover/click payload: { x, y, lng, lat, index, layer } — lng/lat null off-globe;
  // index/layer come from GPU picking (null off-globe / over no feature). They're
  // lazy getters: a handler that reads only lng/lat triggers no pick (no GPU
  // readback). viewchange: no arg. gesturehint: { kind: 'touch'|'wheel' }, fired
  // when cooperative mode passes an input to the page.
  on(type, cb) {
    (this._handlers[type] ||= []).push(cb);
    return () => { this._handlers[type] = this._handlers[type].filter((f) => f !== cb); };
  }
  _emit(type, e) { const hs = this._handlers[type]; if (hs) for (const f of hs) f(e); }
  _emitPointer(type, e) {
    const hs = this._handlers[type];
    if (!hs || !hs.length) return;          // skip the work when nobody listens
    const g = this.cam.unproject(e.offsetX, e.offsetY);
    let pk, picked = false;                 // pick lazily — only if a handler reads index/layer
    const pick = () => {
      // NOT gated on g: point discs and strokes are screen-space quads that
      // legitimately overhang the globe silhouette, and the id-buffer holds
      // their ids there even though the pixel misses the sphere
      if (!picked) { pk = this.pick(e.offsetX, e.offsetY); picked = true; }
      return pk;                            // null over no feature
    };
    this._emit(type, {
      x: e.offsetX, y: e.offsetY,
      lng: g ? g.lng : null, lat: g ? g.lat : null,
      get index() { return pick()?.index ?? null; },
      get layer() { return pick()?.layer ?? null; },
    });
  }

  get stats() {
    return {
      features: this.layers.reduce((a, l) => a + l.nFeatures, 0),
      verts: this.layers.reduce((a, l) => a + l.nVerts, 0),
    };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  _frame() {
    this._frameId++;                          // pick-rebuild budget: once per frame
    if (!this._dirty) return;
    this._dirty = false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(...this.bg);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._renderScene(this.canvas.width, this.canvas.height);
  }

  // Draw the scene (depth disk -> fills -> strokes) into the currently-bound
  // framebuffer at w x h device px. The caller binds the target and clears it, so
  // the same path serves the live frame and offscreen snapshots. Stroke width is
  // scaled by device-px-per-CSS-px so it looks identical at any output resolution.
  _renderScene(w, h) {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    const { vp, mvp } = this.cam.matrices(w / h);
    const dppx = this.canvas.clientHeight ? h / this.canvas.clientHeight : this.dpr;

    // 1) opaque screen-parallel depth disk -> globe body + hides the back hemisphere
    this._drawDisk(vp, ...this.diskColor, 1);

    // 2) polygon fills (depth-tested against the disk). Color comes from each
    // layer's per-feature style texture, sampled by a_featureId.
    gl.useProgram(this.fillProg);
    gl.uniformMatrix4fv(this.fillU.mvp, false, mvp);
    gl.uniform1i(this.fillU.style, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const l of this.layers) {
      gl.uniform1i(this.fillU.hoverId,
        this._hoverLayer == null || this._hoverLayer === l ? this._hoverId : -1);
      gl.bindTexture(gl.TEXTURE_2D, l.styleTex);
      gl.uniform1i(this.fillU.styleW, l.styleW);
      gl.bindVertexArray(l.vao);
      gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
    }

    // 3) thick AA stroke overlays (screen-space quads). Depth-test against the
    // disk (back hidden) but don't write depth — strokes are a pure overlay.
    if (this.lineLayers.length) {
      gl.useProgram(this.strokeProg);
      gl.uniformMatrix4fv(this.strokeU.mvp, false, mvp);
      gl.uniform2f(this.strokeU.viewport, w, h);
      gl.uniform1f(this.strokeU.pxPerRad, this.cam.pxPerRad(h));
      gl.depthMask(false);
      for (const l of this.lineLayers) {
        gl.uniform4f(this.strokeU.color, l.color[0], l.color[1], l.color[2], l.color[3]);
        gl.uniform1f(this.strokeU.hw, l.width * dppx * 0.5);
        const d = l.dash;
        if (d) gl.uniform2f(this.strokeU.dash, (d[0] + d[1]) * dppx, d[0] / (d[0] + d[1]));
        else gl.uniform2f(this.strokeU.dash, 0, 0);
        gl.bindVertexArray(l.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
      }
      gl.depthMask(true);
    }

    // 4) point markers (screen-space discs) — topmost overlay. Color from each
    // layer's per-feature style texture; depth-test against the disk (back hidden)
    // but don't write depth.
    if (this.pointLayers.length) {
      gl.useProgram(this.pointProg);
      gl.uniformMatrix4fv(this.pointU.mvp, false, mvp);
      gl.uniform2f(this.pointU.viewport, w, h);
      gl.uniform1f(this.pointU.dppx, dppx);
      gl.uniform1i(this.pointU.style, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.depthMask(false);
      for (const l of this.pointLayers) {
        gl.uniform1i(this.pointU.hoverId,
          this._hoverLayer == null || this._hoverLayer === l ? this._hoverId : -1);
        gl.bindTexture(gl.TEXTURE_2D, l.styleTex);
        gl.uniform1i(this.pointU.styleW, l.styleW);
        gl.bindVertexArray(l.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
      }
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
  }

  // Mark the rendered frame AND the pick id-buffer stale (they change together on
  // any view/layer/size change). highlight() only sets _dirty — it doesn't move geometry.
  _invalidate() { this._dirty = true; this._pickValid = false; }

  // Draw the depth disk with a given color (opaque body in the main view, id 0
  // in the pick pass). Shared by _renderScene and _renderPickScene. Takes the
  // rotation-free vp matrix — the disk stays screen-aligned.
  _drawDisk(vp, r, g, b, a) {
    const gl = this.gl;
    gl.useProgram(this.diskProg);
    gl.uniformMatrix4fv(this.diskU.mvp, false, vp);
    gl.uniform4f(this.diskU.color, r, g, b, a);
    gl.bindVertexArray(this.diskVAO);
    gl.drawElements(gl.TRIANGLES, this.diskCount, gl.UNSIGNED_INT, 0);
  }

  // Free an offscreen render target ({ fbo, tex, rbo }) — pick buffer and snapshots.
  _freeTarget(t) {
    const gl = this.gl;
    gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); gl.deleteRenderbuffer(t.rbo);
  }

  // Highlight one feature (tinted toward white), or -1/null for none. Pass the
  // layer (e.g. from a hover event's e.layer) to scope the tint — feature ids
  // are per-layer, so without it every layer's feature `index` would light up.
  // Omitting the layer keeps the old tint-everywhere behavior for one-layer apps.
  highlight(index, layer = null) {
    const id = index == null ? -1 : index;
    if (id === this._hoverId && layer === this._hoverLayer) return;
    this._hoverId = id;
    this._hoverLayer = layer;
    this._dirty = true;
  }

  // Render the fills into the offscreen id-buffer: each feature's id as a color.
  // Lazy — only when the view/layers/size changed since the last pick. The depth
  // disk is drawn first (as id 0) so back-hemisphere cells are occluded and can't
  // be picked. Blend is off so ids are written exactly.
  _renderPickScene() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (!this._pick || this._pick.w !== w || this._pick.h !== h) {
      if (this._pick) this._freeTarget(this._pick);
      this._pick = { ...this._renderTarget(w, h), w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pick.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { vp, mvp } = this.cam.matrices(w / h);

    // depth-only occluder: the disk writes depth (color 0 = "nothing")
    this._drawDisk(vp, 0, 0, 0, 0);

    // fills as id-colors; u_idBase gives each layer a distinct id range
    gl.useProgram(this.pickProg);
    gl.uniformMatrix4fv(this.pickU.mvp, false, mvp);
    let base = 0;
    for (const l of this.layers) {
      gl.uniform1ui(this.pickU.idBase, base);
      gl.bindVertexArray(l.vao);
      gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
      base += l.nFeatures;
    }
    // point discs continue the same global id space (drawn after fills so they win
    // where they overlap); the back hemisphere is already occluded by the disk.
    if (this.pointLayers.length) {
      gl.useProgram(this.pointPickProg);
      gl.uniformMatrix4fv(this.pointPickU.mvp, false, mvp);
      gl.uniform2f(this.pointPickU.viewport, w, h);
      gl.uniform1f(this.pointPickU.dppx, this.dpr);
      gl.depthMask(false);
      for (const l of this.pointLayers) {
        gl.uniform1ui(this.pointPickU.idBase, base);
        gl.bindVertexArray(l.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
        base += l.nPoints;
      }
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    this._pickValid = true;
  }

  // Which fill feature is under a canvas pixel? -> { layer, index } or null.
  // The id-buffer re-renders lazily, at most once per animation frame: during
  // a drag every pointermove invalidates it (viewchange), and without the
  // frame gate an index-reading hover handler would force a full offscreen
  // re-render of every layer PER POINTER EVENT at DGGS scale. Reusing a
  // ≤1-frame-stale buffer for extra same-frame picks is imperceptible.
  pick(px, py) {
    if (!this.layers.length && !this.pointLayers.length) return null;
    if (!this._pickValid && this._pickFrame !== this._frameId) {
      this._renderPickScene();
      this._pickFrame = this._frameId;
    }
    if (!this._pick) return null;              // nothing ever rendered yet
    const gl = this.gl;
    // -1: GL rows run bottom-up, so CSS row 0 is device row height-1 (without
    // it, the top row failed the bounds check and every pick read one row off)
    const x = Math.round(px * this.dpr), y = this.canvas.height - 1 - Math.round(py * this.dpr);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;
    const p = this._pickPixel;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pick.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // high byte is * 2^24, not << 24: a left shift past bit 30 goes negative in JS.
    const id = p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] * 0x1000000);
    if (id === 0) return null;                  // background / disk / back hemisphere
    let global = id - 1;
    for (const l of this.layers) {
      if (global < l.nFeatures) return { layer: l, index: global };
      global -= l.nFeatures;
    }
    for (const l of this.pointLayers) {
      if (global < l.nPoints) return { layer: l, index: global };
      global -= l.nPoints;
    }
    return null;
  }

  // Offscreen render target: RGBA8 color texture + depth renderbuffer + FBO at
  // w x h. Returns the handles for snapshot(); this is also the infra M4 picking
  // will reuse. Leaves the FBO bound.
  _renderTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const rbo = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbo);
    return { fbo, tex, rbo };
  }

  // Render the current view to an offscreen buffer at an arbitrary resolution and
  // return a PNG (or JPEG) Blob — independent of the on-screen canvas, so it works
  // for crisp shareable stills and headless batch capture. The live canvas/dpr are
  // never touched.
  //   width/height : output px (default: current drawing-buffer size; pass width
  //                  alone to keep the current aspect)
  //   supersample  : internal AA oversampling (default 2; clamped to GPU limits)
  //   transparent  : true -> outside the globe disk is transparent (PNG)
  //   type/quality : 'image/png' (default) | 'image/jpeg', quality 0..1
  snapshot({ width, height, supersample = 2, type = 'image/png', quality, transparent = false } = {}) {
    const gl = this.gl, canvas = this.canvas;
    const outW = Math.max(1, Math.round(width || canvas.width));
    const outH = Math.max(1, Math.round(height
      || (width ? width * canvas.height / canvas.width : canvas.height)));
    // supersample internally for AA, clamped to the GPU's max renderbuffer size
    const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    let ss = Math.max(1, supersample);
    while (ss > 1 && (outW * ss > max || outH * ss > max)) ss -= 1;
    const w = Math.min(max, Math.round(outW * ss)), h = Math.min(max, Math.round(outH * ss));

    const { fbo, tex, rbo } = this._renderTarget(w, h);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._freeTarget({ fbo, tex, rbo });
      throw new Error('snapshot: framebuffer incomplete (size too large?)');
    }
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], transparent ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._renderScene(w, h);

    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // restore the live framebuffer + clear color; repaint on the next frame
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(...this.bg);
    this._freeTarget({ fbo, tex, rbo });
    this._dirty = true;

    // raw pixels (bottom-left origin) -> temp canvas, then flip + downscale to out
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0);
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');
    ctx.scale(1, -1);                          // WebGL readPixels origin is bottom-left
    ctx.drawImage(tmp, 0, -outH, outW, outH);  // flip upright + downscale (bilinear AA)
    return new Promise((resolve) => out.toBlob(resolve, type, quality));
  }
}
