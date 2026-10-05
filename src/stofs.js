// NOAA STOFS-2D-Global station guidance for one station, as JSON.
// The S3 bucket has no CORS headers, so browsers can't read it directly; the Worker fetches and parses it.

export const BUCKET = 'https://noaa-gestofs-pds.s3.amazonaws.com';
export const STATION = 'CHTS1'; // NWS id for Charleston Harbor (NOAA 8665530)

// Parse one station's ".E" block from a SHEF file: header line plus ".E1", ".E2"… continuation lines.
// Scans with indexOf so a 1.8 MB file stays well under the Workers CPU limit.
export function parseShef(text, station) {
  const atStart = text.startsWith(`.E ${station} `), head = atStart ? 0 : text.indexOf(`\n.E ${station} `) + 1;
  if (!atStart && head === 0) throw new Error(`station ${station} not in SHEF file`);
  const lines = [];
  for (let at = head; at < text.length;) {
    const end = text.indexOf('\n', at), line = text.slice(at, end < 0 ? text.length : end);
    if (lines.length && (!line.startsWith('.E') || line.startsWith('.E '))) break; // next station or end of block
    lines.push(line);
    at = end < 0 ? text.length : end + 1;
  }
  const [first, ...rest] = lines, parts = first.split(/\s+/);
  const date = parts[2], hhmm = first.match(/DH(\d{4})/)[1], interval = +first.match(/\/DIN(\d+)/)[1];
  const start = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +hhmm.slice(0, 2), +hhmm.slice(2)) / 1000;
  const nums = s => s.split('/').map(v => v.trim()).filter(Boolean).map(Number);
  const values = [...nums(first.split(/\/DIN\d+\//)[1]), ...rest.flatMap(l => nums(l.replace(/^\.E\d+\s+/, '')))];
  return { start, intervalMin: interval, values };
}

// Newest published cycle (00/06/12/18Z; they post a few hours late), walking back up to 48 h.
export async function latestStofs(now = new Date()) {
  for (let back = 0; back < 48; back += 6) {
    const t = new Date(now.getTime() - back * 3600e3), cyc = String(Math.floor(t.getUTCHours() / 6) * 6).padStart(2, '0');
    const ymd = t.toISOString().slice(0, 10).replaceAll('-', '');
    const r = await fetch(`${BUCKET}/stofs_2d_glo.${ymd}/stofs_2d_glo.t${cyc}z.points.cwl.shef`);
    if (r.status === 403 || r.status === 404) continue; // cycle not published yet; try the previous one
    if (!r.ok) throw new Error(`STOFS fetch ${r.status}`);
    return { model: 'STOFS-2D-Global', cycle: `${t.toISOString().slice(0, 10)} ${cyc}Z`, datum: 'MLLW', units: 'ft', ...parseShef(await r.text(), STATION) };
  }
  throw new Error('no STOFS cycle found in last 48 h');
}
