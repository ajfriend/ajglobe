// Geometry-math unit tests (Node's built-in runner: `node --test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vec3, quat, mat4, lnglatToVec3, vec3ToLngLat, lnglatToQuat, quatToLngLat } from '../src/glmath.js';

const EPS = 1e-6;
const close = (a, b, eps = EPS) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const vclose = (a, b, eps = EPS) => { for (let i = 0; i < a.length; i++) close(a[i], b[i], eps); };

test('lnglatToVec3: known points are unit vectors', () => {
  vclose(lnglatToVec3(0, 0), [1, 0, 0]);
  vclose(lnglatToVec3(90, 0), [0, 1, 0]);
  vclose(lnglatToVec3(0, 90), [0, 0, 1]);      // north pole = +z
  vclose(lnglatToVec3(180, 0), [-1, 0, 0]);    // antimeridian
  for (const [lng, lat] of [[0, 0], [37, 12], [180, 0], [-120, 60], [10, -80]]) {
    close(vec3.len(lnglatToVec3(lng, lat)), 1);
  }
});

test('lnglatToVec3 ∘ vec3ToLngLat roundtrips (incl. antimeridian, neg lng)', () => {
  for (const [lng, lat] of [[0, 0], [37, 12], [-64, -23], [180, 0], [-179.9, 45]]) {
    const ll = vec3ToLngLat(lnglatToVec3(lng, lat));
    close(ll.lng, lng, 1e-4);
    close(ll.lat, lat, 1e-4);
  }
  // at the pole lng is degenerate; only latitude is meaningful
  close(vec3ToLngLat(lnglatToVec3(123, 90)).lat, 90, 1e-4);
});

test('slerp of (near-)antipodal endpoints stays on the unit sphere', () => {
  // regression: sin(π) cancellation produced ~8e7-magnitude garbage points
  const a = lnglatToVec3(0, 0);
  for (const b of [lnglatToVec3(180, 0), vec3.norm([-1, 1e-8, 0])]) {
    for (const t of [0.25, 0.5, 0.75]) {
      const p = vec3.slerp(a, b, t);
      close(vec3.len(p), 1, 1e-9);
      close(vec3.angle(a, p), t * vec3.angle(a, b), 1e-5);   // uniform along the arc
    }
  }
});

test('lnglatToQuat ∘ quatToLngLat roundtrips lng/lat/roll', () => {
  for (const [lng, lat, roll] of [[0, 0, 0], [30, -15, 25], [-100, 40, -60], [140, 60, 170], [-3, 55, 0]]) {
    const v = quatToLngLat(lnglatToQuat(lng, lat, roll));
    // center via vector angle (dodges lng wrap), roll directly
    close(vec3.angle(lnglatToVec3(lng, lat), lnglatToVec3(v.lng, v.lat)), 0, 1e-5);
    close(v.roll, roll, 1e-4);
  }
});

test('lnglatToQuat: result is a unit quaternion; roll=0 is north up', () => {
  for (const [lng, lat] of [[0, 0], [25, 40], [-100, -10]]) {
    const q = lnglatToQuat(lng, lat);              // roll defaults to 0
    close(Math.hypot(q[0], q[1], q[2], q[3]), 1);  // unit
    close(quatToLngLat(q).roll, 0, 1e-4);          // north up
  }
});

test('vec3.angle / norm', () => {
  close(vec3.angle([1, 0, 0], [0, 1, 0]), Math.PI / 2);
  close(vec3.angle([1, 0, 0], [1, 0, 0]), 0);
  close(vec3.angle([1, 0, 0], [-1, 0, 0]), Math.PI);
  vclose(vec3.norm([3, 0, 0]), [1, 0, 0]);
  vclose(vec3.norm([0, 0, 0]), [0, 0, 0]);     // degenerate -> divide by 1
});

test('vec3.slerp: endpoints, unit midpoint at half the angle', () => {
  const a = [1, 0, 0], b = [0, 1, 0];
  vclose(vec3.slerp(a, b, 0), a);
  vclose(vec3.slerp(a, b, 1), b);
  const mid = vec3.slerp(a, b, 0.5);
  close(vec3.len(mid), 1);
  close(vec3.angle(a, mid), Math.PI / 4);
  vclose(vec3.slerp(a, a, 0.5), a);            // identical inputs short-circuit
});

test('quat.fromAxisAngle: identity at 0, +90° about z maps x̂→ŷ', () => {
  vclose(quat.fromAxisAngle([0, 0, 1], 0), [0, 0, 0, 1]);
  const q = quat.fromAxisAngle([0, 0, 1], Math.PI / 2);
  vclose(quat.rotateVec3(q, [1, 0, 0]), [0, 1, 0]);
});

test('quat.multiply ∘ rotateVec3 compose in order', () => {
  const qA = quat.fromAxisAngle([0, 0, 1], Math.PI / 2);  // x̂ -> ŷ
  const qB = quat.fromAxisAngle([1, 0, 0], Math.PI / 2);  // ŷ -> ẑ
  const v = [1, 0, 0];
  const stepwise = quat.rotateVec3(qB, quat.rotateVec3(qA, v));
  const combined = quat.rotateVec3(quat.multiply(qB, qA), v);
  vclose(combined, stepwise);
  vclose(combined, [0, 0, 1]);
});

test('quat.fromUnitVectors maps a onto b (incl. antiparallel, identical)', () => {
  for (const [a, b] of [[[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [-1, 0, 0]], [[0, 0, 1], [0, 0, 1]]]) {
    vclose(quat.rotateVec3(quat.fromUnitVectors(a, b), a), b, 1e-5);
  }
});

test('quat.normalize', () => {
  vclose(quat.normalize([0, 0, 0, 2]), [0, 0, 0, 1]);
  close(Math.hypot(...quat.normalize([1, 2, 3, 4])), 1);
});

test('mat4.invert: inv(M)·M ≈ identity (the unproject path)', () => {
  const M = mat4.fromQuat(quat.fromAxisAngle([0, 1, 0], 0.7));
  const prod = mat4.multiply(mat4.invert(M), M);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  vclose(prod, I, 1e-5);
  assert.equal(mat4.invert([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0]), null);  // singular -> null
});
