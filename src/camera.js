// Orthographic globe camera: a quaternion orientation + a zoom (orthographic
// half-extent). Arcball drag and wheel zoom. Emits a change callback so the
// renderer only redraws when something moved.

import { vec3, quat, mat4, lnglatToVec3, lnglatToQuat, vec3ToLngLat } from './glmath.js';

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

// Framing margin: at zoom 1 the ortho half-extent is MARGIN world units, so the
// globe (radius 1) sits with 5% breathing room. Exported so nothing restates it:
// orb derives px-per-radian from it (dashes), and framed embeds can set
// zoom: MARGIN to make the globe exactly fill its box.
export const MARGIN = 1.05;

export class Camera {
  constructor(canvas, onChange, signal, interaction = {}) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.q = quat.identity();      // model orientation
    this.zoom = 1;                 // 1 == globe just fits
    this._drag = null;             // arcball drag state
    // Which input handlers to attach. Embedded globes (blog posts, dashboards)
    // often want wheel OFF so the page keeps its scroll, while drag still works.
    // getView/setView/lookAt always work regardless — this only gates user input.
    this._attach(signal, { drag: true, wheel: true, keys: true, ...interaction });
  }

  // Orthographic half-height in world units: globe radius 1 + the MARGIN,
  // divided by zoom. Shared by the arcball unproject (_ball) and the projection.
  _halfExtent() { return MARGIN / this.zoom; }

  // Device px per world unit (≈ per radian of arc at the globe center) for a
  // viewport of hPx device pixels — the scale screen-space effects (dashes) use.
  pxPerRad(hPx) { return (hPx / 2) / this._halfExtent(); }

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

  _attach(signal, { drag, wheel, keys }) {
    const c = this.canvas;
    if (drag) {
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
    }
    if (wheel) {
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.zoom = Math.max(0.3, Math.min(50, this.zoom * Math.exp(-e.deltaY * 0.001)));
        this.onChange();
      }, { passive: false, signal });
    }
    // Keyboard rotation, scoped to the (focusable) canvas so it never hijacks the
    // host page's keys. Up/Down + W/S tilt (screen X), A/D spin (screen Y),
    // Left/Right + Q/E roll (screen Z). Step 10° (30° with Shift) DIVIDED BY
    // ZOOM, so the on-screen motion stays constant — a drag scales the same way
    // by construction, and a fixed world-angle step is a wild jump when zoomed
    // in. Each is a world-frame (screen-aligned) rotation, pre-multiplied like
    // the drag.
    if (keys) {
      if (c.tabIndex < 0) c.tabIndex = 0;
      c.addEventListener('keydown', (e) => {
        const axis = KEY_AXIS[e.code];
        if (!axis) return;
        e.preventDefault();
        const delta = quat.fromAxisAngle(axis, ((e.shiftKey ? 30 : 10) / this.zoom) * Math.PI / 180);
        this.q = quat.normalize(quat.multiply(delta, this.q));
        this.onChange();
      }, { signal });
    }
  }

  // Point the camera at a given lng/lat (animation-free; sets orientation), north up.
  lookAt(lngDeg, latDeg) {
    this.q = lnglatToQuat(lngDeg, latDeg, 0);
    this.onChange();
  }

  // The current view as { q, zoom }: q is the exact unit orientation (copied so the
  // snapshot can't alias live state), zoom the orthographic zoom. For a human-readable
  // form, convert: quatToLngLat(view.q) -> { lng, lat, roll }; build one with
  // lnglatToQuat(lng, lat, roll) (both pure, in glmath).
  getView() { return { q: this.q.slice(), zoom: this.zoom }; }

  // Apply a view { q?, zoom? } — both optional (zoom-only keeps the orientation,
  // q-only keeps the zoom). Idempotent: re-applying the current view is a no-op (no
  // redraw, no 'viewchange'), so a viewchange->setView sync loop self-terminates
  // without a guard flag — the echoed setView lands a bit-identical view and no-ops.
  setView({ q, zoom } = {}) {
    const nq = q ?? this.q, nz = zoom ?? this.zoom;
    if (nz === this.zoom && nq.every((v, i) => v === this.q[i])) return;
    if (q != null) this.q = nq.slice();   // copy only a caller-supplied array (can't alias)
    this.zoom = nz;
    this.onChange();
  }

  // Projection · view only (no model rotation): the matrix for screen-aligned
  // geometry like the depth disk, which must not rotate with the globe.
  vp(aspect) {
    const s = this._halfExtent();
    const proj = mat4.ortho(-s * aspect, s * aspect, -s, s, 0.1, 10);
    return mat4.multiply(proj, VIEW);
  }

  // Both frame matrices, sharing one vp computation (the render passes need the
  // pair: vp for the depth disk, mvp for everything that rotates).
  matrices(aspect) {
    const vp = this.vp(aspect);
    return { vp, mvp: mat4.multiply(vp, mat4.fromQuat(this.q)) };
  }

  mvp(aspect) {
    return this.matrices(aspect).mvp;
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
