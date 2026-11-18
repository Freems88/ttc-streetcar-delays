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

    def straightened(self):
        """A copy for drawing only: the TTC's shapes bend out to each stop pole at the curb,
        which puts a sideways jog of up to ~15 m at every stop. On straight track, each
        vertex is moved onto the line the track runs along there. "along" is kept, so
        point_at(a) still means the same place on the track; project() on the copy doesn't."""
        xs, ys = list(self.x), list(self.y)
        offsets = [k * STRAIGHT_STEP for k in range(-STRAIGHT_WIN // STRAIGHT_STEP,
                                                     STRAIGHT_WIN // STRAIGHT_STEP + 1)]
        for i, a in enumerate(self.along):
            if a < STRAIGHT_WIN or a > self.length - STRAIGHT_WIN:
                continue  # needs straight track on both sides
            pts = [(o, *self.point_at(a + o)) for o in offsets]
            line = _fit_line(pts)
            # Refit on the points nearest the line, so the jogs themselves don't tilt it.
            near = sorted(pts, key=lambda p: abs(_off_line(line, p)))[:int(len(pts) * 0.7)]
            line = _fit_line(near)
            on = [p for p in pts if abs(_off_line(line, p)) <= STRAIGHT_TOL]
            if (len(on) < 0.6 * len(pts) or min(p[0] for p in on) > -STRAIGHT_SIDE
                    or max(p[0] for p in on) < STRAIGHT_SIDE):
                continue  # a curve or a corner: leave it alone
            line = _fit_line(on)
            d = _off_line(line, (0, self.x[i], self.y[i]))
            if abs(d) <= STRAIGHT_MAX:
                xs[i] += d * line[3]
                ys[i] -= d * line[2]
        g = PathGeom.__new__(PathGeom)
        g.x, g.y, g.along, g.length = xs, ys, self.along, self.length
        g.seg_bearing = [bearing_of(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) for i in range(len(xs) - 1)]
        return g


# Straightening the drawn track (PathGeom.straightened).
STRAIGHT_STEP = 25   # m between the points the local line is fitted to
STRAIGHT_WIN = 150   # m either side of a vertex looked at
STRAIGHT_SIDE = 100  # m: the track must be on the line at least this far both ways
STRAIGHT_TOL = 3     # m: points this close to the line count as on it
STRAIGHT_MAX = 15    # m: never move a vertex further than this


def _fit_line(pts):
    """Best-fit line through [(_, x, y)]: (cx, cy, ux, uy), a point and unit direction."""
    n = len(pts)
    cx, cy = sum(p[1] for p in pts) / n, sum(p[2] for p in pts) / n
    sxx = sum((p[1] - cx) ** 2 for p in pts)
    syy = sum((p[2] - cy) ** 2 for p in pts)
    sxy = sum((p[1] - cx) * (p[2] - cy) for p in pts)
    th = 0.5 * math.atan2(2 * sxy, sxx - syy)
    return cx, cy, math.cos(th), math.sin(th)


def _off_line(line, p):
    """Signed sideways distance of point (_, x, y) from the line (left is positive)."""
    cx, cy, ux, uy = line
    return (p[2] - cy) * ux - (p[1] - cx) * uy


def service_day(ts):
    return (datetime.fromtimestamp(ts) - timedelta(hours=DAY_CUTOFF_HOURS)).strftime("%Y-%m-%d")


def hour_key(ts, day):
    """Hour-of-day bucket 0..47 for the time-of-day slider: 0-23 on weekdays, 24-47 on
    weekends, by the service day (so 1 a.m. Saturday night counts as Saturday)."""
    weekend = datetime.strptime(day, "%Y-%m-%d").weekday() >= 5
    return datetime.fromtimestamp(ts).hour + (24 if weekend else 0)


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
