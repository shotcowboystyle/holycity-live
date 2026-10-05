// Shared helpers for the 2D dashboards. Leaflet (global L) is loaded by each page before this module.
export const CITY = 'https://gis.charleston-sc.gov/arcgis2/rest/services/External';
export const CITY_V1 = 'https://gis.charleston-sc.gov/arcgis/rest/services/External';
export const PENINSULA = [32.7953, -79.9427]; // center of ZIPs 29401 + 29403
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = v => v == null ? '—' : '$' + Math.round(v).toLocaleString();
export const day = ms => ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const miles = m => `${(m / 1609.34).toFixed(2)} mi`;
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const lightTheme = () => matchMedia('(prefers-color-scheme: light)').matches;
// Phone layout: the map sits in a scrolling page, so one finger scrolls and two fingers move the map.
export const phoneLayout = () => matchMedia('(max-width: 760px) and (pointer: coarse)').matches;

// Shareable state lives in the shell's query string (?at=…&r=…), so a copied link restores it.
const topWin = () => {
  try { top.location.href; return top; } catch { return window; } // embedded cross-origin: keep state in this frame's URL
};
export const param = k => new URL(topWin().location.href).searchParams.get(k);
export function setParam(k, v) {
  const w = topWin(), u = new URL(w.location.href);
  if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v);
  if (u.href !== w.location.href) w.history.replaceState(w.history.state, '', u);
}

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message ?? 'ArcGIS error');
  return d;
}
export const query = (layer, params) => getJSON(`${layer}/query?${new URLSearchParams({ f: 'json', ...params })}`);
// GeoJSON features, all pages fetched in parallel (ArcGIS caps each response at the layer's maxRecordCount)
export async function queryAll(layer, params, page) {
  const { count } = await query(layer, { ...params, returnCountOnly: true });
  const pages = await Promise.all(Array.from({ length: Math.ceil(count / page) }, (_, k) =>
    query(layer, { outSR: 4326, orderByFields: 'OBJECTID', ...params, resultOffset: k * page, resultRecordCount: page, f: 'geojson' })));
  return pages.flatMap(p => p.features);
}
export const near = (lat, lon, meters) => ({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, distance: meters, units: 'esriSRUnit_Meter' });
export function metersBetween(a, b) { // haversine, [lat, lon]
  const R = 6371000, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function makeMap(el, center = PENINSULA, zoom = 14) {
  const phone = phoneLayout();
  const map = L.map(el, { preferCanvas: true, dragging: !phone }).setView(center, zoom); // pinch still pans and zooms
  if (phone) { const hint = L.control({ position: 'topright' }); hint.onAdd = () => L.DomUtil.create('div', 'map-hint'); hint.addTo(map).getContainer().textContent = 'Use two fingers to move the map'; }
  const esri = 'https://services.arcgisonline.com/arcgis/rest/services/Canvas', tone = lightTheme() ? 'Light' : 'Dark';
  const attribution = 'Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors · Data: City of Charleston';
  L.tileLayer(`${esri}/World_${tone}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, attribution }).addTo(map);
  map.createPane('labels').style.zIndex = 650; map.getPane('labels').style.pointerEvents = 'none';
  L.tileLayer(`${esri}/World_${tone}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, pane: 'labels' }).addTo(map);
  return map;
}

// Address search shared by every tab: the picked place is stored in localStorage, and the other tabs
// (same-origin iframes) hear the `storage` event and follow along. A searched place also goes in the URL (?at=lat,lon&place=label).
const KEY = 'chs-location';
const LOCATOR = `${CITY_V1}/City_Address_Locator/GeocodeServer`;
export function addressBox(el, onPick) {
  el.innerHTML = `<div class="row"><input type="search" placeholder="Address in Charleston, e.g. 80 Broad St" list="${el.id}-dl" aria-label="Address">
    <button type="button" data-act="go">Go</button><button type="button" data-act="me" title="Use my location">◎</button></div>
    <datalist id="${el.id}-dl"></datalist><div class="sub" data-msg></div>`;
  const input = el.querySelector('input'), dl = el.querySelector('datalist'), msg = el.querySelector('[data-msg]');
  let timer, keys = {};
  const pick = (place, store = true) => {
    msg.textContent = place.label; input.value = '';
    if (store) {
      try { localStorage.setItem(KEY, JSON.stringify(place)); } catch { /* storage blocked: tabs just won't sync */ }
      setParam('at', `${place.lat.toFixed(5)},${place.lon.toFixed(5)}`); setParam('place', place.label);
    }
    onPick(place);
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (input.value.length < 3) return;
    timer = setTimeout(() => getJSON(`${LOCATOR}/suggest?${new URLSearchParams({ text: input.value, maxSuggestions: 6, f: 'json' })}`)
      .then(d => { keys = Object.fromEntries(d.suggestions.map(s => [s.text, s.magicKey])); dl.innerHTML = d.suggestions.map(s => `<option value="${esc(s.text)}">`).join(''); },
        e => { msg.textContent = 'Suggestions unavailable right now.'; msg.title = e.message; }), 250);
  });
  const find = () => {
    const text = input.value.trim(); if (!text) return;
    msg.textContent = 'Searching…';
    getJSON(`${LOCATOR}/findAddressCandidates?${new URLSearchParams({ SingleLine: text, ...(keys[text] ? { magicKey: keys[text] } : {}), outSR: 4326, maxLocations: 1, f: 'json' })}`)
      .then(d => {
        const c = d.candidates[0];
        if (!c) { msg.textContent = 'No City of Charleston address matched.'; return; }
        pick({ label: c.address, lat: c.location.y, lon: c.location.x });
      }, e => { msg.textContent = "Address search didn't respond. Try again."; msg.title = e.message; });
  };
  el.querySelector('[data-act=go]').onclick = find;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') find(); });
  el.querySelector('[data-act=me]').onclick = () => {
    if (!navigator.geolocation) { msg.textContent = 'Location not available in this browser.'; return; }
    msg.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(p => pick({ label: 'My location', lat: p.coords.latitude, lon: p.coords.longitude }),
      e => { msg.textContent = 'Location unavailable: ' + e.message; });
  };
  addEventListener('storage', e => { if (e.key === KEY && e.newValue) pick(JSON.parse(e.newValue), false); });
  const [lat, lon] = (param('at') ?? '').split(',').map(Number); // a shared link wins over this browser's last search
  if (Number.isFinite(lat) && Number.isFinite(lon) && param('at')) pick({ label: param('place') || 'Shared location', lat, lon });
  else try { const saved = localStorage.getItem(KEY); if (saved) pick(JSON.parse(saved), false); } catch { /* storage blocked: start empty */ }
  return { pick };
}

// Plain-language failure with a retry button; the technical detail stays in the tooltip
export function failed(el, what, e, retry) {
  el.innerHTML = `<span class="bad" title="${esc(e.message)}">${esc(what)} didn't respond.</span> <button type="button">Retry</button>`;
  el.querySelector('button').onclick = retry;
}

// Horizontal bar list: rows = [[label, value, color?]]
export function bars(el, rows, fmtV = v => v.toLocaleString()) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  el.innerHTML = rows.length ? `<div class="bars">${rows.map(([l, v, c]) =>
    `<span class="lbl" title="${esc(l)}">${esc(l)}</span><span><div class="bar" style="width:${(v / max * 100).toFixed(1)}%;${c ? `background:${c}` : ''}"></div></span><span class="val">${fmtV(v)}</span>`).join('')}</div>`
    : '<div class="sub">None.</div>';
}
// Column chart (SVG) for a time series: rows = [[label, value]]; labels shown every `every` columns
export function columns(el, rows, { every = 3, color = 'var(--accent)', highlightLast = false } = {}) {
  // viewBox matches the drawn width so labels aren't stretched. ponytail: no redraw on resize, next data refresh fixes it
  const W = el.clientWidth || 340, H = 130, pad = 18, max = Math.max(1, ...rows.map(r => r[1])), bw = (W - 4) / rows.length;
  const peak = rows.find(r => r[1] === max), label = rows.length ? `${rows[0][0]} to ${rows.at(-1)[0]}, peak ${max.toLocaleString()}${peak ? ` in ${peak[0]}` : ''}` : 'No data';
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${rows.map(([l, v], i) => {
    const h = v / max * (H - pad - 12), x = 2 + i * bw;
    return `<rect x="${x + 1}" y="${H - pad - h}" width="${bw - 2}" height="${h}" rx="1.5" fill="${color}" opacity="${highlightLast && i === rows.length - 1 ? 0.45 : 0.9}"><title>${esc(l)}: ${v.toLocaleString()}</title></rect>`
      + (i % every === 0 ? `<text x="${x}" y="${H - 5}">${esc(l)}</text>` : '');
  }).join('')}<text x="2" y="9">${max.toLocaleString()}</text></svg>`;
}
