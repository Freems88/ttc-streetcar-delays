# Toronto streetcar delays

Where Toronto streetcars lose time compared with a clean run that only stops at passenger stops, as a 3D map that sharpens every night as data builds up.

The TTC publishes live streetcar positions (GTFS-Realtime) but keeps no history, so a Raspberry Pi logs them and rebuilds the map nightly.

## Layout

- `collector/`: runs on the Pi as systemd services (deployed copies live in `~/ttc-streetcars/`).
  - `logger.py`: polls vehicle positions every 20 s (streetcar routes only, deduplicated) and both TTC alert feeds every 2 min. Writes one CSV and one alerts JSONL per service day (04:00 to 04:00) and gzips finished days.
  - `gtfs_snapshot.py`: saves each new TTC static GTFS published on Toronto Open Data (daily check).
- `pipeline/`: stdlib-only Python, run nightly on the Pi by `pi/ttc-delays-nightly.timer`.
  - `network.py`: builds directed track pieces from every streetcar pattern in every saved schedule. Pieces never change once made, so stats stay comparable when routes change; new track adds pieces.
  - `process_day.py`: snaps a day's pings to the track and records the seconds each pass spent on every 25 m slice and every stop interval, plus when every vehicle on the route (buses too) left each stop.
  - `fleet.py`: streetcars and buses in service per route in 10-minute steps, from each feed fetch, against the vehicle blocks in the schedule in effect.
  - `headways.py`: headway regularity against the schedule in effect that day (cached per saved schedule in `sched/`): excess wait (TfL), bunching and gaps, cars seen vs scheduled, and the TCQSM headway coefficient of variation, per stop, route and hour.
  - `build_site.py`: combines days into last-90-days and all-time stats, route summaries and a per-route bus/diversion timeline with alerts.
  - `signals.py`: fetches the City of Toronto traffic signal list (monthly) and labels each slice stop / signal / both / elsewhere, since stop delay is mostly boarding and signal delay mostly red lights.
  - `turns.py`: turn prohibitions from the traffic by-law (Chapter 950, Schedule 23), streamed from the City's ~800 MB by-law file every 90 days and matched to signals by street name.
  - `drafts.py` + `capture.py`: bot dry run. Drafts the day's would-be Bluesky posts (summary, slowest segment with a framed 3D image, service notes) to `drafts.html`. Images come from the map's screenshot mode (`?shot=1`), rendered by headless Chromium on the Pi.
  - `nightly.py`: runs the above and force-pushes the built site to `gh-pages`.
- `site/`: the static map page (MapLibre + deck.gl, OpenFreeMap tiles).

## Method

- **Clean run, per slice:** taken from daytime passes only (06:00 to midnight), so overnight cars skipping quiet stops don't set it. It's the 10th-percentile time through the slice, plus the stop's normal stopping time spread around each passenger stop. That stopping time is the 10th-percentile time from the midpoint before the stop to the midpoint after it, minus the fast-pass times of the slices in between.
- **Delay:** the average time minus the clean run, per 100 m, overall or by time of day.
- **Waits:** headways at each stop, frequent service only (scheduled every 12 min or better). Average wait for a rider arriving at random is sum(h²) / 2 sum(h); excess wait is that minus the same for the scheduled headways. Bunched = under half the scheduled headway, gap = over 1.5×. A stop where under a third of scheduled cars showed up that day counts as not served (diversion) and is left out. Only days a saved schedule covers have headway data (from 2026-11-01).
- **Excluded:** standing still for over 3 minutes counts as a layover and is cut out. Buses on streetcar routes are left out of delay stats but counted in the route timeline.

## Running locally

```bash
cd pipeline
export DATA_DIR=../devdata STATIC_DIR=../devdata/static WORK_DIR=../devdata/work
python network.py
python process_day.py 2026-10-29
python build_site.py ../devdata/build
python -m http.server 8765 --directory ../devdata/build
```

Inspired by a map of Turin tram delays shared by Andrea Matranga on Bluesky.
