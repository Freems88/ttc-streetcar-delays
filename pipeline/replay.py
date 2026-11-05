"""Replay file: every streetcar's day as a path with times, for the animated replay page.

Positions are snapped to the track where they match it (the same matching as the delay
measure), and between two positions on the same piece of track the path follows the rails,
so cars glide round curves instead of cutting corners between 30-second pings. Positions
off known track (yards, loops) are kept as reported.

Output (site/data/replay.json): {"day", "start" (epoch of 04:00), "cars": [{"v": vehicle,
"r": route, "p": [lon, lat, t, dlon, dlat, dt, ...], "g": [g, dg, ...]}]}. lon/lat are in
1e-5 degrees and t in seconds from 04:00; after the first point each triple is a difference
from the one before, which keeps the file small. A car gets a new entry for each trip (and
when it vanishes from the feed for over BREAK_S), so an entry is one trip.

"st" lists the day's short turns (shortturns.py), for the replay's "!" markers.

"g" is the ghost clock for the replay's race: seconds a clean run (the delay map's
baseline, stops included) would take to get from the entry's first point to each point,
along the same track. Off known track, the ghost moves at GHOST_OFF_MS.
"""
import csv
import gzip
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import headways
from common import BIN_M, DATA_DIR, FLEXITY_IDS, NIGHT_TWIN, WORK_DIR, to_lonlat, to_xy
from process_day import Matcher, split_passes

BREAK_S = 300       # silent this long: the car left the feed, so don't draw a line across the gap
SIMPLIFY_M = 1.5    # track vertices kept when following the rails between two positions
STILL_M = 2         # closer than this to the last point: standing still
GHOST_OFF_MS = 4.0  # m/s: the ghost's pace off known track or where the clean run isn't known


def simplify(xs, ys, tol):
    """Indexes of the vertices Douglas-Peucker keeps."""
    keep = {0, len(xs) - 1}
    stack = [(0, len(xs) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dx, dy = xs[j] - xs[i], ys[j] - ys[i]
        norm = math.hypot(dx, dy) or 1e-9
        best, k = -1.0, None
        for m in range(i + 1, j):
            d = abs(dy * (xs[m] - xs[i]) - dx * (ys[m] - ys[i])) / norm
            if d > best:
                best, k = d, m
        if best > tol:
            keep.add(k)
            stack += [(i, k), (k, j)]
    return sorted(keep)


def clean_secs(clean, a1, a2):
    """Seconds a clean run takes from a1 to a2 metres along a piece (clean: s per slice)."""
    s, a = 0.0, a1
    while a < a2:
        b = int(a // BIN_M)
        end = min(a2, (b + 1) * BIN_M)
        c = clean[b] if clean and b < len(clean) else None
        s += (end - a) * (c / BIN_M if c else 1 / GHOST_OFF_MS)
        a = end
    return s


def track_points(m, keep, pi, seq):
    """[(t, x, y, piece, along)] along piece pi for one pass, following the rails between positions."""
    g, along = m.geoms[pi], keep[pi]
    out = []
    for i, (t1, a1) in enumerate(seq):
        out.append((t1, *g.point_at(a1), pi, a1))
        if i + 1 == len(seq):
            break
        t2, a2 = seq[i + 1]
        if a2 - a1 < 5:
            continue
        lo = next((i for i, a in enumerate(along) if a > a1), len(along))
        for a in along[lo:]:
            if a >= a2:
                break
            out.append((t1 + (t2 - t1) * (a - a1) / (a2 - a1), *g.point_at(a), pi, a))
    return out


def build(day, network=None, clean=None):
    """clean: {piece id: [clean-run seconds per slice]} (stats-recent.json); without it the
    ghost runs at GHOST_OFF_MS everywhere."""
    src = DATA_DIR / f"{day}.csv"
    opener = open
    if not src.exists():
        src, opener = DATA_DIR / f"{day}.csv.gz", gzip.open
    network = network or json.loads((WORK_DIR / "network.json").read_text())
    m = Matcher(network)
    keep = []
    for g in m.geoms:
        idx = simplify(g.x, g.y, SIMPLIFY_M)
        keep.append([g.along[i] for i in idx])
    clean_of = [(clean or {}).get(p["id"]) for p in m.pieces]

    pings = defaultdict(dict)  # vehicle -> {vehicle_ts: ((t, x, y, bearing), route, trip)}
    with opener(src, "rt", newline="") as f:
        for r in csv.DictReader(f):
            vid = r["vehicle_id"]
            if not (vid.isdigit() and int(vid) in FLEXITY_IDS):
                continue
            vts = int(r["vehicle_ts"] or r["fetch_ts"])
            x, y = to_xy(float(r["lon"]), float(r["lat"]))
            brg = float(r["bearing"]) if r["bearing"] else None
            pings[vid][vts] = ((vts, x, y, brg), NIGHT_TWIN.get(r["route_id"], r["route_id"]), r["trip_id"])

    start, end = headways.day_bounds(day)
    cars = []
    for vid, by_ts in sorted(pings.items()):
        rows = [by_ts[t] for t in sorted(by_ts) if start <= t < end]
        if len(rows) < 2:
            continue
        seq = [p for p, _, _ in rows]
        trip_at = {p[0]: (r, trip) for p, r, trip in rows}
        opts = [m.candidates(*p[1:]) for p in seq]
        passes, _ = split_passes(seq, opts)
        m.stitch(passes)
        pts = []  # (t, x, y, piece or None, along or None)
        on_track = set()
        for pi, s in passes:
            pts += track_points(m, keep, pi, s)
            on_track.update(t for t, _ in s)
        pts += [(p[0], p[1], p[2], None, None) for p, o in zip(seq, opts) if not o and p[0] not in on_track]
        pts.sort(key=lambda v: v[0])

        cur, last_key, last_t = None, None, None
        for pt in pts:
            t, x, y = pt[:3]
            # A stitched join point has no ping of its own: it keeps the trip of the ping before it.
            key = trip_at.get(t, last_key)
            if cur is None or key != last_key or t - last_t > BREAK_S:
                # A new trip starts where the last one ended, so the trail has no gap.
                seed = cur["pts"][-1:] if cur is not None and t - last_t <= BREAK_S else []
                cur = {"v": vid, "r": key[0], "pts": list(seed)}
                cars.append(cur)
            pl = cur["pts"]
            if len(pl) >= 2 and math.hypot(x - pl[-1][1], y - pl[-1][2]) < STILL_M \
                    and math.hypot(pl[-1][1] - pl[-2][1], pl[-1][2] - pl[-2][2]) < STILL_M:
                pl[-1] = (t, *pl[-1][1:])  # still standing: just move the time on
            elif not pl or t > pl[-1][0]:
                pl.append(pt)
            last_key, last_t = key, t

    out_cars = []
    for c in cars:
        if len(c["pts"]) < 2:
            continue
        flat, prev = [], (0, 0, 0)
        ghost, g, g_prev, last = [], 0.0, 0, None
        for t, x, y, pi, a in c["pts"]:
            lon, lat = to_lonlat(x, y)
            q = (round(lon * 1e5), round(lat * 1e5), round(t - start))
            flat += [q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]]
            prev = q
            if last is not None:
                lx, ly, lpi, la = last
                if pi is not None and pi == lpi and a >= la:
                    g += clean_secs(clean_of[pi], la, a)
                else:
                    g += math.hypot(x - lx, y - ly) / GHOST_OFF_MS
            last = (x, y, pi, a)
            ghost.append(round(g) - g_prev)
            g_prev = round(g)
        out_cars.append({"v": c["v"], "r": c["r"], "p": flat, "g": ghost})
    return {"day": day, "start": int(start), "cars": out_cars}


def write(day, dest, network=None, clean_file=None):
    clean = None
    if clean_file and Path(clean_file).exists():
        clean = {pid: p["clean"] for pid, p in json.loads(Path(clean_file).read_text())["pieces"].items()}
    out = build(day, network, clean)
    # The day's short turns (from the day's processed results), for the replay's "!" markers:
    # [seconds from 04:00, vehicle, lon, lat, route, direction, stop name, scheduled end].
    agg = WORK_DIR / "agg" / f"{day}.json.gz"
    if agg.exists():
        with gzip.open(agg, "rt") as f:
            events = (json.load(f).get("short_turns") or {}).get("events", [])
        out["st"] = [[e["t"] - out["start"], e["v"], e["lon"], e["lat"], e["r"], e["d"], e["name"], e["to"]]
                     for e in events]
    dest.write_text(json.dumps(out, separators=(",", ":")))
    n = sum(len(c["p"]) // 3 for c in out["cars"])
    print(f"replay {day}: {len(out['cars'])} paths, {n} points, {dest.stat().st_size / 1e6:.1f} MB"
          f"{'' if clean else ' (no clean run: ghost at a flat pace)'}", file=sys.stderr)


if __name__ == "__main__":
    # replay.py DAY [OUT] [STATS] (STATS: a stats-recent.json, for the ghost's clean run)
    write(sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else Path("replay.json"),
          clean_file=sys.argv[3] if len(sys.argv) > 3 else None)
