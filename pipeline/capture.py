#!/usr/bin/env python3
"""Screenshot a page with headless Chromium once it says it's fully drawn.

Chromium's plain --screenshot flag can't wait for map tiles, so this drives it over
the DevTools protocol: load the page, poll `window.__shotReady` (set by the map's
screenshot mode once tiles and layers are drawn), then capture. No GPU is used
(SwiftShader software rendering); a Pi 4 takes ~30-60 s per image.

Usage: capture.py URL OUT.png [WIDTH HEIGHT]
Needs: websocket-client (installed in ~/ttc-streetcars/venv), chromium.
"""
import base64
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

TIMEOUT_S = 150


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DevTools:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self.next_id = 0

    def call(self, method, **params):
        self.next_id += 1
        self.ws.send(json.dumps({"id": self.next_id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.next_id:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})


def capture(url, out, width=1200, height=900):
    browser = shutil.which("chromium") or shutil.which("chromium-browser")
    port = free_port()
    profile = tempfile.mkdtemp(prefix="ttc-shot-")
    proc = subprocess.Popen(
        [browser, "--headless=new", "--hide-scrollbars", "--no-first-run", "--mute-audio",
         "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         f"--window-size={width},{height}", f"--user-data-dir={profile}",
         f"--remote-debugging-port={port}", "--remote-allow-origins=*", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 30
        while True:
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:
                if time.time() > deadline:
                    raise RuntimeError("chromium did not start")
                time.sleep(0.5)
        dt = DevTools(page["webSocketDebuggerUrl"])
        dt.call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=False)
        dt.call("Page.enable")
        dt.call("Page.navigate", url=url)
        deadline = time.time() + TIMEOUT_S
        ready = None
        while time.time() < deadline:
            ready = dt.call("Runtime.evaluate", expression="window.__shotReady || null",
                            returnByValue=True)["result"].get("value")
            if ready:
                break
            time.sleep(1)
        if not ready:
            raise RuntimeError("page never reported ready")
        png = base64.b64decode(dt.call("Page.captureScreenshot", format="png")["data"])
        with open(out, "wb") as f:
            f.write(png)
        return ready
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    url, out = sys.argv[1], sys.argv[2]
    w, h = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (1200, 900)
    t = time.time()
    ready = capture(url, out, w, h)
    print(f"captured {out} in {time.time() - t:.0f}s (ready: {ready})", file=sys.stderr)
