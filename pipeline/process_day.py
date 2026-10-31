#!/usr/bin/env python3
"""Reduce one service day of logged positions to per-slice running-time statistics.

For every streetcar run (vehicle + trip), pings are snapped to the track piece that
matches their position and heading, then time between consecutive pings is shared
out over the 25 m slices covered (all of it to one slice when the car didn't move).
Each slice a pass fully crosses yields one sample: seconds spent in that slice.

Per piece and slice we keep a log-bucketed histogram of samples and per time-of-day
sums and counts (for the typical time). Slices alone can't give a fair clean run:
with ~30 s between pings a stop's dwell gets smeared over neighbouring slices, so
the best pass in every slice adds up to a run that never stops. So we also time
each stop interval (halfway-to-previous-stop to halfway-to-next-stop; cars are
moving at those points so the interpolated crossing times are good) and keep a
histogram of those. Plus daily per-route counts for the bus/diversion timeline, and per route pattern
the number of its slices streetcar runs covered (divided by the pattern's length,
that's how many full trips' worth of service ran).

The histograms (which set the clean run) only take daytime passes, 06:00 to
midnight: overnight cars on empty streets skip most stops, so they'd make the
clean run a non-stopping run. Overnight passes still count in the sums and counts,
and are compared against the daytime clean run.

Standing still longer than LAYOVER_S is treated as a layover (terminal loops,
change-offs) and cut out of the pass.

Usage: process_day.py YYYY-MM-DD [...]   Writes WORK_DIR/agg/<day>.json.gz
"""
import csv
import gzip
import json
import math
import sys
from collections import defaultdict

from common import (BIN_M, DATA_DIR, FLEXITY_IDS, NIGHT_TWIN, WORK_DIR, PathGeom,
                    angle_diff, slot_of, to_xy)

MATCH_M = 35        # max distance from the track for a ping to count as on it
BEARING_TOL = 60    # max heading difference from the track direction, degrees
MAX_GAP_S = 90      # a longer silence between pings ends the pass
MAX_SPEED = 25      # m/s; faster implied movement means a bad match
STILL_M = 3         # moved less than this between pings = standing still
LAYOVER_S = 180     # standing this long in one place = layover, not delay
CELL = 100          # spatial index cell, metres

# Log-spaced histogram buckets for seconds-in-slice: 0.25 s .. ~600 s, ~21% wide.
B0, BR, NB = 0.25, 1.215, 42


def bucket(v):
    if v < B0:
        return 0
    return min(NB - 1, int(math.log(v / B0) / math.log(BR)) + 1)


def bucket_mid(b):
    return 0.0 if b == 0 else B0 * BR ** (b - 0.5)


class Matcher:
    def __init__(self, network):
        self.pieces = network["pieces"]
        self.geoms = [PathGeom(p["line"]) for p in self.pieces]
        self.index = defaultdict(list)  # cell -> [(piece, seg)]
        for pi, g in enumerate(self.geoms):
            for si in range(len(g.x) - 1):
                x0, x1 = sorted((g.x[si], g.x[si + 1]))
                y0, y1 = sorted((g.y[si], g.y[si + 1]))
                for cx in range(int((x0 - MATCH_M) // CELL), int((x1 + MATCH_M) // CELL) + 1):
                    for cy in range(int((y0 - MATCH_M) // CELL), int((y1 + MATCH_M) // CELL) + 1):
                        self.index[(cx, cy)].append((pi, si))
        # Stop-interval boundaries per piece: midpoints between consecutive stops.
        self.bounds = []
        for p in self.pieces:
            a = [s["along"] for s in p["stops"]]
            self.bounds.append([(x + y) / 2 for x, y in zip(a, a[1:])])

    def candidates(self, x, y, bearing):
        """{piece: [(along, distance)]} for track within MATCH_M heading the same way."""
        out = defaultdict(list)
        for pi, si in self.index.get((int(x // CELL), int(y // CELL)), ()):
            g = self.geoms[pi]
            if bearing is not None and angle_diff(bearing, g.seg_bearing[si]) > BEARING_TOL:
                continue
            a, d = g.project_seg(si, x, y)
            if d <= MATCH_M:
                out[pi].append((a, d))
        return out


def split_passes(pings, opts_list):
    """Turn a run's pings into monotonic passes: [(piece, [(t, along), ...])]. Also returns off-track count."""
    passes, cur, seq, off = [], None, [], 0

    def close():
        if seq:
            passes.append((cur, list(seq)))
        seq.clear()

    for (t, _, _, _), opts in zip(pings, opts_list):
        if not opts:
            off += 1
            close()
            continue
        a = None
        if seq and cur in opts:
            fwd = [a for a, _ in opts[cur] if a >= seq[-1][1] - 20]
            dt = t - seq[-1][0]
            if fwd and dt <= MAX_GAP_S and (min(fwd) - seq[-1][1]) / dt <= MAX_SPEED:
                a = max(min(fwd), seq[-1][1])  # GPS jitter backwards: treat as standing still
        if a is None:
            close()
            cur, (a, _) = min(((pi, min(o, key=lambda v: v[1])) for pi, o in opts.items()),
                              key=lambda v: v[1][1])
        seq.append((t, a))
    close()
    return passes, off


def split_layovers(seq):
    """Cut a pass wherever the car stood in one spot for over LAYOVER_S; trim standing ends."""
    parts, cur = [], [seq[0]]
    still = 0  # index in cur of the ping where the current standing spell began
    for p in seq[1:]:
        if p[1] - cur[still][1] < STILL_M:
            if p[0] - cur[still][0] > LAYOVER_S:
                parts.append(cur[:still + 1])
                cur, still = [p], 0
                continue
        else:
            still = len(cur)
        cur.append(p)
    parts.append(cur)
    out = []
    for p in parts:
        # Drop standing time before the car first moves and after it last moves.
        i0 = 0
        while i0 + 1 < len(p) and p[i0 + 1][1] - p[0][1] < 10:
            i0 += 1
        i1 = len(p) - 1
        while i1 - 1 > i0 and p[-1][1] - p[i1 - 1][1] < 10:
            i1 -= 1
        if i1 > i0:
            out.append(p[i0:i1 + 1])
    return out


def interval_times(seq, bounds):
    """{interval k: (seconds, start time)} for stop intervals [bounds[k], bounds[k+1]] the pass fully crossed."""
    cross = {}
    j = 0
    for k, b in enumerate(bounds):
        while j + 1 < len(seq) and seq[j + 1][1] < b:
            j += 1
        if j + 1 >= len(seq):
            break
        (t1, a1), (t2, a2) = seq[j], seq[j + 1]
        if a1 <= b < a2 and t2 - t1 <= MAX_GAP_S:
            cross[k] = t1 + (t2 - t1) * (b - a1) / (a2 - a1)
    return {k: (cross[k + 1] - cross[k], cross[k]) for k in cross if k + 1 in cross}


def slice_times(seq):
    """{bin: (seconds, entry_time)} for slices the pass fully crossed."""
    first = math.ceil(seq[0][1] / BIN_M)
    last = math.floor(seq[-1][1] / BIN_M)
    if last <= first:
        return {}
    acc = defaultdict(float)
    entry = {}
    for (t1, a1), (t2, a2) in zip(seq, seq[1:]):
        dt = t2 - t1
        if a2 - a1 < STILL_M:
            b = int((a1 + a2) / 2 // BIN_M)
            acc[b] += dt
            entry.setdefault(b, t1)
            continue
        b = int(a1 // BIN_M)
        while b * BIN_M < a2:
            overlap = min(a2, (b + 1) * BIN_M) - max(a1, b * BIN_M)
            if overlap > 0:
                acc[b] += dt * overlap / (a2 - a1)
                entry.setdefault(b, t1 + dt * (max(a1, b * BIN_M) - a1) / (a2 - a1))
            b += 1
    return {b: (acc[b], entry[b]) for b in range(first, last) if b in acc}


def process(day, network=None):
    src = DATA_DIR / f"{day}.csv"
    opener = open
    if not src.exists():
        src, opener = DATA_DIR / f"{day}.csv.gz", gzip.open
    network = network or json.loads((WORK_DIR / "network.json").read_text())
    m = Matcher(network)

    runs = defaultdict(dict)  # (vehicle, trip) -> {vehicle_ts: (t, x, y, bearing)}
    run_route = {}
    route_days = defaultdict(lambda: {"flex_on": 0, "flex_off": 0, "bus": 0})
    first_ts = last_ts = None  # how much of the day was logged
    with opener(src, "rt", newline="") as f:
        for r in csv.DictReader(f):
            ts = int(r["fetch_ts"])
            first_ts = ts if first_ts is None else min(first_ts, ts)
            last_ts = ts if last_ts is None else max(last_ts, ts)
            route = NIGHT_TWIN.get(r["route_id"], r["route_id"])
            vid = r["vehicle_id"]
            if not (vid.isdigit() and int(vid) in FLEXITY_IDS):
                route_days[route]["bus"] += 1
                continue
            vts = int(r["vehicle_ts"] or r["fetch_ts"])
            x, y = to_xy(float(r["lon"]), float(r["lat"]))
            brg = float(r["bearing"]) if r["bearing"] else None
            runs[(vid, r["trip_id"])][vts] = (vts, x, y, brg)
            run_route[(vid, r["trip_id"])] = route

    # Route pattern slices, to count how much of its route each run covered ("trip
    # equivalents": a short-turned or partly logged trip counts as a fraction).
    slice_pats = defaultdict(list)  # (piece index, bin) -> [pattern ids]
    for pat in network.get("patterns", []):
        for pi, b in pat["slices"]:
            slice_pats[(pi, b)].append(pat["id"])
    cover = defaultdict(lambda: defaultdict(int))  # route -> pattern -> slices covered

    hist = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))   # piece -> bin -> bucket -> n
    sums = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # piece -> slot -> bin -> s
    cnts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))    # piece -> slot -> bin -> n
    ihist = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # piece -> interval -> bucket -> n
    n_pings = n_passes = n_samples = 0
    for key, by_ts in runs.items():
        route = run_route[key]
        pings = [by_ts[t] for t in sorted(by_ts)]
        n_pings += len(pings)
        opts_list = [m.candidates(x, y, b) for _, x, y, b in pings]
        passes, off = split_passes(pings, opts_list)
        route_days[route]["flex_off"] += off
        route_days[route]["flex_on"] += len(pings) - off
        run_cover = defaultdict(int)  # pattern -> slices this run covered
        for pi, whole in passes:
            pid = m.pieces[pi]["id"]
            for seq in split_layovers(whole):
                times = slice_times(seq)
                if not times:
                    continue
                for b in times:
                    for pat_id in slice_pats.get((pi, b), ()):
                        if pat_id.split("-")[0] == route:
                            run_cover[pat_id] += 1
                n_passes += 1
                for b, (v, t_in) in times.items():
                    n_samples += 1
                    slot = slot_of(t_in, day)
                    if slot != "night":
                        hist[pid][b][bucket(v)] += 1
                    sums[pid][slot][b] += v
                    cnts[pid][slot][b] += 1
                for k, (v, t_in) in interval_times(seq, m.bounds[pi]).items():
                    if slot_of(t_in, day) != "night":
                        ihist[pid][k][bucket(v)] += 1
        # A run belongs to the direction it covered most (loops are shared by both).
        if run_cover:
            best = max(run_cover, key=run_cover.get)
            cover[route][best] += run_cover[best]
    for route, pats in cover.items():
        route_days[route]["cover"] = dict(pats)

    out = {
        "day": day,
        "stats": {"pings": n_pings, "passes": n_passes, "samples": n_samples,
                  "logged_h": round((last_ts - first_ts) / 3600, 2) if first_ts else 0},
        "routes": route_days,
        "hist": hist,
        "ihist": ihist,
        "sums": {p: {s: {b: round(v, 2) for b, v in d.items()} for s, d in sl.items()} for p, sl in sums.items()},
        "cnts": cnts,
    }
    dest = WORK_DIR / "agg" / f"{day}.json.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    with gzip.open(tmp, "wt") as f:
        json.dump(out, f, separators=(",", ":"))
    tmp.replace(dest)
    print(f"{day}: {n_pings} pings, {n_passes} passes, {n_samples} slice samples -> {dest.name} "
          f"({dest.stat().st_size / 1e3:.0f} kB)", file=sys.stderr)


if __name__ == "__main__":
    net = json.loads((WORK_DIR / "network.json").read_text())
    for d in sys.argv[1:]:
        process(d, net)
