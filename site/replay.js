// Replay: every streetcar's day, animated from data/replay.json (see pipeline/replay.py).
(async function () {
  const {MapboxOverlay, ScatterplotLayer, TripsLayer, PathLayer, IconLayer, TextLayer} = deck;
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
  const gclk = new Float32Array(nPts);  // ghost clock: clean-run seconds from the trip's first point
  const starts = new Uint32Array(data.cars.length + 1);
  const paths = [];  // {v, r, i0, i1 (exclusive), t0, t1}
  let k = 0;
  data.cars.forEach((c, ci) => {
    starts[ci] = k;
    let lon = 0, lat = 0, t = 0, g = 0;
    const i0 = k, rc = routeColor(c.r);
    for (let j = 0; j < c.p.length; j += 3, k++) {
      lon += c.p[j]; lat += c.p[j + 1]; t += c.p[j + 2];
      g += c.g ? c.g[j / 3] : 0;
      pos[2 * k] = lon / 1e5; pos[2 * k + 1] = lat / 1e5; ts[k] = t; gclk[k] = g;
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
    paths.push({v: c.v, r: c.r, i0, i1: k, t0: ts[i0], t1: ts[k - 1], ghost: !!c.g});
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
  const state = {t: 3 * 3600, speed: 600, playing: true, color: "route", follow: null, routes: new Set(), race: null};
  const routeOn = (r) => !state.routes.size || state.routes.has(r);
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has("t")) {
    const [hh, mm] = h.get("t").split(":").map(Number);
    if (!isNaN(hh)) state.t = (((hh - 4 + 24) % 24) * 3600 + (mm || 0) * 60);
  }
  if (["30", "120", "600"].includes(h.get("s"))) state.speed = +h.get("s");
  if (h.get("c") === "speed") state.color = "speed";
  for (const r of (h.get("r") || "").split(",")) if (paths.some((p) => p.r === r)) state.routes.add(r);
  if (h.has("car") && byCar.has(h.get("car"))) state.follow = h.get("car");
  state.t = Math.max(tMin, Math.min(tMax, state.t));
  function writeHash() {
    const local = (state.t / 3600 + 4) % 24, hh = Math.floor(local), mm = Math.floor((local - hh) * 60);
    const q = new URLSearchParams({t: `${hh}:${String(mm).padStart(2, "0")}`});
    if (state.speed !== 600) q.set("s", state.speed);
    if (state.color !== "route") q.set("c", state.color);
    if (state.routes.size) q.set("r", [...state.routes].sort().join(","));
    if (state.follow) q.set("car", state.follow);
    if (state.race) q.set("race", "1");
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
  // Phones have very dense screens; drawing the trails at full density is most of the work.
  const overlay = new MapboxOverlay({interleaved: false, layers: [], pickingRadius: 14,
    useDevicePixels: Math.min(devicePixelRatio || 1, wide ? 2 : 1.5)});
  map.addControl(overlay);
  await new Promise((res) => (map.loaded() ? res() : map.once("load", res)));
  // Quieter basemap: the cars are the show.
  for (const l of map.getStyle().layers) {
    if (l.type === "symbol" && /poi|housenum/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");
  }

  // Pack vertex ranges [[i0, i1), ...] into TripsLayer binary data, in both colourings.
  function pack(ranges) {
    const n = ranges.reduce((s, [a, b]) => s + b - a, 0);
    const out = {pos: new Float64Array(2 * n), ts: new Float32Array(n), route: new Uint8Array(4 * n), speed: new Uint8Array(4 * n)};
    const st = new Uint32Array(ranges.length + 1);
    let o = 0;
    ranges.forEach(([a, b], li) => {
      st[li] = o;
      out.pos.set(pos.subarray(2 * a, 2 * b), 2 * o);
      out.ts.set(ts.subarray(a, b), o);
      out.route.set(colRoute.subarray(4 * a, 4 * b), 4 * o);
      out.speed.set(colSpeed.subarray(4 * a, 4 * b), 4 * o);
      o += b - a;
    });
    st[ranges.length] = o;
    const mk = (colors) => ({length: ranges.length, startIndices: st,
      attributes: {getPath: {value: out.pos, size: 2}, getTimestamps: {value: out.ts, size: 1}, getColor: {value: colors, size: 4}}});
    return {route: mk(out.route), speed: mk(out.speed)};
  }

  // Trails are split into hour-long chunks and only the chunks in view are drawn: one or two
  // hours of track instead of the whole day's half-million points every frame (phones choke).
  const CHUNK_S = 3600;
  let chunks = [];
  let shown = paths;  // paths on the routes picked
  function lastAtOrBefore(p, t) {
    let lo = p.i0, hi = p.i1 - 1;
    if (ts[lo] > t) return lo;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid; else hi = mid;
    }
    return ts[hi] <= t ? hi : lo;
  }
  function buildChunks() {
    shown = paths.filter((p) => routeOn(p.r));
    const ranges = [];
    for (const p of shown) {
      for (let hr = Math.floor(p.t0 / CHUNK_S); hr <= Math.floor(p.t1 / CHUNK_S); hr++) {
        // From the last vertex at or before the hour starts to the first one after it ends.
        const a = lastAtOrBefore(p, hr * CHUNK_S), b = Math.min(p.i1, lastAtOrBefore(p, (hr + 1) * CHUNK_S) + 2);
        if (b - a >= 2) (ranges[hr] = ranges[hr] || []).push([a, b]);
      }
    }
    chunks = ranges.map((r) => r && pack(r));
  }

  function heads(t, list = shown) {
    const out = [];
    for (const p of list) {
      const a = at(p, t);
      if (a) out.push({p, lon: a[0], lat: a[1], i: a[3]});
    }
    return out;
  }
  const headColor = (d) => (state.color === "route" ? routeColor(d.p.r) : speedColor(kmh[d.i]));

  // The followed car's own paths, drawn on top with a long bright trail.
  let followTrips = null;
  const followData = (v) => pack(byCar.get(v).map((p) => [p.i0, p.i1]));

  function draw() {
    const hs = heads(state.t);
    const followed = state.follow ? heads(state.t, byCar.get(state.follow)) : [];
    const trails = [];
    for (let hr = Math.floor((state.t - TRAIL_S) / CHUNK_S); hr <= Math.floor(state.t / CHUNK_S); hr++) {
      if (!chunks[hr]) continue;
      trails.push(new TripsLayer({
        id: `trails-${hr}-${state.color}`, data: chunks[hr][state.color], _pathType: "open",
        currentTime: state.t, trailLength: TRAIL_S, fadeTrail: true,
        widthUnits: "pixels", getWidth: 3, widthMinPixels: 2, capRounded: true, jointRounded: true,
        opacity: state.follow ? 0.4 : 0.9,
      }));
    }
    overlay.setProps({layers: [
      ...trails,
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
        filled: false, stroked: true, getLineColor: [255, 255, 255, 255],
        lineWidthUnits: "pixels", getLineWidth: 2, radiusUnits: "pixels", getRadius: 13,
      }),
      ...raceLayers(),
    ]});
    $("clock").textContent = clockText(state.t);
    $("scrub").value = state.t;
    if (state.follow) updateFollow(followed[0]);
  }

  // --- following a car ------------------------------------------------------------------
  function follow(v) {
    if (v !== state.follow) state.race = null;
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
    if (!state.race) $("race").hidden = true;
    $("f-stats").innerHTML =
      `<span>Since ${clockText(legs[0].t0)}</span><b>${km.toFixed(1)} km</b>` +
      `<span>Moving</span><b>${dur(moving)}</b>` +
      `<span>Standing still</span><b>${dur(still)}</b>`;
    const trip = d ? d.p : legs.find((p) => p.t0 > state.t);
    $("race-btn").hidden = !!state.race || !raceable(trip);
    if (state.race) updateRace(d);
    else if (d && !dragging && !easing) map.jumpTo({center: [d.lon, d.lat]});
  }
  let easing = false;

  // --- racing the ghost ------------------------------------------------------------------
  // The ghost drives the same trip, along the same track, at the clean-run pace (the delay
  // map's baseline: the quickest 10% of daytime trips on each stretch, stops included). It
  // leaves when the real car pulls away and the race ends when the real car stops at the end.
  const GHOST_ICON = {
    url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='72' viewBox='0 0 64 72'>" +
      "<path d='M6 34a26 26 0 0 1 52 0v34l-8.7-7-8.6 7-8.7-7-8.7 7-8.6-7L6 68z' fill='#f4f1ff' " +
      "fill-opacity='.93' stroke='#b9a8ff' stroke-width='3' stroke-linejoin='round'/>" +
      "<circle cx='23' cy='32' r='5' fill='#1b1530'/><circle cx='41' cy='32' r='5' fill='#1b1530'/>" +
      "<ellipse cx='32' cy='46' rx='4' ry='5' fill='#1b1530'/></svg>"),
    width: 64, height: 72, anchorY: 60,
  };
  const MIN_RACE_KM = 1;
  function raceBounds(p) {
    // Pulling away: the last point before the car first moves 20 m. Arriving: the first
    // point within 20 m of where it finally stops.
    let s = p.i0, e = p.i1 - 1;
    while (s < e && cumKm[s + 1] - cumKm[p.i0] < 0.02) s++;
    while (e > s && cumKm[p.i1 - 1] - cumKm[e - 1] < 0.02) e--;
    return [s, e];
  }
  function raceable(p) {
    if (!p || !p.ghost) return false;
    const [s, e] = raceBounds(p);
    return cumKm[e] - cumKm[s] >= MIN_RACE_KM && gclk[e] > gclk[s];
  }
  function startRace(rewind, after = null) {
    const legs = byCar.get(state.follow).filter((q) => !after || q.t0 > after.t0);
    const p = after ? legs.find(raceable) :
      legs.find((q) => q.t0 <= state.t && state.t <= q.t1 && raceable(q)) || legs.find((q) => q.t0 > state.t && raceable(q));
    if (!p) return;
    const [s, e] = raceBounds(p);
    state.race = {p, s, e};
    state.race.best = bestTrip(state.race);
    if (rewind || state.t < ts[s] || state.t > ts[e]) state.t = ts[s] - 5;
    if (state.speed === 600) setSpeed(120);
    setPlaying(true);
    writeHash();
    draw();
  }
  function stopRace() {
    state.race = null;
    writeHash();
    draw();
  }
  // The best real trip: the quickest any car on the same route covered the same stretch
  // that day, between the points where this trip pulls away and arrives, the same way.
  // Daytime races (06:00 on) only count daytime trips and overnight ones overnight trips,
  // matching the clean run's daytime rule.
  const NEAR_M = 40;
  const localHour = (t) => (t / 3600 + 4) % 24;
  function project(i, P) {
    // Distance (m) from point P to segment i -> i+1, and how far along it the nearest point is.
    const ax = pos[2 * i] * KX, ay = pos[2 * i + 1] * KY, bx = pos[2 * i + 2] * KX, by = pos[2 * i + 3] * KY;
    const px = P[0] * KX, py = P[1] * KY, dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const u = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return [Math.hypot(px - ax - u * dx, py - ay - u * dy), u];
  }
  function bestTrip({p, s, e}) {
    const A = [pos[2 * s], pos[2 * s + 1]], B = [pos[2 * e], pos[2 * e + 1]];
    const len = cumKm[e] - cumKm[s], night = localHour(ts[s]) < 6;
    let best = null;
    for (const q of paths) {
      if (q.r !== p.r || q.i1 - q.i0 < 2 || (localHour(q.t0) < 6) !== night) continue;
      let a = null;
      for (let i = q.i0; i < q.i1 - 1; i++) {
        const [dA, uA] = project(i, A);
        if (dA < NEAR_M) { a = [i, uA]; continue; }  // keep the last pass by A: it may have waited there
        if (!a) continue;
        const [dB, uB] = project(i, B);
        if (dB >= NEAR_M) continue;
        const tA = lerpAt(ts, a[0], a[1]), tB = lerpAt(ts, i, uB);
        const kmA = lerpAt(cumKm, a[0], a[1]), kmB = lerpAt(cumKm, i, uB);
        // Same stretch: about the same distance (not a diversion or a trip round a loop).
        if (Math.abs(kmB - kmA - len) <= 0.12 * len && tB > tA && (!best || tB - tA < best.tB - best.tA)) {
          best = {q, tA, tB, kmA, kmB, lo: a[0], hi: Math.min(i + 1, q.i1 - 1)};
        }
        break;
      }
    }
    return best;
  }

  // Index and fraction along [lo, hi] where arr (non-decreasing) reaches v.
  function findIn(arr, lo, hi, v) {
    if (v <= arr[lo]) return [lo, 0];
    if (v >= arr[hi]) return [hi, 0];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid; else hi = mid;
    }
    const span = arr[hi] - arr[lo];
    return [lo, span > 0 ? (v - arr[lo]) / span : 0];
  }
  const lerpAt = (arr, i, f, stride = 1, o = 0) =>
    arr[stride * i + o] + f * ((arr[stride * (i + 1) + o] ?? arr[stride * i + o]) - arr[stride * i + o]);
  // Where things stand at time t: ghost and car positions, and the time lost so far.
  function raceState(t) {
    const {p, s, e} = state.race;
    const t0 = ts[s], tEnd = ts[e], g0 = gclk[s], gEnd = gclk[e];
    const [gi, gf] = findIn(gclk, s, e, g0 + Math.max(0, t - t0));
    const tc = Math.min(Math.max(t, t0), tEnd);
    const [ci, cf] = findIn(ts, s, e, tc);
    const carG = lerpAt(gclk, ci, cf), ghostKm = lerpAt(cumKm, gi, gf), carKm = lerpAt(cumKm, ci, cf);
    let best = null;
    const b = state.race.best;
    if (b && b.q !== p) {
      const [bi, bf] = findIn(ts, b.lo, b.hi, b.tA + Math.max(0, t - t0));
      // When the best trip got as far along as the car is now (distances scaled to match).
      const km = b.kmA + (carKm - cumKm[s]) * (b.kmB - b.kmA) / Math.max(1e-6, cumKm[e] - cumKm[s]);
      const [ki, kf] = findIn(cumKm, b.lo, b.hi, km);
      best = {at: [lerpAt(pos, bi, bf, 2, 0), lerpAt(pos, bi, bf, 2, 1)],
              lost: (tc - t0) - (lerpAt(ts, ki, kf) - b.tA), done: t - t0 >= b.tB - b.tA};
    }
    return {
      best, bestTime: b ? b.tB - b.tA : null, bestIsThis: !!b && b.q === p,
      ghost: [lerpAt(pos, gi, gf, 2, 0), lerpAt(pos, gi, gf, 2, 1)], gi, ci,
      car: [lerpAt(pos, ci, cf, 2, 0), lerpAt(pos, ci, cf, 2, 1)],
      lost: (tc - t0) - (carG - g0), aheadKm: Math.max(0, ghostKm - carKm),
      ghostDone: t - t0 >= gEnd - g0, carDone: t >= tEnd, started: t >= t0,
      real: tEnd - t0, clean: gEnd - g0, km: cumKm[e] - cumKm[s],
    };
  }
  function raceLayers() {
    if (!state.race) return [];
    const r = raceState(state.t);
    // The stretch of track between the car and the ghost: the gap it has opened up.
    const gap = [];
    if (r.gi > r.ci) {
      gap.push(r.car);
      for (let i = r.ci + 1; i <= r.gi; i++) gap.push([pos[2 * i], pos[2 * i + 1]]);
      gap.push(r.ghost);
    }
    return [
      new PathLayer({
        id: "ghost-gap", data: gap.length ? [gap] : [], getPath: (d) => d,
        getColor: [185, 168, 255, 130], widthUnits: "pixels", getWidth: 5, capRounded: true, jointRounded: true,
      }),
      new ScatterplotLayer({
        id: "ghost-glow", data: [r.ghost], getPosition: (d) => d,
        getFillColor: [200, 190, 255, 60], radiusUnits: "pixels", getRadius: 18,
      }),
      new IconLayer({
        id: "ghost", data: [r.ghost], getPosition: (d) => d, getIcon: () => GHOST_ICON,
        getSize: 34, sizeUnits: "pixels",
      }),
      new ScatterplotLayer({
        id: "best", data: r.best ? [r.best.at] : [], getPosition: (d) => d,
        getFillColor: [255, 196, 70, 255], radiusUnits: "pixels", getRadius: 6,
        stroked: true, getLineColor: [255, 255, 255, 230], lineWidthUnits: "pixels", getLineWidth: 1.5,
      }),
      new TextLayer({
        id: "best-label", data: r.best ? [r.best.at] : [], getPosition: (d) => d,
        getText: () => `Best real trip: car ${state.race.best.q.v}`, getSize: 12, getColor: [255, 214, 120, 255],
        getPixelOffset: [0, -16], fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600,
        background: true, getBackgroundColor: [20, 21, 24, 210], backgroundPadding: [5, 2],
      }),
    ];
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const mins = (s) => `${Math.round(s / 60)} min`;
  function updateRace(d) {
    const r = raceState(state.t);
    const b = state.race.best;
    const bestWho = b ? `car ${b.q.v} at ${clockText(b.tA)}` : "";
    const bestLine = (lost) => lost >= 5 ? `<span class="r-star">★</span> Best real trip ahead by ${mmss(lost)}` :
      lost <= -5 ? `<span class="r-star">★</span> ${mmss(-lost)} ahead of the best real trip` :
      `<span class="r-star">★</span> Level with the best real trip`;
    let html;
    if (!r.started) {
      html = `<div class="r-big">Ready…</div><div class="r-sub">The racers leave when car ${state.follow} pulls away.</div>`;
    } else if (!r.carDone) {
      html = (r.lost < 5 ? `<div class="r-big">Neck and neck with the ghost</div>` :
        `<div class="r-big">Ghost ahead by ${mmss(r.lost)}</div>` +
        `<div class="r-sub">${r.ghostDone ? "The ghost has already finished the trip." :
          `${r.aheadKm.toFixed(1)} km up the line.`}</div>`) +
        (r.best ? `<div class="r-row">${bestLine(r.best.lost)}</div><div class="r-sub">That's ${bestWho}.</div>` :
          r.bestIsThis ? `<div class="r-row"><span class="r-star">★</span> This is the day's fastest trip on this stretch.</div>` :
          `<div class="r-sub"><span class="r-star">★</span> No other trip covered exactly this stretch today, so there's no best real trip to race.</div>`);
    } else {
      const pct = Math.round((r.real / r.clean - 1) * 100);
      html = `<div class="r-big">Ghost wins by ${mins(r.real - r.clean)}</div>` +
        `<div class="r-results">` +
        `<span>This trip</span><b>${mins(r.real)}</b>` +
        (b ? `<span><span class="r-star">★</span> Best real trip${r.bestIsThis ? " (this one!)" : `, ${bestWho}`}</span><b>${mins(r.bestTime)}</b>` : "") +
        `<span>👻 Clean-run ghost</span><b>${mins(r.clean)}</b></div>` +
        `<div class="r-sub">${r.km.toFixed(1)} km. This trip took ${pct}% longer than the ghost` +
        (b && !r.bestIsThis ? ` and ${Math.round((r.real / r.bestTime - 1) * 100)}% longer than the best real trip.` : ".") + `</div>` +
        `<button class="linkish" id="race-next">Race the next trip</button>`;
    }
    $("race-body").innerHTML = html;
    $("race").hidden = false;
    const nx = $("race-next");
    if (nx) nx.onclick = () => { const prev = state.race.p; state.race = null; startRace(true, prev); };
    // Chase camera: keep both the car and the ghost in view.
    if (dragging || easing) return;
    const pts = [r.car, r.ghost, ...(r.best ? [r.best.at] : [])];
    const lons = pts.map((q) => q[0]), lats = pts.map((q) => q[1]);
    const pad = wide ? {top: 80, bottom: 120, left: 340, right: 320} : {top: 140, bottom: 300, left: 40, right: 40};
    const cam = map.cameraForBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      {padding: pad, bearing: map.getBearing()});
    if (!cam) { map.jumpTo({center: r.car}); return; }
    const z = map.getZoom(), tz = Math.min(15.5, cam.zoom);
    map.jumpTo({center: cam.center, zoom: z + (tz - z) * 0.08});
  }
  $("race-btn").addEventListener("click", () => startRace(true));
  $("race-stop").addEventListener("click", stopRace);
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
    lg.hidden = c === "route";  // the route chips double as the route legend
    if (c === "speed") {
      const max = SPEED_STOPS[SPEED_STOPS.length - 1][0];
      const ramp = SPEED_STOPS.map(([v, c]) => `rgb(${c.join(",")}) ${v / max * 100}%`).join(",");
      lg.innerHTML = `<div class="ramp" style="background:linear-gradient(90deg,${ramp})"></div>` +
        `<div class="ticks"><span>Standing</span><span>15</span><span>25</span><span>40+ km/h</span></div>`;
    }
    writeHash();
    draw();
  }
  document.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.color)));

  // Route chips: with every route showing, a tap picks just that route; after that taps
  // add or drop routes. Fewer routes also means less for a phone to draw.
  const allRoutes = Object.keys(ROUTES).filter((r) => paths.some((p) => p.r === r));
  function renderRoutes() {
    $("routes").innerHTML = allRoutes.map((r) =>
      `<button class="chip${routeOn(r) ? "" : " off"}" data-route="${r}" aria-pressed="${state.routes.has(r)}">` +
      `<span class="sw" style="background:rgb(${ROUTES[r][1].join(",")})"></span>${routeName(r)}</button>`).join("");
    $("routes-all").hidden = !state.routes.size;
    $("routes-hint").hidden = !!state.routes.size;
  }
  function routesChanged() {
    if (state.routes.size === allRoutes.length) state.routes.clear();
    renderRoutes();
    buildChunks();
    writeHash();
    draw();
  }
  $("routes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-route]");
    if (!b) return;
    const r = b.dataset.route;
    if (!state.routes.size) state.routes.add(r);
    else if (state.routes.has(r)) state.routes.delete(r);
    else state.routes.add(r);
    routesChanged();
  });
  $("routes-all").addEventListener("click", () => { state.routes.clear(); routesChanged(); });

  // --- go ------------------------------------------------------------------------------
  renderRoutes();
  buildChunks();
  setSpeed(state.speed);
  setColor(state.color);
  if (state.follow) {
    follow(state.follow);
    if (h.get("race") === "1") startRace(false);
  }
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
