"""Temporary TTC service changes per route and day, from the saved alerts (data/alerts/).

The schedule doesn't know about detours, so on those days a route's numbers describe a
different service: a short turn may be the diversion's turning point, a stop's waits may be
replacement buses. Rather than model every detour, those route-days are flagged: the bot
doesn't pick them for its route superlatives, and the trends page marks them.

A route-day is flagged when a TTC alert for it (detour, no service, reduced or modified
service) covered at least MIN_HOURS of the day's service hours, and the change was temporary:
planned for at most MAX_PLANNED_DAYS (a weekend diversion), or an incident (open-ended, from
first seen to gone). Long-running changes (a month of construction) are the route's normal
for now, and the observed route patterns already follow them. Subway delays and elevator
outages that only list connecting streetcar routes aren't route alerts and are skipped.
"""
import glob
import gzip
import json
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from common import DATA_DIR, NIGHT_TWIN

EFFECTS = {"DETOUR", "NO_SERVICE", "REDUCED_SERVICE", "MODIFIED_SERVICE"}
MAX_PLANNED_DAYS = 7
MIN_HOURS = 3
SERVICE = (6, 24)  # hours of the service day that count
STREETCAR = {"501", "503", "504", "505", "506", "507", "508", "509", "510", "511", "512"}  # after NIGHT_TWIN


def _text(t):
    return ((t or {}).get("translation") or [{}])[0].get("text", "").strip()


def _intervals():
    """[(route, start, end, title)] for qualifying alerts, in epoch seconds."""
    first, gone, seen = {}, {}, {}
    for f in sorted(glob.glob(str(DATA_DIR / "alerts" / "*.jsonl*"))):
        op = gzip.open if f.endswith(".gz") else open
        with op(f, "rt") as fh:
            for line in fh:
                try:
                    a = json.loads(line)
                except ValueError:
                    continue
                if a.get("source") != "ttc":
                    continue
                key = (a.get("id"), a.get("hash"))
                if a.get("event") == "active":
                    first.setdefault(key, a["fetch_ts"])
                    seen.setdefault(key, a)
                elif a.get("event") == "gone":
                    gone.setdefault(key, a["fetch_ts"])
    out = []
    for key, a in seen.items():
        al = a.get("alert") or {}
        if al.get("effect") not in EFFECTS:
            continue
        routes = {NIGHT_TWIN.get(e.get("routeId"), e.get("routeId")) for e in al.get("informedEntity", [])}
        routes = {r for r in routes if r in STREETCAR}
        title = _text(al.get("headerText")).lstrip("– ").strip()
        if not routes or re.match(r"Line \d|.*[Ee]levator", title):
            continue
        periods = [(int(p.get("start") or 0), int(p.get("end") or 0)) for p in al.get("activePeriod") or []]
        planned = [(s, e) for s, e in periods if s and e]
        if planned:
            if (max(e for _, e in planned) - min(s for s, _ in planned)) / 86400 > MAX_PLANNED_DAYS:
                continue  # long-running: the route's normal for now
            spans = planned
        else:  # an incident: from first seen to gone (or still on at the last fetch)
            spans = [(first[key], gone.get(key, first[key] + 3600))]
        for r in routes:
            for s, e in spans:
                out.append((r, s, e, title or al.get("effect").replace("_", " ").lower()))
    return out


def flags(days):
    """{day: {route: [alert titles]}} for the given service days ("YYYY-MM-DD")."""
    ivs = _intervals()
    out = defaultdict(dict)
    for day in days:
        d = date.fromisoformat(day)
        lo = datetime(d.year, d.month, d.day) + timedelta(hours=SERVICE[0])
        hi = datetime(d.year, d.month, d.day) + timedelta(hours=SERVICE[1])
        lo_t, hi_t = lo.timestamp(), hi.timestamp()
        cover = defaultdict(float)
        titles = defaultdict(list)
        for r, s, e, title in ivs:
            ov = min(e, hi_t) - max(s, lo_t)
            if ov > 0:
                cover[r] += ov
                if title not in titles[r]:
                    titles[r].append(title)
        for r, secs in cover.items():
            if secs >= MIN_HOURS * 3600:
                out[day][r] = titles[r][:3]
    return dict(out)


if __name__ == "__main__":
    import sys
    for day, routes in flags(sys.argv[1:]).items():
        for r, t in sorted(routes.items()):
            print(day, r, "|", " / ".join(x[:80] for x in t))
