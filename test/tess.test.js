// triangulatePolygon: concave spherical polygons with holes (node --test).
// Validated against the real cells_to_poly blog data — H3 cell unions with up
// to 3 holes, including the larger-than-a-hemisphere "cross" polygon — plus
// synthetic shapes. The validator is frame-free spherical geometry, so it
// exercises both the gnomonic and the spherical-predicate paths identically:
//   1. every triangle is non-negatively oriented (det ≥ -eps), and
//   2. the summed spherical excess of the triangles equals the polygon's
//      region area by Gauss-Bonnet (outer ring minus holes, RHR winding).
// Given (1), any overlap or spill double-counts area and breaks (2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triangulatePolygon, capCenter, HEMI_MARGIN } from '../src/tess.js';
import { lnglatToVec3, vec3 } from '../src/glmath.js';

const at = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
const det3 = (A, B, C) => vec3.dot(A, vec3.cross(B, C));

// Gauss-Bonnet: area enclosed on the LEFT of a geodesic ring = 2π − Σ exterior turns.
function ringArea(P, [s, e]) {
  let turns = 0;
  for (let i = s; i < e; i++) {
    const v = at(P, i), prev = at(P, i === s ? e - 1 : i - 1), next = at(P, i === e - 1 ? s : i + 1);
    const t = vec3.tangent(v, prev);
    const din = [-t[0], -t[1], -t[2]];                           // arrive direction at v
    const dout = vec3.tangent(v, next);
    turns += Math.atan2(vec3.dot(vec3.cross(din, dout), v), vec3.dot(din, dout));
  }
  return 2 * Math.PI - turns;
}

// spherical excess (unsigned area) of triangle (a,b,c)
function triArea(P, a, b, c) {
  const A = at(P, a), B = at(P, b), C = at(P, c);
  const ang = (V, U, W) => {
    const t1 = vec3.tangent(V, U), t2 = vec3.tangent(V, W);
    return Math.atan2(vec3.len(vec3.cross(t1, t2)), vec3.dot(t1, t2));
  };
  return ang(A, B, C) + ang(B, C, A) + ang(C, A, B) - Math.PI;
}

// Build (P, rings) from GeoJSON polygon coordinates (strip closing duplicates).
function fromCoords(polyCoords) {
  const P = [], rings = [];
  for (const ring of polyCoords) {
    const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0]
      && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
    const s = P.length / 3;
    for (const [lng, lat] of open) P.push(...lnglatToVec3(lng, lat));
    rings.push([s, P.length / 3]);
  }
  return { P, rings };
}

function runPoly(coords, label, { looseCount = false } = {}) {
  const { P, rings } = fromCoords(coords);
  const tris = triangulatePolygon(P, rings);

  // Region area by Gauss-Bonnet, mirroring the implementation's winding
  // contract: the OUTER ring's winding is trusted as-given (its left side is
  // the region — CCW = small side, CW = the complement); holes are oriented
  // to their role, so each subtracts its small side. One formula, all cases.
  const S = 4 * Math.PI;
  const outerA = ringArea(P, rings[0]);
  const region = outerA
    - rings.slice(1).reduce((s, r) => {
      const a = ringArea(P, r);
      return s + Math.min(a, S - a);
    }, 0);

  const n = rings[rings.length - 1][1] - rings[0][0];
  const { worst } = capCenter(P, rings);
  // hemisphere-fitting complements go through the cap-ring split, which adds a
  // synthetic split ring + fan — only bound their count; everything else is exact
  const complement = worst > HEMI_MARGIN && outerA > 2 * Math.PI;
  if (complement || looseCount) assert.ok(tris.length / 3 >= n - 2, `${label}: triangle count`);
  else assert.equal(tris.length / 3, n + 2 * (rings.length - 1) - 2, `${label}: triangle count`);

  let sum = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const d = det3(at(P, tris[t]), at(P, tris[t + 1]), at(P, tris[t + 2]));
    assert.ok(d > -1e-9, `${label}: flipped triangle (det ${d})`);
    sum += triArea(P, tris[t], tris[t + 1], tris[t + 2]);
  }
  assert.ok(Math.abs(sum - region) < 1e-6 + region * 1e-5,
    `${label}: cover area ${sum.toFixed(8)} vs region ${region.toFixed(8)}`);
}

test('convex ring triangulates like a fan', () => {
  runPoly([[[0, 0], [10, 0], [12, 8], [5, 14], [-2, 8]]], 'convex pentagon');
});

test('concave ring (two-hex union shape)', () => {
  runPoly([[[0, 0], [10, 0], [10, 10], [20, 10], [20, 20], [10, 20], [10, 15], [0, 15]]], 'L-shape');
});

test('ring with a hole', () => {
  runPoly([
    [[0, 0], [20, 0], [20, 20], [0, 20]],
    [[5, 5], [5, 12], [12, 12], [12, 5]],          // hole (CW)
  ], 'square with hole');
});

test('winding is meaningful: a CW ring fills the complement of the CCW one', () => {
  const ccw = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const cw = [ccw[0].slice().reverse()];
  runPoly(ccw, 'small CCW square');                // ~small region
  runPoly(cw, 'CW square = complement');           // ~4π − small (Steiner fan)
});

test('concave CW loops fill the complement correctly (no star-shape assumption)', () => {
  // regression: the antipodal fan double-covered concave complements
  const L = [[0, 0], [10, 0], [10, 10], [20, 10], [20, 20], [10, 20], [10, 15], [0, 15]];
  runPoly([L.slice().reverse()], 'CW L-shape complement');
  const C = [[0, 0], [14, 0], [14, 4], [4, 4], [4, 10], [14, 10], [14, 14], [0, 14]];
  runPoly([C.slice().reverse()], 'CW C-shape complement');
});

test('touching rings: a hole sharing a vertex with the outer ring', () => {
  // regression: the zero-length bridge left position-duplicates that broke
  // ear clipping (cover was -6.11 sr vs a 0.109 sr region)
  // pinch-dedupe removes the zero-length bridge's duplicates, so the triangle
  // count is legitimately lower than the bridged formula — area is the invariant
  runPoly([
    [[0, 0], [20, 0], [20, 20], [0, 20]],
    [[0, 0], [5, 10], [10, 5]],                    // shares (0,0); CW
  ], 'hole touching outer (gnomonic)', { looseCount: true });
  // complement-side region: a full lat −60° circle traversed east (region =
  // everything north of it, > hemisphere) with a touching hole just north
  const circle = Array.from({ length: 36 }, (_, k) => [k * 10 - 180, -60]);
  runPoly([circle, [[-180, -60], [-170, -40], [170, -40]]],
    'hole touching outer (complement side)', { looseCount: true });
});

test('degenerate rings emit nothing instead of flooding or crashing', () => {
  const { P, rings } = fromCoords([[[0, 0], [10, 0]]]);          // 2-point ring
  assert.deepEqual(triangulatePolygon(P, rings), []);
  const one = fromCoords([[[5, 5]]]);                            // 1-point ring
  assert.deepEqual(triangulatePolygon(one.P, one.rings), []);
});

// CCW hexagon ring in lng/lat degrees, for complement-region tests.
const hex = (cx, cy, r) => Array.from({ length: 6 }, (_, k) => {
  const t = (k / 6) * 2 * Math.PI;
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
});

test('scattered complement (loops wider than any hemisphere) fails loudly, not wrongly', () => {
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const { P, rings } = fromCoords([hex(-86, 0, 3).reverse(), hex(86, 0, 3).reverse()]);
    const tris = triangulatePolygon(P, rings);
    assert.deepEqual(tris, [], 'garbage output must be dropped');
    assert.ok(warned, 'and the drop must be loud');
  } finally {
    console.warn = origWarn;
  }
});

test('complement WITH holes: sphere minus two loops (both rings CW)', () => {
  // region = everything except two hexes: first ring CW (complement side),
  // second ring CW too (a hole cut out of that complement) — area 4π − a − b,
  // validated by the Gauss-Bonnet check inside runPoly
  runPoly([hex(0, 0, 8).reverse(), hex(40, 10, 6).reverse()], 'sphere minus two hexes');
  // and with three loops, holes at spread-out positions
  runPoly([hex(0, 0, 8).reverse(), hex(35, -12, 5).reverse(), hex(-25, 20, 4).reverse()],
    'sphere minus three hexes');
});

test('every polygon in the cells_to_poly blog data triangulates validly', () => {
  const files = ['intro_cells', 'intro_poly', 'cross', 'equator', 'holes_0', 'holes_1', 'holes_2', 'holes_3'];
  let polys = 0, withHoles = 0, overHemisphere = 0;
  for (const name of files) {
    const gj = JSON.parse(readFileSync(new URL(`../examples/data/cells_to_poly/${name}.json`, import.meta.url)));
    for (const f of gj.features) {
      const g = f.geometry;
      const polysCoords = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : [];
      polysCoords.forEach((coords, i) => {
        runPoly(coords, `${name}[${i}]`);
        polys++;
        if (coords.length > 1) withHoles++;
        const { P, rings } = fromCoords(coords);
        if (ringArea(P, rings[0]) > 2 * Math.PI) overHemisphere++;
      });
    }
  }
  assert.ok(polys > 10, `exercised ${polys} polygons`);
  assert.ok(withHoles >= 2, `including ${withHoles} with holes`);
  assert.ok(overHemisphere >= 1, `including ${overHemisphere} larger than a hemisphere`);
});
