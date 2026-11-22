// Tour: yesterday in about 40 seconds, played on the replay (replay.html#tour=1).
// A time-lapse of the whole network, then one beat per story from the bot's picks
// (data/drafts/stories.json, see drafts.py story_of): the camera flies to the spot, the
// replay runs at the moment it happened, and a stopwatch sets the car against the ghost
// (the clean run). Ends on the story card. Skip is always there; a tap pauses.
(function () {
  const begin = () => setup(window.replayTour);
  if (window.replayTour) begin(); else window.addEventListener("replay-ready", begin, {once: true});

  // Captions: short, numbers exactly as on the site, never a dig at the TTC or its staff.
  // Each beat has a few variants, [setup, payoff]; the day picks one (so everyone sees the
  // same words that day, and they change day to day), and "Watch again" moves on a step.
  // {when} {day} {lost} {place} {placeLc} {detail} {route} {car} {clean}
  const CAPTIONS = {
    open: [
      ["{when}. Every streetcar, all day.", "{lost} hours lost to delays."],
      ["Every streetcar on {day}, from the TTC's live positions.", "Together they lost {lost} hours to delays."],
    ],
    signal: [
      ["Held at a signal: {place}", "{detail}."],
      ["Clean run through here: {clean}. Now watch car {car}.", "{detail}."],
      ["Car {car}, {placeLc}.", "Not alone: {detailLc}."],
      ["Watch the clock: {placeLc}.", "{detail}."],
    ],
    segment: [
      ["The day's slowest stretch: {place}", "{detail}."],
      ["The ghost is a clean run. Watch it pull away.", "{detail}."],
    ],
    stopwait: [
      ["Longest extra wait at a stop: {place}", "{detail}."],
      ["Riders at {place} waited longest beyond the schedule.", "{detail}."],
      ["{place}: where the minutes went missing.", "{detail}."],
    ],
    shortturn: [
      ["{place}: trips sent back early", "{detail}."],
      ["Each ⚠ is a streetcar turned back before its last stop.", "{detail}."],
      ["{place}. Not every trip reaches the end.", "{detail}."],
      ["{place}, where the end of the line moves.", "{detail}."],
    ],
    close: [["Now pick a car and ride along."], ["Your turn: tap any streetcar."], ["Every car's day is here. Pick one."]],
  };
  const KINDS = Object.keys(CAPTIONS);
  let round = 0;  // times watched on this visit
  const pick = (kind, day) => {
    const list = CAPTIONS[kind], n = Math.floor(Date.parse(day) / 864e5) + round + KINDS.indexOf(kind);
    return list[((n % list.length) + list.length) % list.length];
  };
  const lc = (x) => (x ? x[0].toLowerCase() + x.slice(1) : "");
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

  async function setup(R) {
    let stories = null;
    try { stories = await (await fetch("data/drafts/stories.json", {cache: "no-cache"})).json(); } catch { /* none */ }
    if (!stories || stories.day !== R.data.day || !stories.items?.length) return;
    const btn = document.getElementById("tour-btn");
    btn.hidden = false;
    btn.addEventListener("click", () => play(R, stories));
    if (R.tour.active) play(R, stories);
  }

  // --- finding the moment ---------------------------------------------------------------
  const DAY_FROM = 6 * 3600 - 4 * 3600, DAY_TO = 22 * 3600 - 4 * 3600;  // 06:00-22:00 (t counts from 04:00)
  const SPOT_M = 150, NEAR_M = 40, MAX_LOST = 900;
  // Every daytime pass through the spot (or along the stretch): [p, a, b] vertex range and
  // the time it lost against the ghost over that range. The tour shows the pass at the 90th
  // percentile: a bad but ordinary day there, not a one-off breakdown.
  // allDay: every pass, any hour, its loss clamped to 0..MAX_LOST (for the day's tally).
  function passes(R, at, allDay = false) {
    const {paths, ts, gclk, cumKm, project} = R, out = [];
    const keep = (p, a, b, minKm) => {
      const lost = (ts[b] - ts[a]) - (gclk[b] - gclk[a]);
      if (cumKm[b] - cumKm[a] <= minKm) return;
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
    return {...m, tA: ts[m.a], tB: ts[m.b], hold, n: all.length, day};
  }

  // --- the tour -------------------------------------------------------------------------
  function play(R, stories) {
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

    // Spot beats, most time lost first; at most two, with the short turns between them.
    const spots = [], kinds = ["signal", "segment", "stopwait"];
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
    const mids = spots.slice(0, st ? 2 : 3).map(spotBeat);
    if (st) mids.splice(1, 0, shortBeat(st));
    beats.push(...mids, closeBeat());

    // UI
    document.body.classList.add("touring");
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
      R.setFocus(null);
      R.setRoutes([]);
      document.removeEventListener("keydown", onKey, true);
      ui.hidden = true;
      document.body.classList.remove("touring");
      state.speed = 600;
      R.setSpeed(600);
      R.setPlaying(true);
      map.stop();
      move(home, 1200);
      endCard(R, stories, () => play(R, stories));
      R.writeHash();
    }

    // Time-lapse of the whole network through the morning rush.
    // The whole day sped through, with the day's time lost to delays adding up. The counter
    // ends on the site's figure (stories.lost_h); its shape over the day comes from the replay:
    // each trip's time lost against the ghost, spread over the trip.
    function openBeat() {
      const t0 = R.tMin, t1 = R.tMax, dur = 6, STEP = 60;
      const curve = new Float64Array(Math.ceil((t1 - t0) / STEP) + 2);
      for (const p of R.paths) {
        if (!p.ghost || p.t1 <= p.t0) continue;
        const lost = Math.max(0, (p.t1 - p.t0) - (gclk[p.i1 - 1] - gclk[p.i0]));
        const k0 = Math.floor((p.t0 - t0) / STEP), k1 = Math.floor((p.t1 - t0) / STEP);
        for (let k = k0; k <= k1; k++) curve[k + 1] += lost / (k1 - k0 + 1);
      }
      for (let k = 1; k < curve.length; k++) curve[k] += curve[k - 1];
      const total = curve[curve.length - 1] || 1;
      const lostBy = (t) => {
        const x = Math.max(0, Math.min(curve.length - 1.001, (t - t0) / STEP)), k = Math.floor(x);
        return stories.lost_h * lerp(curve[k], curve[k + 1], x - k) / total;
      };
      return {
        dur,
        enter() { map.stop(); map.jumpTo(home); R.setFocus(null); R.tour.layers = null; },
        tick(f) {
          state.t = lerp(t0, t1, f);
          state.speed = (t1 - t0) / dur;
          caption(fill(openCap[f < 0.5 ? 0 : 1], vars));
          showHud(!stories.lost_h ? "" :
            `<div class="th-big">${Math.round(f >= 1 ? stories.lost_h : lostBy(state.t)).toLocaleString("en-CA")} hours</div>` +
            `<div class="th-row"><span>lost to delays by ${esc(R.clockText(state.t))}</span></div>`);
        },
      };
    }

    // One car at the story's spot: fly in, roll up, feel the wait in real time, then speed
    // through the rest of it and show what it cost against the ghost.
    function spotBeat({s, m}) {
      const v = {...vars, place: s.place, placeLc: lc(s.place), detail: s.detail, detailLc: lc(s.detail),
        car: m.p.v, clean: R.dur(gclk[m.b] - gclk[m.a])};
      const [c0, c1] = capsFor(s.kind);
      const lead = 45, hasHold = m.hold && m.hold[1] - m.hold[0] >= 25;
      const h0 = hasHold ? m.hold[0] : (m.tA + m.tB) / 2, h1 = hasHold ? m.hold[1] : h0;
      // Phases, real seconds: fly, approach, feel (real time), speed through, pay off, and
      // (when the site gives a day total for the spot) sweep through the whole day there.
      const day = m.day, sweep = s.at.total_h && day.length >= 5;
      const P = [...(hasHold ? [1.5, 1.3, 2.5, 1.8, 2.2] : [1.5, 2.5, 0, 0, 2.5]), sweep ? 3.4 : 0];
      const ends = P.reduce((a, d) => [...a, (a.at(-1) || 0) + d], []);
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
      const tEnd = m.tB + 25;
      const spot = centre(s);
      const clock = (sec) => R.dur(Math.max(0, sec));
      const ghostTotal = gclk[m.b] - gclk[m.a];
      const ghostAt = (t) => {
        const [i, f] = findIn(gclk, m.a, m.b, gclk[m.a] + Math.max(0, t - m.tA));
        return [lerpAt(pos, i, f, 2, 0), lerpAt(pos, i, f, 2, 1)];
      };
      let cam = null;
      return {
        dur,
        enter() {
          state.t = m.tA - lead;
          R.setFocus(m.p.v);
          map.stop();
          cam = null;
          move({center: spot, zoom: 16.2, pitch: 55, bearing: map.getBearing()}, P[0] * 1000);
          R.tour.layers = () => {
            if (state.t < m.tA) return [];
            const g = ghostAt(state.t), {IconLayer, ScatterplotLayer} = R.deck;
            return [
              new ScatterplotLayer({id: "tour-ghost-glow", data: [g], getPosition: (d) => d,
                getFillColor: [200, 190, 255, 60], radiusUnits: "pixels", getRadius: 18}),
              new IconLayer({id: "tour-ghost", data: [g], getPosition: (d) => d, getIcon: () => R.GHOST_ICON,
                getSize: 30, sizeUnits: "pixels"}),
            ];
          };
        },
        tick(f, sec) {
          let t;
          if (sec < ends[0]) t = m.tA - lead;
          else if (sec < ends[1]) t = lerp(m.tA - lead, h0, (sec - ends[0]) / P[1]);
          else if (sec < ends[2]) t = h0 + (sec - ends[1]);
          else if (sec < ends[3]) t = lerp(h0 + P[2], h1, easeIn((sec - ends[2]) / P[3]));
          else if (sec < ends[4] || !sweep) t = lerp(hasHold ? h1 : h0, tEnd, easeOut(Math.min(1, (sec - ends[3]) / P[4])));
          else return sweepTick((sec - ends[4]) / P[5]);
          state.speed = 120;
          state.t = t;
          // Camera rides with the car once it has arrived.
          if (sec >= ends[0]) {
            const a = R.heads(t, R.byCar.get(m.p.v))[0];
            if (a) {
              // Once the flight is over (or if a slow device cut it short), ease the centre onto
              // the car and the zoom and tilt to where the flight was going.
              cam = cam ? [lerp(cam[0], a.lon, 0.12), lerp(cam[1], a.lat, 0.12)] : map.getCenter().toArray();
              if (!map.isMoving()) map.jumpTo({center: cam, zoom: lerp(map.getZoom(), 16.2, 0.08), pitch: lerp(map.getPitch(), 55, 0.08)});
            }
          }
          const carS = Math.min(t, m.tB) - m.tA, ghostS = Math.min(Math.max(0, t - m.tA), ghostTotal);
          const waiting = hasHold && t >= h0 && t <= h1;
          caption(fill(c0, v), sec >= ends[3] ? fill(c1, v) : "");
          showHud(t < m.tA ? "" :
            (waiting ? `<div class="th-big">Standing still ${clock(t - h0)}</div>` : "") +
            `<div class="th-row"><span>Car ${esc(m.p.v)}</span><b>${clock(carS)}</b></div>` +
            `<div class="th-row ghost"><span>👻 Clean run</span><b>${clock(ghostS)}</b></div>`);
        },
        leave() { R.tour.layers = null; },
      };
      // Every car there that day, sped through, the tally climbing as each one passes.
      function sweepTick(f) {
        if (state.focus) {
          R.setFocus(null);
          R.tour.layers = null;
          map.stop();
          move({center: spot, zoom: 15.4, pitch: 50, bearing: map.getBearing()}, 900);
        }
        state.t = lerp(s0, s1, ease(Math.min(1, f)));
        state.speed = (s1 - s0) / P[5];
        const [cars, h] = f >= 1 ? [s.at.cars, s.at.total_h] : tallyAt(state.t);
        caption(fill(c0, v), fill(c1, v));
        showHud(`<div class="th-big">${h.toFixed(1)} hours lost here</div>` +
          `<div class="th-row"><span>Streetcars by ${esc(R.clockText(state.t))}</span><b>${cars}</b></div>`);
      }
    }

    // The short-turn route at a distance, the day sped by, warnings popping and a running tally.
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
      const lons = ev.map((e) => e.lon), lats = ev.map((e) => e.lat);
      const pad = R.wide ? 160 : 70;
      const v = {...vars, place: s.place, detail: s.detail, route: s.at.route};
      const [c0, c1] = capsFor("shortturn");
      const dur = 7;
      return {
        dur,
        enter() {
          R.setFocus(null);
          R.tour.layers = null;
          R.setRoutes([s.at.route]);
          state.t = t0;
          map.stop();
          const cam = map.cameraForBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
            {padding: pad, bearing: -17, pitch: 40});
          move({...(cam || {center: [lons[0], lats[0]]}), zoom: Math.min(14.2, cam ? cam.zoom : 13), pitch: 40, bearing: -17}, 1400);
        },
        tick(f) {
          state.t = lerp(t0, t1, ease(f));
          state.speed = (t1 - t0) / dur * 1.2;
          const n = ev.filter((e) => e.t >= t0 && e.t <= state.t).length;
          caption(fill(c0, v), f > 0.6 ? fill(c1, v) : "");
          showHud(`<div class="th-row"><span>${esc(R.clockText(t0))} to ${esc(R.clockText(state.t))}</span></div>` +
            `<div class="th-row"><span>⚠ Trips sent back early</span><b>${n}</b></div>`);
        },
        leave() { R.setRoutes([]); },
      };
    }

    function closeBeat() {
      return {
        dur: 3,
        enter() { R.setFocus(null); R.tour.layers = null; map.stop(); move(home, 2000); },
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
