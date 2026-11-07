// Trends page: daily series per route from data/trends.json (see pipeline/trends.py).
(async function () {
  const $ = (id) => document.getElementById(id);

  // Same theme choice as the map (saved by the map's theme buttons).
  try {
    const t = localStorage.getItem("ttc-delays-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: follow the system */ }
  const isDark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);

  const ROUTES = {
    "501": ["Queen", "#d33f3f", "#ff6b6b"], "503": ["Kingston Rd", "#8c5a3c", "#d1a27f"],
    "504": ["King", "#b58500", "#ffd24a"], "505": ["Dundas", "#2e9e4f", "#5fd68a"],
    "506": ["Carlton", "#138a96", "#4fd1db"], "507": ["Long Branch", "#2f6fd1", "#7fb0ff"],
    "508": ["Lake Shore", "#7a52c7", "#b49cff"], "509": ["Harbourfront", "#e0731b", "#ffa45c"],
    "510": ["Spadina", "#c2408f", "#ff8ad0"], "511": ["Bathurst", "#6f8f00", "#c6e86a"],
    "512": ["St Clair", "#4a7fb0", "#9fd3ff"],
  };
  const colorOf = (r) => (ROUTES[r] ? ROUTES[r][isDark() ? 2 : 1] : "#888");
  const nameOf = (r) => (ROUTES[r] ? `${r} ${ROUTES[r][0]}` : r);

  let T;
  try {
    T = await (await fetch("data/trends.json", {cache: "no-cache"})).json();
  } catch (e) {
    $("charts").innerHTML = "<p class='field-note'>No trend data yet: it's built each night.</p>";
    return;
  }
  const allRoutes = Object.keys(T.routes).filter((r) => ROUTES[r]).sort();

  // --- state (kept in the link) --------------------------------------------------------
  const state = {routes: new Set(), period: 90, days: "all", band: "all", shade: false, sig: "sig", sigSplit: "both"};
  const h = new URLSearchParams(location.hash.slice(1));
  for (const r of (h.get("r") || "").split(",")) if (allRoutes.includes(r)) state.routes.add(r);
  if (["30", "90"].includes(h.get("p"))) state.period = +h.get("p");
  if (["wd", "we"].includes(h.get("d"))) state.days = h.get("d");
  if (["am", "pm"].includes(h.get("b"))) state.band = h.get("b");
  if (h.get("s") === "held") state.sig = "held";
  if (["tsp", "notsp"].includes(h.get("ss"))) state.sigSplit = h.get("ss");
  function writeHash() {
    const q = new URLSearchParams();
    if (state.routes.size) q.set("r", [...state.routes].sort().join(","));
    if (state.period !== 90) q.set("p", state.period);
    if (state.days !== "all") q.set("d", state.days);
    if (state.band !== "all") q.set("b", state.band);
    if (state.sig !== "sig") q.set("s", state.sig);
    if (state.sigSplit !== "both") q.set("ss", state.sigSplit);
    history.replaceState(null, "", q.toString() ? "#" + q : location.pathname);
  }
  const shown = () => (state.routes.size ? allRoutes.filter((r) => state.routes.has(r)) : allRoutes);

  // --- days on the x axis ----------------------------------------------------------------
  const dayDate = (d) => new Date(d + "T12:00:00");
  const isWeekend = (d) => [0, 6].includes(dayDate(d).getDay());
  function xDays() {
    const idx = T.days.map((d, i) => i).slice(-state.period);
    return idx.filter((i) => state.days === "all" || (state.days === "we") === isWeekend(T.days[i]));
  }
  const fmtDay = (d, long) => dayDate(d).toLocaleDateString("en-CA", long ? {weekday: "short", month: "short", day: "numeric"} : {month: "short", day: "numeric"});

  // --- chart definitions -------------------------------------------------------------------
  const pct = (v) => `${(v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 1 : 0)}%`;
  const min1 = (v) => `${v.toFixed(1)} min`;
  const CHARTS = [
    {id: "delay", title: "Time lost to delays", unit: "min",
      sub: "Minutes a typical end-to-end trip loses beyond the clean run (both directions averaged).",
      fmt: min1, series: (r) => [{vals: T.routes[r].delay?.[state.band]}]},
    {id: "sig", title: "Signals", opts: true,
      sub: () => (state.sig === "sig"
        ? "Seconds a streetcar loses per signal it approaches, beyond a clean approach."
        : "Share of streetcars held 90 s or more at a signal (about one signal cycle).") +
        " Approaches with a stop in them are left out (boarding would count as holding)." +
        " Priority and other signals are different intersections: compare each line with itself over time.",
      fmt: (v) => (state.sig === "sig" ? `${v.toFixed(1)} s` : pct(v)),
      series: (r) => {
        const m = T.routes[r][state.sig] || {};
        const out = [];
        if (state.sigSplit !== "notsp") out.push({vals: m[`tsp-${state.band}`], label: "priority"});
        if (state.sigSplit !== "tsp") out.push({vals: m[`notsp-${state.band}`], label: "other", dashed: state.sigSplit === "both"});
        return out;
      }},
    {id: "ewt", title: "Extra wait at stops", fmt: min1,
      sub: "How much longer riders wait than if cars came as scheduled (frequent service, all the route's stops).",
      series: (r) => [{vals: T.routes[r].ewt?.[state.band]}]},
    {id: "short", title: "Short turns", fmt: pct, allDay: true,
      sub: "Share of trips sent back before the end of the line. All day only.",
      series: (r) => [{vals: T.routes[r].short?.all}]},
    {id: "fleet", title: "Streetcars in service", fmt: pct, ref: 1,
      sub: "Streetcar hours run as a share of those scheduled; 100% is as scheduled.",
      series: (r) => [{vals: T.routes[r].fleet?.[state.band]}]},
  ];

  // --- drawing ---------------------------------------------------------------------------
  // Drawn at the page's real width (not scaled), so labels stay readable on phones.
  let W = 900;
  const H = 190, ML = 44, MR = 14, MT = 12, MB = 24;
  const niceStep = (v) => {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  };
  const rolling = (vals, k = 7) => vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - k + 1), i + 1).filter((v) => v != null);
    return w.length >= Math.min(4, k) ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
  // Weather words: rain in mm, snow as an estimated depth in cm (pipeline/weather.py); never
  // the station's liquid-equivalent figure, which needs too much explaining.
  const wxKind = (w) => w.kind ?? (w.p ? (w.tmax != null && w.tmax <= 1 ? "snow" : "rain") : null);
  const wxText = (w) => {
    const k = wxKind(w);
    return k === "snow" ? `≈ ${w.snow_cm ?? w.p} cm snow (estimated)` : k === "rain" ? `${w.rain_mm ?? w.p} mm rain`
      : k === "mixed" ? `${w.rain_mm ?? w.p} mm rain, possibly with some snow` : "dry";
  };
  const wetOrCold = (d) => {
    const w = T.weather?.[d];
    return w && ((w.rain_mm ?? w.p ?? 0) >= 5 || (w.snow_cm ?? 0) >= 2 || (w.tmin != null && w.tmin <= -15));
  };

  function xScale(n) {
    return (i) => (n <= 1 ? (ML + W - MR) / 2 : ML + i * (W - ML - MR) / (n - 1));
  }

  function chartSvg(def, xi) {
    const n = xi.length, X = xScale(n);
    const lines = [];
    let lo = Infinity, hi = -Infinity;
    for (const r of shown()) {
      for (const s of def.series(r)) {
        if (!s.vals) continue;
        const vals = xi.map((i) => s.vals[i] ?? null);
        if (!vals.some((v) => v != null)) continue;
        for (const v of vals) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        lines.push({r, vals, dashed: s.dashed, label: s.label});
      }
    }
    const shade = state.shade ? xi.map((i, k) => (wetOrCold(T.days[i]) ? k : -1)).filter((k) => k >= 0) : [];
    if (!lines.length) {
      return {svg: `<svg viewBox="0 0 ${W} 60"><text class="empty" x="${ML}" y="34">` +
        `${def.allDay && state.band !== "all" ? "All day only: switch time of day to All day." : "No data for this selection yet."}</text></svg>`, lines};
    }
    // Round tick steps (1, 2, 5 x a power of ten); fleet charts sit around 100%.
    let y0 = def.ref ? Math.min(0.9, lo) : Math.min(0, lo), y1 = def.ref ? Math.max(1.1, hi) : Math.max(hi, 1e-9);
    const tick = niceStep((y1 - y0) / 4);
    y0 = Math.floor(y0 / tick) * tick;
    y1 = Math.ceil(y1 / tick) * tick;
    const Y = (v) => MT + (1 - (v - y0) / (y1 - y0)) * (H - MT - MB);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${def.title}">`;
    // Weather shading, then gridlines and axis labels.
    const bw = n > 1 ? (W - ML - MR) / (n - 1) : 20;
    svg += shade.map((k) => `<rect class="wx-shade" x="${(X(k) - bw / 2).toFixed(1)}" y="${MT}" width="${bw.toFixed(1)}" height="${H - MT - MB}"/>`).join("");
    svg += `<g class="grid">`;
    for (let v = y0; v <= y1 + tick / 2; v += tick) {
      const y = Y(v);
      svg += `<line x1="${ML}" x2="${W - MR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>` +
        `<text x="${ML - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${def.fmt(v).replace(/ (min|s)$/, "")}</text>`;
    }
    svg += `</g>`;
    if (def.ref) svg += `<line x1="${ML}" x2="${W - MR}" y1="${Y(def.ref)}" y2="${Y(def.ref)}" stroke="var(--muted)" stroke-dasharray="4 3"/>`;
    // Date labels, spaced to fit.
    const step = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 120))));
    for (let k = 0; k < n; k += step) {
      svg += `<text x="${X(k).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtDay(T.days[xi[k]])}</text>`;
    }
    // New TTC schedules.
    for (const sd of T.schedules || []) {
      const k = xi.findIndex((i) => T.days[i] === sd);
      if (k >= 0) {
        svg += `<g class="sched"><line x1="${X(k)}" x2="${X(k)}" y1="${MT}" y2="${H - MB}"/>` +
          `<text x="${X(k) + 4}" y="${MT + 10}">new schedule</text></g>`;
      }
    }
    // Series: daily dots, joined; with plenty of days, a 7-day average on top.
    const smooth = n >= 10;
    for (const ln of lines) {
      const c = colorOf(ln.r);
      const pts = ln.vals.map((v, k) => (v == null ? null : [X(k), Y(v)]));
      const path = (ps) => ps.reduce((d, p, k) => d + (p ? `${!ps[k - 1] ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : ""), "");
      const dash = ln.dashed ? ` stroke-dasharray="5 4"` : "";
      if (smooth) {
        svg += `<path d="${path(pts)}" fill="none" stroke="${c}" stroke-width="1" opacity="0.35"${dash}/>`;
        const avg = rolling(ln.vals).map((v, k) => (v == null ? null : [X(k), Y(v)]));
        svg += `<path d="${path(avg)}" fill="none" stroke="${c}" stroke-width="2.4"${dash}/>`;
      } else {
        svg += `<path d="${path(pts)}" fill="none" stroke="${c}" stroke-width="1.8"${dash}/>`;
      }
      svg += pts.map((p) => (p ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${smooth ? 1.8 : 2.8}" fill="${c}"${smooth ? ` opacity="0.6"` : ""}/>` : "")).join("");
    }
    svg += `<line class="cross" x1="0" x2="0" y1="${MT}" y2="${H - MB}" visibility="hidden"/>`;
    return {svg: svg + `</svg>`, lines};
  }

  function weatherSvg(xi) {
    const n = xi.length, X = xScale(n), WH = 46;
    if (!T.weather || !xi.some((i) => T.weather[T.days[i]])) return "";
    const maxP = Math.max(10, ...xi.map((i) => T.weather[T.days[i]]?.p || 0));
    const bw = Math.max(3, Math.min(14, (W - ML - MR) / Math.max(1, n) * 0.6));
    let svg = `<svg viewBox="0 0 ${W} ${WH}" role="img" aria-label="Daily weather">`;
    xi.forEach((i, k) => {
      const w = T.weather[T.days[i]];
      if (!w) return;
      if (w.p > 0) {
        // Heights follow the amount of water, so a big snowfall and a downpour look alike in size.
        const hgt = Math.max(2, (w.p / maxP) * 30);
        svg += `<rect class="${wxKind(w)}" x="${(X(k) - bw / 2).toFixed(1)}" y="${(34 - hgt).toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" rx="1.5"><title>${fmtDay(T.days[i], true)}: ${wxText(w)}</title></rect>`;
      }
      if (w.tmin != null && w.tmin <= -15) svg += `<text class="cold" x="${X(k).toFixed(1)}" y="44" text-anchor="middle" style="fill:#6c4fc1">❄</text>`;
    });
    svg += `<line x1="${ML}" x2="${W - MR}" y1="34" y2="34" stroke="var(--line)"/></svg>`;
    return `<section class="tr-chart wx"><h2>Weather <span class="label-note">Toronto</span></h2>` +
      `<p class="sub">Rain (blue), snow (pale) and mixed days (outlined), at Toronto City. Snow depth is estimated from the ` +
      `temperature (colder snow is fluffier); ❄ marks days below −15 °C. Hover a chart for each day's figures.</p>${svg}</section>`;
  }

  // --- render ------------------------------------------------------------------------------
  let rendered = [];
  function render() {
    W = Math.max(300, Math.min(940, $("charts").clientWidth - 30));
    const xi = xDays();
    $("band-note").hidden = state.band === "all";
    const daysN = T.days.length;
    $("span-note").textContent = `Data from ${fmtDay(T.days[0], true)}: ${daysN} day${daysN === 1 ? "" : "s"} so far` +
      (daysN < 21 ? ", so lines are short for now and fill in each night." : ".");
    rendered = [];
    let html = weatherSvg(xi);
    for (const def of CHARTS) {
      const {svg, lines} = chartSvg(def, xi);
      rendered.push({def, lines, xi});
      const sub = typeof def.sub === "function" ? def.sub() : def.sub;
      const opts = def.opts ? `<div class="tr-opts"><div class="seg" role="group" aria-label="Signal measure">` +
        `<button data-sig="sig" class="${state.sig === "sig" ? "on" : ""}">Seconds lost</button>` +
        `<button data-sig="held" class="${state.sig === "held" ? "on" : ""}">Held 90 s+</button></div> ` +
        `<div class="seg" role="group" aria-label="Which signals">` +
        ["both", "tsp", "notsp"].map((k) => `<button data-split="${k}" class="${state.sigSplit === k ? "on" : ""}">` +
          `${{both: "Both", tsp: "Priority", notsp: "Other"}[k]}</button>`).join("") + `</div></div>` : "";
      const routesIn = [...new Set(lines.map((l) => l.r))];
      const legend = routesIn.map((r) => `<span><i style="background:${colorOf(r)}"></i>${nameOf(r)}</span>`).join("") +
        (def.id === "sig" && state.sigSplit === "both" ? `<span>solid: signals with transit priority</span><span class="dash"><i></i>dashed: other signals</span>` : "");
      html += `<section class="tr-chart" data-chart="${rendered.length - 1}">${opts}<h2>${def.title}</h2><p class="sub">${sub}</p>${svg}` +
        `<div class="tr-legend">${legend}</div></section>`;
    }
    $("charts").innerHTML = html;
    $("meta").textContent = `Every value is recomputed each night against the current baseline. Last day: ${fmtDay(T.days[daysN - 1], true)}.`;
    writeHash();
  }

  // --- hover: values for the nearest day -------------------------------------------------------
  const tip = $("tip");
  function hideTip() {
    tip.hidden = true;
    document.querySelectorAll(".cross").forEach((c) => c.setAttribute("visibility", "hidden"));
  }
  function showTip(e) {
    const sec = e.target.closest("[data-chart]"), svg = sec?.querySelector("svg");
    if (!sec || !svg) { hideTip(); return; }
    const {def, lines, xi} = rendered[+sec.dataset.chart];
    if (!lines.length) { hideTip(); return; }
    const box = svg.getBoundingClientRect(), x = (e.clientX - box.left) / box.width * W;
    const n = xi.length, X = xScale(n);
    const k = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((x - ML) / ((W - ML - MR) / (n - 1)))));
    const cross = svg.querySelector(".cross");
    cross.setAttribute("x1", X(k)); cross.setAttribute("x2", X(k)); cross.setAttribute("visibility", "visible");
    const day = T.days[xi[k]], w = T.weather?.[day];
    const rows = lines.filter((l) => l.vals[k] != null).sort((a, b) => b.vals[k] - a.vals[k]).map((l) =>
      `<div class="row"><span><span class="sw" style="background:${colorOf(l.r)}"></span>${nameOf(l.r)}${l.label ? ` <span class="dim">${l.label}</span>` : ""}</span><b>${def.fmt(l.vals[k])}</b></div>`).join("");
    const wx = w ? `<div class="dim">${wxText(w)}` +
      `${w.tmin != null ? ` · ${Math.round(w.tmin)}° to ${Math.round(w.tmax)}°C` : ""}</div>` : "";
    tip.innerHTML = `<div><b>${fmtDay(day, true)}</b></div>${wx}${rows || "<div class='dim'>No data this day</div>"}`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(innerWidth - tw - 8, e.clientX + 14)}px`;
    tip.style.top = `${Math.max(8, Math.min(innerHeight - th - 8, e.clientY - th / 2))}px`;
  }
  $("charts").addEventListener("mousemove", showTip);
  $("charts").addEventListener("mouseleave", hideTip);
  // Touch has no "mouse left the chart": a tap on a chart shows that day, and a tap anywhere
  // else, or scrolling, closes it.
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    if (e.target.closest("[data-chart] svg")) showTip(e); else hideTip();
  });
  addEventListener("scroll", () => { if (!tip.hidden && !matchMedia("(hover: hover)").matches) hideTip(); }, {passive: true});

  // --- controls ----------------------------------------------------------------------------------
  function renderChips() {
    $("routes").innerHTML = `<button data-route="" class="${state.routes.size ? "" : "on"}" aria-pressed="${!state.routes.size}">All</button>` +
      allRoutes.map((r) => `<button data-route="${r}" class="${state.routes.has(r) ? "on" : ""}" aria-pressed="${state.routes.has(r)}">${nameOf(r)}</button>`).join("");
  }
  $("routes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-route]");
    if (!b) return;
    const r = b.dataset.route;
    if (!r) state.routes.clear();
    else if (state.routes.has(r)) state.routes.delete(r);
    else state.routes.add(r);
    if (state.routes.size === allRoutes.length) state.routes.clear();
    renderChips();
    render();
  });
  const seg = (attr, key, parse = (v) => v) => {
    document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      b.classList.toggle("on", String(parse(b.dataset[attr])) === String(state[key]));
      b.addEventListener("click", () => {
        state[key] = parse(b.dataset[attr]);
        document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.toggle("on", x === b));
        render();
      });
    });
  };
  seg("period", "period", Number);
  seg("days", "days");
  seg("band", "band");
  $("shade-weather").checked = state.shade;
  $("shade-weather").addEventListener("change", (e) => { state.shade = e.target.checked; render(); });
  $("charts").addEventListener("click", (e) => {
    const s = e.target.closest("[data-sig]"), sp = e.target.closest("[data-split]");
    if (s) { state.sig = s.dataset.sig; render(); }
    if (sp) { state.sigSplit = sp.dataset.split; render(); }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  let resizeTimer = null;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

  renderChips();
  render();
})();
