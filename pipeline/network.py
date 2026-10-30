#!/usr/bin/env python3
"""Build the streetcar track network the delay profile is measured on.

Every streetcar pattern (all routes incl. overnight, all saved schedule snapshots,
excluding replacement buses) is walked in 5 m steps; stretches not already covered
by an existing piece in the same direction become new pieces. Pieces are directed,
cut into BIN_M slices, and never change once created, so slice statistics stay
comparable forever; new or moved track simply adds pieces.

Route "patterns" (main pattern per route and direction in the newest schedule)
are mapped onto piece slices for the per-route clean-run summaries.

Usage: network.py   Reads STATIC_DIR snapshots; updates WORK_DIR/network.json.
"""
import csv
import io
import json
import math
import re
import statistics
import sys
import zipfile
from collections import Counter, defaultdict

from common import (BIN_M, NIGHT_TWIN, STATIC_DIR, WORK_DIR, PathGeom, angle_diff,
                    bearing_of, to_lonlat, to_xy)

STEP = 5           # metres between samples when walking a shape
COVER_M = 12       # a shape point this close to a piece (same direction) is already covered
COVER_BEARING = 45
MIN_PIECE = 50     # ignore uncovered stretches shorter than this (junction slop)
GRID = 25

NETWORK = WORK_DIR / "network.json"


def reader(z, name):
    (member,) = [n for n in z.namelist() if n.endswith("/" + name) or n == name]
    return csv.DictReader(io.TextIOWrapper(z.open(member), "utf-8-sig"))


def secs(hms):
    h, m, s = map(int, hms.split(":"))
    return h * 3600 + m * 60 + s


def tidy_headsign(h):
    m = re.match(r"(\w+) - .*?towards (.+)", h)
    if not m:
        return "", h
    return {"West": "Westbound", "East": "Eastbound", "North": "Northbound",
            "South": "Southbound"}.get(m.group(1), m.group(1)), m.group(2)


def walk(geom):
    """Points every STEP metres along a path: (along, x, y, bearing)."""
    out = []
    n = max(1, int(geom.length // STEP))
    for i in range(n + 1):
        a = min(geom.length, i * STEP)
        x, y = geom.point_at(a)
        x2, y2 = geom.point_at(min(geom.length, a + STEP))
        x0, y0 = geom.point_at(max(0.0, a - STEP))
        out.append((a, x, y, bearing_of(x2 - x0, y2 - y0)))
    return out


class Network:
    def __init__(self, data=None):
        self.data = data or {"bin_m": BIN_M, "snapshots": [], "pieces": [], "patterns": []}
        self.geoms = [PathGeom(p["line"]) for p in self.data["pieces"]]
        self.grid = defaultdict(list)  # cell -> [(piece, along, x, y, bearing)]
        for pi, g in enumerate(self.geoms):
            self._index(pi, g)

    def _index(self, pi, g):
        for a, x, y, b in walk(g):
            self.grid[(int(x // GRID), int(y // GRID))].append((pi, a, x, y, b))

    def locate(self, x, y, bearing):
        """(piece, along) of the nearest same-direction piece point within COVER_M, else None."""
        best, bd = None, COVER_M
        cx, cy = int(x // GRID), int(y // GRID)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for pi, a, px, py, pb in self.grid.get((cx + dx, cy + dy), ()):
                    d = math.hypot(px - x, py - y)
                    if d <= bd and angle_diff(pb, bearing) <= COVER_BEARING:
                        best, bd = (pi, a), d
        return best

    def add_shape(self, lonlats, routes):
        """Add uncovered stretches of a shape as new pieces; return per-step (piece, along) mapping."""
        pts = walk(PathGeom(lonlats))
        mapping = [self.locate(x, y, b) for _, x, y, b in pts]
        i = 0
        while i < len(pts):
            if mapping[i] is not None:
                i += 1
                continue
            j = i
            while j < len(pts) and mapping[j] is None:
                j += 1
            # Extend one step either side so the new piece joins its neighbours.
            lo, hi = max(0, i - 1), min(len(pts), j + 1)
            if pts[hi - 1][0] - pts[lo][0] >= MIN_PIECE:
                line = [[round(c, 6) for c in to_lonlat(x, y)] for _, x, y, _ in pts[lo:hi]]
                pi = len(self.data["pieces"])
                self.data["pieces"].append({"id": f"p{pi}", "line": line, "routes": [], "stops": []})
                g = PathGeom(line)
                self.geoms.append(g)
                self._index(pi, g)
                along = 0.0
                for k in range(lo + 1, hi):
                    along += math.hypot(pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2])
                    if i <= k < j:
                        mapping[k] = (pi, along)
                if lo == i:
                    mapping[i] = (pi, 0.0)
            i = j
        # A route counts as using a piece only if it runs a real stretch of it, not a crossing.
        steps = Counter(m[0] for m in mapping if m is not None)
        for pi, n in steps.items():
            if n * STEP >= 200:
                rs = self.data["pieces"][pi]["routes"]
                rs.extend(r for r in routes if r not in rs)
        return pts, mapping


def snapshot_zips():
    return sorted(STATIC_DIR.glob("surface-routes-and-schedules-for-bustime/*.zip"))


def build():
    net = Network(json.loads(NETWORK.read_text()) if NETWORK.exists() else None)
    zips = snapshot_zips()
    if all(z.name in net.data["snapshots"] for z in zips) and net.data["patterns"]:
        print("network up to date", file=sys.stderr)
        return
    for zpath in zips:
        if zpath.name in net.data["snapshots"]:
            continue
        print(f"adding {zpath.name}", file=sys.stderr)
        add_snapshot(net, zpath)
        net.data["snapshots"].append(zpath.name)
    # Route summaries always come from the newest schedule.
    net.data["patterns"] = patterns(net, zips[-1])
    for p in net.data["pieces"]:
        g = PathGeom(p["line"])
        p["length"] = round(g.length, 1)
        p["bins"] = [[round(c, 5) for c in to_lonlat(*g.point_at((i + 0.5) * BIN_M))]
                     for i in range(math.ceil(g.length / BIN_M))]
    NETWORK.parent.mkdir(parents=True, exist_ok=True)
    tmp = NETWORK.with_suffix(".tmp")
    tmp.write_text(json.dumps(net.data, separators=(",", ":")))
    tmp.replace(NETWORK)
    n_bins = sum(len(p["bins"]) for p in net.data["pieces"])
    km = sum(p["length"] for p in net.data["pieces"]) / 1000
    print(f"network: {len(net.data['pieces'])} pieces, {km:.1f} km, {n_bins} slices, "
          f"{len(net.data['patterns'])} route patterns", file=sys.stderr)


def load_snapshot(zpath, want_stop_times=True):
    z = zipfile.ZipFile(zpath)
    routes = {r["route_id"]: r for r in reader(z, "routes.txt") if r["route_type"] == "0"}
    trips = [t for t in reader(z, "trips.txt")
             if t["route_id"] in routes and "Replacement Bus" not in t["trip_headsign"]]
    shape_ids = {t["shape_id"] for t in trips}
    pts = defaultdict(list)
    for r in reader(z, "shapes.txt"):
        if r["shape_id"] in shape_ids:
            pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
    shapes = {s: [(lon, lat) for _, lon, lat in sorted(v)] for s, v in pts.items()}
    stop_seq = defaultdict(list)
    if want_stop_times:
        trip_ids = {t["trip_id"] for t in trips}
        for r in reader(z, "stop_times.txt"):
            if r["trip_id"] in trip_ids:
                stop_seq[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], r["arrival_time"], r["departure_time"]))
    stops = {s["stop_id"]: s for s in reader(z, "stops.txt")}
    return routes, trips, shapes, stop_seq, stops


def add_snapshot(net, zpath):
    routes, trips, shapes, stop_seq, stops = load_snapshot(zpath)
    by_shape = defaultdict(list)
    for t in trips:
        by_shape[t["shape_id"]].append(t)
    # Busiest patterns first so the main lines become the long pieces.
    for shape in sorted(by_shape, key=lambda s: -len(by_shape[s])):
        if shape not in shapes or len(shapes[shape]) < 2:
            continue
        rs = sorted({NIGHT_TWIN.get(t["route_id"], t["route_id"]) for t in by_shape[shape]})
        pts, mapping = net.add_shape(shapes[shape], rs)
        rep = max((sorted(stop_seq[t["trip_id"]]) for t in by_shape[shape]), key=len, default=[])
        attach_stops(net, pts, mapping, rep, stops)


def attach_stops(net, pts, mapping, rep, stops):
    g_shape_xy = [(x, y) for _, x, y, _ in pts]
    for _, sid, _, _ in rep:
        s = stops[sid]
        sx, sy = to_xy(float(s["stop_lon"]), float(s["stop_lat"]))
        k = min(range(len(g_shape_xy)), key=lambda i: (g_shape_xy[i][0] - sx) ** 2 + (g_shape_xy[i][1] - sy) ** 2)
        if math.hypot(g_shape_xy[k][0] - sx, g_shape_xy[k][1] - sy) > 40 or mapping[k] is None:
            continue
        pi, a = mapping[k]
        piece = net.data["pieces"][pi]
        if all(st["id"] != sid for st in piece["stops"]):
            piece["stops"].append({"id": sid, "name": s["stop_name"], "along": round(a, 1),
                                   "lonlat": [round(float(s["stop_lon"]), 6), round(float(s["stop_lat"]), 6)]})
            piece["stops"].sort(key=lambda st: st["along"])


def patterns(net, zpath):
    routes, trips, shapes, stop_seq, stops = load_snapshot(zpath)
    counts = Counter((t["route_id"], t["direction_id"], t["shape_id"], t["trip_headsign"]) for t in trips
                     if "Short Turn" not in t["trip_headsign"] and t["route_id"] not in NIGHT_TWIN)
    main = {}
    for (route, d, shape, head), _ in counts.most_common():
        main.setdefault((route, d), (shape, head))
    out = []
    for (route, d), (shape, head) in sorted(main.items()):
        pts = walk(PathGeom(shapes[shape]))
        mapping = [net.locate(x, y, b) for _, x, y, b in pts]
        st = [t for t in trips if t["shape_id"] == shape]
        seqs = [sorted(stop_seq[t["trip_id"]]) for t in st]
        rep = max(seqs, key=len)
        # Shape distance of first and last stop, to drop terminal loops.
        xy = [(x, y) for _, x, y, _ in pts]

        def nearest_step(sid):
            sx, sy = to_xy(float(stops[sid]["stop_lon"]), float(stops[sid]["stop_lat"]))
            return min(range(len(xy)), key=lambda i: (xy[i][0] - sx) ** 2 + (xy[i][1] - sy) ** 2)

        k0, k1 = nearest_step(rep[0][1]), nearest_step(rep[-1][1])
        slices, seen = [], set()
        for k in range(k0, k1 + 1):
            if mapping[k] is None:
                continue
            key = (mapping[k][0], int(mapping[k][1] // BIN_M))
            if key not in seen:
                seen.add(key)
                slices.append(list(key))
        runtimes = [secs(v[-1][2]) - secs(v[0][3]) for v in seqs if len(v) == len(rep)]
        direction, dest = tidy_headsign(head)
        out.append({
            "id": f"{route}-{d}", "route": route, "dir": int(d),
            "name": routes[route]["route_long_name"].title(), "direction": direction,
            "from": stops[rep[0][1]]["stop_name"], "to": dest,
            "length": round(pts[k1][0] - pts[k0][0]),
            "sched_s": statistics.median(runtimes) if runtimes else None,
            "coverage": round(sum(m is not None for m in mapping[k0:k1 + 1]) / max(1, k1 - k0 + 1), 3),
            "slices": slices,
        })
    return out


if __name__ == "__main__":
    build()
