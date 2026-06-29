// Camera project/unproject geometry, headless via a stub canvas (no DOM/WebGL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.js';
import { vec3, quat, lnglatToVec3 } from '../src/glmath.js';

// Stub only what Camera actually touches: a bounding rect, addEventListener +
// setPointerCapture (from _attach), and a settable tabIndex.
function stubCanvas(w = 800, h = 600) {
  return {
    tabIndex: -1,
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h }),
    addEventListener() {}, setPointerCapture() {},
  };
}
const newCam = () => new Camera(stubCanvas(), () => {}, new AbortController().signal);
// Camera with a call-counting onChange, to assert when a change does/doesn't commit.
function countingCam() {
  const calls = { n: 0 };
  const cam = new Camera(stubCanvas(), () => { calls.n++; }, new AbortController().signal);
  return { cam, calls };
}

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
  const snap = cam.getView();                         // remember this view
  cam.lookAt(-100, -10);                              // move away
  assert.notDeepEqual(cam.getView(), snap);
  cam.setView(snap);                                  // restore (q present -> exact)
  assert.deepEqual(cam.getView(), snap);
  snap.q[0] = 999;                                    // mutating the snapshot must not leak in
  assert.notEqual(cam.q[0], 999);
});

test('getView is human-readable: lookAt centers the point, north up (roll ~ 0)', () => {
  const cam = newCam();
  for (const [lng, lat] of [[0, 0], [25, 40], [-100, -10], [140, 60]]) {
    cam.lookAt(lng, lat);
    const v = cam.getView();
    const err = vec3.angle(lnglatToVec3(lng, lat), lnglatToVec3(v.lng, v.lat));
    assert.ok(err < 1e-5, `center off by ${err} rad`);            // centered point recovered
    assert.ok(Math.abs(v.roll) < 1e-4, `roll ${v.roll}° not ~0 after lookAt`);
  }
});

test('setView human form round-trips lng/lat/roll/zoom', () => {
  const cam = newCam();
  cam.setView({ lng: 30, lat: -15, roll: 25, zoom: 3 });
  const v = cam.getView();
  assert.ok(Math.abs(v.lng - 30) < 1e-4, `lng ${v.lng}`);
  assert.ok(Math.abs(v.lat + 15) < 1e-4, `lat ${v.lat}`);
  assert.ok(Math.abs(v.roll - 25) < 1e-4, `roll ${v.roll}`);
  assert.equal(v.zoom, 3);
});

test('setView human form keeps omitted fields (roll-only twists in place)', () => {
  const cam = newCam();
  cam.setView({ lng: 50, lat: 10, zoom: 2 });
  cam.setView({ roll: 90 });                          // only roll given
  const v = cam.getView();
  assert.ok(Math.abs(v.lng - 50) < 1e-4 && Math.abs(v.lat - 10) < 1e-4, 'center preserved');
  assert.ok(Math.abs(v.roll - 90) < 1e-4, `roll ${v.roll}`);
  assert.equal(v.zoom, 2, 'zoom preserved');
});

test('setView: explicit q wins over human fields', () => {
  const cam = newCam();
  cam.lookAt(45, 30);
  const exact = cam.getView();
  cam.lookAt(0, 0);
  cam.setView({ ...exact, lng: -170, lat: -80 });     // q present -> lng/lat ignored
  assert.deepEqual(cam.getView(), exact);
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
