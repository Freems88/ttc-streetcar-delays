#!/usr/bin/env python3
"""Archive TTC streetcar positions from the GTFS-Realtime vehicle positions feed.

Polls every POLL_SECS, keeps streetcar-route vehicles, drops pings whose vehicle
timestamp hasn't changed, and appends to one CSV per service day about once a
minute. Finished days are gzipped once the service day rolls over.

Also archives TTC service alerts (all routes) every ALERT_SECS as change events:
an "active" line with the full alert when one appears or its content changes, and
a "gone" line when it disappears. Each day's file starts with every alert active
at that point, so a day file reads on its own.
"""
import csv
import gzip
import hashlib
import json
import logging
import os
import shutil
import signal
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from google.protobuf.json_format import MessageToDict
from google.transit import gtfs_realtime_pb2

FEEDS = [
    "https://bustime.ttc.ca/gtfsrt/vehicles",
    # Fallback. Its Azure WAF returns 403 to the default python-requests User-Agent.
    "https://gtfsrt.ttc.ca/vehicles/position?format=binary",
]
USER_AGENT = "ttc-streetcar-logger/1.0 (personal research archive)"

# The two alert feeds carry different content, so both are kept.
ALERT_FEEDS = {
    # Short-notice operational alerts: collision detours, short turns.
    "bustime": "https://bustime.ttc.ca/gtfsrt/alerts",
    # Planned service changes and construction, with active periods and links.
    "ttc": "https://gtfsrt.ttc.ca/alerts/all?format=binary",
}
ALERT_SECS = float(os.environ.get("ALERT_SECS", 120))

# route_type 0 (tram) in TTC static GTFS, checked 2026-10-29. route_id == route_short_name.
# 3xx are the overnight (Blue Night) streetcar routes. 508 isn't in service now; kept in case it returns.
DEFAULT_ROUTES = "501,503,504,505,506,507,508,509,510,511,512,301,304,305,306,310,312"
ROUTES = set(os.environ.get("ROUTES", DEFAULT_ROUTES).split(","))

POLL_SECS = float(os.environ.get("POLL_SECS", 20))
FLUSH_SECS = float(os.environ.get("FLUSH_SECS", 60))
STATUS_SECS = 900
# Service day starts at 04:00 local, so late-night trips stay with the day they belong to.
DAY_CUTOFF_HOURS = 4
DATA_DIR = Path(os.environ.get("DATA_DIR", Path.home() / "ttc-streetcars" / "data"))

FIELDS = ["fetch_ts", "vehicle_ts", "vehicle_id", "route_id", "trip_id",
          "lat", "lon", "bearing", "speed"]

log = logging.getLogger("ttc-streetcars")


def service_day(ts):
    return (datetime.fromtimestamp(ts) - timedelta(hours=DAY_CUTOFF_HOURS)).strftime("%Y-%m-%d")


class ErrorThrottle:
    """Log the first occurrence of an error, then at most one summary per interval."""

    def __init__(self, interval=600):
        self.interval = interval
        self.last_logged = {}
        self.suppressed = {}

    def error(self, key, msg):
        now = time.monotonic()
        if now - self.last_logged.get(key, -1e9) >= self.interval:
            n = self.suppressed.pop(key, 0)
            log.error("%s%s", msg, f" (+{n} similar since last report)" if n else "")
            self.last_logged[key] = now
        else:
            self.suppressed[key] = self.suppressed.get(key, 0) + 1


class Logger:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.last_vehicle_ts = {}  # vehicle_id -> last vehicle timestamp written
        self.buffer = []
        self.errors = ErrorThrottle()
        self.stats = {"polls": 0, "failed": 0, "fallback": 0, "rows": 0, "alert_events": 0}
        self.current_day = None
        self.alerts = {src: {} for src in ALERT_FEEDS}  # source -> alert id -> content hash
        self.alerts_day = {src: None for src in ALERT_FEEDS}  # day each source last wrote

    def get_feed(self, url):
        r = self.session.get(url, timeout=(5, 15))
        r.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(r.content)
        return feed

    def fetch(self):
        for i, url in enumerate(FEEDS):
            try:
                feed = self.get_feed(url)
                if i:
                    self.stats["fallback"] += 1
                return feed
            except Exception as e:
                self.errors.error(url, f"fetch failed {url}: {type(e).__name__}: {e}")
        return None

    def poll(self):
        self.stats["polls"] += 1
        fetch_ts = int(time.time())
        feed = self.fetch()
        if feed is None:
            self.stats["failed"] += 1
            return
        for ent in feed.entity:
            if not ent.HasField("vehicle"):
                continue
            v = ent.vehicle
            route = v.trip.route_id
            if route not in ROUTES:
                continue
            vid = v.vehicle.id or ent.id
            vts = v.timestamp if v.HasField("timestamp") else 0
            if vts and self.last_vehicle_ts.get(vid) == vts:
                continue
            self.last_vehicle_ts[vid] = vts
            p = v.position
            self.buffer.append([
                fetch_ts, vts or "", vid, route, v.trip.trip_id,
                f"{p.latitude:.6f}", f"{p.longitude:.6f}",
                f"{p.bearing:g}" if p.HasField("bearing") else "",
                f"{p.speed:.2f}" if p.HasField("speed") else "",
            ])
        # Forget vehicles not seen for an hour so the dedupe map can't grow forever.
        if self.stats["polls"] % 180 == 0:
            cutoff = fetch_ts - 3600
            self.last_vehicle_ts = {k: t for k, t in self.last_vehicle_ts.items() if t and t > cutoff}

    def flush(self):
        if not self.buffer:
            return
        by_day = {}
        for row in self.buffer:
            by_day.setdefault(service_day(row[0]), []).append(row)
        for day, rows in list(by_day.items()):
            path = DATA_DIR / f"{day}.csv"
            try:
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                new = not path.exists()
                with open(path, "a", newline="") as f:
                    w = csv.writer(f)
                    if new:
                        w.writerow(FIELDS)
                    w.writerows(rows)
            except OSError as e:
                # Keep unwritten rows in memory and retry next flush (disk full, drive missing).
                self.errors.error("write", f"write failed {path}: {e}")
                continue
            self.stats["rows"] += len(rows)
            del by_day[day]
        self.buffer = [row for rows in by_day.values() for row in rows]
        if len(self.buffer) > 200_000:  # ~6h of streetcars; don't eat RAM if the disk stays broken
            self.buffer = self.buffer[-200_000:]

    def seed_dedupe(self):
        """After a restart, recover each vehicle's last timestamp from the tail of today's file."""
        path = DATA_DIR / f"{service_day(time.time())}.csv"
        try:
            with open(path, "rb") as f:
                f.seek(max(0, f.seek(0, os.SEEK_END) - 512 * 1024))
                lines = f.read().decode("utf-8", "replace").splitlines()[1:]  # first may be partial
        except FileNotFoundError:
            return
        for row in csv.reader(lines):
            if len(row) == len(FIELDS) and row[1].isdigit():
                self.last_vehicle_ts[row[2]] = int(row[1])
        log.info("seeded dedupe for %d vehicles from %s", len(self.last_vehicle_ts), path.name)

    def alerts_path(self, ts):
        return DATA_DIR / "alerts" / f"{service_day(ts)}.jsonl"

    def seed_alerts(self):
        """After a restart, replay today's alert events so unchanged alerts aren't rewritten."""
        today = service_day(time.time())
        try:
            lines = self.alerts_path(time.time()).read_text().splitlines()
        except FileNotFoundError:
            return
        for line in lines:
            try:
                ev = json.loads(line)
                known = self.alerts[ev["source"]]
            except (ValueError, KeyError):
                continue
            self.alerts_day[ev["source"]] = today
            if ev["event"] == "active":
                known[ev["id"]] = ev["hash"]
            else:
                known.pop(ev["id"], None)
        log.info("seeded alerts: %s", {s: len(a) for s, a in self.alerts.items()})

    def poll_alerts(self):
        fetch_ts = int(time.time())
        day = service_day(fetch_ts)
        events, updates = [], {}
        for src, url in ALERT_FEEDS.items():
            try:
                feed = self.get_feed(url)
            except Exception as e:
                self.errors.error("alerts:" + src, f"alerts fetch failed {url}: {type(e).__name__}: {e}")
                continue
            known = self.alerts[src]
            rewrite_all = self.alerts_day[src] != day
            current = {}
            for ent in feed.entity:
                if not ent.HasField("alert"):
                    continue
                body = MessageToDict(ent.alert)
                h = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]
                current[ent.id] = h
                if rewrite_all or known.get(ent.id) != h:
                    events.append({"fetch_ts": fetch_ts, "source": src, "event": "active",
                                   "id": ent.id, "hash": h, "alert": body})
            for aid in known.keys() - current.keys():
                events.append({"fetch_ts": fetch_ts, "source": src, "event": "gone", "id": aid})
            updates[src] = current
        if events:
            path = self.alerts_path(fetch_ts)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "a") as f:
                    f.writelines(json.dumps(ev, ensure_ascii=False) + "\n" for ev in events)
            except OSError as e:
                # Leave state alone so the same events are retried next poll.
                self.errors.error("alerts:write", f"write failed {path}: {e}")
                return
            self.stats["alert_events"] += len(events)
        for src, current in updates.items():
            self.alerts[src] = current
            self.alerts_day[src] = day

    def compress_finished_days(self):
        today = service_day(time.time())
        for path in sorted([*DATA_DIR.glob("*.csv"), *DATA_DIR.glob("alerts/*.jsonl")]):
            if path.stem >= today:
                continue
            gz = path.with_name(path.name + ".gz")
            tmp = path.with_name(path.name + ".gz.tmp")
            try:
                with open(path, "rb") as src, gzip.open(tmp, "wb", compresslevel=6) as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                os.replace(tmp, gz)
                path.unlink()
                log.info("compressed %s -> %s (%.1f MB)", path.name, gz.name, gz.stat().st_size / 1e6)
            except OSError as e:
                self.errors.error("gzip", f"gzip failed {path}: {e}")
                tmp.unlink(missing_ok=True)

    def run(self):
        stop = []
        signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
        signal.signal(signal.SIGINT, lambda *_: stop.append(1))
        log.info("starting: data_dir=%s routes=%s poll=%ss flush=%ss alerts=%ss",
                 DATA_DIR, ",".join(sorted(ROUTES)), POLL_SECS, FLUSH_SECS, ALERT_SECS)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.compress_finished_days()
        self.seed_dedupe()
        self.seed_alerts()
        self.current_day = service_day(time.time())
        next_poll = last_flush = last_status = time.monotonic()
        last_alerts = -1e9
        while not stop:
            self.poll()
            now = time.monotonic()
            if now - last_alerts >= ALERT_SECS:
                self.poll_alerts()
                last_alerts = now
            if now - last_flush >= FLUSH_SECS:
                self.flush()
                last_flush = now
                day = service_day(time.time())
                if day != self.current_day:
                    self.current_day = day
                    self.compress_finished_days()
            if now - last_status >= STATUS_SECS:
                log.info("status: %s buffered=%d tracked_vehicles=%d active_alerts=%s",
                         self.stats, len(self.buffer), len(self.last_vehicle_ts),
                         {s: len(a) for s, a in self.alerts.items()})
                last_status = now
            next_poll += POLL_SECS
            # If we fell behind (slow fetch, suspend), resync instead of bursting.
            if next_poll < time.monotonic():
                next_poll = time.monotonic() + POLL_SECS
            while not stop and time.monotonic() < next_poll:
                time.sleep(min(1.0, next_poll - time.monotonic()))
        self.flush()
        log.info("stopped: %s", self.stats)


def main():
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(levelname)s %(message)s")
    Logger().run()


if __name__ == "__main__":
    main()
