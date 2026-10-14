// The explored squares for the vision layer (docs/vision-layer-spec.md section 6, "Seen squares";
// the contract is docs/vision-layer-b4.md section 4): which squares of each map the party has
// seen, kept in the map image's shared metadata (SEEN_KEY {v, cols, rows, bits}, fog/bitset.js).
// Tracked on EVERY map whatever its mode, so remembering a building later is retroactive. Written
// by ONE GM screen, the answerer (fog/doors.js isAnswerer, handed on as ctx.isAnswerer()): the
// players, the projector and every other GM screen compute nothing and write nothing.
// fog/memory.js draws from the value on every screen. fog.js calls sync() on each pass while 🌫 Our
// fog is on, clear() when it goes off; while it is off this file does nothing at all.
//
//   SEEN_EVERY_MS            recompute at most this often (a trailing run: the last move counts)
//   SEEN_WRITE_MS            one map's SEEN_KEY written at most this often
//   darkReachFt(item, vctx)  🌑: how far a PC sees by itself, feet: max(SELF_SIGHT, its darkvision,
//                            its own light's reach)
//   cellsSeen(snap)          -> Map(mapId -> sorted square indices): what the party sees NOW (pure)
//   seenInputSig(snap)       -> string: everything cellsSeen depends on (pure)
//   mergeSeen(value, cells, grid)  -> {value, added}: value = the whole new SEEN_KEY value, or null
//                            when nothing is new (pure; a value of another size starts empty)
//   createSeen(api, ctx)     -> {sync(snap), clear(), forget(), status()}
//
// What a PC sees (cellsSeen): from its middle, on the map under its middle (the topmost), the line
// of sight polygon (fog/los.js visibilityPolygon) among the sight blockers of that map's lines (and
// lines on no map) plus the map's edge ring, as far as its sight light reaches (fog/sight.js
// sightReachFt). The edge ring keeps sight on its map, so only the maps a PC stands on cost
// anything, and a wall past the reach is clipped away before the sweep. A square counts once its
// CENTRE is inside the polygon (fog/los.js seenCells). Standing in 🌑 a square counts only within
// the PC's own reach (darkReachFt) or within some public light's reach: a torch seen far off
// doesn't reveal the dark in between.
//
// The writer (createSeen, on the answerer only):
//   - recomputes when seenInputSig changes, at most once per SEEN_EVERY_MS (one trailing timer);
//   - keeps, per map, the squares seen and not yet in the shared value (pending), with the grid
//     they were computed on (a new grid drops them);
//   - writes the maps due (SEEN_WRITE_MS since their last write) in ONE updateItems, each draft's
//     value united with the pending squares (mergeSeen on the DRAFT, never the snapshot, so a
//     Forget written meanwhile isn't undone with old squares), assigned whole: never a key deleted
//     (the live lesson of 2026-10-12: a JSON-patch "remove" of a missing key desyncs other screens).
//     The write goes on its own: sync() never waits for it (fog.js's pass doesn't hang on a shared
//     round-trip), one write at a time, SEEN_WRITE_TIMEOUT_MS without an answer is a failure, and a
//     failure backs off (SEEN_WRITE_MS doubling to SEEN_RETRY_MAX_MS, one log line per new error);
//   - spots a Forget: the shared value lost squares this screen wrote (once the echo of its own
//     write was due). That map's pending squares are dropped, and the squares the party sees now
//     go back in on the next write, so a Forget with PCs on the map fogs over and their sight
//     comes back within about SEEN_WRITE_MS;
//   - a lost update (two GM screens both answering for a moment) is put back by the next pass
//     that still sees those squares: every write is an idempotent union.
// ctx (fog.js partCtx): isAnswerer(), snapshot(), timers (setTimeout, clearTimeout and now), log(text,
// kind). api: {OBR}.

import { SEEN_KEY } from "../keys.js?v=7f44662";
import { SELF_SIGHT, effectiveLight, visionOf } from "../fx/lightmeta.js?v=7f44662";
import { centreOf, mapAt } from "../views.js?v=7f44662";
import { createBits, decode, encode, getBit, setBits } from "./bitset.js?v=7f44662";
import { edgeWalls, segmentsOf } from "./lines.js?v=7f44662";
import { seenCells, sightBlockers, visibilityPolygon } from "./los.js?v=7f44662";
import { seenOf } from "./maps.js?v=7f44662";
import { sightReachFt } from "./sight.js?v=7f44662";

export const SEEN_EVERY_MS = 1000;
export const SEEN_WRITE_MS = 5000;
// After a write, the snapshot may still show the value from before it for a moment (Owlbear's echo
// comes back through scene.items.onChange): a value that lacks our squares is taken as a Forget only
// when it isn't that old value, or when the echo is this late.
const ECHO_MS = SEEN_WRITE_MS;
// A failed write (RateLimitHit, a dropped connection) is tried again after SEEN_WRITE_MS, doubling
// up to SEEN_RETRY_MAX_MS (review of B4: every pass mustn't hammer a pushing-back Owlbear), by its own
// timer too; a write that gets no answer in SEEN_WRITE_TIMEOUT_MS counts as failed. The write runs
// on its own (review of B4): sync() never waits for the shared round-trip, so fog.js's pass (walls,
// sight, doors, memory on the DM's screen) never hangs on it.
export const SEEN_RETRY_MAX_MS = 30000;
export const SEEN_WRITE_TIMEOUT_MS = 15000;

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const r1 = (x) => Math.round(x) + 0;
const r2 = (x) => Math.round(x * 100) / 100 + 0;
const gridKey = (g) => (g ? `${g.cols}x${g.rows}@${g.cell}` : "");
const rawOf = (item) => JSON.stringify(item?.metadata?.[SEEN_KEY] ?? null);

// ---- what the party sees (pure) ----

export function darkReachFt(item, vctx = {}) {
  const v = safe(() => visionOf(item, vctx || {}), null);
  const light = safe(() => effectiveLight(item, vctx?.lighting));
  const own = light && finite(light.reach) && light.reach > 0 ? light.reach : 0;
  const dark = v && finite(v.dark) && v.dark > 0 ? v.dark : 0;
  return Math.max(SELF_SIGHT, dark, own);
}

const mapsById = (snap) => new Map((Array.isArray(snap?.maps) ? snap.maps : []).filter((m) => m?.id != null).map((m) => [m.id, m]));

// The public lights (fx/darkness.js darknessCtx: [{x, y, reach}], scene px and feet) that light anything.
const litLights = (vctx) => (Array.isArray(vctx?.lights) ? vctx.lights : [])
  .filter((l) => l && finite(l.x, l.y, l.reach) && l.reach > 0);

// One PC: {mapId, map, c, reachPx, dark: {reachPx} | null}, or null when it sees nothing anywhere.
function pcView(pc, snap, byMap) {
  const dpi = snap?.grid?.dpi, pxPerFt = snap?.grid?.pxPerFt;
  if (!finite(dpi, pxPerFt) || !(pxPerFt > 0)) return null;
  const c = centreOf(pc, dpi);
  if (!c || !finite(c.x, c.y)) return null;
  const mapId = mapAt(c, snap.rects);
  const map = mapId != null ? byMap.get(mapId) : null;
  if (!map || !map.grid) return null;
  const ft = safe(() => sightReachFt(pc, snap.vctx || {}), 0);
  const reachPx = finite(ft) && ft > 0 ? ft * pxPerFt : 0;
  if (!(reachPx > 0)) return null;
  const where = safe(() => visionOf(pc, snap.vctx || {}).where, null);
  const dark = where === "dark" ? { ft: darkReachFt(pc, snap.vctx || {}) } : null;
  return { id: pc.id, mapId, map, c, ft, reachPx, dark };
}

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
  const pcs = Array.isArray(snap?.pcs) ? snap.pcs : [];
  if (!pcs.length) return out;
  const byMap = mapsById(snap);
  const dpi = snap?.grid?.dpi, pxPerFt = snap?.grid?.pxPerFt;
  const lines = Array.isArray(snap?.lines) ? snap.lines : [];
  const blockersOf = new Map(); // mapId -> its sight blockers (worked out once per map)
  const lights = litLights(snap?.vctx);
  const marks = new Map(); // mapId -> Set of indices
  const done = new Set();
  for (const pc of pcs) {
    if (pc?.id == null || done.has(pc.id)) continue;
    done.add(pc.id);
    const v = pcView(pc, snap, byMap);
    if (!v) continue;
    if (!blockersOf.has(v.mapId)) {
      const own = lines.filter((l) => l && (l.mapId === v.mapId || l.mapId == null));
      blockersOf.set(v.mapId, sightBlockers([...segmentsOf(own), ...edgeWalls(v.map.item, dpi)]));
    }
    const poly = visibilityPolygon(v.c, blockersOf.get(v.mapId), v.reachPx);
    if (poly.length < 3) continue;
    let cells = seenCells([poly], v.map.grid);
    if (v.dark) cells = inTheDark(cells, v.map.grid, v.c, v.dark.ft * pxPerFt, lights, pxPerFt);
    if (!cells.length) continue;
    if (!marks.has(v.mapId)) marks.set(v.mapId, new Set());
    const set = marks.get(v.mapId);
    for (const i of cells) set.add(i);
  }
  for (const [id, set] of marks) out.set(id, [...set].sort((a, b) => a - b));
  return out;
}

// Everything cellsSeen reads, and nothing else: each PC's id, middle (to 1 px), reach and whether it
// stands in 🌑 (with its own reach there), the public lights (only while some PC is in 🌑), each
// line's id, map, kind, open, disabled and points, each map's id, rect and grid.
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
  const lights = anyDark ? litLights(snap?.vctx).map((l) => [r1(l.x), r1(l.y), l.reach]) : [];
  const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter(Boolean).map((l) => [l.id, l.mapId ?? null, l.kind,
    !!l.open, !!l.disabled, (Array.isArray(l.points) ? l.points : []).map((p) => (p && finite(p.x, p.y) ? [r2(p.x), r2(p.y)] : null))]);
  const maps = [...byMap.values()].map((m) => [m.id, m.rect ? [r2(m.rect.x0), r2(m.rect.y0), r2(m.rect.x1), r2(m.rect.y1)] : null,
    m.grid ? [m.grid.x0, m.grid.y0, m.grid.cell, m.grid.cols, m.grid.rows] : null]);
  return JSON.stringify([dpi ?? null, snap?.grid?.pxPerFt ?? null, pcs, lights, lines, maps]);
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

  let epoch = 0; // a clear()/forget() moves it on: anything in flight from before is dropped
  let alive = false; // a sync ran since the last clear()
  let writer = false; // this screen was the answerer on the last sync
  let lastSnap = null;
  let lastSig = null, lastComputeAt = -Infinity, computeMs = 0, computes = 0;
  let current = new Map(); // mapId -> {gridKey, cells: sorted indices}: what the party saw at the last compute
  let gen = 0; // bumped by each compute
  let folded = new Map(); // mapId -> `${gen}|${raw}`: current already compared with this shared value
  let pending = new Map(); // mapId -> {grid, gridKey, cells: Set}
  let wrote = new Map(); // mapId -> {gridKey, cells, set, raw, before: Set, at, confirmed}: this screen's last write
  let lastWrite = new Map(); // mapId -> when it was last written
  let firstSaid = new Set(); // maps whose first write this switch-on was logged
  let wakeT = null, wakeAt = null;
  let writes = 0, lastWriteAt = null, lastError = null;
  let inflight = null; // {timer}: the write on its way (one at a time)
  let retryAt = -Infinity, backoff = 0, saidError = null; // after a failed write: nothing before retryAt

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
  }

  function dropMap(id) {
    current.delete(id);
    folded.delete(id);
    pending.delete(id);
    wrote.delete(id);
  }

  function nameOf(m) { return String(m?.name || m?.item?.name || m?.id || "a map"); }

  // A Forget (or a resize): the shared value lost squares this screen wrote.
  function spotForgets(snap, byMap, t) {
    for (const [id, rec] of [...wrote]) {
      const m = byMap.get(id);
      if (!m) { dropMap(id); continue; }
      if (gridKey(m.grid) !== rec.gridKey) {
        wrote.delete(id);
        pending.delete(id);
        folded.delete(id);
        log(`${nameOf(m)} changed size, starting again`);
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
      log(`${nameOf(m)} forgotten, starting again`);
    }
  }

  function compute(snap, t) {
    const t0 = clock();
    const seen = cellsSeen(snap);
    computeMs = r2(clock() - t0);
    computes++;
    lastComputeAt = t;
    gen++;
    const byMap = mapsById(snap);
    current = new Map();
    for (const [id, cells] of seen) {
      const m = byMap.get(id);
      if (m?.grid) current.set(id, { gridKey: gridKey(m.grid), cells });
    }
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

  async function write(due, byMap, t, e) {
    const ids = [...due.keys()];
    const results = new Map(); // id -> {value, before}
    await OBR().scene.items.updateItems(ids, (drafts) => {
      for (const d of drafts) {
        const p = due.get(d.id);
        if (!p || !d.metadata || typeof d.metadata !== "object") continue;
        const before = JSON.stringify(d.metadata[SEEN_KEY] ?? null);
        const r = mergeSeen(d.metadata[SEEN_KEY], p.cells, p.grid);
        results.set(d.id, { value: r.value, before });
        if (r.value) d.metadata[SEEN_KEY] = r.value; // whole: never a key deleted, never one field patched
      }
    });
    if (e !== epoch) return 0;
    let n = 0;
    for (const [id, p] of due) {
      const r = results.get(id);
      // p is a copy taken when the write started: squares seen while it was on its way stay pending
      const live = pending.get(id);
      if (live && live.gridKey === p.gridKey) {
        for (const i of p.cells) live.cells.delete(i);
        if (!live.cells.size) pending.delete(id);
      }
      if (!r || !r.value) continue;
      n++;
      lastWrite.set(id, t);
      const m = byMap.get(id);
      const cells = [...p.cells].sort((a, b) => a - b);
      wrote.set(id, { gridKey: p.gridKey, cells, set: new Set(cells), raw: JSON.stringify(r.value),
        before: new Set([r.before, rawOf(m?.item)]), at: t, confirmed: false });
      if (!firstSaid.has(id)) {
        firstSaid.add(id);
        log(`first explored squares written on ${nameOf(m)} (${p.cells.size})`);
      }
    }
    if (n) { writes++; lastWriteAt = t; }
    return n;
  }

  async function doSync(snap) {
    const was = writer;
    writer = answerer();
    if (!writer) {
      if (was) log("this screen no longer writes the explored squares");
      if (was || alive) reset(); // pending, records and timers dropped; no Owlbear call
      return { skipped: true, computed: false, writing: 0, pending: 0, failed: false, error: null };
    }
    if (!was) log("this screen writes the explored squares (the lowest GM connection)");
    alive = true;
    lastSnap = snap;
    const e = epoch;
    const t = now();
    const byMap = mapsById(snap);
    for (const id of [...current.keys(), ...pending.keys()]) if (!byMap.has(id)) dropMap(id);
    spotForgets(snap, byMap, t);
    for (const [id, p] of [...pending]) if (gridKey(byMap.get(id)?.grid) !== p.gridKey) pending.delete(id);

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

    // Start the write of the maps due (one call, on its own: never awaited here); a timer for the
    // next one due. While a write is on its way, none starts; it wakes the writer when it settles.
    const due = new Map();
    let next = Infinity;
    for (const [id, p] of pending) {
      if (!p.cells.size) { pending.delete(id); continue; }
      const at = dueAt(id);
      if (at <= t) due.set(id, { grid: p.grid, gridKey: p.gridKey, cells: new Set(p.cells) });
      else next = Math.min(next, at);
    }
    let writing = 0;
    if (due.size && !inflight) {
      startWrite(due, byMap, t, e);
      writing = due.size;
    }
    if (next < Infinity) wake(next);
    // A failed write is reported (fog.js logs it and passes again) until a write works; the retry
    // itself waits for retryAt whatever passes come.
    return { skipped: false, computed, writing, pending: pendingCount(), failed: !!lastError, error: lastError };
  }

  // When a map's pending squares may be written: SEEN_WRITE_MS after its last write, never before
  // retryAt after a failure.
  function dueAt(id) {
    return Math.max((lastWrite.get(id) ?? -Infinity) + SEEN_WRITE_MS, retryAt);
  }

  function startWrite(due, byMap, t, e) {
    const me = { timer: null };
    inflight = me;
    const timeout = new Promise((_, reject) => {
      me.timer = T.setTimeout(() => {
        me.timer = null;
        reject(new Error(`no answer from Owlbear in ${Math.round(SEEN_WRITE_TIMEOUT_MS / 1000)} s`));
      }, SEEN_WRITE_TIMEOUT_MS);
    });
    const job = write(due, byMap, t, e);
    job.catch(() => {}); // a write that times out and fails later is no unhandled rejection
    Promise.race([job, timeout]).then(() => {
      if (e !== epoch || inflight !== me) return;
      if (lastError) log(`the explored squares write worked again`);
      lastError = null;
      saidError = null;
      backoff = 0;
      retryAt = -Infinity;
    }, (err) => {
      if (e !== epoch || inflight !== me) return;
      lastError = String(err?.message || err);
      backoff = backoff ? Math.min(SEEN_RETRY_MAX_MS, backoff * 2) : SEEN_WRITE_MS;
      retryAt = now() + backoff;
      if (lastError !== saidError) {
        saidError = lastError;
        log(`✖ the explored squares write failed (tried again in ${Math.round(backoff / 1000)} s, then less often): ${lastError}`);
      }
    }).finally(() => {
      if (me.timer != null) safe(() => T.clearTimeout(me.timer));
      me.timer = null;
      if (e !== epoch || inflight !== me) return;
      inflight = null;
      // the next write due (squares seen meanwhile, or the retry), by the timer
      let at = Infinity;
      for (const [id, p] of pending) if (p.cells.size) at = Math.min(at, dueAt(id));
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
      lastError = String(err?.message || err);
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
    return Promise.resolve({ cleared: true });
  }

  // The scene closed: the same.
  function forget() {
    clear();
  }

  function status() {
    return { writer: answerer(), maps: current.size, pending: pendingCount(), writes, lastWriteAt, computeMs, computes,
      writing: !!inflight, retryAt: finite(retryAt) ? retryAt : null,
      error: lastError };
  }

  return { sync, clear, forget, status };
}
