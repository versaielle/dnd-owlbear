// The vision spike's pure parts (docs/vision-layer-spec.md section 12): no Owlbear SDK here, so
// check_spike.mjs runs every one of them in node. background.js turns what these return into
// local items; popover.js shows the numbers.
//
//   settings        what the GM's buttons switched on (one object, broadcast to every screen)
//   geometry        a CURVE's points on the scene (position, rotation, scale), a map image's corners
//   wallPlan        Smoke & Spectre's lines (walls, closed doors, windows) + an edge round each map,
//                   for the occupied maps or all of them, as double-sided walls or single-sided pairs
//   lightPlan       one sight light per Spike-PC token
//   doorPlan        a handle at the middle of every Smoke door
//   memoryShapes    the S2 fog-layer pieces over one map
//   diffByKey       which local items to add and delete so the screen matches a plan
//   frameStats ...  the frame meter's numbers per 2 s window, and the "Copy results" text
//
// THROWAWAY: this folder is the test build for one evening; it is never merged.

export const NS = "dnd-npc-spike";
export const PC_KEY = `${NS}/pc`; // shared: on CHARACTER tokens the GM marks with "Spike: PC on"
export const LOCAL_KEY = `${NS}/local`; // on every local item the spike adds: {probe, key, sig}
export const DOOR_KEY = `${NS}/door`; // on the local door handles too (true): the context menu's filter
export const SMOKE = "com.battle-system.smoke";
const SK = (k) => `${SMOKE}/${k}`;

export const PROBES = ["light", "wall", "door", "memory"];

// Broadcast channels.
export const CH = {
  settings: `${NS}/settings`, // GM -> every screen: the settings object
  hello: `${NS}/hello`, // a screen that just started: send me the settings and your report
  report: `${NS}/report`, // every screen -> GMs: what I built, and my frame numbers
  door: `${NS}/door`, // whoever picked a door handle -> GMs
  raf: `${NS}/raf`, // this screen's meter popover -> its background (LOCAL)
  ui: `${NS}/ui`, // the GM popover -> its background (LOCAL)
  state: `${NS}/state`, // the GM background -> its popover (LOCAL)
};
export const WINDOW_MS = 2000; // the frame meter's window

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const rad = (d) => (d * Math.PI) / 180;
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => (finite(x) ? Math.round(x * 10) / 10 : null);

// ---- settings ----

export const DEFAULT_SETTINGS = Object.freeze({
  v: 1,
  at: 0, // when the GM changed them (ms); the newest wins on every screen
  by: "", // the GM screen's connection id (breaks a tie)
  meter: false,
  lights: { on: false, sourceRadius: 0, reachFt: 60 },
  walls: { on: false, scope: "occupied", sides: "double", gmOpen: true },
  memory: null, // {mapId}
  doors: { on: false, locked: false },
});

const pick = (x, allowed, dflt) => (allowed.includes(x) ? x : dflt);
const num = (x, lo, hi, dflt) => (finite(x) ? Math.max(lo, Math.min(hi, x)) : dflt);

// Any object (a broadcast, a stored copy) as a full settings object: unknown fields dropped,
// numbers kept in range, everything missing OFF.
export function cleanSettings(x) {
  const d = DEFAULT_SETTINGS;
  const s = x && typeof x === "object" ? x : {};
  const l = s.lights && typeof s.lights === "object" ? s.lights : {};
  const w = s.walls && typeof s.walls === "object" ? s.walls : {};
  const o = s.doors && typeof s.doors === "object" ? s.doors : {};
  const m = s.memory && typeof s.memory === "object" && typeof s.memory.mapId === "string" && s.memory.mapId ? { mapId: s.memory.mapId } : null;
  return {
    v: 1,
    at: num(s.at, 0, Number.MAX_SAFE_INTEGER, 0),
    by: typeof s.by === "string" ? s.by.slice(0, 80) : "",
    meter: s.meter === true,
    lights: { on: l.on === true, sourceRadius: num(l.sourceRadius, 0, 500, d.lights.sourceRadius),
              reachFt: num(l.reachFt, 5, 2000, d.lights.reachFt) },
    walls: { on: w.on === true, scope: pick(w.scope, ["occupied", "all"], d.walls.scope),
             sides: pick(w.sides, ["double", "pairs"], d.walls.sides), gmOpen: w.gmOpen !== false },
    memory: m,
    doors: { on: o.on === true, locked: o.locked === true },
  };
}

// Is `a` newer than `b`? Later `at` wins; the same `at`: the larger `by` (so every screen agrees).
export function newer(a, b) {
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  return a.by > b.by;
}

// A short label of what's on, for the history and the table ("all off" when nothing is).
export function settingsLabel(s) {
  const c = cleanSettings(s);
  const parts = [];
  if (c.meter) parts.push("meter");
  if (c.lights.on) parts.push(`lights sr${c.lights.sourceRadius} ${c.lights.reachFt}ft`);
  if (c.walls.on) parts.push(`walls ${c.walls.scope} ${c.walls.sides}${c.walls.gmOpen ? " gm-open" : " gm-block"}`);
  if (c.memory) parts.push("memory");
  if (c.doors.on) parts.push(`doors${c.doors.locked ? " locked" : ""}`);
  return parts.length ? parts.join(" | ") : "all off";
}

// ---- screens ----

export const TABLE_UA = /CrKey|Chromecast|GoogleTV|Android TV|AFT[A-Z]|BRAVIA|SMART-TV|Tizen|Web0S/i;
export const CAST_RECEIVER_NAME = /^cast receiver$/i;

// gm, table (the projector: Owlbear's Cast receiver joins as a player named "Cast Receiver") or
// player (a phone, a laptop). Copied from owlbear/bus.js kindOf, without the panel's settings.
export function kindOf({ role, name = "", ua = "" } = {}) {
  if (role === "GM") return "gm";
  if (CAST_RECEIVER_NAME.test(String(name || "").trim()) || TABLE_UA.test(ua || "")) return "table";
  return "player";
}

// ---- geometry ----

// A point of an item (in its own coordinates) on the scene: scaled, turned (degrees), moved.
// The same as gather.js wallSegments' MathM.fromItem(item) x MathM.fromPosition(p), decomposed.
export function toWorld(item, p) {
  const pos = item?.position || { x: 0, y: 0 };
  const sx = finite(item?.scale?.x) ? item.scale.x : 1, sy = finite(item?.scale?.y) ? item.scale.y : 1;
  const a = rad(item?.rotation || 0);
  const x = p.x * sx, y = p.y * sy;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: pos.x + x * c - y * s, y: pos.y + x * s + y * c };
}

// A CURVE's points on the scene; a closed one ends where it starts. [] when it has no usable point.
export function worldPoints(item) {
  if (!Array.isArray(item?.points)) return [];
  const pts = item.points.filter((p) => p && finite(p.x, p.y)).map((p) => toWorld(item, p));
  if (pts.some((p) => !finite(p.x, p.y))) return [];
  if (item.style?.closed && pts.length > 2) pts.push({ ...pts[0] });
  return pts;
}

export const isMapImage = (i) => i?.layer === "MAP" && (i.type === undefined || i.type === "IMAGE");

// The four corners of an image item on the scene (top-left, top-right, bottom-right, bottom-left
// in its own frame), from its pixel size, its grid dpi and offset (the point at `position`), its
// scale and turn, at the scene's `dpi`. null when it isn't an image with grid settings.
export function imageCorners(item, dpi) {
  const iw = item?.image?.width, ih = item?.image?.height, gd = item?.grid?.dpi;
  if (!finite(iw, ih, gd, dpi) || iw <= 0 || ih <= 0 || gd <= 0 || !item.position) return null;
  const k = dpi / gd;
  const off = item.grid.offset && finite(item.grid.offset.x, item.grid.offset.y) ? item.grid.offset : { x: iw / 2, y: ih / 2 };
  const at = (u, v) => toWorld(item, { x: (u - off.x) * k, y: (v - off.y) * k });
  return [at(0, 0), at(iw, 0), at(iw, ih), at(0, ih)];
}

const centreOf = (pts) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });

// A token's middle: its image's centre when it has one, else its position.
export function itemCentre(item, dpi) {
  const c = imageCorners(item, dpi);
  if (c) return centreOf(c);
  const p = item?.position;
  return p && finite(p.x, p.y) ? { x: p.x, y: p.y } : null;
}

// The scene's map images as rectangles (their bounding boxes), topmost first: by zIndex, then the
// later in the scene. As views.js mapRects.
export function mapRects(items, dpi) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((i, n) => {
    if (!isMapImage(i)) return;
    const c = imageCorners(i, dpi);
    if (!c) return;
    const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
    out.push({ id: i.id, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
               z: finite(i.zIndex) ? i.zIndex : 0, n });
  });
  return out.sort((a, b) => b.z - a.z || b.n - a.n);
}

// The topmost map under point p (its id), or null. As views.js mapAt.
export function mapAt(p, rects) {
  if (!p || !finite(p.x, p.y)) return null;
  const hit = (rects || []).find((r) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1);
  return hit ? hit.id : null;
}

export const isSpikePc = (i) => i?.layer === "CHARACTER" && i.metadata?.[PC_KEY] === true;

// The maps a Spike-PC stands on (the topmost map under each one's middle).
export function occupiedMaps(items, rects, dpi) {
  const out = new Set();
  for (const i of items || []) {
    if (!isSpikePc(i)) continue;
    const id = mapAt(itemCentre(i, dpi), rects);
    if (id) out.add(id);
  }
  return out;
}

// The point half way along a polyline (its length, not its points).
export function midpointAlong(pts) {
  if (!pts?.length) return null;
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
  let left = total / 2;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 0 && left <= d) return { x: a.x + ((b.x - a.x) * left) / d, y: a.y + ((b.y - a.y) * left) / d };
    left -= d;
  }
  return { ...pts[0] };
}

// ---- Smoke & Spectre's lines ----

// Every Smoke & Spectre vision line in the scene: {id, kind: wall|door|window, open, disabled,
// attachedTo, pts}. Lines from 🏘 Set up interiors carry the same keys, so both are read.
export function visionLines(items) {
  const out = [];
  for (const i of items || []) {
    const m = i?.metadata;
    if (!m || !m[SK("isVisionLine")] || i.type !== "CURVE") continue;
    const pts = worldPoints(i);
    if (pts.length < 2) continue;
    out.push({
      id: i.id,
      kind: m[SK("isWindow")] ? "window" : m[SK("isDoor")] ? "door" : "wall",
      open: !!m[SK("doorOpen")],
      disabled: !!m[SK("disabled")],
      attachedTo: i.attachedTo || null,
      pts,
    });
  }
  return out;
}

// The map a line belongs to: the map image it hangs on (🏘 Set up interiors attaches every line to
// its map), else the topmost map under its middle; null when it's on none.
export function lineMap(line, rects, byId) {
  const ids = new Set((rects || []).map((r) => r.id));
  let cur = line.attachedTo;
  for (let n = 0; cur && n < 10; n++) {
    if (ids.has(cur)) return cur;
    cur = byId?.get(cur)?.attachedTo;
  }
  return mapAt(midpointAlong(line.pts), rects);
}

const ptsSig = (pts) => pts.map((p) => `${r2(p.x)},${r2(p.y)}`).join(" ");

// The local walls one line makes. An open door, or a line Smoke has disabled, makes none. A window
// is a wall that isn't visible (light passes) but blocks. sides "pairs": two single-sided walls,
// the second wound the other way, instead of one double-sided wall (spec S4).
export function wallsOfLine(line, { sides = "double", blocking = true } = {}) {
  if (line.disabled || (line.kind === "door" && line.open)) return [];
  const visible = line.kind !== "window";
  const one = (key, pts, doubleSided) => ({
    key, points: pts.map((p) => ({ x: r2(p.x), y: r2(p.y) })), doubleSided, blocking, visible, kind: line.kind,
    sig: `${ptsSig(pts)}|${doubleSided ? "d" : "s"}|${blocking ? "b" : "o"}|${visible ? "v" : "h"}`,
  });
  if (sides === "pairs") return [one(`${line.id}:a`, line.pts, false), one(`${line.id}:b`, [...line.pts].reverse(), false)];
  return [one(line.id, line.pts, true)];
}

// Everything the walls probe builds on one screen.
//   scope "occupied": the maps a Spike-PC stands on, their lines and an edge wall round each;
//   scope "all": every map's edge, and every line in the scene.
//   blocking: false on a GM screen when "GM walls don't block" is on (the DM's drags pass).
// Returns {specs, maps: [ids], lines: n, segments: n}.
export function wallPlan(items, { dpi, scope = "occupied", sides = "double", blocking = true } = {}) {
  const rects = mapRects(items, dpi);
  const byId = new Map((items || []).map((i) => [i.id, i]));
  const inScope = scope === "all" ? new Set(rects.map((r) => r.id)) : occupiedMaps(items, rects, dpi);
  const specs = [];
  let lines = 0;
  for (const line of visionLines(items)) {
    if (scope !== "all" && !inScope.has(lineMap(line, rects, byId))) continue;
    const w = wallsOfLine(line, { sides, blocking });
    if (w.length) lines++;
    specs.push(...w);
  }
  for (const r of rects) {
    if (!inScope.has(r.id)) continue;
    const c = imageCorners(byId.get(r.id), dpi);
    specs.push(...wallsOfLine({ id: `edge:${r.id}`, kind: "edge", pts: [...c, { ...c[0] }] }, { sides, blocking }));
  }
  const segments = specs.reduce((a, s) => a + Math.max(0, s.points.length - 1), 0);
  return { specs, maps: [...inScope], lines, segments };
}

// ---- lights ----

// Feet to scene pixels, with the scene grid: `dpi` pixels per square of `multiplier` feet.
export function feetToPx(ft, dpi, multiplier = 5) {
  const m = finite(multiplier) && multiplier > 0 ? multiplier : 5;
  const d = finite(dpi) && dpi > 0 ? dpi : 150;
  return (ft / m) * d;
}

// One PRIMARY light per Spike-PC token, keyed by the token (the light follows it as an attachment,
// so a move changes nothing here).
export function lightPlan(items, { sourceRadius = 0, reachFt = 60, dpi = 150, multiplier = 5 } = {}) {
  const attenuation = r2(feetToPx(reachFt, dpi, multiplier));
  return (items || []).filter(isSpikePc).map((t) => {
    const c = itemCentre(t, dpi) || { x: 0, y: 0 }; // the light sits on the token's middle, then rides along
    return { key: t.id, of: t.id, position: { x: r2(c.x), y: r2(c.y) }, sourceRadius, attenuation,
             sig: `${sourceRadius}|${attenuation}` };
  });
}

// ---- doors ----

// A handle at the middle of every Smoke door (open or shut), keyed by its line.
export function doorPlan(items, { dpi = 150, locked = false } = {}) {
  const size = r2(dpi * 0.4);
  return visionLines(items).filter((l) => l.kind === "door").map((l) => {
    const at = midpointAlong(l.pts);
    const position = { x: r2(at.x), y: r2(at.y) };
    return { key: l.id, line: l.id, position, size, locked, sig: `${position.x},${position.y}|${size}|${locked ? "l" : "u"}` };
  });
}

// The handle (one of ours, by its metadata) nearest to p within `reach` scene px, or null.
export function nearestDoor(p, handles, reach) {
  let best = null, bestD = Infinity;
  for (const h of handles || []) {
    const d = Math.hypot(h.position.x - p.x, h.position.y - p.y);
    if (d <= reach && d < bestD) { best = h; bestD = d; }
  }
  return best;
}

// ---- S2: the fog-layer memory pieces ----

export const CMD = { MOVE: 0, LINE: 1, CLOSE: 5 }; // Owlbear's Command enum (obr-sdk.js)

const ring = (pts) => [[CMD.MOVE, r2(pts[0].x), r2(pts[0].y)], ...pts.slice(1).map((p) => [CMD.LINE, r2(p.x), r2(p.y)]), [CMD.CLOSE]];

// Over one map image: its corners, the left half (in the map's own frame) as path commands, and the
// whole map with a hole in its middle third (two rings: draw it with fillRule "evenodd").
export function memoryShapes(mapItem, dpi) {
  const c = imageCorners(mapItem, dpi);
  if (!c) return null;
  const [tl, tr, br, bl] = c;
  const at = (u, v) => ({ x: tl.x + u * (tr.x - tl.x) + v * (bl.x - tl.x), y: tl.y + u * (tr.y - tl.y) + v * (bl.y - tl.y) });
  const left = ring([tl, at(0.5, 0), at(0.5, 1), bl]);
  const holed = [...ring([tl, tr, br, bl]), ...ring([at(1 / 3, 1 / 3), at(2 / 3, 1 / 3), at(2 / 3, 2 / 3), at(1 / 3, 2 / 3)])];
  return { corners: c, left, holed };
}

// The S2 plan for the map `mapId`: three pieces, keyed copy, dim and hole. [] when the map is gone.
export function memoryPlan(items, mapId, dpi) {
  const map = (items || []).find((i) => i.id === mapId && isMapImage(i));
  const shapes = map && memoryShapes(map, dpi);
  if (!shapes) return [];
  const sig = `${mapId}|${ptsSig(shapes.corners)}`;
  return [
    { key: "copy", map, zIndex: -2, sig },
    { key: "dim", commands: shapes.left, opacity: 0.45, fillRule: "nonzero", zIndex: -1.5, sig },
    { key: "hole", commands: shapes.holed, opacity: 1, fillRule: "evenodd", zIndex: -1, sig },
  ];
}

// ---- matching the screen to a plan ----

// have: [{id, key, sig}] (our local items of one probe), want: [{key, sig}].
// -> {add: [want specs], del: [ids]}: anything changed, gone or doubled goes, anything new or
// changed comes.
export function diffByKey(have, want) {
  const wantBy = new Map((want || []).map((w) => [w.key, w]));
  const kept = new Set();
  const del = [];
  for (const h of have || []) {
    const w = wantBy.get(h.key);
    if (!w || w.sig !== h.sig || kept.has(h.key)) del.push(h.id);
    else kept.add(h.key);
  }
  const add = (want || []).filter((w) => !kept.has(w.key));
  return { add, del };
}

// ---- the frame meter ----

export function percentile(list, p) {
  const xs = (list || []).filter((x) => finite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[Math.min(xs.length, rank) - 1];
}

// One window of requestAnimationFrame: `intervals` are the ms between frames, `spanMs` the window's
// length. fps = frames per second over the window; low10 = the 10th-percentile frame rate (the
// rate of the frame at the 90th percentile of frame time); worstMs = the longest frame.
export function frameStats(intervals, spanMs) {
  const xs = (intervals || []).filter((x) => finite(x) && x >= 0);
  if (!xs.length) return { fps: null, low10: null, worstMs: null, frames: 0 };
  const span = finite(spanMs) && spanMs > 0 ? spanMs : xs.reduce((a, b) => a + b, 0);
  const p90 = percentile(xs, 90);
  return { fps: r1((xs.length * 1000) / span), low10: p90 > 0 ? r1(1000 / p90) : null, worstMs: r1(Math.max(...xs)), frames: xs.length };
}

// Long tasks in one window (PerformanceObserver "longtask" durations, ms).
export function longTaskStats(durations) {
  const xs = (durations || []).filter((x) => finite(x));
  return { ltMs: r1(xs.reduce((a, b) => a + b, 0)) ?? 0, ltN: xs.length, ltMax: xs.length ? r1(Math.max(...xs)) : 0 };
}

// Event-loop lag in one window: how late each 50 ms timer fired (ms).
export function lagStats(lags) {
  const xs = (lags || []).filter((x) => finite(x));
  if (!xs.length) return { lagMean: null, lagP90: null, lagMax: null };
  return { lagMean: r1(xs.reduce((a, b) => a + b, 0) / xs.length), lagP90: r1(percentile(xs, 90)), lagMax: r1(Math.max(...xs)) };
}

// ---- the results ----

const pad2 = (n) => String(n).padStart(2, "0");
export function clock(t) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const show = (x, unit = "") => (x === null || x === undefined ? "-" : `${x}${unit}`);

// One history entry as a line of text.
export function historyLine(e) {
  const t = clock(e.t);
  if (e.ev === "phase") return `${t}  == phase: ${e.label}`;
  if (e.ev === "settings") return `${t}  -- settings: ${e.label}`;
  if (e.ev === "door") return `${t}  ** door ${e.door} by ${e.name} (${e.kind}) via ${e.via}`;
  if (e.ev === "note") return `${t}  ## ${e.label}`;
  const r = e.r || {};
  return `${t}  ${e.kind.padEnd(6)} ${String(e.name).slice(0, 18).padEnd(18)} fps ${show(r.fps).padStart(5)}  low10 ${show(r.low10).padStart(5)}`
    + `  worst ${show(r.worstMs, "ms").padStart(7)}  lt ${show(r.ltMs, "ms")}/${show(r.ltN)}  bg-lt ${show(r.bgLtMs, "ms")}`
    + `  lag90 ${show(r.lagP90, "ms")}  | lights ${show(e.s?.lights)} walls ${show(e.s?.walls)} | ${e.probes || ""}`;
}

const mean = (xs) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// Per phase, per probe settings, per screen: how many readings, mean fps, mean and lowest low10,
// the worst frame, mean long-task ms per window and mean lag p90.
export function summarize(history) {
  const groups = new Map();
  for (const e of history || []) {
    if (e.ev !== "reading" || !e.r) continue;
    const k = `${e.phase || ""}\u0000${e.probes || ""}\u0000${e.conn}`;
    if (!groups.has(k)) groups.set(k, { phase: e.phase || "", probes: e.probes || "", kind: e.kind, name: e.name, rows: [] });
    groups.get(k).rows.push(e.r);
  }
  return [...groups.values()].map((g) => {
    const v = (f) => g.rows.map(f).filter((x) => finite(x));
    const lows = v((r) => r.low10);
    return { phase: g.phase, probes: g.probes, kind: g.kind, name: g.name, n: g.rows.length,
             fps: mean(v((r) => r.fps)), low10: mean(lows), low10Min: lows.length ? Math.min(...lows) : null,
             worstMs: v((r) => r.worstMs).length ? Math.max(...v((r) => r.worstMs)) : null,
             ltMs: mean(v((r) => r.ltMs)), lagP90: mean(v((r) => r.lagP90)) };
  });
}

// The plain text "Copy results" gives: a summary table, then (raw) every history line.
export function resultsText(history, { raw = true, now = Date.now() } = {}) {
  const out = [`Vision spike results, copied ${new Date(now).toISOString()}`,
    "fps/low10 come from requestAnimationFrame in the spike's small meter popover: only a proxy for Owlbear's own render loop.",
    "", "SUMMARY (phase | probes | screen: readings, mean fps, mean low10, lowest low10, worst frame, mean long-task ms per 2 s, mean lag p90)"];
  const rows = summarize(history);
  if (!rows.length) out.push("  (no frame readings)");
  for (const s of rows) {
    out.push(`  ${s.phase || "(no phase)"} | ${s.probes || "-"} | ${s.kind} ${s.name}: n=${s.n} fps=${show(s.fps)} low10=${show(s.low10)}`
      + ` min-low10=${show(s.low10Min)} worst=${show(s.worstMs, "ms")} lt=${show(s.ltMs, "ms")} lag90=${show(s.lagP90, "ms")}`);
  }
  if (raw) {
    out.push("", "HISTORY");
    for (const e of history || []) out.push(historyLine(e));
  }
  return out.join("\n");
}

// The GM that posts table readings to the panel log: the smallest connection id among the GM
// screens heard from lately (so two GM tabs don't post twice).
export function leaderOf(gmConns) {
  const xs = [...(gmConns || [])].filter((x) => typeof x === "string" && x).sort();
  return xs[0] || null;
}
