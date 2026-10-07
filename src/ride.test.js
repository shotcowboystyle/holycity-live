import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourLevel, verdict, spotAdvice, RAIN_WET_KM2, RAIN_FLOOD_KM2 } from '../public/ride.js';

const thr = { minor: 7 };
const when = t => `${t} pm`;
const hours = levels => levels.map((l, t) => ({ t, level: l, causes: l ? ['tide'] : [] }));

test('hourLevel: tide at NWS minor stage floods, rain area sets wet spots', () => {
  assert.deepEqual(hourLevel({ waterFt: 6.9, thr, rainKm2: 0 }), { level: 0, causes: [] });
  assert.deepEqual(hourLevel({ waterFt: 7, thr, rainKm2: 0 }), { level: 2, causes: ['tide'] });
  assert.deepEqual(hourLevel({ waterFt: 5, thr, rainKm2: RAIN_WET_KM2 }), { level: 1, causes: ['rain'] });
  assert.deepEqual(hourLevel({ waterFt: 7.2, thr, rainKm2: RAIN_FLOOD_KM2 }), { level: 2, causes: ['tide', 'rain'] });
  assert.equal(hourLevel({ waterFt: 6.5, thr: { minor: 7, wet: 6.4 }, rainKm2: 0 }).level, 1);
  assert.equal(hourLevel({ waterFt: null, thr: null, rainKm2: null }).level, 0); // data still loading
});

test('verdict: flooding now, later, never', () => {
  assert.deepEqual(verdict(hours([2, 2, 0]), hours([2])[0], when), { headline: 'Now: low streets are flooding', detail: 'Should ease around 2 pm.' });
  assert.equal(verdict(hours([0, 0, 2, 2, 2, 0]), { t: 3, level: 2 }, when).headline, '3 pm: low streets are flooding');
  assert.equal(verdict(hours([0, 0, 2, 2, 2, 0]), hours([0])[0], when).detail,
    'Flooding likely from 2 pm, for about 3 hours (high tide). Plan around it.');
  assert.equal(verdict([{ t: 0, level: 0, causes: [] }, { t: 1, level: 1, causes: ['rain'] }], { t: 0, level: 0 }, when).detail,
    'Some wet spots around 1 pm (rain).');
  assert.equal(verdict(hours([0, 0]), { t: 0, level: 0 }, when).detail, 'No flooding expected in the next two days.');
  assert.equal(verdict(hours([2, 2]), { t: 0, level: 2 }, when).detail, 'No letup expected in the next two days.');
});

test('spotAdvice: plain depth and what to do', () => {
  assert.equal(spotAdvice(0), 'dry.');
  assert.equal(spotAdvice(1), 'a little standing water. Go slow.');
  assert.equal(spotAdvice(8.4), 'about 8 in of water. Find another way.');
  assert.equal(spotAdvice(18), 'about 1.5 ft of water. Find another way.');
});
