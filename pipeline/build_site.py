#!/usr/bin/env python3
"""Combine daily slice statistics into the data files the map page reads.

For each window (last WINDOW_DAYS days, all time) and each 25 m slice:
  clean  = a clean run's seconds in the slice: the 10th-percentile pass through the
           slice, plus that stop interval's clean stopping time (10th-percentile
           interval time minus its slices' fast-pass times) placed around the stop
  mean   = average seconds-in-slice per time-of-day slot
  delay  = (mean - clean) per 100 m
Route summaries add those up along each route's current main pattern. Also writes a
per-route daily timeline (streetcars / buses / diverted) with the service alerts
seen that day.

Usage: build_site.py OUT_DIR   (copies site/ into OUT_DIR and writes OUT_DIR/data/)
"""
import gzip
import json
import re
import shutil
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from common import BIN_M, DATA_DIR, NIGHT_TWIN, SLOT_LABELS, SLOTS, WORK_DIR
from process_day import NB, bucket_mid

WINDOW_DAYS = 90
CLEAN_PCT = 0.10
MIN_SAMPLES = 3        # slices with fewer passes than this are left out
TIMELINE_DAYS = 90
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


def load_days():
    days = {}
    for p in sorted((WORK_DIR / "agg").glob("*.json.gz")):
        with gzip.open(p, "rt") as f:
            days[p.name[:10]] = json.load(f)
    return days


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


def window_stats(network, days):
    hist = defaultdict(lambda: defaultdict(lambda: [0] * NB))
    sums = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    cnts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    ihist = defaultdict(lambda: defaultdict(lambda: [0] * NB))
    seen_days = defaultdict(lambda: defaultdict(int))
    for d in days:
        for pid, bins in d["hist"].items():
            for b, h in bins.items():
                hb = hist[pid][int(b)]
                for k, n in h.items():
                    hb[int(k)] += n
                seen_days[pid][int(b)] += 1
        for pid, ints in d.get("ihist", {}).items():
            for i, h in ints.items():
                hi = ihist[pid][int(i)]
                for k, n in h.items():
                    hi[int(k)] += n
        for pid, slots in d["sums"].items():
            for s, bins in slots.items():
                for b, v in bins.items():
                    sums[pid][s][int(b)] += v
                    cnts[pid][s][int(b)] += d["cnts"][pid][s][b]

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
            h = hist[pid].get(b)
            if b not in fast:
                continue
            c = fast[b] + extra.get(b, 0.0)
            clean[b], n[b], ndays[b] = round(c, 2), sum(h), seen_days[pid][b]
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
        pieces[pid] = {"clean": clean, "n": n, "days": ndays, "slots": slot_out}

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
    return {"pieces": pieces, "routes": routes}


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


def load_alerts(span):
    """{day: {route: {alert key}}} plus "_texts": {alert key: {header, url}}."""
    out = defaultdict(lambda: defaultdict(set))
    texts = {}
    for d in span:
        for p in [DATA_DIR / "alerts" / f"{d}.jsonl", DATA_DIR / "alerts" / f"{d}.jsonl.gz"]:
            if not p.exists():
                continue
            opener = gzip.open if p.suffix == ".gz" else open
            with opener(p, "rt") as f:
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
                    routes = {NIGHT_TWIN.get(e.get("routeId", ""), e.get("routeId", ""))
                              for e in a.get("informedEntity", [])}
                    key = f"{ev['source']}:{ev['id']}"
                    # bustime headers are cut off at ~30 characters; prefer the description.
                    shown = desc if ev["source"] == "bustime" and desc else (header.strip(" –-") or desc)
                    texts[key] = {"text": shown[:300], "url": _text(a.get("url"))}
                    for r in routes:
                        out[d][r].add(key)
    out["_texts"] = texts
    return out


def _text(ts):
    if not ts:
        return ""
    tr = ts.get("translation", [])
    return next((t["text"] for t in tr if t.get("language", "en") == "en"), tr[0]["text"] if tr else "")


def update_history(stats, last_day):
    path = WORK_DIR / "history.json"
    hist = json.loads(path.read_text()) if path.exists() else {}
    hist[last_day] = {pid: r["clean_s"] for pid, r in stats["routes"].items() if r["clean_s"]}
    path.write_text(json.dumps(hist, separators=(",", ":")))
    return hist


def moved(hist, last_day, pid, back=14):
    """Change in a route's clean run vs `back` days ago (or the oldest record)."""
    days = sorted(d for d in hist if pid in hist[d])
    if len(days) < 2:
        return None
    target = (date.fromisoformat(last_day) - timedelta(days=back)).isoformat()
    older = [d for d in days if d <= target] or days[:1]
    then = older[-1]
    return {"since": then, "change_s": hist[last_day][pid] - hist[then][pid]} if then != last_day else None


def main():
    out = Path(sys.argv[1])
    network = json.loads((WORK_DIR / "network.json").read_text())
    days = load_days()
    if not days:
        sys.exit("no processed days")
    last = max(days)
    cutoff = (date.fromisoformat(last) - timedelta(days=WINDOW_DAYS - 1)).isoformat()

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE_SRC, out)
    data = out / "data"
    data.mkdir(exist_ok=True)

    windows = {"recent": [d for k, d in days.items() if k >= cutoff], "all": list(days.values())}
    stats = {w: window_stats(network, ds) for w, ds in windows.items()}
    hist = update_history(stats["recent"], last)
    for pid, r in stats["recent"]["routes"].items():
        r["moved"] = moved(hist, last, pid)
    for w, s in stats.items():
        (data / f"stats-{w}.json").write_text(json.dumps(s, separators=(",", ":")))

    tl, alert_texts = timeline(days, network)
    lite = {
        "bin_m": BIN_M,
        "pieces": [{k: p[k] for k in ("id", "routes", "bins", "stops", "length")} for p in network["pieces"]],
        "patterns": [{k: v for k, v in p.items()} for p in network["patterns"]],
    }
    (data / "network.json").write_text(json.dumps(lite, separators=(",", ":")))
    (data / "timeline.json").write_text(json.dumps({"routes": tl, "alerts": alert_texts}, separators=(",", ":")))

    def totals(ds):
        return {k: sum(d["stats"][k] for d in ds) for k in ("pings", "passes", "samples")}

    meta = {
        "generated": int(time.time()),
        "first_day": min(days), "last_day": last,
        "windows": {w: {"days": len(ds), "from": min(d["day"] for d in ds), **totals(ds)} for w, ds in windows.items()},
        "window_days": WINDOW_DAYS, "clean_pct": CLEAN_PCT, "min_samples": MIN_SAMPLES,
        "slots": SLOT_LABELS,
    }
    (data / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    size = sum(f.stat().st_size for f in data.iterdir())
    print(f"site built in {out}: {len(days)} days ({min(days)}..{last}), data {size / 1e6:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
