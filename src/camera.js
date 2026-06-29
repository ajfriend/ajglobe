// Orthographic globe camera: a quaternion orientation + a zoom (orthographic
// half-extent). Arcball drag and wheel zoom. Emits a change callback so the
// renderer only redraws when something moved.

import { vec3, quat, mat4, lnglatToVec3, vec3ToLngLat } from './glmath.js';

// Keyboard rotation map: e.code -> signed rotation axis in the world frame
// (pre-multiplied like the drag). Directions are by on-screen motion (verified
// empirically — the screen-vertical tilt is the world X axis here, the horizontal
// spin is world Y): Up/Down + W/S move the globe up/down, A/D move it left/right
// (both matching a drag), Left/Right + Q/E roll about the view axis.
const KEY_AXIS = {
  ArrowUp: [-1, 0, 0], KeyW: [-1, 0, 0],    // up
  ArrowDown: [1, 0, 0], KeyS: [1, 0, 0],    // down
  KeyA: [0, -1, 0], KeyD: [0, 1, 0],        // left / right
  ArrowLeft: [0, 0, 1], KeyQ: [0, 0, 1],    // roll
  ArrowRight: [0, 0, -1], KeyE: [0, 0, -1],
};

// The view matrix is constant (orthographic eye on +z looking at the origin) — the
// globe's orientation lives entirely in the model quaternion. Compute it once.
const VIEW = mat4.lookAt([0, 0, 3], [0, 0, 0], [0, 1, 0]);

const DEG = Math.PI / 180;

// Object-space unit "north" (d position / d latitude) at a lng/lat in degrees —
// the tangent pointing toward the north pole. Used to define/read screen roll.
function northAt(lngDeg, latDeg) {
  const lng = lngDeg * DEG, lat = latDeg * DEG, s = Math.sin(lat);
  return [-s * Math.cos(lng), -s * Math.sin(lng), Math.cos(lat)];
}

// Build the model orientation that centers (lng,lat) on the view axis with the
// given screen roll (degrees, 0 = north up). Two shortest-arc steps — center→+z,
// then spin about the view axis to lift north to screen-up — then the roll.
function orient(lngDeg, latDeg, rollDeg) {
  const center = lnglatToVec3(lngDeg, latDeg);
  const q1 = quat.fromUnitVectors(center, [0, 0, 1]);                  // center -> +z
  const n1 = quat.rotateVec3(q1, northAt(lngDeg, latDeg));             // north, now ⊥ +z
  let q = quat.multiply(quat.fromUnitVectors(vec3.norm([n1[0], n1[1], 0]), [0, 1, 0]), q1);
  if (rollDeg) q = quat.multiply(quat.fromAxisAngle([0, 0, 1], rollDeg * DEG), q);
  return quat.normalize(q);
}

export class Camera {
  constructor(canvas, onChange, signal) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.q = quat.identity();      // model orientation
    this.zoom = 1;                 // 1 == globe just fits
    this._drag = null;             // arcball drag state
    this._attach(signal);          // signal (from Orb's AbortController) detaches on destroy
  }

  // Orthographic half-height in world units: globe radius 1 + ~5% margin,
  // divided by zoom. Shared by the arcball unproject (_ball) and the projection.
  _halfExtent() { return 1.05 / this.zoom; }

  // Project a pixel to a point on the virtual arcball (radius = globe radius),
  // in the camera/world frame (z toward the viewer).
  _ball(px, py) {
    const r = this.canvas.getBoundingClientRect();
    const s = this._halfExtent();
    const aspect = r.width / r.height;
    const x = ((2 * px) / r.width - 1) * s * aspect;  // world units on the view plane
    const y = -((2 * py) / r.height - 1) * s;
    const d2 = x * x + y * y;
    return d2 <= 1 ? [x, y, Math.sqrt(1 - d2)] : vec3.norm([x, y, 0]);
  }

  _attach(signal) {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      // Track the previous ball vector so each move is an INCREMENTAL rotation
      // (not cumulative-from-start).
      this._drag = { v: this._ball(e.offsetX, e.offsetY) };
    }, { signal });
    c.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const v1 = this._ball(e.offsetX, e.offsetY);
      const delta = quat.fromUnitVectors(this._drag.v, v1);   // incremental step
      this.q = quat.normalize(quat.multiply(delta, this.q));
      this._drag.v = v1;                   // advance reference -> per-move deltas
      this.onChange();
    }, { signal });
    // Direct drag: the globe stops where you release it. (A time-normalized
    // momentum fling can return later as a tuned, opt-in feature; the naive
    // constant-decay version amplified tiny drags into a disorienting spin.)
    const end = () => { this._drag = null; };
    c.addEventListener('pointerup', end, { signal });
    c.addEventListener('pointercancel', end, { signal });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.3, Math.min(50, this.zoom * Math.exp(-e.deltaY * 0.001)));
      this.onChange();
    }, { passive: false, signal });
    // Keyboard rotation, scoped to the (focusable) canvas so it never hijacks the
    // host page's keys. Up/Down + W/S tilt (screen X), A/D spin (screen Y),
    // Left/Right + Q/E roll (screen Z). Step 10°, 30° with Shift. Each is a
    // world-frame (screen-aligned) rotation, pre-multiplied like the drag.
    if (c.tabIndex < 0) c.tabIndex = 0;
    c.addEventListener('keydown', (e) => {
      const axis = KEY_AXIS[e.code];
      if (!axis) return;
      e.preventDefault();
      const delta = quat.fromAxisAngle(axis, (e.shiftKey ? 30 : 10) * Math.PI / 180);
      this.q = quat.normalize(quat.multiply(delta, this.q));
      this.onChange();
    }, { signal });
  }

  // Point the camera at a given lng/lat (animation-free; sets orientation), north
  // up. Sugar for setView({ lng, lat, roll: 0 }) keeping the current zoom.
  lookAt(lngDeg, latDeg) {
    this.q = orient(lngDeg, latDeg, 0);
    this.onChange();
  }

  // The view as both a human-readable chart AND the exact orientation:
  //   { lng, lat, roll, zoom, q }
  // lng/lat = the geographic point at screen center; roll = screen twist in
  // degrees (0 = north up); zoom; q = the exact unit quaternion. The human fields
  // are for reading / editing / hard-coding a view you found interactively; q is
  // the lossless field — pass the whole object back to setView() to restore it
  // bit-exactly (q wins). lng/roll degenerate at the poles (lat = ±90); q does not.
  getView() {
    const { lng, lat, roll } = this._decompose();
    return { lng, lat, roll, zoom: this.zoom, q: this.q.slice() };
  }

  // Apply a view. Accepts either form (all fields optional):
  //   { q, zoom }                 -> exact restore (q takes precedence)
  //   { lng, lat, roll, zoom }    -> human form; omitted lng/lat/roll are kept
  //                                  from the current orientation, north up by default
  //   { zoom } / {}               -> zoom-only (or no-op), orientation untouched
  // Idempotent: if the resulting view equals the current one exactly, do nothing
  // (no redraw, no 'viewchange'). That makes a viewchange->setView sync loop
  // self-terminate without a guard flag — the echoed setView({...q}) is a no-op.
  setView(v = {}) {
    const nz = v.zoom ?? this.zoom;
    let nq;
    if (v.q != null) {
      nq = v.q;                                          // exact orientation wins
    } else if (v.lng != null || v.lat != null || v.roll != null) {
      const cur = this._decompose();                     // fill the omitted human fields
      nq = orient(v.lng ?? cur.lng, v.lat ?? cur.lat, v.roll ?? cur.roll);
    } else {
      nq = this.q;                                        // zoom-only / empty
    }
    if (nz === this.zoom && nq.length === this.q.length && nq.every((x, i) => x === this.q[i])) return;
    this.q = nq.slice();           // copy so a caller's array can't alias internal state
    this.zoom = nz;
    this.onChange();
  }

  // Read the current orientation as { lng, lat, roll } (degrees). The centered
  // point is q⁻¹·(+z) (the object point that lands on the view axis); roll is the
  // angle of local north away from screen-up after the model rotation.
  _decompose() {
    const [x, y, z, w] = this.q;
    const center = quat.rotateVec3([-x, -y, -z, w], [0, 0, 1]);   // conjugate · +z
    const { lng, lat } = vec3ToLngLat(center);
    const nv = quat.rotateVec3(this.q, northAt(lng, lat));        // north in view space
    return { lng, lat, roll: Math.atan2(-nv[0], nv[1]) / DEG };
  }

  mvp(aspect) {
    const s = this._halfExtent();
    const proj = mat4.ortho(-s * aspect, s * aspect, -s, s, 0.1, 10);
    const model = mat4.fromQuat(this.q);
    return mat4.multiply(proj, mat4.multiply(VIEW, model));
  }

  // Geographic point -> canvas CSS pixels. visible=false when the point is on
  // the far (back) hemisphere, behind the globe from the viewer.
  project(lngDeg, latDeg) {
    const p = lnglatToVec3(lngDeg, latDeg);
    const r = this.canvas.getBoundingClientRect();
    const clip = mat4.mulVec4(this.mvp(r.width / r.height), [p[0], p[1], p[2], 1]);
    return {
      x: (clip[0] / clip[3] * 0.5 + 0.5) * r.width,
      y: (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * r.height,
      // Front hemisphere = the model-rotated point faces the +z viewer.
      visible: quat.rotateVec3(this.q, p)[2] > 0,
    };
  }

  // Canvas CSS pixel -> { lng, lat } where the view ray meets the globe, or null
  // if the pixel misses it. inv(MVP) maps NDC straight to OBJECT (geographic)
  // space — MVP already bakes in the model rotation — so we intersect the unit
  // sphere there and read lng/lat off the hit directly (no extra un-rotation).
  unproject(px, py) {
    const r = this.canvas.getBoundingClientRect();
    const inv = mat4.invert(this.mvp(r.width / r.height));
    if (!inv) return null;
    const nx = (px / r.width) * 2 - 1, ny = 1 - (py / r.height) * 2;
    const at = (z) => { const v = mat4.mulVec4(inv, [nx, ny, z, 1]); return [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; };
    const a = at(-1), d = vec3.sub(at(1), a);            // ray a + t d (object space)
    const A = vec3.dot(d, d), B = 2 * vec3.dot(a, d), C = vec3.dot(a, a) - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;                            // misses the globe
    const t = (-B - Math.sqrt(disc)) / (2 * A);          // nearest (front) intersection
    return vec3ToLngLat([a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]);
  }
}
