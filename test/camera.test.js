// Camera project/unproject geometry, headless via a stub canvas (no DOM/WebGL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.js';
import { vec3, quat, lnglatToVec3, quatToLngLat } from '../src/glmath.js';

// Stub only what Camera actually touches: a bounding rect, style, listener
// registry (from _attach), setPointerCapture, and a settable tabIndex.
// dispatch() fires registered handlers with mouse-ish defaults so tests can
// drive the gesture handlers with plain objects — no jsdom, no PointerEvent.
function stubCanvas(w = 800, h = 600) {
  const L = {};
  return {
    tabIndex: -1, style: {},
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h }),
    addEventListener(type, fn) { (L[type] ||= []).push(fn); },
    setPointerCapture() {},
    dispatch(type, e = {}) {
      for (const fn of L[type] || []) fn({ type, pointerType: 'mouse', preventDefault() { e.defaulted = true; }, ...e });
    },
  };
}
const newCam = () => new Camera(stubCanvas(), () => {}, new AbortController().signal);
// Camera with a call-counting notify, to assert when a change does/doesn't commit.
function countingCam() {
  const calls = { n: 0 };
  const cam = new Camera(stubCanvas(), () => { calls.n++; }, new AbortController().signal);
  return { cam, calls };
}
// Camera wired for gesture tests: exposes its stub canvas and collects hints.
function gestureCam(interaction) {
  const c = stubCanvas(), hints = [];
  const cam = new Camera(c, (type, e) => { if (type === 'gesturehint') hints.push({ type, ...e }); },
                         new AbortController().signal, interaction);
  return { cam, c, hints };
}
const touch = (id, x, y) => ({ pointerId: id, pointerType: 'touch', offsetX: x, offsetY: y });
// Quaternion similarity: |q1.q2| ~ 1 means same rotation (q and -q are the same).
const qdot = (a, b) => Math.abs(a.reduce((s, v, i) => s + v * b[i], 0));

test('project ∘ unproject roundtrips on the front hemisphere', () => {
  const cam = newCam();
  cam.lookAt(10, 20);
  for (const [lng, lat] of [[10, 20], [25, 35], [-15, 40], [40, -5], [-30, -25]]) {
    const p = cam.project(lng, lat);
    assert.ok(p.visible, `(${lng},${lat}) should be on the front hemisphere`);
    const u = cam.unproject(p.x, p.y);
    assert.ok(u, 'unproject should hit the globe');
    // compare as unit vectors to sidestep lng wrap / pole degeneracy
    const err = vec3.angle(lnglatToVec3(lng, lat), lnglatToVec3(u.lng, u.lat));
    assert.ok(err < 1e-5, `roundtrip error ${err} rad`);
  }
});

test('visible flag: front hemisphere true, back false', () => {
  const cam = newCam();
  cam.lookAt(0, 0);
  assert.equal(cam.project(0, 0).visible, true);     // sub-viewer point
  assert.equal(cam.project(180, 0).visible, false);  // antipode -> back hemisphere
  assert.equal(cam.project(89, 0).visible, true);    // just inside the limb
});

test('unproject of a pixel that misses the globe is null', () => {
  const cam = newCam();
  cam.lookAt(0, 0);
  assert.equal(cam.unproject(0, 0), null);           // top-left corner, outside the disc
});

test('getView/setView round-trips a view exactly (and the snapshot is a copy)', () => {
  const cam = newCam();
  cam.lookAt(25, 40);
  cam.setView({ zoom: 2.5 });
  const snap = cam.getView();                         // { q, zoom }
  cam.lookAt(-100, -10);                              // move away
  assert.notDeepEqual(cam.getView(), snap);
  cam.setView(snap);                                  // restore
  assert.deepEqual(cam.getView(), snap);
  snap.q[0] = 999;                                    // mutating the snapshot must not leak in
  assert.notEqual(cam.q[0], 999);
});

test('lookAt centers the point with north up (roll ~ 0, via quatToLngLat)', () => {
  const cam = newCam();
  for (const [lng, lat] of [[0, 0], [25, 40], [-100, -10], [140, 60]]) {
    cam.lookAt(lng, lat);
    const v = quatToLngLat(cam.getView().q);
    const err = vec3.angle(lnglatToVec3(lng, lat), lnglatToVec3(v.lng, v.lat));
    assert.ok(err < 1e-5, `center off by ${err} rad`);            // centered point recovered
    assert.ok(Math.abs(v.roll) < 1e-4, `roll ${v.roll}° not ~0 after lookAt`);
  }
});

test('setView is idempotent: re-applying the current view does not emit', () => {
  const { cam, calls } = countingCam();
  cam.lookAt(10, 20);                                 // 1 change
  calls.n = 0;
  cam.setView(cam.getView());                         // identical view -> no-op
  cam.setView({});                                    // nothing supplied -> no-op
  cam.setView({ q: cam.q.slice(), zoom: cam.zoom });  // exact copy -> no-op
  assert.equal(calls.n, 0);
});

test('setView emits once when q or zoom actually changes', () => {
  const { cam, calls } = countingCam();
  calls.n = 0;
  cam.setView({ zoom: cam.zoom + 1 });               // zoom changed
  assert.equal(calls.n, 1);
  cam.setView({ q: quat.fromAxisAngle([0, 1, 0], 0.5) });  // q changed
  assert.equal(calls.n, 2);
});

test('setView accepts partial views (zoom-only / q-only)', () => {
  const cam = newCam();
  cam.lookAt(30, 15);
  const q0 = cam.q.slice();
  cam.setView({ zoom: 4 });                          // zoom-only leaves q untouched
  assert.deepEqual(cam.q, q0);
  assert.equal(cam.zoom, 4);
  const q1 = quat.fromAxisAngle([1, 0, 0], 0.3);
  cam.setView({ q: q1 });                            // q-only leaves zoom untouched
  assert.deepEqual([...cam.q], [...q1]);
  assert.equal(cam.zoom, 4);
});

// ---------------------------------------------------------------------------
// Gestures: pinch zoom, two-finger rotate, cooperative mode. Driven through
// the stub's dispatch(); geometry facts used below (800x600 canvas, zoom 1):
// canvas center is (400,300) and _ball(400,300) = [0,0,1].

test('pinch: zoom follows the spread ratio', () => {
  const { cam, c } = gestureCam();
  c.dispatch('pointerdown', touch(1, 300, 300));
  c.dispatch('pointerdown', touch(2, 500, 300));
  c.dispatch('pointermove', touch(1, 200, 300));   // dist 200 -> 300
  assert.ok(Math.abs(cam.zoom - 1.5) < 1e-12, `zoom ${cam.zoom} != 1.5`);
  c.dispatch('pointermove', touch(2, 600, 300));   // dist 300 -> 400
  assert.ok(Math.abs(cam.zoom - 2) < 1e-12, `zoom ${cam.zoom} != 2`);
});

test('pinch: zoom clamps at the wheel rails (0.3, 50)', () => {
  const hi = gestureCam();
  hi.cam.setView({ zoom: 40 });
  hi.c.dispatch('pointerdown', touch(1, 300, 300));
  hi.c.dispatch('pointerdown', touch(2, 500, 300));
  hi.c.dispatch('pointermove', touch(1, 100, 300)); // dist 200 -> 400: 40*2 -> clamp 50
  assert.equal(hi.cam.zoom, 50);
  const lo = gestureCam();
  lo.cam.setView({ zoom: 0.4 });
  lo.c.dispatch('pointerdown', touch(1, 200, 300));
  lo.c.dispatch('pointerdown', touch(2, 600, 300));
  lo.c.dispatch('pointermove', touch(1, 350, 300));
  lo.c.dispatch('pointermove', touch(2, 450, 300)); // dist 400 -> 100: 0.4*0.25 -> clamp 0.3
  assert.equal(lo.cam.zoom, 0.3);
});

test('two-finger translate rotates like the equivalent single drag of the midpoint', () => {
  const two = gestureCam();
  two.c.dispatch('pointerdown', touch(1, 300, 280));
  two.c.dispatch('pointerdown', touch(2, 500, 320));
  two.c.dispatch('pointermove', touch(1, 340, 280)); // both fingers +40px x,
  two.c.dispatch('pointermove', touch(2, 540, 320)); // net spread unchanged
  // Events are sequential, so the spread wobbles between the two moves (the
  // intermediate zoom perturbs the second step's arcball scale slightly) —
  // net zoom returns to ~1 and the rotation approximates the mouse drag.
  assert.ok(Math.abs(two.cam.zoom - 1) < 1e-9, `zoom ${two.cam.zoom} drifted`);
  const one = gestureCam();
  one.c.dispatch('pointerdown', { pointerId: 9, offsetX: 400, offsetY: 300 });
  one.c.dispatch('pointermove', { pointerId: 9, offsetX: 420, offsetY: 300 }); // midpoint path,
  one.c.dispatch('pointermove', { pointerId: 9, offsetX: 440, offsetY: 300 }); // same increments
  assert.ok(qdot(one.cam.q, two.cam.q) > 1 - 1e-4, 'midpoint drag and mouse drag should match');
});

test('2->1 handoff rebases on the survivor: next move at its coords is a no-op', () => {
  const { cam, c } = gestureCam();
  c.dispatch('pointerdown', touch(1, 300, 300));
  c.dispatch('pointerdown', touch(2, 500, 300));
  c.dispatch('pointermove', touch(1, 350, 320));    // pinch a bit
  c.dispatch('pointerup', touch(2, 500, 300));      // lift one finger
  const { q, zoom } = cam.getView();
  c.dispatch('pointermove', touch(1, 350, 320));    // survivor, unmoved
  assert.equal(cam.zoom, zoom);
  assert.ok(qdot(q, cam.q) > 1 - 1e-12, 'no jump across the 2->1 transition');
});

test('third finger is ignored while held, promoted after a lift', () => {
  const { cam, c } = gestureCam();
  c.dispatch('pointerdown', touch(1, 300, 300));
  c.dispatch('pointerdown', touch(2, 500, 300));
  const qRef = cam.q;
  c.dispatch('pointerdown', touch(3, 100, 100));
  c.dispatch('pointermove', touch(3, 700, 500));    // wild move: no effect
  assert.equal(cam.q, qRef);                        // q never replaced
  assert.equal(cam.zoom, 1);
  c.dispatch('pointerup', touch(1, 300, 300));      // now fingers 2+3 drive
  c.dispatch('pointermove', touch(3, 600, 400));    // dist 283 -> 141: zoom halves
  assert.ok(Math.abs(cam.zoom - 0.5) < 1e-12, `zoom ${cam.zoom} != 0.5`);
});

test('cooperative: lone touch is the page\'s (mouse drag still works)', () => {
  const { cam, c } = gestureCam({ cooperative: true });
  const qRef = cam.q;
  c.dispatch('pointerdown', touch(1, 300, 300));
  c.dispatch('pointermove', touch(1, 400, 350));
  assert.equal(cam.q, qRef, 'single touch must not rotate');
  c.dispatch('pointerup', touch(1, 400, 350));
  c.dispatch('pointerdown', { pointerId: 9, offsetX: 300, offsetY: 300 });
  c.dispatch('pointermove', { pointerId: 9, offsetX: 400, offsetY: 350 });
  assert.notEqual(cam.q, qRef, 'mouse drag must still rotate');
});

test('cooperative: two touches pinch even though one is inert', () => {
  const { cam, c } = gestureCam({ cooperative: true });
  c.dispatch('pointerdown', touch(1, 300, 300));
  c.dispatch('pointerdown', touch(2, 500, 300));
  c.dispatch('pointermove', touch(1, 200, 300));   // dist 200 -> 300
  assert.ok(Math.abs(cam.zoom - 1.5) < 1e-12);
});

test('non-cooperative: single touch still rotates (phones without a page to scroll)', () => {
  const { cam, c } = gestureCam();
  const qRef = cam.q;
  c.dispatch('pointerdown', touch(1, 300, 300));
  c.dispatch('pointermove', touch(1, 400, 350));
  assert.notEqual(cam.q, qRef);
});

test('cooperative wheel: plain scrolls the page (hint), ctrl/meta zooms', () => {
  const { cam, c, hints } = gestureCam({ cooperative: true });
  const plain = { deltaY: -100 };
  c.dispatch('wheel', plain);
  assert.equal(cam.zoom, 1);
  assert.equal(plain.defaulted, undefined, 'plain wheel must not preventDefault');
  assert.deepEqual(hints, [{ type: 'gesturehint', kind: 'wheel' }]);
  const ctrl = { deltaY: -100, ctrlKey: true };
  c.dispatch('wheel', ctrl);
  assert.ok(cam.zoom > 1);
  assert.equal(ctrl.defaulted, true);
  assert.equal(hints.length, 1, 'zooming wheel does not hint');
});

test('touch hint: fires on cancel of a lone touch; not on tap; not out of a pinch', () => {
  const a = gestureCam({ cooperative: true });         // browser reclaims -> hint
  a.c.dispatch('pointerdown', touch(1, 300, 300));
  a.c.dispatch('pointercancel', touch(1, 310, 340));
  assert.deepEqual(a.hints, [{ type: 'gesturehint', kind: 'touch' }]);
  const b = gestureCam({ cooperative: true });         // tap -> pointerup -> silent
  b.c.dispatch('pointerdown', touch(1, 300, 300));
  b.c.dispatch('pointerup', touch(1, 300, 300));
  assert.deepEqual(b.hints, []);
  const p = gestureCam({ cooperative: true });         // cancel out of a pinch -> silent
  p.c.dispatch('pointerdown', touch(1, 300, 300));
  p.c.dispatch('pointerdown', touch(2, 500, 300));
  p.c.dispatch('pointercancel', touch(1, 300, 300));
  p.c.dispatch('pointercancel', touch(2, 500, 300));
  assert.deepEqual(p.hints, []);
});

test('touch-action plumbing: none / pan-x pan-y / untouched without drag', () => {
  assert.equal(gestureCam().c.style.touchAction, 'none');
  assert.equal(gestureCam({ cooperative: true }).c.style.touchAction, 'pan-x pan-y');
  assert.equal(gestureCam({ drag: false }).c.style.touchAction, undefined);
});

test('cooperative touchmove preventDefaults only multi-finger gestures', () => {
  const { c } = gestureCam({ cooperative: true });
  const two = { touches: [{}, {}] };
  c.dispatch('touchmove', two);
  assert.equal(two.defaulted, true, '2 touches: gesture is ours');
  const one = { touches: [{}] };
  c.dispatch('touchmove', one);
  assert.equal(one.defaulted, undefined, '1 touch: the page scrolls');
});

test('zoom:false locks zoom but keeps two-finger rotation', () => {
  const { cam, c } = gestureCam({ zoom: false });
  const q0 = cam.q;
  c.dispatch('pointerdown', touch(1, 300, 280));
  c.dispatch('pointerdown', touch(2, 500, 320));
  c.dispatch('pointermove', touch(1, 150, 240));   // translate AND spread
  c.dispatch('pointermove', touch(2, 450, 300));
  assert.equal(cam.zoom, 1, 'pinch spread must not zoom');
  assert.notEqual(cam.q, q0, 'two fingers must still rotate');
});

test('zoom:false detaches the wheel listener (no zoom, no preventDefault, no hint)', () => {
  for (const interaction of [{ zoom: false }, { cooperative: true, zoom: false }]) {
    const { cam, c, hints } = gestureCam(interaction);
    const plain = { deltaY: -100 }, ctrl = { deltaY: -100, ctrlKey: true };
    c.dispatch('wheel', plain);
    c.dispatch('wheel', ctrl);
    assert.equal(cam.zoom, 1);
    assert.equal(plain.defaulted, undefined);
    assert.equal(ctrl.defaulted, undefined, 'ctrl+wheel is the page\'s too');
    assert.deepEqual(hints, [], 'no ctrl+scroll hint when zoom is locked');
  }
});

test('zoom:false still allows setView zoom (only user gestures are locked)', () => {
  const { cam } = gestureCam({ zoom: false });
  cam.setView({ zoom: 3 });
  assert.equal(cam.zoom, 3);
});

// Twist: rotating the finger-to-finger vector rolls the globe about the view
// axis, following the fingers. The two sequential moves below rotate the vector
// 90° counterclockwise ON SCREEN around the fixed midpoint (400,300); the
// interleaved midpoint tumble + spread wobble cancel only approximately, hence
// the loose tolerance (a sign error or missing twist lands at dot ~0.7).
function twist90(interaction) {
  const g = gestureCam(interaction);
  g.c.dispatch('pointerdown', touch(1, 300, 300));
  g.c.dispatch('pointerdown', touch(2, 500, 300));
  g.c.dispatch('pointermove', touch(1, 400, 400));
  g.c.dispatch('pointermove', touch(2, 400, 200));
  return g;
}

test('two-finger twist rolls about the view axis (globe follows the fingers)', () => {
  const { cam } = twist90();
  const expect = quat.fromAxisAngle([0, 0, 1], Math.PI / 2);   // screen CCW = world +z
  // 0.99 ~ 16° of slop: the zoom wobble between the sequential moves leaves a
  // few degrees of uncancelled tumble; a missing twist lands at ~0.9, a sign
  // error at ~0.7 (the zoom-locked twin below holds the tighter 0.995).
  assert.ok(qdot(expect, cam.q) > 0.99, `twist quat off (${qdot(expect, cam.q)})`);
  assert.ok(Math.abs(cam.zoom - 1) < 1e-9, `constant spread must not zoom (${cam.zoom})`);
});

test('twist still rolls when zoom is locked', () => {
  const { cam } = twist90({ zoom: false });
  const expect = quat.fromAxisAngle([0, 0, 1], Math.PI / 2);
  assert.ok(qdot(expect, cam.q) > 0.995, `twist quat off (${qdot(expect, cam.q)})`);
  assert.equal(cam.zoom, 1);
});
