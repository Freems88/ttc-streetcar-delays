/* Toronto streetcar delay map: a 3D delay "curtain" over each piece of track. */
(async function () {
  const {MapboxOverlay, LineLayer, PathLayer, ScatterplotLayer, IconLayer, ColumnLayer} = deck;

  // Map colours per theme. On a dark map the top of the delay scale is bright magenta
  // instead of dark maroon, which would disappear; the clean-run speed scale mirrors it.
  const PALETTES = {
    light: {
      delay: [[0, [140, 197, 173]], [8, [243, 211, 107]], [15, [240, 139, 58]], [30, [198, 47, 47]], [60, [92, 10, 30]]],
      speed: [[0, [92, 10, 30]], [10, [198, 47, 47]], [20, [240, 139, 58]], [30, [243, 211, 107]],
        [40, [140, 197, 173]], [55, [60, 140, 120]]],
      base: [140, 197, 173, 200], faint: [180, 180, 180, 160], stop: [35, 35, 35, 220], vertical: [110, 110, 110, 70],
    },
    dark: {
      delay: [[0, [110, 190, 160]], [8, [243, 211, 107]], [15, [240, 139, 58]], [30, [230, 70, 70]], [60, [255, 90, 160]]],
      speed: [[0, [255, 90, 160]], [10, [230, 70, 70]], [20, [240, 139, 58]], [30, [243, 211, 107]],
        [40, [110, 190, 160]], [55, [60, 156, 134]]],
      base: [95, 160, 135, 220], faint: [110, 110, 110, 170], stop: [215, 215, 215, 220], vertical: [190, 190, 190, 55],
    },
  };
  // Waits view: the delay colours at excess-wait breaks of 0, 1, 2, 4 and 8+ minutes.
  const WAIT_BREAKS = [0, 1, 2, 4, 8];
  for (const pl of Object.values(PALETTES)) pl.wait = pl.delay.map(([, c], i) => [WAIT_BREAKS[i], c]);
  let pal = PALETTES.light;
  const MAX_SHOWN = 100; // s per 100 m; taller peaks are capped (the tooltip shows the real value)
  // Peaks rise with the square root of the delay, so the few worst spots don't swamp the
  // map and small delays still lift off the street; colour and the tooltip give the value.
  const peakHeight = (v) => Math.sqrt(Math.min(v, MAX_SHOWN)) * state.height * 4;
  const STATUS_TEXT = {
    normal: "Streetcars", diverted: "Streetcars, often off the usual track", mixed: "Some buses",
    bus: "Mostly buses", none: "No vehicles seen", nodata: "Not logged",
  };

  const state = {window: "recent", days: "all", time: "all", range: [7, 10], route: "", dir: "both",
    signals: true, height: 12, view: "delay", stats: {}, heads: {}};
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
  const WINDOW_LABELS = {d15: "Last 15 days", d30: "Last 30 days", recent: `Last ${meta.window_days} days`, all: "All time"};
  // Each window's stats are a separate file, fetched the first time it's picked.
  async function loadWindow(w) {
    if (!state.stats[w]) state.stats[w] = await get(`stats-${w}.json`);
  }
  // --- time of day ----------------------------------------------------------------
  // Days (all / weekdays / weekends) x an hour range [from, to): a preset chip or any range
  // on the two-handle slider (narrow it to one hour for a single hour). "All day, all
  // days" uses the window's stats as-is; anything else is built from per-hour data
  // (hours-<window>.json), fetched the first time it's needed.
  const PRESETS = {all: [0, 24, "All day"], am: [6, 10, "AM peak"], mid: [10, 15, "Midday"], pm: [15, 19, "PM peak"],
    eve: [19, 24, "Evening"], night: [0, 6, "Overnight"]};
  const DAYS_LABELS = {all: "All days", wd: "Weekdays", we: "Weekends"};
  state.hourData = {};
  const usesHours = () => !(state.time === "all" && state.days === "all");
  const hourRange = () => (state.time === "custom" ? state.range : PRESETS[state.time].slice(0, 2));
  const clock = (h) => (h % 24 === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`);
  function timeLabel() {
    const [a, b] = hourRange();
    const hours = state.time === "custom" ? `${clock(a)}–${clock(b)}` : PRESETS[state.time][2];
    return `${DAYS_LABELS[state.days]} · ${hours}`;
  }
  async function loadHours(w) {
    if (usesHours() && !state.hourData[w]) state.hourData[w] = await get(`hours-${w}.json`);
  }
  // Headway sums per stop, route and hour (headways-<window>.json), for the waits view,
  // route cards and the routes chart; fetched the first time one of those needs them.
  const needHeads = () => state.view === "wait" || !!state.route;
  async function loadHeads(w, force) {
    if ((force || needHeads()) && !state.heads[w]) state.heads[w] = await get(`headways-${w}.json`);
  }
  // Hour keys (0-23 weekday, 24-47 weekend) in the current time selection.
  function hourKeys() {
    const [a, z] = hourRange(), keys = [];
    for (let h = a; h < z; h++) {
      if (state.days !== "we") keys.push(String(h));
      if (state.days !== "wd") keys.push(String(h + 24));
    }
    return keys;
  }
  // A range that matches a preset is that preset, so its chip lights up.
  function setRange(a, b) {
    const match = Object.entries(PRESETS).find(([, [pa, pb]]) => pa === a && pb === b);
    state.time = match ? match[0] : "custom";
    state.range = [a, b];
  }

  const rangeEl = document.getElementById("hour-range");
  const fill = rangeEl.querySelector(".range-fill");
  const thumbs = {a: rangeEl.querySelector('[data-thumb="a"]'), b: rangeEl.querySelector('[data-thumb="b"]')};
  function syncTimeControls() {
    document.querySelectorAll("[data-days]").forEach((b) => b.classList.toggle("on", b.dataset.days === state.days));
    document.querySelectorAll("[data-time]").forEach((b) => b.classList.toggle("on", b.dataset.time === state.time));
    const [a, b] = hourRange();
    thumbs.a.style.left = `${a / 24 * 100}%`;
    thumbs.b.style.left = `${b / 24 * 100}%`;
    fill.style.left = `${a / 24 * 100}%`;
    fill.style.width = `${(b - a) / 24 * 100}%`;
    thumbs.a.setAttribute("aria-valuenow", a);
    thumbs.a.setAttribute("aria-valuetext", clock(a));
    thumbs.b.setAttribute("aria-valuenow", b);
    thumbs.b.setAttribute("aria-valuetext", clock(b));
    document.getElementById("time-label").textContent = `(${timeLabel()})`;
  }
  async function timeChanged() {
    syncTimeControls();
    await loadHours(state.window);
    render();
  }
  document.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => { state.days = b.dataset.days; timeChanged(); }));
  document.querySelectorAll("[data-time]").forEach((b) => b.addEventListener("click", () => {
    setRange(...PRESETS[b.dataset.time].slice(0, 2));
    timeChanged();
  }));

  // Dragging: a handle moves one end; the fill moves both, keeping the width.
  const hourAt = (clientX) => {
    const r = rangeEl.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 24);
  };
  function moveTo(what, h, grab) {
    let [a, b] = hourRange();
    if (what === "a") a = Math.min(h, b - 1);
    else if (what === "b") b = Math.max(h, a + 1);
    else {
      const w = b - a;
      a = Math.max(0, Math.min(24 - w, h - grab));
      b = a + w;
    }
    if ([a, b].join() !== hourRange().join()) {
      setRange(a, b);
      timeChanged();
    }
  }
  for (const [what, el] of [["a", thumbs.a], ["b", thumbs.b], ["fill", fill]]) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const grab = hourAt(e.clientX) - hourRange()[0];
      const onMove = (ev) => moveTo(what, hourAt(ev.clientX), grab);
      const onUp = () => { el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerup", onUp); };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  }
  for (const [what, el] of Object.entries(thumbs)) {
    el.addEventListener("keydown", (e) => {
      const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[e.key];
      if (!step) return;
      e.preventDefault();
      moveTo(what, hourRange()[what === "a" ? 0 : 1] + step);
    });
  }

  // The delay and pass arrays for a piece under the current time selection.
  let viewKey = "", viewCache = new Map();
  function viewOf(p, st) {
    if (!usesHours()) return st.slots.all;
    const key = `${state.window}|${state.days}|${hourRange()}`;
    if (key !== viewKey) { viewKey = key; viewCache = new Map(); }
    if (viewCache.has(p.id)) return viewCache.get(p.id);
    const nb = p.bins.length, d = new Array(nb).fill(null), n = new Array(nb).fill(0);
    const hp = state.hourData[state.window]?.pieces[p.id];
    if (hp) {
      const [a, z] = hourRange();
      const rows = hourKeys().map((k) => hp[k]).filter(Boolean);
      for (let b = 0; b < nb; b++) {
        if (st.clean[b] == null) continue;
        let c = 0, s = 0;
        for (const [cn, mn] of rows) if (cn[b]) { c += cn[b]; s += cn[b] * mn[b]; }
        if (c) { n[b] = c; d[b] = Math.max(0, s / c - st.clean[b]) * 100 / net.bin_m; }
      }
    }
    const v = {d, n};
    viewCache.set(p.id, v);
    return v;
  }

  // A route direction's typical trip time under the current time selection: its slices'
  // mean times where this selection has data, the all-day mean elsewhere. Null if under
  // half the route has data for the selection.
  function typicalFor(pat, r) {
    if (!r || !r.typical_s) return null;
    if (!usesHours()) return r.typical_s.all ?? null;
    const stats = state.stats[state.window];
    let total = 0, have = 0, all = 0;
    for (const [pi, b] of pat.slices) {
      const p = pieces[pi], st = stats.pieces[p.id];
      if (!st || st.clean[b] == null) continue;
      all += 1;
      const v = viewOf(p, st);
      const d = v.n[b] ? v.d[b] : st.slots.all.d[b];
      if (v.n[b]) have += 1;
      total += st.clean[b] + (d ?? 0) * net.bin_m / 100;
    }
    return all && have >= 0.5 * all ? Math.round(total) : null;
  }

  const routeSel = document.getElementById("route");
  for (const r of Object.keys(routeNames).sort()) routeSel.add(new Option(`${r} ${routeNames[r]}`, r));

  function segGroup(attr, key) {
    document.querySelectorAll(`[data-${attr}]`).forEach((btn) => btn.addEventListener("click", async () => {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.classList.toggle("on", b === btn));
      state[key] = btn.dataset[attr];
      if (key === "window") {
        await loadWindow(state.window);
        await loadHours(state.window);
      }
      await loadHeads(state.window);
      render();
    }));
  }
  segGroup("window", "window");
  segGroup("dir", "dir");
  segGroup("view", "view");

  function updateViewChrome() {
    const speed = state.view === "speed", wait = state.view === "wait";
    document.getElementById("speed-note").hidden = !speed;
    document.getElementById("wait-note").hidden = !wait;
    // Clean-run speed is all daytime pooled, so time of day doesn't apply.
    document.getElementById("time-field").classList.toggle("disabled", speed);
    document.querySelectorAll("#time-field button").forEach((el) => { el.disabled = speed; });
    document.getElementById("breakdown-box").hidden = speed || wait;
    document.getElementById("show-signals").disabled = wait;
    document.getElementById("legend-title").textContent = speed ? "Clean-run speed, km/h (stops not counted)"
      : wait ? "Excess wait at stops, minutes" : "Delay vs. clean run, seconds per 100 m";
    document.getElementById("legend-bar").classList.toggle("speed", speed);
    document.getElementById("legend-ticks").innerHTML = (speed ? ["0", "10", "20", "30", "40", "55+"]
      : wait ? ["0", "1", "2", "4", "8+"] : ["0", "8", "15", "30", "60+"]).map((t) => `<span>${t}</span>`).join("");
    document.querySelectorAll(".legend-key .k-sig, .legend-key .k-tsp, .legend-key .k-turn")
      .forEach((el) => { el.parentElement.hidden = wait; });
  }
  routeSel.addEventListener("change", async () => {
    state.route = routeSel.value;
    await loadHeads(state.window);
    render();
    flyToRoute();
  });
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
      document.querySelectorAll("dialog[open]").forEach((d) => d.close());
      explain.showModal();
      // data-explain="tsp" jumps to that section of the explainer.
      const section = link.dataset.explain && document.getElementById(`explain-${link.dataset.explain}`);
      explain.scrollTop = section ? section.offsetTop - 16 : 0;
    }
    else if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
    else if (e.target.tagName === "DIALOG") e.target.close(); // click on the backdrop
  });

  // --- waits (headway regularity) --------------------------------------------------
  // Per stop and route, sums over the selected hours (see pipeline/headways.py):
  // [n, sum h, sum h², bunched, gaps, sum scheduled h at each observed one,
  //  sum (h - scheduled)², scheduled n, scheduled sum h, scheduled sum h²], seconds.
  const ALL_KEYS = Array.from({length: 48}, (_, i) => String(i));
  const MIN_HEADWAYS = 20;
  // TCQSM headway adherence (coefficient of variation of headway deviations).
  const TCQSM = [[0.21, "A", "like clockwork"], [0.30, "B", "slightly off headway"], [0.39, "C", "often off headway"],
    [0.52, "D", "irregular, some bunching"], [0.74, "E", "frequent bunching"], [Infinity, "F", "most cars bunched"]];
  function waitStats(a) {
    if (!a) return null;
    const [n, sh, sh2, nb, ng, shm, sd2, ns, shs, shs2] = a;
    if (n < MIN_HEADWAYS || ns < MIN_HEADWAYS) return null;
    const awt = sh2 / (2 * sh) / 60, swt = shs2 / (2 * shs) / 60, even = sh / (2 * n) / 60;
    const cv = Math.sqrt(sd2 / n) / (shm / n);
    return {n, ns, awt, swt, ewt: awt - swt, uneven: awt - even, missing: even - swt, bunched: nb / n, gaps: ng / n,
      seen: n / ns, cv, los: TCQSM.find(([x]) => cv <= x), schedH: shs / ns / 60};
  }
  function sumHours(hours, keys) {
    if (!hours) return null;
    let acc = null;
    for (const k of keys) {
      const row = hours[k];
      if (!row) continue;
      acc ||= new Array(row.length).fill(0);
      row.forEach((v, i) => { acc[i] += v; });
    }
    return acc;
  }
  const stopWaits = (stopId, route, keys = hourKeys()) =>
    waitStats(sumHours(state.heads[state.window]?.stops[stopId]?.[route], keys));
  // Each route direction's stops, in order along its pattern.
  const patternStops = {};
  for (const pat of net.patterns) {
    const ids = [], on = new Set(pat.slices.map(([pi, b]) => `${pi}:${b}`));
    for (const [pi] of pat.slices) {
      for (const st of pieces[pi].stops) {
        const b = Math.min(pieces[pi].bins.length - 1, Math.floor(st.along / net.bin_m));
        if (on.has(`${pi}:${b}`) && !ids.includes(st.id)) ids.push(st.id);
      }
    }
    patternStops[pat.id] = ids;
  }
  // A route direction's waits: excess wait averaged over its stops (as TfL averages a route's
  // timing points); bunching, gaps and cars seen pooled over all its headways.
  function routeWaits(pat, keys = hourKeys()) {
    const per = patternStops[pat.id].map((id) => stopWaits(id, pat.route, keys)).filter(Boolean);
    if (per.length < 3) return null;
    const sum = (f) => per.reduce((t, w) => t + f(w), 0);
    const n = sum((w) => w.n);
    return {stops: per.length, ewt: sum((w) => w.ewt) / per.length, awt: sum((w) => w.awt) / per.length,
      swt: sum((w) => w.swt) / per.length, bunched: sum((w) => w.bunched * w.n) / n, gaps: sum((w) => w.gaps * w.n) / n,
      seen: n / sum((w) => w.ns)};
  }

  // --- routes compared ------------------------------------------------------------
  // Hours a day of streetcar service spent beyond clean runs, per route and direction,
  // as sorted bars. Tapping a row shows that route and direction on the map.
  const compareDlg = document.getElementById("compare");
  document.getElementById("compare-open").addEventListener("click", async () => {
    await loadHeads(state.window, true);
    renderCompare();
    compareDlg.showModal();
  });

  // Two measures: per km (how bad a route is, length aside; the map's own unit) and
  // total a day (where the most time goes, so long and frequent routes count for more).
  let compareMeasure = "perkm";
  document.querySelectorAll("[data-measure]").forEach((b) => b.addEventListener("click", async () => {
    compareMeasure = b.dataset.measure;
    await loadHeads(state.window, true);
    document.querySelectorAll("[data-measure]").forEach((x) => x.classList.toggle("on", x === b));
    renderCompare();
  }));
  const MEASURES = {
    perkm: {
      lede: "Seconds a typical trip loses per 100 m of route, beyond the clean run: the average height of the route's curtain on the map. Tap a route to see it.",
      value: (p, r) => (r.typical_s?.all != null && r.clean_s ? (r.typical_s.all - r.clean_s) / p.length * 100 : null),
      label: (v) => `${v.toFixed(1)} s / 100 m`,
      sub: (p, r) => `a typical trip loses ${Math.round((r.typical_s.all - r.clean_s) / 60)} min over ` +
        `${(p.length / 1000).toFixed(1)} km · takes ${r.ratio.toFixed(2)}× its clean-run total`,
    },
    total: {
      lede: "Streetcar hours a day spent beyond the clean run, from the trips actually run. Long, frequent routes count for more. Tap a route to see it.",
      value: (p, r) => r.hours_lost_per_day ?? null,
      label: (v) => `${Math.round(v)} h`,
      sub: (p, r) => `${Math.round(r.trips_per_day)} trips a day · a typical trip takes ${r.ratio.toFixed(2)}× its clean-run total`,
    },
    wait: {
      lede: "Excess wait: how much longer riders wait for a car than they would if cars came as scheduled, averaged over the route's stops (frequent service only, all day). Tap a route to see it.",
      value: (p) => routeWaits(p, ALL_KEYS)?.ewt ?? null,
      label: (v) => `${v.toFixed(1)} min`,
      sub: (p) => {
        const w = routeWaits(p, ALL_KEYS);
        return `${Math.round(w.bunched * 100)}% of cars bunched · ${Math.round(w.gaps * 100)}% after a big gap · ` +
          `${Math.round(Math.min(w.seen, 9.99) * 100)}% of scheduled cars seen`;
      },
      needsDelay: false,
    },
  };

  function renderCompare() {
    const stats = state.stats[state.window];
    const m = MEASURES[compareMeasure];
    document.getElementById("compare-lede").textContent = m.lede;
    const rows = net.patterns.map((p) => {
      const r = stats.routes[p.id] || {};
      return {p, r, v: r.ratio != null || m.needsDelay === false ? m.value(p, r) : null};
    }).filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    const max = Math.max(0.01, ...rows.map((x) => x.v));
    const box = document.getElementById("compare-rows");
    box.textContent = "";
    for (const {p, r, v} of rows) {
      const row = document.createElement("button");
      row.className = "compare-row";
      row.setAttribute("role", "listitem");
      row.title = `${p.route} ${p.name} ${p.direction.toLowerCase()}: ${m.label(v)}; ${m.sub(p, r)}. Tap to show on the map.`;
      row.innerHTML =
        `<span class="compare-name">${p.route} ${p.name}<span>${p.direction}</span></span>` +
        `<span class="compare-bar"><i style="width:${(v / max * 70).toFixed(1)}%"></i><b>${m.label(v)}</b></span>` +
        `<span class="compare-sub">${m.sub(p, r)}</span>`;
      row.addEventListener("click", () => {
        state.route = p.route;
        state.dir = /^(East|North)/.test(p.direction) ? "en" : "ws";
        syncControls();
        compareDlg.close();
        render();
        flyToRoute();
      });
      box.append(row);
    }
    const shown = new Set(rows.map((x) => x.p.route));
    const missing = [...new Set(net.patterns.filter((p) => !shown.has(p.route)).map((p) => `${p.route} ${p.name}`))];
    const days = meta.windows[state.window].days;
    document.getElementById("compare-note").textContent =
      (rows.length ? "" : compareMeasure === "wait" ? "No headway data yet: it starts with the first day a saved schedule covers. "
        : "Not enough finished days logged yet. ") +
      `${WINDOW_LABELS[state.window]}, finished days only` +
      (days < 14 ? ", preliminary: partly logged days count in proportion to the hours logged" : "") + "." +
      (missing.length ? ` No streetcar service measured on ${missing.join(", ")}.` : "");
  }

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
  // t is a preset (am, pm, ...) or h<start hour> for a 2-hour window; dy is the day type.
  const HASH_KEYS = {w: "window", dy: "days", r: "route", d: "dir", v: "view"};
  const DEFAULTS = {window: "recent", days: "all", route: "", dir: "both", view: "delay"};
  const ALLOWED = {window: Object.keys(WINDOW_LABELS), days: Object.keys(DAYS_LABELS), route: ["", ...Object.keys(routeNames)],
    dir: ["both", "en", "ws"], view: ["delay", "speed", "wait"]};
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    for (const [k, key] of Object.entries(HASH_KEYS)) {
      if (ALLOWED[key].includes(h.get(k))) state[key] = h.get(k);
    }
    const t = h.get("t") || "";
    if (t in PRESETS) state.time = t;
    const m = t.match(/^h(\d{1,2})-(\d{1,2})$/);
    if (m && +m[1] < +m[2] && +m[2] <= 24) setRange(+m[1], +m[2]);
    if (h.get("sig") === "0") state.signals = false;
    const c = (h.get("c") || "").split(",").map(Number);
    return c.length === 5 && c.every(Number.isFinite)
      ? {center: [c[0], c[1]], zoom: c[2], bearing: c[3], pitch: c[4]} : null;
  }
  function writeHash() {
    if (SHOT || !map) return;
    const h = new URLSearchParams();
    for (const [k, key] of Object.entries(HASH_KEYS)) if (state[key] !== DEFAULTS[key]) h.set(k, state[key]);
    if (state.time !== "all") h.set("t", state.time === "custom" ? `h${state.range[0]}-${state.range[1]}` : state.time);
    if (!state.signals) h.set("sig", "0");
    const c = map.getCenter();
    h.set("c", [c.lng.toFixed(4), c.lat.toFixed(4), map.getZoom().toFixed(2), map.getBearing().toFixed(0),
      map.getPitch().toFixed(0)].join(","));
    history.replaceState(null, "", `#${h}`);
  }
  // Put the controls in line with state (after reading a link).
  function syncControls() {
    for (const [attr, key] of [["window", "window"], ["dir", "dir"], ["view", "view"]]) {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.classList.toggle("on", b.dataset[attr] === state[key]));
    }
    syncTimeControls();
    routeSel.value = state.route;
    document.getElementById("show-signals").checked = state.signals;
  }
  const linkCamera = SHOT ? null : readHash();
  // A link pasted into an open tab only changes the hash; reload to apply it. (Our own
  // updates use replaceState, which doesn't fire this.)
  addEventListener("hashchange", () => location.reload());
  syncControls();
  await loadWindow(state.window);
  await loadHours(state.window);
  await loadHeads(state.window);
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
      return [{pos: [s.lonlat[0] + o[0], s.lonlat[1] + o[1]], name: s.name, id: s.id}];
    });
  }
  function updateOffset() {
    offsetM = state.dir === "both" ? OFFSET_PX * 40075016 * KX / (512 * 2 ** map.getZoom()) : 0;
  }
  // Re-render on zoom: the direction offset is in pixels and turn-ban icons appear close in.
  map.on("zoomend", () => { if (!SHOT) render(); });

  // Turn bans (City by-law), only when zoomed in close: one "no turn" sign per banned
  // approach, lying flat on the map and turned to that direction of travel, placed just
  // before the intersection on the right-hand side of the approaching traffic.
  const TURN_ZOOM = 15;
  // Ontario-style regulatory sign: white square, black border, black arrow for the banned
  // move, red circle and slash. Drawn pointing "up" = the direction of travel.
  // Each arrow: [shaft path, arrowhead triangle(s)].
  const TURN_ARROWS = {
    l: ["M18.5 25 V17.5 Q18.5 12.5 13.5 12.5 H11", "11.5,8 6.5,12.5 11.5,17"],
    r: ["M13.5 25 V17.5 Q13.5 12.5 18.5 12.5 H21", "20.5,8 25.5,12.5 20.5,17"],
    u: ["M20 25 V14 Q20 8.5 15 8.5 Q11 8.5 11 13 V17", "7,16 11,21.5 15,16"],
    lr: ["M16 25 V13.5 M10 13.5 H22", "10.5,9.5 6,13.5 10.5,17.5|21.5,9.5 26,13.5 21.5,17.5"],
    t: ["M16 25 V11", "11.5,12 16,6 20.5,12"],
  };
  const turnIcon = (kind) => ({
    id: `turn-${kind}`, width: 96, height: 96,
    url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 32 32'>" +
      "<rect x='1.5' y='1.5' width='29' height='29' rx='2.5' fill='white' stroke='#111' stroke-width='1.6'/>" +
      `<path d='${TURN_ARROWS[kind][0]}' fill='none' stroke='#111' stroke-width='3.2' stroke-linejoin='round'/>` +
      TURN_ARROWS[kind][1].split("|").map((pts) => `<polygon points='${pts}' fill='#111'/>`).join("") +
      "<circle cx='16' cy='16' r='11.5' fill='none' stroke='#d0282e' stroke-width='2.6'/>" +
      // As on Ontario signs: "no left" slashes bottom-left to top-right, "no right" mirrors it.
      (kind === "l" ? "<line x1='7.9' y1='24.1' x2='24.1' y2='7.9' stroke='#d0282e' stroke-width='2.6'/>"
        : "<line x1='7.9' y1='7.9' x2='24.1' y2='24.1' stroke='#d0282e' stroke-width='2.6'/>") + "</svg>"),
  });
  const TURN_ICONS = Object.fromEntries(Object.keys(TURN_ARROWS).map((k) => [k, turnIcon(k)]));
  const APPROACH = {Northbound: 0, Eastbound: 90, Southbound: 180, Westbound: 270}; // on the street grid
  const turnKind = (t) => {
    t = t.toLowerCase();
    if (t.includes("u-turn")) return "u";
    if (t.includes("left") && t.includes("right")) return "lr";
    if (t.includes("left")) return "l";
    if (t.includes("right")) return "r";
    return "t";
  };
  const UPSTREAM_M = 26, RIGHT_M = 10, STACK_M = 11;

  // Direction of travel (on the street grid) of a piece of track at a slice.
  function approachAt(p, b) {
    const a = p.bins[Math.max(0, b - 1)], z = p.bins[Math.min(p.bins.length - 1, b + 1)];
    const heading = (Math.atan2((z[0] - a[0]) * KX, z[1] - a[1]) * 180 / Math.PI + 360) % 360;
    const rel = ((heading - GRID) % 360 + 360) % 360;
    return ["Northbound", "Eastbound", "Southbound", "Westbound"][Math.round(rel / 90) % 4];
  }

  // When a ban applies, read from the by-law wording ("7:00 a.m. to 9:00 a.m. and 4:00 p.m.
  // to 6:00 p.m., Mon. to Fri."): days (weekdays / Sat / Sun) and hour ranges. Anything
  // unreadable counts as always, so a ban is never hidden by a parsing miss.
  const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|noon|midnight)`;
  function hourOf(h, m, ap) {
    ap = ap.toLowerCase();
    if (ap.startsWith("noon")) return 12;
    if (ap.startsWith("midnight")) return 24;
    let x = +h % 12 + (+m || 0) / 60;
    if (ap.startsWith("p")) x += 12;
    return x;
  }
  function parseWhen(text) {
    // Exemptions live in parentheses ("Taxicabs excepted from 10:00 p.m. to 5:00 a.m."),
    // and their times aren't when the ban applies.
    const main = text.replace(/\([^)]*\)/g, " ");
    const lower = main.toLowerCase().replace(/monday/g, "mon").replace(/friday/g, "fri")
      .replace(/saturday/g, "sat").replace(/sunday/g, "sun");
    // Temporary bans whose dates are all in past years have ended.
    const years = [...main.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => +m[0]);
    if (years.length && Math.max(...years) < new Date().getFullYear()) return {expired: true};
    const hours = [];
    if (!/^\s*anytime/.test(lower)) {
      // "and" between two times is a by-law typo for "to" in at least one entry.
      for (const m of main.matchAll(new RegExp(`${CLOCK}\\s*(?:to|and)\\s*${CLOCK}`, "gi"))) {
        const s = hourOf(m[1], m[2], m[3]), e = hourOf(m[4], m[5], m[6]);
        if (e > s) hours.push([s, e]);
        else hours.push([s, 24], [0, e]); // runs past midnight
      }
    }
    // Days: the union of those mentioned ("Mon. to Fri. and ... Sat." covers both).
    const days = new Set();
    if (/mon\.? to (fri|sat|sun)/.test(lower)) days.add("wd"); // day names were shortened above
    if (/mon\.? to (sat|sun)/.test(lower) || /\bsat(urday)?s?\.?\b/.test(lower.replace(/mon\.? to sat\w*\.?/, ""))) days.add("sat");
    if (/mon\.? to sun/.test(lower) || (/\bsun(day)?s?\.?\b/.test(lower) && !/except[^,]*sun/.test(lower))) days.add("sun");
    if (/except[^,]*sun/.test(lower) && !days.size) { days.add("wd"); days.add("sat"); }
    return {hours: hours.length ? hours : null, days: days.size && days.size < 3 ? days : null};
  }
  const banExpired = (t) => !!(t.parsed ||= parseWhen(t.when)).expired;
  function banActive(t) {
    if (banExpired(t)) return false;
    if (!usesHours()) return true; // all day, all days: every ban applies at some point
    const w = t.parsed;
    if (w.days && state.days === "wd" && !w.days.has("wd")) return false;
    if (w.days && state.days === "we" && !w.days.has("sat") && !w.days.has("sun")) return false;
    if (!w.hours) return true;
    const [a, b] = hourRange();
    return w.hours.some(([s, e]) => s < b && e > a);
  }

  // Signs for the approaches the displayed streetcars travel (sigDirs: signal -> directions),
  // for bans in effect at the selected time.
  function turnSigns(sigDirs) {
    const out = [];
    for (const [i, dirsShown] of sigDirs) {
      const s = net.signals[i];
      const per = {}; // approach -> kinds
      for (const t of s.turns || []) {
        if (!banActive(t)) continue;
        const dirs = /all directions/i.test(t.dir) ? Object.keys(APPROACH) : Object.keys(APPROACH).filter((d) => t.dir.includes(d));
        for (const d of dirs) if (dirsShown.has(d)) (per[d] ||= new Set()).add(turnKind(t.turn));
      }
      for (const [d, kinds] of Object.entries(per)) {
        // No left and no right on one approach: a single "no turns" sign.
        if (kinds.has("l") && kinds.has("r")) { kinds.delete("l"); kinds.delete("r"); kinds.add("lr"); }
        const heading = (APPROACH[d] + GRID + 360) % 360; // compass bearing of travel
        const fx = Math.sin(heading * Math.PI / 180), fy = Math.cos(heading * Math.PI / 180);
        [...kinds].forEach((kind, j) => {
          const back = UPSTREAM_M + j * STACK_M; // a second ban on the same approach sits further back
          const ex = -fx * back + fy * RIGHT_M, ny = -fy * back - fx * RIGHT_M; // right-hand normal is (fy, -fx)
          out.push({signal: s, kind, angle: -heading,
            pos: [s.lonlat[0] + ex / (111320 * KX), s.lonlat[1] + ny / 110540]});
        });
      }
    }
    return out;
  }
  function turnLayer(sigDirs) {
    const show = state.signals && map.getZoom() >= TURN_ZOOM;
    return new IconLayer({id: "turn-bans", visible: show,
      data: show ? turnSigns(sigDirs) : [],
      getPosition: (x) => x.pos, getIcon: (x) => TURN_ICONS[x.kind], getAngle: (x) => x.angle,
      // Sized in metres so signs grow as you zoom in, within readable limits.
      billboard: false, getSize: 9, sizeUnits: "meters", sizeMinPixels: 16, sizeMaxPixels: 64,
      pickable: true, onHover: showSignalTip, onClick: showSignalTip});
  }

  function visiblePieces() {
    return pieces.filter((p) => (!state.route || p.routes.includes(state.route)) &&
      (state.dir === "both" || (state.dir === "en") === p.en));
  }

  // With a route picked, only the slices its own patterns run over (pieces are shared).
  function onRoute(p, b) {
    if (!state.route) return true;
    return (sliceRoutes.get(`${p.index}:${b}`) || []).some((id) => patterns[id].route === state.route);
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
    const segs = [], base = [], stops = [], sigShown = new Set(), sigDirs = new Map();
    for (const p of visiblePieces()) {
      const st = stats.pieces[p.id];
      for (const path of runsOf(p)) base.push({path});
      p.sig.forEach((i, b) => {
        if (i < 0 || !onRoute(p, b)) return;
        sigShown.add(i);
        if (net.signals[i].turns) (sigDirs.get(i) || sigDirs.set(i, new Set()).get(i)).add(approachAt(p, b));
      });
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
      turnLayer(sigDirs),
    ]});
    renderRouteCard();
  }

  // Waits view: a column at each stop, as tall and as hot as its excess wait.
  const MAX_WAIT = 12; // minutes; taller columns are capped (the tooltip shows the real value)
  const waitHeight = (v) => Math.sqrt(Math.max(0, Math.min(v, MAX_WAIT))) * state.height * 14;
  function renderWait() {
    const base = [], cols = [], seen = new Set();
    const heads = state.heads[state.window];
    const keys = hourKeys();
    for (const p of visiblePieces()) {
      for (const path of runsOf(p)) base.push({path});
      if (!heads) continue;
      for (const s of stopsOf(p)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const routes = Object.keys(heads.stops[s.id] || {}).filter((r) => !state.route || r === state.route).sort();
        const per = routes.map((r) => [r, stopWaits(s.id, r, keys)]).filter(([, w]) => w);
        if (!per.length) continue;
        // Several routes at one stop: their excess waits averaged by number of headways.
        const n = per.reduce((t, [, w]) => t + w.n, 0);
        const ewt = per.reduce((t, [, w]) => t + w.ewt * w.n, 0) / n;
        cols.push({pos: s.pos, name: s.name, id: s.id, per, ewt, n,
          color: colorFor(Math.max(0, ewt), confidence(n / 2), pal.wait)});
      }
    }
    // Thin columns that stay a few pixels wide at any zoom.
    const mpp = 40075016 * KX / (512 * 2 ** map.getZoom());
    drawn = cols.flatMap((c) => [c.pos[0], c.pos[1], 0, c.pos[0], c.pos[1], waitHeight(c.ewt)]);
    screenPts = null;
    overlay.setProps({layers: [
      new PathLayer({id: "base", data: base, getPath: (x) => x.path, getColor: pal.faint, widthUnits: "pixels", getWidth: 2}),
      new ColumnLayer({id: "waits", data: cols, getPosition: (x) => x.pos, getElevation: (x) => waitHeight(x.ewt),
        radius: Math.max(8, 2.2 * mpp), diskResolution: 10, extruded: true, getFillColor: (x) => x.color,
        material: false, pickable: true, autoHighlight: true, highlightColor: [0, 0, 0, 255],
        onHover: showWaitTip, onClick: showWaitTip,
        updateTriggers: {getElevation: [state.height, state.window, timeLabel()], getFillColor: [state.window, timeLabel()]}}),
    ]});
    renderRouteCard();
    document.getElementById("wait-empty").hidden = (meta.windows[state.window].headway_days || 0) > 0;
  }

  function render() {
    updateViewChrome();
    updateOffset();
    writeHash();
    document.getElementById("loading").hidden = true;
    if (state.view === "speed") return renderSpeed();
    if (state.view === "wait") return renderWait();
    const stats = state.stats[state.window];
    const ridge = [], verticals = [], base = [], stops = [];
    const lostByKind = [0, 0, 0, 0];
    const approaches = new Map();
    const sigShown = new Set(), sigDirs = new Map(); // signal -> directions streetcars approach it from
    for (const p of visiblePieces()) {
      const st = stats.pieces[p.id];
      for (const path of runsOf(p)) base.push({path});
      p.sig.forEach((i, b) => {
        if (i < 0 || !onRoute(p, b)) return;
        sigShown.add(i);
        if (net.signals[i].turns) (sigDirs.get(i) || sigDirs.set(i, new Set()).get(i)).add(approachAt(p, b));
      });
      stops.push(...stopsOf(p));
      if (!st) continue;
      const slot = viewOf(p, st);
      const d = smoothed(slot.d);
      for (let b = 0; b < p.bins.length; b++) {
        if (d[b] == null || !onRoute(p, b)) continue;
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
        const h = peakHeight(d[b]);
        verticals.push({from: [...pos(p, b), 0], to: [...pos(p, b), h]});
        if (b + 1 < p.bins.length && d[b + 1] != null && onRoute(p, b + 1)) {
          const h2 = peakHeight(d[b + 1]);
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
        turnLayer(sigDirs),
        new LineLayer({id: "ridge", data: ridge, getSourcePosition: (x) => x.from, getTargetPosition: (x) => x.to,
          getColor: (x) => x.color, getWidth: 3.5, pickable: true, autoHighlight: true, highlightColor: [0, 0, 0, 255],
          onHover: showTooltip, onClick: showTooltip,
          updateTriggers: {getColor: [state.window, timeLabel()]}}),
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
    const typ = typicalFor(pat, r);
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

  const minTxt = (m) => `${Math.abs(m) < 0.05 ? "0" : m.toFixed(1)} min`;
  function waitLines(w) {
    const parts = [];
    if (w.uneven >= 0.1) parts.push(`uneven spacing adds ${minTxt(w.uneven)}`);
    if (w.missing >= 0.1) parts.push(`missing cars add ${minTxt(w.missing)}`);
    return `<div>Riders turning up at random waited <b>${minTxt(w.awt)}</b> on average, ` +
      `vs ${minTxt(w.swt)} if cars had come as scheduled (about every ${Math.round(w.schedH)} min)` +
      (parts.length ? `: ${parts.join(", ")}` : "") + `</div>` +
      `<div class="t-dim">${Math.round(w.bunched * 100)}% of cars came bunched (under half the scheduled gap behind the one ahead) · ` +
      `${Math.round(w.gaps * 100)}% after a big gap (over 1.5×) · ${Math.round(Math.min(w.seen, 9.99) * 100)}% of scheduled cars seen<br>` +
      `Headway regularity (TCQSM): ${w.los[1]}, ${w.los[2]} · ${fmt(w.n)} headways</div>`;
  }
  function showWaitTip(info) {
    if (!info.object) { tip.hidden = true; return; }
    const c = info.object;
    const off = state.heads[state.window]?.off[c.id] || {};
    const offTxt = Object.entries(off).filter(([r]) => !state.route || r === state.route)
      .map(([r, d]) => `${r}: not served on ${d} day${d === 1 ? "" : "s"} (diverted or off the track), left out`);
    const ewtTxt = (v) => (v < -0.05 ? `${minTxt(-v)} shorter than scheduled` : `+${minTxt(v)} excess wait`);
    tip.innerHTML =
      `<div class="t-title">${c.name}</div>` +
      `<div class="t-dim">${c.per.map(([r]) => r).join(", ")} · ${timeLabel()}</div>` +
      (c.per.length === 1 ? `<div class="t-big">${ewtTxt(c.per[0][1].ewt)}</div>${waitLines(c.per[0][1])}`
        : `<div class="t-big">${ewtTxt(c.ewt)} (routes averaged)</div>` + c.per.map(([r, w]) =>
          `<div class="t-routes"><div class="t-head">${r} ${routeNames[r] || ""}: ${ewtTxt(w.ewt)}</div>${waitLines(w)}</div>`).join("")) +
      (offTxt.length ? `<div class="t-routes t-dim">${offTxt.join("<br>")}</div>` : "") +
      `<div class="t-routes t-dim">Frequent service only (scheduled every 12 min or better). Buses on the route count. More under “?”.</div>`;
    placeTip(info);
  }

  function showSignalTip(info) {
    if (!info.object) { tip.hidden = true; return; }
    const s = info.object.signal || info.object; // a turn sign carries its signal
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const bans = (s.turns || []).filter((t) => !banExpired(t)).map((t) => `<div>${esc(t.dir)} ${esc(t.turn.toLowerCase())}` +
      `${/turn/i.test(t.turn) ? "" : " turn"}: <span class="t-dim">${esc(t.when)}</span></div>`).join("");
    tip.innerHTML = `<div class="t-title">${s.midblock ? "Pedestrian signal" : "Traffic signal"}: ${esc(s.name)}</div>` +
      `<div class="t-dim">${s.tsp ? "Has transit signal priority (can extend a green or shorten a red for a streetcar)."
        : "No transit signal priority."}</div>` +
      (bans ? `<div class="t-routes"><div class="t-head">Turns banned (City by-law)</div>${bans}</div>` : "");
    placeTip(info);
  }

  function showTooltip(info) {
    if (!info.object) { tip.hidden = true; return; }
    const {piece: p, bin: b} = info.object;
    const st = state.stats[state.window].pieces[p.id];
    const slot = viewOf(p, st);
    const stop = nearestStop(p, b);
    // Same ~125 m weighted average the ridge is drawn with.
    const rate = smoothAt(slot.d, b);
    const span = [-2, -1, 0, 1, 2].filter((o) => slot.d[b + o] != null).length * net.bin_m;
    const lostHere = rate * span / 100;
    const cleanHere = smoothAt(st.clean.map((c, i) => (slot.d[i] == null ? null : c)), b) * span / net.bin_m;
    const typical = cleanHere + lostHere;
    const routes = (sliceRoutes.get(`${p.index}:${b}`) || []).filter((id) => !state.route || patterns[id].route === state.route);
    tip.innerHTML =
      `<div class="t-title">${stop ? `Near ${stop}` : "Streetcar track"}</div>` +
      `<div class="t-dim">${p.routes.join(", ")} · ${timeLabel()}</div>` +
      `<div class="t-kind">${kindText(p, b)}</div>` +
      `<div class="t-big">${rate.toFixed(1)} s lost per 100 m</div>` +
      `<div>The ${span} m around here cost a typical car <b>${lostHere < 1 ? "under 1 s" : `${Math.round(lostHere)} s`}</b></div>` +
      `<div class="t-dim">${cleanHere.toFixed(1)} s clean run vs ${typical.toFixed(1)} s typical<br>` +
      `Based on ${fmt(slot.n[b])} pass${slot.n[b] === 1 ? "" : "es"}</div>` +
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
      const typ = typicalFor(pat, r);
      let movedTxt = "";
      if (r.moved) {
        const m = r.moved.change_s / 60;
        movedTxt = ` · clean-run total ${Math.abs(m) < 0.05 ? "unchanged" : `moved ${m > 0 ? "+" : "−"}${Math.abs(m).toFixed(1)} min`} since ${dayFmt(r.moved.since)}`;
      }
      const w = state.heads[state.window] ? routeWaits(pat) : null;
      const waitTxt = w ? `<br>Riders wait <b>${w.ewt < 0 ? `${minTxt(-w.ewt)} less` : `${minTxt(w.ewt)} longer`}</b> than scheduled ` +
        `on average (<button class="linkish" data-explain="waits">excess wait</button>) · ${Math.round(w.bunched * 100)}% of cars bunched` : "";
      html += `<div class="dir"><div class="dir-name">${pat.direction} to ${pat.to}</div>` +
        `<div class="dir-stats">` +
        (r.clean_s && typ != null ? `A typical trip loses <b>${mins(typ - r.clean_s)}</b> to delays` +
          `<br>${mins(typ)} typical vs ${mins(r.clean_s)} ` +
          `<button class="linkish" data-explain>clean-run total</button> · scheduled ${mins(pat.sched_s)}` +
          `<br>${fmt(r.samples)} slice passes · ${Math.round(r.data_coverage * 100)}% of the route measured${movedTxt}`
          : r.clean_s ? `Not enough data yet for ${timeLabel().toLowerCase()}` : "No streetcar data yet for this direction") +
        waitTxt + `</div></div>`;
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
