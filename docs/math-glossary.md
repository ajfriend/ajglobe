# Math glossary

Every named theorem/algorithm in the codebase, what it does here, and why it's
the right tool rather than decoration. House rule: a name appears in a comment
only when it's either the standard searchable term for the simplest adequate
tool, or a citation that spares the code from arguing a proof inline. If a
plain phrase says the same thing, use the plain phrase.

## Quaternion (orientation) — `src/glmath.js`, `src/camera.js`

The globe's orientation is a single unit quaternion; every rotation composes by
quaternion multiply. **Why:** the alternative (Euler angles / rotating about
lat-lng axes) is exactly the gimbal-lock + mouse-desync bug this library exists
to kill (PLAN §1). Standard graphics practice.

## Slerp (spherical linear interpolation) — `vec3.slerp`, `src/glmath.js`

Interpolates two unit vectors along their great circle; used to densify every
line segment into a geodesic arc. **Why:** slerp is uniform in angle, so each
of the n pieces of a densified edge subtends exactly ang/n — the dash-length
arithmetic in `lines()` depends on that. (Lerp + normalize is nearly as good
but non-uniform.) Antipodal endpoints have no unique great circle; the guard
picks a deterministic perpendicular route.

## Arcball drag — `src/camera.js`

The standard "grab the sphere" mouse mapping: project the cursor onto a virtual
ball, rotate by the quaternion taking the press point to the current point.
**Why:** it's the technique that makes drag feel attached to the globe, and the
name is how you look it up. ~10 lines.

## Gnomonic projection — `src/tess.js` (triangulation path 1)

Projects a polygon's rings onto the tangent plane at its bounding-cap center
before 2D ear-clipping. **Why:** the gnomonic map's one defining property —
great circles become straight lines — is the entire correctness argument: it
makes the 2D triangulation's topology faithful on the sphere, and 2D signed
areas read ring winding. Any other projection would be wrong, not just less
elegant. The projection is per-polygon and local (a tangent plane has no
antimeridian or pole), so it doesn't violate the never-go-to-2D thesis.

## Ear clipping — `src/tess.js`

The *simple* polygon triangulation algorithm: repeatedly cut off a convex
corner containing no other vertex. Used in 2D (gnomonic frame) and directly on
the sphere (with triple-product predicates) for over-hemisphere polygons.
**Why:** O(n²) but tiny and dependency-free; the fancy alternatives
(constrained Delaunay, monotone decomposition) are what we deliberately
avoided. Sized for annotation-scale polygons — DGGS cells never come here
(they take the topology-fan fast path).

## Eberly's hole bridging — `bridgeHole2`, `src/tess.js`

Merges a hole ring into its outer ring by a bridge at a mutually visible vertex
pair: ray-cast +x from the hole's max-x vertex, then screen the candidate
triangle for reflex vertices. From David Eberly's "Triangulation by Ear
Clipping" write-up. **Why the citation:** the visibility predicate is subtle;
the name points at a proven recipe instead of asking the reader to trust
hand-waved geometry. The naive alternative (test all pairs) has the same
complexity and the same subtle predicate, minus the reference.

## Bâdoiu–Clarkson (approximate minimum enclosing ball) — `capCenter`, `src/tess.js`

Finds the bounding-cap center of a polygon's vertices: start at the vertex
mean, repeatedly step toward the farthest vertex with shrinking (1/k) steps.
**Why:** hemisphere routing needs a margin-*maximizing* center — the plain
vertex mean is density-biased and misrouted near-hemisphere polygons (a bug we
actually hit). Exact algorithms (Welzl) are more code; this is ~8 lines, and
the citation is what explains why the funny shrinking step converges.

## Triple-product predicate — `det3`, `src/tess.js`

`det(a,b,c) = a · (b × c)`: positive iff the spherical triangle a→b→c winds CCW
seen from outside the sphere. The spherical ear-clip path builds its
orientation and point-in-triangle tests from it. **Why:** it's the exact
spherical analog of the 2D cross-product sign test — the plain name for the
plain tool.

## Gauss–Bonnet (area from boundary turning) — `test/tess.test.js` only

For a geodesic polygon, enclosed area = 2π − Σ exterior turn angles. The test
suite computes each polygon's region area from its boundary alone, then checks
that the triangulation's summed spherical excess matches. **Why:** one
frame-independent invariant validates every triangulation — overlaps, spills,
and wrong-side fills all double-count area and break it. The alternative
(golden files, hand-picked constants) is weaker and more brittle. Never ships;
tests only.

## Spherical excess — `test/tess.test.js`

A spherical triangle's area = (sum of its angles) − π. The per-triangle half of
the Gauss–Bonnet check above.

## Terms deliberately *not* used in code comments

- **Steiner vertices/points** — plain "new vertices" says it better; the term
  survives only in `docs/complement-polygons-with-holes.md` as history.
- Anything naming the tessellation routing ("Bâdoiu–Clarkson", "Eberly") leaks
  no further than `src/tess.js`; the public API and README stay in plain
  geometry vocabulary.
