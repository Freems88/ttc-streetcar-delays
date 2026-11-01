#!/usr/bin/env python3
"""Nightly job on the Pi: update the network, process finished days, rebuild and publish the site.

Publishing force-pushes a single fresh commit to the gh-pages branch, so the repo
doesn't accumulate a copy of the data every night.

Usage: nightly.py [--rebuild] [--no-publish] [--include-today] [--drafts-today]
  --rebuild        reprocess every day (after a method change)
  --include-today  also process the service day still being logged (for a first publish)
  --drafts-today   also draft bot posts for the day so far (hourly refreshes)
"""
import shutil
import subprocess
import sys
import time
from pathlib import Path

import build_site
import drafts
import network
import process_day
import signals
import turns
from common import DATA_DIR, WORK_DIR, service_day

REMOTE = "git@github-ttc-delays:Freems88/ttc-streetcar-delays.git"
SITE_OUT = WORK_DIR / "site"


def days_to_process(rebuild, include_today):
    today = service_day(time.time())
    out = []
    for raw in sorted(DATA_DIR.glob("*.csv*")):
        day = raw.name[:10]
        if day == today and not include_today:
            continue
        agg = WORK_DIR / "agg" / f"{day}.json.gz"
        if rebuild or not agg.exists() or agg.stat().st_mtime < raw.stat().st_mtime or day == today:
            out.append(day)
    return sorted(set(out))


def publish(last_day):
    git = lambda *a: subprocess.run(["git", "-C", str(SITE_OUT), *a], check=True)
    (SITE_OUT / ".nojekyll").touch()
    git("init", "-q")
    git("checkout", "-q", "-B", "gh-pages")
    git("add", "-A")
    git("-c", "user.name=ttc-delays-pi", "-c", "user.email=ttc-delays-pi@users.noreply.github.com",
        "commit", "-q", "-m", f"Data through {last_day}")
    git("push", "-q", "-f", REMOTE, "gh-pages")


def main():
    args = set(sys.argv[1:])
    network.build()
    signals.ensure_signals()
    turns.ensure()
    import json
    net = json.loads((WORK_DIR / "network.json").read_text())
    for day in days_to_process("--rebuild" in args, "--include-today" in args):
        process_day.process(day, net)
    sys.argv = ["build_site.py", str(SITE_OUT)]
    build_site.main()
    # Bot dry run: draft yesterday's posts (once per day) and ship them with the site.
    try:
        drafts.make(SITE_OUT)
        if "--drafts-today" in args:
            drafts.make(SITE_OUT, today=True)
    except Exception as e:
        print(f"drafts failed: {type(e).__name__}: {e}", file=sys.stderr)
    if drafts.DRAFTS.exists():
        shutil.copytree(drafts.DRAFTS, SITE_OUT / "data" / "drafts", dirs_exist_ok=True)
    if "--no-publish" not in args:
        last = max(p.name[:10] for p in (WORK_DIR / "agg").glob("*.json.gz"))
        publish(last)
        print(f"published data through {last}", file=sys.stderr)


if __name__ == "__main__":
    main()
