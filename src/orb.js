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
// (Thick strokes, picking, coastlines, lng/lat input helpers come next.)

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
in vec4 a_color;
uniform mat4 u_mvp;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

const FILL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o_color;
void main() { o_color = v_color; }`;

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
    this.fillU = { mvp: gl.getUniformLocation(this.fillProg, 'u_mvp') };
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
  //   starts       : Uint32Array ring start indices (len = nCells + 1)
  //   fill         : (cellIndex) => [r,g,b,a]  | [r,g,b,a] constant
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

    // per-vertex color from the cell's fill
    const colors = new Uint8Array(nVerts * 4);
    const fillFn = typeof fill === 'function' ? fill : () => fill;
    let triCount = 0;
    for (let c = 0; c < nCells; c++) {
      const s = starts[c], e = starts[c + 1], k = e - s;
      const col = hexRGBA(fillFn(c));
      for (let v = s; v < e; v++) {
        colors[v * 4] = col[0]; colors[v * 4 + 1] = col[1];
        colors[v * 4 + 2] = col[2]; colors[v * 4 + 3] = col[3];
      }
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

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = this._attrib(this.fillProg, 'a_pos', pos, 3);
    const cb = this._attrib(this.fillProg, 'a_color', colors, 4, gl.UNSIGNED_BYTE, true);
    const ib = this._elements(idx);
    gl.bindVertexArray(null);

    const layer = { vao, count: idx.length, nCells, nVerts, _buffers: [pb, cb, ib] };
    layer.remove = () => {
      this.layers = this.layers.filter((l) => l !== layer);
      gl.deleteVertexArray(vao);
      layer._buffers.forEach((b) => gl.deleteBuffer(b));
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

    // 2) polygon fills (depth-tested against the sphere)
    gl.useProgram(this.fillProg);
    gl.uniformMatrix4fv(this.fillU.mvp, false, mvp);
    for (const l of this.layers) {
      gl.bindVertexArray(l.vao);
      gl.drawElements(gl.TRIANGLES, l.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }
}
