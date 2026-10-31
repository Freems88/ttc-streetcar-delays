"""Turn prohibitions from the City's traffic by-law (Municipal Code Chapter 950, Schedule 23),
matched to traffic signals by street name.

The by-law dataset is one ~800 MB JSON file covering every schedule, so it's streamed
and only Schedule 23 records are kept: current ones (not repealed) at a named
intersection. Refreshed every REFRESH_DAYS; turn bans rarely change.

Usage: turns.py [local files.json]   (default: download)  Writes WORK_DIR/turn-bans.json.
"""
import json
import re
import sys
import time
import urllib.request

from common import WORK_DIR

URL = ("https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/72040958-e532-46f7-9228-8d07b4677a2b/"
       "resource/fb743d85-6915-4f4d-8885-9b342d1b2aee/download/files.json")
OUT = WORK_DIR / "turn-bans.json"
REFRESH_DAYS = 90
SCHEDULE = b'"displayName":"Schedule 23: Prohibited Turns"'
RECORD = b'{"Owner2"'

ABBREV = {"street": "st", "avenue": "ave", "road": "rd", "boulevard": "blvd", "drive": "dr", "crescent": "cres",
          "place": "pl", "court": "crt", "gardens": "gdns", "square": "sq", "terrace": "ter", "parkway": "pkwy",
          "east": "e", "west": "w", "north": "n", "south": "s"}


def norm(name):
    """Comparable street name: 'Queen Street East' and 'QUEEN ST E' both -> 'queen st e'."""
    words = re.sub(r"[^a-z0-9 ]+", " ", name.lower()).split()
    return " ".join(ABBREV.get(w, w) for w in words)


def _records(stream):
    """Yield the raw bytes of each by-law record from the streamed JSON array."""
    buf = b""
    while True:
        chunk = stream.read(8 << 20)
        buf += chunk
        parts = buf.split(b"," + RECORD)
        # Everything but the last part is complete; the last may continue in the next chunk.
        for p in parts[:-1]:
            yield p if p.startswith(RECORD) else RECORD + p.split(RECORD, 1)[-1]
        buf = b"," + RECORD + parts[-1] if len(parts) > 1 else parts[-1]
        if not chunk:
            tail = buf[1:] if buf.startswith(b",") else buf
            yield tail.rsplit(b"]", 1)[0]
            return


def extract(stream):
    bans = []
    for raw in _records(stream):
        if SCHEDULE not in raw:
            continue
        start = raw.find(RECORD)
        try:
            rec = json.loads(raw[start:])
        except ValueError:
            continue
        if rec.get("latestRegulationActionByStatus") == "Repealed":
            continue
        fields = {t["key"]: t["value"] for t in rec.get("parsedTableData", [])}
        loc = fields.get("Intersection or Portion of Highway", {})
        pair = (loc.get("ParsedObject") or {}).get("intersection_pair")
        if not pair:
            continue  # stretches of road and offsets: not at one intersection
        streets = [s["stName"] for s in pair["intersections"] if s.get("stName")]
        if len(streets) != 2:
            continue
        get = lambda k: (fields.get(k) or {}).get("Original", "")
        when = get("Times and/or Days")
        bans.append({
            "streets": streets, "direction": get("Direction"), "turn": get("Turns Prohibited"), "when": when,
            "ttc_exempt": bool(re.search(r"T\.?T\.?C\.?[^)]*excepted", when, re.I)),
            "bylaw": rec.get("latestRegulationActionByLaw"),
        })
    return bans


def ensure(local=None):
    """Refresh OUT if it's missing or older than REFRESH_DAYS; keep the old copy on failure."""
    if not local and OUT.exists() and time.time() - OUT.stat().st_mtime < REFRESH_DAYS * 86400:
        return
    try:
        if local:
            with open(local, "rb") as f:
                bans = extract(f)
        else:
            req = urllib.request.Request(URL, headers={"User-Agent": "ttc-streetcar-logger/1.0"})
            with urllib.request.urlopen(req, timeout=600) as r:
                bans = extract(r)
        if len(bans) < 100:
            raise ValueError(f"only {len(bans)} turn bans found")
        tmp = OUT.with_suffix(".tmp")
        tmp.write_text(json.dumps(bans, separators=(",", ":")))
        tmp.replace(OUT)
        print(f"turn bans: {len(bans)} current, at intersections", file=sys.stderr)
    except Exception as e:
        print(f"turn bans: refresh failed ({type(e).__name__}: {e}); using existing copy", file=sys.stderr)


def load():
    return json.loads(OUT.read_text()) if OUT.exists() else []


def by_intersection(bans):
    """{frozenset of two normalised street names: [ban, ...]}. 'A East/A West' style names
    count as either."""
    out = {}
    for b in bans:
        a_opts = [norm(x) for x in b["streets"][0].split("/")]
        b_opts = [norm(x) for x in b["streets"][1].split("/")]
        for a in a_opts:
            for c in b_opts:
                out.setdefault(frozenset((a, c)), []).append(b)
    return out


if __name__ == "__main__":
    ensure(sys.argv[1] if len(sys.argv) > 1 else None)
