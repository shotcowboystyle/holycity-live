// CARTA bus schedule (GTFS) for the Transit tab, run in a Web Worker (transit.html `ask`) so the page never stalls:
// fetch the feed zip, unzip only the files used, and answer "next buses at these stops" from a departure index kept here.
// The pure functions are exported for src/gtfs.test.js.
export const TZ = 'America/New_York';
const FILES = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt', 'calendar.txt', 'calendar_dates.txt',
  'fare_attributes.txt', 'fare_rules.txt', 'feed_info.txt'];

// Zip reader: walks the central directory and inflates only the named entries with the browser's own DecompressionStream.
// ponytail: no zip64 or encryption; the CARTA feed is a plain 2 MB zip.
export async function unzip(buf, names) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), utf8 = new TextDecoder();
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--; // end-of-central-directory record
  if (e < 0) throw new Error('GTFS feed is not a zip file');
  const out = {};
  let p = dv.getUint32(e + 16, true);
  for (let k = dv.getUint16(e + 10, true); k > 0; k--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), n = dv.getUint16(p + 28, true);
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + n)), local = dv.getUint32(p + 42, true);
    p += 46 + n + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    if (!names.includes(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true), data = u8.subarray(start, start + size);
    if (method === 0) out[name] = utf8.decode(data);
    else if (method === 8) out[name] = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    else throw new Error(`zip compression method ${method}`);
  }
  return out;
}

// GTFS CSV → rows of strings. ponytail: no newlines inside quoted fields; none in this feed.
export function csv(text = '') {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (!line.includes('"')) { rows.push(line.split(',')); continue; }
    const row = []; let f = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c !== '"') f += c; else if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else f += c;
    }
    row.push(f); rows.push(row);
  }
  return rows;
}
const table = text => { // {rows, c: column index by name}; a missing file is an empty table
  const [head = [], ...rows] = csv(text);
  return { rows, c: Object.fromEntries(head.map((k, i) => [k.trim(), i])) };
};
const hms = t => { const [h, m, s] = t.split(':'); return h * 3600 + m * 60 + +s; }; // "25:10:00" → 90600: GTFS runs past midnight
const hex = v => /^[0-9a-f]{6}$/i.test(v ?? '') ? `#${v}` : null;

// The slim model: routes, one line per route and direction, stops, plus the departure index and calendars kept in the worker.
export function build(f) {
  const R = table(f['routes.txt']), T = table(f['trips.txt']), S = table(f['stops.txt']), ST = table(f['stop_times.txt']);
  const SH = table(f['shapes.txt']), C = table(f['calendar.txt']), CD = table(f['calendar_dates.txt']);
  const FA = table(f['fare_attributes.txt']), FR = table(f['fare_rules.txt']), FI = table(f['feed_info.txt']);

  const price = Object.fromEntries(FA.rows.map(r => [r[FA.c.fare_id], +r[FA.c.price]]));
  const fare = Object.fromEntries(FR.rows.map(r => [r[FR.c.route_id], price[r[FR.c.fare_id]]]));
  const routes = R.rows.map(r => ({ id: r[R.c.route_id], short: r[R.c.route_short_name] ?? '', name: r[R.c.route_long_name] ?? '',
    desc: r[R.c.route_desc] ?? '', url: r[R.c.route_url] ?? '', color: hex(r[R.c.route_color]) ?? '#6b7a8f', sort: +(r[R.c.route_sort_order] || 0),
    fare: fare[r[R.c.route_id]] ?? null })).sort((a, b) => a.sort - b.sort);

  const trips = T.rows.map(r => ({ id: r[T.c.trip_id], route: r[T.c.route_id], service: r[T.c.service_id], headsign: r[T.c.trip_headsign] ?? '',
    dir: r[T.c.direction_id] ?? '', shape: r[T.c.shape_id] ?? '' }));
  const tripIx = new Map(trips.map((t, i) => [t.id, i]));

  // the shape most trips use, per route and direction, stands for that route on the map
  const use = new Map();
  for (const t of trips) { const k = `${t.route}|${t.dir}`, m = use.get(k) ?? new Map(); m.set(t.shape, (m.get(t.shape) ?? 0) + 1); use.set(k, m); }
  const wanted = new Map([...use].map(([k, m]) => [[...m].sort((a, b) => b[1] - a[1])[0][0], k.split('|')[0]]));
  const pts = new Map();
  for (const r of SH.rows) {
    const id = r[SH.c.shape_id]; if (!wanted.has(id)) continue;
    (pts.get(id) ?? pts.set(id, []).get(id)).push([+r[SH.c.shape_pt_sequence], +r[SH.c.shape_pt_lat], +r[SH.c.shape_pt_lon]]);
  }
  const lines = [...pts].map(([id, p]) => ({ route: wanted.get(id), pts: p.sort((a, b) => a[0] - b[0]).map(([, lat, lon]) => [lat, lon]) }));

  // departures per stop: [seconds after the service day's midnight, trip index], skipping no-pickup stops and each trip's last stop
  const last = new Map();
  for (const r of ST.rows) { const seq = +r[ST.c.stop_sequence], t = r[ST.c.trip_id]; if (!(last.get(t) >= seq)) last.set(t, seq); }
  const deps = new Map(), served = new Map();
  for (const r of ST.rows) {
    const ti = tripIx.get(r[ST.c.trip_id]), stop = r[ST.c.stop_id], time = r[ST.c.departure_time] || r[ST.c.arrival_time];
    if (ti === undefined) continue;
    (served.get(stop) ?? served.set(stop, new Set()).get(stop)).add(trips[ti].route);
    if (!time || r[ST.c.pickup_type] === '1' || last.get(trips[ti].id) === +r[ST.c.stop_sequence]) continue;
    (deps.get(stop) ?? deps.set(stop, []).get(stop)).push([hms(time), ti]);
  }
  for (const d of deps.values()) d.sort((a, b) => a[0] - b[0]);

  const stops = S.rows.filter(r => !+(r[S.c.location_type] || 0) && served.has(r[S.c.stop_id])).map(r => ({ id: r[S.c.stop_id],
    code: r[S.c.stop_code] ?? '', name: r[S.c.stop_name], lat: +r[S.c.stop_lat], lon: +r[S.c.stop_lon], routes: [...served.get(r[S.c.stop_id])] }));

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']; // JS getDay() order
  const calendar = C.rows.map(r => ({ service: r[C.c.service_id], days: DAYS.map(d => r[C.c[d]] === '1'), start: r[C.c.start_date], end: r[C.c.end_date] }));
  const dates = CD.rows.map(r => ({ service: r[CD.c.service_id], date: r[CD.c.date], type: r[CD.c.exception_type], holiday: r[CD.c.holiday_name] ?? '' }));
  const fi = FI.rows[0] ?? [];
  const feed = { version: fi[FI.c.feed_version] ?? '', start: fi[FI.c.feed_start_date] ?? '', end: fi[FI.c.feed_end_date] ?? '' };
  return { routes, lines, stops, trips, deps, calendar, dates, feed };
}

// Charleston's calendar day and clock for an instant, `d` days later (d = -1: yesterday), whatever the device's time zone
export function localDay(now, d = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + d));
  return { ymd: day.toISOString().slice(0, 10).replaceAll('-', ''), dow: day.getUTCDay(), secs: p.hour * 3600 + p.minute * 60 + +p.second };
}

export function activeServices(model, ymd, dow) {
  const on = new Set(model.calendar.filter(c => c.start <= ymd && ymd <= c.end && c.days[dow]).map(c => c.service));
  for (const x of model.dates) if (x.date === ymd) { if (x.type === '1') on.add(x.service); else on.delete(x.service); }
  return on;
}

// Next n departures at a stop: {trip, route, headsign, time (epoch ms), sched}. Yesterday's service days cover trips running
// past midnight (times over 24:00); tomorrow's give the first buses when nothing else runs tonight. Includes the last minute.
export function nextDepartures(model, stopId, now = new Date(), n = 6) {
  const list = model.deps.get(stopId); if (!list) return [];
  const t = localDay(now), out = [];
  for (const d of [-1, 0, 1]) {
    const day = localDay(now, d), on = activeServices(model, day.ymd, day.dow);
    for (const [secs, ti] of list) {
      const wait = secs + d * 86400 - t.secs, trip = model.trips[ti];
      if (wait >= -60 && on.has(trip.service)) out.push({ trip: trip.id, route: trip.route, headsign: trip.headsign, time: now.getTime() + wait * 1000 });
    }
  }
  return out.sort((a, b) => a.time - b.time).slice(0, n);
}

export function holiday(model, now = new Date()) { // today's holiday names from calendar_dates, e.g. "Christmas Eve"
  const { ymd } = localDay(now);
  return [...new Set(model.dates.filter(x => x.date === ymd && x.holiday).map(x => x.holiday))].join('; ');
}

let model;
const TASKS = {
  async load({ url }) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} CARTA schedule`);
    model = build(await unzip(await r.arrayBuffer(), FILES));
    const { routes, lines, stops, feed } = model;
    return { routes, lines, stops, feed, holiday: holiday(model) };
  },
  next: ({ stops, n }) => Object.fromEntries(stops.map(id => [id, nextDepartures(model, id, new Date(), n)])),
};
// message {id, task, ...args} → {id, result} or {id, error}
if (typeof WorkerGlobalScope !== 'undefined') onmessage = async ({ data: { id, task, ...args } }) => {
  try { postMessage({ id, result: await TASKS[task](args) }); }
  catch (e) { postMessage({ id, error: String(e.message ?? e) }); } // reported back to the page, which shows it in the card
};
