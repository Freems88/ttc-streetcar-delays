"""Replay file: every streetcar's day as a path with times, for the animated replay page.

Positions are snapped to the track where they match it (the same matching as the delay
measure), and between two positions on the same piece of track the path follows the rails,
so cars glide round curves instead of cutting corners between 30-second pings. Positions
off known track (yards, loops) are kept as reported.

Output (site/data/replay.json): {"day", "start" (epoch of 04:00), "cars": [{"v": vehicle,
"r": route, "p": [lon, lat, t, dlon, dlat, dt, ...]}]}. lon/lat are in 1e-5 degrees and t
in seconds from 04:00; after the first point each triple is a difference from the one
before, which keeps the file small. A car gets a new entry when it changes route or
vanishes from the feed for over BREAK_S.
"""
import csv
import gzip
import json
import math
import sys
from collections import defaultdict

import headways
from common import DATA_DIR, FLEXITY_IDS, NIGHT_TWIN, WORK_DIR, to_lonlat, to_xy
from process_day import Matcher, split_passes

BREAK_S = 300      # silent this long: the car left the feed, so don't draw a line across the gap
SIMPLIFY_M = 1.5   # track vertices kept when following the rails between two positions
STILL_M = 2        # closer than this to the last point: standing still


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


def track_points(m, keep, pi, seq):
    """[(t, x, y)] along piece pi for one pass, following the rails between positions."""
    g, along = m.geoms[pi], keep[pi]
    out = []
    for i, (t1, a1) in enumerate(seq):
        out.append((t1, *g.point_at(a1)))
        if i + 1 == len(seq):
            break
        t2, a2 = seq[i + 1]
        if a2 - a1 < 5:
            continue
        lo = next((i for i, a in enumerate(along) if a > a1), len(along))
        for a in along[lo:]:
            if a >= a2:
                break
            out.append((t1 + (t2 - t1) * (a - a1) / (a2 - a1), *g.point_at(a)))
    return out


def build(day, network=None):
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

    pings = defaultdict(dict)  # vehicle -> {vehicle_ts: ((t, x, y, bearing), route)}
    with opener(src, "rt", newline="") as f:
        for r in csv.DictReader(f):
            vid = r["vehicle_id"]
            if not (vid.isdigit() and int(vid) in FLEXITY_IDS):
                continue
            vts = int(r["vehicle_ts"] or r["fetch_ts"])
            x, y = to_xy(float(r["lon"]), float(r["lat"]))
            brg = float(r["bearing"]) if r["bearing"] else None
            pings[vid][vts] = ((vts, x, y, brg), NIGHT_TWIN.get(r["route_id"], r["route_id"]))

    start, end = headways.day_bounds(day)
    cars = []
    for vid, by_ts in sorted(pings.items()):
        rows = [by_ts[t] for t in sorted(by_ts) if start <= t < end]
        if len(rows) < 2:
            continue
        seq = [p for p, _ in rows]
        route_at = {p[0]: r for p, r in rows}
        opts = [m.candidates(*p[1:]) for p in seq]
        passes, _ = split_passes(seq, opts)
        m.stitch(passes)
        pts = []  # (t, x, y)
        on_track = set()
        for pi, s in passes:
            pts += track_points(m, keep, pi, s)
            on_track.update(t for t, _ in s)
        pts += [(p[0], p[1], p[2]) for p, o in zip(seq, opts) if not o and p[0] not in on_track]
        pts.sort()

        cur, last_route, last_t = None, None, None
        for t, x, y in pts:
            # A stitched join point has no ping of its own: it keeps the route of the ping before it.
            route = route_at.get(t, last_route)
            if cur is None or route != last_route or t - last_t > BREAK_S:
                cur = {"v": vid, "r": route, "pts": []}
                cars.append(cur)
            pl = cur["pts"]
            if len(pl) >= 2 and math.hypot(x - pl[-1][1], y - pl[-1][2]) < STILL_M \
                    and math.hypot(pl[-1][1] - pl[-2][1], pl[-1][2] - pl[-2][2]) < STILL_M:
                pl[-1] = (t, pl[-1][1], pl[-1][2])  # still standing: just move the time on
            elif not pl or t > pl[-1][0]:
                pl.append((t, x, y))
            last_route, last_t = route, t

    out_cars = []
    for c in cars:
        if len(c["pts"]) < 2:
            continue
        flat, prev = [], (0, 0, 0)
        for t, x, y in c["pts"]:
            lon, lat = to_lonlat(x, y)
            q = (round(lon * 1e5), round(lat * 1e5), round(t - start))
            flat += [q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]]
            prev = q
        out_cars.append({"v": c["v"], "r": c["r"], "p": flat})
    return {"day": day, "start": int(start), "cars": out_cars}


def write(day, dest, network=None):
    out = build(day, network)
    dest.write_text(json.dumps(out, separators=(",", ":")))
    n = sum(len(c["p"]) // 3 for c in out["cars"])
    print(f"replay {day}: {len(out['cars'])} paths, {n} points, {dest.stat().st_size / 1e6:.1f} MB",
          file=sys.stderr)


if __name__ == "__main__":
    from pathlib import Path
    write(sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else Path("replay.json"))
