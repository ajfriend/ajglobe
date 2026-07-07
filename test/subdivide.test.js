// Large-cell fill subdivision (Node's built-in runner: `node --test`).
// The crack-free property is the point: shared edges must subdivide identically
// in both adjacent triangles, or hairline slivers open along them (§8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subdivideTri, fanFillGeometry } from '../src/tess.js';
import { lnglatToVec3, vec3 } from '../src/glmath.js';

// Run subdivideTri over a list of triangles given as lng/lat corner triples;
// returns the {P, F, I} arrays it filled.
function subdivide(tris) {
  const P = [], F = [], I = [];
  for (let k = 0; k < tris.length; k++) {
    const ids = tris[k].map(([lng, lat]) => {
      P.push(...lnglatToVec3(lng, lat)); F.push(k);
      return P.length / 3 - 1;
    });
    subdivideTri(P, F, I, k, ...ids);
  }
  return { P, F, I };
}

// All boundary points a triangle contributes along the edge between unit
// vectors u and v (points on that great-circle arc, keyed to kill float noise).
function edgePoints(P, I, u, v) {
  const n = vec3.cross(u, v), nl = vec3.len(n), uv = vec3.dot(u, v);
  const keys = new Set();
  for (const i of I) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    if (Math.abs(vec3.dot(p, n) / nl) > 1e-9) continue;                  // on the great circle
    if (vec3.dot(p, u) < uv - 1e-9 || vec3.dot(p, v) < uv - 1e-9) continue;  // between u and v
    keys.add(p.map((x) => x.toFixed(12)).join(','));
  }
  return keys;
}

test('small triangles pass through unsubdivided', () => {
  const { P, I } = subdivide([[[0, 0], [1, 0], [0, 1]]]);   // ~0.017 rad edges
  assert.equal(P.length, 9);
  assert.deepEqual(I, [0, 1, 2]);
});

test('coarse triangles subdivide; every vertex lands on the unit sphere', () => {
  const { P, I } = subdivide([[[0, 0], [12, 0], [0, 12]]]); // ~0.21 rad edges
  assert.ok(I.length > 3 * 4, 'expected real subdivision');
  for (let i = 0; i < P.length; i += 3) {
    const r = Math.hypot(P[i], P[i + 1], P[i + 2]);
    assert.ok(Math.abs(r - 1) < 1e-12, `vertex radius ${r}`);
  }
});

test('subdivided interior hugs the sphere (bounded chord sag)', () => {
  const { P, I } = subdivide([[[0, 0], [12, 0], [0, 12]]]);
  // sample each output triangle's interior; residual flat-chord sag is what
  // bounds boundary-curvature error and limb-coverage shortfall (see orb.js)
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
    for (const [u, v, w] of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]) {
      const x = u * P[a * 3] + v * P[b * 3] + w * P[c * 3];
      const y = u * P[a * 3 + 1] + v * P[b * 3 + 1] + w * P[c * 3 + 1];
      const z = u * P[a * 3 + 2] + v * P[b * 3 + 2] + w * P[c * 3 + 2];
      const r = Math.hypot(x, y, z);
      assert.ok(r > 0.9984, `interior point at radius ${r}`);
    }
  }
});

test('an exactly-antipodal edge pair produces no NaN vertices', () => {
  // regression: mid() computed 1/hypot(0,0,0) = Infinity → NaN positions
  const P = [1, 0, 0, -1, 0, 0, 0, 1, 0], F = [0, 0, 0], I = [];
  subdivideTri(P, F, I, 0, 0, 1, 2);
  assert.ok(P.every(Number.isFinite), 'all vertices finite');
});

test('shared edges subdivide identically in both neighbours (no T-junctions)', () => {
  // Two very differently-shaped triangles sharing the edge (0,0)–(10,0): the old
  // per-triangle lattice picked different densities for these (crack); the split
  // decision now depends only on the edge's endpoints, so the boundary point sets
  // must be identical.
  const shared = [[0, 0], [10, 0]];
  const { P, I, F } = subdivide([
    [shared[0], shared[1], [5, 8]],               // tall: all edges long
    [shared[0], [3, -2], shared[1]],              // squat: only the shared edge long
  ]);
  const u = lnglatToVec3(0, 0), v = lnglatToVec3(10, 0);
  const triA = [], triB = [];
  for (let t = 0; t < I.length; t += 3) (F[I[t]] === 0 ? triA : triB).push(I[t], I[t + 1], I[t + 2]);
  const ptsA = edgePoints(P, triA, u, v);
  const ptsB = edgePoints(P, triB, u, v);
  assert.ok(ptsA.size >= 3, `expected the shared edge split (got ${ptsA.size} points)`);
  assert.deepEqual([...ptsA].sort(), [...ptsB].sort());
});

test('fanFillGeometry: per-cell dispatch matches all-cells subdivision exactly', () => {
  // A mixed-resolution layer: one giant cell (trips the coarseness gate) among
  // many fine quads. The hybrid path fans the fine cells directly and routes
  // only the coarse cell through subdivideTri; since fine cells would emit
  // unchanged from subdivideTri anyway (all edges under the split threshold),
  // the position-resolved triangle sets must be IDENTICAL to the old
  // everything-subdivides path.
  const cells = [
    [[-40, -30], [40, -30], [40, 30], [-40, 30]],            // giant: coarse
  ];
  for (let i = 0; i < 20; i++) {                             // fine 1° quads
    const lng = -50 + i * 5, lat = 50;
    cells.push([[lng, lat], [lng + 1, lat], [lng + 1, lat + 1], [lng, lat + 1]]);
  }
  const pos = [], starts = [0];
  for (const ring of cells) {
    for (const [lng, lat] of ring) pos.push(...lnglatToVec3(lng, lat));
    starts.push(starts[starts.length - 1] + ring.length);
  }
  const posF = new Float32Array(pos);
  const g = fanFillGeometry(posF, new Uint32Array(starts), cells.length);

  // reference: the pre-optimization path — every cell through subdivideTri
  const P = Array.from(posF), F = new Array(posF.length / 3).fill(0), I = [];
  for (let c = 0; c < cells.length; c++) {
    for (let v = starts[c]; v < starts[c + 1]; v++) F[v] = c;
    for (let j = starts[c] + 1; j < starts[c + 1] - 1; j++) {
      subdivideTri(P, F, I, c, starts[c], j, j + 1);
    }
  }

  const key = (pos_, fids_, a, b, c) => {
    const p = (i) => `${pos_[i * 3].toFixed(6)},${pos_[i * 3 + 1].toFixed(6)},${pos_[i * 3 + 2].toFixed(6)}`;
    return `${fids_[a]}|` + [p(a), p(b), p(c)].sort().join(';');
  };
  const setOf = (pos_, fids_, idx_) => {
    const s = [];
    for (let t = 0; t < idx_.length; t += 3) s.push(key(pos_, fids_, idx_[t], idx_[t + 1], idx_[t + 2]));
    return s.sort();
  };
  assert.equal(g.idx.length, I.length, 'same triangle count');
  // the old path uploaded new Float32Array(P) — compare at the same precision
  assert.deepEqual(setOf(g.pos, g.fids, g.idx), setOf(new Float32Array(P), F, I));
});

test('fanFillGeometry: pure-fine layer passes positions through untouched', () => {
  const pos = [], starts = [0];
  for (let i = 0; i < 8; i++) {
    const lng = i * 10;
    for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) pos.push(...lnglatToVec3(lng + dx, dy));
    starts.push(starts[starts.length - 1] + 4);
  }
  const posF = new Float32Array(pos);
  const g = fanFillGeometry(posF, new Uint32Array(starts), 8);
  assert.equal(g.pos, posF, 'no copy on the hot path');
  assert.equal(g.idx.length, 8 * 2 * 3, 'two fan triangles per quad');
  assert.equal(g.fids[4], 1);
});
