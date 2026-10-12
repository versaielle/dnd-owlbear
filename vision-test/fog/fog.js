// Our own vision layer's lifecycle (docs/vision-layer-spec.md sections 9-11; the builders' contract
// is docs/vision-layer-b2b3.md, this file is its section 4 "fog.js"): the scene switch "🌫 Our fog",
// one snapshot per pass for the three drawing parts (fog/sight.js: a light per PC, fog/walls.js: the
// local walls, fog/doors.js: the door handles, their menus and the leader's door checks), the
// throttle, and the leader GM screen's shared writes.
//
//   SETTLE_MS, MAX_WAIT_MS, RETRY_MS, RETRY_MAX_MS, FOG_COLOR, LEADER_RECHECK_MS, LEADER_WAIT_MS,
//   LEADER_SLOW_MS
//   SMOKE_VISION_OFF        Smoke & Spectre's own scene switch "Disable Vision" (its 5.0.4 MetadataKeys
//                           FOG_DISABLE_VISION): true = Smoke draws no vision lights in this scene
//   cleanFog(v)             FOG_KEY's value made safe: {v: 1, on, at, prev: {filled, color} | null}
//   fogOn(sceneMeta)        is 🌫 Our fog on in this scene
//   switchValue(raw, on, now)   what a click on 🌫 Our fog writes: {v: 1, on, at: now, prev?} (prev kept)
//   writeSwitch(OBR, on, now)   that write (any GM screen: the DM's click; the 🔥 Lighting list uses it)
//   smokeVision(sceneMeta, items)   {here, on}: Smoke runs in this scene (its sceneId, a token it
//                           gives sight), and its vision isn't switched off there
//   inputSig(sceneMeta) / roomSig(roomMeta)   the metadata a pass depends on
//   buildSnapshot(items, sceneMeta, roomMeta, grid, ctx)   the one snapshot every part plans from (pure)
//   createFog(api, ctx, opts) -> {start(), stop(), status(), setOn(on), kick(), snapshot()}
//
// INERT WHEN OFF. While the scene's FOG_KEY.on isn't true, this file only watches the scene's
// metadata (and whether a scene is open): no local item, no write, no menu, no item listener. The
// three parts are made the first time the switch is seen on. Smoke & Spectre works as today.
//
// SAME PICTURE EVERYWHERE. Every screen that draws (GM tabs, the projector's Cast receiver, phones;
// never a copy that only relays) builds its lights, walls and handles from the same snapshot. The
// one screen-dependent choice is the GM pass-through, ctx.gmPass (contract section 8): "B" (the
// default) puts each PC's light standalone on a GM screen, so no wall stops the DM's moves there.
//
// ONE WRITER. Shared writes come only from the leader GM screen (opts.isLeader: the lights writer's
// gate, fx/lightwriter.js), except the DM's own click on the switch:
//   - 🌫 Our fog turns on: the fog fill and colour found are kept in FOG_KEY.prev (once: an existing
//     prev is the scene's own from before), the fill goes on and black, and every door line that has
//     both formats takes Smoke's state (fog/lines.js drift: Smoke was in charge until now);
//   - it turns off: prev goes back on the fog, and FOG_KEY loses prev.
// The leader does each once per switch time (FOG_KEY.at). A GM screen that isn't the leader yet (the
// lights writer's 35 s warm-up) looks again every LEADER_RECHECK_MS while something is due, for
// LEADER_WAIT_MS: by then the leader (another GM screen, or this one) has usually done it. When
// nobody has (the scene still says so: FOG_KEY.prev waiting to go back, or no prev kept at a
// switch-on), it keeps looking every LEADER_SLOW_MS for as long as that lasts: no GM screen may
// lead for a while (GM screens on different builds, an old build open), and a fog left black
// would hide the map from Smoke's players. kick() also looks while something is due, and
// background.js kicks whenever the lights writer's gate changes.
//
// PASSES. One at a time (a request during one gives one more after it); stop() waits for the one
// in flight, which checks after every await that it still should draw, so a copy stepping aside
// mid-pass never adds items after its own clean-up. Item changes settle for SETTLE_MS, but a long
// drag still gets a pass every MAX_WAIT_MS. Scene and room metadata trigger a pass only when an
// input changed (FOG_KEY, SCENE_LIGHTING_KEY, Smoke's Disable Vision; PARTY_SENSES_KEY,
// PARTY_KEY). A grid change re-reads the grid. A scene closing forgets every
// record (Owlbear drops local items with it); a scene opening gets a pass that sweeps. A part whose
// sync fails is synced again after RETRY_MS, doubling to RETRY_MAX_MS. Each part skips a sync whose
// plan is unchanged, so a pass with nothing new asks nothing of Owlbear. The walls go first, so a
// switch-on never shows a light before the walls that stop it.
//
// While on, a GM screen whose scene also has Smoke's vision on gets one notification per switch-on,
// and status().smoke says so for the 🔥 Lighting list: both would draw fog.

import { FOG_KEY, FOG_LOCAL_KEY, PARTY_KEY, PARTY_SENSES_KEY, SCENE_LIGHTING_KEY, SMOKE } from "../keys.js?v=3fa571c";
import { planCtx } from "../fx/lightwriter.js?v=3fa571c";
import { readGrid } from "../fx/darkness.js?v=3fa571c";
import { mapRects } from "../views.js?v=3fa571c";
import { doorEdit, drift, occupiedMaps, readLines } from "./lines.js?v=3fa571c";
import { createSight } from "./sight.js?v=3fa571c";
import { createWalls } from "./walls.js?v=3fa571c";
import { createDoors } from "./doors.js?v=3fa571c";

export const SETTLE_MS = 150; // item changes settle this long before a pass
export const MAX_WAIT_MS = 750; // ...but a long drag still gets a pass this often
export const RETRY_MS = 2000; // a failed sync is tried again after this, doubling...
export const RETRY_MAX_MS = 30000; // ...up to this
export const LEADER_RECHECK_MS = 5000; // a GM screen with a leader's write due, but not the leader yet, looks again...
export const LEADER_WAIT_MS = 60000; // ...this long (the lights writer's warm-up is 35 s; then some GM screen leads)
export const LEADER_SLOW_MS = 30000; // ...then this often, while the scene shows nobody did it
export const FOG_COLOR = "#000000"; // solid black on the projector and the phones (spike S5)
export const SMOKE_VISION_OFF = `${SMOKE}/disableVision`;
const SMOKE_SCENE_ID = `${SMOKE}/sceneId`; // Smoke writes it the first time it runs in a scene
const SMOKE_HAS_VISION = `${SMOKE}/hasVision`;

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const describe = (e) => e?.error?.message || e?.message || String(e);

// ---- the switch (pure) ----

export function cleanFog(v) {
  const o = isObj(v) ? v : {};
  const p = isObj(o.prev) ? o.prev : null;
  const prev = p ? { filled: p.filled === true, color: typeof p.color === "string" && p.color ? p.color : null } : null;
  return { v: 1, on: o.on === true, at: finite(o.at) ? o.at : 0, prev };
}

export const fogOn = (sceneMeta) => cleanFog(sceneMeta?.[FOG_KEY]).on;

// A click on 🌫 Our fog: on or off, now; the prev the leader kept stays (it puts it back itself).
export function switchValue(raw, on, now) {
  const cur = cleanFog(raw);
  const out = { v: 1, on: !!on, at: finite(now) ? now : 0 };
  if (cur.prev) out.prev = cur.prev;
  return out;
}

export async function writeSwitch(OBR, on, now = Date.now()) {
  const meta = (await OBR.scene.getMetadata()) || {};
  const next = switchValue(meta[FOG_KEY], on, now);
  await OBR.scene.setMetadata({ [FOG_KEY]: next });
  return next;
}

// Is Smoke & Spectre drawing vision in this scene? `here`: it has run in it (the scene id it writes)
// or a token has its sight; `on`: here, and its "Disable Vision" isn't set (Smoke then makes no
// vision lights at all). Its own local walls may stay either way (not checked live yet).
export function smokeVision(sceneMeta, items) {
  const m = isObj(sceneMeta) ? sceneMeta : {};
  const here = m[SMOKE_SCENE_ID] != null
    || (Array.isArray(items) ? items : []).some((i) => i?.metadata?.[SMOKE_HAS_VISION] === true);
  return { here, on: here && m[SMOKE_VISION_OFF] !== true };
}

const stable = (x) => JSON.stringify(x ?? null);
export const inputSig = (m) => stable([m?.[FOG_KEY], m?.[SCENE_LIGHTING_KEY], m?.[SMOKE_VISION_OFF] === true]);
export const roomSig = (m) => stable([m?.[PARTY_SENSES_KEY], m?.[PARTY_KEY]]);

// ---- the snapshot (pure) ----

// grid: {dpi, ftPerCell, pxPerFt} (fx/darkness.js readGrid). ctx: {isPc(item), pcTokens, party}.
export function buildSnapshot(items, sceneMeta, roomMeta, grid, ctx = {}, at = 0) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i?.id != null);
  const sm = isObj(sceneMeta) ? sceneMeta : {};
  const rm = isObj(roomMeta) ? roomMeta : {};
  const g = grid && finite(grid.dpi) && grid.dpi > 0 ? grid : { dpi: 150, ftPerCell: 5, pxPerFt: 30 };
  const isPc = (i) => { try { return !!ctx.isPc?.(i); } catch { return false; } };
  const rects = mapRects(list, g.dpi);
  const party = Array.isArray(ctx.party) && ctx.party.length ? ctx.party : undefined;
  return {
    items: list, byId: new Map(list.map((i) => [i.id, i])), sceneMeta: sm, roomMeta: rm, grid: g,
    fog: cleanFog(sm[FOG_KEY]), rects, lines: readLines(list, { dpi: g.dpi, rects }),
    pcs: list.filter(isPc), occupied: occupiedMaps(list, { isPc, rects, dpi: g.dpi }),
    vctx: planCtx(list, sm, rm, { pcTokens: ctx.pcTokens ?? null, party, grid: g }), at,
  };
}

// ---- the lifecycle on one screen ----

// api: background.js's sdk ({OBR, buildLight, buildWall, buildShape, ...}). ctx: background.js's
// (role, kind, host, conn, playerId, name, isPc, pcTokens, party, log; read live, through getters).
// opts: {isLeader(), ownToken(), gmPass "A" | "B", doorTap, timers, makers ({sight, walls, doors}:
// the offline check's fakes)}.
export function createFog(api = {}, ctx = {}, opts = {}) {
  const O = api.OBR;
  const T = opts.timers || ctx.timers || {
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now(),
  };
  const host = ctx.host ?? "";
  const isGm = () => ctx.role === "GM";
  const leader = () => { try { return isGm() && !!opts.isLeader?.(); } catch { return false; } };
  const log = (t) => { try { ctx.log?.(`fog: ${t}`); } catch { /* nowhere to say it */ } };
  const makers = { sight: createSight, walls: createWalls, doors: createDoors, ...(opts.makers || {}) };

  let running = false, sceneReady = false, drawing = false;
  let items = null, sceneMeta = {}, roomMeta = {}, grid = null, gridStale = true;
  let metaSig = null, rSig = null;
  let snap = null;
  let parts = null; // {sight, walls, doors}, made the first time the switch is seen on
  const partErrors = {};
  let unsubs = [], drawUnsubs = [];
  let busy = false, again = false, passes = 0, current = null; // current: the run in flight
  let settleT = null, firstAt = null, retryT = null, retryMs = RETRY_MS, leaderT = null;
  let doneOn = null, warnedAt = null; // the FOG_KEY.at the leader's switch-on work / the Smoke note was done for
  let owing = null; // {key, since}: a leader's write this GM screen saw due while it wasn't the leader
  let lastError = null, smoke = { here: false, on: false };

  // The ctx the three parts get (contract section 2), read live from background.js's.
  const partCtx = {
    get role() { return ctx.role; }, get isGm() { return isGm(); }, get kind() { return ctx.kind; },
    get host() { return host; }, get conn() { return ctx.conn; }, get playerId() { return ctx.playerId; },
    get name() { return ctx.name; },
    isLeader: leader,
    isPc: (i) => { try { return !!ctx.isPc?.(i); } catch { return false; } },
    ownToken: () => { try { return opts.ownToken?.() ?? null; } catch { return null; } },
    get gmPass() { return opts.gmPass === "A" ? "A" : "B"; },
    get doorTap() { return !!opts.doorTap; },
    snapshot: () => snap,
    timers: T,
    log: (t) => { try { ctx.log?.(t); } catch { /* quiet */ } },
  };

  function makeParts() {
    if (parts) return parts;
    parts = {};
    for (const name of ["sight", "walls", "doors"]) {
      try {
        parts[name] = makers[name](api, partCtx);
      } catch (e) {
        parts[name] = null;
        partErrors[name] = describe(e);
        log(`${name} didn't start: ${partErrors[name]}`);
      }
    }
    return parts;
  }
  const each = (f) => { for (const p of Object.values(parts || {})) if (p) f(p); };

  // ---- passes: one at a time ----

  function run() {
    if (!running) return current || Promise.resolve();
    if (busy) {
      again = true;
      return current;
    }
    busy = true;
    current = (async () => {
      try {
        do {
          again = false;
          await pass();
        } while (again && running);
      } catch (e) {
        lastError = describe(e);
        log(`pass failed: ${lastError}`);
        retry();
      } finally {
        busy = false;
        current = null;
      }
    })();
    return current;
  }

  function soon() {
    if (!running || !drawing) return;
    const now = T.now();
    if (firstAt == null) firstAt = now;
    if (settleT) T.clearTimeout(settleT);
    settleT = T.setTimeout(() => {
      settleT = null;
      firstAt = null;
      run();
    }, Math.max(0, Math.min(SETTLE_MS, firstAt + MAX_WAIT_MS - now)));
  }

  function retry() {
    if (retryT || !running) return;
    const ms = retryMs;
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    retryT = T.setTimeout(() => {
      retryT = null;
      run();
    }, ms);
  }

  function leaderLater(ms = LEADER_RECHECK_MS) {
    if (leaderT || !running || !isGm()) return;
    leaderT = T.setTimeout(() => {
      leaderT = null;
      run();
    }, ms);
  }

  async function pass() {
    if (!running || !sceneReady) return;
    passes++;
    const fog = cleanFog(sceneMeta[FOG_KEY]);
    let failed = null;
    try {
      await leaderWork(fog);
    } catch (e) {
      // the shared write failed (tried again after RETRY_MS, doubling): our drawing goes on
      failed = `leader: ${describe(e)}`;
      log(`the leader's write failed: ${describe(e)}`);
    }
    if (!running) return; // stop() came meanwhile: it cleans up
    if (!fog.on) {
      if (drawing) await bringDown();
      lastError = failed;
      if (failed) retry();
      else retryMs = RETRY_MS;
      return;
    }
    if (!drawing) await bringUp();
    if (!running || !drawing) return;
    if (gridStale || !grid) {
      grid = await readGrid(O);
      gridStale = false;
    }
    if (!running || !drawing) return; // stopped or switched off while it read: nothing more of ours goes on
    if (!items) items = await O.scene.items.getItems();
    if (!running || !drawing) return;
    snap = buildSnapshot(items, sceneMeta, roomMeta, grid, ctx, T.now());
    smoke = smokeVision(sceneMeta, items);
    if (isGm() && smoke.on && warnedAt !== fog.at) {
      warnedAt = fog.at;
      note("🌫 Our fog is on, and Smoke & Spectre's vision is on in this scene too: switch on “Disable Vision” in Smoke's settings", "WARNING");
    }
    // The walls first: a light never shows before the walls that stop it.
    for (const name of ["walls", "sight", "doors"]) {
      if (!running || !drawing) return;
      const p = parts[name];
      if (!p) continue;
      let r = null;
      try {
        r = await p.sync(snap);
      } catch (e) {
        r = { failed: true, error: describe(e) };
      }
      if (r?.failed) failed = `${name}: ${r.error || "failed"}`;
    }
    lastError = failed;
    if (failed) retry();
    else retryMs = RETRY_MS;
  }

  // Our items come on: the parts, the door menus, and the listeners only a drawing screen needs.
  async function bringUp() {
    makeParts();
    drawing = true;
    items = null;
    gridStale = true;
    const sub = (f) => {
      try {
        const u = f();
        if (typeof u === "function") drawUnsubs.push(u);
      } catch (e) {
        log(`can't watch: ${describe(e)}`);
      }
    };
    sub(() => O.scene.items.onChange((list) => {
      items = Array.isArray(list) ? list : null;
      soon();
    }));
    sub(() => O.scene.grid?.onChange?.(() => {
      gridStale = true;
      soon();
    }));
    sub(() => O.room?.onMetadataChange?.((m) => {
      const s = roomSig(m);
      roomMeta = isObj(m) ? m : {};
      if (s === rSig) return;
      rSig = s;
      soon();
    }));
    try {
      roomMeta = (await O.room?.getMetadata?.()) || {};
      rSig = roomSig(roomMeta);
    } catch { /* an older Owlbear: the party's names come from ctx */ }
    try {
      await parts.doors?.start?.();
    } catch (e) {
      partErrors.doors = describe(e);
    }
    log("on: drawing our sight, walls and doors here");
  }

  // ...and off: menus, listeners, every local item of ours on this screen.
  async function bringDown() {
    drawing = false;
    for (const u of drawUnsubs.splice(0)) { try { u(); } catch { /* gone */ } }
    if (settleT) T.clearTimeout(settleT);
    if (retryT) T.clearTimeout(retryT);
    settleT = retryT = null;
    firstAt = null;
    retryMs = RETRY_MS;
    snap = null;
    items = null;
    try { await parts?.doors?.stop?.(); } catch (e) { log(`doors stop: ${describe(e)}`); }
    for (const name of ["sight", "walls", "doors"]) {
      try { await parts?.[name]?.clear?.(); } catch (e) { log(`${name} clear: ${describe(e)}`); }
    }
    await sweep();
    lastError = null;
    log("off: our items are gone from this screen; Smoke & Spectre as before");
  }

  // Every local item of ours (this host's), whatever made it: an earlier page's, a part's that failed.
  async function sweep() {
    try {
      const left = await O.scene.local.getItems((i) => i?.metadata?.[FOG_LOCAL_KEY]?.host === host);
      if (left?.length) await O.scene.local.deleteItems(left.map((i) => i.id));
      return left?.length || 0;
    } catch {
      return 0; // no scene: its local items went with it
    }
  }

  function note(text, variant = "INFO") {
    try {
      const p = O.notification?.show?.(text, variant);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* fine */ }
  }

  // ---- the leader's shared writes ----

  // What the leader still owes this switch state: "on" (keep prev, fill black, adopt drift), "off"
  // (put prev back), or null.
  const due = (fog) => (fog.on ? (doneOn === fog.at ? null : "on") : fog.prev ? "off" : null);

  async function leaderWork(fog) {
    const owe = due(fog);
    if (!owe || !isGm()) {
      owing = null;
      return;
    }
    if (!leader()) {
      const key = `${owe}|${fog.at}`;
      if (owing?.key !== key) owing = { key, since: T.now() };
      // After LEADER_WAIT_MS, go on looking (slowly) only while the scene shows nobody has done it:
      // prev still waiting to go back, or none kept at this switch-on.
      if (T.now() - owing.since < LEADER_WAIT_MS) leaderLater(LEADER_RECHECK_MS);
      else if (owe === "off" || !fog.prev) leaderLater(LEADER_SLOW_MS);
      return;
    }
    owing = null;
    if (owe === "on") {
      const fill = O.scene.fog;
      if (!fog.prev) {
        const prev = { filled: (await fill.getFilled()) === true, color: (await fill.getColor()) || null };
        // Only onto the switch as it stands now (the DM may have clicked again meanwhile).
        const now = cleanFog(((await O.scene.getMetadata()) || {})[FOG_KEY]);
        if (!now.on || now.at !== fog.at) return;
        await O.scene.setMetadata({ [FOG_KEY]: { v: 1, on: true, at: fog.at, prev } });
      }
      if ((await fill.getFilled()) !== true) await fill.setFilled(true);
      if (String((await fill.getColor()) || "").toLowerCase() !== FOG_COLOR) await fill.setColor(FOG_COLOR);
      const list = items || (await O.scene.items.getItems());
      const drifted = list.filter((i) => i?.type === "CURVE" && drift(i.metadata)).map((i) => i.id);
      if (drifted.length) {
        await O.scene.items.updateItems(drifted, (ds) => {
          for (const d of ds) {
            const c = drift(d.metadata);
            if (c) doorEdit(d.metadata, c);
          }
        });
        log(`adopted Smoke's door state on ${drifted.length} line(s)`);
      }
      doneOn = fog.at;
      log("switched on: the fog is filled black (its own fill and colour kept to put back)");
      return;
    }
    // off: put the scene's own fill and colour back, then drop prev
    const now = cleanFog(((await O.scene.getMetadata()) || {})[FOG_KEY]);
    if (now.on || !now.prev) return;
    await O.scene.fog.setFilled(now.prev.filled);
    if (now.prev.color) await O.scene.fog.setColor(now.prev.color);
    await O.scene.setMetadata({ [FOG_KEY]: { v: 1, on: false, at: now.at } });
    log("switched off: the fog's own fill and colour are back");
  }

  // ---- watching the scene ----

  function onSceneMeta(m) {
    sceneMeta = isObj(m) ? m : {};
    const s = inputSig(sceneMeta);
    if (s === metaSig) return;
    metaSig = s;
    run();
  }

  async function onReady(r) {
    sceneReady = !!r;
    items = null;
    snap = null;
    gridStale = true;
    metaSig = null;
    if (!sceneReady) {
      // Owlbear dropped every local item with the scene: forget, write nothing.
      if (parts) {
        try { parts.sight?.forget?.(); } catch { /* fine */ }
        for (const name of ["walls", "doors"]) {
          try { await parts[name]?.clear?.(); } catch { /* the scene is gone */ }
        }
      }
      return;
    }
    try { onSceneMeta(await O.scene.getMetadata()); } catch (e) { log(`can't read the scene: ${describe(e)}`); }
  }

  async function start() {
    if (running) return;
    running = true;
    const sub = (f) => {
      try {
        const u = f();
        if (typeof u === "function") unsubs.push(u);
      } catch (e) {
        log(`can't watch: ${describe(e)}`);
      }
    };
    sub(() => O.scene.onMetadataChange((m) => onSceneMeta(m)));
    sub(() => O.scene.onReadyChange((r) => { onReady(r); }));
    let ready = false;
    try { ready = !!(await O.scene.isReady()); } catch { ready = false; }
    if (!running) return;
    if (ready) await sweep(); // an earlier page of ours may have left items on this scene
    await onReady(ready);
  }

  async function stop() {
    if (!running) return;
    running = false;
    for (const u of unsubs.splice(0)) { try { u(); } catch { /* gone */ } }
    for (const t of [leaderT, settleT, retryT]) if (t) T.clearTimeout(t);
    leaderT = settleT = retryT = null;
    // The pass in flight first (it stops at its next await): then nothing of it lands after this.
    if (current) { try { await current; } catch { /* run() keeps its own errors */ } }
    if (drawing) await bringDown();
    else await sweep();
  }

  // kick(): an input background.js holds changed (the heartbeat's PC ids, the party; the lights
  // writer's gate): a pass while drawing, and while off too when a leader's write is still due.
  function kick() {
    if (drawing) soon();
    else if (running && sceneReady && isGm() && due(cleanFog(sceneMeta[FOG_KEY]))) run();
  }

  // The DM's click on 🌫 Our fog (any GM screen).
  async function setOn(on) {
    if (!isGm()) return { ok: false, text: "Only the DM switches 🌫 Our fog" };
    if (!(await O.scene.isReady())) return { ok: false, text: "Open a scene first" };
    await writeSwitch(O, on, T.now());
    return { ok: true, text: on ? "🌫 Our fog is on" : "🌫 Our fog is off: Smoke & Spectre as before" };
  }

  function status() {
    const st = (name) => { try { return parts?.[name]?.status?.() ?? null; } catch (e) { return { error: describe(e) }; } };
    const fog = cleanFog(sceneMeta[FOG_KEY]);
    return {
      running, ready: sceneReady, on: fog.on, drawing, leader: leader(), gm_pass: partCtx.gmPass, passes,
      smoke: fog.on ? smoke : null, sight: st("sight"), walls: st("walls"), doors: st("doors"),
      errors: { ...partErrors }, error: lastError,
    };
  }

  return { start, stop, status, setOn, kick, snapshot: () => snap };
}
