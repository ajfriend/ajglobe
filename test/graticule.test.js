// graticuleLines + smallCircleLines geometry (Node's built-in runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graticuleLines, smallCircleLines } from '../src/orb.js';
import { lnglatToVec3, vec3 } from '../src/glmath.js';

// Split { xyz, starts } back into per-polyline arrays of [x, y, z] points.
function polylines({ xyz, starts }) {
  const out = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const line = [];
    for (let p = starts[i]; p < starts[i + 1]; p++) line.push([xyz[p * 3], xyz[p * 3 + 1], xyz[p * 3 + 2]]);
    out.push(line);
  }
  return out;
}
const DEG = Math.PI / 180;

test('smallCircleLines: closed ring of unit points at the given angular radius', () => {
  const center = [37, 12], radius = 25;
  const [ring] = polylines(smallCircleLines({ center, radius }));
  const n = lnglatToVec3(...center);
  for (const p of ring) {
    assert.ok(Math.abs(vec3.len(p) - 1) < 1e-6, 'unit length');
    assert.ok(Math.abs(vec3.dot(p, n) - Math.cos(radius * DEG)) < 1e-6, 'constant angular radius');
  }
  assert.deepEqual(ring[0], ring[ring.length - 1]);       // closed
});

test('smallCircleLines: sampling converges to the geodesic policy at a great circle', () => {
  // radius 90° IS a great circle: expect ~2π/MAX_SEG (=0.05) segments
  const [ring] = polylines(smallCircleLines({ center: [0, 90], radius: 90 }));
  assert.ok(Math.abs(ring.length - 1 - Math.ceil(2 * Math.PI / 0.05)) <= 1, `segs ${ring.length - 1}`);
  // small circles need fewer samples, scaled by √sin(radius)
  const [small] = polylines(smallCircleLines({ center: [0, 90], radius: 10 }));
  assert.ok(small.length < ring.length / 2, 'small circle samples fewer points');
});

test('default graticule: 36 two-point meridians + 17 parallels, within bounds', () => {
  const lines = polylines(graticuleLines());
  assert.equal(lines.length, 36 + 17);
  const meridians = lines.slice(0, 36), parallels = lines.slice(36);
  for (const m of meridians) {
    assert.equal(m.length, 2);                            // geodesic: endpoints only
    assert.ok(Math.abs(m[0][2] + Math.sin(80 * DEG)) < 1e-6);   // lat −80 …
    assert.ok(Math.abs(m[1][2] - Math.sin(80 * DEG)) < 1e-6);   // … to lat +80
  }
  parallels.forEach((p, i) => {
    const z = Math.sin((-80 + i * 10) * DEG);             // constant latitude, −80..80 by 10
    for (const pt of p) assert.ok(Math.abs(pt[2] - z) < 1e-6, `z ${pt[2]} vs ${z}`);
    assert.deepEqual(p[0], p[p.length - 1]);              // closed ring
  });
});

test('step 15 keeps parallels at symmetric multiples of step', () => {
  const lines = polylines(graticuleLines({ step: 15 }));
  const parallels = lines.filter((l) => l.length > 2);
  assert.equal(lines.length - parallels.length, 24);      // 360 / 15 meridians
  const lats = parallels.map((p) => Math.round(Math.asin(p[0][2]) / DEG));
  assert.deepEqual(lats, [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75]);
});
