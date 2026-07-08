// Orthographic globe camera: a quaternion orientation + a zoom (orthographic
// half-extent). Arcball drag and wheel zoom. Emits a change callback so the
// renderer only redraws when something moved.

import { vec3, quat, mat4, lnglatToVec3, lnglatToQuat, vec3ToLngLat, DEG } from './glmath.js';

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
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => void} onChange  redraw callback
   * @param {AbortSignal} signal   detaches every listener on abort
   * @param {{drag?: boolean, wheel?: boolean, keys?: boolean, cooperative?: boolean}} [interaction]
   *        cooperative: the embedded-map pattern — a single finger pans the PAGE
   *        and a plain wheel scrolls it; two fingers or ctrl/cmd+wheel move the
   *        globe. Mouse/pen drag is unaffected.
   * @param {(type: string, detail: object) => void} [emit]  event channel for
   *        'gesturehint' ({kind:'touch'|'wheel'}) — fired when cooperative mode
   *        passes an input to the page, so app code can show a "use two
   *        fingers" / "ctrl+scroll" overlay.
   */
  constructor(canvas, onChange, signal, interaction = {}, emit = () => {}) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.q = quat.identity();      // model orientation
    this.zoom = 1;                 // 1 == globe just fits
    this._pointers = new Map();    // pointerId -> {x, y, type}; insertion-ordered
    this._ref = null;              // gesture reference: {v} (drag) | {v, dist} (pinch)
    this._pinched = false;         // pinch happened this touch sequence (gates the hint)
    this._emit = emit;
    // Which input handlers to attach. Embedded globes (blog posts, dashboards)
    // often want wheel OFF so the page keeps its scroll, while drag still works;
    // cooperative goes further (see the JSDoc above).
    // getView/setView/lookAt always work regardless — this only gates user input.
    this._attach(signal, { drag: true, wheel: true, keys: true, cooperative: false, ...interaction });
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

  _zoomBy(f) {
    this.zoom = Math.max(0.3, Math.min(50, this.zoom * f));
    this.onChange();
  }

  // Recompute the gesture reference from the pointers currently down. Called on
  // every pointer-count change, so 1<->2 finger transitions are jump-free: each
  // move's delta is measured against the state at the last transition, never
  // across it. A lone touch in cooperative mode gets NO reference — that finger
  // belongs to the page (scroll), not the globe.
  _rebase(cooperative) {
    const P = [...this._pointers.values()];
    if (P.length >= 2) {           // first two (insertion order); extras ignored
      this._ref = { v: this._ball((P[0].x + P[1].x) / 2, (P[0].y + P[1].y) / 2),
                    dist: Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) };
      this._pinched = true;        // sticky until every finger lifts
    } else if (P.length === 1 && !(cooperative && P[0].type === 'touch')) {
      this._ref = { v: this._ball(P[0].x, P[0].y) };
    } else {
      this._ref = null;
      if (P.length === 0) this._pinched = false;
    }
  }

  _attach(signal, { drag, wheel, keys, cooperative }) {
    const c = this.canvas;
    if (drag) {
      // The library owns touch-action (input plumbing on its own canvas, not
      // chrome): cooperative leaves single-finger pans to the page; otherwise
      // every touch is ours. Not restored on destroy() — a successor Orb on the
      // same canvas re-sets it.
      c.style.touchAction = cooperative ? 'pan-x pan-y' : 'none';
      c.addEventListener('pointerdown', (e) => {
        // A lone cooperative touch is tracked but not captured and gets no _ref:
        // either the browser takes it for scrolling (-> pointercancel, the hint
        // cue) or a second finger upgrades it to a pinch. Touch pointers are
        // implicitly captured to their target anyway, so skipping capture here
        // is about intent, not behavior.
        // try: capture throws when the pointer is already gone (lifted before
        // this handler ran, or a synthetic event) — losing capture is fine,
        // losing the whole gesture to the exception is not.
        if (!(cooperative && e.pointerType === 'touch')) {
          try { c.setPointerCapture(e.pointerId); } catch { /* stale/synthetic pointer */ }
        }
        this._pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, type: e.pointerType });
        this._rebase(cooperative);
      }, { signal });
      c.addEventListener('pointermove', (e) => {
        const p = this._pointers.get(e.pointerId);
        if (!p || !this._ref) return;            // hover, or a finger the page owns
        p.x = e.offsetX; p.y = e.offsetY;
        if (this._pointers.size >= 2) {
          const [a, b] = this._pointers.values();
          if (p !== a && p !== b) return;        // third finger: tracked, ignored
          // Rotate by the midpoint's arcball delta, then zoom by the spread
          // ratio, then re-anchor the reference at the NEW zoom (_ball depends
          // on zoom) so zoom never bleeds into rotation on the next move.
          const delta = quat.fromUnitVectors(this._ref.v, this._ball((a.x + b.x) / 2, (a.y + b.y) / 2));
          this.q = quat.normalize(quat.multiply(delta, this.q));
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          if (dist > 0 && this._ref.dist > 0) this._zoomBy(dist / this._ref.dist);
          else this.onChange();                  // coincident fingers: 0/0 zoom would poison the view with NaN
          this._ref = { v: this._ball((a.x + b.x) / 2, (a.y + b.y) / 2), dist };
        } else {
          // Track the previous ball vector so each move is an INCREMENTAL
          // rotation (not cumulative-from-start).
          const v1 = this._ball(e.offsetX, e.offsetY);
          const delta = quat.fromUnitVectors(this._ref.v, v1);
          this.q = quat.normalize(quat.multiply(delta, this.q));
          this._ref.v = v1;                      // advance reference -> per-move deltas
          this.onChange();
        }
      }, { signal });
      // Direct drag: the globe stops where you release it. (A time-normalized
      // momentum fling can return later as a tuned, opt-in feature; the naive
      // constant-decay version amplified tiny drags into a disorienting spin.)
      const end = (e) => {
        const p = this._pointers.get(e.pointerId);
        this._pointers.delete(e.pointerId);
        // pointercancel of a lone cooperative touch = the browser took it to
        // scroll — the cue for "use two fingers". Taps end in pointerup (no
        // hint); a finger cancelled out of a pinch is covered by _pinched.
        if (e.type === 'pointercancel' && cooperative && p?.type === 'touch'
            && this._pointers.size === 0 && !this._pinched) {
          this._emit('gesturehint', { kind: 'touch' });
        }
        this._rebase(cooperative);
      };
      c.addEventListener('pointerup', end, { signal });
      c.addEventListener('pointercancel', end, { signal });
      // touch-action 'pan-x pan-y' is finger-count-blind (the browser may claim
      // a two-finger PAN as a scroll), and iOS Safari's viewport pinch-zoom has
      // ignored touch-action alone — a non-passive preventDefault while 2+
      // touches are down keeps multi-finger gestures ours, while a single
      // finger stays the page's.
      if (cooperative) c.addEventListener('touchmove', (e) => {
        if (e.touches.length >= 2) e.preventDefault();
      }, { passive: false, signal });
    }
    if (wheel) {
      c.addEventListener('wheel', (e) => {
        if (cooperative && !e.ctrlKey && !e.metaKey) {
          // The page keeps plain scroll; hint how to zoom. No throttle here —
          // the app's fade-timer reset is the debounce, and emitting with no
          // listeners is a no-op. (Trackpad pinches arrive as ctrlKey wheel
          // events, so they zoom the globe with no extra code.)
          this._emit('gesturehint', { kind: 'wheel' });
          return;
        }
        e.preventDefault();        // also blocks ctrl+wheel browser page-zoom
        this._zoomBy(Math.exp(-e.deltaY * 0.001));
      }, { passive: false, signal });
    }
    // Keyboard rotation, scoped to the (focusable) canvas so it never hijacks the
    // host page's keys. Up/Down + W/S tilt (screen X), A/D spin (screen Y),
    // Left/Right + Q/E roll (screen Z). Step 10° (30° with Shift). Tilt/spin
    // divide by zoom so their on-screen motion stays constant (they translate
    // content across the view, which magnifies with zoom — same scaling a drag
    // gets by construction); roll does NOT scale — it twists about the view
    // axis, and 10° of twist looks like 10° at any zoom. Each is a world-frame
    // (screen-aligned) rotation, pre-multiplied like the drag.
    if (keys) {
      if (c.tabIndex < 0) c.tabIndex = 0;
      c.addEventListener('keydown', (e) => {
        const axis = KEY_AXIS[e.code];
        if (!axis) return;
        e.preventDefault();
        const scale = axis[2] !== 0 ? 1 : this.zoom;    // roll = screen-Z axis
        const delta = quat.fromAxisAngle(axis, ((e.shiftKey ? 30 : 10) / scale) * DEG);
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
  // pair: vp for the depth disk, mvp for everything that rotates). Cached per
  // (orientation, zoom, aspect): this.q is REPLACED — never mutated in place —
  // on every view change, so reference identity keys the cache; the inverse is
  // computed lazily by unproject and rides along. Matters for label overlays
  // calling project()/unproject() per feature per frame: one matrix build
  // instead of N.
  matrices(aspect) {
    const c = this._mats;
    if (c && c.q === this.q && c.zoom === this.zoom && c.aspect === aspect) return c;
    // Freeze the cached orientation: the cache key is q's reference identity,
    // which is sound only while q is replaced rather than mutated. Freezing
    // turns a future in-place write (which would silently serve stale
    // matrices) into a loud TypeError at the offending site.
    Object.freeze(this.q);
    const vp = this.vp(aspect);
    return (this._mats = {
      q: this.q, zoom: this.zoom, aspect,
      vp, mvp: mat4.multiply(vp, mat4.fromQuat(this.q)), inv: undefined,
    });
  }

  mvp(aspect) {
    return this.matrices(aspect).mvp;
  }

  // Geographic point -> canvas CSS pixels. visible=false when the point is on
  // the far (back) hemisphere, behind the globe from the viewer. (px <-> NDC
  // y-flip convention: mirror of unproject's.)
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
    const m = this.matrices(r.width / r.height);
    const inv = m.inv !== undefined ? m.inv : (m.inv = mat4.invert(m.mvp));
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
