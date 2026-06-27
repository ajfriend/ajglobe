// Orthographic globe camera: a quaternion orientation + a zoom (orthographic
// half-extent). Arcball drag, wheel zoom, and release inertia. Emits a change
// callback so the renderer only redraws when something moved.

import { vec3, quat, mat4 } from './glmath.js';

export class Camera {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.q = quat.identity();      // model orientation
    this.zoom = 1;                 // 1 == globe just fits
    this.spin = null;              // {axis, angle} inertia, in world frame
    this._drag = null;             // arcball drag state
    this._attach();
  }

  // Project a pixel to a point on the virtual arcball (radius = globe radius),
  // in the camera/world frame (z toward the viewer).
  _ball(px, py) {
    const r = this.canvas.getBoundingClientRect();
    const s = 1.05 / this.zoom;                       // ortho half-height
    const aspect = r.width / r.height;
    const x = ((2 * px) / r.width - 1) * s * aspect;  // world units on the view plane
    const y = -((2 * py) / r.height - 1) * s;
    const d2 = x * x + y * y;
    return d2 <= 1 ? [x, y, Math.sqrt(1 - d2)] : vec3.norm([x, y, 0]);
  }

  _attach() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.spin = null;
      // Track the previous ball vector so each move is an INCREMENTAL rotation
      // (not cumulative-from-start); inertia then coasts at the per-move rate.
      this._drag = { v: this._ball(e.offsetX, e.offsetY), last: null, lastT: e.timeStamp };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const v1 = this._ball(e.offsetX, e.offsetY);
      const delta = quat.fromUnitVectors(this._drag.v, v1);   // incremental step
      this.q = quat.normalize(quat.multiply(delta, this.q));
      this._drag.v = v1;                   // advance reference -> per-move deltas
      this._drag.last = delta;
      this._drag.lastT = e.timeStamp;
      this.onChange();
    });
    // Direct drag: the globe stops where you release it. (A time-normalized
    // momentum fling can return later as a tuned, opt-in feature; the naive
    // constant-decay version amplified tiny drags into a disorienting spin.)
    const end = () => { this._drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.3, Math.min(50, this.zoom * Math.exp(-e.deltaY * 0.001)));
      this.onChange();
    }, { passive: false });
  }

  // Advance inertia one frame; returns true if still animating.
  tick() {
    if (!this.spin) return false;
    const d = quat.fromAxisAngle(this.spin.axis, this.spin.angle);
    this.q = quat.normalize(quat.multiply(d, this.q));
    this.spin.angle *= 0.92;
    if (Math.abs(this.spin.angle) < 0.0008) { this.spin = null; return false; }
    return true;
  }

  // Point the camera at a given lng/lat (animation-free; sets orientation).
  lookAt(lngDeg, latDeg) {
    // Rotate so that (lng,lat) lands at the sub-viewer point (+z).
    const lng = (lngDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
    const c = Math.cos(lat);
    const target = [c * Math.cos(lng), c * Math.sin(lng), Math.sin(lat)];
    this.q = quat.fromUnitVectors(target, [0, 0, 1]);
    this.spin = null;
    this.onChange();
  }

  mvp(aspect) {
    const s = 1.05 / this.zoom;
    const proj = mat4.ortho(-s * aspect, s * aspect, -s, s, 0.1, 10);
    const view = mat4.lookAt([0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const model = mat4.fromQuat(this.q);
    return mat4.multiply(proj, mat4.multiply(view, model));
  }
}
