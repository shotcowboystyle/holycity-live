// Plain-language helpers for the dashboards. Pure functions, no DOM, so node --test can run them.

// "down 12%", "up 8%", "about the same" (within 3%); null when there's nothing to compare against
export function changeWords(now, prev) {
  if (!prev) return null;
  const pct = Math.round((now - prev) / prev * 100);
  return Math.abs(pct) < 3 ? 'about the same' : `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%`;
}

// Where x falls among the other values, in fifths: 0 = lowest fifth … 4 = highest fifth
export function fifth(x, values) {
  if (!values.length) return 2;
  return Math.min(4, Math.floor(values.filter(v => v < x).length / values.length * 5));
}
export const FIFTHS = ['among the lowest in the city', 'lower than most neighborhoods', 'about typical for the city',
  'higher than most neighborhoods', 'among the highest in the city'];

// City data is often ALL CAPS: "176 CONCORD ST" → "176 Concord St"
export const titleCase = s => String(s ?? '').trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

// Days from `from` until the next weekday named dayName ("MONDAY", " tuesday"), today counting as 0; null if unknown
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
export function daysUntil(dayName, from = new Date()) {
  const want = DAYS.indexOf(String(dayName ?? '').trim().toUpperCase());
  return want < 0 ? null : (want - from.getDay() + 7) % 7;
}
// "today", "tomorrow", or the weekday ("Monday") for a date n days out
export const dayWord = (n, date) => n === 0 ? 'today' : n === 1 ? 'tomorrow' : date.toLocaleDateString('en-US', { weekday: 'long' });
