// Shared helpers for the example pages. App-level code, deliberately outside
// src/ — the library owns no color scales or data loading (PLAN §3).

// viridis via 8 control stops (no d3 dependency)
const STOPS = [[68,1,84],[71,44,122],[59,81,139],[44,113,142],
               [33,144,141],[39,173,129],[92,200,99],[253,231,37]];
export function viridis(t){
  t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, t | 0), f = t - i, a = STOPS[i], b = STOPS[i+1];
  return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f, 255];
}

// Fetch a little-endian binary from data/ into a typed array.
export async function bin(name, Ctor){
  const b = await fetch(`data/${name}`).then(r=>{if(!r.ok)throw new Error(name+' '+r.status);return r.arrayBuffer();});
  return new Ctor(b);
}

// Min/max/span of the finite values, for linear value->color scales. A span
// that is near-zero relative to the values is float noise (e.g. mu3 res 0: 12
// congruent pentagons, AR all 1.0) — return span Infinity so the caller's
// (v - min) / span collapses to one color instead of amplifying the noise.
export function finiteRange(values){
  let min = Infinity, max = -Infinity;
  for (const v of values) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min;
  return { min, max, span: span > 1e-4 * Math.max(Math.abs(min), Math.abs(max), 1) ? span : Infinity };
}
