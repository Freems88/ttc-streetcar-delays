/* Toronto streetcar delay map: a 3D delay "curtain" over each piece of track. */
(async function () {
  const {MapboxOverlay, LineLayer, PathLayer, ScatterplotLayer} = deck;

  // Map colours per theme. On a dark map the top of the delay scale is bright magenta
  // instead of dark maroon, which would disappear; the clean-run speed scale mirrors it.
  const PALETTES = {
    light: {
      delay: [[0, [140, 197, 173]], [5, [243, 211, 107]], [15, [240, 139, 58]], [35, [198, 47, 47]], [70, [92, 10, 30]]],
      speed: [[0, [92, 10, 30]], [10, [198, 47, 47]], [20, [240, 139, 58]], [30, [243, 211, 107]],
        [40, [140, 197, 173]], [55, [60, 140, 120]]],
      base: [140, 197, 173, 200], faint: [180, 180, 180, 160], stop: [35, 35, 35, 220], vertical: [110, 110, 110, 70],
    },
    dark: {
      delay: [[0, [110, 190, 160]], [5, [243, 211, 107]], [15, [240, 139, 58]], [35, [230, 70, 70]], [70, [255, 90, 160]]],
      speed: [[0, [255, 90, 160]], [10, [230, 70, 70]], [20, [240, 139, 58]], [30, [243, 211, 107]],
        [40, [110, 190, 160]], [55, [60, 156, 134]]],
      base: [95, 160, 135, 220], faint: [110, 110, 110, 170], stop: [215, 215, 215, 220], vertical: [190, 190, 190, 55],
    },
  };
  let pal = PALETTES.light;
  const MAX_SHOWN = 100; // s per 100 m; taller peaks are capped (the tooltip shows the real value)
  const STATUS_TEXT = {
    normal: "Streetcars", diverted: "Streetcars, often off the usual track", mixed: "Some buses",
    bus: "Mostly buses", none: "No vehicles seen", nodata: "Not logged",
  };

  const state = {window: "recent", slot: "all", route: "", dir: "both", show: "all", signals: true, height: 12,
    view: "delay", stats: {}};
  // Slice labels from build_site: 0 elsewhere, 1 stop, 2 signal, 3 stop + signal.
  const KINDS = [
    {name: "Elsewhere", color: "#9fb8ad"}, {name: "Stop only", color: "#f3c95b"},
    {name: "Signal only", color: "#c62f2f"}, {name: "Stop + signal", color: "#f08b3a"},
  ];
  const BREAKDOWN_ORDER = [2, 3, 1, 0];

  const get = (f) => fetch(`data/${f}`, {cache: "no-cache"}).then((r) => r.json());
  // ?shot=1: screenshot mode for bot images (see renderShot).
  const params = new URLSearchParams(location.search);
  const SHOT = params.get("shot") === "1";
  const [meta, net, timeline] = await Promise.all([get("meta.json"), get("network.json"), get("timeline.json")]);
  state.stats.recent = await get("stats-recent.json");

  // --- static lookups -------------------------------------------------------------
  const pieces = net.pieces.map((p, i) => {
    const b0 = p.bins[0], b1 = p.bins[p.bins.length - 1];
    const brg = (Math.atan2((b1[0] - b0[0]) * Math.cos(43.67 * Math.PI / 180), b1[1] - b0[1]) * 180 / Math.PI + 360) % 360;
    return {...p, index: i, en: brg < 135 || brg >= 315};
  });
  const patterns = Object.fromEntries(net.patterns.map((p) => [p.id, p]));
  const sliceRoutes = new Map(); // "piece:bin" -> [pattern ids]
  for (const pat of net.patterns) {
    for (const [pi, b] of pat.slices) {
      const k = `${pi}:${b}`;
      if (!sliceRoutes.has(k)) sliceRoutes.set(k, []);
      sliceRoutes.get(k).push(pat.id);
    }
  }
  const routeNames = {};
  for (const p of net.patterns) routeNames[p.route] = p.name;

  // --- controls -------------------------------------------------------------------
  document.getElementById("window-days").textContent = meta.window_days;
  const slotSel = document.getElementById("slot");
  for (const [k, v] of Object.entries(meta.slots)) slotSel.add(new Option(v, k));
  const routeSel = document.getElementById("route");
  for (const r of Object.keys(routeNames).sort()) routeSel.add(new Option(`${r} ${routeNames[r]}`, r));

  function segGroup(attr, key) {
    document.querySelectorAll(`[data-${attr}]`).forEach((btn) => btn.addEventListener("click", async () => {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.classList.toggle("on", b === btn));
      state[key] = btn.dataset[attr];
      if (key === "window" && !state.stats.all) state.stats.all = await get("stats-all.json");
      render();
    }));
  }
  segGroup("window", "window");
  segGroup("dir", "dir");
  segGroup("show", "show");
  segGroup("view", "view");

  function updateViewChrome() {
    const speed = state.view === "speed";
    document.getElementById("speed-note").hidden = !speed;
    document.getElementById("slot-field").classList.toggle("disabled", speed);
    slotSel.disabled = speed;
    document.getElementById("breakdown-box").hidden = speed;
    document.getElementById("legend-title").textContent = speed
      ? "Clean-run speed, km/h (stops not counted)" : "Delay vs. clean run, seconds per 100 m";
    document.getElementById("legend-bar").classList.toggle("speed", speed);
    document.getElementById("legend-ticks").innerHTML = (speed ? ["0", "10", "20", "30", "40", "55+"]
      : ["0", "5", "15", "35", "70+"]).map((t) => `<span>${t}</span>`).join("");
  }
  slotSel.addEventListener("change", () => { state.slot = slotSel.value; render(); });
  routeSel.addEventListener("change", () => { state.route = routeSel.value; render(); flyToRoute(); });
  document.getElementById("height").addEventListener("input", (e) => { state.height = +e.target.value; render(); });
  document.getElementById("show-signals").addEventListener("change", (e) => { state.signals = e.target.checked; render(); });
  const panel = document.getElementById("panel");
  document.getElementById("panel-toggle").addEventListener("click", (e) => {
    panel.classList.toggle("collapsed");
    e.currentTarget.setAttribute("aria-expanded", !panel.classList.contains("collapsed"));
  });
  if (matchMedia("(max-width: 700px)").matches) panel.classList.add("collapsed");

  // "What's a clean run?" links anywhere on the page, including ones rendered later.
  const explain = document.getElementById("explain");
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-explain]");
    if (link) {
      explain.showModal();
      // data-explain="tsp" jumps to that section of the explainer.
      const section = link.dataset.explain && document.getElementById(`explain-${link.dataset.explain}`);
      explain.scrollTop = section ? section.offsetTop - 16 : 0;
    }
    else if (e.target.closest("[data-close]") || e.target === explain) explain.close();
  });

  // --- meta / preliminary banner --------------------------------------------------
  const w = meta.windows.recent;
  const fmt = (n) => n.toLocaleString("en-CA");
  const dayFmt = (d) => new Date(d + "T12:00").toLocaleDateString("en-CA", {month: "short", day: "numeric", year: "numeric"});
  document.getElementById("meta").innerHTML =
    `Based on ${w.days} day${w.days === 1 ? "" : "s"} (${dayFmt(w.from)} – ${dayFmt(meta.last_day)}) · ` +
    `${fmt(w.pings)} positions · ${fmt(w.samples)} slice passes. ` +
    `Updated ${new Date(meta.generated * 1000).toLocaleString("en-CA", {dateStyle: "medium", timeStyle: "short"})}.`;
  if (meta.windows.all.days < 14) {
    const el = document.getElementById("prelim");
    el.hidden = false;
    el.textContent = `Preliminary: ${meta.windows.all.days} day${meta.windows.all.days === 1 ? "" : "s"} of data so far. ` +
      "Numbers will move as more passes come in, and faint lines have very few.";
  }

  // --- theme ----------------------------------------------------------------------
  // "Auto" follows the system; a picked theme is remembered. Bot images are always light.
  const THEME_KEY = "ttc-delays-theme";
  const STYLES = {light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark"};
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  let themePref = "auto";
  try { themePref = localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { /* storage blocked */ }
  if (SHOT) themePref = "light";
  // ?theme=dark|light forces a theme for this visit (shared links, bot images) without saving it.
  if (["light", "dark"].includes(params.get("theme"))) themePref = params.get("theme");
  const isDark = () => themePref === "dark" || (themePref === "auto" && darkQuery.matches);
  function applyTheme() {
    if (themePref === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = themePref;
    pal = PALETTES[isDark() ? "dark" : "light"];
    document.querySelectorAll("[data-theme-pick]").forEach((b) => b.classList.toggle("on", b.dataset.themePick === themePref));
  }
  applyTheme();
  let mapDark = isDark();
  function themeChanged() {
    applyTheme();
    if (isDark() !== mapDark) {
      mapDark = isDark();
      map.setStyle(STYLES[mapDark ? "dark" : "light"]);
    }
    render();
  }
  document.querySelectorAll("[data-theme-pick]").forEach((b) => b.addEventListener("click", () => {
    themePref = b.dataset.themePick;
    try { localStorage.setItem(THEME_KEY, themePref); } catch (e) { /* storage blocked */ }
    themeChanged();
  }));
  darkQuery.addEventListener("change", () => { if (themePref === "auto") themeChanged(); });

  // --- shareable links --------------------------------------------------------------
  // Filters and camera live in the URL hash, e.g. #r=504&v=speed&c=-79.39,43.65,14,-17,58
  const HASH_KEYS = {w: "window", t: "slot", r: "route", d: "dir", s: "show", v: "view"};
  const DEFAULTS = {window: "recent", slot: "all", route: "", dir: "both", show: "all", view: "delay"};
  const ALLOWED = {window: ["recent", "all"], slot: Object.keys(meta.slots), route: ["", ...Object.keys(routeNames)],
    dir: ["both", "en", "ws"], show: ["all", "nostop"], view: ["delay", "speed"]};
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    for (const [k, key] of Object.entries(HASH_KEYS)) {
      if (ALLOWED[key].includes(h.get(k))) state[key] = h.get(k);
    }
    if (h.get("sig") === "0") state.signals = false;
    const c = (h.get("c") || "").split(",").map(Number);
    return c.length === 5 && c.every(Number.isFinite)
      ? {center: [c[0], c[1]], zoom: c[2], bearing: c[3], pitch: c[4]} : null;
  }
  function writeHash() {
    if (SHOT || !map) return;
    const h = new URLSearchParams();
    for (const [k, key] of Object.entries(HASH_KEYS)) if (state[key] !== DEFAULTS[key]) h.set(k, state[key]);
    if (!state.signals) h.set("sig", "0");
    const c = map.getCenter();
    h.set("c", [c.lng.toFixed(4), c.lat.toFixed(4), map.getZoom().toFixed(2), map.getBearing().toFixed(0),
      map.getPitch().toFixed(0)].join(","));
    history.replaceState(null, "", `#${h}`);
  }
  // Put the controls in line with state (after reading a link).
  function syncControls() {
    for (const [attr, key] of [["window", "window"], ["dir", "dir"], ["show", "show"], ["view", "view"]]) {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.classList.toggle("on", b.dataset[attr] === state[key]));
    }
    slotSel.value = state.slot;
    routeSel.value = state.route;
    document.getElementById("show-signals").checked = state.signals;
  }
  const linkCamera = SHOT ? null : readHash();
  // A link pasted into an open tab only changes the hash; reload to apply it. (Our own
  // updates use replaceState, which doesn't fire this.)
  addEventListener("hashchange", () => location.reload());
  syncControls();
  if (state.window === "all") state.stats.all = await get("stats-all.json");
  const copyBtn = document.getElementById("copy-link");
  copyBtn.addEventListener("click", async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      copyBtn.textContent = "Link copied";
    } catch (e) {
      copyBtn.textContent = "Copy the address bar to share this view";
    }
    setTimeout(() => { copyBtn.textContent = "Copy link to this view"; }, 2500);
  });

  // --- map ------------------------------------------------------------------------
  let map = null;
  map = new maplibregl.Map({
    container: "map",
    style: STYLES[mapDark ? "dark" : "light"],
    ...(innerWidth > 700 ? {center: [-79.395, 43.662], zoom: 12.5} : {center: [-79.405, 43.652], zoom: 11.3}),
    ...(linkCamera || {}),
    pitch: linkCamera ? linkCamera.pitch : 58, bearing: linkCamera ? linkCamera.bearing : -17, maxPitch: 75,
    attributionControl: {compact: true, customAttribution: "Data: TTC GTFS-Realtime via City of Toronto Open Data"},
  });
  map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), "top-right");
  if (innerWidth > 700 && !SHOT) map.setPadding({left: 360, top: 0, right: 0, bottom: 0});
  const overlay = new MapboxOverlay({interleaved: false, layers: [], pickingRadius: 10});
  map.addControl(overlay);
  map.on("moveend", writeHash);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") tip.hidden = true; });

  function colorFor(v, alpha, stops = pal.delay) {
    if (v >= stops[stops.length - 1][0]) return [...stops[stops.length - 1][1], alpha];
    for (let i = 1; i < stops.length; i++) {
      const [v1, c1] = stops[i];
      if (v <= v1) {
        const [v0, c0] = stops[i - 1];
        const t = (v - v0) / (v1 - v0);
        return [0, 1, 2].map((k) => Math.round(c0[k] + t * (c1[k] - c0[k]))).concat(alpha);
      }
    }
  }
  const confidence = (n) => (n >= 30 ? 255 : n >= 10 ? 170 : 90);

  // Both directions share a street, so with both shown each is drawn a few pixels to the
  // right of its direction of travel (Toronto drives on the right). A single direction
  // sits back on the track. The gap is in pixels, so it's recomputed on zoom.
  const OFFSET_PX = 4;
  const KX = Math.cos(43.67 * Math.PI / 180);
  for (const p of pieces) {
    p.normals = p.bins.map((_, b) => {
      const a = p.bins[Math.max(0, b - 1)], z = p.bins[Math.min(p.bins.length - 1, b + 1)];
      const dx = (z[0] - a[0]) * 111320 * KX, dy = (z[1] - a[1]) * 110540;
      const len = Math.hypot(dx, dy) || 1;
      // Right-hand normal of (dx, dy) is (dy, -dx), in degrees per metre.
      return [dy / len / (111320 * KX), -dx / len / 110540];
    });
  }
  let offsetM = 0;
  const pos = (p, b) => (offsetM ? [p.bins[b][0] + p.normals[b][0] * offsetM, p.bins[b][1] + p.normals[b][1] * offsetM]
    : p.bins[b]);
  // A piece's stops on its route, moved onto the piece's offset line when both directions show.
  function stopsOf(p) {
    return p.stops.flatMap((s) => {
      const b = Math.min(p.bins.length - 1, Math.floor(s.along / net.bin_m));
      if (!onRoute(p, b)) return [];
      const o = offsetM ? [p.normals[b][0] * offsetM, p.normals[b][1] * offsetM] : [0, 0];
      return [{pos: [s.lonlat[0] + o[0], s.lonlat[1] + o[1]], name: s.name}];
    });
  }
  function updateOffset() {
    offsetM = state.dir === "both" ? OFFSET_PX * 40075016 * KX / (512 * 2 ** map.getZoom()) : 0;
  }
  map.on("zoomend", () => { if (!SHOT && state.dir === "both") render(); });

  function visiblePieces() {
    return pieces.filter((p) => (!state.route || p.routes.includes(state.route)) &&
      (state.dir === "both" || (state.dir === "en") === p.en));
  }

  // With a route picked, only the slices its own patterns run over (pieces are shared).
  function onRoute(p, b) {
    if (!state.route) return true;
    return (sliceRoutes.get(`${p.index}:${b}`) || []).some((id) => patterns[id].route === state.route);
  }

  // Also drops stop-only spots when "Hide stop-only spots" is on.
  function binVisible(p, b) {
    return !(state.show === "nostop" && p.tags[b] === 1) && onRoute(p, b);
  }

  function runsOf(p) {
    const runs = [];
    let cur = null;
    for (let b = 0; b < p.bins.length; b++) {
      if (onRoute(p, b)) (cur ||= []).push(pos(p, b));
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return runs.filter((r) => r.length > 1);
  }

  // Smooth over ~125 m so single noisy slices don't dominate; gaps stay gaps.
  // The tooltip uses the same weights, so its numbers match the drawn height.
  const KERNEL = [1, 2, 3, 2, 1];
  function smoothAt(d, i) {
    if (d[i] == null) return null;
    let s = 0, w = 0;
    KERNEL.forEach((k, o) => { const x = d[i + o - 2]; if (x != null) { s += k * x; w += k; } });
    return s / w;
  }
  const smoothed = (d) => d.map((_, i) => smoothAt(d, i));

  // Clean-run speed at slice b, km/h: average the free-running times over ~125 m (so the
  // speed is distance over total time), the same smoothing the delay ridge uses.
  function speedAt(free, b) {
    const t = smoothAt(free, b);
    return t == null || t <= 0 ? null : net.bin_m / t * 3.6;
  }

  function renderSpeed() {
    const stats = state.stats[state.window];
    const segs = [], base = [], stops = [], sigShown = new Set();
    for (const p of visiblePieces()) {
      const st = stats.pieces[p.id];
      for (const path of runsOf(p)) base.push({path});
      p.sig.forEach((i, b) => { if (i >= 0 && onRoute(p, b)) sigShown.add(i); });
      stops.push(...stopsOf(p));
      if (!st || !st.free) continue;
      for (let b = 0; b + 1 < p.bins.length; b++) {
        if (!onRoute(p, b) || st.free[b] == null) continue;
        const kmh = speedAt(st.free, b);
        if (kmh == null) continue;
        // Near stops cars are braking and pulling away: fade so real slow zones stand out.
        const nearStop = p.tags[b] === 1 || p.tags[b] === 3;
        segs.push({path: [pos(p, b), pos(p, b + 1)], piece: p, bin: b, kmh,
          color: colorFor(kmh, nearStop ? 90 : confidence(st.n[b]), pal.speed)});
      }
    }
    drawn = segs.flatMap((s) => [...s.path[0], 0]);
    screenPts = null;
    overlay.setProps({layers: [
      new PathLayer({id: "base", data: base, getPath: (x) => x.path, getColor: pal.faint, widthUnits: "pixels", getWidth: 2}),
      new PathLayer({id: "speed", data: segs, getPath: (x) => x.path, getColor: (x) => x.color, widthUnits: "pixels",
        getWidth: 5, capRounded: true, pickable: true, autoHighlight: true, highlightColor: [0, 0, 0, 255],
        onHover: showSpeedTip, onClick: showSpeedTip, updateTriggers: {getColor: [state.window]}}),
      new ScatterplotLayer({id: "stops", data: stops, getPosition: (x) => x.pos,
          getRadius: 9, radiusUnits: "meters", radiusMinPixels: 1, radiusMaxPixels: 3,
        getFillColor: pal.stop}),
      new ScatterplotLayer({id: "signals", visible: state.signals, data: [...sigShown].map((i) => net.signals[i]),
        getPosition: (s) => s.lonlat, stroked: true,
        // Scale with zoom so markers don't swamp the track when zoomed out.
        getRadius: 14, radiusUnits: "meters", radiusMinPixels: 1.5, radiusMaxPixels: 5,
        lineWidthUnits: "meters", getLineWidth: 4, lineWidthMinPixels: 0.5, lineWidthMaxPixels: 1.5, getLineColor: [138, 28, 43, 255],
        getFillColor: (s) => (s.tsp ? [138, 28, 43, 255] : [255, 255, 255, 255]),
        pickable: true, onHover: showSignalTip, onClick: showSignalTip}),
    ]});
    renderRouteCard();
  }

  function render() {
    updateViewChrome();
    updateOffset();
    writeHash();
    document.getElementById("loading").hidden = true;
    if (state.view === "speed") return renderSpeed();
    const stats = state.stats[state.window];
    const ridge = [], verticals = [], base = [], stops = [];
    const lostByKind = [0, 0, 0, 0];
    const approaches = new Map();
    const sigShown = new Set();
    for (const p of visiblePieces()) {
      const st = stats.pieces[p.id];
      for (const path of runsOf(p)) base.push({path});
      p.sig.forEach((i, b) => { if (i >= 0 && onRoute(p, b)) sigShown.add(i); });
      stops.push(...stopsOf(p));
      if (!st) continue;
      const slot = st.slots[state.slot];
      const d = smoothed(slot.d);
      for (let b = 0; b < p.bins.length; b++) {
        if (d[b] == null || !binVisible(p, b)) continue;
        if (slot.d[b] != null) lostByKind[p.tags[b]] += slot.d[b] * net.bin_m / 100;
        // Signal approaches (one per piece and signal) for the priority comparison.
        if (slot.d[b] != null && p.sig[b] >= 0 && p.tags[b] >= 2) {
          const k = `${p.index}:${p.sig[b]}`;
          const a = approaches.get(k) || {lost: 0, slices: 0, passes: Infinity, tsp: net.signals[p.sig[b]].tsp};
          a.lost += slot.d[b] * net.bin_m / 100;
          a.slices += 1;
          a.passes = Math.min(a.passes, slot.n[b]);
          approaches.set(k, a);
        }
        const h = Math.min(d[b], MAX_SHOWN) * state.height;
        verticals.push({from: [...pos(p, b), 0], to: [...pos(p, b), h]});
        if (b + 1 < p.bins.length && d[b + 1] != null && binVisible(p, b + 1)) {
          const h2 = Math.min(d[b + 1], MAX_SHOWN) * state.height;
          const n = Math.min(slot.n[b], slot.n[b + 1]);
          ridge.push({
            from: [...pos(p, b), h], to: [...pos(p, b + 1), h2],
            color: colorFor((d[b] + d[b + 1]) / 2, confidence(n)), piece: p, bin: b, value: d[b],
          });
        }
      }
    }
    // Each curtain sampled at its foot, middle and top.
    drawn = verticals.flatMap((v) => [v.from[0], v.from[1], 0, v.from[0], v.from[1], v.to[2] / 2,
      v.from[0], v.from[1], v.to[2]]);
    screenPts = null;
    overlay.setProps({
      layers: [
        new PathLayer({id: "base", data: base, getPath: (x) => x.path, getColor: pal.base, widthUnits: "pixels", getWidth: 2.5}),
        new LineLayer({id: "verticals", data: verticals, getSourcePosition: (x) => x.from, getTargetPosition: (x) => x.to,
          getColor: pal.vertical, getWidth: 1}),
        new ScatterplotLayer({id: "stops", data: stops, getPosition: (x) => x.pos,
          getRadius: 9, radiusUnits: "meters", radiusMinPixels: 1, radiusMaxPixels: 3,
          getFillColor: pal.stop}),
        new ScatterplotLayer({id: "signals", visible: state.signals, data: [...sigShown].map((i) => net.signals[i]),
          getPosition: (s) => s.lonlat, stroked: true,
          getRadius: 14, radiusUnits: "meters", radiusMinPixels: 1.5, radiusMaxPixels: 5,
          lineWidthUnits: "meters", getLineWidth: 4, lineWidthMinPixels: 0.5, lineWidthMaxPixels: 1.5,
          getLineColor: [138, 28, 43, 255],
          getFillColor: (s) => (s.tsp ? [138, 28, 43, 255] : [255, 255, 255, 255]),
          pickable: true, onHover: showSignalTip, onClick: showSignalTip}),
        new LineLayer({id: "ridge", data: ridge, getSourcePosition: (x) => x.from, getTargetPosition: (x) => x.to,
          getColor: (x) => x.color, getWidth: 2.5, pickable: true, autoHighlight: true, highlightColor: [0, 0, 0, 255],
          onHover: showTooltip, onClick: showTooltip,
          updateTriggers: {getColor: [state.window, state.slot]}}),
      ],
    });
    renderRouteCard();
    renderBreakdown(lostByKind);
    renderTsp(approaches);
  }

  // Median time lost per signal approach, with vs without transit priority. A rate, not a
  // share: two-thirds of signals on the network have priority, so shares would mislead.
  const MIN_APPROACH_PASSES = 20;
  function renderTsp(approaches) {
    const groups = {true: [], false: []};
    for (const a of approaches.values()) {
      if (a.slices >= 3 && a.passes >= MIN_APPROACH_PASSES) groups[a.tsp].push(a.lost);
    }
    const median = (v) => {
      v.sort((x, y) => x - y);
      const m = v.length >> 1;
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    };
    const el = document.getElementById("tsp");
    if (groups.true.length < 5 || groups.false.length < 5) {
      el.innerHTML = `Not enough signal approaches in this view to compare transit priority. ` +
        `<button class="linkish" data-explain="tsp">Why?</button>`;
      return;
    }
    el.innerHTML = `<div><b>At signals, a typical streetcar loses</b> ${Math.round(median(groups.true))} s ` +
      `with transit priority · ${Math.round(median(groups.false))} s without</div>` +
      `<div class="tsp-sub">Median per signal approach · ${groups.true.length} / ${groups.false.length} approaches · ` +
      `<button class="linkish" data-explain="tsp">read with care</button></div>`;
  }

  function renderBreakdown(lost) {
    const total = lost.reduce((a, b) => a + b, 0);
    document.getElementById("breakdown").innerHTML = total ? BREAKDOWN_ORDER.map((k) => {
      const pct = 100 * lost[k] / total;
      return `<div class="bd-row"><span>${KINDS[k].name}</span>` +
        `<span class="bd-bar"><i style="--c:${KINDS[k].color};width:${pct.toFixed(1)}%"></i></span>` +
        `<span class="bd-pct">${Math.round(pct)}%</span></div>`;
    }).join("") : `<div class="bd-row"><span>No data in this view</span></div>`;
  }

  // --- tooltip --------------------------------------------------------------------
  const tip = document.getElementById("tooltip");
  const mins = (s) => (s == null ? "–" : `${Math.round(s / 60)} min`);

  function nearestStop(p, b) {
    const a = (b + 0.5) * net.bin_m;
    let best = null;
    for (const s of p.stops) if (!best || Math.abs(s.along - a) < Math.abs(best.along - a)) best = s;
    return best && Math.abs(best.along - a) < 400 ? best.name : null;
  }

  function routeLine(pid) {
    const pat = patterns[pid], r = state.stats[state.window].routes[pid];
    if (!r || !r.clean_s) return "";
    const typ = r.typical_s[state.slot] ?? r.typical_s.all;
    if (typ == null) return "";
    return `<div><b>${pat.route} ${pat.name}</b> ${pat.direction.toLowerCase()} to ${pat.to}: ` +
      `a typical trip loses <b>${mins(typ - r.clean_s)}</b> in total across all its segments ` +
      `(${mins(typ)} vs ${mins(r.clean_s)} clean-run total · scheduled ${mins(pat.sched_s)})</div>`;
  }

  function kindText(p, b) {
    const s = p.sig[b] >= 0 ? net.signals[p.sig[b]] : null;
    const sig = s ? `${s.midblock ? "pedestrian signal" : "signal"} at ${s.name}${s.tsp ? " (has transit priority)" : ""}` : "";
    switch (p.tags[b]) {
      case 1: return "At a stop with no signal: mostly boarding time";
      case 2: return `Approaching a ${sig}: red lights and queues`;
      case 3: return `At a stop and a ${sig}: boarding and red lights mixed`;
      default: return "Between stops and signals: traffic, turns or slow zones";
    }
  }

  // Screen positions of what's drawn (sample points of the curtains or speed lines), so the
  // tooltip can sit where it covers the least of the plot. Projected once per view.
  let drawn = [];        // flat [lon, lat, z, ...] set by render()/renderSpeed()
  let screenPts = null;  // flat [x, y, ...] for the current view
  map.on("move", () => { screenPts = null; });

  function plotPoints(viewport) {
    if (screenPts || !viewport) return screenPts || [];
    screenPts = [];
    for (let i = 0; i < drawn.length; i += 3) {
      const [x, y] = viewport.project([drawn[i], drawn[i + 1], drawn[i + 2]]);
      screenPts.push(x, y);
    }
    return screenPts;
  }

  function placeTip(info) {
    tip.hidden = false;
    // Measure at the left edge, so the old position can't squeeze the width.
    tip.style.left = "0px";
    tip.style.top = "0px";
    const w = tip.offsetWidth, h = tip.offsetHeight, gap = 14;
    const fit = ([x, y]) => [Math.max(8, Math.min(x, innerWidth - w - 8)), Math.max(8, Math.min(y, innerHeight - h - 8))];
    // Above first: the curtain hangs below its ridge line, so above is usually clear.
    const cands = [[info.x + gap, info.y - gap - h], [info.x - gap - w, info.y - gap - h],
      [info.x + gap, info.y + gap], [info.x - gap - w, info.y + gap]].map(fit);
    const pts = plotPoints(info.viewport);
    let best = cands[0], bestScore = Infinity;
    for (const [x, y] of cands) {
      if (info.x >= x && info.x <= x + w && info.y >= y && info.y <= y + h) continue; // never cover the cursor
      let score = 0;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] >= x && pts[i] <= x + w && pts[i + 1] >= y && pts[i + 1] <= y + h) score++;
      }
      if (score < bestScore) { best = [x, y]; bestScore = score; }
    }
    tip.style.left = `${best[0]}px`;
    tip.style.top = `${best[1]}px`;
  }

  function showSpeedTip(info) {
    if (!info.object) { tip.hidden = true; return; }
    const {piece: p, bin: b, kmh} = info.object;
    const st = state.stats[state.window].pieces[p.id];
    const stop = nearestStop(p, b);
    const nearStop = p.tags[b] === 1 || p.tags[b] === 3;
    tip.innerHTML =
      `<div class="t-title">${stop ? `Near ${stop}` : "Streetcar track"}</div>` +
      `<div class="t-dim">${p.routes.join(", ")}</div>` +
      `<div class="t-big">${Math.round(kmh)} km/h clean-run speed</div>` +
      `<div class="t-dim">How fast the quickest 10% of daytime passes move here, not counting time stopped at stops.` +
      `<br>${fmt(st.n[b])} passes</div>` +
      (nearStop ? `<div class="t-kind">Near a stop: cars are braking or pulling away, so slow is expected.</div>` : "");
    placeTip(info);
  }

  function showSignalTip(info) {
    if (!info.object) { tip.hidden = true; return; }
    const s = info.object;
    tip.innerHTML = `<div class="t-title">${s.midblock ? "Pedestrian signal" : "Traffic signal"}: ${s.name}</div>` +
      `<div class="t-dim">${s.tsp ? "Has transit signal priority (can extend a green or shorten a red for a streetcar)."
        : "No transit signal priority."}</div>`;
    placeTip(info);
  }

  function showTooltip(info) {
    if (!info.object) { tip.hidden = true; return; }
    const {piece: p, bin: b} = info.object;
    const st = state.stats[state.window].pieces[p.id];
    const slot = st.slots[state.slot];
    const stop = nearestStop(p, b);
    // Same ~125 m weighted average the ridge is drawn with.
    const rate = smoothAt(slot.d, b);
    const span = [-2, -1, 0, 1, 2].filter((o) => slot.d[b + o] != null).length * net.bin_m;
    const lostHere = rate * span / 100;
    const cleanHere = smoothAt(st.clean.map((c, i) => (slot.d[i] == null ? null : c)), b) * span / net.bin_m;
    const typical = cleanHere + lostHere;
    const days = meta.windows[state.window].days;
    const routes = (sliceRoutes.get(`${p.index}:${b}`) || []).filter((id) => !state.route || patterns[id].route === state.route);
    tip.innerHTML =
      `<div class="t-title">${stop ? `Near ${stop}` : "Streetcar track"}</div>` +
      `<div class="t-dim">${p.routes.join(", ")} · ${meta.slots[state.slot]}</div>` +
      `<div class="t-kind">${kindText(p, b)}</div>` +
      `<div class="t-big">${rate.toFixed(1)} s lost per 100 m</div>` +
      `<div>The ${span} m around here cost a typical car <b>${lostHere < 1 ? "under 1 s" : `${Math.round(lostHere)} s`}</b></div>` +
      `<div class="t-dim">${cleanHere.toFixed(1)} s clean run vs ${typical.toFixed(1)} s typical<br>` +
      `${fmt(slot.n[b])} passes · streetcars passed here on ${st.days[b]} of ${days} day${days === 1 ? "" : "s"}</div>` +
      (routes.length ? `<div class="t-routes"><div class="t-head">Whole route${routes.length > 1 ? "s" : ""} through here</div>` +
        `${routes.map(routeLine).join("")}</div>` : "") +
      `<div class="t-routes t-dim">Clean run: each segment's fastest 10% of real daytime passes, stops included. More under “?” on the legend.</div>`;
    placeTip(info);
  }
  map.getCanvas().addEventListener("mouseleave", () => { tip.hidden = true; });

  // --- route card -----------------------------------------------------------------
  function renderRouteCard() {
    const card = document.getElementById("route-card");
    if (!state.route) { card.hidden = true; return; }
    const stats = state.stats[state.window];
    const dirs = net.patterns.filter((p) => p.route === state.route);
    let html = `<h2>${state.route} ${routeNames[state.route]}</h2>`;
    for (const pat of dirs) {
      const r = stats.routes[pat.id] || {};
      const typ = r.typical_s ? (r.typical_s[state.slot] ?? r.typical_s.all) : null;
      let movedTxt = "";
      if (r.moved) {
        const m = r.moved.change_s / 60;
        movedTxt = ` · clean-run total ${Math.abs(m) < 0.05 ? "unchanged" : `moved ${m > 0 ? "+" : "−"}${Math.abs(m).toFixed(1)} min`} since ${dayFmt(r.moved.since)}`;
      }
      html += `<div class="dir"><div class="dir-name">${pat.direction} to ${pat.to}</div>` +
        `<div class="dir-stats">` +
        (r.clean_s && typ != null ? `A typical trip loses <b>${mins(typ - r.clean_s)}</b> to delays` +
          `<br>${mins(typ)} typical vs ${mins(r.clean_s)} ` +
          `<button class="linkish" data-explain>clean-run total</button> · scheduled ${mins(pat.sched_s)}` +
          `<br>${fmt(r.samples)} slice passes · ${Math.round(r.data_coverage * 100)}% of the route measured${movedTxt}`
          : "No streetcar data yet for this direction") +
        `</div></div>`;
    }
    const rows = timeline.routes[state.route] || [];
    const seen = new Map();
    const cells = rows.map((row) => {
      for (const a of row.alerts || []) if (!seen.has(a)) seen.set(a, row.day);
      const title = `${dayFmt(row.day)}: ${STATUS_TEXT[row.status]}` +
        (row.bus_share ? ` (${Math.round(row.bus_share * 100)}% buses)` : "") +
        ((row.alerts || []).length ? `\n${row.alerts.map((a) => "• " + (timeline.alerts[a]?.text || "")).join("\n")}` : "");
      return `<i class="${row.status}${(row.alerts || []).length ? " alert" : ""}" title="${title.replace(/"/g, "&quot;")}"></i>`;
    }).join("");
    html += `<div class="timeline-label"><span>Last ${rows.length} days</span><span>today</span></div>` +
      `<div class="timeline">${cells}</div>` +
      `<div class="timeline-key"><span style="--c:var(--s-normal)">streetcars</span><span style="--c:var(--s-diverted)">off usual track</span>` +
      `<span style="--c:var(--s-mixed)">some buses</span><span style="--c:var(--s-bus)">mostly buses</span><span style="--c:var(--s-nodata)">not logged</span></div>`;
    if (seen.size) {
      const list = [...seen.keys()].slice(-6).reverse().map((a) => {
        const t = timeline.alerts[a];
        return t ? `<li>${t.text.replace(/</g, "&lt;")}${t.url ? ` <a href="${t.url}" target="_blank" rel="noopener">details</a>` : ""}</li>` : "";
      }).join("");
      html += `<div class="timeline-label"><span>Recent TTC alerts for this route</span></div><ul class="alerts-list">${list}</ul>`;
    }
    card.innerHTML = html;
    card.hidden = false;
  }

  function flyToRoute() {
    const ps = visiblePieces();
    if (!ps.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of ps) for (const run of runsOf(p)) for (const c of run) b.extend(c);
    map.fitBounds(b, {padding: {top: 80, bottom: 80, left: innerWidth > 700 ? 400 : 40, right: 80},
      pitch: 50, bearing: -17, duration: 1200});
  }

  // --- screenshot mode ------------------------------------------------------------
  // ?shot=1&win=yesterday&piece=p8&b0=100&b1=112[&slot=all&ctx=500&title=..&sub=..]
  // Frames one segment (slices b0..b1 of a piece) along the Toronto street grid, with
  // the track either side faded for context, and sets window.__shotReady once drawn.
  const GRID = -17; // Toronto's street grid, degrees from north

  async function renderShot() {
    document.body.classList.add("shot");
    document.getElementById("loading").hidden = true;
    const stats = await get(`stats-${params.get("win") || "yesterday"}.json`);
    const p = pieces.find((x) => x.id === params.get("piece"));
    const b0 = +params.get("b0"), b1 = +params.get("b1");
    const slot = params.get("slot") || "all";
    const ctx = Math.round((+params.get("ctx") || 500) / net.bin_m);
    const lo = Math.max(0, b0 - ctx), hi = Math.min(p.bins.length - 1, b1 + ctx);
    const st = stats.pieces[p.id];
    const d = st ? smoothed(st.slots[slot].d) : [];
    // Scale so the segment's tallest peak stands about 320 m high, whatever its value.
    const peak = Math.max(10, ...d.slice(b0, b1 + 1).filter((v) => v != null));
    const k = 320 / Math.min(peak, MAX_SHOWN);
    const inSeg = (b) => b >= b0 && b <= b1;
    const ridge = [], verticals = [];
    for (let b = lo; b <= hi; b++) {
      if (d[b] == null) continue;
      const h = Math.min(d[b], MAX_SHOWN) * k;
      verticals.push({from: [...p.bins[b], 0], to: [...p.bins[b], h], seg: inSeg(b)});
      if (b < hi && d[b + 1] != null) {
        ridge.push({from: [...p.bins[b], h], to: [...p.bins[b + 1], Math.min(d[b + 1], MAX_SHOWN) * k],
          color: inSeg(b) ? colorFor((d[b] + d[b + 1]) / 2, 255) : [150, 150, 150, 150], seg: inSeg(b)});
      }
    }
    const nearSlice = (s) => { const b = Math.floor(s.along / net.bin_m); return b >= lo && b <= hi; };
    const sigIdx = new Set(p.sig.slice(lo, hi + 1).filter((i) => i >= 0));
    overlay.setProps({layers: [
      new PathLayer({id: "base", data: pieces, getPath: (x) => x.bins, getColor: [160, 160, 160, 110],
        widthUnits: "pixels", getWidth: 2}),
      new PathLayer({id: "seg-base", data: [{path: p.bins.slice(lo, hi + 1)}], getPath: (x) => x.path,
        getColor: pal.base, widthUnits: "pixels", getWidth: 3.5}),
      new LineLayer({id: "verticals", data: verticals, getSourcePosition: (x) => x.from, getTargetPosition: (x) => x.to,
        getColor: (x) => (x.seg ? [110, 110, 110, 110] : [150, 150, 150, 50]), getWidth: 1}),
      new ScatterplotLayer({id: "stops", data: p.stops.filter(nearSlice), getPosition: (s) => s.lonlat,
        getRadius: 4, radiusUnits: "pixels", getFillColor: [35, 35, 35, 230]}),
      new ScatterplotLayer({id: "signals", data: [...sigIdx].map((i) => net.signals[i]), getPosition: (s) => s.lonlat,
        getRadius: 6, radiusUnits: "pixels", stroked: true, lineWidthUnits: "pixels", getLineWidth: 2,
        getLineColor: [138, 28, 43, 255], getFillColor: (s) => (s.tsp ? [138, 28, 43, 255] : [255, 255, 255, 255])}),
      new LineLayer({id: "ridge", data: ridge, getSourcePosition: (x) => x.from, getTargetPosition: (x) => x.to,
        getColor: (x) => x.color, getWidth: (x) => (x.seg ? 4 : 2.5)}),
    ]});

    const callout = document.getElementById("callout");
    for (const [cls, text] of [["c-title", params.get("title")], ["c-sub", params.get("sub")],
      ["c-site", "freems88.github.io/ttc-streetcar-delays"]]) {
      if (!text) continue;
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text;
      callout.append(div);
    }
    callout.hidden = false;

    // Turn the camera so the segment runs across the image, snapped to the street grid,
    // preferring the view closest to the site's usual one.
    const [a, z] = [p.bins[b0], p.bins[b1]];
    const theta = (Math.atan2((z[0] - a[0]) * Math.cos(43.67 * Math.PI / 180), z[1] - a[1]) * 180 / Math.PI + 360) % 360;
    const snap = (x) => GRID + Math.round((x - GRID) / 90) * 90;
    const off = (x) => Math.abs((((x - GRID) % 360) + 540) % 360 - 180);
    const bearing = [snap(theta - 90), snap(theta + 90)].sort((u, v) => off(u) - off(v))[0];
    const bounds = new maplibregl.LngLatBounds();
    for (const c of p.bins.slice(lo, hi + 1)) bounds.extend(c);
    map.once("idle", () => requestAnimationFrame(() => requestAnimationFrame(() => { window.__shotReady = true; })));
    setTimeout(() => { window.__shotReady ||= "timeout"; }, 60000);
    map.fitBounds(bounds, {bearing, pitch: 50, duration: 0,
      padding: {top: Math.round(innerHeight * 0.38), bottom: 60, left: 60, right: 60}});
  }

  if (SHOT) renderShot(); else render();
})();
