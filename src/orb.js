// ajglobe — correct, fast orthographic globe rendering for polygons & lines.
//
// The thesis: never parameterize to 2D. Vertices are points on the unit sphere
// (lng/lat -> xyz once), fills are triangulated by ring TOPOLOGY (a fan over
// vertex indices, coordinate-free), and the back hemisphere is hidden by an
// opaque depth sphere. So the antimeridian and the poles need no special cases —
// they're just points, and a pole that lies inside a convex cell is covered by
// that cell's fan like any other interior point.
//
// Milestone 1: filled convex polygons + background sphere + arcball/zoom.
// M2: per-feature style substrate — each vertex carries a featureId; color lives
// in a per-feature texture sampled by id, so a restyle (layer.update) touches
// nFeatures texels, never the geometry. (Thick strokes, picking, lines come next.)

import { lnglatToVec3Into } from './glmath.js';
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
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

const FILL_VS = `#version 300 es
in vec3 a_pos;
in uint a_featureId;
uniform mat4 u_mvp;
flat out uint v_fid;
void main() {
  v_fid = a_featureId;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

// Color is fetched from the per-feature style texture by id (row-major, width
// u_styleW). texelFetch + NEAREST means an exact lookup, no filtering.
const FILL_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_style;
uniform int u_styleW;
flat in uint v_fid;
out vec4 o_color;
void main() {
  int fid = int(v_fid);
  o_color = texelFetch(u_style, ivec2(fid % u_styleW, fid / u_styleW), 0);
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

function hexRGBA(c) {
  if (Array.isArray(c)) return c.length === 4 ? c : [...c, 255];
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16), 255];
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

export class Orb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 required');
    this.gl = gl;
    this.bg = hexRGBA(opts.background || '#0b0e13').map((x, i) => i < 3 ? x / 255 : 1);
    this.sphereColor = hexRGBA(opts.sphere || '#11151c').map((x) => x / 255);

    this.fillProg = program(gl, FILL_VS, FILL_FS);
    this.sphereProg = program(gl, SPHERE_VS, SPHERE_FS);
    // Uniform locations are fixed after link — resolve once, not per frame.
    this.fillU = {
      mvp: gl.getUniformLocation(this.fillProg, 'u_mvp'),
      style: gl.getUniformLocation(this.fillProg, 'u_style'),
      styleW: gl.getUniformLocation(this.fillProg, 'u_styleW'),
    };
    this.sphereU = {
      mvp: gl.getUniformLocation(this.sphereProg, 'u_mvp'),
      color: gl.getUniformLocation(this.sphereProg, 'u_color'),
    };
    this._buildSphere();

    this.layers = [];
    this.lineLayers = [];
    this._handlers = { hover: [], click: [], viewchange: [] };
    this.cam = new Camera(canvas, () => { this._dirty = true; this._emit('viewchange'); });
    this._dirty = true;
    canvas.addEventListener('pointermove', (e) => this._emitPointer('hover', e));
    canvas.addEventListener('click', (e) => this._emitPointer('click', e));

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    // Per-feature opacity: fill's alpha rides in the style texture; blend it over
    // the depth sphere. Cells don't overlap, so straight alpha needs no sorting.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(...this.bg);

    this._resize();
    new ResizeObserver(() => { this._resize(); this._dirty = true; }).observe(canvas);
    const loop = () => { this._frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
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

  // Subdivide one fan triangle (vertex indices ia,ib,ic into P) onto the sphere
  // when it is coarse enough to sag below the depth sphere; append the new verts
  // to P (positions) and F (feature ids) and push triangles to I. Small triangles
  // emit unchanged (no new verts). Subdivision is uniform per triangle, so very
  // coarse neighbours can leave hairline T-junctions — fine for reference fills.
  _fanTri(P, F, I, fid, ia, ib, ic) {
    const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
    const bx = P[ib * 3], by = P[ib * 3 + 1], bz = P[ib * 3 + 2];
    const cx = P[ic * 3], cy = P[ic * 3 + 1], cz = P[ic * 3 + 2];
    const ang = (ux, uy, uz, vx, vy, vz) => Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy + uz * vz)));
    const maxA = Math.max(ang(ax, ay, az, bx, by, bz), ang(bx, by, bz, cx, cy, cz), ang(ax, ay, az, cx, cy, cz));
    const L = Math.max(1, Math.ceil(maxA / 0.12));
    if (L === 1) { I.push(ia, ib, ic); return; }
    const base = P.length / 3;
    const at = (i, k) => base + (i * (i + 1) / 2 + k);    // index of lattice point (i,k)
    for (let i = 0; i <= L; i++) {
      for (let k = 0; k <= i; k++) {
        const u = (L - i) / L, v = (i - k) / L, w = k / L;  // barycentric over a,b,c
        const x = ax * u + bx * v + cx * w, y = ay * u + by * v + cy * w, z = az * u + bz * v + cz * w;
        const inv = 1 / Math.hypot(x, y, z);                // project onto the unit sphere
        P.push(x * inv, y * inv, z * inv); F.push(fid);
      }
    }
    for (let i = 0; i < L; i++) {
      for (let k = 0; k <= i; k++) {
        I.push(at(i, k), at(i + 1, k), at(i + 1, k + 1));
        if (k < i) I.push(at(i, k), at(i + 1, k + 1), at(i, k + 1));
      }
    }
  }

  _buildSphere() {
    const gl = this.gl;
    // Slightly inside the unit sphere so cells (at r=1) always sit in front of it
    // and the back hemisphere of cells fails the depth test against it.
    const m = uvSphere(0.998);
    this.sphereCount = m.idx.length;
    this.sphereVAO = gl.createVertexArray();
    gl.bindVertexArray(this.sphereVAO);
    this._attrib(this.sphereProg, 'a_pos', m.pos, 3);
    this._elements(m.idx);
    gl.bindVertexArray(null);
  }

  // Add a filled-polygon layer.
  //   xyz | lnglat : Float32Array of vertex positions (3/vertex or 2/vertex)
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
    // chord below the depth sphere (radius 0.998) and get occluded (§8). Gate on
    // the apex-spoke angle: a ring edge is <= 2x a spoke, so spoke < 0.06 rad
    // keeps every fan edge < 0.12 rad (chord sag < 0.002). r5/r6 cells (~1°) never
    // trip it, so their fast path stays as-is.
    const COS_GATE = Math.cos(0.06);
    let fids = new Uint32Array(nVerts);
    let triCount = 0, anyLarge = false;
    for (let c = 0; c < nCells; c++) {
      const s = starts[c], e = starts[c + 1], k = e - s;
      const ax = pos[s * 3], ay = pos[s * 3 + 1], az = pos[s * 3 + 2];
      for (let v = s; v < e; v++) {
        fids[v] = c;
        if (ax * pos[v * 3] + ay * pos[v * 3 + 1] + az * pos[v * 3 + 2] < COS_GATE) anyLarge = true;
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
        for (let j = s + 1; j < e - 1; j++) this._fanTri(P, F, I, c, s, j, j + 1);
      }
      pos = new Float32Array(P);
      fids = new Uint32Array(F);
      idx = new Uint32Array(I);
      nVerts = pos.length / 3;
    }

    // Per-feature style: one RGBA8 texel per feature, indexed by id (row-major in
    // a W-wide texture). Restyle = rewrite these texels; geometry is untouched.
    const fillFn = typeof fill === 'function' ? fill : () => fill;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const W = Math.min(maxTex, 4096);
    const H = Math.max(1, Math.ceil(nCells / W));
    if (H > maxTex) throw new Error(`too many features for one style texture: ${nCells}`);
    const styleTex = this._styleTexture(W, H, this._buildStyle(nCells, W, H, fillFn));

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
    // Restyle without re-tessellating: rewrite the per-feature texels only.
    layer.update = ({ fill: f } = {}) => {
      if (f == null) return layer;
      const fn = typeof f === 'function' ? f : () => f;
      gl.bindTexture(gl.TEXTURE_2D, styleTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE,
        this._buildStyle(nCells, W, H, fn));
      this._dirty = true;
      return layer;
    };
    layer.remove = () => {
      this.layers = this.layers.filter((l) => l !== layer);
      gl.deleteVertexArray(vao);
      layer._buffers.forEach((b) => gl.deleteBuffer(b));
      gl.deleteTexture(styleTex);
      this._dirty = true;
    };
    this.layers.push(layer);
    this._dirty = true;
    return layer;
  }

  // Add a polyline layer drawn as thin GL_LINES (SPIKE — thick AA strokes and
  // great-circle densification are M3/M5). Reuses the sphere program. Vertices
  // ride at radius ~1.0015 so lines sit just above fills yet still depth-test
  // against the sphere (back-hemisphere lines hidden). Drawn in 3D, so the
  // antimeridian is just adjacent points on the sphere — no unwrap.
  //   xyz | lnglat : Float32Array positions (3/vertex or 2/vertex)
  //   starts       : Uint32Array polyline start indices (len = nLines + 1)
  //   color        : '#rrggbb' | [r,g,b,a]
  lines({ xyz, lnglat, starts, color = '#ffffff' }) {
    const gl = this.gl;
    const nLines = starts.length - 1;
    const nVerts = xyz ? xyz.length / 3 : lnglat.length / 2;
    const R = 1.0015;

    const pos = new Float32Array(nVerts * 3);
    for (let v = 0; v < nVerts; v++) {
      if (xyz) { pos[v * 3] = xyz[v * 3]; pos[v * 3 + 1] = xyz[v * 3 + 1]; pos[v * 3 + 2] = xyz[v * 3 + 2]; }
      else lnglatToVec3Into(pos, v * 3, lnglat[v * 2], lnglat[v * 2 + 1]);
      pos[v * 3] *= R; pos[v * 3 + 1] *= R; pos[v * 3 + 2] *= R;
    }

    // GL_LINES index: each polyline [s,e) becomes its (j, j+1) segments.
    let segs = 0;
    for (let l = 0; l < nLines; l++) segs += Math.max(0, starts[l + 1] - starts[l] - 1);
    const idx = new Uint32Array(segs * 2);
    let t = 0;
    for (let l = 0; l < nLines; l++) {
      for (let j = starts[l], e = starts[l + 1]; j < e - 1; j++) { idx[t++] = j; idx[t++] = j + 1; }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = this._attrib(this.sphereProg, 'a_pos', pos, 3);
    const ib = this._elements(idx);
    gl.bindVertexArray(null);

    const col = hexRGBA(color).map((x) => x / 255);
    const layer = { vao, count: idx.length, nLines, nVerts, color: col, _buffers: [pb, ib] };
    layer.remove = () => {
      this.lineLayers = this.lineLayers.filter((l) => l !== layer);
      gl.deleteVertexArray(vao);
      layer._buffers.forEach((b) => gl.deleteBuffer(b));
      this._dirty = true;
    };
    this.lineLayers.push(layer);
    this._dirty = true;
    return layer;
  }

  lookAt(lng, lat) { this.cam.lookAt(lng, lat); }

  // Composition surface (the official overlay API): geo<->screen + events.
  // project(lng,lat) -> { x, y, visible }  (canvas CSS px; visible=false on back)
  // unproject(x,y)   -> { lng, lat } | null (null when the pixel misses the globe)
  project(lng, lat) { return this.cam.project(lng, lat); }
  unproject(x, y) { return this.cam.unproject(x, y); }

  // on('hover'|'click'|'viewchange', cb) -> unsubscribe fn.
  // hover/click payload: { x, y, lng, lat, index } — lng/lat are null off-globe;
  // index is reserved for M4 GPU picking (null until then). viewchange: no arg.
  on(type, cb) {
    (this._handlers[type] ||= []).push(cb);
    return () => { this._handlers[type] = this._handlers[type].filter((f) => f !== cb); };
  }
  _emit(type, e) { const hs = this._handlers[type]; if (hs) for (const f of hs) f(e); }
  _emitPointer(type, e) {
    const hs = this._handlers[type];
    if (!hs || !hs.length) return;          // skip the unproject when nobody listens
    const g = this.cam.unproject(e.offsetX, e.offsetY);
    this._emit(type, { x: e.offsetX, y: e.offsetY, lng: g ? g.lng : null, lat: g ? g.lat : null, index: null });
  }

  get stats() {
    return {
      cells: this.layers.reduce((a, l) => a + l.nCells, 0),
      verts: this.layers.reduce((a, l) => a + l.nVerts, 0),
    };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspect = this.canvas.width / this.canvas.height;
    const mvp = this.cam.mvp(aspect);

    // 1) opaque background sphere (depth) -> hides the back hemisphere
    gl.useProgram(this.sphereProg);
    gl.uniformMatrix4fv(this.sphereU.mvp, false, mvp);
    gl.uniform4f(this.sphereU.color, ...this.sphereColor, 1);
    gl.bindVertexArray(this.sphereVAO);
    gl.drawElements(gl.TRIANGLES, this.sphereCount, gl.UNSIGNED_INT, 0);

    // 2) polygon fills (depth-tested against the sphere). Color comes from each
    // layer's per-feature style texture, sampled by a_featureId.
    gl.useProgram(this.fillProg);
    gl.uniformMatrix4fv(this.fillU.mvp, false, mvp);
    gl.uniform1i(this.fillU.style, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const l of this.layers) {
      gl.bindTexture(gl.TEXTURE_2D, l.styleTex);
      gl.uniform1i(this.fillU.styleW, l.styleW);
      gl.bindVertexArray(l.vao);
      gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
    }

    // 3) line overlays (thin GL_LINES; reuse the sphere program for flat color)
    if (this.lineLayers.length) {
      gl.useProgram(this.sphereProg);
      gl.uniformMatrix4fv(this.sphereU.mvp, false, mvp);
      for (const l of this.lineLayers) {
        gl.uniform4f(this.sphereU.color, l.color[0], l.color[1], l.color[2], l.color[3]);
        gl.bindVertexArray(l.vao);
        gl.drawElements(gl.LINES, l.count, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
  }
}
