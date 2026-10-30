"""Shared settings and geometry helpers for the delay pipeline (stdlib only)."""
import math
import os
from datetime import datetime, timedelta
from pathlib import Path

HOME = Path.home()
DATA_DIR = Path(os.environ.get("DATA_DIR", HOME / "ttc-streetcars" / "data"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", HOME / "ttc-streetcars" / "static"))
WORK_DIR = Path(os.environ.get("WORK_DIR", HOME / "ttc-streetcars" / "delays"))

BIN_M = 25  # length of each slice of route the delay profile is measured on
DAY_CUTOFF_HOURS = 4  # must match the collector's service-day boundary

# Overnight routes run the same streets as their daytime twins; fold them in.
NIGHT_TWIN = {"301": "501", "304": "504", "305": "505", "306": "506", "310": "510", "312": "512"}
FLEXITY_IDS = range(4400, 4700)  # TTC Flexity Outlook streetcars; anything else is a bus

SLOTS = ["am", "mid", "pm", "eve", "wkend", "night"]
SLOT_LABELS = {
    "all": "All day", "am": "Weekday AM peak", "mid": "Weekday midday", "pm": "Weekday PM peak",
    "eve": "Weekday evening", "wkend": "Weekend daytime", "night": "Overnight",
}

# Local equirectangular projection, metres. Plenty accurate across Toronto.
LAT0 = 43.67
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def to_xy(lon, lat):
    return lon * KX, lat * KY


def to_lonlat(x, y):
    return x / KX, y / KY


def bearing_of(dx, dy):
    """Compass bearing (0 = north, clockwise) of a vector in projected metres."""
    return math.degrees(math.atan2(dx, dy)) % 360


def angle_diff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


class PathGeom:
    """A polyline in projected metres with cumulative distance ("along") per vertex."""

    def __init__(self, lonlats):
        pts = [to_xy(lon, lat) for lon, lat in lonlats]
        # Drop repeated vertices so every segment has length.
        self.x, self.y = [pts[0][0]], [pts[0][1]]
        for x, y in pts[1:]:
            if math.hypot(x - self.x[-1], y - self.y[-1]) > 0.01:
                self.x.append(x)
                self.y.append(y)
        self.along = [0.0]
        self.seg_bearing = []
        for i in range(len(self.x) - 1):
            dx, dy = self.x[i + 1] - self.x[i], self.y[i + 1] - self.y[i]
            self.along.append(self.along[-1] + math.hypot(dx, dy))
            self.seg_bearing.append(bearing_of(dx, dy))
        self.length = self.along[-1]

    def project_seg(self, i, x, y):
        """(along, distance) of point (x, y) projected onto segment i."""
        x0, y0 = self.x[i], self.y[i]
        dx, dy = self.x[i + 1] - x0, self.y[i + 1] - y0
        seglen2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / seglen2))
        px, py = x0 + t * dx, y0 + t * dy
        return self.along[i] + t * math.sqrt(seglen2), math.hypot(x - px, y - py)

    def project(self, x, y, min_along=-1.0):
        """Nearest projection with along >= min_along: (along, distance)."""
        best = (None, float("inf"))
        for i in range(len(self.x) - 1):
            if self.along[i + 1] < min_along:
                continue
            a, d = self.project_seg(i, x, y)
            if a >= min_along and d < best[1]:
                best = (a, d)
        return best

    def point_at(self, a):
        """Projected (x, y) at distance a along the path."""
        a = max(0.0, min(self.length, a))
        lo, hi = 0, len(self.along) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if self.along[mid] <= a:
                lo = mid
            else:
                hi = mid
        seg = self.along[hi] - self.along[lo]
        t = (a - self.along[lo]) / seg if seg else 0
        return self.x[lo] + t * (self.x[hi] - self.x[lo]), self.y[lo] + t * (self.y[hi] - self.y[lo])


def service_day(ts):
    return (datetime.fromtimestamp(ts) - timedelta(hours=DAY_CUTOFF_HOURS)).strftime("%Y-%m-%d")


def slot_of(ts, day):
    """Time-of-day slot for a moment `ts` within service day `day` (YYYY-MM-DD)."""
    t = datetime.fromtimestamp(ts)
    h = t.hour + t.minute / 60
    if h < 6:
        return "night"
    if datetime.strptime(day, "%Y-%m-%d").weekday() >= 5:
        return "wkend"
    if h < 9.5:
        return "am"
    if h < 15.5:
        return "mid"
    if h < 19:
        return "pm"
    return "eve"
