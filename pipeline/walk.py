"""Slower than walking: the replay tour's stretch where streetcars lost to someone on foot.

A ride here is time on board: from the moment a car leaves stop A to the moment it comes
within REACH_M of stop B, on one trip. Cars often report standing a little short of the stop
they're at (a car is 30 m long, and the feed doesn't say where on it the position is), so the
wait there isn't counted: the safe side for a claim that walking won. Against it, someone
walking the same street (the track's length between the stops) at a steady WALK_KMH, a
little under an ordinary pace, which allows for waiting at a crossing now and then. No
attempt is made to guess the lights: a walker going the same way mostly gets the car's
greens, and isn't stuck in the queue behind it.

Every daytime ride of MIN_M to MAX_M between two stops counts (not near either end of a
trip, where layovers sit; not losing over MAX_LOSS_S against the clean run, which is a
breakdown), on routes the day's service-change flags leave alone. The stretch shown is the
one with the most rides slower than walking; the ride shown there is the middle one by how
much it lost to the walker, among those still LEAD_M or more short of B when the walker got
there, so the gap shows on screen at the finish.

Output (stories.json "walk", for tour.js), times in seconds from 04:00 as in replay.json:
{"route", "v" (vehicle), "street", "a", "b" (cross streets), "a_ll", "b_ll" ([lon, lat]),
 "tA" (leaves A), "tB" (comes within REACH_M of B), "m" (metres), "ride_s", "walk_s",
 "kmh" (walking pace), "n" (rides there slower than walking), "of" (all rides there),
 "net": the same measure across the network, by trip: {"trips" (daytime trips with a stretch
 slower than walking), "of" (daytime trips with any stretch measured), "routes" ([route, trips],
 most first), "lines" ([trips, [[lon, lat], ...]] per stop-to-stop piece of street a slower
 stretch covered; drafts.py moves these to their own file, walk-lines.json)}}

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
LEAD_M = 100               # the car is at least this far short of B when the walker arrives
REACH_M = 30               # a car this close to stop B (a car length) has arrived
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


def _lead(cum, ts, b, tW):
    """How far short of b metres along the car still is at tW, when the walker gets there."""
    return b - _interp(ts, cum, tW)


def _cross(name):
    street, cross = name, ""
    name = re.sub(r"\s+(North|South|East|West|Far|Near)\s+Side$", "", name.strip(), flags=re.I)
    m = re.match(r"(.+?)\s+at\s+(.+)", name, flags=re.I)
    if m:
        street, cross = m.group(1), m.group(2)
    # Some stop names are in capitals: "DUNDAS ST WEST AT MCCAUL ST" -> "McCaul St".
    tidy = lambda s: re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(),
                            s.title() if s.isupper() else s).split(" - ")[0].strip()
    street = re.sub(r"\s+(East|West|North|South)$", "", tidy(street))
    return street, tidy(cross)


def pick(replay, net, skip_routes=()):
    pace = WALK_KMH / 3.6
    stops = _stops(net)
    grid = defaultdict(list)
    for k, (_, _, (x, y), _, _) in enumerate(stops):
        grid[(int(x // CELL), int(y // CELL))].append(k)
    rides = defaultdict(list)   # (route, stop A, stop B) -> [ride]
    trips = defaultdict(set)    # route -> trips with a stretch measured
    slow = defaultdict(int)     # route -> trips with a stretch slower than walking
    edges = {}                  # (stop, next stop) -> [trips slower than walking over it, line]
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
        slow_to = {}   # stop index on `on` -> furthest stop index reached by a slower-than-walking ride from it
        for ia, (a, ka) in enumerate(on):
            tA = _leave(cum, ts, a + 3)
            if not DAY_FROM <= tA <= DAY_TO:
                continue
            for ib, (b, kb) in enumerate(on[ia + 1:], ia + 1):
                m = b - a
                if m < MIN_M:
                    continue
                if m > MAX_M:
                    break
                tB = _reach(cum, ts, b - REACH_M)
                if tB is None or tB <= tA:
                    break
                ride, walk = tB - tA, m / pace
                if gh and ride - (_interp(cum, gh, b) - _interp(cum, gh, a)) > MAX_LOSS_S:
                    continue
                r = {"v": car["v"], "tA": tA, "tB": tB, "m": m, "ride": ride, "walk": walk}
                trips[car["r"]].add(id(car))
                if ride > walk:
                    r["lead"] = _lead(cum, ts, b, tA + walk)
                    slow_to[ia] = max(slow_to.get(ia, ia), ib)
                rides[(car["r"], ka, kb)].append(r)
        if slow_to:
            slow[car["r"]] += 1
            covered = set()
            for ia, ib in slow_to.items():
                covered.update(range(ia, ib))
            for j in covered:
                key = (on[j][1], on[j + 1][1])
                if key not in edges:
                    edges[key] = [0, _line(xs, cum, on[j][0], on[j + 1][0])]
                edges[key][0] += 1
    best = None
    for key, rs in rides.items():
        lost = [r for r in rs if r["ride"] > r["walk"]]
        shown = sorted((r for r in lost if r["lead"] >= LEAD_M), key=lambda r: r["ride"] - r["walk"])
        if shown and (best is None or (len(lost), -len(rs)) > (best[1], -best[2])):
            best = (key, len(lost), len(rs), shown[len(shown) // 2])
    if not best:
        return None
    (route, ka, kb), n, of, r = best
    street, a = _cross(stops[ka][1])
    _, b = _cross(stops[kb][1])
    return {"route": route, "v": r["v"], "street": street, "a": a, "b": b,
            "a_ll": stops[ka][4], "b_ll": stops[kb][4],
            "tA": round(r["tA"]), "tB": round(r["tA"]) + round(r["ride"]), "m": round(r["m"]),
            "ride_s": round(r["ride"]), "walk_s": round(r["walk"]), "kmh": WALK_KMH, "n": n, "of": of,
            "net": {"trips": sum(slow.values()), "of": sum(len(t) for t in trips.values()),
                    "routes": sorted(([k, v] for k, v in slow.items()), key=lambda x: (-x[1], x[0])),
                    "lines": sorted(edges.values(), key=lambda e: e[0])}}


def _line(xs, cum, a, b):
    """The path from a to b metres along, as [lon, lat] (5 decimals), simplified to ~3 m."""
    i, j = bisect_left(cum, a), bisect_right(cum, b)
    pts = [(_interp(cum, [x for x, _ in xs], a), _interp(cum, [y for _, y in xs], a))]
    pts += xs[i:j]
    pts.append((_interp(cum, [x for x, _ in xs], b), _interp(cum, [y for _, y in xs], b)))
    keep = _simplify(pts, 3.0)
    return [[round(x / KX, 5), round(y / KY, 5)] for x, y in keep]


def _simplify(pts, tol):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1
    far, k = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs((pts[i][0] - x1) * dy - (pts[i][1] - y1) * dx) / L
        if d > far:
            far, k = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return _simplify(pts[:k + 1], tol)[:-1] + _simplify(pts[k:], tol)


if __name__ == "__main__":
    print(json.dumps(pick(json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))), indent=1))
