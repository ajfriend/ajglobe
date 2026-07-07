// Triangulation of concave spherical polygons with holes (the convex topology
// fan in polygons() can't express these). Pure geometry, no GL. Two paths:
//
// Winding is trusted throughout — the outer ring's orientation chooses the
// region (CCW = its small side, CW = the complement) and is never repaired;
// hole rings are re-oriented only to their role (see triangulatePolygon).
// Two triangulation paths:
//
// 1. Polygon fits an open hemisphere (the common case): gnomonic-project the
//    rings onto the tangent plane at the polygon's bounding-cap center.
//    Gnomonic maps great circles to straight lines, so the 2D triangulation's
//    topology is faithful on the sphere — and 2D signed areas READ winding
//    (routing, hole-role orientation). Bridge holes into the outer ring
//    (Eberly's max-x mutual-visibility method), then ear-clip. The projection
//    is per-polygon and local, so this does NOT reintroduce the global 2D
//    parameterization the thesis bans: a tangent plane has no antimeridian
//    and no pole.
//
// 2. Polygon exceeds a hemisphere (encloses a pole, spans the antimeridian at
//    scale, contains antipodal points — no projection center exists): ear-clip
//    ON THE SPHERE with triple-product predicates. Ear tests are local (an ear
//    of a cell-scale boundary is a small spherical triangle, where
//    det(a,b,c) > 0 ⇔ CCW and three half-space dets ⇔ point-in-triangle), so
//    the polygon's total size doesn't matter. Unlike path 1 this path has no
//    signed areas to re-orient holes with, so holes must arrive wound CW —
//    the only remaining asymmetry between the paths.
//
// Both paths are O(n²), sized for annotation-scale polygons (hundreds of
// verts), not DGGS layers; convex DGGS cells keep the fan fast path in
// polygons().

import { vec3, quat } from './glmath.js';

// Max geodesic edge (radians) a fill triangle may keep un-split: subdivideTri
// (orb.js) splits longer edges, and everything coupled to that budget derives
// from this one constant — orb's COS_FILL_EDGE / COS_SPOKE_GATE / depth-disk
// radius, and the split-circle sampling in complementWithHoles below.
export const MAX_FILL_EDGE = 0.09;

// Hemisphere-routing margin, in COSINE space (~1.1° from the horizon): below
// this, gnomonic projection blows up and polygons route to the spherical
// path. NOT related to MAX_SEG = 0.02 rad in orb.js — the numeric match is
// coincidence; deriving one from the other would be wrong.
export const HEMI_MARGIN = 0.02;   // exported for the unit tests

// Crack-free adaptive subdivision of one triangle (vertex indices ia,ib,ic
// into P) onto the sphere, so coarse fills render faithfully: any edge
// subtending more than MAX_FILL_EDGE splits at its spherical midpoint and the
// pieces recurse; small triangles emit unchanged (no new verts). New verts
// append to P (positions) + F (feature ids), triangles push to I. Both the
// split test and the midpoint depend only on the edge's two endpoints, so
// adjacent triangles — same fan or neighbouring cells — subdivide a shared edge
// identically: no T-junction cracks (a uniform per-triangle lattice picked
// different densities for fan neighbours, leaving hairline slivers along
// shared spokes — visible on H3 res-1 cells). What subdivision buys (occlusion
// is NOT on the list — front-hemisphere chords keep z > 0 by convexity, so the
// depth disk can never swallow them): curved boundaries instead of straight
// chords, and full coverage out to the limb for cells that straddle it — a flat
// interior sags to radius cos(edge/2) inside the sphere, so a giant straddling
// cell's surface would cross the disk plane short of the silhouette, leaving a
// bare-disk annulus. At the threshold the residual sag is 1−cos(MAX_FILL_EDGE/2)
// ≈ 0.001 — sub-2px at typical canvas sizes. Consumed by orb's fill paths;
// deliberately NOT re-exported from the package entry (internal signature).
const COS_FILL_EDGE = Math.cos(MAX_FILL_EDGE);
export function subdivideTri(P, F, I, fid, ia, ib, ic) {
  const dot = (i, j) => P[i * 3] * P[j * 3] + P[i * 3 + 1] * P[j * 3 + 1] + P[i * 3 + 2] * P[j * 3 + 2];
  const mid = (i, j) => {                         // spherical midpoint of two unit vectors
    let x = P[i * 3] + P[j * 3], y = P[i * 3 + 1] + P[j * 3 + 1], z = P[i * 3 + 2] + P[j * 3 + 2];
    const h = Math.hypot(x, y, z);
    if (h < 1e-9) {
      // exact antipodes: the naive midpoint is the zero vector (NaN after
      // normalize; a zero-vector "midpoint" never converges). Any perpendicular
      // is a valid midpoint — pick one deterministically (same probing as slerp).
      const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
      [x, y, z] = Math.abs(ax) < 0.9 ? [0, az, -ay] : [-az, 0, ax];   // a × x̂ or a × ŷ
      const s = 1 / Math.hypot(x, y, z);
      x *= s; y *= s; z *= s;
    } else {
      x /= h; y /= h; z /= h;
    }
    P.push(x, y, z); F.push(fid);
    return P.length / 3 - 1;
  };
  const rec = (a, b, c) => {
    const ab = dot(a, b) < COS_FILL_EDGE, bc = dot(b, c) < COS_FILL_EDGE, ca = dot(c, a) < COS_FILL_EDGE;
    if (!ab && !bc && !ca) { I.push(a, b, c); return; }
    if (ab && bc && ca) {                         // all long: 4-way split
      const mab = mid(a, b), mbc = mid(b, c), mca = mid(c, a);
      rec(a, mab, mca); rec(mab, b, mbc); rec(mca, mbc, c); rec(mab, mbc, mca);
      return;
    }
    if (!ab) return bc ? rec(b, c, a) : rec(c, a, b);   // rotate a long edge into ab
    const m = mid(a, b);                          // bisect it; the halves re-test the rest
    rec(a, m, c); rec(m, b, c);
  };
  rec(ia, ib, ic);
}

// ---- shared ear-clip skeleton ----------------------------------------------
// orient(a,b,c): >0 for a CCW corner; inTri(p,a,b,c): p inside CCW triangle;
// samePos(i,j): vertices i and j are position-identical. Clips a simple CCW
// index cycle into triangles appended to out. Bridged cycles contain duplicate
// indices AND position-duplicates (rings that touch at a vertex — cell unions
// produce these — plus zero-length bridges): the ear scan must skip a vertex
// that merely COINCIDES with an ear corner (it lies on the boundary, never
// strictly inside), or every ear touching the shared vertex is falsely
// blocked and the fallback emits garbage. Zero-area corners the bridges
// create are skipped as non-convex until the fallback clears them.
function earClip(orient, inTri, samePos, cycle, out) {
  // Collapse consecutive position-duplicates. A hole touching the outer ring
  // bridges with a ZERO-LENGTH bridge, leaving runs like …A,A,…,A,A,… whose
  // corners all have zero orientation — every real ear then looks degenerate
  // and only the fallback can act. Removing the run (keeping one visit per
  // run — the pinch still visits the shared position twice, non-adjacently)
  // restores a clippable cycle; it also neutralizes repeated consecutive
  // points in sloppy input rings.
  const idx = [];
  for (const v of cycle) {
    if (idx.length && samePos(v, idx[idx.length - 1])) continue;
    idx.push(v);
  }
  while (idx.length > 1 && samePos(idx[0], idx[idx.length - 1])) idx.pop();
  let guard = idx.length * idx.length + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (orient(a, b, c) <= 0) continue;                 // reflex or degenerate corner
      let ear = true;
      for (const p of idx) {                              // any other vertex inside?
        if (p === a || p === b || p === c) continue;
        if (samePos(p, a) || samePos(p, b) || samePos(p, c)) continue;
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

// gnomonic-project one ring's vertices into pts (flat 2D), recording each 2D
// slot's source index in src; returns the ring's slot cycle. The one home of
// the rotate-and-divide projection — ringCCW and triangulateGnomonic share it.
function projectRing(P, [s, e], q, pts, src) {
  const cyc = [];
  for (let v = s; v < e; v++) {
    const r = quat.rotateVec3(q, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    src.push(v);
    cyc.push(src.length - 1);
    pts.push(r[0] / r[2], r[1] / r[2]);
  }
  return cyc;
}

function triangulateGnomonic(P, rings, center, out) {
  const q = quat.fromUnitVectors(center, [0, 0, 1]);      // cap center -> +z
  const pts = [], src = [];
  const cycles = rings.map((ring) => projectRing(P, ring, q, pts, src));

  // The outer ring's winding is TRUSTED (routing in triangulatePolygon sends
  // only CCW-outer polygons here). Hole rings are oriented to their ROLE: per
  // GeoJSON, hole-ness comes from ring order (outer first), so given the role
  // a hole's winding is redundant — flipping a CCW "hole" to CW implements the
  // role; it never second-guesses which region the polygon means.
  let outer = cycles[0];
  const holes = cycles.slice(1).map((h) => (area2(pts, h) > 0 ? h.slice().reverse() : h));
  holes.sort((h1, h2) => Math.max(...h2.map((i) => pts[i * 2])) - Math.max(...h1.map((i) => pts[i * 2])));
  for (const h of holes) outer = bridgeHole2(pts, outer, h);

  const tris = [];
  earClip(
    (a, b, c) => cross2(pts, a, b, c),
    (p, a, b, c) => pointInTri2(pts, p, a, b, c),
    (i, j) => pts[i * 2] === pts[j * 2] && pts[i * 2 + 1] === pts[j * 2 + 1],
    outer, tris,
  );
  for (const t of tris) out.push(src[t]);
  return out;
}

// Complement region ("sphere minus these loops", every ring CW around its own
// small side; one or more loops). Ear clipping can't start on the loop
// boundaries (every corner is reflex from the region's side — spheres aren't
// bound by the planar two-ears theorem), and a plain fan from the antipode is
// only valid for loops whose complement is star-shaped from there, which
// concave loops are not. Instead, split the sphere at a circle midway between
// the loops' bounding cap and the hemisphere limit:
//   - far side: a pure spherical cap around the antipode — fan, no holes;
//   - near side: an ordinary hemisphere-fitting polygon — the split circle as
//     its CCW outer ring, the given loops as its holes — the gnomonic path.
// Both sides index the SAME split-ring vertices, so the caller's subdivision
// splits the shared edges identically and the seam stays crack-free (the
// subdivideTri shared-edge argument).
function complementRegion(P, rings, center, worst, out) {
  const th = (Math.acos(worst) + Math.PI / 2) / 2;      // split-circle radius
  const q = quat.fromUnitVectors([0, 0, 1], center);
  // sample at the fill-edge budget so subdivideTri won't re-split ring edges
  const segs = Math.max(16, Math.ceil((2 * Math.PI) * Math.sin(th) / MAX_FILL_EDGE));
  const ring0 = P.length / 3;
  const ct = Math.cos(th), st = Math.sin(th);
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    P.push(...quat.rotateVec3(q, [st * Math.cos(t), st * Math.sin(t), ct]));
  }
  const si = P.length / 3;                              // far side: fan the cap
  P.push(-center[0], -center[1], -center[2]);
  for (let i = 0; i < segs; i++) out.push(si, ring0 + ((i + 1) % segs), ring0 + i);
  // near side: split ring (CCW in the gnomonic frame) + the loops as holes
  return triangulateGnomonic(P, [[ring0, ring0 + segs], ...rings], center, out);
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
    (i, j) => P[i * 3] === P[j * 3] && P[i * 3 + 1] === P[j * 3 + 1] && P[i * 3 + 2] === P[j * 3 + 2],
    outer, out,
  );
  return out;
}

// ---- entry ------------------------------------------------------------------

// Approximate bounding-cap center of all ring vertices (Bâdoiu–Clarkson: walk
// from the vertex mean toward the farthest vertex with shrinking steps). The
// vertex mean alone is density-biased and can drift enough to push vertices of
// a near-hemisphere polygon past 90°; the cap center maximizes the margin.
// Returns { c, worst }: c the cap center, worst the min dot(c, vertex) — the
// cosine of the cap's angular radius. Exported for the unit tests (which use
// worst > HEMI_MARGIN to predict routing).
export function capCenter(P, rings) {
  let c = [0, 0, 0];
  for (const [s, e] of rings) {
    for (let v = s; v < e; v++) { c[0] += P[v * 3]; c[1] += P[v * 3 + 1]; c[2] += P[v * 3 + 2]; }
  }
  c = vec3.norm(c);
  let worst = -2, prev = -2;
  for (let k = 1; k <= 60; k++) {
    let f = 0;
    worst = 2;
    for (const [s, e] of rings) {
      for (let v = s; v < e; v++) {
        const d = c[0] * P[v * 3] + c[1] * P[v * 3 + 1] + c[2] * P[v * 3 + 2];
        if (d < worst) { worst = d; f = v; }
      }
    }
    if (Math.abs(worst - prev) < 1e-7) break;           // converged
    prev = worst;
    const t = 1 / (k + 1);
    c = vec3.norm([
      c[0] + t * (P[f * 3] - c[0]),
      c[1] + t * (P[f * 3 + 1] - c[1]),
      c[2] + t * (P[f * 3 + 2] - c[2]),
    ]);
  }
  return { c, worst };
}

// signed-area sign of one ring in the gnomonic frame at `center`:
// > 0 = CCW = the ring encloses its small side; < 0 = CW = the complement
function ringCCW(P, ring, center) {
  const q = quat.fromUnitVectors(center, [0, 0, 1]);
  const pts = [], src = [];
  const cyc = projectRing(P, ring, q, pts, src);
  return area2(pts, cyc) > 0;
}

// Triangulate one spherical polygon. P: flat unit-xyz PLAIN ARRAY — the
// complement paths append Steiner vertices, so callers must own any parallel
// arrays; rings: array of [start, end) vertex-index ranges (outer first, then
// holes; open rings — no repeated closing point). Appends vertex-index triples
// to `out` and returns it.
//
// The outer ring's winding is RESPECTED, never repaired: on a sphere both
// sides of a loop are bounded, so winding is the only bit that says which
// region a ring means — CCW encloses its small side, CW the complement. There
// is nothing to validate it against ("the plane lets you validate winding; the
// sphere only lets you obey it"). Sloppily wound planar exports are the data
// layer's problem, by design.
export function triangulatePolygon(P, rings, out = []) {
  // a ring needs 3 vertices to bound anything; drop degenerates rather than
  // guessing (a 2-point ring has signed area 0 and would otherwise be
  // misread as a complement covering the whole sphere)
  rings = rings.filter(([s, e]) => e - s >= 3);
  if (!rings.length) return out;
  const { c, worst } = capCenter(P, rings);
  if (worst <= HEMI_MARGIN) {
    // Vertices don't fit an open hemisphere: spherical predicates. One shape
    // this path cannot do: a complement region whose small loops are scattered
    // too widely for the cap-ring split (e.g. two CW loops near-antipodal) —
    // every boundary corner is reflex, no ear ever clips, and the fallback
    // emits inverted triangles. Genuinely over-hemisphere OUTLINES (wiggly
    // boundaries like the blog's 'cross') clip fine, so detect the failure by
    // its signature — flipped output — rather than pre-guessing from shape,
    // and fail loudly instead of rendering garbage.
    const n0 = out.length;
    triangulateSpherical(P, rings, out);
    for (let t = n0; t < out.length; t += 3) {
      if (det3(P, out[t], out[t + 1], out[t + 2]) < -1e-9) {
        console.warn('ajglobe: unsupported spherical polygon (likely a complement with loops spanning more than a hemisphere); skipping');
        out.length = n0;
        break;
      }
    }
    return out;
  }
  if (ringCCW(P, rings[0], c)) return triangulateGnomonic(P, rings, c, out);
  return complementRegion(P, rings, c, worst, out);
}
