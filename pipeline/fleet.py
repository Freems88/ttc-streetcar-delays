"""Cars in service: how many streetcars (and buses) ran each route, against the schedule.

Actual: the feed lists every vehicle signed on to a trip, refreshed about every 30 s.
For each 10-minute bucket of the service day (04:00 onward) we average, over the fetches
in it, how many distinct streetcars and buses each route had. Cars going to or from the
yard, or parked, aren't in the feed, so this is cars carrying passengers.

Scheduled: from the static GTFS in effect, each block (one vehicle's day of work) is in
service from a trip's first departure until the next trip of the block starts, or until
that trip's last arrival if the next one is more than BLOCK_GAP_S later (the vehicle
goes back to the yard in between). Trips marked "Replacement Bus" count as buses.

Both come out as {route: {"car": [N_BUCKETS], "bus": [N_BUCKETS]}}; actual buckets with
no logging are None.
"""
from collections import defaultdict

import headways
from common import NIGHT_TWIN

BUCKET_S = 600
N_BUCKETS = 144     # 24 h from 04:00
BLOCK_GAP_S = 1800  # a block idle longer than this between trips is out of service


def actual(per_fetch, day):
    """per_fetch: {fetch_ts: {(route, kind): number of distinct vehicles}}."""
    lo, _ = headways.day_bounds(day)
    sums = defaultdict(lambda: defaultdict(lambda: [0.0] * N_BUCKETS))
    fetches = [0] * N_BUCKETS
    for ts, counts in per_fetch.items():
        b = int((ts - lo) // BUCKET_S)
        if not 0 <= b < N_BUCKETS:
            continue
        fetches[b] += 1
        for (route, kind), n in counts.items():
            sums[route][kind][b] += n
    out = {}
    for route, kinds in sums.items():
        out[route] = {kind: [round(kinds[kind][b] / fetches[b], 1) if fetches[b] else None
                             for b in range(N_BUCKETS)] for kind in ("car", "bus")}
    return out


def scheduled(day):
    """None if no saved schedule covers the day."""
    found = headways.service_dates(day)
    if found is None:
        return None
    snap, dates = found
    lo, hi = headways.day_bounds(day)
    blocks = defaultdict(list)  # (date offset, block) -> [(start, end, route, kind)]
    for k, base, sids in dates:
        for sid in sids:
            for route, block, start, end, bus in snap.get("trips", {}).get(sid, []):
                blocks[(k, block)].append((base + start, base + end, NIGHT_TWIN.get(route, route),
                                           "bus" if bus else "car"))
    if not any(k == 0 for k, _ in blocks):
        return None
    out = defaultdict(lambda: {"car": [0.0] * N_BUCKETS, "bus": [0.0] * N_BUCKETS})
    for trips in blocks.values():
        trips.sort()
        for i, (start, end, route, kind) in enumerate(trips):
            nxt = trips[i + 1][0] if i + 1 < len(trips) else None
            # In service until the next trip starts, unless the gap means a trip to the yard.
            stop = nxt if nxt is not None and nxt - end <= BLOCK_GAP_S else end
            a, z = max(start, lo), min(stop, hi)
            row = out[route][kind]
            while a < z:
                b = int((a - lo) // BUCKET_S)
                edge = min(z, lo + (b + 1) * BUCKET_S)
                if b < N_BUCKETS:
                    row[b] += (edge - a) / BUCKET_S
                a = edge
    return {r: {k: [round(v, 1) for v in row] for k, row in kinds.items()} for r, kinds in out.items()}
