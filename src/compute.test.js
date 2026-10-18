import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillDepressions, findDepressions, toHalf, relief } from '../public/compute.js';

// 5 × 5 ground at 2 m with a 2-cell pit (0.5 m, 1 m) draining over a 1.5 m notch in the map edge
const W = 5, H = 5, elev = new Float32Array(W * H).fill(2);
elev[2 * W + 2] = 0.5; elev[2 * W + 3] = 1; elev[2 * W + 4] = 1.5;

test('fillDepressions: pit fills to its spill level, edges and open water drain', () => {
  const f = fillDepressions(elev, W, H, -10);
  assert.equal(f[2 * W + 2], 1.5);
  assert.equal(f[2 * W + 3], 1.5);
  assert.equal(f[0], 2); // map edge: untouched
  assert.equal(fillDepressions(elev, W, H, 0.6)[2 * W + 2], 0.5); // below the outlet level the pit is open water
});

test('findDepressions: one component as flat arrays with sorted elevations, prefix sums and grid position', () => {
  const r = findDepressions(elev, W, H, -10, { x: 0, y: 0, z: 1, w: 1 }, 5, 4);
  assert.equal(r.start.length, 1);
  assert.equal(r.n[0], 2); // the notch itself holds no water, so it isn't part of the depression
  assert.deepEqual([...r.sorted], [0.5, 1]);
  assert.deepEqual([...r.prefix], [0, 0.5, 1.5]); // n + 1 sums, starting at start + component index
  assert.equal(r.spill[0], 1.5);
  assert.deepEqual([...r.cells].sort(), [2 * W + 2, 2 * W + 3]);
  assert.ok(r.gx[0] > 0 && r.gx[0] < 4 && r.gy[0] > 0 && r.gy[0] < 3);
});

test('toHalf: IEEE half-float bits, rounding and overflow', () => {
  assert.deepEqual([1, -2, 0.5, 3.4, 65504, 1e6, 0].map(toHalf), [0x3c00, 0xc000, 0x3800, 0x42cd, 0x7bff, 0x7c00, 0]);
});

test('relief: exaggerated heights, water flat at 0, normals tilt away from the slope', () => {
  // 3 × 2 vertices (SEGX 2, SEGY 1) on a 2 km × 1 km plane; elevation rises 10 m per column eastward
  const elev = new Float32Array([-5, 10, 20, -5, 10, 20]), pos = new Float32Array(18), nrm = new Float32Array(18);
  const top = relief(elev, 100, 2, 1, 2, 1, pos, nrm);
  assert.deepEqual([pos[1], pos[4], pos[7]].map(v => +v.toFixed(3)), [0, 1, 2]); // m × 100 / 1000 → km, water clamped
  assert.equal(+top.toFixed(3), 2);
  assert.ok(nrm[3] < 0 && nrm[4] > 0 && Math.abs(nrm[5]) < 1e-9); // rising to +x: normal leans to −x, none in z
  assert.ok(Math.abs(Math.hypot(nrm[3], nrm[4], nrm[5]) - 1) < 1e-6);
});
