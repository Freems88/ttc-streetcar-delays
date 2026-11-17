# Stuck TO: Toronto streetcar delays

Where Toronto streetcars lose time compared with a clean run, built from the TTC's live
positions logged on a Raspberry Pi. Live at https://stuckin.to, with a Bluesky bot
(@stuckin.to) posting yesterday's highlights.

**Read before changing anything:** `docs/how-it-works.md` (how it fits together, the data
rules, assumptions, health checks, recipes, decisions) and `README.md` (file layout).
Pi access and on-Pi operations are in `CLAUDE.local.md` (not in the repo).

## How the pieces run

- `collector/` runs continuously on the Pi (logger, schedule snapshots).
- `pipeline/` runs nightly on the Pi at 04:20 (`pi/ttc-delays-nightly.*`): it pulls this repo,
  processes finished days, builds the site and force-pushes it to `gh-pages`. Bot posts go out
  at 07:45, 12:15 and 17:15 from the drafts it writes.
- `site/` is static: MapLibre 4.7.1 + deck.gl 9.1.14 (pinned), OpenFreeMap tiles. The build
  tags `app.js`/`style.css` links with a content hash, since Pages caches files for 10 minutes.

So **pushing to `main` goes live at the next 04:20 run**. To publish sooner, or to apply a
method change to past days (`nightly.py --rebuild`), see `CLAUDE.local.md`.

## Working on it

- Pipeline code is **stdlib-only Python 3.11** (the Pi's system Python). `capture.py` alone uses
  the logger's venv (websocket-client) to drive headless Chromium.
- Test locally against `devdata/` (gitignored), as in the README's *Running locally*. The
  preview server is the `ttc-site-preview` launch config (port 8765). The in-app browser can't
  load the basemap tiles, so check basemap-dependent changes with `capture.py` on the Pi.
- After a pipeline change, check it on real data, including known awkward days (e.g. the 505
  via College on Nov 7), before saying it works.
- Every behaviour change updates `docs/how-it-works.md` in the same change or a following
  `Docs:` commit. The docs are the project's memory.
- Commits: a short imperative summary, then a paragraph on why.
- After publishing, verify the live site (data file or versioned script), not just the build.

## Things decided (details in the docs' *Data rules* and *Decisions worth remembering*)

- **Observational only:** no dollar costs, no one-off traffic counts.
- Windows are yesterday / 7 / 30 / 90 days; there is deliberately **no all-time view**.
- Route patterns are **observed** from where cars ran, not taken from the schedule.
- Words: a **clean run** is per segment, and a route's sum is its **clean-run total** (never
  "best case" or "good run"). **Segments** are stop-centred; **slices** are 25 m.
- Comparisons that aren't experiments (transit priority, turn bans) are described, with
  caveats, never claimed as proof.
- The bot posts yesterday, as one thread; no service-change posts.

## Public repo

This repository is public. Never commit the Pi's address, SSH keys, `bot.env` or other
credentials, or details of the other bots on the Pi. Those stay in `CLAUDE.local.md` or on
the Pi.
