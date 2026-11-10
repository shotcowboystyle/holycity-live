import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vehicles, arrivals, alerts } from './gtfsrt.js';

// tiny protobuf writer for test messages: [field, value] with value a number (varint), {f32}, string or nested array
const vint = n => { let b = BigInt.asUintN(64, BigInt(n)); const out = []; do { let x = Number(b & 0x7fn); b >>= 7n; if (b) x |= 0x80; out.push(x); } while (b); return out; };
function msg(fields) {
  const out = [];
  for (const [f, v] of fields) {
    if (typeof v === 'number') out.push(...vint(f * 8), ...vint(v));
    else if (v.f32 != null) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v.f32, true); out.push(...vint(f * 8 + 5), ...b); }
    else { const b = typeof v === 'string' ? [...new TextEncoder().encode(v)] : [...msg(v)]; out.push(...vint(f * 8 + 2), ...vint(b.length), ...b); }
  }
  return Uint8Array.from(out);
}
const feed = (...ents) => msg([[1, [[1, '2.0']]], ...ents.map(e => [2, e])]);

test('vehicles: position, trip and route, without a position dropped', () => {
  const buf = feed([[1, 'e1'], [4, [[1, [[1, 'trip9'], [5, '1239']]], [2, [[1, { f32: 32.78 }], [2, { f32: -79.93 }], [3, { f32: 90 }]]], [5, 1794340800], [8, [[1, 'v12'], [2, '1203']]]]]],
    [[1, 'e2'], [4, [[8, [[1, 'v13']]]]]]);
  const [v, ...rest] = vehicles(buf);
  assert.equal(rest.length, 0);
  assert.equal(v.id, 'v12'); assert.equal(v.label, '1203'); assert.equal(v.trip, 'trip9'); assert.equal(v.route, '1239');
  assert.ok(Math.abs(v.lat - 32.78) < 1e-5 && Math.abs(v.lon + 79.93) < 1e-5);
  assert.equal(v.ts, 1794340800); // a 5-byte varint survives
});

test('arrivals: only the asked stop, with times, negative delays and skipped stops', () => {
  const tu = (trip, stus) => [[1, trip], [3, [[1, [[1, trip], [5, '1239']]], ...stus.map(s => [2, s])]]];
  const buf = feed(
    tu('t1', [[[4, 'A'], [3, [[2, 1794340900]]]], [[4, 'B'], [3, [[2, 1794341000]]]]]),
    tu('t2', [[[4, 'B'], [2, [[1, -90]]]]]),
    tu('t3', [[[4, 'B'], [5, 1]]]));
  assert.deepEqual(arrivals(buf, 'B'), [
    { trip: 't1', route: '1239', time: 1794341000, delay: null, skipped: false },
    { trip: 't2', route: '1239', time: null, delay: -90, skipped: false },
    { trip: 't3', route: '1239', time: null, delay: null, skipped: true },
  ]);
  assert.deepEqual(arrivals(buf, 'Z'), []);
});

test('alerts: header, description, routes and active period', () => {
  const tr = s => [[1, [[1, s], [2, 'en']]]];
  const buf = feed([[1, 'a1'], [5, [[1, [[1, 1794300000], [2, 1794900000]]], [5, [[2, '1241']]], [5, [[2, '1241']]], [10, tr('Detour on Route 30')], [11, tr('Use Ashley Ave')]]]]);
  assert.deepEqual(alerts(buf), [{ header: 'Detour on Route 30', description: 'Use Ashley Ave', url: '', routes: ['1241'], stops: [], periods: [[1794300000, 1794900000]] }]);
});
