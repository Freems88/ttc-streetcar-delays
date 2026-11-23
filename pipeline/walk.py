"""Slower than walking: the replay tour's stretch where streetcars lost to someone on foot.

A ride here is time on board: from the moment a car leaves stop A to the moment it reaches
stop B, on one trip. Against it, someone walking the same street (the track's length between
the stops) at a steady WALK_KMH, a little under an ordinary pace, which allows for waiting
at a crossing now and then. No attempt is made to guess the lights: a walker going the same
way mostly gets the car's greens, and isn't stuck in the queue behind it.

Every daytime ride of MIN_M to MAX_M between two stops counts (not near either end of a
trip, where layovers sit; not losing over MAX_LOSS_S against the clean run, which is a
breakdown), on routes the day's service-change flags leave alone. The stretch shown is the
one with the most rides slower than walking; the ride shown there is the middle one by how
much it lost to the walker, among those where the walker got at least LEAD_M ahead, so the
gap shows on screen.

Output (stories.json "walk", for tour.js), times in seconds from 04:00 as in replay.json:
{"route", "v" (vehicle), "street", "a", "b" (cross streets), "a_ll", "b_ll" ([lon, lat]),
 "tA" (leaves A), "tB" (reaches B), "m" (metres), "ride_s", "walk_s", "kmh" (walking pace),
 "n" (rides there slower than walking), "of" (all rides there)}

Usage: walk.py REPLAY.json NETWORK.json   (prints the pick)
"""
import json
import math
import re
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict

from common import FLEXITY_IDS

WALK_KMH = 4.5
MIN_M, MAX_M = 800, 1500   # long enough to be a real ride, short enough to frame in one view
LEAD_M = 100               # the walker gets at least this far ahead (about three car lengths)
END_M = 300                # rides starting or ending this close to a trip's ends are left out (layovers)
MAX_LOSS_S = 15 * 60       # against the clean run over the ride: more is a breakdown
DAY_FROM, DAY_TO = 2 * 3600, 18 * 3600   # 06:00-22:00, as seconds from 04:00
STOP_M = 18                # a stop counts if the path passes this close, going its way
SAME_STOP_M = 60           # stops closer than this along a trip are one (bays, near and far side)
KX, KY = 111320 * math.cos(math.radians(43.65)), 110540
CELL = 100


def _xy(lon, lat):
    return lon * KX, lat * KY


def _stops(net):
    """Every stop with its position and the way its track runs: [(id, name, (x, y), (dx, dy), lonlat)]."""
    out, seen = [], set()
    for p in net["pieces"]:
        bins = p["bins"]
        for s in p["stops"]:
            if s["id"] in seen:
                continue
            seen.add(s["id"])
            b = min(len(bins) - 1, int(s["along"] // net["bin_m"]))
            lo, hi = _xy(*bins[max(0, b - 1)]), _xy(*bins[min(len(bins) - 1, b + 1)])
            out.append((s["id"], s["name"], _xy(*s["lonlat"]), (hi[0] - lo[0], hi[1] - lo[1]), s["lonlat"]))
    return out


def _decode(car):
    p, g = car["p"], car.get("g")
    xs, ts, lon, lat, t = [], [], 0, 0, 0
    for i in range(0, len(p), 3):
        lon += p[i]; lat += p[i + 1]; t += p[i + 2]
        xs.append(_xy(lon * 1e-5, lat * 1e-5))
        ts.append(t)
    gh = None
    if g and len(g) == len(ts):
        gh, acc = [], 0
        for v in g:
            acc += v
            gh.append(acc)
    return xs, ts, gh


def _interp(xs, ys, x):
    """y at x, xs ascending (clamped)."""
    i = bisect_left(xs, x)
    if i <= 0:
        return ys[0]
    if i >= len(xs):
        return ys[-1]
    span = xs[i] - xs[i - 1]
    f = (x - xs[i - 1]) / span if span > 0 else 1
    return ys[i - 1] + f * (ys[i] - ys[i - 1])


def _leave(cum, ts, d):
    """The last moment the car is at or before distance d."""
    i = bisect_right(cum, d)
    if i <= 0:
        return ts[0]
    if i >= len(cum):
        return ts[-1]
    span = cum[i] - cum[i - 1]
    f = (d - cum[i - 1]) / span if span > 0 else 0
    return ts[i - 1] + f * (ts[i] - ts[i - 1])


def _reach(cum, ts, d):
    """The first moment the car reaches distance d."""
    i = bisect_left(cum, d)
    if i <= 0:
        return ts[0]
    if i >= len(cum):
        return None
    span = cum[i] - cum[i - 1]
    f = (d - cum[i - 1]) / span if span > 0 else 1
    return ts[i - 1] + f * (ts[i] - ts[i - 1])


def _along(xs, cum, stops, grid):
    """Stops the path passes going their way: [(metres along, stop index)], one per stop."""
    found = {}
    for i in range(1, len(xs)):
        (x1, y1), (x2, y2) = xs[i - 1], xs[i]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        if L2 < 1:
            continue
        for cx in range(int((min(x1, x2) - STOP_M) // CELL), int((max(x1, x2) + STOP_M) // CELL) + 1):
            for cy in range(int((min(y1, y2) - STOP_M) // CELL), int((max(y1, y2) + STOP_M) // CELL) + 1):
                for k in grid.get((cx, cy), ()):
                    _, _, (sx, sy), (tx, ty), _ = stops[k]
                    if tx * dx + ty * dy <= 0:   # the stop on the other side of the street
                        continue
                    f = max(0.0, min(1.0, ((sx - x1) * dx + (sy - y1) * dy) / L2))
                    off = math.hypot(sx - x1 - f * dx, sy - y1 - f * dy)
                    if off < STOP_M and (k not in found or off < found[k][1]):
                        found[k] = (cum[i - 1] + f * math.sqrt(L2), off)
    out = []
    for a, k in sorted((a, k) for k, (a, _) in found.items()):
        if not out or a - out[-1][0] >= SAME_STOP_M:
            out.append((a, k))
    return out


def _lead(cum, ts, a, tA, tB, pace):
    """The walker's biggest lead over the car (metres), both leaving A at tA."""
    best = 0.0
    i0, i1 = bisect_left(ts, tA), bisect_right(ts, tB)
    for i in range(i0, i1):
        best = max(best, (ts[i] - tA) * pace - (cum[i] - a))
    return best


def _cross(name):
    street, cross = name, ""
    name = re.sub(r"\s+(North|South|East|West|Far|Near)\s+Side$", "", name.strip(), flags=re.I)
    m = re.match(r"(.+?)\s+at\s+(.+)", name, flags=re.I)
    if m:
        street, cross = m.group(1), m.group(2)
    tidy = lambda s: (s.title() if s.isupper() else s).split(" - ")[0].strip()
    street = re.sub(r"\s+(East|West|North|South)$", "", tidy(street))
    return street, tidy(cross)


def pick(replay, net, skip_routes=()):
    pace = WALK_KMH / 3.6
    stops = _stops(net)
    grid = defaultdict(list)
    for k, (_, _, (x, y), _, _) in enumerate(stops):
        grid[(int(x // CELL), int(y // CELL))].append(k)
    rides = defaultdict(list)   # (route, stop A, stop B) -> [ride]
    for car in replay["cars"]:
        try:
            if int(car["v"]) not in FLEXITY_IDS:
                continue
        except ValueError:
            continue
        if car["r"] in skip_routes:
            continue
        xs, ts, gh = _decode(car)
        if len(xs) < 3:
            continue
        cum = [0.0]
        for i in range(1, len(xs)):
            cum.append(cum[-1] + math.dist(xs[i - 1], xs[i]))
        on = [(a, k) for a, k in _along(xs, cum, stops, grid) if END_M <= a <= cum[-1] - END_M]
        for ia, (a, ka) in enumerate(on):
            tA = _leave(cum, ts, a + 3)
            if not DAY_FROM <= tA <= DAY_TO:
                continue
            for b, kb in on[ia + 1:]:
                m = b - a
                if m < MIN_M:
                    continue
                if m > MAX_M:
                    break
                tB = _reach(cum, ts, b - 3)
                if tB is None or tB <= tA:
                    break
                ride, walk = tB - tA, m / pace
                if gh and ride - (_interp(cum, gh, b) - _interp(cum, gh, a)) > MAX_LOSS_S:
                    continue
                r = {"v": car["v"], "tA": tA, "tB": tB, "m": m, "ride": ride, "walk": walk}
                if ride > walk:
                    r["lead"] = _lead(cum, ts, a, tA, tB, pace)
                rides[(car["r"], ka, kb)].append(r)
    best = None
    for key, rs in rides.items():
        slow = [r for r in rs if r["ride"] > r["walk"]]
        shown = sorted((r for r in slow if r["lead"] >= LEAD_M), key=lambda r: r["ride"] - r["walk"])
        if shown and (best is None or (len(slow), -len(rs)) > (best[1], -best[2])):
            best = (key, len(slow), len(rs), shown[len(shown) // 2])
    if not best:
        return None
    (route, ka, kb), n, of, r = best
    street, a = _cross(stops[ka][1])
    _, b = _cross(stops[kb][1])
    return {"route": route, "v": r["v"], "street": street, "a": a, "b": b,
            "a_ll": stops[ka][4], "b_ll": stops[kb][4],
            "tA": round(r["tA"]), "tB": round(r["tA"]) + round(r["ride"]), "m": round(r["m"]),
            "ride_s": round(r["ride"]), "walk_s": round(r["walk"]), "kmh": WALK_KMH, "n": n, "of": of}


if __name__ == "__main__":
    print(json.dumps(pick(json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))), indent=1))
