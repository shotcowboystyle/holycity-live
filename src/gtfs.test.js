import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { unzip, csv, build, activeServices, nextDepartures, holiday, localDay } from '../public/gtfs.js';

// a zip with one deflated and one stored entry, laid out the way zip tools write it
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, text, store] of files) {
    const raw = Buffer.from(text), body = store ? raw : deflateRawSync(raw), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    local.push(lh, n, body); central.push(ch, n); offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

test('unzip inflates only the requested entries, deflated or stored', async () => {
  const out = await unzip(zip([['a.txt', 'hello '.repeat(50)], ['b.txt', 'stored', true], ['c.txt', 'skip me']]), ['a.txt', 'b.txt']);
  assert.deepEqual(Object.keys(out).sort(), ['a.txt', 'b.txt']);
  assert.equal(out['a.txt'], 'hello '.repeat(50));
  assert.equal(out['b.txt'], 'stored');
});

test('csv handles quoted commas, doubled quotes and CRLF', () => {
  assert.deepEqual(csv('a,b\r\n1,"x, ""y"""\r\n\r\n'), [['a', 'b'], ['1', 'x, "y"']]);
});

// a tiny feed: weekday and Sunday service, Thanksgiving runs Sunday service, one trip past midnight
const feed = build({
  'routes.txt': 'route_id,route_short_name,route_long_name,route_color,route_sort_order\n20,20,King St,b7295a,1\n210,210,"DASH, free",zzz,2',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n20,WK,t1,Downtown,0,s1\n20,WK,t2,Downtown,0,s1\n20,SUN,t3,Downtown,0,s1\n20,WK,late,Downtown,0,s1',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type\nA,King / Calhoun,32.78,-79.93,\nB,End,32.79,-79.94,0',
  'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type\nt1,08:00:00,08:00:00,A,1,0\nt1,08:10:00,08:10:00,B,2,0\nt2,09:00:00,09:00:00,A,1,0\nt2,09:10:00,09:10:00,B,2,0\nt3,10:00:00,10:00:00,A,1,0\nt3,10:10:00,10:10:00,B,2,0\nlate,25:10:00,25:10:00,A,1,0\nlate,25:20:00,25:20:00,B,2,0',
  'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns1,32.79,-79.94,2\ns1,32.78,-79.93,1',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260901,20270501\nSUN,0,0,0,0,0,0,1,20260901,20270501',
  'calendar_dates.txt': 'service_id,date,holiday_name,exception_type\nWK,20261126,Thanksgiving Day,2\nSUN,20261126,Thanksgiving Day,1',
  'fare_attributes.txt': 'fare_id,price\nF,2.00', 'fare_rules.txt': 'fare_id,route_id\nF,20',
  'feed_info.txt': 'feed_version,feed_start_date,feed_end_date\nv1,20261105,20270427',
});
const at = iso => new Date(iso);
const hhmm = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

test('build: route colors are checked, shapes ordered, last stops are not departures', () => {
  assert.equal(feed.routes[0].color, '#b7295a');
  assert.equal(feed.routes[1].color, '#6b7a8f'); // "zzz" is not a color
  assert.equal(feed.routes[0].fare, 2);
  assert.deepEqual(feed.lines, [{ route: '20', pts: [[32.78, -79.93], [32.79, -79.94]] }]);
  assert.equal(feed.deps.get('B'), undefined);
  assert.deepEqual(feed.stops.map(s => s.id), ['A', 'B']);
  assert.deepEqual(feed.feed, { version: 'v1', start: '20261105', end: '20270427' });
});

test('activeServices: weekday calendar, Sunday, and a holiday swapping in Sunday service', () => {
  assert.deepEqual([...activeServices(feed, '20261110', 2)], ['WK']);
  assert.deepEqual([...activeServices(feed, '20261115', 0)], ['SUN']);
  assert.deepEqual([...activeServices(feed, '20261126', 4)], ['SUN']);
  assert.deepEqual([...activeServices(feed, '20270601', 2)], []); // past the calendar
});

test('nextDepartures: in Charleston time, past midnight, and tomorrow when tonight is done', () => {
  // Tuesday 8:30 AM EST: the 9:00 trip, then the 1:10 AM (25:10) trip, then Wednesday's 8:00
  assert.deepEqual(nextDepartures(feed, 'A', at('2026-11-10T13:30:00Z'), 3).map(d => [d.trip, hhmm(d.time)]), [['t2', '09:00'], ['late', '01:10'], ['t1', '08:00']]);
  // Wednesday 12:30 AM: Tuesday's service day still has the 25:10 trip
  assert.deepEqual(nextDepartures(feed, 'A', at('2026-11-11T05:30:00Z'), 1).map(d => [d.trip, hhmm(d.time)]), [['late', '01:10']]);
  // Thanksgiving morning: Sunday service only
  assert.deepEqual(nextDepartures(feed, 'A', at('2026-11-26T13:00:00Z'), 1).map(d => d.trip), ['t3']);
  assert.equal(holiday(feed, at('2026-11-26T13:00:00Z')), 'Thanksgiving Day');
  assert.deepEqual(nextDepartures(feed, 'nope'), []);
});

test('localDay uses Charleston time whatever the clock zone: 11 PM EST is still the same day', () => {
  assert.deepEqual(localDay(at('2026-11-11T04:00:00Z')), { ymd: '20261110', dow: 2, secs: 23 * 3600 });
  assert.equal(localDay(at('2026-11-11T04:00:00Z'), -1).ymd, '20261109');
});
