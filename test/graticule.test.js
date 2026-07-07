// graticuleLines geometry (Node's built-in runner: `node --test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graticuleLines } from '../src/orb.js';

// Split { lnglat, starts } back into per-polyline [lng, lat] arrays.
function polylines({ lnglat, starts }) {
  const out = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const line = [];
    for (let v = starts[i]; v < starts[i + 1]; v++) line.push([lnglat[v * 2], lnglat[v * 2 + 1]]);
    out.push(line);
  }
  return out;
}

test('default graticule: 36 meridians + 17 parallels, all within bounds', () => {
  const lines = polylines(graticuleLines());
  assert.equal(lines.length, 36 + 17);
  for (const line of lines) for (const [lng, lat] of line) {
    assert.ok(lng >= -180 && lng <= 180, `lng ${lng}`);
    assert.ok(lat >= -80 && lat <= 80, `lat ${lat}`);
  }
});

test('meridians run pole-limit to pole-limit at constant longitude', () => {
  const meridians = polylines(graticuleLines()).slice(0, 36);
  for (const m of meridians) {
    assert.ok(m.every(([lng]) => lng === m[0][0]), 'constant lng');
    assert.equal(m[0][1], -80);
    assert.equal(m[m.length - 1][1], 80);
  }
});

test('parallels are closed rings at constant latitude, symmetric about the equator', () => {
  const parallels = polylines(graticuleLines()).slice(36);
  const lats = parallels.map((p) => p[0][1]);
  assert.deepEqual(lats, lats.map((_, i) => -80 + i * 10));   // -80..80 by 10
  for (const p of parallels) {
    assert.ok(p.every(([, lat]) => lat === p[0][1]), 'constant lat');
    assert.equal(p[0][0], -180);
    assert.equal(p[p.length - 1][0], 180);                    // closes on itself
  }
});

test('step 15 keeps parallels at symmetric multiples of step', () => {
  const lines = polylines(graticuleLines({ step: 15 }));
  const meridians = lines.filter((l) => l.every(([lng]) => lng === l[0][0]) && l[0][1] === -80);
  const parallels = lines.filter((l) => l.every(([, lat]) => lat === l[0][1]));
  assert.equal(meridians.length, 24);                         // 360 / 15
  assert.deepEqual(parallels.map((p) => p[0][1]), [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75]);
});
