// Plain-language "can I ride?" logic for the flood tab. Pure functions, no DOM, so node --test can run them.

// ponytail: rain thresholds are rain-model area (km² of ≥ 2 in ponding, whole map). Measured 2026-10-07 at default
// drainage (1 in/h) and concentration (4×): undrained excess 0.05 in → 2 km², 0.25 in → 14 km², 1 in → 41 km².
// Wet spots = the first ponds; flooding = rain outrunning the drains by about a quarter inch. Recalibrate against
// City flood closures when another rain event is on record.
export const RAIN_WET_KM2 = 1, RAIN_FLOOD_KM2 = 14;
const CAUSE = { tide: 'high tide', rain: 'rain' };

// One hour → 0 dry, 1 some wet spots, 2 low streets flooding. thr.minor = NWS minor flood stage (ft, same datum as
// waterFt); thr.wet is an optional lower "wet spots" stage (Charleston has none below NWS minor).
export function hourLevel({ waterFt, thr, rainKm2 }) {
  const tide = waterFt == null || !thr ? 0 : waterFt >= thr.minor ? 2 : thr.wet != null && waterFt >= thr.wet ? 1 : 0;
  const rain = rainKm2 == null ? 0 : rainKm2 >= RAIN_FLOOD_KM2 ? 2 : rainKm2 >= RAIN_WET_KM2 ? 1 : 0;
  const level = Math.max(tide, rain);
  const causes = level ? [tide === level && 'tide', rain === level && 'rain'].filter(Boolean) : [];
  return { level, causes };
}

const STATE = ['streets are dry', 'some low spots may be wet', 'low streets are flooding'];
const causeText = causes => [...new Set(causes)].map(c => CAUSE[c]).join(' and ');
const forHours = n => n <= 1 ? 'for about an hour' : `for about ${n} hours`;

// hours[0] is now; each { t, level, causes }. sel is the picked hour (may be outside hours). when(t) → "4 pm today".
export function verdict(hours, sel, when) {
  const headline = `${sel.t === hours[0]?.t ? 'Now' : when(sel.t)}: ${STATE[sel.level]}`;
  if (!hours.length) return { headline, detail: '' };
  if (hours[0].level === 2) {
    const k = hours.findIndex(h => h.level < 2);
    return { headline, detail: k < 0 ? 'No letup expected in the next two days.' : `Should ease around ${when(hours[k].t)}.` };
  }
  for (const lvl of [2, 1]) {
    const a = hours.findIndex(h => h.level >= lvl); if (a < 0) continue;
    let b = a; const causes = [];
    while (b < hours.length && hours[b].level >= lvl) causes.push(...hours[b++].causes);
    return { headline, detail: lvl === 2
      ? `Flooding likely from ${when(hours[a].t)}, ${forHours(b - a)} (${causeText(causes)}). Plan around it.`
      : `Some wet spots around ${when(hours[a].t)} (${causeText(causes)}).` };
  }
  return { headline, detail: 'No flooding expected in the next two days.' };
}

// Water depth at one spot, inches → what a rider should do
export function spotAdvice(depthIn) {
  if (depthIn >= 2) return `about ${depthIn >= 12 ? `${(depthIn / 12).toFixed(1)} ft` : `${Math.round(depthIn)} in`} of water. Find another way.`;
  if (depthIn > 0) return 'a little standing water. Go slow.';
  return 'dry.';
}
