#!/usr/bin/env python3
"""Post the bot's drafts to Bluesky (@stuckto.bsky.social) as one thread through the day.

The nightly run writes yesterday's draft (drafts/<day>/draft.json). It goes out in slots,
each replying to the thread's last post:
  morning  summary, then the slowest spot with its image
  midday   waits at stops
  evening  cars in service, then service changes
A post with nothing to say that day is simply missing from the draft and skipped.
drafts/<day>/posted.json records what went out, so a slot never posts twice.

Nothing is posted unless WORK_DIR/bot-enabled exists; without it a slot only prints
what it would post. The site link in a draft is posted as short link text ("See the
map") so it doesn't eat into the 300-character limit.

Usage: post.py SLOT [--dry-run]   (SLOT: morning, midday or evening)
Needs STUCKTO_HANDLE and STUCKTO_PASSWORD (an app password) in the environment.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

from common import WORK_DIR, service_day

DRAFTS = WORK_DIR / "drafts"
ENABLED = WORK_DIR / "bot-enabled"
SESSION = WORK_DIR / "bsky-session"
SLOTS = {"morning": ["summary", "segment"], "midday": ["waits"], "evening": ["fleet", "service"]}
LINK = re.compile(r"https://freems88\.github\.io/ttc-streetcar-delays/\S*")
LINK_TEXT = "See the map"
IMAGE_SIZE = (1200, 900)  # as captured by drafts.py


def login():
    from atproto import Client
    client = Client()
    try:
        client.login(session_string=SESSION.read_text().strip())
    except Exception:
        client.login(os.environ["STUCKTO_HANDLE"], os.environ["STUCKTO_PASSWORD"])
    fd = os.open(SESSION, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(client.export_session_string())
    return client


def rich_text(text):
    """The post text with the site link as short link text."""
    from atproto import client_utils
    tb, pos = client_utils.TextBuilder(), 0
    for m in LINK.finditer(text):
        tb.text(text[pos:m.start()]).link(LINK_TEXT, m.group(0))
        pos = m.end()
    return tb.text(text[pos:])


def shown(text):
    return LINK.sub(LINK_TEXT, text)


def main():
    slot = sys.argv[1] if len(sys.argv) > 1 else ""
    if slot not in SLOTS:
        sys.exit(f"usage: post.py {{{','.join(SLOTS)}}} [--dry-run]")
    dry = "--dry-run" in sys.argv or not ENABLED.exists()
    # Yesterday's draft, by the service day (the nightly run writes it at 04:20).
    day = service_day(time.time() - 86400)
    path = DRAFTS / day / "draft.json"
    if not path.exists():
        print(f"post: no draft for {day}; nothing to post", file=sys.stderr)
        return
    draft = json.loads(path.read_text())
    state_path = DRAFTS / day / "posted.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"done": []}
    todo = [p for kind in SLOTS[slot] for p in draft["posts"] if p["kind"] == kind and kind not in state["done"]]
    if not todo:
        print(f"post: {day} {slot}: nothing to post", file=sys.stderr)
        return
    client = None if dry else login()
    for p in todo:
        if dry:
            print(f"[dry run] {day} {slot} {p['kind']} ({len(shown(p['text']))} chars"
                  f"{', image' if p.get('image') else ''}):\n{shown(p['text'])}\n")
            continue
        from atproto import models
        reply = None
        if state.get("root"):
            ref = lambda r: models.ComAtprotoRepoStrongRef.Main(uri=r["uri"], cid=r["cid"])
            reply = models.AppBskyFeedPost.ReplyRef(root=ref(state["root"]), parent=ref(state["last"]))
        image = DRAFTS / day / p["image"] if p.get("image") else None
        if image and image.exists():
            res = client.send_image(text=rich_text(p["text"]), image=image.read_bytes(), image_alt=p.get("alt", ""),
                                    image_aspect_ratio=models.AppBskyEmbedDefs.AspectRatio(
                                        width=IMAGE_SIZE[0], height=IMAGE_SIZE[1]),
                                    reply_to=reply, langs=["en-CA"])
        else:
            res = client.send_post(text=rich_text(p["text"]), reply_to=reply, langs=["en-CA"])
        ref = {"uri": res.uri, "cid": res.cid}
        state.setdefault("root", ref)
        state["last"] = ref
        state["done"].append(p["kind"])
        state_path.write_text(json.dumps(state, indent=1))
        print(f"post: {day} {slot} {p['kind']} -> {res.uri}", file=sys.stderr)


if __name__ == "__main__":
    main()
