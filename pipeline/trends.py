"""Daily trend series for the Trends page: one value per route per day, for several measures
and time-of-day bands, all measured against the SAME baseline (the current window's clean
runs and signal-approach clean times) so days compare fairly. Rebuilt in full every night,
so past days shift a little while the baseline settles.

Bands: "all" (everything but overnight), "am" (weekday 6-10) and "pm" (weekday 3-7 pm).
Weekends only have "all".

Measures, per route:
  delay  minutes a typical trip loses to delays: the sum over the route's slices of the day's
         mean time minus the clean run, scaled up to the whole route from the share measured
         (needs half the route), averaged over its directions
  sig    average seconds a streetcar loses per signal it approaches, beyond that approach's
         clean time; and held, the share held 90 s+. Approaches with a stop in them are left
         out (boarding time would count as signal delay). Split by transit priority: "tsp",
         "notsp", "any". The two splits are different signals, so compare each with itself
         over time rather than with each other.
  ewt    excess wait at stops, minutes (as the waits view, over all the route's stops)
  short  share of trips short-turned (all day only)
  fleet  vehicle-hours of streetcars run as a share of those scheduled
"""
from datetime import date

BANDS = {"all": None, "am": (6, 10), "pm": (15, 19)}
SLOTS = {"all": ("am", "mid", "pm", "eve", "wkend"), "am": ("am",), "pm": ("pm",)}
MIN_PASSES = 3        # a slice needs this many passes in a band to count that day
MIN_COVERAGE = 0.5    # share of a direction's slices measured for its delay to count
HELD_S = 90
MIN_APPROACH = 20     # signal passes a route needs in a band for its held share to count
MIN_HEADWAYS = 20
FLEET_BUCKET_S = 600  # fleet.py buckets, from 04:00


def _hours(band, weekend):
    """Hour keys (0-23 weekday, 24-47 weekend) in a band, or None if the band doesn't apply."""
    if band == "all":
        return [h + (24 if weekend else 0) for h in range(24)]
    if weekend:
        return None
    a, b = BANDS[band]
    return list(range(a, b))


def _r(x, n=2):
    return None if x is None else round(x, n)


def day_rows(d, network, clean, approaches, on_route=None):
    """{route: {measure: {band or split: value}}} for one day's processed results `d`."""
    weekend = date.fromisoformat(d["day"]).weekday() >= 5
    pid_of = [p["id"] for p in network["pieces"]]
    out = {}

    def put(route, measure, key, value):
        if value is not None:
            out.setdefault(route, {}).setdefault(measure, {})[key] = value

    # Delay per direction, then averaged per route.
    by_route = {}
    for pat in network.get("patterns", []):
        for band, slots in SLOTS.items():
            if band != "all" and weekend:
                continue
            lost, measured = 0.0, 0
            for pi, b in pat["slices"]:
                pid = pid_of[pi]
                c = (clean.get(pid) or [])
                if b >= len(c) or c[b] is None:
                    continue
                s = n = 0
                for slot in slots:
                    s += d["sums"].get(pid, {}).get(slot, {}).get(str(b), 0)
                    n += d["cnts"].get(pid, {}).get(slot, {}).get(str(b), 0)
                if n >= MIN_PASSES:
                    lost += s / n - c[b]
                    measured += 1
            if pat["slices"] and measured / len(pat["slices"]) >= MIN_COVERAGE:
                by_route.setdefault((pat["route"], band), []).append(lost / (measured / len(pat["slices"])) / 60)
    for (route, band), vals in by_route.items():
        put(route, "delay", band, _r(sum(vals) / len(vals)))

    # Held at signals, by transit priority.
    zones = d.get("zones", {})
    for band in BANDS:
        hours = _hours(band, weekend)
        if hours is None:
            continue
        tally = {}  # (route, split) -> [held, passes]
        for a in approaches:
            if a["stop_in_zone"]:
                continue
            hist = zones.get(f"{a['piece']}|{a['px']}")
            if not hist:
                continue
            held = passes = extra = 0
            for h in hours:
                for bucket, n in hist.get(str(h), {}).items():
                    lost = (int(bucket) + 0.5) * 10 - a["clean_s"]
                    passes += n
                    extra += n * max(0.0, lost)
                    if lost >= HELD_S:
                        held += n
            if not passes:
                continue
            for route in a["routes"]:
                for split in ("any", "tsp" if a["tsp"] else "notsp"):
                    t = tally.setdefault((route, split), [0, 0, 0.0])
                    t[0] += held
                    t[1] += passes
                    t[2] += extra
        for (route, split), (held, passes, extra) in tally.items():
            if passes >= MIN_APPROACH:
                put(route, "held", f"{split}-{band}", _r(held / passes, 3))
                put(route, "sig", f"{split}-{band}", _r(extra / passes, 1))

    # Excess wait at stops. Waits count every vehicle (riders take whatever comes), so a route
    # run mostly by buses that day (a full bus replacement, like the 503 in Nov 2026) is left out.
    heads = d.get("heads") or {}
    bus_day = {r for r, c in (d.get("routes") or {}).items()
               if c.get("bus", 0) > c.get("flex_on", 0) + c.get("flex_off", 0)}
    for band in BANDS:
        hours = _hours(band, weekend)
        if hours is None:
            continue
        sums = {}
        for stop, routes in heads.items():
            for route, by_hour in routes.items():
                if route in bus_day or (on_route is not None and stop not in on_route.get(route, ())):
                    continue  # bus-run day, or a stop off the route's streetcar path (build_site.route_stops)
                acc = sums.setdefault(route, [0] * 10)
                for h in hours:
                    row = by_hour.get(str(h))
                    if row:
                        for i in range(10):
                            acc[i] += row[i]
        for route, (n, sh, sh2, _, _, _, _, ns, shs, shs2) in sums.items():
            if n >= MIN_HEADWAYS and ns >= MIN_HEADWAYS and sh and shs:
                put(route, "ewt", band, _r((sh2 / (2 * sh) - shs2 / (2 * shs)) / 60))

    # Short turns (all day).
    for route, c in ((d.get("short_turns") or {}).get("routes") or {}).items():
        if c["runs"] >= 20:
            put(route, "short", "all", _r(c["short"] / c["runs"], 3))

    # Streetcars run vs scheduled.
    fl = d.get("fleet") or {}
    act, sch = fl.get("actual") or {}, fl.get("sched") or {}
    for band in BANDS:
        if band != "all" and weekend:
            continue
        a, b = (4, 28) if band == "all" else BANDS[band]
        lo, hi = (a - 4) * 3600 // FLEET_BUCKET_S, (b - 4) * 3600 // FLEET_BUCKET_S
        for route in set(act) & set(sch):
            ran = schd = 0.0
            for i in range(lo, min(hi, len(act[route]["car"]))):
                v, s = act[route]["car"][i], sch[route]["car"][i] if i < len(sch[route]["car"]) else None
                if v is None or s is None:
                    continue  # not logged then
                ran += v
                schd += s
            if schd >= 6:  # at least an hour of one scheduled car
                put(route, "fleet", band, _r(ran / schd, 3))
    return out


def build(days, load, network, clean, approaches, on_route=None):
    """days: sorted day strings; load(day) -> that day's processed results.
    Returns {"days": [...], "routes": {route: {measure: {key: [value per day]}}}}."""
    series = {}
    for i, day in enumerate(days):
        rows = day_rows(load(day), network, clean, approaches, on_route)
        for route, measures in rows.items():
            for m, vals in measures.items():
                for k, v in vals.items():
                    series.setdefault(route, {}).setdefault(m, {}).setdefault(k, [None] * len(days))[i] = v
    return {"days": days, "routes": series}
