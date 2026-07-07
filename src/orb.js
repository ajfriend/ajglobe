// ajglobe — correct, fast orthographic globe rendering for polygons, lines & points.
//
// The thesis: never parameterize to 2D. Vertices are points on the unit sphere
// (lng/lat -> xyz once), fills are triangulated by ring TOPOLOGY (a fan over
// vertex indices, coordinate-free), and the back hemisphere is hidden by an
// opaque depth sphere. So the antimeridian and the poles need no special cases —
// they're just points, and a pole that lies inside a convex cell is covered by
// that cell's fan like any other interior point.
//
// Per-feature style substrate: each vertex carries a featureId; color lives in a
// per-feature texture sampled by id, so a restyle (layer.update) touches nFeatures
// texels, never the geometry. The same featureId drives GPU picking. Three
// primitives — polygons (fills), lines (thick AA strokes), points (disc markers).

import { lnglatToVec3, lnglatToVec3Into, vec3 } from './glmath.js';

// Re-export the pure view converters so consumers get them from the package entry
// alongside Orb (the core view format is { q, zoom }; these translate the rotation
// part to/from a human-readable { lng, lat, roll }).
export { lnglatToQuat, quatToLngLat } from './glmath.js';
import { Camera } from './camera.js';

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

const SPHERE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 o_color;
void main() { o_color = u_color; }`;

const SPHERE_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`;

// Thick AA strokes: expand each segment to a screen-space quad of constant pixel
// width. Project both endpoints, take the screen-space perpendicular, and offset
// this vertex by side * (halfWidth + 1px AA pad). v_dist carries the signed pixel
// distance from the centerline so the fragment shader can feather the edges.
const STROKE_VS = `#version 300 es
in vec3 a_pA;
in vec3 a_pB;
in vec2 a_param;            // x: end (0=A, 1=B), y: side (-1/+1)
uniform mat4 u_mvp;
uniform vec2 u_viewport;    // device px
uniform float u_hw;         // stroke half-width, device px
out float v_dist;
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
  v_dist = a_param.y * w;
}`;

const STROKE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_hw;
in float v_dist;
out vec4 o_color;
void main() {
  float cov = clamp(u_hw + 0.5 - abs(v_dist), 0.0, 1.0);   // 1px edge feather
  if (cov <= 0.0) discard;
  o_color = vec4(u_color.rgb, u_color.a * cov);
}`;

// Points (M6): each marker is a screen-space round disc of constant pixel radius,
// billboarded around its unit-sphere center like a stroke quad — offset clip.xy by
// the corner, keep the center's clip.z/w so the disc takes the center's depth (back
// hemisphere hidden by the depth sphere). Explicit attribute locations so the same
// VAO drives both the color and the pick program (like FILL_VS).
const POINT_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;     // unit-quad corner (-1/+1, -1/+1)
layout(location = 1) in vec3 a_center;     // unit-sphere xyz (lifted above fills)
layout(location = 2) in float a_radius;    // disc radius, CSS px
layout(location = 3) in uint a_featureId;
uniform mat4 u_mvp;
uniform vec2 u_viewport;   // device px
uniform float u_dppx;      // device px per CSS px (radius is CSS px)
flat out uint v_fid;
out vec2 v_off;            // device-px offset from the disc center
out float v_rad;           // disc radius, device px
void main() {
  v_fid = a_featureId;
  float rad = a_radius * u_dppx;
  float pad = rad + 1.0;            // +1px so the AA ramp has room
  v_rad = rad;
  v_off = a_corner * pad;
  vec4 clip = u_mvp * vec4(a_center, 1.0);
  clip.xy += (a_corner * pad) / (u_viewport * 0.5) * clip.w;
  gl_Position = clip;
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

// d3-geo's geoStitch, loaded lazily from a CDN the first time borders() needs it
// (pay-per-use — the core ships no dependency). It un-cuts the antimeridian/polar
// splits that GeoJSON polygons carry for 2D validity (Russia, Antarctica), turning
// them back into proper spherical rings — which is what we draw. Cached after load.
// NB: this https import stays external in the dist build (package.json build's
// `--external:https://*`) so d3-geo is never bundled; revisit that flag if it moves.
let _stitch;
async function loadStitch() {
  if (!_stitch) _stitch = (await import('https://cdn.jsdelivr.net/npm/d3-geo-projection@4/+esm')).geoStitch;
  return _stitch;
}
// Apply a geoStitch fn per feature-geometry (robust across GeoJSON shapes).
function applyStitch(geoStitch, gj) {
  if (gj.type !== 'FeatureCollection') return geoStitch(gj);
  return { type: 'FeatureCollection', features: gj.features.map((f) =>
    f.geometry ? { ...f, geometry: geoStitch(f.geometry) } : f) };
}

// UV sphere triangle mesh, radius r.
function uvSphere(r, slices = 64, stacks = 32) {
  const pos = [], idx = [];
  for (let i = 0; i <= stacks; i++) {
    const v = (i / stacks) * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
    for (let j = 0; j <= slices; j++) {
      const u = (j / slices) * 2 * Math.PI;
      pos.push(r * sv * Math.cos(u), r * sv * Math.sin(u), r * cv);
    }
  }
  const row = slices + 1;
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = i * row + j, b = a + row;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

// Crack-free adaptive subdivision of one fan triangle (vertex indices ia,ib,ic
// into P) onto the sphere, so coarse fills stay above the depth sphere (§8):
// any edge subtending more than MAX_FILL_EDGE splits at its spherical midpoint
// and the pieces recurse; small triangles emit unchanged (no new verts). New
// verts append to P (positions) + F (feature ids), triangles push to I. Both
// the split test and the midpoint depend only on the edge's two endpoints, so
// adjacent triangles — same fan or neighbouring cells — subdivide a shared edge
// identically: no T-junction cracks (the old uniform per-triangle lattice could
// pick different densities for fan neighbours, leaving hairline slivers along
// shared spokes — visible on H3 res-1 cells). Worst case, all edges at the
// threshold (equilateral), the interior stays above cos(MAX_FILL_EDGE/√3)
// ≈ 0.99865 > depth sphere 0.998. Internal; exported for the unit tests.
const MAX_FILL_EDGE = 0.09;                       // rad
const COS_FILL_EDGE = Math.cos(MAX_FILL_EDGE);
// polygons()'s fast-path gate, derived from the same constant: fan-triangle
// edges are two apex spokes plus a ring edge bounded by their sum, so spokes
// under MAX_FILL_EDGE/2 keep every edge below the split threshold — the flat
// fast path then emits exactly what subdivideTri would.
const COS_SPOKE_GATE = Math.cos(MAX_FILL_EDGE / 2);
export function subdivideTri(P, F, I, fid, ia, ib, ic) {
  const dot = (i, j) => P[i * 3] * P[j * 3] + P[i * 3 + 1] * P[j * 3 + 1] + P[i * 3 + 2] * P[j * 3 + 2];
  const mid = (i, j) => {                         // spherical midpoint of two unit vectors
    const x = P[i * 3] + P[j * 3], y = P[i * 3 + 1] + P[j * 3 + 1], z = P[i * 3 + 2] + P[j * 3 + 2];
    const s = 1 / Math.hypot(x, y, z);
    P.push(x * s, y * s, z * s); F.push(fid);
    return P.length / 3 - 1;
  };
  const rec = (a, b, c) => {
    const ab = dot(a, b) < COS_FILL_EDGE, bc = dot(b, c) < COS_FILL_EDGE, ca = dot(c, a) < COS_FILL_EDGE;
    if (!ab && !bc && !ca) { I.push(a, b, c); return; }
    if (ab && bc && ca) {                         // all long: 4-way split
      const mab = mid(a, b), mbc = mid(b, c), mca = mid(c, a);
      rec(a, mab, mca); rec(mab, b, mbc); rec(mca, mbc, c); rec(mab, mbc, mca);
      return;
    }
    if (!ab) return bc ? rec(b, c, a) : rec(c, a, b);   // rotate a long edge into ab
    const m = mid(a, b);                          // bisect it; the halves re-test the rest
    rec(a, m, c); rec(m, b, c);
  };
  rec(ia, ib, ic);
}

export class Orb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 required');
    this.gl = gl;
    this.bg = rgbaF(opts.background || '#0b0e13');
    this.sphereColor = rgbaF(opts.sphere || '#11151c');

    // Programs + their uniform names (each is `u_<key>` in GLSL), built in one pass
    // and stored as this.<name>Prog / this.<name>U (location maps, resolved once).
    const PROGRAMS = {
      fill:      [FILL_VS, FILL_FS,        ['mvp', 'style', 'styleW', 'hoverId']],
      sphere:    [SPHERE_VS, SPHERE_FS,    ['mvp', 'color']],
      stroke:    [STROKE_VS, STROKE_FS,    ['mvp', 'viewport', 'hw', 'color']],
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
    this._hoverId = -1;        // feature to highlight in the fills (-1 = none)
    this._pick = null;         // offscreen id-buffer { fbo, tex, rbo, w, h }
    this._pickValid = false;   // stale when the view / layers / size change
    this._pickPixel = new Uint8Array(4);   // reused readback scratch (per-pointer)
    this._buildSphere();

    this.layers = [];
    this.lineLayers = [];
    this.pointLayers = [];
    this._handlers = { hover: [], click: [], viewchange: [] };
    // One AbortController removes every canvas listener (Orb's + Camera's) on destroy().
    this._destroyed = false;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this.cam = new Camera(canvas, () => { this._invalidate(); this._emit('viewchange'); }, signal);
    this._dirty = true;
    canvas.addEventListener('pointermove', (e) => this._emitPointer('hover', e), { signal });
    canvas.addEventListener('click', (e) => this._emitPointer('click', e), { signal });

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    // Per-feature opacity: fill's alpha rides in the style texture; blend it over
    // the depth sphere. Cells don't overlap, so straight alpha needs no sorting.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    gl.deleteVertexArray(this.sphereVAO);
    this._sphereBuffers.forEach((b) => gl.deleteBuffer(b));
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
  _attrib(prog, name, data, size, type, normalized = false) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type ?? gl.FLOAT, normalized, 0, 0);
    return buf;
  }

  // Create an ELEMENT_ARRAY_BUFFER (indices) on the bound VAO.
  _elements(data) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  // Integer vertex attribute (vertexAttribIPointer; ids pass through unconverted).
  _attribI(prog, name, data, size, type) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribIPointer(loc, size, type, 0, 0);
    return buf;
  }

  // Vertex i as unit-sphere xyz, from either an xyz or an lng/lat position array.
  _posAt(xyz, lnglat, i) {
    return xyz ? [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]
      : lnglatToVec3(lnglat[i * 2], lnglat[i * 2 + 1]);
  }

  // Pack one RGBA8 texel per feature from the fill fn, row-major in W×H bytes.
  _buildStyle(n, W, H, fillFn) {
    const data = new Uint8Array(W * H * 4);
    for (let c = 0; c < n; c++) {
      const col = hexRGBA(fillFn(c));
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
    const tex = this._styleTexture(W, H, this._buildStyle(n, W, H, asFn(colorFn)));
    const restyle = (f) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE,
        this._buildStyle(n, W, H, asFn(f)));
      this._dirty = true;
    };
    return { tex, W, H, restyle };
  }

  _buildSphere() {
    const gl = this.gl;
    // Slightly inside the unit sphere so cells (at r=1) always sit in front of it
    // and the back hemisphere of cells fails the depth test against it.
    const m = uvSphere(0.998);
    this.sphereCount = m.idx.length;
    this.sphereVAO = gl.createVertexArray();
    gl.bindVertexArray(this.sphereVAO);
    const pb = this._attrib(this.sphereProg, 'a_pos', m.pos, 3);
    const ib = this._elements(m.idx);
    this._sphereBuffers = [pb, ib];   // kept so destroy() can free them
    gl.bindVertexArray(null);
  }

  // Add a filled-polygon layer.
  //   xyz | lnglat : Float32Array positions (3/vertex unit xyz, or 2/vertex lng,lat)
  //   starts       : Uint32Array ring start indices (len = nFeatures + 1)
  //   fill         : (featureIndex) => [r,g,b,a] | '#rrggbb' | constant
  // Returns the layer; layer.update({fill}) restyles (no re-tessellation),
  // layer.remove() frees it.
  polygons({ xyz, lnglat, starts, fill }) {
    const gl = this.gl;
    const nCells = starts.length - 1;
    let nVerts = xyz ? xyz.length / 3 : lnglat.length / 2;

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

    // Per-vertex feature id (the cell each vertex belongs to). Style is NOT baked
    // here — it lives in a per-feature texture sampled by id (built below), so a
    // restyle rewrites nFeatures texels and never touches this geometry. All verts
    // of a cell's fan share its id, so the fragment shader reads it 'flat'.
    //
    // The same pass flags any cell coarse enough that flat fan triangles would
    // chord below the depth sphere (radius 0.998) and get occluded (§8). The
    // apex-spoke gate is derived from subdivideTri's split threshold (see
    // COS_SPOKE_GATE) so one constant owns the policy; r5/r6 cells (~1°) never
    // trip it, so their fast path stays as-is.
    let fids = new Uint32Array(nVerts);
    let triCount = 0, anyLarge = false;
    for (let c = 0; c < nCells; c++) {
      const s = starts[c], e = starts[c + 1], k = e - s;
      const ax = pos[s * 3], ay = pos[s * 3 + 1], az = pos[s * 3 + 2];
      for (let v = s; v < e; v++) {
        fids[v] = c;
        if (ax * pos[v * 3] + ay * pos[v * 3 + 1] + az * pos[v * 3 + 2] < COS_SPOKE_GATE) anyLarge = true;
      }
      if (k >= 3) triCount += k - 2;
    }

    // Triangulate by ring TOPOLOGY — a fan (s, j, j+1), indices only, so it is
    // coordinate-free and immune to the antimeridian/pole (valid for convex rings).
    let idx;
    if (!anyLarge) {
      idx = new Uint32Array(triCount * 3);
      let t = 0;
      for (let c = 0; c < nCells; c++) {
        const s = starts[c], e = starts[c + 1];
        for (let j = s + 1; j < e - 1; j++) { idx[t++] = s; idx[t++] = j; idx[t++] = j + 1; }
      }
    } else {
      // Coarse cells present: subdivide their fan triangles and project the new
      // vertices onto the sphere so the fill stays above the depth sphere. Small
      // triangles still emit as one flat triangle, so only coarse cells grow.
      const P = Array.from(pos), F = Array.from(fids), I = [];
      for (let c = 0; c < nCells; c++) {
        const s = starts[c], e = starts[c + 1];
        for (let j = s + 1; j < e - 1; j++) subdivideTri(P, F, I, c, s, j, j + 1);
      }
      pos = new Float32Array(P);
      fids = new Uint32Array(F);
      idx = new Uint32Array(I);
      nVerts = pos.length / 3;
    }

    // Per-feature style: one RGBA8 texel per feature, indexed by id (restyle just
    // rewrites those texels; geometry is untouched).
    const { tex: styleTex, W, H, restyle } = this._makeStyle(nCells, fill);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = this._attrib(this.fillProg, 'a_pos', pos, 3);
    const fb = this._attribI(this.fillProg, 'a_featureId', fids, 1, gl.UNSIGNED_INT);
    const ib = this._elements(idx);
    gl.bindVertexArray(null);

    const layer = {
      vao, count: idx.length, nCells, nVerts,
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
  // densified so the stroke follows the great-circle arc. Strokes ride at radius
  // ~1.0015 so they sit just above fills but still depth-test against the sphere
  // (back-hemisphere strokes hidden). Coordinate-free: drawn in 3D, so the
  // antimeridian is just adjacent points on the sphere — no unwrap, no seam.
  //   xyz | lnglat : Float32Array positions (3/vertex unit xyz, or 2/vertex lng,lat)
  //   starts       : Uint32Array polyline start indices (len = nLines + 1)
  //   color        : '#rrggbb' | [r,g,b,a]
  //   width        : stroke width in CSS pixels (default 1.5)
  //   lift         : stroke radius above the unit sphere (default 1.0015). Bigger =
  //                  more depth separation from fills (less z-fighting toward the
  //                  limb), at the cost of the stroke visibly floating off the
  //                  surface near the limb. ~1.003–1.004 is a good high-contrast range.
  lines({ xyz, lnglat, starts, color = '#ffffff', width = 1.5, lift: R = 1.0015 }) {
    const gl = this.gl;
    const nLines = starts.length - 1;
    const MAX_SEG = 0.05;                         // rad; densify long edges into arcs
    const vec = (i) => this._posAt(xyz, lnglat, i);

    // Per segment, 4 verts carrying both endpoints (a_pA, a_pB) + (end, side); the
    // vertex shader does the screen-space offset, so geometry is view-independent.
    const PA = [], PB = [], PRM = [], IDX = [];
    let base = 0;
    for (let l = 0; l < nLines; l++) {
      const s = starts[l], e = starts[l + 1];
      if (e - s < 2) continue;
      // densify the polyline by slerp so each drawn segment reads as a geodesic arc
      let prev = vec(s);
      const dense = [prev];
      for (let i = s + 1; i < e; i++) {
        const cur = vec(i);
        const n = Math.max(1, Math.ceil(vec3.angle(prev, cur) / MAX_SEG));
        for (let k = 1; k <= n; k++) dense.push(vec3.slerp(prev, cur, k / n));
        prev = cur;
      }
      for (let i = 0; i + 1 < dense.length; i++) {
        const a = dense[i], b = dense[i + 1];
        const ax = a[0] * R, ay = a[1] * R, az = a[2] * R;
        const bx = b[0] * R, by = b[1] * R, bz = b[2] * R;
        for (let q = 0; q < 4; q++) { PA.push(ax, ay, az); PB.push(bx, by, bz); }
        PRM.push(0, -1, 0, 1, 1, -1, 1, 1);
        IDX.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
        base += 4;
      }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pa = this._attrib(this.strokeProg, 'a_pA', new Float32Array(PA), 3);
    const pb = this._attrib(this.strokeProg, 'a_pB', new Float32Array(PB), 3);
    const pm = this._attrib(this.strokeProg, 'a_param', new Float32Array(PRM), 2);
    const ib = this._elements(new Uint32Array(IDX));
    gl.bindVertexArray(null);

    const layer = {
      vao, count: IDX.length, nLines, width,
      color: rgbaF(color), _buffers: [pa, pb, pm, ib],
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
  // size at its unit-sphere position, depth-tested against the background sphere
  // (back-hemisphere points hidden), pickable, and styled per-feature. Markers draw
  // on top of fills and strokes.
  //   xyz | lnglat : Float32Array positions (3/vertex unit xyz, or 2/vertex lng,lat)
  //   color        : (i) => [r,g,b,a] | '#rrggbb' | constant   (per-feature)
  //   size         : (i) => radiusPx  | number                 (per-feature, CSS px)
  // Returns the layer; layer.update({color}) restyles, layer.remove() frees it.
  points({ xyz, lnglat, color = '#ff3b30', size = 5 }) {
    const gl = this.gl;
    const nPoints = xyz ? xyz.length / 3 : lnglat.length / 2;
    const R = 1.002;                              // lift above fills/strokes
    const sizeFn = asFn(size);
    const vec = (i) => this._posAt(xyz, lnglat, i);

    // 4 verts per point (a screen-space quad); the vertex shader billboards them.
    // a_center/a_radius/a_featureId repeat across the quad (as strokes repeat a_pA/B).
    const CO = [], CEN = [], RAD = [], FID = [], IDX = [];
    const corners = [-1, -1, 1, -1, -1, 1, 1, 1];
    let base = 0;
    for (let p = 0; p < nPoints; p++) {
      const v = vec(p), r = sizeFn(p);
      const cx = v[0] * R, cy = v[1] * R, cz = v[2] * R;
      for (let q = 0; q < 4; q++) {
        CO.push(corners[q * 2], corners[q * 2 + 1]);
        CEN.push(cx, cy, cz); RAD.push(r); FID.push(p);
      }
      IDX.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      base += 4;
    }

    // Per-feature color/alpha in a style texture sampled by id (same as fills).
    const { tex: styleTex, W, H, restyle } = this._makeStyle(nPoints, color);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const cob = this._attrib(this.pointProg, 'a_corner', new Float32Array(CO), 2);
    const ceb = this._attrib(this.pointProg, 'a_center', new Float32Array(CEN), 3);
    const rab = this._attrib(this.pointProg, 'a_radius', new Float32Array(RAD), 1);
    const fib = this._attribI(this.pointProg, 'a_featureId', new Uint32Array(FID), 1, gl.UNSIGNED_INT);
    const ib = this._elements(new Uint32Array(IDX));
    gl.bindVertexArray(null);

    const layer = {
      vao, count: IDX.length, nPoints,
      styleTex, styleW: W, styleH: H, _buffers: [cob, ceb, rab, fib, ib],
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

  // Batteries-included reference geometry (Natural Earth), fetched from a CDN and
  // drawn via lines() — the library bundles no data. detail: '110m' | '50m' | '10m'.
  // baseUrl overrides the default CDN (e.g. self-hosted GeoJSON). Returns the layer.
  // Reference lines usually ride over polygon fills, so they default to a higher
  // lift than raw lines(): extra depth separation kills fill z-fighting toward the
  // limb, and is invisible over a bare sphere.
  async coastlines(opts = {}) {
    return this._neLines({ file: 'coastline', color: '#000000', width: 1.5, stitch: false, lift: 1.0035, ...opts });
  }
  // Full country outlines (admin-0 country polygons → ring polylines), so borders
  // read as complete shapes on their own (coast included), not just inter-country
  // land boundaries. Pair with coastlines() and the shared coast slightly overdraws.
  // Stitched by default (un-cuts the antimeridian/polar splits); `stitch:false` to
  // skip, or `stitch: geoStitch` to inject your own (offline / no CDN).
  async borders(opts = {}) {
    return this._neLines({ file: 'admin_0_countries', color: '#c2185b', width: 1.2, stitch: true, lift: 1.0035, ...opts });
  }

  async _neLines({ file, detail = '50m', color, width, baseUrl, stitch, lift }) {
    const url = `${baseUrl || DEFAULT_NE}/ne_${detail}_${file}.geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ajglobe: failed to load ${url} (${res.status})`);
    let gj = await res.json();
    if (stitch) {
      try { gj = applyStitch(typeof stitch === 'function' ? stitch : await loadStitch(), gj); }
      catch (e) { console.warn('ajglobe: geoStitch unavailable, drawing raw polygons —', e.message); }
    }
    const { lnglat, starts } = geojsonLines(gj);
    return this.lines({ lnglat, starts, color, width, lift });
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

  // on('hover'|'click'|'viewchange', cb) -> unsubscribe fn.
  // hover/click payload: { x, y, lng, lat, index, layer } — lng/lat null off-globe;
  // index/layer come from GPU picking (null off-globe / over no feature). They're
  // lazy getters: a handler that reads only lng/lat triggers no pick (no GPU
  // readback). viewchange: no arg.
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
      if (!picked) { pk = g ? this.pick(e.offsetX, e.offsetY) : null; picked = true; }
      return pk;                            // null when off-globe (nothing under the pixel)
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
      cells: this.layers.reduce((a, l) => a + l.nCells, 0),
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
    if (!this._dirty) return;
    this._dirty = false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(...this.bg);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._renderScene(this.canvas.width, this.canvas.height);
  }

  // Draw the scene (depth sphere -> fills -> strokes) into the currently-bound
  // framebuffer at w x h device px. The caller binds the target and clears it, so
  // the same path serves the live frame and offscreen snapshots. Stroke width is
  // scaled by device-px-per-CSS-px so it looks identical at any output resolution.
  _renderScene(w, h) {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    const mvp = this.cam.mvp(w / h);
    const dppx = this.canvas.clientHeight ? h / this.canvas.clientHeight : this.dpr;

    // 1) opaque background sphere (depth) -> hides the back hemisphere
    this._drawSphere(mvp, ...this.sphereColor, 1);

    // 2) polygon fills (depth-tested against the sphere). Color comes from each
    // layer's per-feature style texture, sampled by a_featureId.
    gl.useProgram(this.fillProg);
    gl.uniformMatrix4fv(this.fillU.mvp, false, mvp);
    gl.uniform1i(this.fillU.style, 0);
    gl.uniform1i(this.fillU.hoverId, this._hoverId);
    gl.activeTexture(gl.TEXTURE0);
    for (const l of this.layers) {
      gl.bindTexture(gl.TEXTURE_2D, l.styleTex);
      gl.uniform1i(this.fillU.styleW, l.styleW);
      gl.bindVertexArray(l.vao);
      gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
    }

    // 3) thick AA stroke overlays (screen-space quads). Depth-test against the
    // sphere (back hidden) but don't write depth — strokes are a pure overlay.
    if (this.lineLayers.length) {
      gl.useProgram(this.strokeProg);
      gl.uniformMatrix4fv(this.strokeU.mvp, false, mvp);
      gl.uniform2f(this.strokeU.viewport, w, h);
      gl.depthMask(false);
      for (const l of this.lineLayers) {
        gl.uniform4f(this.strokeU.color, l.color[0], l.color[1], l.color[2], l.color[3]);
        gl.uniform1f(this.strokeU.hw, l.width * dppx * 0.5);
        gl.bindVertexArray(l.vao);
        gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
      }
      gl.depthMask(true);
    }

    // 4) point markers (screen-space discs) — topmost overlay. Color from each
    // layer's per-feature style texture; depth-test against the sphere (back hidden)
    // but don't write depth.
    if (this.pointLayers.length) {
      gl.useProgram(this.pointProg);
      gl.uniformMatrix4fv(this.pointU.mvp, false, mvp);
      gl.uniform2f(this.pointU.viewport, w, h);
      gl.uniform1f(this.pointU.dppx, dppx);
      gl.uniform1i(this.pointU.style, 0);
      gl.uniform1i(this.pointU.hoverId, this._hoverId);
      gl.activeTexture(gl.TEXTURE0);
      gl.depthMask(false);
      for (const l of this.pointLayers) {
        gl.bindTexture(gl.TEXTURE_2D, l.styleTex);
        gl.uniform1i(this.pointU.styleW, l.styleW);
        gl.bindVertexArray(l.vao);
        gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
      }
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
  }

  // Mark the rendered frame AND the pick id-buffer stale (they change together on
  // any view/layer/size change). highlight() only sets _dirty — it doesn't move geometry.
  _invalidate() { this._dirty = true; this._pickValid = false; }

  // Draw the depth sphere with a given color (opaque body in the main view, id 0
  // in the pick pass). Shared by _renderScene and _renderPickScene.
  _drawSphere(mvp, r, g, b, a) {
    const gl = this.gl;
    gl.useProgram(this.sphereProg);
    gl.uniformMatrix4fv(this.sphereU.mvp, false, mvp);
    gl.uniform4f(this.sphereU.color, r, g, b, a);
    gl.bindVertexArray(this.sphereVAO);
    gl.drawElements(gl.TRIANGLES, this.sphereCount, gl.UNSIGNED_INT, 0);
  }

  // Free an offscreen render target ({ fbo, tex, rbo }) — pick buffer and snapshots.
  _freeTarget(t) {
    const gl = this.gl;
    gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); gl.deleteRenderbuffer(t.rbo);
  }

  // Highlight one fill feature (tinted toward white), or -1 for none.
  highlight(index) {
    const id = index == null ? -1 : index;
    if (id === this._hoverId) return;
    this._hoverId = id;
    this._dirty = true;
  }

  // Render the fills into the offscreen id-buffer: each feature's id as a color.
  // Lazy — only when the view/layers/size changed since the last pick. The depth
  // sphere is drawn first (as id 0) so back-hemisphere cells are occluded and can't
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
    const mvp = this.cam.mvp(w / h);

    // depth-only occluder: the sphere writes depth (color 0 = "nothing")
    this._drawSphere(mvp, 0, 0, 0, 0);

    // fills as id-colors; u_idBase gives each layer a distinct id range
    gl.useProgram(this.pickProg);
    gl.uniformMatrix4fv(this.pickU.mvp, false, mvp);
    let base = 0;
    for (const l of this.layers) {
      gl.uniform1ui(this.pickU.idBase, base);
      gl.bindVertexArray(l.vao);
      gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
      base += l.nCells;
    }
    // point discs continue the same global id space (drawn after fills so they win
    // where they overlap); the back hemisphere is already occluded by the sphere.
    if (this.pointLayers.length) {
      gl.useProgram(this.pointPickProg);
      gl.uniformMatrix4fv(this.pointPickU.mvp, false, mvp);
      gl.uniform2f(this.pointPickU.viewport, w, h);
      gl.uniform1f(this.pointPickU.dppx, this.dpr);
      gl.depthMask(false);
      for (const l of this.pointLayers) {
        gl.uniform1ui(this.pointPickU.idBase, base);
        gl.bindVertexArray(l.vao);
        gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
        base += l.nPoints;
      }
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    this._pickValid = true;
  }

  // Which fill feature is under a canvas pixel? -> { layer, index } or null. Renders
  // the id-buffer once per view change, then reads back a single pixel.
  pick(px, py) {
    if (!this.layers.length && !this.pointLayers.length) return null;
    if (!this._pickValid) this._renderPickScene();
    const gl = this.gl;
    const x = Math.round(px * this.dpr), y = Math.round(this.canvas.height - py * this.dpr);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;
    const p = this._pickPixel;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pick.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // high byte is * 2^24, not << 24: a left shift past bit 30 goes negative in JS.
    const id = p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] * 0x1000000);
    if (id === 0) return null;                  // background / sphere / back hemisphere
    let global = id - 1;
    for (const l of this.layers) {
      if (global < l.nCells) return { layer: l, index: global };
      global -= l.nCells;
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
