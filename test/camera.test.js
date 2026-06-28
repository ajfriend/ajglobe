// Camera project/unproject geometry, headless via a stub canvas (no DOM/WebGL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.js';
import { vec3, lnglatToVec3 } from '../src/glmath.js';

// Minimal canvas the Camera needs: a bounding rect + no-op listeners + tabIndex.
function stubCanvas(w = 800, h = 600) {
  return {
    width: w, height: h, clientWidth: w, clientHeight: h, tabIndex: -1,
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h }),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
  };
}
const newCam = () => new Camera(stubCanvas(), () => {}, new AbortController().signal);

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
