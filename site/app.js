/* Toronto streetcar delay map: a 3D delay "curtain" over each piece of track. */
(async function () {
  const {MapboxOverlay, LineLayer, PathLayer, ScatterplotLayer} = deck;

  const COLOR_STOPS = [[0, [140, 197, 173]], [5, [243, 211, 107]], [15, [240, 139, 58]], [35, [198, 47, 47]], [70, [92, 10, 30]]];
  const BASE_COLOR = [140, 197, 173, 200];
  const MAX_SHOWN = 100; // s per 100 m; taller peaks are capped (the tooltip shows the real value)
  const STATUS_TEXT = {
    normal: "Streetcars", diverted: "Streetcars, often off the usual track", mixed: "Some buses",
    bus: "Mostly buses", none: "No vehicles seen", nodata: "Not logged",
  };

  const state = {window: "recent", slot: "all", route: "", dir: "both", show: "all", signals: true, height: 12, stats: {}};
  // Slice labels from build_site: 0 elsewhere, 1 stop, 2 signal, 3 stop + signal.
  const KINDS = [
    {name: "Elsewhere", color: "#9fb8ad"}, {name: "Stop only", color: "#f3c95b"},
    {name: "Signal only", color: "#c62f2f"}, {name: "Stop + signal", color: "#f08b3a"},
  ];
  const BREAKDOWN_ORDER = [2, 3, 1, 0];

  const get = (f) => fetch(`data/${f}`, {cache: "no-cache"}).then((r) => r.json());
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
    if (e.target.closest("[data-explain]")) explain.showModal();
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

  // --- map ------------------------------------------------------------------------
  const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/positron",
    ...(innerWidth > 700 ? {center: [-79.395, 43.662], zoom: 12.5} : {center: [-79.405, 43.652], zoom: 11.3}),
    pitch: 58, bearing: -17, maxPitch: 75,
    attributionControl: {compact: true, customAttribution: "Data: TTC GTFS-Realtime via City of Toronto Open Data"},
  });
  map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), "top-right");
  if (innerWidth > 700) map.setPadding({left: 360, top: 0, right: 0, bottom: 0});
  const overlay = new MapboxOverlay({interleaved: false, layers: [], pickingRadius: 10});
  map.addControl(overlay);

  function colorFor(v, alpha) {
    if (v >= COLOR_STOPS[COLOR_STOPS.length - 1][0]) return [...COLOR_STOPS[COLOR_STOPS.length - 1][1], alpha];
    for (let i = 1; i < COLOR_STOPS.length; i++) {
      const [v1, c1] = COLOR_STOPS[i];
      if (v <= v1) {
        const [v0, c0] = COLOR_STOPS[i - 1];
        const t = (v - v0) / (v1 - v0);
        return [0, 1, 2].map((k) => Math.round(c0[k] + t * (c1[k] - c0[k]))).concat(alpha);
      }
    }
  }
  const confidence = (n) => (n >= 30 ? 255 : n >= 10 ? 170 : 90);

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
      if (onRoute(p, b)) (cur ||= []).push(p.bins[b]);
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

  function render() {
    const stats = state.stats[state.window];
    const ridge = [], verticals = [], base = [], stops = [];
    const lostByKind = [0, 0, 0, 0];
    const sigShown = new Set();
    for (const p of visiblePieces()) {
      const st = stats.pieces[p.id];
      for (const path of runsOf(p)) base.push({path});
      p.sig.forEach((i, b) => { if (i >= 0 && onRoute(p, b)) sigShown.add(i); });
      for (const s of p.stops) if (onRoute(p, Math.floor(s.along / net.bin_m))) stops.push({pos: s.lonlat, name: s.name});
      if (!st) continue;
      const slot = st.slots[state.slot];
      const d = smoothed(slot.d);
      for (let b = 0; b < p.bins.length; b++) {
        if (d[b] == null || !binVisible(p, b)) continue;
        if (slot.d[b] != null) lostByKind[p.tags[b]] += slot.d[b] * net.bin_m / 100;
        const h = Math.min(d[b], MAX_SHOWN) * state.height;
        verticals.push({from: [...p.bins[b], 0], to: [...p.bins[b], h]});
        if (b + 1 < p.bins.length && d[b + 1] != null && binVisible(p, b + 1)) {
          const h2 = Math.min(d[b + 1], MAX_SHOWN) * state.height;
          const n = Math.min(slot.n[b], slot.n[b + 1]);
          ridge.push({
            from: [...p.bins[b], h], to: [...p.bins[b + 1], h2],
            color: colorFor((d[b] + d[b + 1]) / 2, confidence(n)), piece: p, bin: b, value: d[b],
          });
        }
      }
    }
    overlay.setProps({
      layers: [
        new PathLayer({id: "base", data: base, getPath: (x) => x.path, getColor: BASE_COLOR, widthUnits: "pixels", getWidth: 2.5}),
        new LineLayer({id: "verticals", data: verticals, getSourcePosition: (x) => x.from, getTargetPosition: (x) => x.to,
          getColor: [110, 110, 110, 70], getWidth: 1}),
        new ScatterplotLayer({id: "stops", data: stops, getPosition: (x) => x.pos, getRadius: 2.6, radiusUnits: "pixels",
          getFillColor: [35, 35, 35, 220]}),
        new ScatterplotLayer({id: "signals", visible: state.signals, data: [...sigShown].map((i) => net.signals[i]),
          getPosition: (s) => s.lonlat, getRadius: 4.5, radiusUnits: "pixels", stroked: true,
          lineWidthUnits: "pixels", getLineWidth: 1.5, getLineColor: [138, 28, 43, 255],
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
      `a typical trip loses <b>${mins(typ - r.clean_s)}</b> in total across all its stretches ` +
      `(${mins(typ)} vs ${mins(r.clean_s)} best case · scheduled ${mins(pat.sched_s)})</div>`;
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

  function placeTip(info) {
    tip.hidden = false;
    // Measure at the left edge, so the old position can't squeeze the width.
    tip.style.left = "0px";
    tip.style.top = "0px";
    tip.style.left = `${Math.min(info.x + 14, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.min(info.y + 14, innerHeight - tip.offsetHeight - 8)}px`;
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
      `<div class="t-dim">${cleanHere.toFixed(1)} s on a good run vs ${typical.toFixed(1)} s typical<br>` +
      `${fmt(slot.n[b])} passes · streetcars passed here on ${st.days[b]} of ${days} day${days === 1 ? "" : "s"}</div>` +
      (routes.length ? `<div class="t-routes"><div class="t-head">Whole route${routes.length > 1 ? "s" : ""} through here</div>` +
        `${routes.map(routeLine).join("")}</div>` : "") +
      `<div class="t-routes t-dim">Clean run: each stretch's fastest 10% of real daytime passes, stops included. More under “?” on the legend.</div>`;
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
        movedTxt = ` · best case ${Math.abs(m) < 0.05 ? "unchanged" : `moved ${m > 0 ? "+" : "−"}${Math.abs(m).toFixed(1)} min`} since ${dayFmt(r.moved.since)}`;
      }
      html += `<div class="dir"><div class="dir-name">${pat.direction} to ${pat.to}</div>` +
        `<div class="dir-stats">` +
        (r.clean_s && typ != null ? `A typical trip loses <b>${mins(typ - r.clean_s)}</b> to delays` +
          `<br>${mins(typ)} typical vs ${mins(r.clean_s)} if every stretch went well ` +
          `(<button class="linkish" data-explain>clean run</button>) · scheduled ${mins(pat.sched_s)}` +
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

  render();
})();
