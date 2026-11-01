"""Headway regularity: how evenly cars actually arrive at each stop, against the schedule.

process_day records when every vehicle on a streetcar route (buses included: riders
board those too) leaves each stop on the track. Here those times become headways, the
gap between one car and the next on the same route at the same stop, and are set
against the scheduled headways from the static GTFS in effect that day.

Per stop, route and hour key (0-23 weekday, 24-47 weekend, like the delay data) we keep
sums the page combines over any time selection:

  n, sh, sh2    observed headways: count, sum, sum of squares (seconds)
  nb, ng        bunched (under half the scheduled headway) and gaps (over 1.5x)
  shm, sd2      sum of the scheduled headway each observed one is set against, and of
                (observed - scheduled)^2, for the TCQSM headway coefficient of variation
  ns, shs, shs2 scheduled headways: count, sum, sum of squares

From those: average wait for a rider turning up at random, sh2 / (2 sh), against the
scheduled wait, shs2 / (2 shs); the difference is TfL's excess wait time. Only frequent
service counts (scheduled every 12 minutes or better at both ends of the headway), as
TfL and the TCQSM do. Headways that span a gap in logging are left out on both sides.
"""
import bisect
import csv
import gzip
import io
import json
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta

from common import NIGHT_TWIN, STATIC_DIR, WORK_DIR

FREQUENT_S = 720     # scheduled headway at or under this counts as frequent service
LOG_GAP_S = 300      # no positions fetched for longer than this = a gap in logging
SAME_CAR_S = 300     # the same vehicle leaving the same stop again this soon is one departure
BUNCHED, GAP = 0.5, 1.5
DEPART_M = 15        # time a car passes this far beyond the stop: it's moving again by then
FIELDS = ["n", "sh", "sh2", "nb", "ng", "shm", "sd2", "ns", "shs", "shs2"]


def _reader(z, name):
    (member,) = [n for n in z.namelist() if n.endswith("/" + name) or n == name]
    return csv.DictReader(io.TextIOWrapper(z.open(member), "utf-8-sig"))


def _secs(hms):
    h, m, s = map(int, hms.split(":"))
    return h * 3600 + m * 60 + s


def _snapshot_cache(zpath):
    """Scheduled departures for streetcar routes in one static GTFS file, cached:
    {"feed_start", "calendar", "dates", "deps": {service: {route: {stop: [secs]}}}}."""
    cache = WORK_DIR / "sched" / (zpath.stem + ".json.gz")
    if cache.exists():
        with gzip.open(cache, "rt") as f:
            return json.load(f)
    z = zipfile.ZipFile(zpath)
    routes = {r["route_id"] for r in _reader(z, "routes.txt") if r["route_type"] == "0"}
    trips = {t["trip_id"]: (NIGHT_TWIN.get(t["route_id"], t["route_id"]), t["service_id"])
             for t in _reader(z, "trips.txt") if t["route_id"] in routes}
    deps = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for r in _reader(z, "stop_times.txt"):
        tr = trips.get(r["trip_id"])
        if tr and r["departure_time"]:
            deps[tr[1]][tr[0]][r["stop_id"]].append(_secs(r["departure_time"]))
    for sv in deps.values():
        for rt in sv.values():
            for times in rt.values():
                times.sort()
    out = {
        "feed_start": next(_reader(z, "feed_info.txt"), {}).get("feed_start_date", ""),
        "calendar": list(_reader(z, "calendar.txt")),
        "dates": list(_reader(z, "calendar_dates.txt")),
        "deps": deps,
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(cache, "wt") as f:
        json.dump(out, f, separators=(",", ":"))
    return out


def _services(snap, date):
    """Service ids running on a date (YYYYMMDD)."""
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][
        datetime.strptime(date, "%Y%m%d").weekday()]
    on = {c["service_id"] for c in snap["calendar"]
          if c["start_date"] <= date <= c["end_date"] and c[wd] == "1"}
    for d in snap["dates"]:
        if d["date"] == date:
            (on.add if d["exception_type"] == "1" else on.discard)(d["service_id"])
    return on


def schedule(day):
    """{(route, stop): sorted departure timestamps} for service day `day` (04:00 to 04:00),
    from the newest saved schedule that had started by then. None if no saved schedule
    covers the day."""
    zips = sorted(STATIC_DIR.glob("surface-routes-and-schedules-for-bustime/*.zip"))
    snaps = [s for s in (_snapshot_cache(z) for z in zips) if s["feed_start"] <= day.replace("-", "")]
    if not snaps:
        return None
    snap = max(snaps, key=lambda s: s["feed_start"])
    d0 = datetime.strptime(day, "%Y-%m-%d")
    lo, hi = (d0 + timedelta(hours=4)).timestamp(), (d0 + timedelta(hours=28)).timestamp()
    out = defaultdict(list)
    found = False
    # Trips of the previous and next service dates can fall inside this 04:00-04:00 day.
    for k in (-1, 0, 1):
        date = d0 + timedelta(days=k)
        # GTFS times count from noon minus 12 h, which keeps them right across DST changes.
        base = date.replace(hour=12).timestamp() - 43200
        for sid in _services(snap, date.strftime("%Y%m%d")):
            for route, stops in snap["deps"].get(sid, {}).items():
                for stop, times in stops.items():
                    for s in times:
                        t = base + s
                        if lo <= t < hi:
                            out[(route, stop)].append(t)
                            found = found or k == 0
    if not found:
        return None
    for v in out.values():
        v.sort()
    return out


def logged_spans(fetch_times):
    """[(start, end)] stretches of continuous logging from the sorted fetch timestamps."""
    spans = []
    for t in fetch_times:
        if spans and t - spans[-1][1] <= LOG_GAP_S:
            spans[-1][1] = t
        else:
            spans.append([t, t])
    return spans


def _within(spans, starts, a, b):
    i = bisect.bisect_right(starts, a) - 1
    return i >= 0 and b <= spans[i][1]


def summarize(day, departures, fetch_times, hour_key, track_stops):
    """departures: {(route, stop): [(t, vehicle)]}. Returns ({stop: {route: {hour key: [FIELDS]}}},
    {stop: [routes not run there that day]}), or None when no saved schedule covers the day.

    A stop where fewer than a third of the scheduled cars on a route showed up that day was
    most likely off the route (a diversion, or buses off the track); it's left out of the
    measures for that day, not counted as one very long wait, and listed separately."""
    sched = schedule(day)
    if sched is None:
        return None
    spans = logged_spans(fetch_times)
    starts = [s for s, _ in spans]
    out = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0] * len(FIELDS))))
    off = defaultdict(list)

    for (route, stop), st in sched.items():
        if stop not in track_stops or len(st) < 2:
            continue
        # One departure per car: drop repeats of the same vehicle (a trip id change, or
        # a stop on two overlapping pieces of track).
        last_of, kept = {}, []
        for t, vid in sorted(departures.get((route, stop), ())):
            if t - last_of.get(vid, -1e9) > SAME_CAR_S:
                kept.append(t)
            last_of[vid] = t

        def sched_headway(t):
            i = bisect.bisect_right(st, t)
            return st[i] - st[i - 1] if 0 < i < len(st) else None

        rows = defaultdict(lambda: [0] * len(FIELDS))
        for a, b in zip(st, st[1:]):
            h = b - a
            if h <= FREQUENT_S and _within(spans, starts, a, b):
                row = rows[hour_key(b, day)]
                row[7] += 1
                row[8] += h
                row[9] += h * h
        n_sched = sum(r[7] for r in rows.values())
        if not n_sched:
            continue
        for a, b in zip(kept, kept[1:]):
            hs, hs0 = sched_headway(b), sched_headway(a)
            if hs is None or hs0 is None or hs > FREQUENT_S or hs0 > FREQUENT_S:
                continue
            if not _within(spans, starts, a, b):
                continue
            h = b - a
            row = rows[hour_key(b, day)]
            row[0] += 1
            row[1] += h
            row[2] += h * h
            row[3] += h < BUNCHED * hs
            row[4] += h > GAP * hs
            row[5] += hs
            row[6] += (h - hs) ** 2
        if sum(r[0] for r in rows.values()) < n_sched / 3:
            off[stop].append(route)
            continue
        out[stop][route] = {h: [round(v) for v in row] for h, row in rows.items()}
    return {s: dict(rs) for s, rs in out.items()}, dict(off)
