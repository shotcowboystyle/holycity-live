// Minimal GTFS-realtime reader for CARTA's Swiftly feeds: decodes the protobuf and keeps only the fields the Transit tab
// draws (Swiftly's license allows showing the data, not passing the raw feed on). Field numbers from gtfs-realtime.proto.
// ponytail: hand-rolled protobuf reader for three message types; swap in a protobuf library if more of the spec is needed.

// → [value, next offset]. Up to 4 bytes stays in plain numbers; longer ones (timestamps, negative int32 delays) go through
// BigInt so the sign and every digit survive.
function varint(buf, p) {
  let v = 0, s = 0, b;
  do { b = buf[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && s < 28);
  if (!(b & 0x80)) return [v >>> 0, p];
  let big = BigInt(v >>> 0), bs = 28n;
  do { b = buf[p++]; big |= BigInt(b & 0x7f) << bs; bs += 7n; } while (b & 0x80);
  return [Number(BigInt.asIntN(64, big)), p];
}

// every [field number, value] of one message: varints as numbers, length-delimited as byte views, fixed32 as float
function* fields(buf) {
  let p = 0, tag, v;
  while (p < buf.length) {
    [tag, p] = varint(buf, p);
    const f = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) { [v, p] = varint(buf, p); yield [f, v]; }
    else if (wire === 2) { [v, p] = varint(buf, p); yield [f, buf.subarray(p, p + v)]; p += v; }
    else if (wire === 5) { yield [f, new DataView(buf.buffer, buf.byteOffset + p, 4).getFloat32(0, true)]; p += 4; }
    else if (wire === 1) p += 8; // fixed64 / double: none of the fields read here
    else throw new Error(`protobuf wire type ${wire}`);
  }
}
const text = b => new TextDecoder().decode(b);
const read = (buf, names) => { // {name: value} for the listed field numbers; `[]` in a name collects repeats
  const o = {};
  for (const [f, v] of fields(buf)) {
    const n = names[f]; if (!n) continue;
    if (n.endsWith('[]')) (o[n.slice(0, -2)] ??= []).push(v); else o[n] = v;
  }
  return o;
};
const entities = buf => (read(buf, { 2: 'entity[]' }).entity ?? []).map(e => read(e, { 3: 'tripUpdate', 4: 'vehicle', 5: 'alert' }));
const trip = b => { const t = b ? read(b, { 1: 'id', 5: 'route' }) : {}; return { trip: t.id ? text(t.id) : null, route: t.route ? text(t.route) : null }; };
const translated = b => { // first translation of a TranslatedString
  const t = b && read(b, { 1: 'tr[]' }).tr?.[0];
  return t ? text(read(t, { 1: 'text' }).text ?? new Uint8Array()) : '';
};

export function vehicles(buf) {
  return entities(buf).filter(e => e.vehicle).map(e => {
    const v = read(e.vehicle, { 1: 'trip', 2: 'pos', 5: 'ts', 8: 'desc' });
    const pos = v.pos ? read(v.pos, { 1: 'lat', 2: 'lon', 3: 'bearing' }) : {}, d = v.desc ? read(v.desc, { 1: 'id', 2: 'label' }) : {};
    return { id: d.id ? text(d.id) : null, label: d.label ? text(d.label) : null, ...trip(v.trip),
      lat: pos.lat ?? null, lon: pos.lon ?? null, bearing: pos.bearing ?? null, ts: v.ts ?? null };
  }).filter(v => v.lat != null && v.lon != null);
}

// Predicted times at one stop. time: epoch seconds; delay: seconds late (when the feed gives only that); skipped: the bus
// won't stop. ponytail: only stops the feed lists by stop_id; delays propagated from an earlier stop are not inferred.
export function arrivals(buf, stopId) {
  const out = [];
  for (const e of entities(buf)) {
    if (!e.tripUpdate) continue;
    const u = read(e.tripUpdate, { 1: 'trip', 2: 'stu[]' });
    for (const s of u.stu ?? []) {
      const st = read(s, { 2: 'arr', 3: 'dep', 4: 'stop', 5: 'rel' });
      if (!st.stop || text(st.stop) !== stopId) continue;
      const ev = read(st.dep ?? st.arr ?? new Uint8Array(), { 1: 'delay', 2: 'time' });
      out.push({ ...trip(u.trip), time: ev.time ?? null, delay: ev.delay ?? null, skipped: st.rel === 1 });
    }
  }
  return out;
}

export function alerts(buf) {
  return entities(buf).filter(e => e.alert).map(e => {
    const a = read(e.alert, { 1: 'period[]', 5: 'entity[]', 8: 'url', 10: 'header', 11: 'description' });
    const periods = (a.period ?? []).map(p => read(p, { 1: 'start', 2: 'end' })).map(p => [p.start ?? null, p.end ?? null]);
    const sel = (a.entity ?? []).map(s => read(s, { 2: 'route', 4: 'stop' }));
    return { header: translated(a.header), description: translated(a.description), url: translated(a.url),
      routes: [...new Set(sel.filter(s => s.route).map(s => text(s.route)))], stops: [...new Set(sel.filter(s => s.stop).map(s => text(s.stop)))], periods };
  });
}
