"""Holy City Live: static server for the dashboards + /api/stofs proxy.

NOAA STOFS-2D-Global station guidance lives on S3 without CORS headers, so the
browser can't read it directly. This fetches the newest cycle's SHEF text,
extracts one station, and returns JSON.

  python3 server.py [port]        # serve
  python3 server.py --selftest    # run parser check
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BUCKET = "https://noaa-gestofs-pds.s3.amazonaws.com"
STATION = "CHTS1"  # NWS id for Charleston Harbor (NOAA 8665530)
CACHE_SECONDS = 1800
_cache = {"at": 0.0, "body": None}


def parse_shef(text, station):
    """Return (start datetime UTC, interval minutes, values) for station's .E block."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        parts = line.split()
        if len(parts) < 4 or parts[0] != ".E" or parts[1] != station:
            continue
        date, fields = parts[2], line.split("/")
        hhmm = next(f for f in fields if f.strip().startswith("DH") or " DH" in f).split("DH")[1][:4]
        interval = int(next(f for f in fields if f.startswith("DIN"))[3:])
        start = datetime.strptime(date + hhmm, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        values = [float(v) for v in line.split("/DIN")[1].split("/")[1:] if v.strip()]
        for cont in lines[i + 1:]:
            if not cont.startswith(".E") or cont.startswith(".E "):
                break
            values += [float(v) for v in cont.split(None, 1)[1].split("/") if v.strip()]
        return start, interval, values
    raise ValueError(f"station {station} not in SHEF file")


def latest_stofs():
    now = datetime.now(timezone.utc)
    for back in range(0, 48, 6):  # newest cycle first; cycles are 00/06/12/18Z and publish a few hours late
        t = now - timedelta(hours=back)
        cyc = f"{t.hour // 6 * 6:02d}"
        url = f"{BUCKET}/stofs_2d_glo.{t:%Y%m%d}/stofs_2d_glo.t{cyc}z.points.cwl.shef"
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                text = r.read().decode("ascii", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):  # cycle not published yet; try the previous one
                continue
            raise
        start, interval, values = parse_shef(text, STATION)
        return {"model": "STOFS-2D-Global", "cycle": f"{t:%Y-%m-%d} {cyc}Z", "datum": "MLLW", "units": "ft",
                "start": int(start.timestamp()), "intervalMin": interval, "values": values}
    raise RuntimeError("no STOFS cycle found in last 48 h")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always serve fresh app.js while developing
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] != "/api/stofs":
            return super().do_GET()
        try:
            if not _cache["body"] or time.time() - _cache["at"] > CACHE_SECONDS:
                _cache["body"] = json.dumps(latest_stofs()).encode()
                _cache["at"] = time.time()
            body, code = _cache["body"], 200
        except Exception as e:  # report to the page's Sources panel, keep serving
            self.log_error("stofs: %s", e)
            body, code = json.dumps({"error": str(e)}).encode(), 502
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def selftest():
    sample = """.E PSBM1 20261004 Z DH1800/DC10041800/HMIFC/DIN30/     7.59/     9.66
.E1      17.51/    18.59
.E CHTS1 20261004 Z DH1800/DC10041800/HMIFC/DIN30/     6.11/     6.34/     6.40
.E1       5.56/     5.01
.E2       4.39/
.E XXXX1 20261004 Z DH1800/DC10041800/HMIFC/DIN30/     1.00
"""
    start, interval, values = parse_shef(sample, "CHTS1")
    assert start == datetime(2026, 10, 4, 18, tzinfo=timezone.utc), start
    assert interval == 30 and values == [6.11, 6.34, 6.40, 5.56, 5.01, 4.39], values
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
