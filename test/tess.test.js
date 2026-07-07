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
import { triangulatePolygon, capCenter } from '../src/tess.js';
import { lnglatToVec3, vec3 } from '../src/glmath.js';

const at = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
const tangent = (v, u) => {                       // tangent at v toward u
  const d = vec3.dot(u, v);
  return vec3.norm([u[0] - d * v[0], u[1] - d * v[1], u[2] - d * v[2]]);
};
const det3 = (A, B, C) => vec3.dot(A, vec3.cross(B, C));

// Gauss-Bonnet: area enclosed on the LEFT of a geodesic ring = 2π − Σ exterior turns.
function ringArea(P, [s, e]) {
  let turns = 0;
  for (let i = s; i < e; i++) {
    const v = at(P, i), prev = at(P, i === s ? e - 1 : i - 1), next = at(P, i === e - 1 ? s : i + 1);
    const din = vec3.norm(vec3.cross(vec3.cross(prev, v), v));   // arrive direction at v
    const dout = tangent(v, next);
    turns += Math.atan2(vec3.dot(vec3.cross(din, dout), v), vec3.dot(din, dout));
  }
  return 2 * Math.PI - turns;
}

// spherical excess (unsigned area) of triangle (a,b,c)
function triArea(P, a, b, c) {
  const A = at(P, a), B = at(P, b), C = at(P, c);
  const ang = (V, U, W) => {
    const t1 = tangent(V, U), t2 = tangent(V, W);
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

function runPoly(coords, label) {
  const { P, rings } = fromCoords(coords);
  const tris = triangulatePolygon(P, rings);

  // Region area by Gauss-Bonnet, mirroring the implementation's winding
  // contract: winding is MEANINGFUL — a single ring encloses what's on its
  // left (CCW = small side, CW = the complement, rendered via a Steiner fan
  // of n triangles); a multi-ring hemisphere-fitting polygon normalizes to
  // small-side outer minus holes; an over-hemisphere polygon trusts RHR.
  const c = capCenter(P, rings);
  let worstDot = 2;
  for (const [s, e] of rings) {
    for (let v = s; v < e; v++) worstDot = Math.min(worstDot, vec3.dot(c, at(P, v)));
  }
  const fits = worstDot > 0.02;
  const S = 4 * Math.PI;
  const outerA = ringArea(P, rings[0]);
  const single = rings.length === 1;
  const complement = fits && single && outerA > 2 * Math.PI;
  const region = (!fits || single ? outerA : Math.min(outerA, S - outerA))
    - rings.slice(1).reduce((s, r) => {
      const a = ringArea(P, r);
      return s + (fits ? Math.min(a, S - a) : S - a);
    }, 0);

  const n = rings[rings.length - 1][1] - rings[0][0];
  assert.equal(tris.length / 3, complement ? n : n + 2 * (rings.length - 1) - 2,
    `${label}: triangle count`);

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
