# Complement polygons with holes: the one shape ajglobe couldn't fill

*2026-07-07 · status: **RESOLVED — implemented.** AJ's ruling: "I don't want to
second-guess the input. I want to respect the input we're given." Winding is
now trusted everywhere (outer rings are never normalized; hole rings are
oriented only to their role), and complement-with-holes is implemented — via a
cap-ring split rather than §6's Steiner-fan sketch, which turned out to have an
ear-scarcity flaw (see the addendum, §8). §§1–7 are kept as written, as the
record of the analysis.*

## 1. The one-sentence version

ajglobe can fill any spherical polygon **except** one whose interior is the
*complement* side of its first ring **and** which also has holes — "the whole
sphere, minus this loop, minus also these other loops" expressed as a single
polygon. Today that input silently renders the wrong region.

## 2. Background: what winding means on a sphere

A closed loop on a plane has an inside and an unbounded outside, so winding is
just a convention. On a sphere there is **no unbounded outside**: every simple
loop divides the sphere into two perfectly legitimate regions, and *something*
must say which one you mean. That something is winding — GeoJSON's right-hand
rule: **the interior is on your left as you walk the ring**. Walk a small loop
counter-clockwise and you enclose the small patch; walk the same loop clockwise
and you enclose everything else — all ~4π steradians of it.

This isn't pedantry; it's the entire subject of the cells_to_poly blog post,
and ajglobe honors it: the post's "loops ordered by enclosed area" figures
render correctly *because* `tess.js` treats a lone CW ring as "fill the
complement."

Holes compose with this the obvious way: a polygon's region is what's on the
left of **every** one of its rings simultaneously. A normal polygon is
`[outer CCW, holes CW]`. The shape this doc is about is `[outer CW, holes CW]`
— left-of-the-first-ring is the complement, and the extra rings cut holes out
of *that*.

## 3. What works today, and through which machinery

`triangulatePolygon` (src/tess.js) has three routes; every blog polygon and
test exercises one of them:

| shape | example | route |
|---|---|---|
| normal polygon, optional holes, fits a hemisphere | intro figure (3 holes) | gnomonic projection at the bounding-cap center → 2D ear-clip; winding normalized |
| complement of a **single** loop | the three "enclose most of the globe" figures | Steiner fan from the antipode of the cap center |
| over-hemisphere outer + holes | `cross` (antipodal vertices, 3 holes) | ear-clip on the sphere with triple-product predicates; trusts RHR |

So "polygons with holes" per se are fully implemented — the gap is only the
*combination* of complement-interior and holes.

## 4. Why the combination is genuinely different

Two independent reasons, one per code path:

**Routing (gnomonic path).** A multi-ring polygon whose vertices all fit a
hemisphere goes to the gnomonic path, which *normalizes* winding — outer
forced CCW, holes CW. That's the right robustness call for the 99% case
(planar GIS tools emit sloppy winding constantly), but it means a deliberate
CW outer is silently flipped: you asked for the complement, you get the small
side. **The current failure mode is a silent wrong-region render, which is
the worst kind of failure.**

**No ears (spherical path).** Suppose we routed it to the winding-trusting
spherical path instead. Ear-clipping needs an "ear": a convex boundary corner
whose triangle contains no other vertex. The complement of a convex-ish loop
has **no convex corners at all** — every interior angle, measured from the
region's side, exceeds π. On the plane this is impossible (the two-ears
theorem guarantees ≥ 3 convex vertices), but the plane gets that from its
unbounded outside; a sphere owes you nothing. Ear-clipping can't take even
one bite. This is exactly why the single-loop complement case uses a Steiner
fan — an artificial interior vertex at the antipode that every boundary
vertex can see — rather than ear-clipping.

## 5. Does anything real produce this shape?

Almost nothing — and that's the honest reason it was left out:

- **H3's `cellsToMultiPolygon` / h3c2p, shapely, turf, GEOS**: all emit a
  "natural" outer loop (the blog's algorithm is literally about picking it).
  They never hand you a CW outer with holes.
- **d3-geo** *renders* the shape fine (its spherical clipping doesn't
  triangulate), so data authored against d3 could contain it in principle —
  but the blog's own figures never combine complement + holes.

The one plausible future use case is ours, not imported: a **focus mask** —
"dim everything except this region." For a single-loop region that's the
supported complement case. But "everything except this *archipelago*" — a
mask around a MultiPolygon country, a set of DGGS cells, a scatter of range
rings — is precisely complement-with-holes. If ajglobe ever grows a
`mask()` convenience, this is the geometry under it.

## 6. The candidate solve: generalize the Steiner fan

The single-loop complement trick extends naturally:

1. Detect the case: first ring CW (in the gnomonic frame — computable
   whenever the rings' vertices fit a hemisphere, which a mask around a
   local region always satisfies) *and* extra rings present.
2. Plant a **tiny CCW Steiner ring** (a triangle ~1e-4 rad across, sub-pixel
   at any zoom) at the antipode of the rings' bounding-cap center. That point
   is outside every loop — i.e. inside the region — exactly when all loops
   fit the cap, the same condition as (1).
3. Treat the Steiner ring as the outer boundary and **demote every given
   ring to a hole**, then run the *existing* spherical-path machinery:
   nearest-visible-pair bridging + predicate ear-clip. No new algorithms.
4. `subdivideTri` already handles the resulting globe-spanning triangles.

Cost estimate: ~20–30 lines in `tess.js`, one test (sphere minus two hexes,
area = 4π − 2·hex by the existing Gauss-Bonnet validator), plus a PLAN §7
edit. The Steiner triangle leaves a ~1e-8 sr unfilled dot at the antipode —
invisible, and it can be shrunk arbitrarily.

Alternatives considered:

- **Warn-and-normalize** (detect the CW-outer-with-holes case, `console.warn`,
  render the small side): cheap, kills the *silent* part of the failure, but
  still renders the wrong thing.
- **Push to the data layer** ("normalize your polygons — pick a natural outer
  loop"): principled — it's what the blog's algorithm is *for* — but it makes
  ajglobe's winding semantics partial: CW means complement for one ring but
  is an error with two. Partial semantics are hard to document and harder to
  trust.
- **Full spherical boolean ops**: out of scope, always.

## 7. Recommendation

**Implement the Steiner-outer generalization, at low priority.** Reasoning:

- The strongest argument isn't the use case (thin, today) but **semantic
  totality**: ajglobe has already committed to "winding is meaningful"
  (PLAN §7) — that promise currently has an asterisk, and the asterisk's
  failure mode is a silent wrong-region fill.
- The fix is small, reuses existing machinery end-to-end, and is precisely
  testable with the validators we already have.
- It unlocks the one future feature that would want it (focus masks) for
  free.

If deferred instead, the minimum honest action is the warn-and-normalize
detector (~5 lines), so the silent failure becomes a loud one. What should
not survive this doc is the status quo: silently rendering the opposite
region of what the winding asked for.

## 8. Addendum: what actually shipped (2026-07-07)

The decision went further than §7's recommendation: **all winding
normalization on outer rings was removed**, not just the complement case
closed. `triangulatePolygon` now reads the first ring's winding (gnomonic
signed-area sign when the polygon fits a hemisphere; trusted as-given
otherwise) and routes:

- CCW outer → gnomonic path (holes oriented to their role — hole-ness comes
  from GeoJSON ring order, so given the role a hole's winding is redundant;
  flipping it enforces the role, it never re-chooses the region).
- CW single ring → antipodal fan (unchanged).
- CW outer + holes → **cap-ring split**, not the §6 Steiner fan. During
  implementation the fan idea hit an ear-scarcity flaw: after bridging holes
  into a tiny antipodal outer, *every* boundary corner except the bridge
  junctions is reflex from the region's side, junction ears are huge and
  usually contain other vertices, and ear clipping stalls into the fallback.
  Instead, split the sphere at a circle midway between the loops' bounding
  cap and the hemisphere limit: the far side is a pure cap (fan from the
  antipode, no holes); the near side is an ordinary hemisphere-fitting
  polygon — split circle as CCW outer, the given loops as holes — handled by
  the existing gnomonic path. Both sides share the split ring's vertices, so
  subdivision keeps the seam crack-free (the shared-edge argument from
  subdivideTri).

Tests: sphere-minus-two-hexes and sphere-minus-three-hexes validate by
Gauss-Bonnet (region = 4π − Σ loops); the validator now uses one uniform
formula for every case — trusted outer, role-oriented holes — which is
itself the evidence that the semantics became total. The consequence for
sloppy planar exports (shapefile CW exteriors et al.) is accepted and
intentional: normalize your data before handing it to the renderer; the
renderer will believe you.
