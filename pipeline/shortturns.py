"""Short turns: trips that turn back well before the end the schedule gives them.

Each logged run (one streetcar on one trip_id) is matched to its scheduled trip: the trip
ids in the live feed match the static schedule in effect about 99% of the time. The
furthest scheduled stop the car came within NEAR_M of is how far it got. If that leaves
more than SHORT_KM of the trip undone:

  - within NEXT_S the car comes back past a stop of this trip at least BACK_KM behind the
    furthest one (whatever trip it's signed on to by then)  -> a short turn, at that stop
  - it was last seen near a yard                             -> heading in (not counted)
  - it carried on without turning back                      -> not counted: the feed gave it
                                                                a new trip number mid-route
  - it vanished from the feed                                -> ended early (taken out of
                                                                service, or the feed lost it)

Runs where the car never got MIN_RUN_KM into the trip are skipped: cars are often signed
on to a trip at a terminal and re-signed before leaving. Planned short trips (the schedule
itself ends them part way) aren't short turns: their scheduled end is where they end.
"""
import gzip
import json
import math
import zipfile
from collections import defaultdict

import headways
from common import NIGHT_TWIN, STATIC_DIR, WORK_DIR, to_xy

NEAR_M = 80       # a car this close to a scheduled stop has reached it
SHORT_KM = 1.0    # more than this of the trip left undone = cut short
MIN_RUN_KM = 1.0  # a run has to get this far into its trip to count
NEXT_S = 20 * 60  # the car has this long after its trip ends to show it turned back
BACK_KM = 0.4     # ...by passing a stop at least this far back along the way it came
LOOKAHEAD = 25    # stops checked ahead of the furthest one so far (pings are ~150 m apart)


_reader = headways._reader  # handles zips that keep their files in a folder


def _trip_cache(zpath):
    """Streetcar trips' stop sequences in one static GTFS file, cached:
    {"stops": {id: [lon, lat, name]}, "trips": {trip_id: [route, headsign, [stop ids]]}}."""
    cache = WORK_DIR / "sched" / (zpath.stem + ".trips-v1.json.gz")
    if cache.exists():
        with gzip.open(cache, "rt") as f:
            return json.load(f)
    z = zipfile.ZipFile(zpath)
    routes = {r["route_id"] for r in _reader(z, "routes.txt") if r["route_type"] == "0"}
    trips = {t["trip_id"]: t for t in _reader(z, "trips.txt") if t["route_id"] in routes}
    seqs = defaultdict(list)
    for r in _reader(z, "stop_times.txt"):
        if r["trip_id"] in trips:
            seqs[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"]))
    used = {s for rows in seqs.values() for _, s in rows}
    stops = {s["stop_id"]: [float(s["stop_lon"]), float(s["stop_lat"]), s["stop_name"].strip()]
             for s in _reader(z, "stops.txt") if s["stop_id"] in used}
    out = {"stops": stops,
           "trips": {tid: [trips[tid]["route_id"], trips[tid]["trip_headsign"], [s for _, s in sorted(rows)]]
                     for tid, rows in seqs.items()}}
    cache.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(cache, "wt") as f:
        json.dump(out, f, separators=(",", ":"))
    return out


def trips_for(day):
    """The trip cache of the newest saved schedule that had started by `day`, or None."""
    zips = sorted(STATIC_DIR.glob("surface-routes-and-schedules-for-bustime/*.zip"))
    started = [z for z in zips if headways._snapshot_cache(z)["feed_start"] <= day.replace("-", "")]
    if not started:
        return None
    return _trip_cache(max(started, key=lambda z: headways._snapshot_cache(z)["feed_start"]))


def _direction(headsign):
    """("West", "Dundas West Station") from "West - 505 Dundas towards Dundas West Station"."""
    d, _, rest = headsign.partition(" - ")
    return d.strip(), rest.split(" towards ")[-1].strip() if " towards " in rest else ""


def detect(runs, sched, near_yard):
    """runs: {(vehicle, trip_id): [(t, x, y), ...] sorted}; near_yard(x, y) -> bool.
    Returns {"events": [...], "routes": {route: {"runs", "short", "early"}}}."""
    stop_xy = {sid: to_xy(lon, lat) for sid, (lon, lat, _) in sched["stops"].items()}
    by_car = defaultdict(list)
    for (vid, tid), pts in runs.items():
        if pts:
            by_car[vid].append((pts[0][0], tid, pts))
    events, counts = [], defaultdict(lambda: {"runs": 0, "short": 0, "early": 0})
    for vid, rs in by_car.items():
        rs.sort()
        for k, (_, tid, pts) in enumerate(rs):
            trip = sched["trips"].get(tid)
            if not trip:
                continue
            route, headsign, sids = trip
            xy = [stop_xy[s] for s in sids]
            cum = [0.0]
            for a, b in zip(xy, xy[1:]):
                cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]) / 1000)
            best = first = None
            t_best = None
            for t, x, y in pts:
                lo = 0 if best is None else max(0, best - 3)
                hi = len(xy) if best is None else min(len(xy), best + LOOKAHEAD)
                for i in range(lo, hi):
                    if (best is None or i > best) and math.hypot(x - xy[i][0], y - xy[i][1]) < NEAR_M:
                        best, t_best = i, t
                        first = i if first is None else first
            if best is None or cum[best] - cum[first] < MIN_RUN_KM:
                continue
            route = NIGHT_TWIN.get(route, route)
            c = counts[route]
            c["runs"] += 1
            left = cum[-1] - cum[best]
            if left <= SHORT_KM:
                continue
            last = pts[-1]
            if near_yard(last[1], last[2]):
                continue
            # Turned back: soon after, it passes a stop of this trip well behind the furthest
            # one. A new trip number alone isn't enough: the feed sometimes relabels a car
            # mid-route, and it just carries on.
            later = []
            for _, _, q in rs[k + 1:]:
                if q[0][0] - last[0] > NEXT_S:
                    break
                later += [p for p in q if p[0] - last[0] <= NEXT_S]
            if not later:
                c["early"] += 1
                continue
            back = [xy[i] for i in range(best) if BACK_KM <= cum[best] - cum[i] <= BACK_KM + 3]
            if not any(math.hypot(x - bx, y - by) < NEAR_M for _, x, y in later for bx, by in back):
                continue
            c["short"] += 1
            d, to = _direction(headsign)
            lon, lat, name = sched["stops"][sids[best]]
            events.append({"r": route, "d": d, "to": to, "stop": sids[best], "name": name,
                           "lon": round(lon, 5), "lat": round(lat, 5), "t": int(t_best), "v": vid,
                           "left": round(left, 1)})
    events.sort(key=lambda e: e["t"])
    return {"events": events, "routes": dict(counts)}
