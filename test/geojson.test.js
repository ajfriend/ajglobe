// geojsonLines: flatten a GeoJSON FeatureCollection into the lines() layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geojsonLines } from '../src/orb.js';

test('geojsonLines flattens lines + polygon rings, skips null geometry', () => {
  const gj = {
    type: 'FeatureCollection',
    features: [
      { geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } },
      { geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] } },
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] } },
      { geometry: null },   // skipped
      {},                   // no geometry -> skipped
    ],
  };
  const { lnglat, starts } = geojsonLines(gj);

  // one polyline per LineString / per ring (6 total): LS, 2×MLS, 1×Polygon ring, 2×MultiPolygon rings
  assert.deepEqual(Array.from(starts), [0, 2, 4, 7, 11, 14, 18]);   // start vertex of each polyline
  assert.equal(starts.length - 1, 6);                               // nLines

  const expected = [
    0, 0, 10, 0,            // LineString
    0, 0, 1, 1,             // MultiLineString[0]
    2, 2, 3, 3, 4, 4,       // MultiLineString[1]
    0, 0, 1, 0, 1, 1, 0, 0, // Polygon ring
    0, 0, 1, 0, 0, 0,       // MultiPolygon[0] ring
    5, 5, 6, 5, 6, 6, 5, 5, // MultiPolygon[1] ring
  ];
  assert.equal(lnglat.length, expected.length);
  assert.deepEqual(Array.from(lnglat), expected);
  assert.ok(lnglat instanceof Float32Array && starts instanceof Uint32Array);
});

test('geojsonLines on an empty collection', () => {
  const { lnglat, starts } = geojsonLines({ type: 'FeatureCollection', features: [] });
  assert.equal(lnglat.length, 0);
  assert.deepEqual(Array.from(starts), [0]);
});
