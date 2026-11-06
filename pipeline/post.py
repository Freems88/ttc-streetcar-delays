#!/usr/bin/env python3
"""Post the bot's drafts to Bluesky (@stuckin.to) as one thread through the day.

The nightly run writes yesterday's draft (drafts/<day>/draft.json). It goes out in slots,
each replying to the thread's last post:
  morning  summary (with the hashtags), then the slowest spot with its image
  midday   the most short-turned route (map), then the most-held signal with its image
  evening  cars in service (chart), then the stop with the longest extra wait (map + tooltip)
(Service-change drafts stay on the drafts page but aren't posted.)
A post with nothing to say that day is simply missing from the draft and skipped.
drafts/<day>/posted.json records what went out, so a slot never posts twice.

Nothing is posted unless WORK_DIR/bot-enabled exists; without it a slot only prints
what it would post. The site link in a draft is taken out of the text and posted as a
link card instead (the site's own title, description and nightly card image), so it
takes none of the 300 characters. Posts with an image can't also carry a card.

Usage: post.py SLOT [--dry-run] [--now] [--draft NAME]   (SLOT: morning, midday, evening or all)
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
SLOTS = {"morning": ["summary", "segment"], "midday": ["shortturn", "signal"], "evening": ["fleet", "stopwait"]}
# The site link in a draft; drafts written before the move to stuckin.to have the github.io one.
LINK = re.compile(r"\s*(https://(?:stuckin\.to|freems88\.github\.io/ttc-streetcar-delays)/\S*)")
# Same as the page's Open Graph tags (site/index.html).
CARD_TITLE = "Stuck: Toronto's streetcar delays"
CARD_DESC = ("Where Toronto streetcars lose time, how long riders wait, and how often they're held at "
             "signals. Updated daily from TTC vehicle positions.")
CARD_IMAGE = WORK_DIR / "site" / "data" / "card.png"
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


def split_link(text):
    """(text without the site link, the link or None)."""
    m = LINK.search(text)
    return (LINK.sub("", text).rstrip(), m.group(1)) if m else (text, None)


def tag_facets(text):
    """Bluesky only treats #words as hashtags (searchable, tappable) when the post marks them,
    by byte offset in the UTF-8 text."""
    from atproto import models
    facets = [models.AppBskyRichtextFacet.Main(
        index=models.AppBskyRichtextFacet.ByteSlice(byte_start=m.start(), byte_end=m.end()),
        features=[models.AppBskyRichtextFacet.Tag(tag=m.group(1).decode())])
        for m in re.finditer(rb"(?<![\w#])#([A-Za-z][A-Za-z0-9_]*)", text.encode("utf-8"))]
    return facets or None


def link_card(client, url):
    from atproto import models
    thumb = client.upload_blob(CARD_IMAGE.read_bytes()).blob if CARD_IMAGE.exists() else None
    return models.AppBskyEmbedExternal.Main(external=models.AppBskyEmbedExternal.External(
        uri=url, title=CARD_TITLE, description=CARD_DESC, thumb=thumb))


def main():
    slot = sys.argv[1] if len(sys.argv) > 1 else ""
    if slot not in SLOTS and slot != "all":
        sys.exit(f"usage: post.py {{{','.join(SLOTS)},all}} [--dry-run] [--now] [--draft NAME]")
    # --now posts even while the bot is switched off (a one-off test thread).
    dry = "--dry-run" in sys.argv or not (ENABLED.exists() or "--now" in sys.argv)
    # Yesterday's draft, by the service day (the nightly run writes it at 04:20), or a
    # named one (e.g. 2026-11-01-sofar).
    day = sys.argv[sys.argv.index("--draft") + 1] if "--draft" in sys.argv else service_day(time.time() - 86400)
    path = DRAFTS / day / "draft.json"
    if not path.exists():
        print(f"post: no draft for {day}; nothing to post", file=sys.stderr)
        return
    draft = json.loads(path.read_text())
    state_path = DRAFTS / day / "posted.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"done": []}
    kinds = [k for s in SLOTS.values() for k in s] if slot == "all" else SLOTS[slot]
    todo = [p for kind in kinds for p in draft["posts"] if p["kind"] == kind and kind not in state["done"]]
    if not todo:
        print(f"post: {day} {slot}: nothing to post", file=sys.stderr)
        return
    client = None if dry else login()
    for p in todo:
        text, url = split_link(p["text"])
        if dry:
            print(f"[dry run] {day} {slot} {p['kind']} ({len(text)} chars"
                  f"{', image' if p.get('image') else ''}{f', link card {url}' if url else ''}):\n{text}\n")
            continue
        from atproto import models
        reply = None
        if state.get("root"):
            ref = lambda r: models.ComAtprotoRepoStrongRef.Main(uri=r["uri"], cid=r["cid"])
            reply = models.AppBskyFeedPost.ReplyRef(root=ref(state["root"]), parent=ref(state["last"]))
        image = DRAFTS / day / p["image"] if p.get("image") else None
        if image and image.exists():
            res = client.send_image(text=text, image=image.read_bytes(), image_alt=p.get("alt", ""),
                                    image_aspect_ratio=models.AppBskyEmbedDefs.AspectRatio(
                                        width=IMAGE_SIZE[0], height=IMAGE_SIZE[1]),
                                    reply_to=reply, langs=["en-CA"], facets=tag_facets(text))
        else:
            res = client.send_post(text=text, reply_to=reply, langs=["en-CA"], facets=tag_facets(text),
                                   embed=link_card(client, url) if url else None)
        ref = {"uri": res.uri, "cid": res.cid}
        state.setdefault("root", ref)
        state["last"] = ref
        state["done"].append(p["kind"])
        state_path.write_text(json.dumps(state, indent=1))
        print(f"post: {day} {slot} {p['kind']} -> {res.uri}", file=sys.stderr)


if __name__ == "__main__":
    main()
