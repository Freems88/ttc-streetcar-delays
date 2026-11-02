#!/usr/bin/env python3
"""Combine daily slice statistics into the data files the map page reads.

For each window (yesterday, the last 7 / 30 / WINDOW_DAYS days) and each 25 m slice:
  clean  = a clean run's seconds in the slice: the 10th-percentile daytime pass
           through the slice, plus that stop interval's clean stopping time
           (10th-percentile interval time minus its slices' fast-pass times) placed
           around the stop
  mean   = average seconds-in-slice per time-of-day slot
  delay  = (mean - clean) per 100 m
Route summaries add those up along each route's current main pattern. Also writes a
per-route daily timeline (streetcars / buses / diverted) with the service alerts
seen that day.

Days are read one at a time, newest first, into running totals for each window, so
memory stays flat however long the archive gets. Along the way two data rules apply
(see docs/how-it-works.md, "Data rules"):
  - a stretch of track that had no streetcars for FRESH_GAP_DAYS logged days and then
    reopened only counts its data from after the reopening (rebuilt track, a long
    diversion: before and after never get averaged together)
  - each slice's last day with streetcars is kept, so the page can fade stale track

Usage: build_site.py OUT_DIR   (copies site/ into OUT_DIR and writes OUT_DIR/data/)
"""
import gzip
import hashlib
import json
import math
import re
import shutil
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import drafts
import fleet
import headways
import signals
import turns
from common import BIN_M, DATA_DIR, NIGHT_TWIN, SLOT_LABELS, SLOTS, WORK_DIR, service_day
from process_day import NB, bucket_mid

WINDOW_DAYS = 90
CLEAN_PCT = 0.10
MIN_SAMPLES = 3        # slices with fewer passes than this are left out
MIN_SIGNAL_PASSES = 20  # a signal counts once this many streetcar passes went through it (90 days)
TIMELINE_DAYS = 90
OBSERVED_DAYS = 3         # route patterns follow where cars actually ran over this many days
FRESH_GAP_DAYS = 14       # no streetcars for this many logged days, then service: a fresh record
STALE_DAYS = 3            # the page fades track with no streetcars for this many days
OBSERVED_SHARE = 0.3      # a slice is on the route if this share of its runs went through it
MIN_OBSERVED_RUNS = 30
END_FILL = 8              # route reaches within this many slices (200 m) of a piece end: run to it
OFF_MIN_PINGS = 300       # off-track warning: at least this many positions off known track,
OFF_MIN_SHARE = 0.03      # and this share of the route's positions
OFF_JUMP = 2.0            # "new" when this many times its usual share (else ongoing)
SITE_SRC = Path(__file__).resolve().parent.parent / "site"
ALERT_NOISE = re.compile(r"elevator|escalator|washroom|accessible entrance", re.I)


def percentile(hist, q):
    n = sum(hist)
    if not n:
        return None
    target, run = q * n, 0
    for b in range(NB):
        run += hist[b]
        if run >= target:
            return bucket_mid(b)
    return bucket_mid(NB - 1)


def load_day(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


class Acc:
    """Running totals for one window, filled one day at a time."""

    def __init__(self):
        self.hist = defaultdict(lambda: defaultdict(lambda: [0] * NB))
        self.ihist = defaultdict(lambda: defaultdict(lambda: [0] * NB))
        self.sums = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
        self.cnts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
        self.seen_days = defaultdict(lambda: defaultdict(int))
        self.hsums = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
        self.hcnts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
        self.heads = defaultdict(lambda: defaultdict(dict))
        self.heads_off = defaultdict(lambda: defaultdict(int))
        self.head_days = 0
        self.zones = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # "piece|px" -> hour -> bucket -> n
        self.zone_days = 0
        self.days = []  # each day's small summary (see main)

    def add(self, d, light, cut):
        """Add one day. `cut`: (piece, bin) slices whose data this day predates a long closure."""
        self.days.append(light)
        for pid, bins in d["hist"].items():
            for b, h in bins.items():
                if (pid, int(b)) in cut:
                    continue
                hb = self.hist[pid][int(b)]
                for k, n in h.items():
                    hb[int(k)] += n
                self.seen_days[pid][int(b)] += 1
        for pid, ints in d.get("ihist", {}).items():
            for i, h in ints.items():
                hi = self.ihist[pid][int(i)]
                for k, n in h.items():
                    hi[int(k)] += n
        for pid, slots in d["sums"].items():
            for sl, bins in slots.items():
                for b, v in bins.items():
                    if (pid, int(b)) in cut:
                        continue
                    self.sums[pid][sl][int(b)] += v
                    self.cnts[pid][sl][int(b)] += d["cnts"][pid][sl][b]
        for pid, hours in d.get("hsums", {}).items():
            for h, bins in hours.items():
                for b, v in bins.items():
                    if (pid, int(b)) in cut:
                        continue
                    self.hsums[pid][h][int(b)] += v
                    self.hcnts[pid][h][int(b)] += d["hcnts"][pid][h][b]
        if "zones" in d:
            self.zone_days += 1
            for key, hours in d["zones"].items():
                for h, buckets in hours.items():
                    acc = self.zones[key][int(h)]
                    for b, n in buckets.items():
                        acc[int(b)] += n
        if "heads" in d:
            self.head_days += 1
            for stop, routes in d["heads"].items():
                for route, hours in routes.items():
                    acc = self.heads[stop][route]
                    for h, row in hours.items():
                        row = list(row) + [0] * (len(headways.FIELDS) - len(row))  # days from before the spread was kept
                        acc[h] = [x + y for x, y in zip(acc[h], row)] if h in acc else row
            for stop, routes in d.get("heads_off", {}).items():
                for route in routes:
                    self.heads_off[stop][route] += 1


SPREAD = [1, 2, 3, 2, 1]  # how a stop's clean stopping time is spread over slices around it


def stop_allowance(piece, fast, ihist):
    """{bin: seconds} of clean-run stopping time (dwell, braking, pulling away) around each stop."""
    stops = [s["along"] for s in piece["stops"]]
    bounds = [(x + y) / 2 for x, y in zip(stops, stops[1:])]
    out = defaultdict(float)
    for k in range(len(bounds) - 1):
        h = ihist.get(k)
        if not h or sum(h) < MIN_SAMPLES:
            continue
        lo, hi = bounds[k], bounds[k + 1]
        bins = [b for b in range(int(lo // BIN_M), int(hi // BIN_M) + 1) if lo <= (b + 0.5) * BIN_M < hi]
        have = [b for b in bins if b in fast]
        if len(have) < 0.8 * len(bins):
            continue
        # Scale up for slices with no data so the comparison is like for like.
        moving = sum(fast[b] for b in have) * len(bins) / len(have)
        allowance = percentile(h, CLEAN_PCT) - moving
        if allowance <= 0:
            continue
        sb = int(stops[k + 1] // BIN_M)
        targets = [(sb + o, w) for o, w in zip(range(-2, 3), SPREAD) if sb + o in have]
        wsum = sum(w for _, w in targets)
        for b, w in targets:
            out[b] += allowance * w / wsum
    return out


def window_stats(network, acc, clean_from=None):
    """Slice and route stats over a window's running totals. With `clean_from` ({piece:
    clean list}), measure against that clean run instead of one computed from these days
    (for single days)."""
    hist, sums, cnts, ihist, seen_days = acc.hist, acc.sums, acc.cnts, acc.ihist, acc.seen_days
    days = acc.days

    pieces, clean_of, mean_of = {}, {}, {}
    for p in network["pieces"]:
        pid, nb = p["id"], len(p["bins"])
        clean, n, ndays = [None] * nb, [0] * nb, [0] * nb
        slot_out = {s: {"d": [None] * nb, "n": [0] * nb} for s in ["all"] + SLOTS}
        fast = {}
        for b in range(nb):
            h = hist[pid].get(b)
            if h and sum(h) >= MIN_SAMPLES:
                fast[b] = percentile(h, CLEAN_PCT)
        extra = stop_allowance(p, fast, ihist[pid])
        for b in range(nb):
            if clean_from is not None:
                c = (clean_from.get(pid) or [None] * nb)[b]
                if c is None or not any(cnts[pid][s].get(b) for s in SLOTS):
                    continue
            elif b in fast:
                c = fast[b] + extra.get(b, 0.0)
            else:
                continue
            h = hist[pid].get(b)
            clean[b], n[b], ndays[b] = round(c, 2), sum(h) if h else 0, seen_days[pid][b]
            clean_of[(pid, b)] = c
            tot_s = tot_n = 0
            for s in SLOTS:
                cn = cnts[pid][s].get(b, 0)
                if cn:
                    mean = sums[pid][s][b] / cn
                    slot_out[s]["d"][b] = round(max(0.0, mean - c) * 100 / BIN_M, 2)
                    slot_out[s]["n"][b] = cn
                    mean_of[(pid, b, s)] = mean
                    tot_s += sums[pid][s][b]
                    tot_n += cn
            mean = tot_s / tot_n
            mean_of[(pid, b, "all")] = mean
            slot_out["all"]["d"][b] = round(max(0.0, mean - c) * 100 / BIN_M, 2)
            slot_out["all"]["n"][b] = tot_n
        # Free-running time: the fast pass alone, without stop allowance (for the speed view).
        free = [round(fast[b], 2) if b in fast else None for b in range(nb)]
        pieces[pid] = {"clean": clean, "free": free, "n": n, "days": ndays, "slots": slot_out}

    routes = {}
    for pat in network["patterns"]:
        have = [(network["pieces"][pi]["id"], b) for pi, b in pat["slices"]]
        with_data = [k for k in have if k in clean_of]
        typical = {}
        for s in ["all"] + SLOTS:
            ks = [k for k in with_data if (k[0], k[1], s) in mean_of]
            if len(ks) >= 0.8 * len(have):
                # Fill slices with no data for this slot from the all-day mean, so totals stay comparable.
                typical[s] = round(sum(mean_of.get((k[0], k[1], s), mean_of[(k[0], k[1], "all")])
                                       for k in with_data))
        routes[pat["id"]] = {
            "clean_s": round(sum(clean_of[k] for k in with_data)) if with_data else None,
            "typical_s": typical,
            "data_coverage": round(len(with_data) / max(1, len(have)), 3),
            "samples": sum(pieces[k[0]]["n"][k[1]] for k in with_data),
        }
        r = routes[pat["id"]]
        r.update(service_per_day(pat, days, len(have)))
        if r["clean_s"] and "all" in typical and r["trips_per_day"] is not None:
            # Observed, not costed: hours a day of streetcar service spent beyond clean runs.
            r["hours_lost_per_day"] = round(r["trips_per_day"] * (typical["all"] - r["clean_s"]) / 3600, 1)
            r["ratio"] = round(typical["all"] / r["clean_s"], 2)
    return {"pieces": pieces, "routes": routes}


def observed_patterns(network, days):
    """Route patterns as cars actually ran them. The schedule's main pattern for a route and
    direction can be a diversion that isn't running yet (in November 2026 it had the 501
    via Gerrard and the 504 via Queen West), or miss one that is. So each pattern's slices
    become the ones at least OBSERVED_SHARE of that direction's runs went through over the
    last OBSERVED_DAYS days. Patterns with too few runs keep the schedule's slices."""
    recent = sorted((d for d in days if "pat_used" in d), key=lambda d: d["day"])[-OBSERVED_DAYS:]
    runs, used = defaultdict(int), defaultdict(lambda: defaultdict(int))
    for d in recent:
        for pid, n in d["pat_runs"].items():
            runs[pid] += n
        for pid, sl in d["pat_used"].items():
            for k, n in sl.items():
                used[pid][k] += n
    for pat in network["patterns"]:
        n = runs.get(pat["id"], 0)
        if n < MIN_OBSERVED_RUNS:
            continue
        keep = {k for k, c in used[pat["id"]].items() if c >= OBSERVED_SHARE * n}
        # A car's pass on a piece of track starts at its first position on it, often 50-100 m
        # in, so the first and last few slices of each piece are rarely fully crossed and fall
        # under the threshold (taking stops there with them). Fill small holes (up to END_FILL
        # slices) and run to a piece's end when the route comes that close to it. Only small
        # ones: a route can use both ends of a long piece and not the middle (the 504 uses
        # the station loops at either end of the piece along Dundas).
        by_piece = defaultdict(list)
        for k in keep:
            pi, b = map(int, k.split(":"))
            by_piece[pi].append(b)
        for pi, bins in by_piece.items():
            nb = len(network["pieces"][pi]["bins"])
            bins.sort()
            fill = set(range(0, bins[0])) if bins[0] <= END_FILL else set()
            if bins[-1] >= nb - 1 - END_FILL:
                fill.update(range(bins[-1] + 1, nb))
            for a, b in zip(bins, bins[1:]):
                if 1 < b - a <= END_FILL + 1:
                    fill.update(range(a + 1, b))
            keep.update(f"{pi}:{b}" for b in fill)
        sched = [tuple(x) for x in pat["slices"]]
        extra = sorted(tuple(map(int, k.split(":"))) for k in keep - {f"{pi}:{b}" for pi, b in sched})
        slices = [list(x) for x in sched if f"{x[0]}:{x[1]}" in keep] + [list(x) for x in extra]
        if len(slices) < 0.3 * len(sched):
            continue  # hardly any of it seen: bus-run or mostly off the track; keep the schedule's
        dropped = len(sched) - (len(slices) - len(extra))
        if dropped or extra:
            print(f"pattern {pat['id']}: observed route differs from the schedule's "
                  f"({dropped} slices not run, {len(extra)} added)", file=sys.stderr)
        pat["sched_slices"] = len(sched)
        pat["slices"] = slices
        pat["length"] = len(slices) * BIN_M
        pat["observed"] = True


def service_per_day(pat, days, n_slices):
    """Full trips' worth of service a day on a pattern: slices runs covered ÷ pattern length,
    over finished days, counting partly logged days by the hours actually logged."""
    today = service_day(time.time())
    finished = [d for d in days if d["day"] < today]
    logged_days = sum(min(1.0, d["stats"].get("logged_h", 0) / 24) for d in finished)
    if pat.get("observed") and all("pat_cover" in d for d in finished):
        covered = sum(d["pat_cover"].get(pat["id"], 0) for d in finished)
        return {"trips_per_day": round(covered / n_slices / logged_days, 1) if logged_days >= 0.25 and n_slices else None}
    covered = sum(d["routes"].get(pat["route"], {}).get("cover", {}).get(pat["id"], 0) for d in finished)
    if logged_days < 0.25 or not n_slices or not any("cover" in r for d in finished for r in d["routes"].values()):
        return {"trips_per_day": None}
    return {"trips_per_day": round(covered / n_slices / logged_days, 1)}


def match_turns(sigs, used):
    """{signal index: [turn ban, ...]} by matching the by-law's street pair to the signal's
    streets. 'No turn on red' entries are left out: they're everywhere and say little
    about what holds streetcars up."""
    index = turns.by_intersection(turns.load())
    out = {}
    for i in used:
        names = [turns.norm(s) for s in sigs[i]["streets"]]
        seen, found = set(), []
        for a in range(len(names)):
            for b in range(a + 1, len(names)):
                for ban in index.get(frozenset((names[a], names[b])), []):
                    if re.search(r"shows red", ban["when"], re.I):
                        continue
                    key = (ban["direction"], ban["turn"], ban["when"])
                    if key not in seen:
                        seen.add(key)
                        found.append({"dir": ban["direction"], "turn": ban["turn"], "when": ban["when"],
                                      "ttc_exempt": ban["ttc_exempt"]})
        if found:
            out[i] = found
    return out


def hour_stats(network, acc):
    """Per piece and hour key (0-23 weekday, 24-47 weekend): [passes per slice, mean seconds
    per slice]. The page sums whichever hours the time-of-day controls select."""
    sums, cnts = acc.hsums, acc.hcnts
    out = {}
    for p in network["pieces"]:
        pid, nb = p["id"], len(p["bins"])
        if pid not in cnts:
            continue
        out[pid] = {}
        for h, bins in cnts[pid].items():
            n = [0] * nb
            mean = [0] * nb
            for b, c in bins.items():
                bi = int(b)
                if bi < nb and c:
                    n[bi] = c
                    mean[bi] = round(sums[pid][h][b] / c, 1)
            out[pid][h] = [n, mean]
    return {"pieces": out}


def headway_stats(acc):
    """Per stop, route and hour key: the headway sums from headways.py added up over the
    window's days (only days a saved schedule covered have them), plus how many of those
    days each stop wasn't served on its route (diverted, or buses off the track)."""
    return {"days": acc.head_days, "stops": acc.heads, "off": acc.heads_off}


def fleet_stats(days):
    """Cars in service per route: an average day by 10-minute bucket (weekdays and weekends),
    and per day the vehicle-hours run against those scheduled. Compared only over buckets
    that were logged; once any day in the window has a saved schedule, only such days count,
    so actual and scheduled cover the same days."""
    with_sched = [d for d in days if d.get("fleet", {}).get("sched")]
    use = with_sched or [d for d in days if "fleet" in d]
    nb = fleet.N_BUCKETS
    prof = {k: defaultdict(lambda: {f: [0.0] * nb for f in ("car", "bus", "scar", "sbus")}) for k in ("wd", "we")}
    n_days = {k: [0] * nb for k in ("wd", "we")}
    per_day = []
    for d in use:
        act, sch = d["fleet"]["actual"], d["fleet"].get("sched") or {}
        kind = "we" if date.fromisoformat(d["day"]).weekday() >= 5 else "wd"
        logged = [any(v["car"][b] is not None for v in act.values()) for b in range(nb)]
        totals = defaultdict(lambda: [0.0] * 4)
        for b in range(nb):
            if not logged[b]:
                continue
            n_days[kind][b] += 1
            for route in set(act) | set(sch):
                a, sc = act.get(route), sch.get(route)
                row = prof[kind][route]
                t = totals[route]
                for i, (f, src, k) in enumerate((("car", a, "car"), ("bus", a, "bus"), ("scar", sc, "car"), ("sbus", sc, "bus"))):
                    v = (src[k][b] or 0) if src else 0
                    row[f][b] += v
                    t[i] += v * fleet.BUCKET_S / 3600
        per_day.append({"day": d["day"], "logged": round(sum(logged) / nb, 2), "sched": bool(sch),
                        "routes": {r: [round(x, 1) for x in t] for r, t in totals.items()}})
    profile = {}
    for kind, routes in prof.items():
        n = n_days[kind]
        profile[kind] = {r: {f: [round(v / n[b], 1) if n[b] else None for b, v in enumerate(vals)]
                             for f, vals in row.items()} for r, row in routes.items()}
    return {"sched_days": len(with_sched), "days_used": {k: max(v) if v else 0 for k, v in n_days.items()},
            "profile": profile, "days": per_day}


HELD_S = (60, 90, 120)   # "held": this much longer than the approach's clean run (90 = about a cycle)
MIN_APPROACH_PASSES = 30


def approach_stats(acc, network, sigs, piece_routes):
    """Per signal approach (one direction of track into one signal): passes, the clean
    approach time (10th percentile of daytime passes), median and 90th-percentile delay
    beyond it, the share of passes held for more than HELD_S seconds beyond it (90 s is
    about one signal cycle: a car held that long missed the first green it could have
    made), and streetcar-hours a day lost there. Flags approaches with a stop in the zone
    (boarding mixed in) or the next signal within 120 m (queues may spill back from it)."""
    by_px = {s["px"]: s for s in sigs}
    pieces = {p["id"]: (pi, p) for pi, p in enumerate(network["pieces"])}
    # Routes at each slice (a piece can carry more routes than pass any one signal on it).
    slice_routes = defaultdict(set)
    for pat in network["patterns"]:
        for pi, b in pat["slices"]:
            slice_routes[(pi, b)].add(pat["route"])
    zones = signals.approach_zones(network["pieces"], sigs)
    days = max(1, acc.zone_days)
    out = []
    for key, hours in acc.zones.items():
        pid, px = key.split("|")
        if pid not in pieces or px not in by_px:
            continue
        pi, p = pieces[pid]
        zone = next((z for z in zones[pi] if z[0] == px), None)
        if zone is None:
            continue
        _, lo, hi, a = zone
        allh, day = defaultdict(int), defaultdict(int)
        for h, buckets in hours.items():
            for b, n in buckets.items():
                allh[b] += n
                if h % 24 >= 6:
                    day[b] += n
        n = sum(allh.values())
        if n < MIN_APPROACH_PASSES or not day:
            continue
        cum, target, clean_b = 0, 0.1 * sum(day.values()), 0
        for b in sorted(day):
            cum += day[b]
            if cum >= target:
                clean_b = b
                break
        clean = (clean_b + 0.5) * 10
        delays = sorted(((max(0.0, (b + 0.5) * 10 - clean), c) for b, c in allh.items()))

        def pct(q):
            k, run = q * n, 0
            for dl, c in delays:
                run += c
                if run >= k:
                    return dl
            return delays[-1][0]
        b_sig = min(len(p["bins"]) - 1, int(a // BIN_M))
        b0, b1 = max(0, int(lo // BIN_M)), min(len(p["bins"]) - 1, int(hi // BIN_M))
        nxt = [z for z in zones[pi] if a < z[3] <= a + 120]
        out.append({
            "piece": pid, "px": px, "name": by_px[px]["name"], "tsp": by_px[px]["tsp"],
            "lonlat": by_px[px]["lonlat"],
            "routes": sorted(slice_routes.get((pi, b_sig)) or slice_routes.get((pi, b0)) or piece_routes.get(pi, [])),
            "dir": drafts.bound_word(drafts.compass(p["bins"][b0], p["bins"][b1])),
            "passes": n, "per_day": round(n / days, 1), "clean_s": round(clean),
            "median_s": round(pct(0.5)), "p90_s": round(pct(0.9)),
            "held": {str(t): round(sum(c for dl, c in delays if dl > t) / n, 3) for t in HELD_S},
            "hours_per_day": round(sum(dl * c for dl, c in delays) / days / 3600, 2),
            "stop_in_zone": any(lo <= st["along"] <= hi for st in p["stops"]),
            "next_signal_close": bool(nxt),
            "b": b_sig,
        })
    out.sort(key=lambda r: -r["hours_per_day"])
    return {"days": acc.zone_days, "held_thresholds": HELD_S, "approaches": out}


def offtrack_warnings(days, network, day):
    """Routes whose streetcars spent a good share of `day` off known track: most likely a
    diversion onto track no saved schedule has ever drawn, which the map can't show until
    the track is added. "new" if well above the route's usual share, else ongoing (a gap
    that has been there all along). Lists where, by ~100 m cell."""
    ordered = sorted(days)
    i = ordered.index(day)
    before = [days[k] for k in ordered[max(0, i - 14):i]]
    stops = [(s["lonlat"], s["name"]) for p in network["pieces"] for s in p["stops"]]
    out = []
    for route, v in sorted(days[day]["routes"].items()):
        on, off = v.get("flex_on", 0), v.get("flex_off", 0)
        if off < OFF_MIN_PINGS or off < OFF_MIN_SHARE * (on + off):
            continue
        share = off / (on + off)
        past = sorted(d["routes"][route]["flex_off"] / max(1, d["routes"][route]["flex_off"] + d["routes"][route]["flex_on"])
                      for d in before if route in d["routes"])
        usual = past[len(past) // 2] if past else None
        places = []
        for cell, n in list(v.get("off_cells", {}).items())[:5]:
            lat, lon = map(float, cell.split(","))
            near = min(stops, key=lambda s: (s[0][0] - lon) ** 2 + (s[0][1] - lat) ** 2)
            dist = math.hypot((near[0][0] - lon) * 80500, (near[0][1] - lat) * 111000)
            places.append({"lat": lat, "lon": lon, "n": n, "near": near[1], "near_m": round(dist)})
        out.append({"route": route, "share": round(share, 3), "usual": round(usual, 3) if usual is not None else None,
                    "new": usual is None or share >= OFF_JUMP * usual, "places": places})
    return out


def timeline(days, network):
    route_ids = sorted({p["route"] for p in network["patterns"]})
    last = max(days) if days else date.today().isoformat()
    span = [(date.fromisoformat(last) - timedelta(days=i)).isoformat() for i in range(TIMELINE_DAYS - 1, -1, -1)]
    alerts_by_day = load_alerts(span)
    out = {}
    for r in route_ids:
        rows = []
        for d in span:
            if d not in days:
                rows.append({"day": d, "status": "nodata"})
                continue
            c = days[d]["routes"].get(r, {"flex_on": 0, "flex_off": 0, "bus": 0})
            total = c["flex_on"] + c["flex_off"] + c["bus"]
            flex = c["flex_on"] + c["flex_off"]
            if total == 0:
                status = "none"
            elif c["bus"] / total >= 0.6:
                status = "bus"
            elif c["bus"] / total >= 0.15:
                status = "mixed"
            elif flex and c["flex_off"] / flex >= 0.25:
                status = "diverted"
            else:
                status = "normal"
            row = {"day": d, "status": status, "bus_share": round(c["bus"] / total, 2) if total else None,
                   "off_share": round(c["flex_off"] / flex, 2) if flex else None}
            al = alerts_by_day.get(d, {}).get(r)
            if al:
                row["alerts"] = sorted(al)
            rows.append(row)
        out[r] = rows
    return out, alerts_by_day.get("_texts", {})


MAX_ROUTES_UNNAMED = 4  # an alert tagged with more routes than this must name the route to count
SUBWAY = re.compile(r"^\W*Line \d", re.I)


def about_route(route, informed, text):
    """Whether an alert is really about `route`, not just tagged with it.

    The TTC tags subway alerts with every surface route serving the affected stations
    (Line 2 delays list 20+ routes, 504 included), so an alert counts if it names the
    route (or its overnight twin), or if it's a short list and not a subway alert.
    """
    numbers = {route} | {n for n, day in NIGHT_TWIN.items() if day == route}
    if any(re.search(rf"\b{n}\b", text) for n in numbers):
        return True
    return len(informed) <= MAX_ROUTES_UNNAMED and not SUBWAY.search(text)


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def load_alerts(span):
    """{day: {route: {alert group}}} plus "_texts": {alert group: {text, url}}.

    The same event often appears more than once: in both feeds, or re-issued under a
    new id when its text is updated ("...Shuttle buses are on the way."). Alerts whose
    text matches, or where one is the start of the other, are merged into one group
    showing the longest text.
    """
    out = defaultdict(lambda: defaultdict(set))
    groups = []  # [normalised text, {text, url}]

    def group_of(shown, url):
        n = _norm(shown)
        for i, (gn, g) in enumerate(groups):
            if len(min(n, gn, key=len)) >= 30 and (n.startswith(gn) or gn.startswith(n)):
                if len(n) > len(gn):
                    groups[i] = [n, {"text": shown, "url": url or g["url"]}]
                return f"a{i}"
        groups.append([n, {"text": shown, "url": url}])
        return f"a{len(groups) - 1}"

    for d in span:
        for p in [DATA_DIR / "alerts" / f"{d}.jsonl", DATA_DIR / "alerts" / f"{d}.jsonl.gz"]:
            if not p.exists():
                continue
            opener = gzip.open if p.suffix == ".gz" else open
            with opener(p, "rt", encoding="utf-8") as f:
                for line in f:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if ev.get("event") != "active":
                        continue
                    a = ev["alert"]
                    header = _text(a.get("headerText"))
                    desc = _text(a.get("descriptionText"))
                    if ALERT_NOISE.search(header + " " + desc):
                        continue
                    informed = {e.get("routeId", "") for e in a.get("informedEntity", [])} - {""}
                    key = f"{ev['source']}:{ev['id']}"
                    # bustime headers are cut off at ~30 characters; prefer the description.
                    shown = (desc if ev["source"] == "bustime" and desc else (re.sub(r"^\W+", "", header) or desc))[:300]
                    group = group_of(shown, _text(a.get("url")))
                    for r in {NIGHT_TWIN.get(x, x) for x in informed}:
                        if about_route(r, informed, header + " " + desc):
                            out[d][r].add(group)
    out["_texts"] = {f"a{i}": g for i, (_, g) in enumerate(groups)}
    return out


def _text(ts):
    if not ts:
        return ""
    tr = ts.get("translation", [])
    return next((t["text"] for t in tr if t.get("language", "en") == "en"), tr[0]["text"] if tr else "")


def pattern_sig(pat):
    """Fingerprint of a route pattern's track, so a routing change can be told apart."""
    return hashlib.sha1(json.dumps(pat["slices"]).encode()).hexdigest()[:10]


def update_history(stats, last_day, network):
    """Record each route's clean-run total for the day, with its pattern fingerprint."""
    path = WORK_DIR / "history.json"
    hist = json.loads(path.read_text()) if path.exists() else {}
    sigs = {p["id"]: pattern_sig(p) for p in network["patterns"]}
    hist[last_day] = {pid: {"c": r["clean_s"], "sig": sigs.get(pid)}
                      for pid, r in stats["routes"].items() if r["clean_s"]}
    path.write_text(json.dumps(hist, separators=(",", ":")))
    return hist


def moved(hist, last_day, pid, back=14):
    """Change in a route's clean-run total vs `back` days ago (or the oldest comparable record).

    Only days on the same routing count: a diversion changes the total because the route
    changed, not because service did. Old records without a fingerprint never match.
    """
    now = hist.get(last_day, {}).get(pid)
    if not isinstance(now, dict):
        return None
    days = sorted(d for d, rec in hist.items()
                  if d < last_day and isinstance(rec.get(pid), dict) and rec[pid]["sig"] == now["sig"])
    if not days:
        return None
    target = (date.fromisoformat(last_day) - timedelta(days=back)).isoformat()
    then = ([d for d in days if d <= target] or days[:1])[-1]
    return {"since": then, "change_s": now["c"] - hist[then][pid]["c"]}


def main():
    out = Path(sys.argv[1])
    network = json.loads((WORK_DIR / "network.json").read_text())
    paths = {p.name[:10]: p for p in sorted((WORK_DIR / "agg").glob("*.json.gz"))}
    if not paths:
        sys.exit("no processed days")
    last = max(paths)
    today = service_day(time.time())
    finished = [k for k in paths if k < today]
    yesterday = max(finished) if finished else None

    # Route patterns from the newest days first: day summaries below need them.
    newest = []
    for k in sorted(paths, reverse=True):
        d = load_day(paths[k])
        if "pat_used" in d:
            newest.append(d)
        if len(newest) == OBSERVED_DAYS:
            break
    observed_patterns(network, newest)
    del newest
    pat_keys = {pat["id"]: {f"{pi}:{b}" for pi, b in pat["slices"]} for pat in network["patterns"]}

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE_SRC, out)
    # GitHub Pages lets browsers cache files for 10 minutes; tag the script and stylesheet
    # with a hash of their contents so a changed file is fetched fresh.
    index = out / "index.html"
    html = index.read_text(encoding="utf-8")
    for name, attr in (("app.js", "src"), ("style.css", "href")):
        tag = hashlib.sha1((out / name).read_bytes()).hexdigest()[:10]
        html = html.replace(f'{attr}="{name}"', f'{attr}="{name}?v={tag}"')
    index.write_text(html, encoding="utf-8")
    data = out / "data"
    data.mkdir(exist_ok=True)

    # Windows offered on the page: yesterday (d1, measured against the 90-day clean run, as
    # one day is too little to set its own), the last 7 and 30 days, and the last
    # WINDOW_DAYS days ("recent", the default, which also feeds history, drafts and
    # screenshots). The 7/30/90-day windows include today while it's being logged.
    def start(n):
        return (date.fromisoformat(last) - timedelta(days=n - 1)).isoformat()
    starts = {"d7": start(7), "d30": start(30), "recent": start(WINDOW_DAYS)}
    accs = {w: Acc() for w in ("d1", "d7", "d30", "recent")}
    acc_today = Acc()
    logged = sorted(paths)
    index_of = {k: i for i, k in enumerate(logged)}
    last_active, cut, last_seen = {}, set(), {}
    light = {}  # day -> small summary kept for the whole build
    for k in sorted((k for k in paths if k >= starts["recent"]), reverse=True):
        d = load_day(paths[k])
        lt = {"day": k, "stats": d["stats"], "routes": d["routes"]}
        if "fleet" in d:
            lt["fleet"] = d["fleet"]
        if "pat_used" in d:
            lt["pat_cover"] = {pid: sum(n for s, n in d["pat_used"].get(pid, {}).items() if s in keys)
                               for pid, keys in pat_keys.items()}
        light[k] = lt
        # Fresh record: going back in time, a slice whose next newer day with streetcars is
        # FRESH_GAP_DAYS or more logged days away had a long closure; drop it from here back.
        day_cut = set()
        i = index_of[k]
        for pid, slots in d["cnts"].items():
            for b in {b for bins in slots.values() for b in bins}:
                sl = (pid, int(b))
                if sl in cut:
                    day_cut.add(sl)
                    continue
                newer = last_active.get(sl)
                if newer is not None and newer - i - 1 >= FRESH_GAP_DAYS:
                    cut.add(sl)
                    day_cut.add(sl)
                    continue
                last_active[sl] = i
                last_seen.setdefault(sl, k)
        for w, st in starts.items():
            if k >= st:
                accs[w].add(d, lt, day_cut)
        if k == yesterday:
            accs["d1"].add(d, lt, day_cut)
        if k == today:
            acc_today.add(d, lt, day_cut)
        del d
    if cut:
        print(f"fresh record: {len(cut)} slices count only data since reopening after a "
              f"{FRESH_GAP_DAYS}+ day closure", file=sys.stderr)
    if not accs["d1"].days:
        del accs["d1"]
    for acc in accs.values():
        acc.days.sort(key=lambda x: x["day"])

    stats = {w: window_stats(network, accs[w]) for w in ("d7", "d30", "recent")}
    clean_recent = {pid: p["clean"] for pid, p in stats["recent"]["pieces"].items()}
    if "d1" in accs:
        stats["d1"] = window_stats(network, accs["d1"], clean_from=clean_recent)
    hist = update_history(stats["recent"], last, network)
    for pid, r in stats["recent"]["routes"].items():
        r["moved"] = moved(hist, last, pid)
    for w, s in stats.items():
        (data / f"stats-{w}.json").write_text(json.dumps(s, separators=(",", ":")))
        (data / f"hours-{w}.json").write_text(json.dumps(hour_stats(network, accs[w]), separators=(",", ":")))
        (data / f"headways-{w}.json").write_text(json.dumps(headway_stats(accs[w]), separators=(",", ":")))
        (data / f"fleet-{w}.json").write_text(json.dumps(fleet_stats(accs[w].days), separators=(",", ":")))

    # The last finished service day, for the bot drafts and screenshot mode.
    if yesterday:
        ys = dict(stats["d1"], day=yesterday, stats=light[yesterday]["stats"])
        (data / "stats-yesterday.json").write_text(json.dumps(ys, separators=(",", ":")))
        warnings = offtrack_warnings(light, network, yesterday)
        (data / "offtrack.json").write_text(json.dumps({"day": yesterday, "warnings": warnings}, separators=(",", ":")))
        for w in warnings:
            where = "; ".join(f"{p['n']} near {p['near']}" for p in w["places"][:3])
            print(f"OFF-TRACK {yesterday} {w['route']}: {w['share']:.0%} of positions off known track "
                  f"(usually {w['usual'] if w['usual'] is not None else '?'}): {where}", file=sys.stderr)
    # The day still being logged (hourly refreshes process it), for so-far bot drafts.
    if acc_today.days:
        ts = dict(window_stats(network, acc_today, clean_from=clean_recent), day=today, stats=light[today]["stats"])
        (data / "stats-today.json").write_text(json.dumps(ts, separators=(",", ":")))

    # Days since streetcars last ran on each slice, for fading stale track on the page.
    ref = date.fromisoformat(last)
    ago = defaultdict(dict)
    for (pid, b), k in last_seen.items():
        ago[pid][b] = (ref - date.fromisoformat(k)).days
    lastseen = {"ref": last, "pieces": {}}
    for p in network["pieces"]:
        if p["id"] in ago:
            lastseen["pieces"][p["id"]] = [ago[p["id"]].get(b) for b in range(len(p["bins"]))]
    (data / "lastseen.json").write_text(json.dumps(lastseen, separators=(",", ":")))

    tl, alert_texts = timeline(light, network)
    # Label each slice stop / signal / both / elsewhere, keeping only signals that touch track.
    sigs = signals.load_signals()
    tagged = signals.tag_pieces(network["pieces"], sigs)
    # Only signals streetcars actually pass count. That drops signals on "track" that only
    # bus detours used (schedule patterns can follow a detour) and lines currently run by
    # buses; they come back once streetcars do.
    busiest = defaultdict(int)
    for p, (_, sig) in zip(network["pieces"], tagged):
        n = stats["recent"]["pieces"].get(p["id"], {}).get("slots", {}).get("all", {}).get("n", [])
        for b, i in enumerate(sig):
            if i >= 0:
                busiest[i] = max(busiest[i], n[b] if b < len(n) else 0)
    for tags, sig in tagged:
        for b, i in enumerate(sig):
            if i >= 0 and busiest[i] < MIN_SIGNAL_PASSES:
                tags[b] &= ~signals.SIGNAL
                sig[b] = -1
    used = sorted({i for _, s in tagged for i in s if i >= 0})
    remap = {i: k for k, i in enumerate(used)}
    signal_turns = match_turns(sigs, used)
    # Each piece's routes are the ones whose patterns (observed where possible) run on it;
    # pieces no pattern uses keep the routes of the schedule shapes that made them.
    piece_routes = defaultdict(set)
    for pat in network["patterns"]:
        for pi, _ in pat["slices"]:
            piece_routes[pi].add(pat["route"])
    lite = {
        "bin_m": BIN_M,
        "pieces": [{**{k: p[k] for k in ("id", "bins", "stops", "length")},
                    "routes": sorted(piece_routes[pi]) if pi in piece_routes else p["routes"],
                    # Track no streetcar has run on in the window (a bus-only routing) isn't drawn.
                    "seen": p["id"] in ago,
                    "tags": tags, "sig": [remap.get(i, -1) for i in sig]}
                   for pi, (p, (tags, sig)) in enumerate(zip(network["pieces"], tagged))],
        "patterns": [{k: v for k, v in p.items()} for p in network["patterns"]],
        "signals": [{**{k: sigs[i][k] for k in ("name", "tsp", "midblock", "lonlat")},
                     **({"turns": signal_turns[i]} if signal_turns.get(i) else {})} for i in used],
    }
    (data / "network.json").write_text(json.dumps(lite, separators=(",", ":")))
    ap = approach_stats(accs["recent"], network, sigs, piece_routes)
    (data / "signal-approaches.json").write_text(json.dumps(ap, separators=(",", ":")))
    clean_ap = [r for r in ap["approaches"] if not r["stop_in_zone"]]
    for title, rows in (("priority not delivering", [r for r in clean_ap if r["tsp"]]),
                        ("no priority, most held", [r for r in clean_ap if not r["tsp"]])):
        rows = sorted(rows, key=lambda r: -r["held"]["90"] * r["per_day"])[:8]
        print(f"APPROACHES {title}: " + "; ".join(
            f"{r['name']} {r['dir']} held {r['held']['90']:.0%} ({r['per_day']:.0f}/day)" for r in rows), file=sys.stderr)
    (data / "timeline.json").write_text(json.dumps({"routes": tl, "alerts": alert_texts}, separators=(",", ":")))

    def totals(ds):
        return {k: sum(d["stats"][k] for d in ds) for k in ("pings", "passes", "samples")}

    meta = {
        "generated": int(time.time()),
        "first_day": min(paths), "last_day": last,
        "windows": {w: {"days": len(a.days), "from": a.days[0]["day"], "headway_days": a.head_days, **totals(a.days)}
                    for w, a in accs.items()},
        "window_days": WINDOW_DAYS, "clean_pct": CLEAN_PCT, "min_samples": MIN_SAMPLES,
        "slots": SLOT_LABELS,
        "yesterday": yesterday,
        "stale_days": STALE_DAYS,
    }
    (data / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    size = sum(f.stat().st_size for f in data.iterdir())
    print(f"site built in {out}: {len(light)} days ({min(light)}..{last}), data {size / 1e6:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
