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
    this.cam = new Camera(canvas, () => { this._dirty = true; });
    this._dirty = true;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
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

    // Per-vertex feature id (the cell each vertex belongs to). Style is NOT baked
    // here — it lives in a per-feature texture sampled by id (built below), so a
    // restyle rewrites nFeatures texels and never touches this geometry. All verts
    // of a cell's fan share its id, so the fragment shader reads it 'flat'.
    const fids = new Uint32Array(nVerts);
    let triCount = 0;
    for (let c = 0; c < nCells; c++) {
      const s = starts[c], e = starts[c + 1], k = e - s;
      for (let v = s; v < e; v++) fids[v] = c;
      if (k >= 3) triCount += k - 2;
    }

    // fan triangulation by TOPOLOGY (indices only — coordinate-free, so it is
    // immune to the antimeridian/pole; valid for convex rings): (s, j, j+1).
    const idx = new Uint32Array(triCount * 3);
    let t = 0;
    for (let c = 0; c < nCells; c++) {
      const s = starts[c], e = starts[c + 1];
      for (let j = s + 1; j < e - 1; j++) {
        idx[t++] = s; idx[t++] = j; idx[t++] = j + 1;
      }
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

  lookAt(lng, lat) { this.cam.lookAt(lng, lat); }
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
    gl.bindVertexArray(null);
  }
}
