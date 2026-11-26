// Tour: yesterday in about 30 seconds, played on the replay (replay.html#tour=1).
// The whole day with the delay map rising, then someone walking beside a streetcar
// (stories.json "walk", see walk.py), then a beat per story from the bot's picks
// (data/drafts/stories.json, see drafts.py story_of): the camera flies to the spot and the
// replay shows a car that went straight through beside one that got stuck there that day.
// Ends on the story card. Skip is always there; a tap pauses.
(function () {
  const begin = () => setup(window.replayTour);
  if (window.replayTour) begin(); else window.addEventListener("replay-ready", begin, {once: true});

  // Captions: short, numbers exactly as on the site, never a dig at the TTC or its staff.
  // Each beat has a few variants, [setup, payoff]; the day picks one (so everyone sees the
  // same words that day, and they change day to day), and "Watch again" moves on a step.
  // {when} {day} {lost} {place} {placeLc} {detail} {detailLc} {route} {car} (the stuck car)
  // {gap} (how far apart in the day the two trips at a spot were). Lines about two cars are
  // only used when the beat has two (pickTwo).
  const CAPTIONS = {
    open: [
      ["{when}. Every streetcar, all day.", "{lost} hours lost to delays."],
      ["Every streetcar on {day}, from the TTC's live positions.", "Together they lost {lost} hours to delays."],
    ],
    signal: [
      ["Held at a signal: {place}", "{detail}."],
      ["Same corner, two trips {gap} apart.", "{detail}."],
      ["Two streetcars, {placeLc}.", "Not a one-off: {detailLc}."],
      ["Watch the clock: {placeLc}.", "{detail}."],
    ],
    segment: [
      ["The day's slowest stretch: {place}", "{detail}."],
      ["Same stretch, two trips {gap} apart.", "{detail}."],
    ],
    // {gap}: the longest gap between the route's cars at a stop in the beat's hours; {typ}:
    // the middle stop's. The columns aren't self-explanatory, so the payoff says what they are.
    shortturn: [
      ["{place}: {detailLc}.", "Each column: the longest gap between streetcars at a stop. Up to {gap} min past the turns."],
      ["Each ⚠ is a streetcar turned back before its last stop.", "Past the turns, gaps between cars stretch to {gap} min, against {typ} on most of the line."],
      ["{place}. Not every trip reaches the end.", "The columns: the longest gap between cars at each stop. {gap} min past the turns, {typ} elsewhere."],
      ["{place}, where the end of the line moves.", "Where cars turn back early, the next one is a long way off: gaps of up to {gap} min."],
    ],
    close: [["Now pick a car and ride along."], ["Your turn: tap any streetcar."], ["Every car's day is here. Pick one."]],
    // The walking beat: {street} {a} {b} {route} {m} (metres) {kmh} {walk} {ride} (m:ss)
    // {n} of {of} (streetcars there slower than walking, of all that way that day).
    // Say walking, never "race": it reads as running, and the point is an easy pace (the
    // walker's label carries the pace whichever line the day gets).
    walk: [
      ["{street}, {a} to {b}: walk it, or ride the {route}?", "Walking won. {n} of {of} streetcars here were slower."],
      ["Strolling {a} to {b}, beside a {route}.", "On foot: {walk}. By streetcar: {ride}."],
      ["{m} m along {street}, walked at an easy {kmh} km/h.", "Faster than {n} of {of} streetcars that way on {day}."],
    ],
    // The walking beat's last step, the network pulled back: {trips} (daytime trips with a
    // stretch of 1 km or more slower than walking) of {all} (daytime trips measured), on
    // {routes} routes.
    walkNet: [
      ["Not just {street}.", "{trips} trips on {day} had a stretch slower than walking."],
      ["Across the network on {day}:", "{trips} of {all} daytime trips were slower than walking somewhere."],
      ["Walking won on {routes} routes that day.", "{trips} trips had a stretch where walking was quicker."],
    ],
  };
  const KINDS = Object.keys(CAPTIONS);
  const SHORT_NO_GAPS = ["{place}: trips sent back early", "{detail}."];  // no network file: no columns to explain
  let round = 0;  // times watched on this visit
  const pick = (kind, day) => {
    const list = CAPTIONS[kind], n = Math.floor(Date.parse(day) / 864e5) + round + KINDS.indexOf(kind);
    return list[((n % list.length) + list.length) % list.length];
  };
  const lc = (x) => (x ? x[0].toLowerCase() + x.slice(1) : "");
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

  // The walker, side on, in the Flexity's flat style: a November coat (mustard, so it shows on
  // the dark map), a red toque, a pale outline. Frames 0-3 are a stride, 4 is standing;
  // `left` mirrors it for walking leftward on screen. Drawn much bigger than life, like the
  // cars: a person to scale would be a couple of pixels.
  const WALK_POSE = [[24, -22, -24], [8, -6, -8], [-22, 24, 22], [-6, 8, 6], [3, -3, 4]];  // front leg, back leg, front arm (degrees)
  const walkerIcons = new Map();
  function walkerIcon(frame, left) {
    const id = `walker-${frame}${left ? "l" : "r"}`;
    if (walkerIcons.has(id)) return walkerIcons.get(id);
    const [fl, bl, fa] = WALK_POSE[frame], rad = Math.PI / 180;
    const limb = (x, y, len, deg) => [x + len * Math.sin(deg * rad), y + len * Math.cos(deg * rad)];
    const line = ([x0, y0], [x1, y1], c, wd) => `<path d='M${x0} ${y0}L${x1.toFixed(1)} ${y1.toFixed(1)}' stroke='${c}' stroke-width='${wd}' stroke-linecap='round'/>`;
    const hip = [20, 41], sh = [20, 24];
    const legs = (deg, c, more = 0) => line(hip, limb(...hip, 20, deg), c, 5.2 + more);
    const arm = (deg, c, more = 0) => line(sh, limb(...sh, 14, deg), c, 4.4 + more);
    const figure = (o) =>   // o: outline pass (thicker, pale) or the figure itself
      (o ? [legs(bl, o, 3), legs(fl, o, 3), arm(-fa, o, 3), arm(fa, o, 3)].join("") +
        `<rect x='13' y='19' width='14' height='26' rx='6' fill='${o}' stroke='${o}' stroke-width='3'/><circle cx='21' cy='12' r='7.4' fill='${o}'/>`
        : legs(bl, "#2b2f3a") + arm(-fa, "#a87a14") + "<rect x='13' y='19' width='14' height='26' rx='6' fill='#f0b429'/>" +
          legs(fl, "#3a4050") + arm(fa, "#d9a01f") +
          "<circle cx='21' cy='12' r='5.6' fill='#e8b48c'/><path d='M15.2 11.2Q15.6 4.6 21 4.4Q26.4 4.6 26.8 11.2Z' fill='#d8433a'/>" +
          "<rect x='14.6' y='10' width='12.8' height='2.6' rx='1.3' fill='#f2f2f2'/>");
    const body = figure("rgba(255,255,255,0.85)") + figure(null);
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='68' viewBox='0 0 40 68'>` +
      `<g${left ? " transform='translate(40 0) scale(-1 1)'" : ""}>${body}</g></svg>`;
    const icon = {id, url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg), width: 40, height: 68, anchorY: 63};
    walkerIcons.set(id, icon);
    return icon;
  }

  async function setup(R) {
    let stories = null;
    try { stories = await (await fetch("data/drafts/stories.json", {cache: "no-cache"})).json(); } catch { /* none */ }
    if (!stories || stories.day !== R.data.day || !stories.items?.length) return;
    // The delay map's figures for the day, for the peaks (optional: the tour runs without).
    let peaks = null, net = null;
    try {
      const get = async (f) => (await fetch(`data/${f}`, {cache: "no-cache"})).json();
      const [n, stats] = await Promise.all([get("network.json"), get("stats-d1.json")]);
      net = n;
      peaks = buildPeaks(R, net, stats);
    } catch (e) { console.warn("tour: no peaks", e); }
    // Where the day's trips were slower than walking (walk.py via drafts.py), for the walking
    // beat's last step; without it the step still counts them.
    if (stories.walk?.net) {
      try {
        const j = await (await fetch("data/drafts/walk-lines.json", {cache: "no-cache"})).json();
        if (j.day === stories.day) stories.walk.lines = j.lines;
      } catch { /* none */ }
    }
    const btn = document.getElementById("tour-btn");
    btn.hidden = false;
    btn.addEventListener("click", () => play(R, stories, peaks, net));
    if (R.tour.active) play(R, stories, peaks, net);
  }

  // --- peaks: the delay map, built up over the day --------------------------------------
  // Each 25 m slice's time lost that day, as on the delay map (yesterday's view: seconds
  // lost per 100 m per pass x passes; summed over the network that's the headline's hours).
  // When it was lost comes from the replay: every stretch where a car fell behind the ghost
  // is put on the nearest slice of track running the same way, in half-hour steps. A
  // slice's column grows on that timing and ends on its delay-map total.
  const PEAK_STEP = 1800, PEAK_NEAR_M = 30, CELL_M = 50, MX = 80660, MY = 110540;
  function buildPeaks(R, net, stats) {
    const {paths, pos, ts, gclk} = R, BIN = net.bin_m;
    const sl = [];
    for (const p of net.pieces) {
      const st = stats.pieces[p.id];
      if (!st) continue;
      const {d, n} = st.slots.all, L = p.bins.length;
      for (let b = 0; b < L; b++) {
        const total = d[b] && n[b] ? d[b] * BIN / 100 * n[b] : 0;
        if (total < 1) continue;
        const q = p.bins[Math.min(b + 1, L - 1)], o = p.bins[Math.max(b - 1, 0)];
        sl.push({pos: p.bins[b], dx: (q[0] - o[0]) * MX, dy: (q[1] - o[1]) * MY, total, cum: null});
      }
    }
    const grid = new Map();
    sl.forEach((x, i) => {
      const k = Math.floor(x.pos[0] * MX / CELL_M) * 1e6 + Math.floor(x.pos[1] * MY / CELL_M);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    const NB = Math.ceil((R.tMax + 1) / PEAK_STEP) + 1, hist = new Map();
    for (const p of paths) {
      if (!p.ghost) continue;
      let ddx = 0, ddy = 0;
      for (let k = p.i0 + 1; k < p.i1; k++) {
        const lon = pos[2 * k - 2], lat = pos[2 * k - 1];
        const mx = (pos[2 * k] - lon) * MX, my = (pos[2 * k + 1] - lat) * MY;
        if (Math.hypot(mx, my) > 2) { ddx = mx; ddy = my; }
        const inc = (ts[k] - ts[k - 1]) - (gclk[k] - gclk[k - 1]);
        if (inc <= 0 || (!ddx && !ddy)) continue;
        const cx = Math.floor(lon * MX / CELL_M), cy = Math.floor(lat * MY / CELL_M);
        let best = -1, bd = PEAK_NEAR_M;
        for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const i of grid.get(gx * 1e6 + gy) || []) {
            const x = sl[i];
            if (x.dx * ddx + x.dy * ddy <= 0) continue;  // track running the other way
            const dist = Math.hypot((x.pos[0] - lon) * MX, (x.pos[1] - lat) * MY);
            if (dist < bd) { bd = dist; best = i; }
          }
        }
        if (best < 0) continue;
        const h = hist.get(best) || hist.set(best, new Float32Array(NB)).get(best);
        h[Math.min(NB - 1, Math.max(0, Math.floor(ts[k - 1] / PEAK_STEP)))] += inc;
      }
    }
    // Cumulative shares per slice (slices the replay never matched take the network's shape).
    const all = new Float64Array(NB);
    for (const h of hist.values()) for (let j = 0; j < NB; j++) all[j] += h[j];
    const share = (h) => {
      const c = new Float32Array(NB + 1);
      for (let j = 0; j < NB; j++) c[j + 1] = c[j] + h[j];
      const z = c[NB] || 1;
      for (let j = 0; j <= NB; j++) c[j] /= z;
      return c;
    };
    const net0 = share(all);
    sl.forEach((x, i) => { x.cum = hist.has(i) ? share(hist.get(i)) : net0; });
    const frac = (c, t) => {
      const u = Math.max(0, Math.min(NB, t / PEAK_STEP)), j = Math.min(NB - 1, Math.floor(u));
      return c[j] + (c[j + 1] - c[j]) * (u - j);
    };
    const sum = sl.reduce((a, x) => a + x.total, 0);
    return {
      slices: sl, frac, matched: hist.size,
      // Share of the network's day total lost by time t.
      lostShare: (t) => sl.reduce((a, x) => a + x.total * frac(x.cum, t), 0) / sum,
      // Slices within m metres of c, on track running the way [dx, dy] points (if given).
      near: (c, m, dir) => sl.filter((x) => Math.hypot((x.pos[0] - c[0]) * MX, (x.pos[1] - c[1]) * MY) < m &&
        (!dir || x.dx * dir[0] * MX + x.dy * dir[1] * MY > 0)),
    };
  }
  // The columns: height is time lost so far (the `rank`th tallest reaching `top` metres),
  // colour by the day's total there, yellow to red.
  function peaksLayer(P, list, t, top, opacity = 1, id = "tour-peaks", rank = 5) {
    if (!list.ref) list.ref = list.map((x) => x.total).sort((a, b) => b - a)[Math.min(list.length - 1, rank)] || 1;
    const ref = list.ref;
    return new deck.ColumnLayer({
      id, data: list, getPosition: (x) => x.pos, diskResolution: 6, radius: top / 60,
      extruded: true, opacity, material: false,
      getFillColor: (x) => {
        const f = Math.min(1, x.total / ref);
        return [255, Math.round(215 - 175 * f), Math.round(90 - 60 * f), 235];
      },
      getElevation: (x) => x.total * P.frac(x.cum, t) / ref * top,
      updateTriggers: {getElevation: Math.round(t / 60)},
    });
  }

  // --- gaps at stops (the short-turn beat) ----------------------------------------------
  // Every stop on the route's observed patterns, with the times the route's cars passed it
  // (within GAP_M, going the stop's way). The beat draws the longest gap between streetcars so
  // far at each: it only grows, so it doesn't flicker at tour speed, and it grows tallest past
  // the spots where cars are sent back.
  const GAP_M = 25;
  function stopGaps(R, net, route) {
    const {paths, pos, ts} = R, stops = new Map();
    for (const pat of net.patterns) {
      if (pat.route !== route) continue;
      const on = new Set(pat.slices.map(([pi, b]) => `${pi}:${b}`));
      net.pieces.forEach((p, pi) => {
        for (const s of p.stops) {
          const b = Math.min(p.bins.length - 1, Math.floor(s.along / net.bin_m));
          if (!on.has(`${pi}:${b}`) || stops.has(s.id)) continue;
          const lo = p.bins[Math.max(0, b - 1)], hi = p.bins[Math.min(p.bins.length - 1, b + 1)];
          stops.set(s.id, {id: s.id, name: s.name, pos: s.lonlat, dir: [(hi[0] - lo[0]) * MX, (hi[1] - lo[1]) * MY], t: []});
        }
      });
    }
    const list = [...stops.values()];
    const pad = GAP_M / MY * 1.5;
    for (const p of paths) {
      if (p.r !== route) continue;
      for (let i = p.i0; i < p.i1 - 1; i++) {
        const ax = pos[2 * i], ay = pos[2 * i + 1], bx = pos[2 * i + 2], by = pos[2 * i + 3];
        const dx = (bx - ax) * MX, dy = (by - ay) * MY, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        for (const s of list) {
          const [sx, sy] = s.pos;
          if (sx < Math.min(ax, bx) - pad * 1.4 || sx > Math.max(ax, bx) + pad * 1.4 ||
              sy < Math.min(ay, by) - pad || sy > Math.max(ay, by) + pad) continue;
          if (dx * s.dir[0] + dy * s.dir[1] <= 0) continue;
          const f = Math.max(0, Math.min(1, ((sx - ax) * MX * dx + (sy - ay) * MY * dy) / L2));
          if (Math.hypot((ax - sx) * MX + f * dx, (ay - sy) * MY + f * dy) > GAP_M) continue;
          s.t.push(ts[i] + f * (ts[i + 1] - ts[i]));
        }
      }
    }
    for (const s of list) s.t.sort((a, b) => a - b);
    return list;
  }
  // Longest gap at a stop between t0 and t (a gap still open at t counts up to t).
  function longestGap(times, t0, t) {
    let last = t0, best = 0;
    for (const x of times) {
      if (x <= t0) continue;
      if (x > t) break;
      best = Math.max(best, x - last);
      last = x;
    }
    return Math.max(best, t - last);
  }

  // --- finding the moment ---------------------------------------------------------------
  const DAY_FROM = 6 * 3600 - 4 * 3600, DAY_TO = 22 * 3600 - 4 * 3600;  // 06:00-22:00 (t counts from 04:00)
  const SPOT_M = 150, NEAR_M = 40, MAX_LOST = 900;
  // Every daytime pass through the spot (or along the stretch): [p, a, b] vertex range and
  // the time it lost against the ghost over that range. The tour shows the pass at the 90th
  // percentile: a bad but ordinary day there, not a one-off breakdown.
  // allDay: every pass, any hour, its loss clamped to 0..MAX_LOST (for the day's tally).
  function passes(R, at, allDay = false) {
    const {paths, ts, gclk, cumKm, project, pos} = R, out = [];
    const keep = (p, a, b, minKm) => {
      const lost = (ts[b] - ts[a]) - (gclk[b] - gclk[a]);
      if (cumKm[b] - cumKm[a] <= minKm) return;
      // Only the story's way through (at.dir, the signal approach's direction): a circle
      // round a junction also catches cars going the other way.
      if (at.dir && (pos[2 * b] - pos[2 * a]) * at.dir[0] * MX ** 2 + (pos[2 * b + 1] - pos[2 * a + 1]) * at.dir[1] * MY ** 2 <= 0) return;
      if (allDay) out.push({p, a, b, t: ts[b], lost: Math.max(0, Math.min(MAX_LOST, lost))});
      else if (ts[a] >= DAY_FROM && ts[b] <= DAY_TO && lost > 0 && lost < MAX_LOST) out.push({p, a, b, lost});
    };
    for (const p of paths) {
      if (!p.ghost || (!allDay && (p.t1 < DAY_FROM || p.t0 > DAY_TO))) continue;
      if (at.spot) {
        // In at one side of the circle round the spot, out the other.
        let a = null;
        for (let i = p.i0; i < p.i1 - 1; i++) {
          const inside = project(i, at.spot)[0] < SPOT_M;
          if (inside && a === null) a = i;
          else if (!inside && a !== null) { keep(p, a, i, 0.18); a = null; }
        }
      } else {
        // The last vertex by the stretch's start, then the first by its end.
        const len = Math.hypot((at.to[0] - at.from[0]) * 80660, (at.to[1] - at.from[1]) * 110540) / 1000;
        let a = null;
        for (let i = p.i0; i < p.i1 - 1; i++) {
          if (project(i, at.from)[0] < NEAR_M) { a = i; continue; }
          if (a === null) continue;
          if (cumKm[i] - cumKm[a] > 1.5 * len + 0.2) { a = null; continue; }  // went another way
          if (project(i, at.to)[0] < NEAR_M) { keep(p, a, i + 1, 0.5 * len); a = null; }
        }
      }
    }
    return out;
  }
  function moment(R, at) {
    const all = passes(R, at).sort((x, y) => x.lost - y.lost);
    if (all.length < 5) return null;
    const m = all[Math.floor(all.length * 0.9)], {ts, cumKm} = R;
    // Its longest stand: the biggest time step with the car (nearly) not moving.
    let hold = null;
    for (let i = m.a + 1; i <= m.b; i++) {
      const dt = ts[i] - ts[i - 1];
      if (cumKm[i] - cumKm[i - 1] < 0.004 && dt > 20 && (!hold || dt > hold[1] - hold[0])) hold = [ts[i - 1], ts[i]];
    }
    // The whole day there, in time order, for the sweep's tally.
    const day = passes(R, at, true).sort((x, y) => x.t - y.t);
    // The car to set it against: the quickest pass through the same spot, the same way, over
    // about the same distance (not a pass clipped by a gap in the feed), as close in time as
    // gives a real contrast (well under the stuck car's time): within an hour, else three.
    const {pos} = R, dir = (q) => [pos[2 * q.b] - pos[2 * q.a], pos[2 * q.b + 1] - pos[2 * q.a + 1]];
    const [hx, hy] = dir(m), km = cumKm[m.b] - cumKm[m.a];
    let quick = null;
    for (const within of [3600, 3 * 3600]) {
      for (const q of day) {
        const [qx, qy] = dir(q), qkm = cumKm[q.b] - cumKm[q.a];
        if (q.p === m.p || qx * hx + qy * hy <= 0 || Math.abs(ts[q.a] - ts[m.a]) > within ||
            ts[q.a] < DAY_FROM || Math.abs(qkm - km) > 0.3 * km) continue;
        if (!quick || ts[q.b] - ts[q.a] < ts[quick.b] - ts[quick.a]) quick = q;
      }
      if (quick && ts[quick.b] - ts[quick.a] <= 0.6 * (ts[m.b] - ts[m.a])) break;
      quick = null;
    }
    return {...m, tA: ts[m.a], tB: ts[m.b], hold, n: all.length, day,
      quick: quick && {...quick, tA: ts[quick.a], tB: ts[quick.b]}};
  }

  // --- the tour -------------------------------------------------------------------------
  function play(R, stories, peaks, net) {
    const {state, map, ts, gclk, pos, findIn, lerpAt} = R;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const $ = (id) => document.getElementById(id);
    const vars = {when: stories.when, day: stories.when.split(",")[0],
      lost: stories.lost_h ? stories.lost_h.toLocaleString("en-CA") : ""};
    const capsFor = (kind) => pick(kind, stories.day);
    const openCap = stories.lost_h ? capsFor("open") : ["{when}. Every streetcar, all day.", stories.headline];
    const closeCap = capsFor("close");
    round++;
    const home = {center: R.wide ? [-79.40, 43.660] : [-79.40, 43.655], zoom: R.wide ? 12.3 : 11.2, pitch: 45, bearing: -17};
    const ease = (f) => f * f * (3 - 2 * f), easeIn = (f) => f * f * f, easeOut = (f) => 1 - (1 - f) ** 3;
    const lerp = (a, b, f) => a + (b - a) * f;
    const move = (opts, ms) => (reduced ? map.jumpTo(opts) : map.flyTo({...opts, duration: ms, essential: true}));

    // The walking beat (stories.walk, from walk.py) takes the slowest stretch's place: someone
    // on foot beating a streetcar says "delay" without needing minutes explained. Without it
    // (no pick that day, or its trip not in the replay), the slowest stretch is back in.
    const walkB = stories.walk ? walkBeat(stories.walk) : null;
    // Spot beats, most time lost first; at most two, with the short turns between them.
    // Not the stop-wait story: its number is riders' waiting time, and a car standing at a
    // stop doesn't show that.
    const spots = [], kinds = walkB ? ["signal"] : ["signal", "segment"];
    for (const s of stories.items) {
      if (!kinds.includes(s.kind) || !s.at) continue;
      const m = moment(R, s.at);
      if (m) spots.push({s, m});
    }
    // Longest stand first; a story at the same corner as one already in (the slowest stretch
    // often ends at the most-held signal) is left out, so each beat is somewhere new.
    const holdOf = (x) => (x.m.hold ? x.m.hold[1] - x.m.hold[0] : 0);
    const centre = (s) => s.at.spot || [(s.at.from[0] + s.at.to[0]) / 2, (s.at.from[1] + s.at.to[1]) / 2];
    spots.sort((x, y) => holdOf(y) - holdOf(x));
    for (let i = spots.length - 1; i > 0; i--) {
      const [a0, a1] = centre(spots[i].s);
      if (spots.slice(0, i).some(({s}) => { const [b0, b1] = centre(s); return Math.hypot((a0 - b0) * 80660, (a1 - b1) * 110540) < 400; }))
        spots.splice(i, 1);
    }
    const st = stories.items.find((s) => s.kind === "shortturn" && s.at?.route &&
      R.shortEv.filter((e) => e.r === s.at.route).length >= 3);
    const beats = [openBeat()];
    // Walking first (the plainest picture of delay), then short turns, then the signal.
    const mids = spots.slice(0, (st ? 2 : 3) - (walkB ? 1 : 0)).map(spotBeat);
    if (walkB) mids.unshift(walkB);
    if (st) mids.splice(1, 0, shortBeat(st));
    beats.push(...mids, closeBeat());

    // UI (the map's credits fold into their (i) button, clear of the captions)
    document.body.classList.add("touring");
    document.querySelectorAll(".maplibregl-ctrl-attrib").forEach((e) => e.classList.remove("maplibregl-compact-show"));
    R.follow(null);
    R.setPlaying(true);
    const ui = $("tour"), cap = $("tour-cap"), hud = $("tour-hud"), prog = $("tour-prog");
    ui.hidden = false;
    $("tour-end").hidden = true;
    prog.innerHTML = beats.map(() => "<span><i></i></span>").join("");
    const bars = [...prog.querySelectorAll("i")];
    let bi = -1, bt = 0, paused = false, lastCap = "";
    const caption = (text, sub = "") => {
      const html = `<b>${esc(text)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}`;
      if (html !== lastCap) { cap.innerHTML = html; lastCap = html; }
    };
    const showHud = (html) => { hud.hidden = !html; if (html) hud.innerHTML = html; };
    function next() {
      if (bi >= 0 && beats[bi].leave) beats[bi].leave();
      bi++;
      bt = 0;
      if (bi >= beats.length) return finish();
      showHud("");
      beats[bi].enter();
    }
    R.tour.tick = (dt) => {
      if (paused) return;
      bt += dt;
      const b = beats[bi];
      bars.forEach((el, i) => { el.style.width = i < bi ? "100%" : i > bi ? "0" : `${Math.min(100, bt / b.dur * 100)}%`; });
      b.tick(Math.min(1, bt / b.dur), bt, dt);
      if (bt >= b.dur) next();
    };
    const shield = $("tour-shield");
    const togglePause = () => {
      paused = !paused;
      R.tour.paused = paused;  // replay.js lets the screen sleep while the tour is paused
      ui.classList.toggle("paused", paused);
    };
    shield.onclick = togglePause;
    $("tour-skip").onclick = () => finish();
    const onKey = (e) => {
      if (e.key === "Escape") finish();
      if (e.key === " " && R.tour.tick) { e.preventDefault(); e.stopImmediatePropagation(); togglePause(); }
    };
    document.addEventListener("keydown", onKey, true);
    next();

    function finish() {
      if (bi >= 0 && bi < beats.length && beats[bi].leave) beats[bi].leave();
      bi = beats.length;
      R.tour.tick = null;
      R.tour.layers = null;
      R.tour.active = false;
      R.tour.paused = false;
      R.setFocus(null);
      R.setRoutes([]);
      state.dim = 0;
      state.extra = [];
      state.hideShort = false;
      state.pinShort = false;
      document.removeEventListener("keydown", onKey, true);
      ui.hidden = true;
      document.body.classList.remove("touring");
      state.speed = 600;
      R.setSpeed(600);
      R.setPlaying(true);
      map.stop();
      move(home, 1200);
      endCard(R, stories, () => play(R, stories, peaks, net));
      R.writeHash();
    }

    // The whole day sped through: the trails fade back and the delay map rises out of the
    // streets, slice by slice, as the time is lost; a counter adds it up. Both end on the
    // site's figures (the peaks on the delay map's, the counter on stories.lost_h).
    function openBeat() {
      const t0 = R.tMin, t1 = R.tMax, grow = 6, dur = grow + 2, STEP = 60;
      // Without the peaks' data, the counter's shape comes from each trip's time lost.
      const curve = new Float64Array(Math.ceil((t1 - t0) / STEP) + 2);
      if (!peaks) {
        for (const p of R.paths) {
          if (!p.ghost || p.t1 <= p.t0) continue;
          const lost = Math.max(0, (p.t1 - p.t0) - (gclk[p.i1 - 1] - gclk[p.i0]));
          const k0 = Math.floor((p.t0 - t0) / STEP), k1 = Math.floor((p.t1 - t0) / STEP);
          for (let k = k0; k <= k1; k++) curve[k + 1] += lost / (k1 - k0 + 1);
        }
        for (let k = 1; k < curve.length; k++) curve[k] += curve[k - 1];
      }
      const lostBy = (t) => {
        if (peaks) return stories.lost_h * peaks.lostShare(t);
        const x = Math.max(0, Math.min(curve.length - 1.001, (t - t0) / STEP)), k = Math.floor(x);
        return stories.lost_h * lerp(curve[k], curve[k + 1], x - k) / (curve[curve.length - 1] || 1);
      };
      return {
        dur,
        enter() {
          map.stop(); map.jumpTo(home); R.setFocus(null);
          state.dim = peaks ? 0.7 : 0;
          state.hideShort = true;  // dozens of warning signs at once: a count instead
          R.tour.layers = peaks ? () => [peaksLayer(peaks, peaks.slices, state.t, 1400)] : null;
        },
        tick(f, sec) {
          const g = Math.min(1, sec / grow);
          state.t = lerp(t0, t1, g);
          state.speed = sec < grow ? (t1 - t0) / grow : 0;
          // The total comes in only once the counter has got there.
          caption(fill(openCap[g < 1 ? 0 : 1], vars));
          showHud(!stories.lost_h ? "" :
            `<div class="th-big">${Math.round(g >= 1 ? stories.lost_h : lostBy(state.t)).toLocaleString("en-CA")} hours</div>` +
            `<div class="th-row"><span>lost to delays by ${esc(R.clockText(state.t))}</span></div>` +
            (R.shortEv.length ? `<div class="th-row"><span>⚠ Trips sent back early</span><b>${R.shortEv.filter((e) => e.t <= state.t).length}</b></div>` : ""));
        },
        leave() { R.tour.layers = null; state.hideShort = false; },
      };
    }

    // Two real cars at the story's spot, the same day, run side by side: each starts the
    // moment it reached the spot, so they roll up together; the quick one goes straight
    // through and on, the stuck one (the 90th-percentile pass) stops, its wait felt in real
    // time and then sped through. Each car carries its own label and time. No clean-run
    // baseline on screen: the quick car is the comparison, and the sweep after shows how
    // often it happened.
    function spotBeat({s, m}) {
      const q = m.quick;
      const apart = q ? Math.round(Math.abs(q.tA - m.tA) / 60) : 0;
      const v = {...vars, place: s.place, placeLc: lc(s.place), detail: s.detail, detailLc: lc(s.detail), car: m.p.v,
        gap: apart < 60 ? `${apart} minutes` : `${Math.floor(apart / 60)} h ${apart % 60} min`};
      let [c0, c1] = capsFor(s.kind);
      if (!q && /two/i.test(c0)) [c0, c1] = CAPTIONS[s.kind][0];  // one car: no "two" lines
      const lead = 15, hasHold = m.hold && m.hold[1] - m.hold[0] >= 25;
      const h0 = hasHold ? m.hold[0] : (m.tA + m.tB) / 2, h1 = hasHold ? m.hold[1] : h0;
      // Phases, real seconds: fly, both roll up (the quick one through and away), the stuck
      // one's wait in real time, sped through, pay off, and (when the site gives a day total
      // for the spot) a sweep through the whole day there.
      const day = m.day, sweep = s.at.total_h && day.length >= 5;
      const P = [1.3, ...(hasHold ? [3.0, 2.0, 1.5, 1.8] : [3.5, 0, 0, 1.5]), sweep ? 3.0 : 0];
      const ends = P.reduce((acc, d) => [...acc, (acc.at(-1) || 0) + d], []);
      const dur = ends.at(-1);
      // The sweep's tally: the cars through, and their time lost, in the replay's own measure,
      // scaled so it lands on the site's figures for the day (cars, total_h).
      const cum = [0];
      for (const d of day) cum.push(cum.at(-1) + d.lost);
      const s0 = sweep ? day[0].t - 300 : 0, s1 = sweep ? day.at(-1).t + 60 : 0;
      const tallyAt = (t) => {
        let k = 0;
        while (k < day.length && day[k].t <= t) k++;
        return [Math.round(s.at.cars * k / day.length), s.at.total_h * cum[k] / (cum.at(-1) || 1)];
      };
      const tEnd = m.tB + 15;
      const spot = centre(s);
      const clock = (sec) => R.dur(Math.max(0, sec));
      // Just the routes through the spot (the story's own link names them), the rest dimmed.
      const routes = (new URLSearchParams(s.hash).get("r") || m.p.r).split(",");
      // The way the cars go through the spot (east, north), for the columns and the camera.
      const dx = pos[2 * m.b] - pos[2 * m.a], dy = pos[2 * m.b + 1] - pos[2 * m.a + 1];
      // The columns round the spot, on the cars' side of the street only (the tally is one direction).
      const local = peaks && sweep ? peaks.near(spot, 450, [dx, dy]) : null;
      // Framed between the spot and where the stuck car stands (it often waits back in the
      // queue), from an angle: the street runs diagonally up the screen, cars heading away
      // to the right, rather than the camera looking straight up the road.
      const stand = R.heads(h0, R.byCar.get(m.p.v))[0];
      const view = stand ? [lerp(spot[0], stand.lon, 0.6), lerp(spot[1], stand.lat, 0.6)] : spot;
      const road = Math.atan2(dx * MX, dy * MY) * 180 / Math.PI;   // compass heading of the street
      const bearing = ((road - 60 + 540) % 360) - 180;
      // The quick car runs on its own clock, lined up with the stuck car's at the spot.
      const quickT = (t) => q.tA + (t - m.tA);
      // The quick car runs a lane over (to the right of travel, by about a drawn car's width
      // at this zoom), so when the two are level they sit side by side, not on top.
      const len = Math.hypot(dx * MX, dy * MY) || 1, lane = R.wide ? 16 : 22;
      const off = [lane * (dy * MY / len) / MX, -lane * (dx * MX / len) / MY];
      // Phones see less street across: a step further out so both cars stay in frame.
      const spotZoom = R.wide ? 16.2 : 15.5;
      // The stuck car's label sits above it, the quick car's below: they start together.
      const label = (txt, at, hot, below = false) => ({txt, at, hot, below});
      return {
        dur,
        enter() {
          state.t = m.tA - lead;
          R.setRoutes(routes);
          R.setFocus(m.p.v);
          state.extra = q ? [{p: q.p, t: quickT(state.t), off}] : [];
          state.dim = 0.65;
          map.stop();
          move({center: view, zoom: spotZoom, pitch: 52, bearing}, P[0] * 1000);
          R.tour.layers = () => {
            const ls = labels();
            return [new deck.TextLayer({
              id: "tour-car-labels", data: ls, getPosition: (l) => l.at, getText: (l) => l.txt,
              getSize: 13, getColor: (l) => (l.hot ? [255, 255, 255, 255] : [200, 200, 205, 255]),
              getPixelOffset: (l) => (l.below ? [0, 40] : [0, -44]), fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600,
              characterSet: "auto", lineHeight: 1.25, background: true,
              getBackgroundColor: (l) => (l.hot ? [20, 21, 24, 235] : [20, 21, 24, 190]), backgroundPadding: [6, 3],
              updateTriggers: {getText: Math.round(state.t), getColor: ls.map((l) => l.hot).join(),
                getBackgroundColor: ls.map((l) => l.hot).join()},
            })];
          };
        },
        tick(f, sec) {
          const [eFly, eIn, eWait, eFast, ePay] = ends;
          if (sec >= ePay && sweep) return sweepTick((sec - ePay) / P[5]);
          let t;
          if (sec < eFly) t = m.tA - lead;
          else if (sec < eIn) t = lerp(m.tA - lead, hasHold ? h0 : tEnd, (sec - eFly) / P[1]);
          else if (sec < eWait) t = h0 + (sec - eIn);
          else if (sec < eFast) t = lerp(h0 + P[2], h1, easeIn((sec - eWait) / P[3]));
          else t = lerp(hasHold ? h1 : tEnd, tEnd, easeOut(Math.min(1, (sec - eFast) / P[4])));
          state.speed = 120;
          state.t = t;
          if (q) state.extra = [{p: q.p, t: quickT(t), off}];
          // The camera holds still; if a slow device cut the flight short, ease it the rest of the way.
          if (sec >= eFly && !map.isMoving()) {
            const c = map.getCenter();
            map.jumpTo({center: [lerp(c.lng, view[0], 0.08), lerp(c.lat, view[1], 0.08)],
              zoom: lerp(map.getZoom(), spotZoom, 0.08), pitch: lerp(map.getPitch(), 52, 0.08),
              bearing: map.getBearing() + (((bearing - map.getBearing() + 540) % 360) - 180) * 0.08});
          }
          const waiting = hasHold && t >= h0 && t <= h1;
          caption(fill(c0, v), sec >= eFast ? fill(c1, v) : "");
          // Once the quick car is through, its time also goes up here: on a phone its label
          // may have left the frame with it.
          const done = q && quickT(t) >= q.tB;
          showHud((waiting ? `<div class="th-big">Standing still ${clock(t - h0)}</div>` : "") +
            (done && (waiting || t < m.tB) ? `<div class="th-row done"><span>Car ${esc(q.p.v)}, ${esc(R.clockText(q.tA))}, went through in</span><b>${clock(q.tB - q.tA)}</b></div>` : ""));
        },
        leave() { R.tour.layers = null; R.setRoutes([]); state.dim = 0; state.extra = []; },
      };
      // Each car's label: which car and when, and its time through the spot so far; the quick
      // car's freezes where it left the spot, ticked.
      function labels() {
        const t = state.t, out = [];
        const me = R.at(m.p, Math.min(Math.max(t, m.p.t0), m.p.t1));
        if (me && t >= m.tA - lead) {
          out.push(label(`${m.p.v} · ${R.clockText(m.tA)}\n${t <= m.tB ? clock(t - m.tA) : `${clock(m.tB - m.tA)}`}`,
            [me[0], me[1]], true));
        }
        if (q) {
          const qt = quickT(t);
          if (qt >= q.tB) {
            out.push(label(`${q.p.v} · ${R.clockText(q.tA)}\n✓ ${clock(q.tB - q.tA)}`, [pos[2 * q.b] + off[0], pos[2 * q.b + 1] + off[1]], false, true));
          } else {
            const a = R.at(q.p, Math.max(qt, q.p.t0));
            if (a) out.push(label(`${q.p.v} · ${R.clockText(q.tA)}\n${clock(qt - q.tA)}`, [a[0] + off[0], a[1] + off[1]], true, true));
          }
        }
        return out;
      }
      // Every car there that day, sped through, the tally climbing as each one passes and
      // the delay map's columns rising round the spot.
      function sweepTick(f) {
        if (state.focus) {
          R.setFocus(null);
          state.extra = [];
          state.dim = 0.5;
          R.tour.layers = local && local.length ? () => [peaksLayer(peaks, local, state.t, 170, 1, "tour-peaks-local", 0)] : null;
          map.stop();
          move({center: spot, zoom: 15.4, pitch: 55, bearing: map.getBearing()}, 900);
        }
        state.t = lerp(s0, s1, ease(Math.min(1, f)));
        state.speed = (s1 - s0) / P[5];
        const [cars, h] = f >= 1 ? [s.at.cars, s.at.total_h] : tallyAt(state.t);
        caption(fill(c0, v), fill(c1, v));
        showHud(`<div class="th-big">${h.toFixed(1)} hours lost here</div>` +
          `<div class="th-row"><span>Streetcars by ${esc(R.clockText(state.t))}</span><b>${cars}</b></div>`);
      }
    }

    // Someone on foot against a real streetcar (stories.walk: the stretch where most cars were
    // slower than walking, and the middle such ride there). Both leave stop A together; the
    // walker keeps a steady pace on the sidewalk the whole way and the car does what it did
    // that day, to within a car length of B (walk.py: the car has arrived there; the beat
    // stops its clock then, so it doesn't drive on past the walker). Each carries a label with
    // its time so far; the walker's freezes, ticked, at B.
    // The clock runs straight through (no real-time hold): the walker's even pace is the
    // yardstick, so the car's stops show against it.
    function walkBeat(w) {
      const p = (R.byCar.get(w.v) || []).find((x) => x.t0 <= w.tA && w.tB <= x.t1);
      if (!p) return null;
      const kmAt = (t) => { const a = R.at(p, t); return a ? lerp(R.cumKm[a[2]], R.cumKm[a[3]], a[4]) : null; };
      const kmA = kmAt(w.tA), kmEnd = kmAt(w.tB);
      if (kmA === null || kmEnd === null || kmEnd <= kmA) return null;
      const kmB = kmA + w.m / 1000;  // stop B, w.m metres on: the car's clock stops short of it
      const tW = w.tA + w.walk_s;   // the walker reaches B
      // The walker: along the car's own track (the street), offset to the right of travel onto
      // the sidewalk, at the steady pace that covers A to B in walk_s.
      const SIDE = R.wide ? 11 : 15;
      const walkerAt = (t) => {
        const km = kmA + (kmB - kmA) * Math.max(0, Math.min(1, (t - w.tA) / w.walk_s));
        const [i, f] = findIn(R.cumKm, p.i0, p.i1 - 1, km);
        // The street's direction there: the next vertex at least 2 m away.
        let j = i + 1;
        while (j < p.i1 - 1 && Math.hypot((pos[2 * j] - pos[2 * i]) * MX, (pos[2 * j + 1] - pos[2 * i + 1]) * MY) < 2) j++;
        const dx = (pos[2 * j] - pos[2 * i]) * MX, dy = (pos[2 * j + 1] - pos[2 * i + 1]) * MY, L = Math.hypot(dx, dy) || 1;
        const lon = lerpAt(pos, i, f, 2, 0), lat = lerpAt(pos, i, f, 2, 1);
        return [lon + SIDE * (dy / L) / MX, lat - SIDE * (dx / L) / MY, dx / MX, dy / MY];
      };
      const A = w.a_ll, B = w.b_ll;
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const road = Math.atan2(dx * MX, dy * MY) * 180 / Math.PI;
      const mmss = (s) => R.dur(s);
      const diff = Math.round((w.ride_s - w.walk_s) / 60);
      const v = {...vars, street: w.street, a: w.a, b: w.b, route: w.route, n: w.n, of: w.of,
        m: w.m.toLocaleString("en-CA"), kmh: String(w.kmh), walk: mmss(w.walk_s), ride: mmss(w.ride_s),
        diff: diff <= 1 ? "a minute" : `${diff} min`};
      const [c0, c1] = capsFor("walk");
      const lead = 8;
      // The last step pulls back to the whole network: every trip that day slower than walking
      // somewhere, counted, and the streets where it happened lit in the walker's coat colour.
      const nt = w.net && w.net.trips > 1 ? w.net : null;
      const nv = nt && {...v, trips: nt.trips.toLocaleString("en-CA"), all: nt.of.toLocaleString("en-CA"), routes: nt.routes.length};
      const [n0, n1] = capsFor("walkNet");
      const P = [1.4, 6.5, 0.5, 2.4, nt ? 4.2 : 0];   // fly, the walk, the car's last metres, pay off, the network
      const ends = P.reduce((acc, d) => [...acc, (acc.at(-1) || 0) + d], []);
      const runSpeed = (w.tB - w.tA + lead) / P[1];
      const label = (txt, at, hot, below) => ({txt, at, hot, below});
      let cam = null, netOn = false, s0 = 0;
      // The camera holds still with both stops in frame, never zoomed out past MIN_ZOOM: below
      // it the streetcar fades to a dot (replay.js ICON_ZOOM, crossfading to 15.4). Starting
      // from the spot beats' view (angled 60 degrees across the street, tilted 52), it tilts
      // further first, then turns the street to run more up the screen (tilt only shortens
      // what runs up the screen), until the stretch fits. A phone's tall screen starts turned.
      // Each try fits A and B as seen tilted (cameraForBounds frames it flat): set the camera,
      // see where they land, adjust zoom and centre, a few times. Jumps within one task never
      // reach the screen, and the camera is put back after.
      const MIN_ZOOM = 15.6;
      const camFor = () => {
        const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
        const box = R.wide ? {l: 140, r: W - 140, t: H * 0.3, b: H * 0.72} : {l: 50, r: W - 50, t: H * 0.2, b: H * 0.76};
        const was = {center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
        const fit = (pitch, turn) => {
          const bearing = ((road - turn + 540) % 360) - 180;
          let cam = {center: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], zoom: 15.5, pitch, bearing};
          for (let k = 0; k < 4; k++) {
            map.jumpTo(cam);
            const a = map.project([A[0], A[1]]), b = map.project([B[0], B[1]]);
            const sw = Math.abs(a.x - b.x) || 1, sh = Math.abs(a.y - b.y) || 1;
            const zoom = cam.zoom + Math.log2(Math.min((box.r - box.l) / sw, (box.b - box.t) / sh));
            // Shift so the pair's middle sits mid-box.
            const mid = map.unproject([(a.x + b.x) / 2 - (box.l + box.r) / 2 + W / 2, (a.y + b.y) / 2 - (box.t + box.b) / 2 + H / 2]);
            cam = {...cam, center: [mid.lng, mid.lat], zoom};
          }
          return cam;
        };
        let best = null;
        search: for (const turn of R.wide ? [60, 45, 35, 25] : [25, 18, 12]) {
          for (const pitch of [52, 58, 64, 70]) {
            const c = fit(pitch, turn);
            if (!best || c.zoom > best.zoom) best = c;
            if (c.zoom >= MIN_ZOOM) { best = c; break search; }
          }
        }
        map.jumpTo(was);
        // Too long to fit even so: hold the zoom anyway (the ends may sit at the frame's edge).
        return {...best, zoom: Math.max(MIN_ZOOM, Math.min(16.2, best.zoom))};
      };
      return {
        dur: ends.at(-1),
        enter() {
          state.t = w.tA - lead;
          R.setRoutes([w.route]);
          R.setFocus(p.v);
          state.extra = [];
          state.dim = 0.65;
          map.stop();
          cam = camFor();
          move(cam, P[0] * 1000);
          // The walker and the labels draw over the streetcars: bigger than life, the car
          // pulling up to the stop would otherwise hide the walker waiting there.
          const onTop = {depthCompare: "always"};
          R.tour.layers = () => {
            const t = state.t, wk = walkerAt(t), walking = t > w.tA && t < tW;
            // Which way the walker faces on screen.
            const s0 = map.project([wk[0], wk[1]]), s1 = map.project([wk[0] + wk[2] * 1e-3, wk[1] + wk[3] * 1e-3]);
            const icon = walkerIcon(walking ? Math.floor(performance.now() / 130) % 4 : 4, s1.x < s0.x);
            return [
              new deck.ScatterplotLayer({id: "tour-walker-ground", parameters: onTop, data: [wk], getPosition: (d) => [d[0], d[1]],
                getRadius: 3, radiusUnits: "pixels", radiusMinPixels: 4, getFillColor: [255, 255, 255, 90]}),
              new deck.IconLayer({id: "tour-walker", parameters: onTop, data: [wk], getPosition: (d) => [d[0], d[1]], getIcon: () => icon,
                getSize: R.wide ? 46 : 38, sizeUnits: "pixels", billboard: true,
                updateTriggers: {getIcon: icon.id}}),
              new deck.TextLayer({
                id: "tour-walk-labels", parameters: onTop, data: labels(t, wk), getPosition: (l) => l.at, getText: (l) => l.txt,
                getSize: 13, getColor: (l) => (l.hot ? [255, 255, 255, 255] : [200, 200, 205, 255]),
                getPixelOffset: (l) => (l.below ? [0, 24] : [0, -44]), fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600,
                characterSet: "auto", lineHeight: 1.25, background: true,
                getBackgroundColor: (l) => (l.hot ? [20, 21, 24, 235] : [20, 21, 24, 190]), backgroundPadding: [6, 3],
                updateTriggers: {getText: Math.round(t), getColor: t >= tW, getBackgroundColor: t >= tW}}),
            ];
          };
        },
        tick(f, sec) {
          const [eFly, eRun, eLast, ePay] = ends;
          if (nt && sec >= ePay) return netTick(sec - ePay);
          let t;
          if (sec < eFly) t = w.tA - lead;
          else if (sec < eRun) t = lerp(w.tA - lead, w.tB, (sec - eFly) / P[1]);
          else t = w.tB;
          state.speed = runSpeed;
          state.t = t;
          // The camera holds still; if a slow device cut the flight short, ease it the rest of the way.
          if (sec >= eFly && !map.isMoving()) {
            const c = map.getCenter(), cc = cam.center.lng !== undefined ? [cam.center.lng, cam.center.lat] : cam.center;
            map.jumpTo({center: [lerp(c.lng, cc[0], 0.08), lerp(c.lat, cc[1], 0.08)],
              zoom: lerp(map.getZoom(), cam.zoom, 0.08), pitch: lerp(map.getPitch(), cam.pitch, 0.08),
              bearing: map.getBearing() + (((cam.bearing - map.getBearing() + 540) % 360) - 180) * 0.08});
          }
          caption(fill(c0, v), t >= w.tB ? fill(c1, v) : "");
          showHud((t >= tW ? `<div class="th-row done"><span>On foot, ${esc(v.m)} m at ${esc(v.kmh)} km/h</span><b>${esc(v.walk)}</b></div>` : "") +
            (t >= w.tB ? `<div class="th-row"><span>Streetcar ${esc(w.route)}, car ${esc(w.v)}</span><b>${esc(v.ride)}</b></div>` +
              `<div class="th-row"><span>Streetcars here slower than walking, ${esc(vars.day)}</span><b>${w.n} of ${w.of}</b></div>` : ""));
        },
        leave() { R.tour.layers = null; R.setRoutes([]); state.dim = 0; state.hideShort = false; netOn = false; },
      };
      function netTick(s) {
        if (!netOn) {
          netOn = true;
          R.setFocus(null);
          R.setRoutes([]);
          state.dim = 0.7;
          state.speed = 0;
          state.hideShort = true;  // the lit streets are the subject, not the day's short turns
          map.stop();
          move(netCam(), 1600);
          R.tour.layers = w.lines?.length ? () => [netLayer()] : null;
        }
        s0 = s;
        // The count climbs as the camera pulls back, and lands on the day's figure.
        const k = Math.round(nt.trips * easeOut(Math.min(1, s / 1.6)));
        caption(fill(n0, nv), s >= 0.8 ? fill(n1, nv) : "");
        showHud(`<div class="th-big">${k.toLocaleString("en-CA")} of ${esc(nv.all)} trips</div>` +
          `<div class="th-row"><span>slower than walking somewhere, ${esc(vars.day)}</span></div>` +
          nt.routes.slice(0, 3).map(([r, n]) => `<div class="th-row"><span>Streetcar ${esc(r)}</span><b>${n}</b></div>`).join(""));
      }
      // Each stop-to-stop piece of street a slower-than-walking stretch covered, wider where
      // more trips were slow over it.
      function netLayer() {
        const top = Math.max(...w.lines.map((l) => l[0]));
        const a = Math.round(235 * Math.min(1, s0 / 1.2));
        return new deck.PathLayer({id: "tour-walk-net", data: w.lines, getPath: (l) => l[1],
          getWidth: (l) => 2 + 5 * Math.sqrt(l[0] / top), widthUnits: "pixels", capRounded: true, jointRounded: true,
          getColor: [240, 180, 41, a], updateTriggers: {getColor: a}});
      }
      // Framed on the lit streets, from the home view's angle, between the tally and the
      // caption: fitted as seen tilted, like the walk's own camera (set it, see where the
      // streets land, adjust, a few times; put back after). The home view without them.
      function netCam() {
        const pts = (w.lines || []).flatMap((l) => l[1]);
        if (!pts.length) return home;
        const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
        const box = {l: R.wide ? 80 : 16, r: W - (R.wide ? 80 : 16), t: H * 0.32, b: H * 0.8};
        const was = {center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
        let cam = {center: [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length],
          zoom: 12, pitch: 35, bearing: home.bearing};
        for (let k = 0; k < 4; k++) {
          map.jumpTo(cam);
          const xy = pts.map((q) => map.project(q));
          const x0 = Math.min(...xy.map((q) => q.x)), x1 = Math.max(...xy.map((q) => q.x));
          const y0 = Math.min(...xy.map((q) => q.y)), y1 = Math.max(...xy.map((q) => q.y));
          const zoom = cam.zoom + Math.log2(Math.min((box.r - box.l) / (x1 - x0 || 1), (box.b - box.t) / (y1 - y0 || 1)));
          const mid = map.unproject([(x0 + x1) / 2 - (box.l + box.r) / 2 + W / 2, (y0 + y1) / 2 - (box.t + box.b) / 2 + H / 2]);
          cam = {...cam, center: [mid.lng, mid.lat], zoom: Math.max(10, Math.min(14, zoom))};
        }
        map.jumpTo(was);
        return cam;
      }
      function labels(t, wk) {
        const out = [], me = R.at(p, Math.min(Math.max(t, p.t0), p.t1));
        const since = (x) => mmss(Math.max(0, x - w.tA));
        if (me) out.push(label(`${w.route} · ${R.clockText(w.tA)}\n${t < w.tB ? since(t) : `${mmss(w.ride_s)}`}`, [me[0], me[1]], true, false));
        out.push(label(`Walking · ${w.kmh} km/h\n${t < tW ? since(t) : `✓ ${mmss(w.walk_s)}`}`, [wk[0], wk[1]], t < tW, true));
        return out;
      }
    }

    // The short-turn route at a distance, the day sped by: warnings pop up where each turn was
    // detected, a column at every stop grows with the longest gap between streetcars so far
    // (tallest past the turns), and a tally counts the turns.
    function shortBeat(s) {
      const ev = R.shortEv.filter((e) => e.r === s.at.route);
      // The busiest four hours of short turns, or the whole span if shorter.
      let t0 = ev[0].t - 300, t1 = ev.at(-1).t + 300;
      if (t1 - t0 > 4 * 3600) {
        let best = 0;
        for (const e of ev) {
          const n = ev.filter((x) => x.t >= e.t && x.t < e.t + 4 * 3600).length;
          if (n > best) { best = n; t0 = e.t - 300; }
        }
        t1 = t0 + 4 * 3600 + 300;
      }
      const inWin = ev.filter((e) => e.t >= t0 && e.t <= t1);
      const gaps = net ? stopGaps(R, net, s.at.route).filter((x) => x.t.length >= 2) : [];
      const pad = R.wide ? 160 : 70;
      // The camera keeps the columns the subject: it frames the stops with the longest gaps (by
      // the beat's end), looking from them toward the turns, so the rest of the line and its
      // warning signs sit behind. Without a clear hot stretch, it frames the turns.
      const ends = gaps.map((g) => (g.end = longestGap(g.t, t0, t1)) / 60).sort((x, y) => x - y);
      const top = ends.at(-1) || 0, typ = ends[Math.floor(ends.length / 2)] || 0;
      const hot = top - typ >= 4 ? gaps.filter((g) => g.end / 60 >= typ + 0.6 * (top - typ)) : [];
      // {gap} and {typ} follow the columns as they grow (set each tick), so the words match the tally.
      const v = {...vars, place: s.place, detail: s.detail, detailLc: lc(s.detail), route: s.at.route, gap: 0, typ: 0};
      const [c0, c1] = hot.length ? capsFor("shortturn") : SHORT_NO_GAPS;
      const mid = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
      const camFor = () => {
        if (hot.length) {
          const hp = hot.map((g) => g.pos), [hx, hy] = mid(hp), [tx, ty] = mid(inWin.map((e) => [e.lon, e.lat]));
          const far = Math.hypot((tx - hx) * MX, (ty - hy) * MY) > 300;
          const bearing = far ? Math.atan2((tx - hx) * MX, (ty - hy) * MY) * 180 / Math.PI : -17;
          const h = map.getContainer().clientHeight;
          const cam = map.cameraForBounds([[Math.min(...hp.map((p) => p[0])), Math.min(...hp.map((p) => p[1]))],
            [Math.max(...hp.map((p) => p[0])), Math.max(...hp.map((p) => p[1]))]],
          {padding: {top: h * 0.42, bottom: h * 0.18, left: pad, right: pad}, bearing, pitch: 58});
          if (cam) return {...cam, zoom: Math.min(15, cam.zoom), pitch: 58, bearing};
        }
        const lons = inWin.map((e) => e.lon), lats = inWin.map((e) => e.lat);
        const cam = map.cameraForBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          {padding: pad, bearing: -17, pitch: 40});
        return {...(cam || {center: [lons[0], lats[0]]}), zoom: Math.min(14.2, cam ? cam.zoom : 13), pitch: 40, bearing: -17};
      };
      // A 40-minute gap or more stands a fifth of the screen high at the beat's camera (closer
      // in on a hot stretch, so metres per minute follow the zoom).
      const dur = 7, GAP_TOP = 40 * 60;
      let mPerMin = 18;
      const gapLayer = (t) => new deck.ColumnLayer({
        id: "tour-gaps", data: gaps, getPosition: (g) => g.pos, diskResolution: 8, radius: 22,
        extruded: true, material: false,
        getFillColor: (g) => {
          const f = Math.min(1, Math.max(0, (g.gap - 600) / 1200));  // 10 min pale yellow .. 30 min red
          return [255, Math.round(215 - 175 * f), Math.round(90 - 60 * f), 235];
        },
        getElevation: (g) => Math.min(g.gap, GAP_TOP) / 60 * mPerMin,
        updateTriggers: {getElevation: Math.round(t / 30), getFillColor: Math.round(t / 30)},
      });
      return {
        dur,
        enter() {
          R.setFocus(null);
          R.setRoutes([s.at.route]);
          state.pinShort = true;
          state.t = t0;
          for (const g of gaps) g.gap = 0;
          R.tour.layers = gaps.length ? () => [gapLayer(state.t)] : null;
          map.stop();
          const cam = camFor(), h = map.getContainer().clientHeight;
          const mpp = 40075016 * Math.cos((cam.center.lat ?? cam.center[1]) * Math.PI / 180) / (512 * 2 ** cam.zoom);
          mPerMin = h / 5 * mpp / (GAP_TOP / 60);
          move(cam, 1400);
        },
        tick(f) {
          state.t = lerp(t0, t1, ease(f));
          state.speed = (t1 - t0) / dur * 1.2;
          const n = ev.filter((e) => e.t >= t0 && e.t <= state.t).length;
          let worst = null;
          for (const g of gaps) {
            g.gap = longestGap(g.t, t0, state.t);
            if (!worst || g.gap > worst.gap) worst = g;
          }
          if (gaps.length) {
            const now = gaps.map((g) => g.gap).sort((x, y) => x - y);
            v.gap = Math.round(now.at(-1) / 60);
            v.typ = Math.round(now[Math.floor(now.length / 2)] / 60);
          }
          caption(fill(c0, v), f > 0.6 ? fill(c1, v) : "");
          showHud(`<div class="th-row"><span>${esc(R.clockText(t0))} to ${esc(R.clockText(state.t))}</span></div>` +
            `<div class="th-row"><span>⚠ Trips sent back early</span><b>${n}</b></div>` +
            (worst ? `<div class="th-row"><span>▮ Longest gap at a stop</span><b>${Math.round(worst.gap / 60)} min</b></div>` : ""));
        },
        leave() { R.setRoutes([]); R.tour.layers = null; state.pinShort = false; },
      };
    }

    function closeBeat() {
      return {
        dur: 3,
        enter() {
          R.setFocus(null); map.stop(); move(home, 2000);
          state.dim = peaks ? 0.55 : 0;
          state.hideShort = true;
          R.tour.layers = peaks ? () => [peaksLayer(peaks, peaks.slices, R.tMax, 1400, 0.9)] : null;
        },
        tick(f, sec, dt) { state.t = Math.min(R.tMax, state.t + dt * 600); state.speed = 600; caption(fill(closeCap[0], vars)); },
      };
    }
  }

  // The end screen: yesterday's stories (the map page's first-visit card) and what next.
  function endCard(R, stories, again) {
    const $ = (id) => document.getElementById(id);
    const card = $("tour-end");
    $("te-when").textContent = stories.when;
    $("te-head").textContent = stories.headline;
    $("te-list").innerHTML = stories.items.map((s) =>
      `<li><a href="./?${esc(new URLSearchParams(s.q).toString())}#${esc(s.hash)}">` +
      `<span class="te-label">${esc(s.label)}</span><span class="te-place">${esc(s.place)}</span>` +
      `<span class="te-detail">${esc(s.detail || "")}</span></a></li>`).join("");
    card.hidden = false;
    document.body.classList.add("tour-ended");
    const close = () => { card.hidden = true; document.body.classList.remove("tour-ended"); };
    $("te-explore").onclick = close;
    $("te-close").onclick = close;
    $("te-again").onclick = () => { close(); again(); };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  }
})();
