// The explored memory's writer for the vision layer (docs/vision-layer-b4.md section 4, and its "As
// built: smooth memory" section; the contract is docs/vision-layer-2024.md section 4). Two keys on each
// map image, written together in ONE draft of one updateItems:
//   EXPLORED_KEY  the smooth memory: the shapes the party has seen, cut by the walls and doors as they
//                 stood (fog/shapes.js). The only thing fog/memory.js draws from.
//   SEEN_KEY      B4's squares (fog/bitset.js): still written exactly as before, never drawn (decision 80
//                 of the plan: tested code, Forget detection and a record for after Thursday).
// Tracked on EVERY map whatever its mode, so remembering a building later is retroactive. Written by
// ONE GM screen, the seen writer (fog/doors.js isSeenWriter, handed on as ctx.isAnswerer(): the lowest
// GM connection whose hello says it writes the shapes): the players, the projector and every other GM
// screen compute nothing and write nothing. fog.js calls sync() on each pass while 🌫 Our fog is on,
// clear() when it goes off; while it is off this file does nothing at all.
//
//   SEEN_EVERY_MS            recompute at most this often (a trailing run: the last move counts)
//   SEEN_WRITE_MS            one map written at most this often
//   CLIP_WAIT_MS             a new writer waits this long for the polygon library before it writes the
//                            squares alone
//   darkReachFt(item, vctx)  🌑: how far a PC sees by itself, feet (fog/shapes.js's stand-in, re-exported)
//   cellsSeen(snap)          -> Map(mapId -> sorted square indices): what the party sees NOW (pure)
//   seenInputSig(snap)       -> string: everything cellsSeen and seenShapes depend on (pure)
//   mergeSeen(value, cells, grid)  -> {value, added}: value = the whole new SEEN_KEY value, or null
//                            when nothing is new (pure; a value of another size starts empty)
//   createSeen(api, ctx)     -> {sync(snap), clear(), forget(), status()}
//
// What a PC sees: fog/shapes.js pcViews (where it stands, how far it sees, whether it's in 🌑) and
// sightBlockersOf (its map's walls, closed doors and edge ring). The SQUARES (cellsSeen): a square
// counts once its CENTRE is inside the PC's line-of-sight polygon (fog/los.js seenCells); in 🌑 only
// within the PC's own reach or a public light's. The SHAPES (fog/shapes.js seenShapes): that polygon
// itself, in 🌑 cut down to the PC's own circle and the public lights' circles, never rounded.
//
// The writer (createSeen, on the seen writer only):
//   - loads the polygon library (fog/clipper.js, a literal import) when this screen becomes the writer,
//     and waits for it up to CLIP_WAIT_MS before writing anything; if it doesn't load, the squares are
//     still written, the shapes stay as they were, and the 🪵 Live log says so once;
//   - recomputes when seenInputSig changes, at most once per SEEN_EVERY_MS (one trailing timer);
//   - keeps, per map, what was seen and not yet written (pending): the squares not in the shared value,
//     and the union of every shape seen since the last write;
//   - a map is due SEEN_WRITE_MS after its last write. A due map's shapes are written only when they
//     grow its explored area by more than MIN_GROW of a square (checked against the snapshot's value
//     first, so nothing is asked of Owlbear for a PC standing still);
//   - writes the maps due in ONE updateItems, each draft's values united with the pending ones
//     (mergeSeen and mergeExplored on the DRAFT, never the snapshot, so a Forget written meanwhile isn't
//     undone with old memory), assigned whole: never a key deleted (the live lesson of 2026-10-12: a
//     JSON-patch "remove" of a missing key desyncs other screens). At most EXPLORED_CALL_MAX_BYTES of
//     shapes go in one call: a map over it waits for the next write (at least one map always goes);
//   - over EXPLORED_MAX_BYTES a map's edges are kept rougher (fog/shapes.js HARDER_PX); still over, that
//     map's explored memory stops growing (said once in the log) until Forget explored;
//   - the write goes on its own: sync() never waits for it (fog.js's pass doesn't hang on a shared
//     round-trip), one write at a time, SEEN_WRITE_TIMEOUT_MS without an answer is a failure, and a
//     failure backs off (SEEN_WRITE_MS doubling to SEEN_RETRY_MAX_MS, one log line per new error);
//   - spots a Forget: the shared value lost what this screen wrote (the squares it set, or explored
//     area it wrote), once the echo of its own write was due. That map's pending memory is dropped,
//     and what the party sees now goes back in on the next write, so a Forget with PCs on the map
//     fogs over and their sight comes back within about SEEN_WRITE_MS;
//   - a lost update (two GM screens both writing for a moment) is put back by the next pass that
//     still sees it: every write is an idempotent union.
// ctx (fog.js partCtx): isAnswerer(), snapshot(), timers (setTimeout, clearTimeout and now), log(text,
// kind). api: {OBR}; the checks may pass clip (the library, already loaded) or loadClip() (a promise
// of it).

import { EXPLORED_KEY, RULES_KEY, SEEN_KEY } from "../keys.js?v=d96a2d9";
import { visionOf } from "../fx/lightmeta.js?v=d96a2d9";
import { centreOf, mapRects } from "../views.js?v=d96a2d9";
import { createBits, decode, encode, getBit, setBits } from "./bitset.js?v=d96a2d9";
import { seenCells, visibilityPolygon } from "./los.js?v=d96a2d9";
import { seenOf } from "./maps.js?v=d96a2d9";
import { EXPLORED_CALL_MAX_BYTES, areaOf, clipOk, darkReachFt, decodeRings, litLights, litLightsOn, mergeExplored, pcViews, readValue,
  rectSize, seenShapes, sightBlockersOf, uniteRings } from "./shapes.js?v=d96a2d9";
import { sightReachFt } from "./sight.js?v=d96a2d9";

export { darkReachFt } from "./shapes.js?v=d96a2d9";

export const SEEN_EVERY_MS = 1000;
export const SEEN_WRITE_MS = 5000;
// After a write, the snapshot may still show the value from before it for a moment (Owlbear's echo
// comes back through scene.items.onChange): a value that lacks what we wrote is taken as a Forget only
// when it isn't that old value, or when the echo is this late.
const ECHO_MS = SEEN_WRITE_MS;
// A failed write (RateLimitHit, a dropped connection) is tried again after SEEN_WRITE_MS, doubling
// up to SEEN_RETRY_MAX_MS (review of B4: every pass mustn't hammer a pushing-back Owlbear), by its own
// timer too; a write that gets no answer in SEEN_WRITE_TIMEOUT_MS counts as failed. The write runs
// on its own (review of B4): sync() never waits for the shared round-trip, so fog.js's pass (walls,
// sight, doors, memory on the DM's screen) never hangs on it.
export const SEEN_RETRY_MAX_MS = 30000;
export const SEEN_WRITE_TIMEOUT_MS = 15000;
// The polygon library: a new writer waits for it this long (so its first write carries both keys),
// then writes the squares alone; a failed load is tried again after CLIP_RETRY_MS.
export const CLIP_WAIT_MS = 10000;
export const CLIP_RETRY_MS = 60000;

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const r1 = (x) => Math.round(x) + 0;
const r2 = (x) => Math.round(x * 100) / 100 + 0;
const gridKey = (g) => (g ? `${g.cols}x${g.rows}@${g.cell}` : "");
const sizeKey = (rect) => { const s = rectSize(rect); return s ? `${s.w}x${s.h}` : ""; };
const rawOf = (item) => JSON.stringify(item?.metadata?.[SEEN_KEY] ?? null);
const rawExp = (item) => JSON.stringify(item?.metadata?.[EXPLORED_KEY] ?? null);
const describe = (e) => String(e?.message || e);
const shareText = (a) => (a >= 10 ? `${Math.round(a / 10)}%` : `${(a / 10).toFixed(1)}%`);

// ---- what the party sees (pure) ----

const mapsById = (snap) => new Map((Array.isArray(snap?.maps) ? snap.maps : []).filter((m) => m?.id != null).map((m) => [m.id, m]));

// The squares (indices) of `cells` a PC in 🌑 sees: centre strictly within its own reach of c, or
// strictly within a light's (strictly: SELF_SIGHT, 5 ft, is its own square only, not the four whose
// centres lie exactly 5 ft off).
function inTheDark(cells, grid, c, ownPx, lights, pxPerFt) {
  const ls = lights.map((l) => ({ x: l.x, y: l.y, r2: (l.reach * pxPerFt) ** 2 }));
  const own2 = ownPx * ownPx;
  const out = [];
  for (const i of cells) {
    const x = grid.x0 + ((i % grid.cols) + 0.5) * grid.cell, y = grid.y0 + (Math.floor(i / grid.cols) + 0.5) * grid.cell;
    const dx = x - c.x, dy = y - c.y;
    if (dx * dx + dy * dy < own2 || ls.some((l) => (x - l.x) ** 2 + (y - l.y) ** 2 < l.r2)) out.push(i);
  }
  return out;
}

export function cellsSeen(snap) {
  const out = new Map();
  const views = pcViews(snap);
  if (!views.length) return out;
  const pxPerFt = snap.grid.pxPerFt;
  const blockersOf = new Map(); // mapId -> its sight blockers (worked out once per map)
  const lightsOf = new Map(); // mapId -> the public lights on it (shapes.js litLightsOn: never another map's)
  const marks = new Map(); // mapId -> Set of indices
  for (const v of views) {
    if (!blockersOf.has(v.mapId)) blockersOf.set(v.mapId, sightBlockersOf(snap, v.mapId));
    if (!lightsOf.has(v.mapId)) lightsOf.set(v.mapId, litLightsOn(snap, v.mapId));
    const poly = visibilityPolygon(v.c, blockersOf.get(v.mapId), v.reachPx);
    if (poly.length < 3) continue;
    let cells = seenCells([poly], v.map.grid);
    if (v.dark) cells = inTheDark(cells, v.map.grid, v.c, v.dark.ft * pxPerFt, lightsOf.get(v.mapId), pxPerFt);
    if (!cells.length) continue;
    if (!marks.has(v.mapId)) marks.set(v.mapId, new Set());
    const set = marks.get(v.mapId);
    for (const i of cells) set.add(i);
  }
  for (const [id, set] of marks) out.set(id, [...set].sort((a, b) => a - b));
  return out;
}

// Everything cellsSeen and seenShapes read, and nothing else: each PC's id, middle (to 1 px), reach and
// whether it stands in 🌑 (with its own reach there), the public lights with their cones (only while
// some PC is in 🌑), each line's id, map, kind, open, disabled and points, each map's id, rect and grid;
// and for the 2024 rules (docs/vision-layer-2024.md): the obscured zones (snap.zones: id, level, map and
// ring, once the fog engine adds them) and the scene's 2024 switches (RULES_KEY, raw). A switch tapped,
// a zone ending or a cone turning recomputes with nobody moving.
export function seenInputSig(snap) {
  const byMap = mapsById(snap);
  const dpi = snap?.grid?.dpi;
  const pcs = [];
  let anyDark = false;
  for (const pc of Array.isArray(snap?.pcs) ? snap.pcs : []) {
    if (pc?.id == null) continue;
    const c = safe(() => centreOf(pc, dpi));
    const ft = safe(() => sightReachFt(pc, snap.vctx || {}), 0);
    const where = safe(() => visionOf(pc, snap.vctx || {}).where, null);
    const dark = where === "dark";
    if (dark) anyDark = true;
    pcs.push([pc.id, c && finite(c.x, c.y) ? [r1(c.x), r1(c.y)] : null, ft, dark ? darkReachFt(pc, snap.vctx || {}) : 0]);
  }
  const coneSig = (k) => (k == null ? null : [finite(k?.facing) ? r2(k.facing) : null, finite(k?.half) ? r2(k.half) : null]);
  const lights = anyDark ? litLights(snap?.vctx).map((l) => [r1(l.x), r1(l.y), l.reach, coneSig(l.cone)]) : [];
  const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter(Boolean).map((l) => [l.id, l.mapId ?? null, l.kind,
    !!l.open, !!l.disabled, (Array.isArray(l.points) ? l.points : []).map((p) => (p && finite(p.x, p.y) ? [r2(p.x), r2(p.y)] : null))]);
  const maps = [...byMap.values()].map((m) => [m.id, m.rect ? [r2(m.rect.x0), r2(m.rect.y0), r2(m.rect.x1), r2(m.rect.y1)] : null,
    m.grid ? [m.grid.x0, m.grid.y0, m.grid.cell, m.grid.cols, m.grid.rows] : null]);
  const zones = (Array.isArray(snap?.zones) ? snap.zones : []).filter(Boolean).map((z) => [z.id ?? null, z.level ?? null, z.mapId ?? null,
    (Array.isArray(z.points) ? z.points : []).map((p) => (p && finite(p.x, p.y) ? [r1(p.x), r1(p.y)] : null))]);
  const rules = snap?.sceneMeta?.[RULES_KEY] ?? null;
  return JSON.stringify([dpi ?? null, snap?.grid?.pxPerFt ?? null, pcs, lights, lines, maps, zones, rules]);
}

// ---- the shared value (pure) ----

// The whole SEEN_KEY value with `cells` added to `value` (a value of another size, or none, starts
// empty), and how many squares were new; value null when none was (nothing to write).
export function mergeSeen(value, cells, grid) {
  if (!grid || !Number.isInteger(grid.cols) || !Number.isInteger(grid.rows)) return { value: null, added: 0 };
  const b = decode(value, grid.cols, grid.rows) ?? createBits(grid.cols, grid.rows);
  if (!b) return { value: null, added: 0 };
  const added = setBits(b, cells instanceof Set ? [...cells] : cells);
  return { value: added ? encode(b) : null, added };
}

// ---- the writer ----

export function createSeen(api = {}, ctx = {}) {
  const OBR = () => api.OBR;
  const T = ctx.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const now = () => safe(() => T.now(), Date.now());
  const log = (text) => { try { ctx.log?.(text, "seen"); } catch { /* nowhere to say it */ } };
  const answerer = () => !!safe(() => ctx.isAnswerer?.(), false);
  const clock = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
  const loadClip = typeof api.loadClip === "function" ? api.loadClip : () => import("./clipper.js?v=d96a2d9").then((m) => m.default);

  let epoch = 0; // a clear()/forget() moves it on: anything in flight from before is dropped
  let alive = false; // a sync ran since the last clear()
  let writer = false; // this screen was the answerer on the last sync
  let lastSnap = null;
  let lastSig = null, lastComputeAt = -Infinity, computeMs = 0, computes = 0;
  let current = new Map(); // mapId -> {gridKey, cells: sorted indices}: the squares the party saw at the last compute
  let gen = 0; // bumped by each compute
  let folded = new Map(); // mapId -> `${gen}|${raw}`: current already compared with this shared value
  let pending = new Map(); // mapId -> {grid, gridKey, cells: Set}
  let wrote = new Map(); // mapId -> {gridKey, cells, set, raw, before: Set, at, confirmed}: this screen's last squares write
  let lastWrite = new Map(); // mapId -> when it was last written
  let firstSaid = new Set(); // maps whose first write this switch-on was logged
  let wakeT = null, wakeAt = null;
  let writes = 0, lastWriteAt = null, lastError = null;
  let inflight = null; // {timer}: the write on its way (one at a time)
  let retryAt = -Infinity, backoff = 0, saidError = null; // after a failed write: nothing before retryAt

  // The shapes (EXPLORED_KEY).
  let clip = clipOk(api.clip) ? api.clip : null; // the polygon library, once loaded
  let clipLoading = null, clipWaitUntil = null, clipTried = false, clipFailedAt = -Infinity, clipError = null;
  let clipSlowSaid = false;
  let curShapes = new Map(); // mapId -> {sizeKey, rings}: the shapes the party saw at the last compute
  let shapesFolded = new Map(); // mapId -> the gen whose shapes went into pending
  let pendShapes = new Map(); // mapId -> {sizeKey, rings, gen}: every shape seen since the last write
  let pendGen = 0;
  let checked = new Map(); // mapId -> {key, how}: the last check of pending against the shared value
  let wroteShapes = new Map(); // mapId -> {sizeKey, raw, value, area, before: Set, at, confirmed}
  let capped = new Set(); // maps whose memory is too big to grow (said once)
  let rough = new Set(); // maps whose edges were kept rougher (said once)
  let shapeSaid = new Set(); // shape errors said
  let shapeError = null, shapesMs = 0, unionMs = 0, expWrites = 0;
  const bytes = new Map(); // mapId -> the bytes of the last value this screen wrote there

  function sleep() {
    if (wakeT != null) safe(() => T.clearTimeout(wakeT));
    wakeT = null;
    wakeAt = null;
  }
  // One timer, at the earliest moment something is due (a trailing compute, a write).
  function wake(at) {
    if (!finite(at)) return;
    if (wakeT != null && wakeAt <= at) return;
    sleep();
    wakeAt = at;
    const e = epoch;
    wakeT = T.setTimeout(() => {
      wakeT = null;
      wakeAt = null;
      if (!alive || e !== epoch) return;
      const s = safe(() => ctx.snapshot?.(), null) || lastSnap;
      if (s) sync(s);
    }, Math.max(0, at - now()));
  }

  function reset() {
    epoch++;
    alive = false;
    sleep();
    if (inflight?.timer != null) safe(() => T.clearTimeout(inflight.timer));
    inflight = null; // a write still on its way lands in the old epoch: its result is dropped
    lastError = null; // a new writer (or none) starts without the old failure or its back-off
    saidError = null;
    backoff = 0;
    retryAt = -Infinity;
    lastSnap = null;
    lastSig = null;
    lastComputeAt = -Infinity;
    current = new Map();
    folded = new Map();
    pending = new Map();
    wrote = new Map();
    curShapes = new Map();
    shapesFolded = new Map();
    pendShapes = new Map();
    checked = new Map();
    wroteShapes = new Map();
    capped = new Set();
    rough = new Set();
    shapeError = null;
  }

  function dropMap(id) {
    current.delete(id);
    folded.delete(id);
    pending.delete(id);
    wrote.delete(id);
    curShapes.delete(id);
    shapesFolded.delete(id);
    pendShapes.delete(id);
    checked.delete(id);
    wroteShapes.delete(id);
    bytes.delete(id);
  }

  function nameOf(m) { return String(m?.name || m?.item?.name || m?.id || "a map"); }

  // ---- the polygon library ----

  function ensureClip() {
    if (clip || clipLoading || now() - clipFailedAt < CLIP_RETRY_MS) return;
    const first = !clipTried;
    clipTried = true;
    if (first) clipWaitUntil = now() + CLIP_WAIT_MS; // only the first try holds the writes back
    const job = Promise.resolve().then(() => loadClip());
    clipLoading = job;
    job.then((lib) => {
      if (!clipOk(lib)) throw new Error("fog/clipper.js didn't give the polygon library");
      clip = lib;
      clipLoading = null;
      clipWaitUntil = null;
      if (clipError) log("the explored memory's polygon library loaded: the explored memory grows again");
      clipError = null;
      lastSig = null; // recompute, now with the shapes
      if (alive) wake(now());
    }).catch((err) => {
      if (clipLoading !== job) return;
      clipLoading = null;
      clipWaitUntil = null;
      clipFailedAt = now();
      const text = describe(err);
      if (text !== clipError) {
        log(`✖ the explored memory's polygon library (fog/clipper.js) didn't load, so the explored memory stops growing`
          + ` (what's kept stays; tried again in ${Math.round(CLIP_RETRY_MS / 1000)} s): ${text}`);
      }
      clipError = text;
      if (alive) wake(now());
    });
  }

  function shapesFailed(m, err) {
    const text = describe(err);
    shapeError = text;
    const key = `${m?.id ?? ""}|${text}`;
    if (shapeSaid.has(key)) return;
    shapeSaid.add(key);
    log(`✖ the explored memory couldn't be worked out${m ? ` on ${nameOf(m)}` : ""} (it stays as it was): ${text}`);
  }

  function noteCapped(id, m) {
    if (capped.has(id)) return;
    capped.add(id);
    log(`✖ the explored memory on ${nameOf(m)} is too big to keep growing (over its size limit even with rougher edges):`
      + " it stays as it is there; Forget explored starts it again");
  }

  // ---- Forget ----

  // A Forget (or a resize): the shared value lost what this screen wrote (squares it set, or explored
  // area it wrote). Logged once per map, whichever key showed it.
  function spotForgets(snap, byMap, t) {
    const forgot = new Set();
    const resized = new Set();
    for (const [id, rec] of [...wrote]) {
      const m = byMap.get(id);
      if (!m) { dropMap(id); continue; }
      if (gridKey(m.grid) !== rec.gridKey) {
        wrote.delete(id);
        pending.delete(id);
        folded.delete(id);
        resized.add(id);
        continue;
      }
      const raw = rawOf(m.item);
      if (raw === rec.raw) { rec.confirmed = true; continue; }
      const b = decode(m.item?.metadata?.[SEEN_KEY], m.grid.cols, m.grid.rows);
      if (b && rec.cells.every((i) => getBit(b, i))) { rec.confirmed = true; continue; }
      if (!rec.confirmed && rec.before.has(raw) && t - rec.at < ECHO_MS) continue; // our echo isn't in yet
      wrote.delete(id);
      pending.delete(id);
      folded.delete(id); // what the party sees now goes back in
      forgot.add(id);
    }
    const dpi = snap?.grid?.dpi;
    const tol = finite(dpi) && dpi > 0 ? dpi * dpi : 22500; // one square: rougher edges written by another screen aren't a Forget
    for (const [id, rec] of [...wroteShapes]) {
      const m = byMap.get(id);
      if (!m) { dropMap(id); continue; }
      if (sizeKey(m.rect) !== rec.sizeKey) {
        wroteShapes.delete(id);
        pendShapes.delete(id);
        shapesFolded.delete(id);
        checked.delete(id);
        capped.delete(id);
        resized.add(id);
        continue;
      }
      const raw = rawExp(m.item);
      if (raw === rec.raw) { rec.confirmed = true; continue; }
      const read = readValue(m.item?.metadata?.[EXPLORED_KEY], m.rect);
      const area = read.valid && read.n > 0 ? areaOf(read.rings) : 0;
      if (area > 0 && area >= rec.area - Math.max(tol, 0.02 * rec.area)) {
        // another screen's union (or rougher edges) holds what this one wrote: that value is the one to watch now
        Object.assign(rec, { confirmed: true, raw, area: Math.max(rec.area, area) });
        continue;
      }
      if (!rec.confirmed && rec.before.has(raw) && t - rec.at < ECHO_MS) continue; // our echo isn't in yet
      wroteShapes.delete(id);
      pendShapes.delete(id);
      shapesFolded.delete(id); // what the party sees now goes back in
      checked.delete(id);
      capped.delete(id);
      rough.delete(id);
      forgot.add(id);
    }
    for (const id of resized) log(`${nameOf(byMap.get(id))} changed size, starting again`);
    for (const id of forgot) if (!resized.has(id)) log(`${nameOf(byMap.get(id))} forgotten, starting again`);
  }

  // ---- what the party sees, folded into pending ----

  function compute(snap, t) {
    const t0 = clock();
    const seen = cellsSeen(snap);
    computes++;
    lastComputeAt = t;
    gen++;
    const byMap = mapsById(snap);
    current = new Map();
    for (const [id, cells] of seen) {
      const m = byMap.get(id);
      if (m?.grid) current.set(id, { gridKey: gridKey(m.grid), cells });
    }
    curShapes = new Map();
    if (clip) {
      const t1 = clock();
      let shapes = null;
      try {
        shapes = seenShapes(snap, clip);
      } catch (err) {
        shapesFailed(null, err);
      }
      shapesMs = r2(clock() - t1);
      for (const [id, rings] of shapes || []) {
        const sk = sizeKey(byMap.get(id)?.rect);
        if (sk) curShapes.set(id, { sizeKey: sk, rings });
      }
    }
    computeMs = r2(clock() - t0);
  }

  // Each map's squares seen now and not in the shared value go to pending (once per compute and value).
  function fold(byMap) {
    for (const [id, cur] of current) {
      const m = byMap.get(id);
      if (!m?.grid || gridKey(m.grid) !== cur.gridKey) continue;
      const raw = rawOf(m.item);
      const k = `${gen}|${raw}`;
      if (folded.get(id) === k) continue;
      folded.set(id, k);
      const have = seenOf(m.item, m.grid);
      const mine = wrote.get(id)?.set; // written by this screen, its echo maybe not in yet
      const missing = cur.cells.filter((i) => !getBit(have, i) && !mine?.has(i));
      if (!missing.length) continue;
      let p = pending.get(id);
      if (!p || p.gridKey !== cur.gridKey) { p = { grid: m.grid, gridKey: cur.gridKey, cells: new Set() }; pending.set(id, p); }
      for (const i of missing) p.cells.add(i);
    }
  }

  // Each map's shapes seen now go into its pending union (once per compute).
  function foldShapes(byMap) {
    if (!clip) return;
    for (const [id, cur] of curShapes) {
      if (shapesFolded.get(id) === gen) continue;
      shapesFolded.set(id, gen);
      if (capped.has(id)) continue;
      const m = byMap.get(id);
      if (!m || sizeKey(m.rect) !== cur.sizeKey) continue;
      const p = pendShapes.get(id);
      try {
        const rings = p && p.sizeKey === cur.sizeKey ? uniteRings(p.rings, cur.rings, clip) : cur.rings;
        pendShapes.set(id, { sizeKey: cur.sizeKey, rings, gen: ++pendGen });
      } catch (err) {
        shapesFailed(m, err);
      }
    }
  }

  // Would this map's pending shapes grow the shared value? "grows" | "none" | "capped" | "error".
  // Against the snapshot's value, or this screen's own last write while its echo isn't in yet. Kept
  // per (pending, value), so a pass that changes neither checks nothing.
  function check(id, m, ps, dpi) {
    const rec = wroteShapes.get(id);
    const raw = rawExp(m.item);
    const mine = rec && !rec.confirmed && rec.before.has(raw);
    const key = `${ps.gen}|${mine ? rec.raw : raw}`;
    const was = checked.get(id);
    if (was?.key === key) return was.how;
    let how = "none";
    try {
      const t0 = clock();
      const r = mergeExplored(mine ? rec.value : m.item?.metadata?.[EXPLORED_KEY], ps.rings, m.rect, clip, { dpi });
      unionMs = r2(clock() - t0);
      how = r.value ? "grows" : r.capped ? "capped" : "none";
    } catch (err) {
      shapesFailed(m, err);
      how = "error";
    }
    checked.set(id, { key, how });
    return how;
  }

  // ---- the write ----

  async function write(due, byMap, t, e, dpi) {
    const ids = [...due.keys()];
    const results = new Map(); // id -> {seen, seenBefore, exp, expBefore, deferred, capped, simplified, error}
    await OBR().scene.items.updateItems(ids, (drafts) => {
      let room = EXPLORED_CALL_MAX_BYTES, anyShapes = false;
      for (const d of drafts) {
        const p = due.get(d.id);
        if (!p || !d.metadata || typeof d.metadata !== "object") continue;
        const res = { seen: null, seenBefore: null, exp: null, expBefore: null, deferred: false, capped: false, simplified: 0, error: null };
        if (p.cells) {
          res.seenBefore = JSON.stringify(d.metadata[SEEN_KEY] ?? null);
          res.seen = mergeSeen(d.metadata[SEEN_KEY], p.cells, p.grid).value;
        }
        if (p.shapes) {
          res.expBefore = JSON.stringify(d.metadata[EXPLORED_KEY] ?? null);
          try {
            const rect = mapRects([d], dpi)[0] || null; // the map as it stands now
            if (rect && sizeKey(rect) === p.shapes.sizeKey) {
              const t0 = clock();
              const r = mergeExplored(d.metadata[EXPLORED_KEY], p.shapes.rings, rect, clip, { dpi });
              unionMs = r2(clock() - t0);
              if (r.value && anyShapes && r.value.rings.length > room) res.deferred = true; // the next write takes it
              else if (r.value) { res.exp = r.value; res.simplified = r.simplified; room -= r.value.rings.length; anyShapes = true; }
              else res.capped = !!r.capped;
            }
          } catch (err) {
            res.error = err;
          }
        }
        // whole values: never a key deleted, never one field patched; nothing assigned that isn't new
        if (res.seen) d.metadata[SEEN_KEY] = res.seen;
        if (res.exp) d.metadata[EXPLORED_KEY] = res.exp;
        results.set(d.id, res);
      }
    });
    if (e !== epoch) return 0;
    let n = 0;
    for (const [id, p] of due) {
      const r = results.get(id);
      const m = byMap.get(id);
      // p is a copy taken when the write started: what was seen while it was on its way stays pending
      if (p.cells) {
        const live = pending.get(id);
        if (live && live.gridKey === p.gridKey) {
          for (const i of p.cells) live.cells.delete(i);
          if (!live.cells.size) pending.delete(id);
        }
      }
      if (p.shapes) {
        const live = pendShapes.get(id);
        const same = live && live.gen === p.shapes.gen;
        if (r?.capped) noteCapped(id, m);
        if (r?.error) shapesFailed(m, r.error);
        if (same && !r?.deferred) pendShapes.delete(id);
        checked.delete(id);
      }
      if (!r || (!r.seen && !r.exp)) continue;
      n++;
      if (!r.deferred) lastWrite.set(id, t); // a map whose shapes wait for the next call is due again at once
      if (r.seen) {
        const cells = [...p.cells].sort((a, b) => a - b);
        wrote.set(id, { gridKey: p.gridKey, cells, set: new Set(cells), raw: JSON.stringify(r.seen),
          before: new Set([r.seenBefore, rawOf(m?.item)]), at: t, confirmed: false });
      }
      if (r.exp) {
        expWrites++;
        wroteShapes.set(id, { sizeKey: p.shapes.sizeKey, raw: JSON.stringify(r.exp), value: r.exp, area: areaOf(decodeRings(r.exp.rings) || []),
          before: new Set([r.expBefore, rawExp(m?.item)]), at: t, confirmed: false });
        bytes.set(id, r.exp.rings.length);
        if (r.simplified && !rough.has(id)) {
          rough.add(id);
          log(`the explored memory on ${nameOf(m)} is near its size limit: its edges are kept rougher (${r.simplified} px)`);
        }
        if (!firstSaid.has(id)) {
          firstSaid.add(id);
          log(`first explored memory written on ${nameOf(m)} (${shareText(r.exp.a)} of the map)`);
        }
      }
    }
    if (n) { writes++; lastWriteAt = t; }
    return n;
  }

  async function doSync(snap) {
    const was = writer;
    writer = answerer();
    if (!writer) {
      if (was) log("this screen no longer writes the explored memory");
      if (was || alive) reset(); // pending, records and timers dropped; no Owlbear call
      return { skipped: true, computed: false, writing: 0, pending: 0, failed: false, error: null };
    }
    if (!was) log("this screen writes the explored memory (the lowest GM connection)");
    alive = true;
    lastSnap = snap;
    const e = epoch;
    const t = now();
    if (!clip) {
      ensureClip();
      // The first load: wait for it (briefly), so the first write carries both keys.
      if (clipLoading && clipWaitUntil != null && t < clipWaitUntil) {
        wake(clipWaitUntil);
        return { skipped: false, computed: false, writing: 0, pending: pendingCount(), failed: false, error: null, waiting: true };
      }
      if (clipLoading && !clipSlowSaid) {
        clipSlowSaid = true;
        log(`✖ the explored memory's polygon library hasn't loaded in ${Math.round(CLIP_WAIT_MS / 1000)} s: the explored memory`
          + " stops growing until it does");
      }
    }
    const byMap = mapsById(snap);
    const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
    for (const id of new Set([...current.keys(), ...pending.keys(), ...curShapes.keys(), ...pendShapes.keys()])) {
      if (!byMap.has(id)) dropMap(id);
    }
    spotForgets(snap, byMap, t);
    for (const [id, p] of [...pending]) if (gridKey(byMap.get(id)?.grid) !== p.gridKey) pending.delete(id);
    for (const [id, p] of [...pendShapes]) if (sizeKey(byMap.get(id)?.rect) !== p.sizeKey) pendShapes.delete(id);

    // Recompute: on a change, at most once per SEEN_EVERY_MS, the last one trailing.
    let computed = false;
    const sig = seenInputSig(snap);
    if (sig !== lastSig) {
      if (t - lastComputeAt >= SEEN_EVERY_MS) {
        compute(snap, t);
        lastSig = sig;
        computed = true;
      } else {
        wake(lastComputeAt + SEEN_EVERY_MS);
      }
    }
    fold(byMap);
    foldShapes(byMap);

    // The maps due: their squares, and their shapes when they'd grow the shared value. One write call
    // (on its own: never awaited here); a timer for the next one due. While a write is on its way, none
    // starts; it wakes the writer when it settles.
    const due = new Map();
    let next = Infinity;
    for (const id of new Set([...pending.keys(), ...pendShapes.keys()])) {
      const p = pending.get(id);
      if (p && !p.cells.size) pending.delete(id);
      const sq = !!(p && p.cells.size);
      const ps = pendShapes.get(id);
      if (!sq && !ps) continue;
      const at = dueAt(id);
      if (at > t) { next = Math.min(next, at); continue; }
      let shapes = null;
      if (ps && clip) {
        const m = byMap.get(id);
        const how = check(id, m, ps, dpi);
        if (how === "grows") shapes = { sizeKey: ps.sizeKey, rings: ps.rings, gen: ps.gen };
        else {
          if (how === "capped") noteCapped(id, m);
          pendShapes.delete(id); // nothing beyond what's stored (or it can't be kept): nothing to write
          checked.delete(id);
        }
      }
      if (sq || shapes) due.set(id, { grid: p?.grid, gridKey: p?.gridKey, cells: sq ? new Set(p.cells) : null, shapes });
    }
    let writing = 0;
    if (due.size && !inflight) {
      startWrite(due, byMap, t, e, dpi);
      writing = due.size;
    }
    if (next < Infinity) wake(next);
    // A failed write is reported (fog.js logs it and passes again) until a write works; the retry
    // itself waits for retryAt whatever passes come.
    return { skipped: false, computed, writing, pending: pendingCount(), failed: !!lastError, error: lastError };
  }

  // When a map's pending memory may be written: SEEN_WRITE_MS after its last write, never before
  // retryAt after a failure.
  function dueAt(id) {
    return Math.max((lastWrite.get(id) ?? -Infinity) + SEEN_WRITE_MS, retryAt);
  }

  function startWrite(due, byMap, t, e, dpi) {
    const me = { timer: null };
    inflight = me;
    const timeout = new Promise((_, reject) => {
      me.timer = T.setTimeout(() => {
        me.timer = null;
        reject(new Error(`no answer from Owlbear in ${Math.round(SEEN_WRITE_TIMEOUT_MS / 1000)} s`));
      }, SEEN_WRITE_TIMEOUT_MS);
    });
    const job = write(due, byMap, t, e, dpi);
    job.catch(() => {}); // a write that times out and fails later is no unhandled rejection
    Promise.race([job, timeout]).then(() => {
      if (e !== epoch || inflight !== me) return;
      if (lastError) log("the explored memory write worked again");
      lastError = null;
      saidError = null;
      backoff = 0;
      retryAt = -Infinity;
    }, (err) => {
      if (e !== epoch || inflight !== me) return;
      lastError = describe(err);
      backoff = backoff ? Math.min(SEEN_RETRY_MAX_MS, backoff * 2) : SEEN_WRITE_MS;
      retryAt = now() + backoff;
      if (lastError !== saidError) {
        saidError = lastError;
        log(`✖ the explored memory write failed (tried again in ${Math.round(backoff / 1000)} s, then less often): ${lastError}`);
      }
    }).finally(() => {
      if (me.timer != null) safe(() => T.clearTimeout(me.timer));
      me.timer = null;
      if (e !== epoch || inflight !== me) return;
      inflight = null;
      // the next write due (memory seen meanwhile, a map that waited for room, or the retry), by the timer
      let at = Infinity;
      for (const [id, p] of pending) if (p.cells.size) at = Math.min(at, dueAt(id));
      for (const id of pendShapes.keys()) at = Math.min(at, dueAt(id));
      if (at < Infinity) wake(Math.max(at, now()));
    });
  }

  function pendingCount() {
    let n = 0;
    for (const p of pending.values()) n += p.cells.size;
    return n;
  }

  // One at a time: a timer's run can't overlap fog.js's pass.
  let chain = Promise.resolve();
  function sync(snap) {
    const run = chain.then(() => doSync(snap)).catch((err) => {
      lastError = describe(err);
      log(`✖ sync failed: ${lastError}`);
      return { skipped: false, computed: false, writing: 0, pending: pendingCount(), failed: true, error: lastError };
    });
    chain = run.catch(() => {});
    return run;
  }

  // The switch went off (or fog.js stopped): timers off, everything dropped. Nothing is written:
  // the shared value is the scene's and stays.
  function clear() {
    reset();
    writer = false;
    firstSaid = new Set();
    lastWrite = new Map();
    shapeSaid = new Set();
    return Promise.resolve({ cleared: true });
  }

  // The scene closed: the same.
  function forget() {
    clear();
  }

  function status() {
    return { writer: answerer(), maps: current.size, pending: pendingCount(), writes, lastWriteAt, computeMs, computes,
      writing: !!inflight, retryAt: finite(retryAt) ? retryAt : null,
      error: lastError,
      explored: { maps: curShapes.size, pending: pendShapes.size, writes: expWrites, last_ms: unionMs, shapes_ms: shapesMs,
        bytes: bytes.size ? Math.max(...bytes.values()) : 0, capped: [...capped],
        lib: clip ? "loaded" : clipLoading ? "loading" : clipError ? "failed" : "not loaded",
        error: clipError || shapeError || null } };
  }

  return { sync, clear, forget, status };
}
