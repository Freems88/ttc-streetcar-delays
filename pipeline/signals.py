"""City of Toronto traffic signal locations, and tagging track slices as stop / signal / both.

Delay at a passenger stop is mostly boarding; delay at a signal is mostly red-light
time. Many Toronto stops sit at signals, where the two can't be told apart from
~30 s pings, so each slice gets one of: elsewhere (0), stop (1), signal (2), both (3).
Zones reach further upstream than downstream, since cars queue before a signal
and slow before a stop.
"""
import csv
import json
import math
import sys
import time
import urllib.request

from common import BIN_M, WORK_DIR, PathGeom, to_xy

SIGNALS_URL = ("https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/1a106e88-f734-4179-b3fe-d690a6187a71/"
               "resource/aeda8fd7-e1d6-4d34-b62a-a7d6be10cc96/download/traffic-signal-4326.csv")
SIGNALS_CSV = WORK_DIR / "traffic-signals.csv"
MAX_AGE_DAYS = 30

SIGNAL_OFF_TRACK_M = 25        # signal point (intersection centre) to track
SIGNAL_ZONE = (-60, 20)        # metres along the track relative to the signal: queue before, clear after
STOP_ZONE = (-40, 25)          # relative to the stop: braking before, pulling away after

ELSEWHERE, STOP, SIGNAL, BOTH = 0, 1, 2, 3


def ensure_signals():
    """Download the signal list if missing or over a month old; keep the old copy if that fails."""
    fresh = SIGNALS_CSV.exists() and time.time() - SIGNALS_CSV.stat().st_mtime < MAX_AGE_DAYS * 86400
    if fresh:
        return
    try:
        req = urllib.request.Request(SIGNALS_URL, headers={"User-Agent": "ttc-streetcar-logger/1.0"})
        data = urllib.request.urlopen(req, timeout=60).read()
        if b"MAIN_STREET" not in data[:2000]:
            raise ValueError("unexpected content")
        tmp = SIGNALS_CSV.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(SIGNALS_CSV)
        print(f"signals: downloaded {len(data) / 1e3:.0f} kB", file=sys.stderr)
    except Exception as e:
        print(f"signals: download failed ({type(e).__name__}: {e}); using existing copy", file=sys.stderr)


def _street(s):
    return "" if not s or s == "None" else s.title().strip()


def load_signals():
    if not SIGNALS_CSV.exists():
        return []
    out = []
    with open(SIGNALS_CSV, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                lon, lat = json.loads(r["geometry"])["coordinates"][0]
            except (ValueError, KeyError, IndexError, TypeError):
                continue
            main, side = _street(r["MAIN_STREET"]), _street(r["SIDE1_STREET"])
            mid = _street(r["MIDBLOCK_ROUTE"])
            name = f"{main} / {side}" if side else (f"{main}, midblock {mid}".strip(", ") if mid else main)
            out.append({"x": to_xy(lon, lat), "name": name, "tsp": r["TRANSIT_PREEMPT"] == "1",
                        "midblock": bool(mid) and not side})
    return out


def tag_pieces(pieces, signals):
    """Per piece: (tags per slice, signal index per slice or -1). Signal list order is `signals`."""
    grid = {}
    for i, s in enumerate(signals):
        grid.setdefault((int(s["x"][0] // 100), int(s["x"][1] // 100)), []).append(i)
    out = []
    for p in pieces:
        g = PathGeom(p["line"])
        nb = math.ceil(g.length / BIN_M)
        tags, sig = [ELSEWHERE] * nb, [-1] * nb
        seen = set()
        for k in range(len(g.x)):
            cx, cy = int(g.x[k] // 100), int(g.y[k] // 100)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    seen.update(grid.get((cx + dx, cy + dy), ()))
        for i in seen:
            a, d = g.project(*signals[i]["x"])
            if d > SIGNAL_OFF_TRACK_M:
                continue
            for b in _zone_bins(a, SIGNAL_ZONE, nb):
                tags[b] |= SIGNAL
                sig[b] = i
        for s in p["stops"]:
            for b in _zone_bins(s["along"], STOP_ZONE, nb):
                tags[b] |= STOP
        out.append((tags, sig))
    return out


def _zone_bins(a, zone, nb):
    lo, hi = a + zone[0], a + zone[1]
    return [b for b in range(max(0, int(lo // BIN_M)), min(nb, int(hi // BIN_M) + 1))
            if lo <= (b + 0.5) * BIN_M <= hi]
