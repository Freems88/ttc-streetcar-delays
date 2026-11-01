#!/usr/bin/env python3
"""Write the bot's would-be posts for the last finished service day. Dry run: nothing is posted.

Up to five posts, each skipped when there's nothing worth saying:
  summary     hours streetcars lost to delay, worst and smoothest route
  segment     the slowest stop-centred segment (min passes), with a framed 3D image
  waits       excess wait at stops: network average, worst and steadiest route direction
  fleet       streetcars in service against the schedule: busiest moment, share of
              scheduled streetcar hours that ran, the route furthest short
  service     routes running buses or off their usual track, with the TTC's reason
Waits and fleet need a saved schedule for the day (from 2026-11-01).

Comparisons with "usual" only appear once the recent window holds MIN_NORMAL_DAYS days.

With today=True (hourly refreshes while data builds up) it drafts the service day so far
instead, into drafts/<day>-sofar/, redone every run and removed once the day's own
draft is written.

Usage: drafts.py SITE_DIR [--force] [--today]   (SITE_DIR is the built site, used for the image)
Writes WORK_DIR/drafts/<day>/draft.json (+ segment.png) and WORK_DIR/drafts/index.json.
"""
import functools
import gzip
import http.server
import json
import math
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import date
from pathlib import Path

import fleet
from common import BIN_M, WORK_DIR

DRAFTS = WORK_DIR / "drafts"
SITE_URL = "https://freems88.github.io/ttc-streetcar-delays/"
VENV_PY = Path.home() / "ttc-streetcars" / "venv" / "bin" / "python"
CAPTURE = Path(__file__).resolve().parent / "capture.py"
GRID = -17               # Toronto's street grid, degrees from north
MIN_PASSES = 30          # a segment needs this many passes yesterday to be named
MIN_NORMAL_DAYS = 7      # before this, no "usual" comparisons
POST_LIMIT = 300         # Bluesky's limit, in characters (graphemes)
KEEP_DAYS = 30
MIN_HEADWAYS = 20        # per stop and route, as on the page
MIN_WAIT_STOPS = 5       # a route direction needs this many measured stops to be named
MIN_LOGGED = 0.9         # fleet post only for days logged at least this fully
STATUS_TEXT = {"bus": "ran mostly with buses", "mixed": "ran partly with buses",
               "diverted": "was often off its usual track"}


def load(site, win):
    d = Path(site) / "data"
    get = lambda name: json.loads((d / name).read_text())
    return get("network.json"), get("stats-recent.json"), get(f"stats-{win}.json"), get("timeline.json"), get("meta.json")


def compass(lonlat_a, lonlat_b):
    dx = (lonlat_b[0] - lonlat_a[0]) * math.cos(math.radians(43.67))
    return math.degrees(math.atan2(dx, lonlat_b[1] - lonlat_a[1])) % 360


def bound_word(theta):
    """Direction of travel in Toronto terms (the street grid, not true north)."""
    rel = (theta - GRID) % 360
    return ["northbound", "eastbound", "southbound", "westbound"][int(((rel + 45) % 360) // 90)]


def split_stop(name):
    """'Spadina Ave at King St West North Side' -> ('Spadina Ave', 'King St West')."""
    name = re.sub(r"\s+(North|South|East|West|Far|Near)\s+Side$", "", name.strip(), flags=re.I)
    m = re.match(r"(.+?)\s+at\s+(.+)", name, flags=re.I)
    return (m.group(1), m.group(2)) if m else (name, "")


def segments(net):
    """Stop-centred segments: (piece, first bin, last bin, stop) between midpoints of neighbouring stops."""
    out = []
    for p in net["pieces"]:
        stops = p["stops"]
        bounds = [(a["along"] + b["along"]) / 2 for a, b in zip(stops, stops[1:])]
        for k in range(len(bounds) - 1):
            bins = [b for b in range(len(p["bins"])) if bounds[k] <= (b + 0.5) * BIN_M < bounds[k + 1]]
            if bins:
                out.append((p, bins[0], bins[-1], stops[k + 1]))
    return out


def seg_loss(stats, pid, b0, b1):
    """(seconds lost per car, passes) over slices b0..b1 for all day, or None if too patchy."""
    st = stats["pieces"].get(pid)
    if not st:
        return None
    d, n = st["slots"]["all"]["d"][b0:b1 + 1], st["slots"]["all"]["n"][b0:b1 + 1]
    have = [(x, m) for x, m in zip(d, n) if x is not None]
    if len(have) < 0.8 * len(d):
        return None
    lost = sum(x for x, _ in have) * BIN_M / 100 * len(d) / len(have)
    passes = sorted(m for _, m in have)[len(have) // 2]
    return lost, passes


def hours_lost(stats):
    total = 0.0
    for st in stats["pieces"].values():
        a = st["slots"]["all"]
        total += sum(x * BIN_M / 100 * m for x, m in zip(a["d"], a["n"]) if x is not None)
    return total / 3600


def route_losses(net, stats):
    """{pattern id: minutes a typical trip lost} for patterns measured well enough."""
    out = {}
    for pat in net["patterns"]:
        r = stats["routes"].get(pat["id"])
        if r and r.get("clean_s") and "all" in r.get("typical_s", {}) and r["data_coverage"] >= 0.8:
            out[pat["id"]] = (r["typical_s"]["all"] - r["clean_s"]) / 60
    return out


def summary_post(day_label, net, recent, yest, have_normal, partial=False):
    pats = {p["id"]: p for p in net["patterns"]}
    loss_y, loss_n = route_losses(net, yest), route_losses(net, recent)
    if not loss_y:
        return None
    label = lambda pid: f"{pats[pid]['route']} {pats[pid]['name']} {pats[pid]['direction'].lower()}"
    if have_normal:
        # Worst = most above its own usual; smoothest = lowest per km.
        worst = max((p for p in loss_y if p in loss_n), key=lambda p: loss_y[p] - loss_n[p], default=None)
    else:
        worst = max(loss_y, key=loss_y.get)
    best = min(loss_y, key=lambda p: loss_y[p] / max(1, pats[p]["length"]))
    lines = [f"{'So far today' if partial else 'Yesterday'} ({day_label}), Toronto streetcars spent {hours_lost(yest):,.0f} hours held up "
             f"beyond a clean run."]
    if worst:
        usual = f" (usually {loss_n[worst]:.0f})" if have_normal and worst in loss_n else ""
        lines.append(f"Worst: {label(worst)}, a typical trip lost {loss_y[worst]:.0f} min{usual}.")
    lines.append(f"Smoothest: {label(best)}, {loss_y[best]:.0f} min lost.")
    return {"kind": "summary", "text": "\n\n".join(lines[:1] + ["\n".join(lines[1:])]) + f"\n\n{SITE_URL}"}


def segment_post(day_label, net, recent, yest, have_normal, partial=False):
    best = None
    for p, b0, b1, stop in segments(net):
        y = seg_loss(yest, p["id"], b0, b1)
        if not y or y[1] < MIN_PASSES:
            continue
        if not best or y[0] > best[4][0]:
            best = (p, b0, b1, stop, y)
    if not best:
        return None
    p, b0, b1, stop, (lost, passes) = best
    street, cross = split_stop(stop["name"])
    direction = bound_word(compass(p["bins"][b0], p["bins"][b1]))
    sig = next((net["signals"][p["sig"][b]] for b in range(b0, b1 + 1) if p["sig"][b] >= 0), None)
    where = f"{street} {direction} approaching {cross}" if sig else f"{street} {direction} at {cross}"
    hours = lost * passes / 3600
    normal = seg_loss(recent, p["id"], b0, b1) if have_normal else None
    lines = [f"Slowest segment {'so far today' if partial else 'yesterday'}: {where}.",
             f"Each streetcar lost {lost:.0f} s here on average"
             + (f" (usually {normal[0]:.0f} s)" if normal else "")
             + f", over {passes} passes: {hours:.1f} hours in all."]
    if sig:
        lines.append("The signal here has transit priority." if sig["tsp"] else "The signal here has no transit priority.")
    shot = {"shot": "1", "win": "today" if partial else "yesterday", "piece": p["id"], "b0": b0, "b1": b1,
            "title": f"{street} {direction}, {'approaching' if sig else 'at'} {cross}",
            "sub": f"{day_label}: {lost:.0f} s lost per streetcar · {passes} passes"}
    alt = (f"3D map of {street} around {cross}, rotated to Toronto's street grid. Delay is drawn as a coloured "
           f"ridge above the track, rising where streetcars lose time; the {direction} segment at {cross} "
           f"is highlighted, peaking at about {lost:.0f} seconds lost per streetcar.")
    return {"kind": "segment", "text": "\n".join(lines), "alt": alt, "shot": shot}


def shorten(text, limit):
    """First sentence, cut at a word boundary to `limit` characters."""
    text = re.split(r"(?<=[.!?])\s", re.sub(r"^\W+", "", text))[0].rstrip(".")
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def service_post(day, day_label, net, timeline):
    names = {p["route"]: p["name"] for p in net["patterns"]}
    notes = []
    for route, rows in sorted(timeline["routes"].items()):
        row = next((r for r in rows if r["day"] == day), None)
        if not row or row["status"] not in STATUS_TEXT:
            continue
        reason = next((shorten(timeline["alerts"][a]["text"], 60) for a in row.get("alerts", [])
                       if timeline["alerts"].get(a, {}).get("text")), "")
        # The route's name usually leads the alert ("504 King: Detour...", or its night
        # twin's, "304 King: ..."); don't say it twice.
        reason = re.sub(r"^\d{3}\s+[^:]{1,30}:\s*", "", reason)
        notes.append(f"• {route} {names.get(route, '')} {STATUS_TEXT[row['status']]}"
                     + (f": {reason}" if reason else ""))
    if not notes:
        return None
    head = f"Service notes, {day_label}:"
    text, shown = head, 0
    for n in notes:
        if len(text) + len(n) + 1 > POST_LIMIT - 25:  # room for the "+N more" line
            break
        text += "\n" + n
        shown += 1
    if shown < len(notes):
        text += f"\n+{len(notes) - shown} more on the map"
    return {"kind": "service", "text": text}


def load_agg(day):
    path = WORK_DIR / "agg" / f"{day}.json.gz"
    if not path.exists():
        return {}
    with gzip.open(path, "rt") as f:
        return json.load(f)


def pattern_stops(net):
    """{pattern id: stop ids along it}."""
    out = {}
    for pat in net["patterns"]:
        on = {(pi, b) for pi, b in pat["slices"]}
        ids = []
        for pi in dict.fromkeys(pi for pi, _ in pat["slices"]):
            p = net["pieces"][pi]
            for s in p["stops"]:
                b = min(len(p["bins"]) - 1, int(s["along"] // BIN_M))
                if (pi, b) in on and s["id"] not in ids:
                    ids.append(s["id"])
        out[pat["id"]] = ids
    return out


def stop_wait(hours):
    """Excess wait etc. for one stop and route from its per-hour sums (see headways.py)."""
    if not hours:
        return None
    a = [sum(col) for col in zip(*hours.values())]
    n, sh, sh2, nb, ng, _, _, ns, shs, shs2 = a[:10]
    if n < MIN_HEADWAYS or ns < MIN_HEADWAYS:
        return None
    return {"n": n, "ns": ns, "nb": nb, "ewt": (sh2 / (2 * sh) - shs2 / (2 * shs)) / 60}


def waits_post(day_label, net, agg):
    heads = agg.get("heads")
    if not heads:
        return None
    pats = {p["id"]: p for p in net["patterns"]}
    every = [w for routes in heads.values() for hours in routes.values() if (w := stop_wait(hours))]
    if len(every) < 20:
        return None
    avg = sum(w["ewt"] for w in every) / len(every)
    per = {}
    for pid, ids in pattern_stops(net).items():
        ws = [w for s in ids if (w := stop_wait(heads.get(s, {}).get(pats[pid]["route"], {})))]
        if len(ws) >= MIN_WAIT_STOPS:
            per[pid] = {"ewt": sum(w["ewt"] for w in ws) / len(ws),
                        "bunched": sum(w["nb"] for w in ws) / sum(w["n"] for w in ws)}
    if len(per) < 2:
        return None
    label = lambda pid: f"{pats[pid]['route']} {pats[pid]['name']} {pats[pid]['direction'].lower()}"
    worst, best = max(per, key=lambda p: per[p]["ewt"]), min(per, key=lambda p: per[p]["ewt"])
    head = (f"Waiting at the stop, {day_label}: on frequent streetcar routes, riders waited "
            f"{avg:.1f} min longer than scheduled, on average.\n\n")
    worst_line = f"Worst: {label(worst)}, +{per[worst]['ewt']:.1f} min, with {per[worst]['bunched']:.0%} of cars bunched."
    best_line = f"\nSteadiest: {label(best)}, +{max(0, per[best]['ewt']):.1f} min."
    link = f"\n\n{SITE_URL}#v=wait"
    # Long route names can push it over the limit; the steadiest route goes first.
    text = head + worst_line + best_line + link
    if len(text) > POST_LIMIT:
        text = head + worst_line + link
    return {"kind": "waits", "text": text}


def fleet_post(day, day_label, net, agg, partial=False):
    fl = agg.get("fleet") or {}
    act, sch = fl.get("actual") or {}, fl.get("sched")
    if not sch or not act:
        return None
    nb = fleet.N_BUCKETS
    logged = [b for b in range(nb) if any(v["car"][b] is not None for v in act.values())]
    if len(logged) < (0.1 if partial else MIN_LOGGED) * nb:
        return None
    names = {p["route"]: p["name"] for p in net["patterns"]}
    hours = lambda arr: sum(arr[b] or 0 for b in logged) / 6
    cars = [sum(v["car"][b] or 0 for v in act.values()) for b in range(nb)]
    sched = [sum(v["car"][b] for v in sch.values()) for b in range(nb)]
    peak = max(logged, key=lambda b: cars[b])
    m = 240 + 10 * peak  # buckets count from 04:00
    when = f"{(m // 60) % 12 or 12}:{m % 60:02d} {'am' if (m // 60) % 24 < 12 else 'pm'}"
    car_h, sched_h = hours(cars), hours(sched)
    bus_h = sum(hours(v["bus"]) for v in act.values())
    if sched_h < 100:
        return None
    # Routes mostly run by buses are left to the service post.
    short = {r: hours(act[r]["car"]) / hours(sch[r]["car"]) for r in sch
             if r in act and hours(sch[r]["car"]) >= 20 and hours(act[r]["bus"]) < 0.5 * hours(sch[r]["car"])}
    lines = [f"Streetcars in service, {day_label}: at the busiest point ({when}), {cars[peak]:.0f} were carrying "
             f"passengers, against {sched[peak]:.0f} scheduled.",
             f"{'So far' if partial else 'Over the day'}, {car_h / sched_h:.0%} of scheduled streetcar hours ran"
             + (f", plus {bus_h:,.0f} bus hours on streetcar routes." if bus_h >= 1 else ".")]
    if short:
        r = min(short, key=short.get)
        line = f"Furthest short: {r} {names.get(r, '')}, {short[r]:.0%} of its scheduled streetcar hours."
        if short[r] < 0.95 and len("\n".join(lines + [line])) <= POST_LIMIT:
            lines.append(line)
    return {"kind": "fleet", "text": "\n".join(lines)}


def capture_image(site, shot, out):
    """Serve the built site locally and screenshot the framed segment."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(site)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}/?" + urllib.parse.urlencode(shot)
        subprocess.run([str(VENV_PY), str(CAPTURE), url, str(out), "1200", "900"], check=True, timeout=300)
        return True
    except Exception as e:
        print(f"drafts: image capture failed: {type(e).__name__}: {e}", file=sys.stderr)
        return False
    finally:
        srv.shutdown()


def make(site, force=False, today=False):
    if today and not (Path(site) / "data" / "stats-today.json").exists():
        return
    net, recent, yest, timeline, meta = load(site, "today" if today else "yesterday")
    day = yest["day"]
    out_dir = DRAFTS / (f"{day}-sofar" if today else day)
    if (out_dir / "draft.json").exists() and not (force or today):
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    d = date.fromisoformat(day)
    day_label = f"{d:%a %b} {d.day}"
    if today:
        now = time.localtime()
        day_label += f", to {now.tm_hour % 12 or 12}:{now.tm_min:02d} {'am' if now.tm_hour < 12 else 'pm'}"
    have_normal = meta["windows"]["recent"]["days"] >= MIN_NORMAL_DAYS
    agg = load_agg(day)
    posts = [p for p in (summary_post(day_label, net, recent, yest, have_normal, today),
                         segment_post(day_label, net, recent, yest, have_normal, today),
                         waits_post(day_label, net, agg),
                         fleet_post(day, day_label, net, agg, today),
                         service_post(day, day_label, net, timeline)) if p]
    for p in posts:
        p["chars"] = len(p["text"])
        if p.get("shot") and capture_image(site, p["shot"], out_dir / "segment.png"):
            p["image"] = "segment.png"
    draft = {"day": day, "partial": today, "generated": int(time.time()), "normal_days": meta["windows"]["recent"]["days"],
             "have_normal": have_normal, "positions": yest["stats"]["pings"], "posts": posts}
    (out_dir / "draft.json").write_text(json.dumps(draft, indent=1))
    sofar = DRAFTS / f"{day}-sofar"
    if not today and sofar.exists():  # the finished day replaces its so-far drafts
        for f in sofar.iterdir():
            f.unlink()
        sofar.rmdir()
    days = sorted((p.name for p in DRAFTS.iterdir() if (p / "draft.json").exists()), reverse=True)
    for old in days[KEEP_DAYS:]:
        for f in (DRAFTS / old).iterdir():
            f.unlink()
        (DRAFTS / old).rmdir()
    (DRAFTS / "index.json").write_text(json.dumps({"days": days[:KEEP_DAYS]}))
    print(f"drafts: {day}: {', '.join(p['kind'] for p in posts)}", file=sys.stderr)


if __name__ == "__main__":
    make(sys.argv[1], "--force" in sys.argv, "--today" in sys.argv)
