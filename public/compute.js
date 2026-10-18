// Heavy per-pixel work for the Flood & Heat map, run in a Web Worker (app.js `compute`) so the page never stalls:
// decoding the 3DEP elevation export, the rain model's depression fill and decoding the City heat-island rasters.
// Results come back as flat typed arrays, transferred rather than copied.

// Float32 → IEEE half (round to nearest), for the elevation texture. ponytail: no NaN payloads; 3DEP has none here.
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function toHalf(v) {
  f32[0] = v; const x = u32[0], sign = (x >>> 16) & 0x8000, m = x & 0x7fffff, e = ((x >>> 23) & 0xff) - 112;
  if (e <= 0) return e < -10 ? sign : sign | ((((m | 0x800000) >>> (1 - e)) + 0x1000) >>> 13);
  if (e >= 31) return sign | 0x7c00;
  return Math.min(sign | 0x7c00, sign | ((e << 10) + ((m + 0x1000) >>> 13)));
}

// Terrain mesh on a (SEGX + 1) × (SEGY + 1) vertex grid, PlaneGeometry order (row iy runs north → south) laid flat in
// x/z: fills each vertex's height (elevation × exag, water clamped flat at 0) and its normal from central differences.
// Shared with app.js, which reruns it when the exaggeration slider moves. Returns the highest vertex, for bounds.
export function relief(elev, exag, SEGX, SEGY, SW, SD, position, normal) {
  const X = SEGX + 1, dx = SW / SEGX, dz = SD / SEGY, k = exag / 1000;
  let top = 0;
  for (let i = 0; i < elev.length; i++) { const y = Math.max(elev[i], 0) * k; position[i * 3 + 1] = y; if (y > top) top = y; }
  for (let iy = 0; iy <= SEGY; iy++) for (let ix = 0; ix <= SEGX; ix++) {
    const y = (jx, jy) => position[(Math.min(SEGY, Math.max(0, jy)) * X + Math.min(SEGX, Math.max(0, jx))) * 3 + 1];
    const gx = (y(ix + 1, iy) - y(ix - 1, iy)) / ((Math.min(SEGX, ix + 1) - Math.max(0, ix - 1)) * dx);
    const gz = (y(ix, iy + 1) - y(ix, iy - 1)) / ((Math.min(SEGY, iy + 1) - Math.max(0, iy - 1)) * dz); // z grows southward with iy
    const len = Math.hypot(gx, 1, gz), i = (iy * X + ix) * 3;
    normal[i] = -gx / len; normal[i + 1] = 1 / len; normal[i + 2] = -gz / len;
  }
  return top;
}

// heights: rows north→south (as exported); half: rows flipped (texture v=0 is south); elev, position, normal, uv, index:
// the terrain mesh, so the page only has to hand the arrays to three.js
async function dem({ url, PW, PH, SEGX, SEGY, SW, SD, exag }) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} 3DEP export`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength < PW * PH * 4) throw new Error('3DEP export truncated');
  const heights = new Float32Array(buf, 0, PW * PH).slice(); // little-endian floats; a 1-bit mask band follows
  const half = new Uint16Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) half[(PH - 1 - y) * PW + x] = toHalf(heights[y * PW + x]);
  const X = SEGX + 1, V = X * (SEGY + 1);
  const elev = new Float32Array(V), position = new Float32Array(V * 3), normal = new Float32Array(V * 3), uv = new Float32Array(V * 2);
  for (let iy = 0; iy <= SEGY; iy++) for (let ix = 0; ix <= SEGX; ix++) {
    const i = iy * X + ix;
    elev[i] = heights[Math.round(iy / SEGY * (PH - 1)) * PW + Math.round(ix / SEGX * (PW - 1))];
    position[i * 3] = ix / SEGX * SW - SW / 2; position[i * 3 + 2] = iy / SEGY * SD - SD / 2;
    uv[i * 2] = ix / SEGX; uv[i * 2 + 1] = 1 - iy / SEGY;
  }
  const index = new Uint32Array(SEGX * SEGY * 6);
  for (let iy = 0, j = 0; iy < SEGY; iy++) for (let ix = 0; ix < SEGX; ix++) { // same winding as PlaneGeometry
    const a = iy * X + ix, b = a + X, c = b + 1, d = a + 1;
    index[j++] = a; index[j++] = b; index[j++] = d; index[j++] = b; index[j++] = c; index[j++] = d;
  }
  const top = relief(elev, exag, SEGX, SEGY, SW, SD, position, normal);
  dem.last = { heights: heights.slice(), W: PW, H: PH }; // kept for the rain task; the page gets the original
  return { heights, half, elev, position, normal, uv, index, top: new Float32Array([top]) };
}

// Rain ponding model, the DEM-only part:
// 1. Priority-Flood (Barnes 2014) fills every depression in the DEM that can't drain to open water or the map edge.
// 2. Each filled depression becomes one component: its cells, sorted elevations (+ prefix sums) and spill level,
//    so app.js can fill it bottom-up for any rain volume with a binary search.
class MinHeap {
  constructor(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(v, k) {
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= k) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = k; this.v[i] = v;
  }
  pop() {
    const top = this.v[0], k = this.k[--this.n], v = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= k) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = k; this.v[i] = v;
    return top;
  }
}

export function fillDepressions(elev, W, H, outletBelow) {
  const n = W * H, filled = Float32Array.from(elev), closed = new Uint8Array(n), heap = new MinHeap(n), pit = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % W, y = (i / W) | 0;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || elev[i] < outletBelow) { closed[i] = 1; heap.push(i, elev[i]); }
  }
  let ph = 0, pt = 0;
  while (pt < ph || heap.n) {
    const c = pt < ph ? pit[pt++] : heap.pop(), cx = c % W, cy = (c / W) | 0, fc = filled[c];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if ((!dx && !dy) || x < 0 || y < 0 || x >= W || y >= H) continue;
      const nb = y * W + x; if (closed[nb]) continue;
      closed[nb] = 1;
      if (filled[nb] <= fc) { filled[nb] = fc; pit[ph++] = nb; } else heap.push(nb, filled[nb]);
    }
  }
  return filled;
}

// g: the rain grid's uv extent {x, y, z, w}. Component k owns cells[start[k] .. start[k] + n[k]); sorted uses the same
// offsets, prefix (n + 1 sums each) starts at start[k] + k. gx/gy: its centroid's fractional GNX × GNY grid position.
export function findDepressions(elev, W, H, outletBelow, g, GNX, GNY) {
  const filled = fillDepressions(elev, W, H, outletBelow);
  const seen = new Uint8Array(W * H), cells = new Int32Array(W * H), sorted = new Float32Array(W * H), q = new Int32Array(W * H);
  const start = [], n = [], spill = [], gx = [], gy = [];
  let used = 0;
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || filled[s] - elev[s] < 0.005) continue;
    const s0 = used; let qh = 0, qt = 0, sx = 0, sy = 0;
    q[qt++] = s; seen[s] = 1;
    while (qh < qt) { // flood-fill one depression (8-connected)
      const c = q[qh++], cx = c % W, cy = (c / W) | 0; cells[used++] = c; sx += cx; sy += cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const nb = y * W + x; if (!seen[nb] && filled[nb] - elev[nb] >= 0.005) { seen[nb] = 1; q[qt++] = nb; }
      }
    }
    const k = used - s0;
    for (let j = 0; j < k; j++) sorted[s0 + j] = elev[cells[s0 + j]];
    sorted.subarray(s0, used).sort();
    const u = sx / k / (W - 1), v = 1 - sy / k / (H - 1); // centroid → grid cell for rainfall
    start.push(s0); n.push(k); spill.push(filled[cells[s0]]);
    gx.push(Math.min(1, Math.max(0, (u - g.x) / (g.z - g.x))) * (GNX - 1)); gy.push(Math.min(1, Math.max(0, (v - g.y) / (g.w - g.y))) * (GNY - 1));
  }
  const prefix = new Float64Array(used + start.length);
  for (let c = 0; c < start.length; c++) {
    const o = start[c] + c; for (let j = 0; j < n[c]; j++) prefix[o + j + 1] = prefix[o + j] + sorted[start[c] + j];
  }
  return { cells: cells.slice(0, used), sorted: sorted.slice(0, used), prefix, start: Int32Array.from(start), n: Int32Array.from(n),
    spill: Float32Array.from(spill), gx: Float32Array.from(gx), gy: Float32Array.from(gy) };
}

// City heat-island model: decode a rendered raster back to °F through its legend ramp (ld: legend column RGBA, top =
// hottest). Returns the anomaly vs the mean (rows north→south) and an RGBA texture of it (rows flipped).
async function heat({ url, W, H, ld, hi, lo }) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} heat export`);
  const img = await createImageBitmap(await r.blob()), c = new OffscreenCanvas(W, H), g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data, temp = new Float32Array(W * H).fill(NaN), rows = ld.length / 4;
  let sum = 0, cnt = 0;
  const near = new Map(); // packed RGB → nearest legend row: the raster has few distinct colors, so scan the legend once per color
  for (let p = 0; p < W * H; p++) {
    if (d[p * 4 + 3] < 200) continue;
    const rgb = (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2];
    let best = near.get(rgb);
    if (best === undefined) {
      let bd = Infinity; best = 0;
      for (let k = 0; k < rows; k++) {
        const dr = d[p * 4] - ld[k * 4], dg = d[p * 4 + 1] - ld[k * 4 + 1], db = d[p * 4 + 2] - ld[k * 4 + 2];
        const dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; best = k; }
      }
      near.set(rgb, best);
    }
    temp[p] = hi - best / (rows - 1) * (hi - lo); sum += temp[p]; cnt++;
  }
  const mean = sum / cnt, out = new Uint8Array(W * H * 4), anom = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, a = Number.isNaN(temp[p]) ? 0 : temp[p] - mean, q = ((H - 1 - y) * W + x) * 4;
    anom[p] = a; out[q] = Math.max(0, Math.min(255, Math.round(128 + a * 16))); out[q + 3] = 255;
  }
  return { out, anom };
}

const TASKS = {
  dem,
  rain: ({ outletBelow, g, GNX, GNY }) => { const { heights, W, H } = dem.last; return findDepressions(heights, W, H, outletBelow, g, GNX, GNY); },
  heat,
};
// message {id, task, ...args} → {id, result} with every typed array transferred, or {id, error}
if (typeof WorkerGlobalScope !== 'undefined') onmessage = async ({ data: { id, task, ...args } }) => {
  try {
    const result = await TASKS[task](args);
    postMessage({ id, result }, Object.values(result).map(a => a.buffer));
  } catch (e) { // reported back to the caller, which shows it in the Data sources panel
    postMessage({ id, error: String(e.message ?? e) });
  }
};
