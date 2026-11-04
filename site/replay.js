// Replay: every streetcar's day, animated from data/replay.json (see pipeline/replay.py).
(async function () {
  const {MapboxOverlay, ScatterplotLayer, TripsLayer} = deck;
  const $ = (id) => document.getElementById(id);

  const ROUTES = {
    "501": ["Queen", [255, 85, 85]], "503": ["Kingston Rd", [205, 165, 125]], "504": ["King", [255, 210, 60]],
    "505": ["Dundas", [70, 205, 120]], "506": ["Carlton", [60, 200, 205]], "507": ["Long Branch", [110, 165, 255]],
    "508": ["Lake Shore", [165, 135, 255]], "509": ["Harbourfront", [255, 145, 60]], "510": ["Spadina", [255, 120, 210]],
    "511": ["Bathurst", [215, 245, 120]], "512": ["St Clair", [150, 225, 255]],
  };
  const OTHER = [200, 200, 200];
  const routeColor = (r) => (ROUTES[r] ? ROUTES[r][1] : OTHER);
  const routeName = (r) => (ROUTES[r] ? `${r} ${ROUTES[r][0]}` : `Route ${r}`);
  // Speed: standing still glows red, a car at line speed glows pale gold.
  const SPEED_STOPS = [[0, [200, 40, 90]], [6, [240, 80, 70]], [15, [252, 150, 70]], [25, [252, 215, 120]], [40, [255, 245, 200]]];
  function speedColor(kmh) {
    if (kmh >= SPEED_STOPS[SPEED_STOPS.length - 1][0]) return SPEED_STOPS[SPEED_STOPS.length - 1][1];
    for (let i = 1; i < SPEED_STOPS.length; i++) {
      const [v1, c1] = SPEED_STOPS[i];
      if (kmh <= v1) {
        const [v0, c0] = SPEED_STOPS[i - 1], f = (kmh - v0) / (v1 - v0);
        return [0, 1, 2].map((k) => Math.round(c0[k] + f * (c1[k] - c0[k])));
      }
    }
  }
  const STILL_KMH = 1;
  const TRAIL_S = 420;  // seconds of trail behind each car (in replay time)
  const DAY_S = 86400;

  // --- data -----------------------------------------------------------------------
  let data;
  try {
    data = await (await fetch("data/replay.json", {cache: "no-cache"})).json();
  } catch (e) {
    $("loading").textContent = "No replay yet: it's built each night from the previous day.";
    return;
  }
  const KX = 111320 * Math.cos(43.67 * Math.PI / 180), KY = 110540;
  let nPts = 0;
  for (const c of data.cars) nPts += c.p.length / 3;
  const pos = new Float64Array(nPts * 2), ts = new Float32Array(nPts);
  const colRoute = new Uint8Array(nPts * 4), colSpeed = new Uint8Array(nPts * 4);
  const kmh = new Float32Array(nPts), cumKm = new Float64Array(nPts), cumStill = new Float64Array(nPts);
  const starts = new Uint32Array(data.cars.length + 1);
  const paths = [];  // {v, r, i0, i1 (exclusive), t0, t1}
  let k = 0;
  data.cars.forEach((c, ci) => {
    starts[ci] = k;
    let lon = 0, lat = 0, t = 0;
    const i0 = k, rc = routeColor(c.r);
    for (let j = 0; j < c.p.length; j += 3, k++) {
      lon += c.p[j]; lat += c.p[j + 1]; t += c.p[j + 2];
      pos[2 * k] = lon / 1e5; pos[2 * k + 1] = lat / 1e5; ts[k] = t;
      if (k > i0) {
        const d = Math.hypot((pos[2 * k] - pos[2 * k - 2]) * KX, (pos[2 * k + 1] - pos[2 * k - 1]) * KY);
        const dt = ts[k] - ts[k - 1];
        kmh[k] = dt > 0 ? d / dt * 3.6 : 0;
        cumKm[k] = cumKm[k - 1] + d / 1000;
        cumStill[k] = cumStill[k - 1] + (kmh[k] < STILL_KMH ? dt : 0);
      }
    }
    if (k - i0 > 1) kmh[i0] = kmh[i0 + 1];
    for (let i = i0; i < k; i++) {
      colRoute.set([...rc, 255], 4 * i);
      // Colour each vertex by the speed of the stretch leading up to it.
      colSpeed.set([...speedColor(kmh[i]), 255], 4 * i);
    }
    paths.push({v: c.v, r: c.r, i0, i1: k, t0: ts[i0], t1: ts[k - 1]});
  });
  starts[data.cars.length] = k;
  const byCar = new Map();
  for (const p of paths) {
    if (!byCar.has(p.v)) byCar.set(p.v, []);
    byCar.get(p.v).push(p);
  }
  const tMin = Math.min(...paths.map((p) => p.t0)), tMax = Math.max(...paths.map((p) => p.t1));

  // Where a path is at time t: [lon, lat, vertex index], or null when it isn't running.
  function at(p, t) {
    if (t < p.t0 || t > p.t1) return null;
    let lo = p.i0, hi = p.i1 - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid; else hi = mid;
    }
    const span = ts[hi] - ts[lo], f = span > 0 ? (t - ts[lo]) / span : 0;
    return [pos[2 * lo] + f * (pos[2 * hi] - pos[2 * lo]), pos[2 * lo + 1] + f * (pos[2 * hi + 1] - pos[2 * lo + 1]), lo, hi, f];
  }

  // --- labels -----------------------------------------------------------------------
  const TZ = "America/Toronto";
  const dayDate = new Date(data.start * 1000);
  $("day-label").textContent = dayDate.toLocaleDateString("en-CA", {timeZone: TZ, weekday: "long", month: "long", day: "numeric"});
  const clockFmt = new Intl.DateTimeFormat("en-US", {timeZone: TZ, hour: "numeric", minute: "2-digit"});
  const clockText = (t) => clockFmt.format(new Date((data.start + t) * 1000)).replace(" AM", " am").replace(" PM", " pm");
  const dur = (s) => {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return h ? `${h} h ${String(m).padStart(2, "0")} m` : m ? `${m}:${String(sec).padStart(2, "0")}` : `${sec} s`;
  };

  // --- state + hash -------------------------------------------------------------------
  const state = {t: 3 * 3600, speed: 600, playing: true, color: "route", follow: null};
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has("t")) {
    const [hh, mm] = h.get("t").split(":").map(Number);
    if (!isNaN(hh)) state.t = (((hh - 4 + 24) % 24) * 3600 + (mm || 0) * 60);
  }
  if (["30", "120", "600"].includes(h.get("s"))) state.speed = +h.get("s");
  if (h.get("c") === "speed") state.color = "speed";
  if (h.has("car") && byCar.has(h.get("car"))) state.follow = h.get("car");
  state.t = Math.max(tMin, Math.min(tMax, state.t));
  function writeHash() {
    const local = (state.t / 3600 + 4) % 24, hh = Math.floor(local), mm = Math.floor((local - hh) * 60);
    const q = new URLSearchParams({t: `${hh}:${String(mm).padStart(2, "0")}`});
    if (state.speed !== 600) q.set("s", state.speed);
    if (state.color !== "route") q.set("c", state.color);
    if (state.follow) q.set("car", state.follow);
    history.replaceState(null, "", "#" + q.toString());
  }

  // --- map ---------------------------------------------------------------------------
  const wide = innerWidth > 700;
  const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/dark",
    center: wide ? [-79.40, 43.660] : [-79.40, 43.655], zoom: wide ? 12.3 : 11.2,
    pitch: 45, bearing: -17, maxPitch: 70,
    attributionControl: {compact: true, customAttribution: "Data: TTC GTFS-Realtime via City of Toronto Open Data"},
  });
  map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), "top-right");
  const overlay = new MapboxOverlay({interleaved: false, layers: [], pickingRadius: 14});
  map.addControl(overlay);
  await new Promise((res) => (map.loaded() ? res() : map.once("load", res)));
  // Quieter basemap: the cars are the show.
  for (const l of map.getStyle().layers) {
    if (l.type === "symbol" && /poi|housenum/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");
  }

  const tripData = (colors) => ({
    length: paths.length, startIndices: starts,
    attributes: {getPath: {value: pos, size: 2}, getTimestamps: {value: ts, size: 1}, getColor: {value: colors, size: 4}},
  });
  const tripsByColor = {route: tripData(colRoute), speed: tripData(colSpeed)};

  function heads(t) {
    const out = [];
    for (const p of paths) {
      const a = at(p, t);
      if (a) out.push({p, lon: a[0], lat: a[1], i: a[3]});
    }
    return out;
  }
  const headColor = (d) => (state.color === "route" ? routeColor(d.p.r) : speedColor(kmh[d.i]));

  // The followed car's own paths, drawn on top with a long bright trail.
  let followTrips = null;
  function followData(v) {
    const legs = byCar.get(v), n = legs.reduce((s, p) => s + p.i1 - p.i0, 0);
    const out = {pos: new Float64Array(2 * n), ts: new Float32Array(n), route: new Uint8Array(4 * n), speed: new Uint8Array(4 * n)};
    const st = new Uint32Array(legs.length + 1);
    let o = 0;
    legs.forEach((p, li) => {
      st[li] = o;
      out.pos.set(pos.subarray(2 * p.i0, 2 * p.i1), 2 * o);
      out.ts.set(ts.subarray(p.i0, p.i1), o);
      out.route.set(colRoute.subarray(4 * p.i0, 4 * p.i1), 4 * o);
      out.speed.set(colSpeed.subarray(4 * p.i0, 4 * p.i1), 4 * o);
      o += p.i1 - p.i0;
    });
    st[legs.length] = o;
    const mk = (colors) => ({length: legs.length, startIndices: st,
      attributes: {getPath: {value: out.pos, size: 2}, getTimestamps: {value: out.ts, size: 1}, getColor: {value: colors, size: 4}}});
    return {route: mk(out.route), speed: mk(out.speed)};
  }

  function draw() {
    const hs = heads(state.t);
    const followed = state.follow ? hs.filter((d) => d.p.v === state.follow) : [];
    overlay.setProps({layers: [
      new TripsLayer({
        id: "trails", data: tripsByColor[state.color], _pathType: "open",
        currentTime: state.t, trailLength: TRAIL_S, fadeTrail: true,
        widthUnits: "pixels", getWidth: 3, widthMinPixels: 2, capRounded: true, jointRounded: true,
        opacity: state.follow ? 0.4 : 0.9,
        updateTriggers: {getColor: state.color},
      }),
      followTrips && new TripsLayer({
        id: `followed-trail-${state.follow}`, data: followTrips[state.color], _pathType: "open",
        currentTime: state.t, trailLength: 2400, fadeTrail: true,
        widthUnits: "pixels", getWidth: 5, capRounded: true, jointRounded: true,
      }),
      new ScatterplotLayer({
        id: "glow", data: hs, getPosition: (d) => [d.lon, d.lat],
        getFillColor: (d) => [...headColor(d), 70], radiusUnits: "pixels", getRadius: 9,
        updateTriggers: {getFillColor: state.color},
      }),
      new ScatterplotLayer({
        id: "heads", data: hs, pickable: true, getPosition: (d) => [d.lon, d.lat],
        getFillColor: (d) => [...headColor(d), 255], radiusUnits: "pixels", getRadius: 3.5,
        stroked: true, getLineColor: [255, 255, 255, 200], lineWidthUnits: "pixels", getLineWidth: 0.8,
        updateTriggers: {getFillColor: state.color},
        onClick: ({object}) => object && follow(object.p.v),
      }),
      new ScatterplotLayer({
        id: "followed", data: followed, getPosition: (d) => [d.lon, d.lat],
        getFillColor: [0, 0, 0, 0], stroked: true, getLineColor: [255, 255, 255, 255],
        lineWidthUnits: "pixels", getLineWidth: 2, radiusUnits: "pixels", getRadius: 13,
      }),
    ]});
    $("clock").textContent = clockText(state.t);
    $("scrub").value = state.t;
    if (state.follow) updateFollow(followed[0]);
  }

  // --- following a car ------------------------------------------------------------------
  function follow(v) {
    state.follow = v;
    followTrips = v ? followData(v) : null;
    $("follow").hidden = !v;
    document.body.classList.toggle("following", !!v);
    if (v) {
      const p = byCar.get(v).find((q) => q.t1 >= state.t) || byCar.get(v)[0];
      if (state.t < p.t0) state.t = p.t0;
      const a = at(p, state.t);
      if (state.speed === 600) setSpeed(120);
      // Fly in, then track the car each frame (tracking during the flight would cancel it).
      easing = true;
      map.easeTo({center: [a[0], a[1]], zoom: Math.max(map.getZoom(), 15), pitch: 55, duration: 900});
      map.once("moveend", () => { easing = false; });
    }
    writeHash();
    draw();
  }
  function updateFollow(d) {
    const v = state.follow, legs = byCar.get(v);
    let km = 0, still = 0, moving = 0, last = null;
    for (const p of legs) {
      if (state.t < p.t0) break;
      const a = at(p, Math.min(state.t, p.t1));
      const i = a[2], f = a[4], j = a[3];
      km += cumKm[i] + f * (cumKm[j] - cumKm[i]);
      const st = cumStill[i] + f * (cumStill[j] - cumStill[i]);
      still += st;
      moving += Math.min(state.t, p.t1) - p.t0 - st;
      last = p;
    }
    const route = d ? d.p.r : last ? last.r : legs[0].r;
    $("f-title").textContent = `Car ${v}`;
    $("f-route").textContent = routeName(route);
    $("f-dot").style.background = $("f-dot").style.color = `rgb(${routeColor(route).join(",")})`;
    if (!d) {
      const next = legs.find((p) => p.t0 > state.t);
      $("f-now").innerHTML = next ? `<span class="still">Out of service</span> until ${clockText(next.t0)}` :
        last ? `<span class="still">Done for the day</span>` : `Starts at ${clockText(legs[0].t0)}`;
    } else {
      const speed = kmh[d.i];
      if (speed < STILL_KMH) {
        // How long it has been standing: walk back through the still stretches.
        let i = d.i;
        while (i > d.p.i0 && kmh[i] < STILL_KMH) i--;
        $("f-now").innerHTML = `<span class="still">Standing still ${dur(state.t - ts[i])}</span>`;
      } else {
        $("f-now").textContent = `${Math.round(speed)} km/h`;
      }
    }
    $("f-stats").innerHTML =
      `<span>Since ${clockText(legs[0].t0)}</span><b>${km.toFixed(1)} km</b>` +
      `<span>Moving</span><b>${dur(moving)}</b>` +
      `<span>Standing still</span><b>${dur(still)}</b>`;
    if (d && !dragging && !easing) map.jumpTo({center: [d.lon, d.lat]});
  }
  let easing = false;
  $("f-close").addEventListener("click", () => follow(null));
  $("random").addEventListener("click", () => {
    const hs = heads(state.t);
    if (hs.length) follow(hs[Math.floor(Math.random() * hs.length)].p.v);
  });
  // Let people look around while following: the camera stops tracking while they drag.
  let dragging = false;
  map.on("dragstart", () => { dragging = true; });
  map.on("dragend", () => { dragging = false; });

  // --- controls ----------------------------------------------------------------------
  function setSpeed(s) {
    state.speed = s;
    document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("on", +b.dataset.speed === s));
    writeHash();
  }
  document.querySelectorAll("[data-speed]").forEach((b) => b.addEventListener("click", () => setSpeed(+b.dataset.speed)));
  function setPlaying(on) {
    state.playing = on;
    $("play").textContent = on ? "❚❚" : "▶";
    $("play").setAttribute("aria-label", on ? "Pause" : "Play");
    if (!on) writeHash();
  }
  $("play").addEventListener("click", () => setPlaying(!state.playing));
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && e.target === document.body) { e.preventDefault(); setPlaying(!state.playing); }
    if (e.key === "Escape") follow(null);
  });
  const scrub = $("scrub");
  scrub.min = tMin; scrub.max = tMax;
  scrub.addEventListener("input", () => { state.t = +scrub.value; draw(); });
  scrub.addEventListener("change", writeHash);

  function setColor(c) {
    state.color = c;
    document.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
    const lg = $("legend");
    lg.classList.toggle("speed", c === "speed");
    if (c === "route") {
      const seen = new Set(paths.map((p) => p.r));
      lg.innerHTML = Object.keys(ROUTES).filter((r) => seen.has(r)).map((r) =>
        `<span class="k"><span class="sw" style="background:rgb(${ROUTES[r][1].join(",")})"></span>${routeName(r)}</span>`).join("");
    } else {
      const max = SPEED_STOPS[SPEED_STOPS.length - 1][0];
      const ramp = SPEED_STOPS.map(([v, c]) => `rgb(${c.join(",")}) ${v / max * 100}%`).join(",");
      lg.innerHTML = `<div class="ramp" style="background:linear-gradient(90deg,${ramp})"></div>` +
        `<div class="ticks"><span>Standing</span><span>15</span><span>25</span><span>40+ km/h</span></div>`;
    }
    writeHash();
    draw();
  }
  document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.color)));

  // --- go ------------------------------------------------------------------------------
  setSpeed(state.speed);
  setColor(state.color);
  if (state.follow) follow(state.follow);
  $("loading").hidden = true;
  let lastFrame = performance.now(), lastHash = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (state.playing) {
      state.t += dt * state.speed;
      if (state.t > tMax) state.t = tMin;  // loop the day
      draw();
      if (now - lastHash > 2000) { writeHash(); lastHash = now; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
