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

  // Short turns that day (pipeline/shortturns.py): a car sent back before the end of its
  // trip. Each pops a yellow "!" over the car for a few seconds of watching.
  const shortEv = (data.st || []).map(([t, v, lon, lat, r, d, name, to]) => ({t, v, lon, lat, r, d, name, to}))
    .sort((a, b) => a.t - b.t);
  const SHORT_ICON = {url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='58' viewBox='0 0 64 58'><path d='M32 4 L60 54 H4 Z' fill='#ffc21a' stroke='#3a2a00' stroke-width='4' stroke-linejoin='round'/><rect x='29' y='19' width='6' height='20' rx='3' fill='#3a2a00'/><circle cx='32' cy='46' r='3.8' fill='#3a2a00'/></svg>"),
    width: 64, height: 58, anchorY: 58};
  const shortShowFor = () => Math.max(300, state.speed * 3.5);  // replay seconds: at least ~3.5 s on screen
  const activeShort = (v) => shortEv.filter((e) => (v ? e.v === v : routeOn(e.r)) &&
    state.t >= e.t && state.t < e.t + shortShowFor());

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
  const state = {t: 3 * 3600, speed: 600, playing: true, color: "route", follow: null, routes: new Set(), race: null,
    dim: 0, focus: null, extra: [], hideShort: false, pinShort: false};  // the last five: the tour (tour.js)
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
  // The tour (tour.js) drives the clock, camera and a focus car while it plays.
  const tour = {active: h.get("tour") === "1", tick: null, layers: null};
  if (tour.active) state.follow = null;
  function writeHash() {
    if (tour.tick) return;
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
  // The dark style draws streets barely lighter than the ground (#181818 on #0c0c0c); lift
  // them a few shades so the street grid reads under the trails without brightening the map.
  const ROADS = {
    highway_minor: "#2b2b2f", highway_motorway_subtle: "#2b2b2f", highway_major_inner: "#26262a",
    highway_major_subtle: "#3a3a3e", highway_major_casing: "rgba(80,80,86,0.9)", highway_motorway_casing: "rgba(80,80,86,0.9)",
  };
  for (const [id, color] of Object.entries(ROADS)) if (map.getLayer(id)) map.setPaintProperty(id, "line-color", color);
  if (map.getLayer("highway_name_other")) map.setPaintProperty("highway_name_other", "text-color", "rgb(118,116,116)");

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
      if (a) out.push({p, lon: a[0], lat: a[1], lo: a[2], i: a[3], f: a[4]});
    }
    return out;
  }
  const headColor = (d) => (state.color === "route" ? routeColor(d.p.r) : speedColor(kmh[d.i]));

  // Zoomed in, the dots become cartoon streetcars. Every TTC streetcar is a Flexity now, so one
  // design does, checked against photos: red roof, a white band under it, tall dark windows
  // that catch the sky, a white belt under them, red down to the rail; black bellows between
  // the five sections; blunt ends; doors on the right side only (they run one way);
  // pantograph on the short section behind the cab, grey equipment on the roof.
  // Each car is five sprites, one per section, placed along its own track, so it bends round
  // corners by itself. Each section is drawn from the nearest of 24 directions to the one it
  // faces on screen (and turned by the rest): a box seen from the map's tilt, its faces shaded, with
  // the flat drawings below mapped onto them (side art on the sides, the cab and rear faces
  // on the ends). Sprites are made as they're first needed. A soft halo on the ground under
  // each car carries the route or speed colour, like the trails, which stay the legend.
  //
  // Side art, nose right: the body runs x 8-193 (184 = 30 m), roof y 8, rail y 42.
  const TRAM_BODY_PATH = "M15 8H184Q191.5 8 191.8 16L192 31L193 32.5V40Q193 42 191 42H12Q8 42 8 38V15Q8 8 15 8Z";
  const TRAM_JOINTS = [54, 76, 124, 146];   // sections of 46, 22, 48, 22, 46
  const GLASS = "<linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#56606e'/>" +
    "<stop offset='.45' stop-color='#1f232a'/><stop offset='1' stop-color='#121418'/></linearGradient>";
  // red body, white band under the roof, windows (the windscreen taller), white belt, bellows,
  // doors, destination sign, lights, glare (kept inside the body by clip #c)
  const sideArt = (doors) =>
    `<path d='${TRAM_BODY_PATH}' fill='#da291c'/>` +
    "<path d='M8.2 12.2H184.5Q191.3 12.4 191.6 16.6V18.4H8.2Z' fill='#f2f2f2'/>" +
    "<rect x='8.6' y='14.6' width='168' height='14.4' rx='1' fill='url(#w)'/>" +
    "<path d='M177 14H184.5Q191.2 14.2 191.5 18L191.8 30H177Z' fill='url(#w)'/>" +
    "<path d='M8 29H193V31.3H8Z' fill='#f2f2f2'/>" +
    TRAM_JOINTS.map((x) => `<rect x='${x - 2}' y='8' width='4' height='34' fill='#1c1c20'/>`).join("") +
    (doors ? [28, 60, 96, 152] : []).map((x) => `<rect x='${x}' y='14.6' width='10' height='26' rx='1' fill='url(#w)' stroke='#8d8d96' stroke-width='.8'/>` +
      `<path d='M${x + 5} 15V40.5' stroke='#8d8d96' stroke-width='.6'/>`).join("") +
    "<rect x='179' y='15.6' width='9.5' height='2.4' rx='.5' fill='#ffa31a'/>" +
    "<g clip-path='url(#c)'>" +
    [18, 46, 86, 114, 134, 166, 186].map((x) => `<path d='M${x} 14.6H${x + 5}L${x + 1.4} 29H${x - 3.6}Z' fill='#fff' fill-opacity='.13'/>` +
      `<path d='M${x + 7} 14.6H${x + 8.6}L${x + 5} 29H${x + 3.4}Z' fill='#fff' fill-opacity='.13'/>`).join("") + "</g>";
  // End art, as seen from outside: x 7-33 across the car, y 63.5 (top of the face) to 96 (rail).
  const endGlare = "<path d='M15 66.2H20.5L14.5 84.3H9Z' fill='#fff' fill-opacity='.13'/><path d='M23 66.2H24.8L18.8 84.3H17Z' fill='#fff' fill-opacity='.13'/>";
  const endBands = "<rect x='7' y='60' width='26' height='36' fill='#da291c'/><path d='M7 63.5H33V66H7Z' fill='#f2f2f2'/>" +
    "<path d='M7 84.5H33V86.5H7Z' fill='#f2f2f2'/><path d='M7 90.3H33V93H7Z' fill='#f2f2f2'/>";
  const frontArt = endBands +   // big windscreen, destination sign, headlights
    "<rect x='8.2' y='66' width='23.6' height='18.5' rx='2' fill='url(#w)'/>" +
    "<rect x='12' y='67.4' width='16' height='2.5' rx='.5' fill='#ffa31a'/>" +
    "<rect x='9' y='87.9' width='4.5' height='1.8' rx='.9' fill='#fff6d8'/><rect x='26.5' y='87.9' width='4.5' height='1.8' rx='.9' fill='#fff6d8'/>" + endGlare;
  const rearArt = endBands +    // rear window, tail lights
    "<rect x='10' y='67' width='20' height='14.5' rx='2' fill='url(#w)'/>" +
    "<rect x='9' y='87.6' width='4.5' height='2.2' rx='1' fill='#ff4a3a' stroke='#3a0806' stroke-width='.6'/>" +
    "<rect x='26.5' y='87.6' width='4.5' height='2.2' rx='1' fill='#ff4a3a' stroke='#3a0806' stroke-width='.6'/>" + endGlare;
  const TRAM_K = 30 / 184;                       // metres per unit of side art
  const TRAM_W = 3.8, TRAM_H = 34 * TRAM_K;      // chunky: wider and taller than life
  // Rear to front: art x from/to, side profile (art units, round from the bottom-left), roof gear.
  const SECTIONS = [
    {x0: 8, x1: 54, prof: [[8, 42], [54, 42], [54, 8], [15, 8], [10, 10], [8, 15]], gear: true},
    {x0: 54, x1: 76},
    {x0: 76, x1: 124, gear: true},
    {x0: 124, x1: 146, panto: true},
    {x0: 146, x1: 193, prof: [[146, 42], [192.5, 42], [192, 16], [188, 9.5], [184, 8], [146, 8]], gear: true},
  ].map((s) => ({...s, prof: s.prof || [[s.x0, 42], [s.x1, 42], [s.x1, 8], [s.x0, 8]]}));
  const TRAM_MID = (8 + 193) / 2;                // the car's middle, in art units
  const TRAM_DIRS = 24;
  const TRAM_PPM = 12, TRAM_FW = 12, TRAM_FH = 13, TRAM_CX = 6, TRAM_CY = 8.5;  // sprite frame, metres
  // Sprites are drawn for the map's tilt, in 10-degree steps: drawn for one tilt and seen at
  // another, a car's sections no longer line up. At most two steps' sprites are kept; tilting
  // to a third starts afresh (a new layer, so its texture doesn't keep growing).
  const TRAM_TILT_STEP = 10;
  const tramSprites = new Map(), tramTilts = new Set();
  let tramGen = 0;
  function tramTilt() {
    const t = Math.round(map.getPitch() / TRAM_TILT_STEP) * TRAM_TILT_STEP;
    if (!tramTilts.has(t)) {
      if (tramTilts.size >= 2) { tramTilts.clear(); tramSprites.clear(); tramGen++; }
      tramTilts.add(t);
    }
    return t;
  }
  function tramSprite(si, dir, tilt) {
    // Section si seen heading dir (0 = right across the screen, counting anticlockwise, so
    // 6 = away from the camera, 18 = towards it), from a camera tilted tilt degrees from
    // straight down. Ground X right, Y away, Z up, in metres; u along the section (rear to
    // front), w across (to its left), v up.
    const key = `${tilt}-${si}-${dir}`;
    if (tramSprites.has(key)) return tramSprites.get(key);
    const s = SECTIONS[si], phi = dir / TRAM_DIRS * 2 * Math.PI, pitch = tilt * Math.PI / 180;
    const ca = Math.cos(phi), sa = Math.sin(phi), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const uc = (s.x1 - s.x0) * TRAM_K / 2, W = TRAM_W;
    const P = (u, w, v) => [(TRAM_CX + (u - uc) * ca - w * sa) * TRAM_PPM,
      (TRAM_CY - ((u - uc) * sa + w * ca) * cp - v * sp) * TRAM_PPM];
    const view = [0, sp, -cp], lit = [-0.45, -0.55, 0.7].map((c, _, a) => c / Math.hypot(...a));
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const pts = (a) => a.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const matrix = (F) => {
      const o = F(0, 0), fx = F(1, 0), fy = F(0, 1);
      return `matrix(${[fx[0] - o[0], fx[1] - o[1], fy[0] - o[0], fy[1] - o[1], o[0], o[1]].map((c) => c.toFixed(4)).join(" ")})`;
    };
    let out = "", ids = 0;
    const face = (poly, n, fill, decal = "") => {
      if (dot(n, view) > -1e-6) return;  // facing away from the camera
      const dark = ((0.45 - 0.45 * Math.max(0, dot(n, lit))) * 0.8).toFixed(2);
      out += `<polygon points='${pts(poly)}' fill='${fill}'/>${decal}` +
        `<polygon points='${pts(poly)}' fill='#000' fill-opacity='${dark}' stroke='#000' stroke-opacity='.35' stroke-width='.7'/>`;
    };
    const decal = (F, clip, art) => {
      const id = "k" + ids++;
      return `<g transform='${matrix(F)}'><clipPath id='${id}'>${clip}</clipPath><g clip-path='url(#${id})'>${art}</g></g>`;
    };
    const prof = s.prof.map(([x, y]) => [(x - s.x0) * TRAM_K, (42 - y) * TRAM_K]);  // (u, v)
    // The two sides: right (doors) and left.
    for (const [w, sgn, doors] of [[-W / 2, -1, true], [W / 2, 1, false]]) {
      const F = (X, Y) => P((X - s.x0) * TRAM_K, w, (42 - Y) * TRAM_K);
      face(prof.map(([u, v]) => P(u, w, v)), [-sa * sgn, ca * sgn, 0], "#da291c",
        decal(F, `<polygon points='${pts(s.prof)}'/>`, sideArt(doors)));
    }
    // The faces round the profile: cab and rear faces, bellows between sections, roof, bevels.
    s.prof.forEach((_, i) => {
      const [u0, v0] = prof[i], [u1, v1] = prof[(i + 1) % prof.length], len = Math.hypot(u1 - u0, v1 - v0);
      if (len < 1e-6) return;
      const nu = (v1 - v0) / len, nv = -(u1 - u0) / len, n = [nu * ca, nu * sa, nv];
      const poly = [P(u0, -W / 2, v0), P(u1, -W / 2, v1), P(u1, W / 2, v1), P(u0, W / 2, v0)];
      if (Math.abs(nu) > 0.9) {
        const art = nu > 0 ? si === SECTIONS.length - 1 && frontArt : si === 0 && rearArt;
        if (!art) return face(poly, n, "#1c1c20");
        // Seen from outside, the viewer's right is the car's left at the front, its right at the back.
        const [b, t] = v0 < v1 ? [[u0, v0], [u1, v1]] : [[u1, v1], [u0, v0]], side = nu > 0 ? 1 : -1;
        const F = (X, Y) => {
          const f = (96 - Y) / 32.5;
          return P(b[0] + f * (t[0] - b[0]), side * (X - 20) / 26 * W, b[1] + f * (t[1] - b[1]));
        };
        return face(poly, n, "#da291c", decal(F, "<rect x='7' y='63.5' width='26' height='32.5'/>", art));
      }
      if (nv > 0.9) {
        const a = Math.min(u0, u1), z = Math.max(u0, u1), g0 = a + (z - a) * 0.18, g1 = z - (z - a) * 0.18;
        return face(poly, n, "#c3241a", s.gear ? `<polygon points='${pts([P(g0, -W * 0.28, v0),
          P(g1, -W * 0.28, v0), P(g1, W * 0.28, v0), P(g0, W * 0.28, v0)])}' fill='#8e9198' stroke='#5c5f66' stroke-width='.6'/>` : "");
      }
      face(poly, n, "#c9261b");
    });
    if (s.panto) {
      const u = uc, top = TRAM_H + 1.4, q = (a, b, c) => P(a, b, c).map((x) => x.toFixed(1)).join(",");
      out += `<polyline points='${q(u - 1.3, 0, TRAM_H)} ${q(u, 0, top)} ${q(u + 1.3, 0, TRAM_H)}' fill='none' stroke='#c4c4cc' stroke-width='1.6' stroke-linejoin='round'/>` +
        `<polyline points='${q(u, -1, top)} ${q(u, 1, top)}' fill='none' stroke='#c4c4cc' stroke-width='1.6'/>`;
    }
    const fw = TRAM_FW * TRAM_PPM, fh = TRAM_FH * TRAM_PPM;
    const icon = {id: `tram-${key}`, width: fw, height: fh, anchorX: TRAM_CX * TRAM_PPM, anchorY: TRAM_CY * TRAM_PPM,
      url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='${fw}' height='${fh}' viewBox='0 0 ${fw} ${fh}'>` +
        `<defs>${GLASS}<clipPath id='c'><path d='${TRAM_BODY_PATH}'/></clipPath></defs>${out}</svg>`)};
    tramSprites.set(key, icon);
    return icon;
  }
  // Drawn in metres, so they grow with the map and shrink with distance, but larger than
  // life: 5x where they appear (a side-on car is ~40 px long at zoom 15), easing back to
  // life size by zoom 18.5, so they still grow on screen every zoom step. Any larger close
  // in and cars queued at a stop (about 33 m apart, 30 m long) overlap each other.
  const tramScale = (z) => Math.max(1, 5 * 0.63 ** (z - 15));
  const ICON_ZOOM = 15;           // dots below this zoom, streetcars above (crossfading over ±0.4)
  function posAtKm(p, km) {
    // On the trip's track; beyond either end, carried on straight (a car's ends overhang).
    const k0 = cumKm[p.i0], k1 = cumKm[p.i1 - 1];
    const on = (k) => {
      const [i, f] = findIn(cumKm, p.i0, p.i1 - 1, k);
      return [lerpAt(pos, i, f, 2, 0), lerpAt(pos, i, f, 2, 1)];
    };
    if ((km >= k0 && km <= k1) || k1 - k0 < 0.005) return on(Math.max(k0, Math.min(k1, km)));
    const e = km < k0 ? k0 : k1, ref = km < k0 ? Math.min(k1, k0 + 0.02) : Math.max(k0, k1 - 0.02);
    const a = on(e), b = on(ref), f = Math.abs(km - e) / Math.abs(e - ref);
    return [a[0] + (a[0] - b[0]) * f, a[1] + (a[1] - b[1]) * f];
  }
  // A direction on the ground (radians, 0 = right, anticlockwise) as it looks on screen, seen
  // from a camera tilted so that ground distances away from it shrink by c.
  const onScreen = (phi, c) => Math.atan2(Math.sin(phi) * c, Math.cos(phi));
  function tramParts(d, scale, bearing, cosPitch, cosTilt) {
    // The car's section ends along its track (centred on where it is); each section sits
    // between its two ends, drawn from the nearest of the sprite directions and turned on
    // screen by what's left over, so its sections line up along the track instead of
    // stepping like stairs.
    const km = cumKm[d.lo] + d.f * (cumKm[d.i] - cumKm[d.lo]);
    const at = (x) => {
      const q = posAtKm(d.p, km + (x - TRAM_MID) * TRAM_K * scale / 1000);
      return d.off ? [q[0] + d.off[0], q[1] + d.off[1]] : q;
    };
    const ends = [8, ...TRAM_JOINTS, 193].map(at);
    const secs = SECTIONS.map((s, si) => {
      const a = ends[si], b = ends[si + 1];
      const dx = (b[0] - a[0]) * KX, dy = (b[1] - a[1]) * KY;
      const sx = dx * Math.cos(bearing) - dy * Math.sin(bearing), sy = dx * Math.sin(bearing) + dy * Math.cos(bearing);
      const phi = Math.atan2(sy, sx);
      const dir = ((Math.round(phi / (2 * Math.PI) * TRAM_DIRS) % TRAM_DIRS) + TRAM_DIRS) % TRAM_DIRS;
      const turn = (onScreen(phi, cosPitch) - onScreen(dir / TRAM_DIRS * 2 * Math.PI, cosTilt)) * 180 / Math.PI;
      return {d, si, dir, turn: ((turn + 540) % 360) - 180, pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]};
    });
    return {d, path: ends, secs};
  }
  function tramLayers(hs, followed, mix) {
    if (!mix) return [];
    const scale = tramScale(map.getZoom()), bearing = map.getBearing() * Math.PI / 180, tilt = tramTilt();
    const cosPitch = Math.cos(map.getPitch() * Math.PI / 180), cosTilt = Math.cos(tilt * Math.PI / 180);
    const cars = hs.map((d) => tramParts(d, scale, bearing, cosPitch, cosTilt));
    const ring = followed.map((d) => tramParts(d, scale, bearing, cosPitch, cosTilt));
    // Nearer sections are drawn over farther ones (billboards take their anchor's depth).
    const secs = cars.flatMap((c) => c.secs);
    const halo = {getPath: (c) => c.path, widthUnits: "meters", capRounded: true, jointRounded: true,
      opacity: mix, parameters: {depthWriteEnabled: false}};
    // The tour dims every car but the one it's following (state.dim, 0..1).
    const fv = state.follow || state.focus, lit = (d) => (isLit(d) ? 1 : 1 - state.dim);
    const trig = {getColor: [state.color, state.dim, fv, state.extra.length]};
    const tint = (a) => ({getColor: (c) => [...headColor(c.d), a * lit(c.d)], updateTriggers: trig});
    return [
      new PathLayer({...halo, id: "tram-ring", data: ring, getColor: [255, 255, 255, 235], getWidth: TRAM_W * scale * 2.2}),
      new PathLayer({...halo, ...tint(60), id: "tram-halo", data: cars, getWidth: TRAM_W * scale * 2.8}),
      new PathLayer({...halo, ...tint(120), id: "tram-halo-core", data: cars, getWidth: TRAM_W * scale * 1.6}),
      new IconLayer({id: `tram-body-${tramGen}`, data: secs, getPosition: (s) => s.pos, getIcon: (s) => tramSprite(s.si, s.dir, tilt), getAngle: (s) => s.turn,
        getColor: (s) => [255, 255, 255, 255 * lit(s.d)], updateTriggers: trig,
        sizeUnits: "meters", getSize: TRAM_FH * scale, opacity: mix, pickable: true,
        onClick: ({object}) => object && follow(object.d.p.v)}),
    ];
  }

  // The followed car's own paths, drawn on top with a long bright trail.
  let followTrips = null;
  const followData = (v) => pack(byCar.get(v).map((p) => [p.i0, p.i1]));

  function shortLayers(hs) {
    if (state.hideShort) return [];  // the tour counts them instead
    // Ride along with the car: the marker sits over it (or where it turned, if it's gone).
    // The tour pins it where the turn was detected (state.pinShort): sped up, markers riding
    // along fly up and down the line.
    const marks = activeShort().map((e) => {
      const h = !state.pinShort && hs.find((d) => d.p.v === e.v);
      return {e, pos: h ? [h.lon, h.lat] : [e.lon, e.lat]};
    });
    return [
      new IconLayer({id: "short-turns", data: marks, getPosition: (m) => m.pos, getIcon: () => SHORT_ICON,
        getSize: 28, sizeUnits: "pixels", getPixelOffset: [0, -10]}),
      new TextLayer({id: "short-labels", data: marks, getPosition: (m) => m.pos, getText: () => "Short turn",
        getSize: 11.5, getColor: [255, 214, 90, 255], getPixelOffset: [0, -48], fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: 600, background: true, getBackgroundColor: [20, 21, 24, 210], backgroundPadding: [5, 2]}),
    ];
  }

  // The tour can add cars drawn at a moment of their own (state.extra: [{p, t, off}], a trip,
  // a time and an optional [lon, lat] shift), e.g. two passes of the same corner run side by
  // side, one moved over a lane so they don't draw on top of each other; while it dims the rest
  // (state.dim), the focus car and those stay lit.
  const isLit = (d) => !state.dim || d.extra || d.p.v === (state.follow || state.focus);
  function draw() {
    const hs = heads(state.t);
    for (const x of state.extra) {
      const a = at(x.p, x.t);
      // That trip drawn at its own moment instead of the main clock's (never twice).
      const k = hs.findIndex((d) => d.p === x.p);
      if (k >= 0) hs.splice(k, 1);
      const o = x.off || [0, 0];
      if (a) hs.push({p: x.p, lon: a[0] + o[0], lat: a[1] + o[1], lo: a[2], i: a[3], f: a[4], extra: true, off: x.off});
    }
    const fv = state.follow || state.focus;
    const followed = fv ? heads(state.t, byCar.get(fv)) : [];
    const dimOf = (d) => (isLit(d) ? 1 : 1 - state.dim);
    const mix = Math.max(0, Math.min(1, (map.getZoom() - ICON_ZOOM + 0.4) / 0.8));  // 0 dots .. 1 streetcars
    const dots = 1 - mix;
    const trails = [];
    for (let hr = Math.floor((state.t - TRAIL_S) / CHUNK_S); hr <= Math.floor(state.t / CHUNK_S); hr++) {
      if (!chunks[hr]) continue;
      trails.push(new TripsLayer({
        id: `trails-${hr}-${state.color}`, data: chunks[hr][state.color], _pathType: "open",
        currentTime: state.t, trailLength: TRAIL_S, fadeTrail: true,
        widthUnits: "pixels", getWidth: 3, widthMinPixels: 2, capRounded: true, jointRounded: true,
        opacity: (fv ? 0.4 : 0.9) * (1 - (state.dim || 0)),
      }));
    }
    overlay.setProps({layers: [
      ...trails,
      followTrips && new TripsLayer({
        id: `followed-trail-${fv}`, data: followTrips[state.color], _pathType: "open",
        currentTime: state.t, trailLength: 2400, fadeTrail: true,
        widthUnits: "pixels", getWidth: 5, capRounded: true, jointRounded: true,
      }),
      new ScatterplotLayer({
        id: "glow", data: hs, getPosition: (d) => [d.lon, d.lat], opacity: dots, visible: dots > 0,
        getFillColor: (d) => [...headColor(d), 70 * dimOf(d)], radiusUnits: "pixels", getRadius: 9,
        updateTriggers: {getFillColor: [state.color, state.dim, fv, state.extra.length]},
      }),
      new ScatterplotLayer({
        id: "heads", data: hs, pickable: true, getPosition: (d) => [d.lon, d.lat], opacity: dots, visible: dots > 0,
        getFillColor: (d) => [...headColor(d), 255 * dimOf(d)], radiusUnits: "pixels", getRadius: 3.5,
        stroked: true, getLineColor: (d) => [255, 255, 255, 200 * dimOf(d)], lineWidthUnits: "pixels", getLineWidth: 0.8,
        updateTriggers: {getFillColor: [state.color, state.dim, fv, state.extra.length], getLineColor: [state.dim, fv, state.extra.length]},
        onClick: ({object}) => object && follow(object.p.v),
      }),
      new ScatterplotLayer({
        id: "followed", data: followed, getPosition: (d) => [d.lon, d.lat], opacity: dots, visible: dots > 0,
        filled: false, stroked: true, getLineColor: [255, 255, 255, 255],
        lineWidthUnits: "pixels", getLineWidth: 2, radiusUnits: "pixels", getRadius: 13,
      }),
      ...tramLayers(hs, followed, mix),
      ...raceLayers(),
      ...shortLayers(hs),
      ...(tour.layers ? tour.layers() : []),
    ]});
    if (shortEv.length) {
      const n = shortEv.filter((e) => e.t <= state.t && routeOn(e.r)).length;
      $("st-count").hidden = false;
      $("st-count").innerHTML = `<span class="st-ico" aria-hidden="true">⚠</span> ${n} short turn${n === 1 ? "" : "s"} so far` +
        `${state.routes.size ? " on these routes" : ""}`;
    }
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
      map.easeTo({center: [a[0], a[1]], zoom: Math.max(map.getZoom(), 16), pitch: 55, duration: 900});
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
      const st = activeShort(v)[0];
      if (st) {
        $("f-now").innerHTML = `<span class="st-now"><span class="st-ico" aria-hidden="true">⚠</span> Short-turned after ${st.name}</span>` +
          `<span class="st-sub">Due to go on to ${st.to}; sent back ${st.d === "East" ? "west" : st.d === "West" ? "east" : st.d === "North" ? "south" : "north"} instead.</span>`;
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
    // Not while zooming: moving the camera would stop the zoom.
    else if (d && !dragging && !easing && !map.isZooming()) map.jumpTo({center: [d.lon, d.lat]});
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
    if (dragging || easing || map.isZooming()) return;
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
  map.on("zoom", () => { if (!state.playing) draw(); });  // dots <-> streetcars while paused
  // What the tour needs from the page (tour.js).
  window.replayTour = {
    tour, state, data, paths, byCar, pos, ts, gclk, kmh, cumKm, tMin, tMax, shortEv, map, wide,
    at, heads, findIn, lerpAt, project, clockText, dur, routeName, routeColor, GHOST_ICON,
    deck: {ScatterplotLayer, IconLayer, PathLayer, TextLayer},
    draw, writeHash, setPlaying, setSpeed, follow,
    setFocus(v) { state.focus = v; if (!state.follow) followTrips = v ? followData(v) : null; },
    setRoutes(rs) { state.routes = new Set(rs); renderRoutes(); buildChunks(); },
  };
  window.dispatchEvent(new Event("replay-ready"));
  let lastFrame = performance.now(), lastHash = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (tour.tick) {
      tour.tick(dt);
      draw();
    } else if (state.playing) {
      state.t += dt * state.speed;
      if (state.t > tMax) state.t = tMin;  // loop the day
      draw();
      if (now - lastHash > 2000) { writeHash(); lastHash = now; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
