// Triangulation of concave spherical polygons with holes (the convex topology
// fan in polygons() can't express these). Pure geometry, no GL. Two paths:
//
// 1. Polygon fits an open hemisphere (the common case): gnomonic-project the
//    rings onto the tangent plane at the polygon's bounding-cap center.
//    Gnomonic maps great circles to straight lines, so the 2D triangulation's
//    topology is faithful on the sphere — and 2D signed areas let us normalize
//    sloppy input winding. Bridge holes into the outer ring (Eberly's max-x
//    mutual-visibility method), then ear-clip. The projection is per-polygon
//    and local, so this does NOT reintroduce the global 2D parameterization
//    the thesis bans: a tangent plane has no antimeridian and no pole.
//
// 2. Polygon exceeds a hemisphere (encloses a pole, spans the antimeridian at
//    scale, contains antipodal points — no projection center exists): ear-clip
//    ON THE SPHERE with triple-product predicates. Ear tests are local (an ear
//    of a cell-scale boundary is a small spherical triangle, where
//    det(a,b,c) > 0 ⇔ CCW and three half-space dets ⇔ point-in-triangle), so
//    the polygon's total size doesn't matter. The one thing this path cannot
//    do is normalize winding (there is no global signed area without already
//    knowing the interior side), so it TRUSTS GeoJSON right-hand-rule input:
//    outer rings CCW, holes CW. Holes are bridged at the nearest mutually
//    visible vertex pair (visibility = the geodesic crosses no polygon edge).
//
// Both paths are O(n²), sized for annotation-scale polygons (hundreds of
// verts), not DGGS layers; convex DGGS cells keep the fan fast path in
// polygons().

import { vec3, quat } from './glmath.js';

// ---- shared ear-clip skeleton ----------------------------------------------
// orient(a,b,c): >0 for a CCW corner; inTri(p,a,b,c): p inside CCW triangle.
// Clips a simple CCW index cycle into triangles appended to out. Bridged
// cycles contain duplicate indices; the by-value skip handles them, and the
// zero-area corners bridges create are skipped as non-convex until the
// fallback clears them.
function earClip(orient, inTri, cycle, out) {
  const idx = cycle.slice();
  let guard = idx.length * idx.length + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (orient(a, b, c) <= 0) continue;                 // reflex or degenerate corner
      let ear = true;
      for (const p of idx) {                              // any other vertex inside?
        if (p === a || p === b || p === c) continue;
        if (inTri(p, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {                                       // degenerate input: clip the
      let best = 0, bestX = -Infinity;                    // most-convex corner anyway
      for (let i = 0; i < idx.length; i++) {
        const x = orient(idx[(i + idx.length - 1) % idx.length], idx[i], idx[(i + 1) % idx.length]);
        if (x > bestX) { bestX = x; best = i; }
      }
      out.push(idx[(best + idx.length - 1) % idx.length], idx[best], idx[(best + 1) % idx.length]);
      idx.splice(best, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
}

// splice hole cycle (entered at hole position hi) into outer at position oi
function spliceBridge(outer, oi, hole, hi) {
  const merged = [];
  for (let i = 0; i <= oi; i++) merged.push(outer[i]);
  for (let k = 0; k <= hole.length; k++) merged.push(hole[(hi + k) % hole.length]);
  for (let i = oi; i < outer.length; i++) merged.push(outer[i]);
  return merged;
}

// ---- path 1: gnomonic (fits an open hemisphere) ----------------------------

// signed area (positive = CCW) of ring `idx` (indices into flat 2D array pts)
function area2(pts, idx) {
  let a = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i] * 2, q = idx[(i + 1) % idx.length] * 2;
    a += pts[p] * pts[q + 1] - pts[q] * pts[p + 1];
  }
  return a / 2;
}

const cross2 = (pts, a, b, c) =>
  (pts[b * 2] - pts[a * 2]) * (pts[c * 2 + 1] - pts[a * 2 + 1]) -
  (pts[c * 2] - pts[a * 2]) * (pts[b * 2 + 1] - pts[a * 2 + 1]);

// orientation-agnostic (bridge-candidate triangles aren't guaranteed CCW);
// boundary counts as inside, which is the conservative choice for ear tests
function pointInTri2(pts, p, a, b, c) {
  const d1 = cross2(pts, a, b, p), d2 = cross2(pts, b, c, p), d3 = cross2(pts, c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Bridge a hole cycle into the outer cycle at a mutually visible vertex pair
// (Eberly): from the hole's max-x vertex M, ray-cast +x to the outer edge it
// first hits, then take the best visible endpoint of that edge (screening the
// outer's reflex vertices inside the candidate triangle). Returns the merged cycle.
function bridgeHole2(pts, outer, hole) {
  let m = 0;
  for (let i = 1; i < hole.length; i++) if (pts[hole[i] * 2] > pts[hole[m] * 2]) m = i;
  const M = hole[m], mx = pts[M * 2], my = pts[M * 2 + 1];

  // closest +x intersection of the horizontal ray with outer edges
  let bestT = Infinity, hit = -1;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    const ay = pts[a * 2 + 1], by = pts[b * 2 + 1];
    if ((ay > my) === (by > my)) continue;                // edge doesn't cross the ray's y
    const t = pts[a * 2] + ((my - ay) / (by - ay)) * (pts[b * 2] - pts[a * 2]);
    if (t >= mx && t < bestT) { bestT = t; hit = i; }
  }
  if (hit < 0) return outer.concat(hole);                 // hole outside outer: garbage in

  // candidate = hit edge's endpoint with larger x; screen reflex outer verts
  // inside triangle (M, ray-hit, candidate), preferring the smallest angle to +x
  const a = outer[hit], b = outer[(hit + 1) % outer.length];
  let ci = pts[a * 2] > pts[b * 2] ? hit : (hit + 1) % outer.length;
  const scratch = [...pts, bestT, my];
  const HITP = scratch.length / 2 - 1;
  let best = ci, bestTan = Infinity;
  for (let i = 0; i < outer.length; i++) {
    const v = outer[i];
    if (cross2(scratch, outer[(i + outer.length - 1) % outer.length], v, outer[(i + 1) % outer.length]) > 0) continue;
    if (!pointInTri2(scratch, v, M, HITP, outer[ci])) continue;
    const tan = Math.abs(scratch[v * 2 + 1] - my) / (scratch[v * 2] - mx || 1e-12);
    if (tan < bestTan || (tan === bestTan && scratch[v * 2] > scratch[outer[best] * 2])) { best = i; bestTan = tan; }
  }
  if (bestTan < Infinity) ci = best;
  return spliceBridge(outer, ci, hole, m);
}

function triangulateGnomonic(P, rings, center, out) {
  const q = quat.fromUnitVectors(center, [0, 0, 1]);      // cap center -> +z

  // gnomonic-project every ring vertex; remember the source index per 2D slot
  const pts = [], slot = new Map();
  const cycles = rings.map(([s, e]) => {
    const cyc = [];
    for (let v = s; v < e; v++) {
      const r = quat.rotateVec3(q, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      slot.set(pts.length / 2, v);
      cyc.push(pts.length / 2);
      pts.push(r[0] / r[2], r[1] / r[2]);
    }
    return cyc;
  });

  // Winding is MEANINGFUL on a sphere (there is no unbounded "outside"): a CCW
  // outer ring encloses the small side, a CW one encloses the COMPLEMENT — the
  // convention GeoJSON's right-hand rule implies and d3-geo renders. A single
  // CW ring therefore fills sphere-minus-loop: fan from the antipode of the cap
  // center (the complement is star-shaped from there for cap-scale loops) and
  // let the caller's subdivision cope with the huge triangles. Appends the
  // antipode as a new vertex in P — callers own the parallel arrays.
  let outer = cycles[0];
  if (rings.length === 1 && area2(pts, outer) < 0) {
    const si = P.length / 3;
    P.push(-center[0], -center[1], -center[2]);
    for (let i = 0; i < outer.length; i++) {
      out.push(si, slot.get(outer[i]), slot.get(outer[(i + 1) % outer.length]));
    }
    return out;
  }

  // multi-ring: normalize to outer CCW, holes CW (tolerates sloppy winding —
  // hole-ness comes from ring order, which GeoJSON fixes as outer-first)
  if (area2(pts, outer) < 0) outer = outer.slice().reverse();
  const holes = cycles.slice(1).map((h) => (area2(pts, h) > 0 ? h.slice().reverse() : h));
  holes.sort((h1, h2) => Math.max(...h2.map((i) => pts[i * 2])) - Math.max(...h1.map((i) => pts[i * 2])));
  for (const h of holes) outer = bridgeHole2(pts, outer, h);

  const tris = [];
  earClip((a, b, c) => cross2(pts, a, b, c), (p, a, b, c) => pointInTri2(pts, p, a, b, c), outer, tris);
  for (const t of tris) out.push(slot.get(t));
  return out;
}

// ---- path 2: spherical predicates (any size; trusts RHR winding) -----------

const det3 = (P, a, b, c) =>
  P[a * 3] * (P[b * 3 + 1] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3 + 1]) -
  P[a * 3 + 1] * (P[b * 3] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3]) +
  P[a * 3 + 2] * (P[b * 3] * P[c * 3 + 1] - P[b * 3 + 1] * P[c * 3]);

const at3 = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

// Do the minor geodesic arcs a-b and c-d properly cross? (Endpoint touches
// don't count — the strict tests reject them.)
function arcsCross(P, a, b, c, d) {
  const A = at3(P, a), B = at3(P, b), C = at3(P, c), D = at3(P, d);
  const n1 = vec3.cross(A, B), n2 = vec3.cross(C, D);
  let X = vec3.cross(n1, n2);
  const L = vec3.len(X);
  if (L < 1e-12) return false;                            // same great circle: treat as touching
  X = [X[0] / L, X[1] / L, X[2] / L];
  for (const S of [X, [-X[0], -X[1], -X[2]]]) {
    if (vec3.dot(vec3.cross(A, S), n1) > 1e-12 && vec3.dot(vec3.cross(S, B), n1) > 1e-12 &&
        vec3.dot(vec3.cross(C, S), n2) > 1e-12 && vec3.dot(vec3.cross(S, D), n2) > 1e-12) return true;
  }
  return false;
}

// Bridge a hole at the nearest mutually visible vertex pair: candidates sorted
// by angular distance; visible = the geodesic crosses no edge in `edges`
// (edges incident to the candidate pair are skipped by the strict arc test).
function bridgeHoleSph(P, outer, hole, edges) {
  const pairs = [];
  for (let oi = 0; oi < outer.length; oi++) {
    for (let hi = 0; hi < hole.length; hi++) {
      const d = vec3.dot(at3(P, outer[oi]), at3(P, hole[hi]));
      pairs.push([d, oi, hi]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0]);                      // nearest first
  for (const [, oi, hi] of pairs) {
    const o = outer[oi], h = hole[hi];
    let visible = true;
    for (const [e1, e2] of edges) {
      if (e1 === o || e2 === o || e1 === h || e2 === h) continue;
      if (arcsCross(P, o, h, e1, e2)) { visible = false; break; }
    }
    if (visible) {
      edges.push([o, h]);
      return spliceBridge(outer, oi, hole, hi);
    }
  }
  return outer.concat(hole);                              // no visible pair: garbage in
}

function triangulateSpherical(P, rings, out) {
  const cycles = rings.map(([s, e]) => Array.from({ length: e - s }, (_, i) => s + i));
  const edges = [];
  for (const cyc of cycles) {
    for (let i = 0; i < cyc.length; i++) edges.push([cyc[i], cyc[(i + 1) % cyc.length]]);
  }
  let outer = cycles[0];
  for (const h of cycles.slice(1)) outer = bridgeHoleSph(P, outer, h, edges);
  // oriented in-triangle test: interior of a CCW ear is where all three dets
  // are >= 0; the antipodal region flips every sign, so far-side vertices
  // (which exist — this path runs for globe-scale polygons) test outside.
  earClip(
    (a, b, c) => det3(P, a, b, c),
    (p, a, b, c) => det3(P, a, b, p) >= 0 && det3(P, b, c, p) >= 0 && det3(P, c, a, p) >= 0,
    outer, out,
  );
  return out;
}

// ---- entry ------------------------------------------------------------------

// Approximate bounding-cap center of all ring vertices (Bâdoiu–Clarkson: walk
// from the vertex mean toward the farthest vertex with shrinking steps). The
// vertex mean alone is density-biased and can drift enough to push vertices of
// a near-hemisphere polygon past 90°; the cap center maximizes the margin.
export function capCenter(P, rings) {   // exported for the unit tests
  let c = [0, 0, 0];
  for (const [s, e] of rings) {
    for (let v = s; v < e; v++) { c[0] += P[v * 3]; c[1] += P[v * 3 + 1]; c[2] += P[v * 3 + 2]; }
  }
  c = vec3.norm(c);
  for (let k = 1; k <= 60; k++) {
    let f = 0, worst = 2;
    for (const [s, e] of rings) {
      for (let v = s; v < e; v++) {
        const d = c[0] * P[v * 3] + c[1] * P[v * 3 + 1] + c[2] * P[v * 3 + 2];
        if (d < worst) { worst = d; f = v; }
      }
    }
    const t = 1 / (k + 1);
    c = vec3.norm([
      c[0] + t * (P[f * 3] - c[0]),
      c[1] + t * (P[f * 3 + 1] - c[1]),
      c[2] + t * (P[f * 3 + 2] - c[2]),
    ]);
  }
  return c;
}

// Triangulate one spherical polygon. P: flat unit-xyz PLAIN ARRAY — the
// complement path appends a Steiner vertex, so callers must own any parallel
// arrays; rings: array of [start, end) vertex-index ranges (outer first, then
// holes; open rings — no repeated closing point). Appends vertex-index triples
// to `out` and returns it.
export function triangulatePolygon(P, rings, out = []) {
  const c = capCenter(P, rings);
  let worst = 2;
  for (const [s, e] of rings) {
    for (let v = s; v < e; v++) {
      worst = Math.min(worst, c[0] * P[v * 3] + c[1] * P[v * 3 + 1] + c[2] * P[v * 3 + 2]);
    }
  }
  // fits comfortably in the open hemisphere (>~1.1° margin)? project; else sphere
  return worst > 0.02 ? triangulateGnomonic(P, rings, c, out) : triangulateSpherical(P, rings, out);
}
