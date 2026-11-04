#!/bin/sh
# Back up the streetcar archive from the SD card to the SSD (run hourly by ttc-backup.timer).
#
#   current/       a mirror of ~/ttc-streetcars, refreshed every run
#   snapshots/DAY  one dated copy per day, made at the first run after 05:00. Unchanged
#                  files are hard links into the previous copies, so a snapshot costs only
#                  what changed that day. Kept for KEEP_DAYS days.
#
# The mirror follows deletions (a file deleted on the SD card goes from current/ too),
# so the snapshots are what protect against mistakes or a corrupted file. Secrets
# (Bluesky app password and session) and the Python venv aren't copied. The logger
# keeps writing to the SD card: if the SSD is missing this run fails and logging carries on.
set -eu

SRC=/home/alex/ttc-streetcars
MOUNT=/mnt/strada
DEST=$MOUNT/ttc-backup
KEEP_DAYS=90

mountpoint -q "$MOUNT" || { echo "backup: $MOUNT is not mounted, nothing copied" >&2; exit 1; }
mkdir -p "$DEST/current" "$DEST/snapshots"

rsync -a --delete \
    --exclude /venv/ --exclude /bot.env --exclude /delays/bsky-session \
    --exclude /delays/site/ --exclude '*.tmp' \
    "$SRC/" "$DEST/current/"

today=$(date +%F)
if [ "$(date +%H)" -ge 5 ] && [ ! -d "$DEST/snapshots/$today" ]; then
    prev=$(ls -1d "$DEST"/snapshots/????-??-?? 2>/dev/null | tail -n 1 || true)
    if [ -n "$prev" ]; then
        rsync -a --link-dest="$prev" "$DEST/current/" "$DEST/snapshots/$today.partial/"
    else
        cp -a "$DEST/current" "$DEST/snapshots/$today.partial"
    fi
    mv "$DEST/snapshots/$today.partial" "$DEST/snapshots/$today"
    # Prune by the date in the name (folder times come from the source, not the snapshot).
    cutoff=$(date -d "-$KEEP_DAYS days" +%F)
    for d in "$DEST"/snapshots/????-??-??; do
        [ -d "$d" ] && [ "$(basename "$d")" \< "$cutoff" ] && rm -rf "$d"
    done
fi
rm -rf "$DEST"/snapshots/*.partial 2>/dev/null || true

date '+%F %T' > "$DEST/last-backup.txt"
echo "backup: ok, $(du -sh "$DEST/current" | cut -f1) mirrored, $(ls -1d "$DEST"/snapshots/????-??-?? 2>/dev/null | wc -l) snapshots"
