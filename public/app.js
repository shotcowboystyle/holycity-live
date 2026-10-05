import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

// ---------- config ----------
const BBOX = { w: -80.10, e: -79.78, s: 32.68, n: 32.88 };
const FOCUS = { w: -79.9723, e: -79.9132, s: 32.7630, n: 32.8276 }; // ZIP 29401 + 29403 extent (Census TIGERweb 2020 ZCTA)
const Z = 13;                                   // tile zoom for terrain (basemap loads one level finer)
const STATION = '8665530';                      // NOAA Charleston Harbor gauge
const NWPS_ID = 'CHTS1';                        // same gauge in NWS Water Prediction Service
const CENTER = { lat: 32.7808, lon: -79.9310 }; // downtown, for point weather/AQ
const GNX = 5, GNY = 4;                         // Open-Meteo sampling grid (must match shader)
const BACK = 48, FWD = 168, N = BACK + FWD + 1; // timeline hours
const R = 6378137, FT = 0.3048;
const COOPS = 'https://api.tidesandcurrents.noaa.gov';
const FEMA = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const CITY = 'https://gis.charleston-sc.gov/arcgis2/rest/services/External';
const CITY_V1 = 'https://gis.charleston-sc.gov/arcgis/rest/services/External'; // older City server (police, Dupont stormwater)
const COUNTY_PW = 'https://gisccapps.charlestoncounty.org/arcgis/rest/services/Public_Works/Public_Works_Viewer/MapServer';
const MRMS = 'https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer';
const UHI_LAYERS = { morning: 4, afternoon: 5, evening: 6 }; // City heat-island temperature models

// ---------- tile / projection math ----------
const lon2x = lon => (lon + 180) / 360 * 2 ** Z;
const lat2y = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z; };
const X0 = Math.floor(lon2x(BBOX.w)), X1 = Math.floor(lon2x(BBOX.e));
const Y0 = Math.floor(lat2y(BBOX.n)), Y1 = Math.floor(lat2y(BBOX.s));
const NX = X1 - X0 + 1, NY = Y1 - Y0 + 1, PW = NX * 256, PH = NY * 256;
const tile2mx = x => x / 2 ** Z * 2 * Math.PI * R - Math.PI * R;
const tile2my = y => Math.PI * R - y / 2 ** Z * 2 * Math.PI * R;
const MB = { w: tile2mx(X0), e: tile2mx(X1 + 1), n: tile2my(Y0), s: tile2my(Y1 + 1) }; // EPSG:3857 extent
const COSLAT = Math.cos((BBOX.n + BBOX.s) / 2 * Math.PI / 180);
const SW = (MB.e - MB.w) * COSLAT / 1000, SD = (MB.n - MB.s) * COSLAT / 1000; // scene size, km
// uv: u west→east, v south→north
const lonlat2uv = (lon, lat) => [(lon2x(lon) - X0) / NX, 1 - (lat2y(lat) - Y0) / NY];
const uv2lonlat = (u, v) => {
  const x = X0 + u * NX, y = Y0 + (1 - v) * NY, n = Math.PI - 2 * Math.PI * y / 2 ** Z;
  return [x / 2 ** Z * 360 - 180, 180 / Math.PI * Math.atan(Math.sinh(n))];
};
const uv2xz = (u, v) => [(u - 0.5) * SW, (0.5 - v) * SD];
const EXTENT_3857 = `${MB.w},${MB.s},${MB.e},${MB.n}`;

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const T0 = Math.floor(Date.now() / 3.6e6) * 3600 - BACK * 3600; // unix seconds, top of hour
const tAt = i => T0 + i * 3600;
const coopsTime = s => Date.parse(s.replace(' ', 'T') + 'Z') / 1000;
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
const localHour = t => +new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  return r.json();
}
const loadImg = src => new Promise((res, rej) => {
  const i = new Image(); i.crossOrigin = 'anonymous';
  i.onload = () => res(i); i.onerror = () => rej(new Error('image failed: ' + src.split('?')[0])); i.src = src;
});
const sources = {};
function source(name, promise) {
  sources[name] = '…'; renderSources();
  // A failed source is reported in the Sources panel and resolves false; the other layers keep working.
  return promise.then(v => { sources[name] = 'ok'; renderSources(); return v ?? true; },
    e => { sources[name] = e.message; renderSources(); return false; });
}
function renderSources() {
  $('sources').innerHTML = Object.entries(sources).map(([k, v]) =>
    `<li>${k}: <span class="${v === 'ok' ? 'ok' : v === '…' ? '' : 'bad'}">${v === 'ok' ? '✓' : v}</span></li>`).join('');
}
function heatIndex(T, RH) { // NWS Rothfusz regression, °F. ponytail: skips the small low-RH/high-RH adjustments
  const hi = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094);
  if ((hi + T) / 2 < 80) return hi;
  return -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH - 0.00683783 * T * T
    - 0.05481717 * RH * RH + 0.00122874 * T * T * RH + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
}
const heatCat = hi => hi >= 125 ? ['Extreme danger', '#b5179e'] : hi >= 103 ? ['Danger', '#eb5757']
  : hi >= 90 ? ['Extreme caution', '#f2994a'] : hi >= 80 ? ['Caution', '#f2c94c'] : ['Low', '#6fcf97'];
const aqiCat = a => a > 300 ? ['Hazardous', '#7e0023'] : a > 200 ? ['Very unhealthy', '#8f3f97'] : a > 150 ? ['Unhealthy', '#ff0000']
  : a > 100 ? ['Unhealthy for sensitive', '#ff7e00'] : a > 50 ? ['Moderate', '#ffff00'] : ['Good', '#00e400'];

// ---------- three.js scene ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
camera.position.set(0, 16, 17);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true; controls.maxPolarAngle = 1.35; controls.minDistance = 0.8; controls.maxDistance = 70;
function resize() {
  renderer.setSize(view.clientWidth, view.clientHeight);
  camera.aspect = view.clientWidth / view.clientHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
function fitFocus() { // frame the 29401/29403 peninsula at a 45° tilt
  const [u0, v0] = lonlat2uv(FOCUS.w, FOCUS.s), [u1, v1] = lonlat2uv(FOCUS.e, FOCUS.n);
  const [x0, z0] = uv2xz(u0, v0), [x1, z1] = uv2xz(u1, v1), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const span = Math.max(Math.abs(x1 - x0) / camera.aspect, Math.abs(z1 - z0));
  const dist = span / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.1;
  controls.target.set(cx, 0, cz);
  camera.position.set(cx, dist * Math.SQRT1_2, cz + dist * Math.SQRT1_2);
}
fitFocus();

const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); blank.needsUpdate = true;
const highGround = new THREE.DataTexture(new Uint16Array([THREE.DataUtils.toHalfFloat(100)]), 1, 1, THREE.RedFormat, THREE.HalfFloatType); // until 3DEP loads
highGround.needsUpdate = true;
const uhiBlank = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1); uhiBlank.needsUpdate = true;
const uniforms = {
  uBase: { value: blank }, uFema: { value: blank }, uUhi: { value: uhiBlank }, uRain: { value: blank }, uHeight: { value: highGround }, uCanopy: { value: blank },
  uWater: { value: -99 }, uMhhw: { value: 0.8 }, uTime: { value: 0 },
  uFlood: { value: true }, uRainOn: { value: true }, uCanopyOn: { value: false }, uHeat: { value: false }, uFemaOn: { value: false },
  uT: { value: new Float32Array(GNX * GNY) }, uRH: { value: new Float32Array(GNX * GNY) },
  uGrid: { value: new THREE.Vector4(...lonlat2uv(BBOX.w, BBOX.s), ...lonlat2uv(BBOX.e, BBOX.n)) }, // Open-Meteo grid corners in uv
  uLight: { value: new THREE.Vector3(-0.5, 0.8, -0.35).normalize() },
};
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */`
    attribute float elev;
    varying vec2 vUv; varying float vElev; varying vec3 vN;
    void main() {
      vUv = uv; vElev = elev; vN = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    #define GNX ${GNX}
    #define GNY ${GNY}
    uniform sampler2D uBase, uFema, uUhi, uRain, uHeight, uCanopy;
    uniform float uWater, uMhhw, uTime;
    uniform bool uFlood, uRainOn, uHeat, uFemaOn, uCanopyOn;
    uniform float uT[GNX * GNY]; uniform float uRH[GNX * GNY];
    uniform vec4 uGrid; uniform vec3 uLight;
    varying vec2 vUv; varying float vElev; varying vec3 vN;

    float gv(int k, int i) { return k == 0 ? uT[i] : uRH[i]; }
    float gridAt(int k, vec2 uv) {
      vec2 p = clamp((uv - uGrid.xy) / (uGrid.zw - uGrid.xy), 0.0, 1.0) * vec2(GNX - 1, GNY - 1);
      ivec2 a = ivec2(floor(p)); ivec2 b = min(a + 1, ivec2(GNX - 1, GNY - 1)); vec2 f = p - vec2(a);
      return mix(mix(gv(k, a.y * GNX + a.x), gv(k, a.y * GNX + b.x), f.x),
                 mix(gv(k, b.y * GNX + a.x), gv(k, b.y * GNX + b.x), f.x), f.y);
    }
    float heatIndex(float T, float RH) {
      float hi = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);
      if ((hi + T) * 0.5 < 80.0) return hi;
      return -42.379 + 2.04901523*T + 10.14333127*RH - 0.22475541*T*RH - 0.00683783*T*T
        - 0.05481717*RH*RH + 0.00122874*T*T*RH + 0.00085282*T*RH*RH - 0.00000199*T*T*RH*RH;
    }
    const float HS[6] = float[6](70.0, 78.0, 80.0, 90.0, 103.0, 125.0);
    const vec3 HC[6] = vec3[6](vec3(.18,.49,.82), vec3(.59,.8,.02), vec3(.95,.79,.3),
                               vec3(.95,.6,.29), vec3(.92,.34,.34), vec3(.71,.09,.62));
    vec3 heatRamp(float h) {
      if (h <= HS[0]) return HC[0];
      for (int i = 1; i < 6; i++) if (h < HS[i]) return mix(HC[i-1], HC[i], (h - HS[i-1]) / (HS[i] - HS[i-1]));
      return HC[5];
    }
    void main() {
      float e = texture2D(uHeight, vUv).r;                               // 3DEP elevation, m, per pixel
      vec3 col = texture2D(uBase, vUv).rgb * (0.62 + 0.55 * max(dot(normalize(vN), uLight), 0.0));
      if (uCanopyOn) { vec4 c = texture2D(uCanopy, vUv); col = mix(col, vec3(0.18, 0.72, 0.32), c.a * 0.65); }
      if (uFemaOn && e > 0.0) { // FEMA draws 1% zones cyan, 0.2% orange; recolor cyan to violet so it doesn't read as water
        vec4 f = texture2D(uFema, vUv);
        col = mix(col, f.b > 0.5 ? vec3(0.62, 0.36, 0.95) : f.rgb, f.a * 0.6);
      }
      if (uHeat && e > 0.3) {
        float T = gridAt(0, vUv) + (texture2D(uUhi, vUv).r * 255.0 - 128.0) / 16.0;
        col = mix(col, heatRamp(heatIndex(T, gridAt(1, vUv))), 0.6);
      }
      float rip = 0.05 * sin(vUv.x * 900.0 + uTime * 2.0) * sin(vUv.y * 700.0 - uTime * 1.6);
      float rain = texture2D(uRain, vUv).r * 2.55;                       // ponded rain depth, m (1 cm steps)
      if (uFlood && e < uWater && e < uMhhw) col = mix(col, vec3(0.04, 0.16, 0.30), 0.45); // normally wet: river, marsh, harbor
      else if (uFlood && e < uWater) {                               // tidal flooding
        float k = clamp((uWater - e) / 1.524, 0.0, 1.0);            // 0..5 ft depth ramp
        col = mix(col, mix(vec3(0.2, 0.8, 1.0), vec3(0.0, 0.25, 0.88), k) + rip, 0.82);
      } else if (uRainOn && rain > 0.05) {                               // rain ponding >= 2 in
        float k = clamp(rain / 0.61, 0.0, 1.0);                          // 0..2 ft depth ramp
        col = mix(col, mix(vec3(0.5, 0.95, 0.7), vec3(0.0, 0.6, 0.5), k) + rip, 0.82);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
});

const SEGX = NX * 64, SEGY = NY * 64;
const geo = new THREE.PlaneGeometry(SW, SD, SEGX, SEGY);
geo.rotateX(-Math.PI / 2);
const terrain = new THREE.Mesh(geo, material);
scene.add(terrain);
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }));
marker.visible = false; scene.add(marker);
const roads = new THREE.Group(); scene.add(roads);
const storm = new THREE.Group(); storm.visible = false; scene.add(storm);

let heights = null; // Float32Array PW*PH, meters NAVD88 (USGS 3DEP via Terrarium)
let exag = 12;
const disp = m => Math.max(m, 0) / 1000 * exag; // clamp water bodies flat at 0
function elevAt(u, v) {
  const x = Math.min(PW - 1, Math.max(0, Math.round(u * (PW - 1))));
  const y = Math.min(PH - 1, Math.max(0, Math.round((1 - v) * (PH - 1))));
  return heights[y * PW + x];
}
function applyExag() {
  const pos = geo.attributes.position, elev = geo.attributes.elev.array;
  for (let i = 0; i < pos.count; i++) pos.setY(i, disp(elev[i]));
  pos.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere(); geo.computeBoundingBox();
  buildRoads(); buildStorm();
}

async function mosaic(z, ...urlFns) { // same extent at zoom z >= Z; later url functions draw on top (labels over base)
  const k = 2 ** (z - Z), c = document.createElement('canvas'); c.width = PW * k; c.height = PH * k;
  const g = c.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let x = X0 * k; x < (X1 + 1) * k; x++) for (let y = Y0 * k; y < (Y1 + 1) * k; y++)
    jobs.push(Promise.all(urlFns.map(f => loadImg(f(z, x, y))))
      .then(imgs => imgs.forEach(i => g.drawImage(i, (x - X0 * k) * 256, (y - Y0 * k) * 256))));
  await Promise.all(jobs);
  return c;
}

// ---------- state ----------
const S = { i: BACK, slrFt: 0, surgeFt: 0, tide: null, nwps: null, stofs: null, wl: null, wx: null, grid: null, aq: null, slr: null, uhi: {}, closures: [], rain: null };

// ---------- loaders ----------
// USGS 3DEP straight from the source ImageServer. (AWS Terrarium tiles were tried first: their z13/z14 overviews
// hold integer/wrong values on the peninsula, e.g. Calhoun St 15 m vs 3.4 m in 3DEP.) Server render takes ~10 s.
const DEM = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const terrainP = source('USGS 3DEP elevation', (async () => {
  const r = await fetch(`${DEM}/exportImage?bbox=${EXTENT_3857}&bboxSR=3857&imageSR=3857&size=${PW},${PH}&format=bsq&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`);
  if (!r.ok) throw new Error(`${r.status} 3DEP export`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength < PW * PH * 4) throw new Error('3DEP export truncated');
  heights = new Float32Array(buf, 0, PW * PH).slice(); // little-endian floats, rows north→south; a 1-bit mask band follows
  const half = new Uint16Array(PW * PH); // per-pixel elevation for the fragment shader (rows flipped: v=0 is south)
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) half[(PH - 1 - y) * PW + x] = THREE.DataUtils.toHalfFloat(heights[y * PW + x]);
  const ht = new THREE.DataTexture(half, PW, PH, THREE.RedFormat, THREE.HalfFloatType);
  ht.magFilter = ht.minFilter = THREE.LinearFilter; ht.unpackAlignment = 2; ht.needsUpdate = true;
  uniforms.uHeight.value = ht;
  const uv = geo.attributes.uv, elev = new Float32Array(uv.count);
  for (let i = 0; i < uv.count; i++) elev[i] = elevAt(uv.getX(i), uv.getY(i));
  geo.setAttribute('elev', new THREE.BufferAttribute(elev, 1));
  applyExag();
  $('loading').style.display = 'none';
})());

const ESRI = 'https://services.arcgisonline.com/arcgis/rest/services';
const BASEMAPS = {
  dark: (z, x, y) => `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  satellite: (z, x, y) => `${ESRI}/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};
const labels = (z, x, y) => `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`;
const baseTex = {};
function setBasemap(name) { // z14: street-level labels for the zoomed-in peninsula view
  baseTex[name] ??= source(`Esri ${name} basemap`, mosaic(Z + 1, BASEMAPS[name], labels).then(c => {
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  }));
  baseTex[name].then(t => { if (t && $('basemap').value === name) uniforms.uBase.value = t; });
}
setBasemap('dark');

source('FEMA NFHL flood zones', new Promise((res, rej) => new THREE.TextureLoader().load(
  `${FEMA}/export?bbox=${EXTENT_3857}&bboxSR=3857&imageSR=3857&size=2048,${Math.round(2048 * PH / PW)}&dpi=40&layers=show:28&format=png32&transparent=true&f=image`,
  res, undefined, () => rej(new Error('export failed')))).then(t => { uniforms.uFema.value = t; }));

const tideP = source('NOAA CO-OPS tides, datums, flood stages', (async () => {
  const q = `station=${STATION}&datum=MLLW&units=english&time_zone=gmt&format=json&application=holycity-live`;
  const d0 = new Date(T0 * 1000), ymd = `${d0.getUTCFullYear()}${String(d0.getUTCMonth() + 1).padStart(2, '0')}${String(d0.getUTCDate()).padStart(2, '0')}`;
  const [obs, pred, datums, flood] = await Promise.all([
    getJSON(`${COOPS}/api/prod/datagetter?product=water_level&range=${BACK + 1}&${q}`),
    getJSON(`${COOPS}/api/prod/datagetter?product=predictions&interval=h&begin_date=${ymd}&range=${N + 24}&${q}`),
    getJSON(`${COOPS}/mdapi/prod/webapi/stations/${STATION}/datums.json?units=english`),
    getJSON(`${COOPS}/mdapi/prod/webapi/stations/${STATION}/floodlevels.json?units=english`),
  ]);
  const dv = Object.fromEntries(datums.datums.map(d => [d.name, d.value])); // ft above station datum
  const o = new Map(), p = new Map();
  let last = null;
  for (const r of obs.data || []) { if (r.v === '') continue; const t = coopsTime(r.t); last = { t, v: +r.v }; if (t % 3600 === 0) o.set(t, +r.v); }
  for (const r of pred.predictions) p.set(coopsTime(r.t), +r.v);
  const predAt = t => { const a = Math.floor(t / 3600) * 3600, f = (t - a) / 3600; return p.get(a) * (1 - f) + p.get(a + 3600) * f; };
  S.tide = {
    obs: o, pred: p, last,
    anom: last ? last.v - predAt(last.t) : 0,       // current surge/anomaly vs astronomical tide
    navdOffsetFt: dv.NAVD88 - dv.MLLW,              // MLLW → NAVD88
    mhhwFt: dv.MHHW - dv.MLLW,
    thr: { minor: flood.nws_minor - dv.MLLW, moderate: flood.nws_moderate - dv.MLLW, major: flood.nws_major - dv.MLLW },
  };
  uniforms.uMhhw.value = (S.tide.mhhwFt - S.tide.navdOffsetFt) * FT;
})()).then(rebuildWater);

const hourMap = pairs => { const m = new Map(); for (const [t, v] of pairs) if (t % 3600 === 0) m.set(t, v); return m; };
source('NWS official harbor forecast (NWPS)', getJSON(`https://api.water.noaa.gov/nwps/v1/gauges/${NWPS_ID}/stageflow`).then(d => {
  S.nwps = hourMap(d.forecast.data.map(r => [Date.parse(r.validTime) / 1000, r.primary])); // ft MLLW, includes surge
  S.nwpsIssued = d.forecast.issuedTime;
})).then(rebuildWater);
source('NOAA STOFS-2D-Global surge guidance', getJSON('/api/stofs').then(d => { // via server.py (S3 has no CORS)
  if (d.error) throw new Error(d.error);
  S.stofs = hourMap(d.values.map((v, k) => [d.start + k * d.intervalMin * 60, v]));
  S.stofsCycle = d.cycle;
})).then(rebuildWater);

// Water level per timeline hour, best source first: observed → NWS official → STOFS model → tide + anomaly.
// At each hand-off the new source is offset to match the old one, and that offset fades over 12 h.
const WL_SOURCES = [
  ['NWS official forecast', t => S.nwps?.get(t)],
  ['STOFS model guidance', t => S.stofs?.get(t)],
  ['Tide prediction + anomaly', t => { const p = S.tide.pred.get(t); return p == null ? undefined : p + S.tide.anom; }],
];
function rebuildWater() {
  const T = S.tide; if (!T) return update();
  const v = new Array(N).fill(null), src = new Array(N).fill(null);
  let cur = null, off = 0, tSwitch = 0;
  for (let i = 0; i < N; i++) {
    const t = tAt(i);
    if (T.last && t <= T.last.t) { v[i] = T.obs.get(t) ?? T.pred.get(t) ?? null; src[i] = 'Observed'; continue; }
    const s = WL_SOURCES.find(([, get]) => get(t) != null); if (!s) continue;
    if (s[0] !== cur) {
      const prev = i > 0 ? v[i - 1] : null, mine = s[1](t - 3600);
      off = prev != null && mine != null ? prev - mine : 0; cur = s[0]; tSwitch = t;
    }
    v[i] = s[1](t) + off * Math.max(0, 1 - (t - tSwitch) / 43200); src[i] = s[0];
  }
  S.wl = { v, src };
  update();
}

source('NOAA 2022 sea level rise scenarios', getJSON(`${COOPS}/dpapi/prod/webapi/product/slr_projections.json?station=${STATION}`).then(d => {
  S.slr = {};
  for (const r of d.SlrProjections) (S.slr[r.scenario] ??= []).push([r.projectionYear, r.projectionRsl]);
  const sel = $('slrScen');
  sel.innerHTML = Object.keys(S.slr).map(s => `<option ${s === 'Intermediate' ? 'selected' : ''}>${s}</option>`).join('');
  updateSlr();
}));

const omBase = 'timeformat=unixtime&past_days=2&forecast_days=8&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';
const lats = [], lons = []; // GNX × GNY grid, row 0 = south
for (let j = 0; j < GNY; j++) for (let i = 0; i < GNX; i++) {
  lats.push(+(BBOX.s + (BBOX.n - BBOX.s) * j / (GNY - 1)).toFixed(4));
  lons.push(+(BBOX.w + (BBOX.e - BBOX.w) * i / (GNX - 1)).toFixed(4));
}
source('Open-Meteo forecast (HRRR/GFS/ECMWF blend)', (async () => {
  const [grid, wx] = await Promise.all([
    getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m,relative_humidity_2m,precipitation&${omBase}`),
    getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${CENTER.lat}&longitude=${CENTER.lon}&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,cloud_cover,uv_index&${omBase}`),
  ]);
  S.grid = { idx: new Map(grid[0].hourly.time.map((t, k) => [t, k])), pts: grid.map(g => g.hourly) };
  S.wx = { idx: new Map(wx.hourly.time.map((t, k) => [t, k])), h: wx.hourly };
})()).then(update);

// Radar-observed rain for past hours. MRMS publishes accumulations ending now (1, 3, 6 … 48 h); differencing them
// gives rain per bucket, spread evenly over that bucket's hours. Point GNX*GNY is downtown.
source('NOAA MRMS radar rainfall (observed)', (async () => {
  const pts = lons.map((x, k) => [x, lats[k]]).concat([[CENTER.lon, CENTER.lat]]);
  const geometry = encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }));
  const d = await getJSON(`${MRMS}/getSamples?geometry=${geometry}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=false&outFields=name,idp_validendtime&f=json`);
  const q = pts.map(() => ({})), when = {}; let end = 0;
  for (const s of d.samples) {
    const m = s.attributes.name.match(/^conus_QPE_(\d+)H$/), te = s.attributes.idp_validendtime / 1000;
    if (!m || Number.isNaN(+s.value) || te < (when[`${s.locationId}/${m[1]}`] ?? 0)) continue; // newest raster per duration
    when[`${s.locationId}/${m[1]}`] = te; q[s.locationId][+m[1]] = Math.max(0, +s.value) / 25.4; end = Math.max(end, te); // service values are mm
  }
  if (!end) throw new Error('no CONUS QPE samples');
  const B = [0, 1, 3, 6, 12, 24, 48];
  S.mrms = { end, hourly: q.map(Q => {
    const h = new Map();
    for (let b = 1; b < B.length; b++) {
      const inc = Math.max(0, (Q[B[b]] ?? 0) - (Q[B[b - 1]] ?? 0)) / (B[b] - B[b - 1]);
      for (let j = B[b - 1]; j < B[b]; j++) h.set(end - j * 3600, inc); // hour ending at that time
    }
    return h;
  }) };
})()).then(update);
// rain (in) in the hour ending at t for grid point p (p = GNX*GNY: downtown): radar when observed, else forecast
function rainIn(p, t) {
  if (S.mrms && t <= S.mrms.end) return S.mrms.hourly[p].get(t) ?? 0;
  if (p === GNX * GNY) { const k = S.wx?.idx.get(t); return k == null ? null : S.wx.h.precipitation[k]; }
  const k = S.grid?.idx.get(t); return k == null ? null : S.grid.pts[p].precipitation[k];
}

source('Open-Meteo air quality (CAMS)', getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CENTER.lat}&longitude=${CENTER.lon}&hourly=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide&timeformat=unixtime&past_days=2&forecast_days=7`)
  .then(d => { S.aq = { idx: new Map(d.hourly.time.map((t, k) => [t, k])), h: d.hourly }; update(); }));

source('NWS active alerts', getJSON(`https://api.weather.gov/alerts/active?point=${CENTER.lat},${CENTER.lon}`).then(d => {
  $('alerts').innerHTML = d.features.length ? d.features.map(f => `<div class="alert"><b>${f.properties.event}</b><br>${f.properties.headline ?? ''}</div>`).join('')
    : 'No active alerts for downtown Charleston.';
})).then(ok => { if (!ok) $('alerts').textContent = 'Unavailable (see Data sources).'; });

// City of Charleston heat-island temperature models: decode rendered raster back to °F via its legend ramp.
async function loadUhi(layer, legend) {
  const entry = legend.layers.find(l => l.layerId === layer).legend[0];
  const [hi, lo] = entry.label.match(/[\d.]+/g).map(Number).sort((a, b) => b - a);
  const leg = await loadImg('data:image/png;base64,' + entry.imageData);
  const lc = document.createElement('canvas'); lc.width = leg.width; lc.height = leg.height;
  const lg = lc.getContext('2d'); lg.drawImage(leg, 0, 0);
  const ld = lg.getImageData(leg.width >> 1, 0, 1, leg.height).data; // top = hottest
  const W = 1024, H = Math.round(W * PH / PW);
  const img = await loadImg(`${CITY}/Heat/MapServer/export?bbox=${EXTENT_3857}&bboxSR=3857&imageSR=3857&size=${W},${H}&layers=show:${layer}&format=png32&transparent=true&f=image`);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data, temp = new Float32Array(W * H).fill(NaN);
  let sum = 0, n = 0;
  for (let p = 0; p < W * H; p++) {
    if (d[p * 4 + 3] < 200) continue;
    let best = 0, bd = Infinity;
    for (let k = 0; k < leg.height; k++) {
      const dr = d[p * 4] - ld[k * 4], dg = d[p * 4 + 1] - ld[k * 4 + 1], db = d[p * 4 + 2] - ld[k * 4 + 2];
      const dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; best = k; }
    }
    temp[p] = hi - best / (leg.height - 1) * (hi - lo); sum += temp[p]; n++;
  }
  const mean = sum / n, out = new Uint8Array(W * H * 4), anom = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, a = Number.isNaN(temp[p]) ? 0 : temp[p] - mean, q = ((H - 1 - y) * W + x) * 4; // flip rows: texture v=0 is south
    anom[p] = a; out[q] = Math.max(0, Math.min(255, Math.round(128 + a * 16))); out[q + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, W, H); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return { tex, anom, W, H };
}
source('City of Charleston heat-island models', (async () => {
  const legend = await getJSON(`${CITY}/Heat/MapServer/legend?f=json`);
  for (const [k, l] of Object.entries(UHI_LAYERS)) S.uhi[k] = await loadUhi(l, legend);
})()).then(update);

source('City of Charleston road closures', (async () => {
  const where = encodeURIComponent("IS_DRILL IS NULL OR IS_DRILL <> 'Yes'");
  const fc = await Promise.all([1, 5].map(l => getJSON(`${CITY}/RoadClosuresViewer/MapServer/${l}/query?where=${where}&outFields=OBJECTID,STREET,LOCATION,REASON,TYPE,STATUS,COMMENT&outSR=4326&f=geojson`)));
  const seen = new Set(); // the EM layer repeats features from the main closure layer
  S.closures = fc.flatMap(f => f.features).filter(f => f.geometry && !seen.has(f.properties.OBJECTID) && seen.add(f.properties.OBJECTID));
})()).then(async () => { await terrainP; buildRoads(); update(); });

const drape = ([lon, lat], lift = 0.02) => { const [u, v] = lonlat2uv(lon, lat), [x, z] = uv2xz(u, v); return [x, disp(elevAt(u, v)) + lift, z]; };
const linesOf = g => g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
function addLines(group, positions, color) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
}
function addPoints(group, positions, color, size) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  group.add(new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false })));
}
function buildRoads() {
  if (!heights) return;
  roads.clear();
  const seg = { flood: [], other: [] }, pts = { flood: [], other: [] };
  const v3 = c => drape(c);
  for (const f of S.closures) {
    const k = /FLOOD/i.test(f.properties.REASON ?? '') ? 'flood' : 'other';
    const lines = linesOf(f.geometry);
    for (const l of lines) for (let i = 1; i < l.length; i++) seg[k].push(...v3(l[i - 1]), ...v3(l[i]));
    pts[k].push(...v3(lines[0][0]));
  }
  for (const [k, color] of [['other', 0xffb020], ['flood', 0xff5a5a]]) { addLines(roads, seg[k], color); addPoints(roads, pts[k], color, 7); }
}

// ---------- stormwater + tree canopy (lazy: fetched the first time a layer is switched on) ----------
// Public storm data is patchy: City inlets are citywide, City pipes exist only for the Dupont–Wappoo watershed
// (West Ashley), and County pipes cover County-maintained systems. The peninsula has inlets but no public pipe data.
const lazy = {};
async function queryAll(url, page) { // every feature inside BBOX, fetched as parallel pages
  const geo = `where=1%3D1&geometry=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
  const { count } = await getJSON(`${url}/query?${geo}&returnCountOnly=true&f=json`);
  const pages = await Promise.all(Array.from({ length: Math.ceil(count / page) }, (_, k) =>
    getJSON(`${url}/query?${geo}&outFields=OBJECTID&outSR=4326&geometryPrecision=6&orderByFields=OBJECTID&resultOffset=${k * page}&resultRecordCount=${page}&f=geojson`)));
  return pages.flatMap(p => p.features).filter(f => f.geometry);
}
S.storm = { inlets: [], dupont: [], county: [] };
function loadStorm() {
  lazy.storm ??= Promise.all([
    source('City storm inlets', queryAll(`${CITY}/Applications/MapServer/2`, 5000).then(f => { S.storm.inlets = f; })),
    source('City Dupont–Wappoo storm network', Promise.all([7, 6, 8].map(l => queryAll(`${CITY_V1}/StormwaterViewerAppDupont/MapServer/${l}`, 1000)))
      .then(f => { S.storm.dupont = f.flat(); })),
    source('County storm pipes', queryAll(`${COUNTY_PW}/56`, 2000).then(f => { S.storm.county = f; })),
  ]).then(async () => { await terrainP; buildStorm(); });
}
function buildStorm() {
  if (!heights) return;
  storm.clear();
  const seg = [];
  for (const f of [...S.storm.dupont, ...S.storm.county])
    for (const l of linesOf(f.geometry)) for (let i = 1; i < l.length; i++) seg.push(...drape(l[i - 1], 0.01), ...drape(l[i], 0.01));
  addLines(storm, seg, 0xe8eef5);
  addPoints(storm, S.storm.inlets.flatMap(f => drape(f.geometry.coordinates, 0.01)), 0x9ad8ff, 2);
}
const loadTex = url => new Promise((res, rej) => new THREE.TextureLoader().load(url, t => { t.anisotropy = renderer.capabilities.getMaxAnisotropy(); res(t); }, undefined, () => rej(new Error('export failed'))));
const cityExport = (svc, layer, w) => { // dynamicLayers drops the City's baked-in value labels
  const dl = encodeURIComponent(JSON.stringify([{ id: +layer, source: { type: 'mapLayer', mapLayerId: +layer }, drawingInfo: { showLabels: false } }]));
  return `${svc}/export?bbox=${EXTENT_3857}&bboxSR=3857&imageSR=3857&size=${w},${Math.round(w * PH / PW)}&dynamicLayers=${dl}&format=png32&transparent=true&f=image`;
};
function loadCanopy() {
  lazy.canopy ??= source('City tree canopy', loadTex(cityExport(`${CITY}/Trees/MapServer`, 1, PW)).then(t => { uniforms.uCanopy.value = t; }));
}
// ---------- time-dependent values ----------
const waterFt = t => S.wl?.v[(t - T0) / 3600] ?? null; // gauge level, ft MLLW, before scenarios
const scenarioFt = () => S.slrFt + S.surgeFt;

// ---------- rain ponding model ----------
// 1. Priority-Flood (Barnes 2014) fills every depression in the DEM that can't drain to open water or the map edge.
// 2. Hourly rain accumulates as excess storage: S += rain − drainage. Drainage throttles to zero as the harbor
//    rises from MHHW to minor flood stage (gravity outfalls submerge), so high tide + rain compounds.
// 3. Each depression receives excess × its area × a runoff-concentration factor and fills bottom-up to its spill level.
// ponytail: overflow from a full depression doesn't cascade downstream; add flow routing if that matters.
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
function fillDepressions(elev, W, H, outletBelow) {
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
function buildRain() {
  const W = PW, H = PH, elev = heights, filled = fillDepressions(elev, W, H, uniforms.uMhhw.value);
  const seen = new Uint8Array(W * H), cells = new Int32Array(W * H), comps = [], q = new Int32Array(W * H);
  let used = 0;
  const g = uniforms.uGrid.value;
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || filled[s] - elev[s] < 0.005) continue;
    const start = used; let qh = 0, qt = 0, sx = 0, sy = 0;
    q[qt++] = s; seen[s] = 1;
    while (qh < qt) { // flood-fill one depression (8-connected)
      const c = q[qh++], cx = c % W, cy = (c / W) | 0; cells[used++] = c; sx += cx; sy += cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const nb = y * W + x; if (!seen[nb] && filled[nb] - elev[nb] >= 0.005) { seen[nb] = 1; q[qt++] = nb; }
      }
    }
    const n = used - start, sorted = new Float32Array(n);
    for (let k = 0; k < n; k++) sorted[k] = elev[cells[start + k]];
    sorted.sort();
    const prefix = new Float64Array(n + 1); for (let k = 0; k < n; k++) prefix[k + 1] = prefix[k] + sorted[k];
    const u = sx / n / (W - 1), v = 1 - sy / n / (H - 1); // centroid → grid cell for rainfall
    const px = Math.min(1, Math.max(0, (u - g.x) / (g.z - g.x))) * (GNX - 1), py = Math.min(1, Math.max(0, (v - g.y) / (g.w - g.y))) * (GNY - 1);
    comps.push({ start, n, sorted, prefix, spill: filled[cells[start]], gx: px, gy: py });
  }
  const depth = new Uint8Array(W * H);
  const tex = new THREE.DataTexture(depth, W, H, THREE.RedFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
  uniforms.uRain.value = tex;
  S.rain = { cells: cells.subarray(0, used), comps, depth, tex, area: 0 };
  update();
}
function rainExcessIn(i) { // excess (undrained) rain storage at timeline index i, inches, per grid point
  const drain = +$('drain').value, T = S.tide, out = new Float64Array(GNX * GNY);
  for (let j = 0; j <= i; j++) {
    const w = waterFt(tAt(j)), f = T && w != null ? Math.min(1, Math.max(0, (T.thr.minor - w - scenarioFt()) / (T.thr.minor - T.mhhwFt))) : 1;
    for (let p = 0; p < out.length; p++) out[p] = Math.max(0, out[p] + (rainIn(p, tAt(j)) ?? 0) - drain * f);
  }
  return out;
}
function updateRain() {
  const R = S.rain; if (!R || !S.grid) return;
  const ex = rainExcessIn(S.i), conc = +$('conc').value, water = uniforms.uWater.value;
  R.depth.fill(0); let wet = 0;
  for (const c of R.comps) {
    const ax = Math.floor(c.gx), ay = Math.floor(c.gy), bx = Math.min(ax + 1, GNX - 1), by = Math.min(ay + 1, GNY - 1), fx = c.gx - ax, fy = c.gy - ay;
    const s = (ex[ay * GNX + ax] * (1 - fx) + ex[ay * GNX + bx] * fx) * (1 - fy) + (ex[by * GNX + ax] * (1 - fx) + ex[by * GNX + bx] * fx) * fy;
    const V = s * 0.0254 * conc * c.n; if (V <= 0) continue; // m × cells
    const { sorted: e, prefix: P, n } = c;
    let L;
    if (V >= n * c.spill - P[n]) L = c.spill;
    else { // largest k with k·e[k−1] − P[k] ≤ V, then level = (V + P[k]) / k
      let lo = 1, hi = n;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (m * e[m - 1] - P[m] <= V) lo = m; else hi = m - 1; }
      L = (V + P[lo]) / lo;
    }
    for (let k = c.start; k < c.start + n; k++) {
      const cell = R.cells[k], d = L - heights[cell]; if (d <= 0) continue;
      const x = cell % PW, y = (cell / PW) | 0;
      R.depth[(PH - 1 - y) * PW + x] = Math.min(255, Math.round(d * 100)); // texture rows run south → north
      if (d >= 0.05 && heights[cell] >= water) wet++;
    }
  }
  R.tex.needsUpdate = true;
  R.area = wet * (SW / PW) * (SD / PH);
}
const rainDepthAt = (u, v) => { // m
  if (!S.rain) return 0;
  const x = Math.min(PW - 1, Math.max(0, Math.round(u * (PW - 1)))), y = Math.min(PH - 1, Math.max(0, Math.round((1 - v) * (PH - 1))));
  return S.rain.depth[(PH - 1 - y) * PW + x] / 100;
};
Promise.all([terrainP, tideP]).then(() => { if (heights) setTimeout(buildRain); });
function uhiFor(t) { const h = localHour(t); return S.uhi[h >= 6 && h < 11 ? 'morning' : h >= 11 && h < 18 ? 'afternoon' : 'evening']; }
function gridVal(t, key, u, v) { // JS twin of shader gridAt
  const k = S.grid?.idx.get(t); if (k == null) return null;
  const g = uniforms.uGrid.value;
  const px = Math.min(1, Math.max(0, (u - g.x) / (g.z - g.x))) * (GNX - 1), py = Math.min(1, Math.max(0, (v - g.y) / (g.w - g.y))) * (GNY - 1);
  const ax = Math.floor(px), ay = Math.floor(py), bx = Math.min(ax + 1, GNX - 1), by = Math.min(ay + 1, GNY - 1), fx = px - ax, fy = py - ay;
  const at = (i, j) => S.grid.pts[j * GNX + i][key][k];
  return (at(ax, ay) * (1 - fx) + at(bx, ay) * fx) * (1 - fy) + (at(ax, by) * (1 - fx) + at(bx, by) * fx) * fy;
}

function updateSlr() {
  const year = +$('slrYear').value, rows = S.slr?.[$('slrScen').value];
  const at = y => { for (let i = 1; i < rows.length; i++) if (y <= rows[i][0]) { const [y0, a] = rows[i - 1], [y1, b] = rows[i]; return a + (b - a) * (y - y0) / (y1 - y0); } return rows.at(-1)[1]; };
  S.slrFt = year && rows ? (at(year) - at(new Date().getFullYear())) / 30.48 : 0; // cm → ft, relative to today
  update();
}

function update() {
  const t = tAt(S.i), rel = S.i - BACK;
  $('when').textContent = new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
  $('whenRel').textContent = rel === 0 ? 'Now' : rel < 0 ? `${-rel} h ago (observed)` : `+${rel} h (forecast)`;

  // flood
  const base = waterFt(t), T = S.tide;
  if (base != null) {
    const w = base + scenarioFt();
    uniforms.uWater.value = (w - T.navdOffsetFt) * FT;
    $('wl').textContent = fmt(w, 2);
    const [cat, col] = w >= T.thr.major ? ['Major flooding', 'var(--major)'] : w >= T.thr.moderate ? ['Moderate flooding', 'var(--moderate)']
      : w >= T.thr.minor ? ['Minor flooding', 'var(--minor)'] : ['Below flood stage', '#8b98a8'];
    Object.assign($('wlCat'), { textContent: cat }).style.background = col;
    const extra = scenarioFt() ? ` Includes +${fmt(scenarioFt(), 1)} ft scenario.` : '';
    const astro = T.pred.get(t), surge = astro == null ? '' : ` Surge vs astronomical tide: ${base - astro >= 0 ? '+' : ''}${fmt(base - astro, 2)} ft.`;
    updateRain();
    $('wlNote').textContent = `${S.wl.src[S.i]}.${surge}${extra} NWS minor ${fmt(T.thr.minor, 1)} · moderate ${fmt(T.thr.moderate, 1)} · major ${fmt(T.thr.major, 1)} ft. ${floodedArea()}`;
  } else uniforms.uWater.value = -99;
  drawChart();

  // heat
  const k = S.grid?.idx.get(t);
  uniforms.uHeat.value = $('lHeat').checked && k != null;
  if (k != null) S.grid.pts.forEach((p, j) => { uniforms.uT.value[j] = p.temperature_2m[k]; uniforms.uRH.value[j] = p.relative_humidity_2m[k]; });
  uniforms.uUhi.value = uhiFor(t)?.tex ?? uhiBlank;

  // point weather
  const wi = S.wx?.idx.get(t), h = S.wx?.h;
  if (wi != null) {
    const hiV = heatIndex(h.temperature_2m[wi], h.relative_humidity_2m[wi]), [hc, hcol] = heatCat(hiV);
    $('wx').innerHTML = [
      ['Temperature', `${fmt(h.temperature_2m[wi], 0)} °F`], ['Humidity', `${fmt(h.relative_humidity_2m[wi], 0)} %`],
      ['Heat index', `${fmt(hiV, 0)} °F <span class="tag" style="background:${hcol}">${hc}</span>`],
      ['Feels like', `${fmt(h.apparent_temperature[wi], 0)} °F`],
      S.mrms && t <= S.mrms.end ? ['Rain (radar)', `${fmt(rainIn(GNX * GNY, t), 2)} in`]
        : ['Rain', `${fmt(h.precipitation[wi], 2)} in · ${fmt(h.precipitation_probability[wi], 0)} %`],
      ['Wind / gust', `${fmt(h.wind_speed_10m[wi], 0)} / ${fmt(h.wind_gusts_10m[wi], 0)} mph`],
      ['Cloud cover', `${fmt(h.cloud_cover[wi], 0)} %`], ['UV index', fmt(h.uv_index[wi], 1)],
    ].map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('');
  } else if (S.wx) $('wx').textContent = 'No forecast for this hour.';

  const ai = S.aq?.idx.get(t), a = S.aq?.h;
  if (ai != null && a.us_aqi[ai] != null) {
    const [c, col] = aqiCat(a.us_aqi[ai]);
    $('aqi').textContent = fmt(a.us_aqi[ai], 0);
    Object.assign($('aqiCat'), { textContent: c }).style.background = col;
    $('aq').innerHTML = [['PM2.5', a.pm2_5[ai], 'µg/m³'], ['PM10', a.pm10[ai], 'µg/m³'], ['Ozone', a.ozone[ai], 'µg/m³'], ['NO₂', a.nitrogen_dioxide[ai], 'µg/m³']]
      .map(([n, v, u]) => `<span>${n}</span><span>${fmt(v, 1)} ${u}</span>`).join('');
  } else if (S.aq) { $('aqi').textContent = '—'; Object.assign($('aqiCat'), { textContent: '' }).style.background = 'none'; $('aq').textContent = 'No air quality forecast for this hour.'; }

  if (lastPick) inspect(...lastPick, false);
}

function floodedArea() { // km² of normally-dry land below current water level (bathtub)
  if (!heights || !S.tide) return '';
  const w = uniforms.uWater.value, m = uniforms.uMhhw.value; let n = 0;
  for (let i = 0; i < heights.length; i++) { const e = heights[i]; if (e >= m && e < w) n++; }
  const rain = S.rain && $('lRain').checked ? ` Rain ponding (≥ 2 in) ≈ ${fmt(S.rain.area, 2)} km².` : '';
  return `Tidal: ≈ ${fmt(n * (SW / PW) * (SD / PH), 1)} km² of normally-dry land under water.${rain}`;
}

function drawChart() {
  const c = $('tideChart'), T = S.tide; if (!T || !S.wl) return;
  const dpr = devicePixelRatio, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const vals = Array.from({ length: N }, (_, i) => waterFt(tAt(i)));
  const off = scenarioFt(), finite = vals.filter(v => v != null);
  const lo = Math.min(...finite) - 0.5, hi = Math.max(T.thr.major + 0.5, Math.max(...finite) + off + 0.5);
  const X = i => i / (N - 1) * W, Y = v => H - (v - lo) / (hi - lo) * H;
  for (const [k, col] of [['minor', '#f2c94c'], ['moderate', '#f2994a'], ['major', '#eb5757']]) {
    g.strokeStyle = col; g.globalAlpha = 0.6; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, Y(T.thr[k])); g.lineTo(W, Y(T.thr[k])); g.stroke();
  }
  g.globalAlpha = 1; g.setLineDash([]);
  if (S.wx) { // downtown hourly rain, bottom 30 % of chart, scaled to max(1 in/h, peak)
    const p = Array.from({ length: N }, (_, i) => rainIn(GNX * GNY, tAt(i)) ?? 0), pmax = Math.max(1, ...p);
    g.fillStyle = 'rgba(80, 220, 170, 0.55)';
    p.forEach((v, i) => { if (v > 0) g.fillRect(X(i) - 0.6, H - v / pmax * H * 0.3, 1.2 + W / N * 0.5, v / pmax * H * 0.3); });
  }
  const line = (series, col, keep) => {
    g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); let pen = false;
    for (let i = 0; i < N; i++) { const v = series[i]; if (v == null || !keep(i)) { pen = false; continue; } pen ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); pen = true; }
    g.stroke();
  };
  const astro = Array.from({ length: N }, (_, i) => T.pred.get(tAt(i)));
  g.globalAlpha = 0.35; line(astro, '#8b98a8', () => true); g.globalAlpha = 1;
  const src = S.wl.src, joined = name => i => src[i] === name || src[i + 1] === name; // overlap one step so segments touch
  line(vals, '#4cc3ff', joined('Observed'));
  g.setLineDash([4, 3]); line(vals, '#4cc3ff', joined(WL_SOURCES[0][0]));
  line(vals, '#2dd4bf', joined(WL_SOURCES[1][0]));
  g.setLineDash([1, 3]); line(vals, '#cbd5e1', joined(WL_SOURCES[2][0]));
  if (off) { g.setLineDash([]); line(vals.map(v => v == null ? null : v + off), '#c084fc', () => true); }
  g.setLineDash([]);
  g.fillStyle = '#8b98a8'; g.font = '10px system-ui'; g.fillText('now', X(BACK) + 3, 10);
  g.strokeStyle = '#8b98a8'; g.beginPath(); g.moveTo(X(BACK), 0); g.lineTo(X(BACK), H); g.stroke();
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(S.i), 0); g.lineTo(X(S.i), H); g.stroke();
}

// ---------- inspector ----------
let lastPick = null, down = null, femaSeq = 0;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !heights) return;
  const r = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = ray.intersectObject(terrain)[0]; if (!hit) return;
  marker.position.copy(hit.point); marker.visible = true;
  lastPick = [hit.point.x / SW + 0.5, 0.5 - hit.point.z / SD];
  inspect(...lastPick, true);
});
let remote = {};
const SUBDIV_FIELDS = 'SUBDIVISION,PCT_Imp,PCT_StreetTree,PCT_SubTree,AF_MEAN_TEMP'; // equity stats live on the Public Safety tab
const kv = rows => `<div class="kv" style="margin-top:4px">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')}</div>`;
const pct = v => v == null ? '—' : `${fmt(v, 0)} %`;
function inspect(u, v, fetchZone) {
  const [lon, lat] = uv2lonlat(u, v), t = tAt(S.i), elevFt = elevAt(u, v) / FT;
  const rows = [['Location', `${lat.toFixed(4)}, ${lon.toFixed(4)}`], ['Ground elevation', `${fmt(elevFt, 1)} ft NAVD88`]];
  if (S.tide && uniforms.uWater.value > -90) {
    const d = uniforms.uWater.value / FT - elevFt;
    rows.push(['Tidal water', d > 0 ? `<b style="color:#33ccff">${fmt(d, 1)} ft deep</b>` : `${fmt(-d, 1)} ft above water`]);
  }
  const rd = rainDepthAt(u, v);
  if (S.rain) rows.push(['Rain ponding', rd >= 0.01 ? `<b style="color:#50dcaa">${fmt(rd / 0.0254, 1)} in</b>` : 'none']);
  const Tg = gridVal(t, 'temperature_2m', u, v), RH = gridVal(t, 'relative_humidity_2m', u, v);
  if (Tg != null) {
    const U = uhiFor(t), px = U && Math.min(U.W - 1, Math.round(u * (U.W - 1))) + Math.min(U.H - 1, Math.round((1 - v) * (U.H - 1))) * U.W;
    const anom = U ? U.anom[px] : 0, hiV = heatIndex(Tg + anom, RH), [hc, col] = heatCat(hiV);
    rows.push(['Heat index', `${fmt(hiV, 0)} °F <span class="tag" style="background:${col}">${hc}</span>`],
      ['Local heat-island offset', anom ? `${anom > 0 ? '+' : ''}${fmt(anom, 1)} °F` : 'no city data']);
  }
  const render = () => { $('inspect').innerHTML = `<div class="kv">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')}</div>${Object.values(remote).join('')}`; };
  if (!fetchZone) return render();
  const seq = ++femaSeq, mine = remote = { fema: '<div class="sub">Looking up zone, neighborhood, pipes…</div>' };
  render();
  const lookup = (key, promise, label) => promise
    .then(html => { mine[key] = html; }, e => { mine[key] = `<div class="sub bad">${label} unavailable: ${e.message}</div>`; })
    .then(() => { if (seq === femaSeq) render(); });
  lookup('subdiv', getJSON(`${CITY}/Equity/MapServer/10/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${SUBDIV_FIELDS}&returnGeometry=false&f=json`)
    .then(d => {
      const a = d.features[0]?.attributes;
      return a ? kv([['Subdivision', `<b>${a.SUBDIVISION}</b>`], ['Impervious surface', pct(a.PCT_Imp)],
        ['Tree canopy: streets / overall', `${pct(a.PCT_StreetTree)} / ${pct(a.PCT_SubTree)}`], ['Afternoon mean temp (heat campaign)', `${fmt(a.AF_MEAN_TEMP, 1)} °F`]])
        : '<div class="sub">Outside City subdivision data.</div>';
    }), 'Neighborhood stats');
  if ($('lStorm').checked) {
    const near = url => getJSON(`${url}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&distance=30&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&resultRecordCount=1&f=json`).then(d => d.features[0]?.attributes);
    lookup('pipe', Promise.all([near(`${CITY_V1}/StormwaterViewerAppDupont/MapServer/7`), near(`${COUNTY_PW}/56`)]).then(([c, k]) => {
      const a = c ?? k;
      return a ? kv([['Nearest storm pipe (30 m)', `${a.DIAMETER ?? '?'} in ${a.MATERIAL ?? ''}`], ['Maintained by', c ? 'City of Charleston' : (a.MAINTENANCE_JURISDICTION ?? 'Charleston County')]])
        : '<div class="sub">No public pipe data within 30 m.</div>';
    }), 'Pipe lookup');
  }
  lookup('fema', getJSON(`${FEMA}/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all:28&tolerance=1&mapExtent=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}&imageDisplay=800,600,96&returnGeometry=false&f=json`)
    .then(d => {
      const a = d.results[0]?.attributes;
      return a ? kv([['FEMA zone', `<b>${a.FLD_ZONE}</b> ${a.ZONE_SUBTY && a.ZONE_SUBTY !== 'Null' ? '· ' + a.ZONE_SUBTY.toLowerCase() : ''}`],
        ...(+a.STATIC_BFE > -9999 ? [['Base flood elev.', `${a.STATIC_BFE} ft`]] : [])])
        : '<div class="sub">FEMA zone: none mapped here.</div>';
    }), 'FEMA zone');
}

// ---------- UI wiring ----------
$('time').max = N - 1;
$('time').addEventListener('input', e => { S.i = +e.target.value; update(); });
$('now').onclick = () => { S.i = BACK; $('time').value = BACK; update(); };
let timer = null;
$('play').onclick = () => {
  if (timer) { clearInterval(timer); timer = null; $('play').textContent = '▶ Play'; return; }
  $('play').textContent = '❚❚ Pause';
  timer = setInterval(() => { S.i = (S.i + 1) % N; $('time').value = S.i; update(); }, 200);
};
$('basemap').onchange = e => setBasemap(e.target.value);
$('lFlood').onchange = e => { uniforms.uFlood.value = e.target.checked; };
$('lRain').onchange = e => { uniforms.uRainOn.value = e.target.checked; update(); };
for (const id of ['drain', 'conc']) $(id).addEventListener('input', () => {
  $('drainV').textContent = `${(+$('drain').value).toFixed(2)} in/h`; $('concV').textContent = `${$('conc').value}×`; update();
});
$('recenter').onclick = fitFocus;
$('lHeat').onchange = update;
$('lFema').onchange = e => { uniforms.uFemaOn.value = e.target.checked; };
$('lRoads').onchange = e => { roads.visible = e.target.checked; };
$('lStorm').onchange = e => { storm.visible = e.target.checked; if (e.target.checked) loadStorm(); };
$('lCanopy').onchange = e => { uniforms.uCanopyOn.value = e.target.checked; if (e.target.checked) loadCanopy(); };
$('slrScen').onchange = updateSlr; $('slrYear').onchange = updateSlr;
$('surge').addEventListener('input', e => { S.surgeFt = +e.target.value; $('surgeV').textContent = `+${S.surgeFt.toFixed(1)} ft`; update(); });
$('exag').addEventListener('input', e => { exag = +e.target.value; $('exagV').textContent = `${exag}×`; if (heights) applyExag(); });
addEventListener('resize', drawChart);
// browsers restore form state on reload; push it into the scene
for (const id of ['lFlood', 'lRain', 'lFema', 'lRoads', 'lStorm', 'lCanopy', 'basemap']) if (id !== 'basemap' || $(id).value !== 'dark') $(id).dispatchEvent(new Event('change'));
for (const id of ['surge', 'exag', 'drain']) $(id).dispatchEvent(new Event('input'));
S.i = +$('time').value;

const frame = ms => { uniforms.uTime.value = ms / 1000; controls.update(); renderer.render(scene, camera); };
renderer.setAnimationLoop(frame);
// Dashboard shell (index.html) says when this tab is hidden: stop rendering so the GPU idles.
addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'tab') renderer.setAnimationLoop(e.data.active ? frame : null); });
update();
