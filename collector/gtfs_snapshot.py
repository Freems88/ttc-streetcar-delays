#!/usr/bin/env python3
"""Keep a copy of every version of the TTC static GTFS published on Toronto Open Data.

Run daily (ttc-gtfs-snapshot.timer). Checks each package's resource metadata and
only downloads when last_modified changes; saves a new zip only when its contents
differ from every copy already kept. Trip IDs in the realtime archive only make
sense against the schedule that was in effect, and the portal keeps no history.
"""
import csv
import hashlib
import io
import json
import logging
import os
import sys
import zipfile
from datetime import date
from pathlib import Path

import requests

CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show"
PACKAGES = [
    # Matches the bustime realtime feed's IDs; the one checked on 2026-10-29.
    "surface-routes-and-schedules-for-bustime",
    # The main TTC GTFS. Was an empty zip on 2026-10-29; kept in case it comes back.
    "ttc-routes-and-schedules",
]
USER_AGENT = "ttc-streetcar-logger/1.0 (personal research archive)"
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path.home() / "ttc-streetcars" / "static"))
STATE = STATIC_DIR / "state.json"

log = logging.getLogger("ttc-gtfs-snapshot")


def feed_info(data):
    """feed_info.txt as a dict, wherever it sits in the zip (TTC nests it in a folder)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist() if n.endswith("routes.txt")]
        if not names:
            raise ValueError("no routes.txt in zip")
        info = [n for n in z.namelist() if n.endswith("feed_info.txt")]
        if not info:
            return {}
        rows = list(csv.DictReader(io.TextIOWrapper(z.open(info[0]), "utf-8-sig")))
        return rows[0] if rows else {}


def main():
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(levelname)s %(message)s")
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    failed = False
    for pkg in PACKAGES:
        try:
            resources = s.get(CKAN, params={"id": pkg}, timeout=30).json()["result"]["resources"]
        except Exception as e:
            log.error("%s: metadata fetch failed: %s: %s", pkg, type(e).__name__, e)
            failed = True
            continue
        for res in resources:
            if res.get("format", "").upper() != "ZIP":
                continue
            key = f"{pkg}/{res['id']}"
            seen = state.get(key, {})
            if seen.get("last_modified") == res.get("last_modified"):
                continue
            data = b""
            try:
                r = s.get(res["url"], timeout=(10, 600))
                r.raise_for_status()
                data = r.content
                info = feed_info(data)
            except requests.RequestException as e:
                log.error("%s: download failed: %s: %s", pkg, type(e).__name__, e)
                failed = True
                continue
            except Exception as e:
                # An empty/broken zip is logged but marked seen, so it isn't refetched daily.
                log.warning("%s: skipped %s (%d bytes): %s: %s", pkg, res["url"],
                            len(data), type(e).__name__, e)
                state[key] = {**seen, "last_modified": res.get("last_modified")}
                continue
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen.get("sha256s", []):
                log.info("%s: re-published, contents unchanged", pkg)
            else:
                out_dir = STATIC_DIR / pkg
                out_dir.mkdir(exist_ok=True)
                label = info.get("feed_version") or digest[:10]
                start = info.get("feed_start_date", "")
                name = f"{date.today():%Y-%m-%d}_{label}" + (f"_from{start}" if start else "") + ".zip"
                tmp = out_dir / (name + ".tmp")
                tmp.write_bytes(data)
                os.replace(tmp, out_dir / name)
                log.info("%s: saved %s (%.1f MB) feed_info=%s", pkg, name, len(data) / 1e6, info)
                seen.setdefault("sha256s", []).append(digest)
            state[key] = {**seen, "last_modified": res.get("last_modified")}
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    os.replace(tmp, STATE)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
