// Doors for the vision layer (docs/vision-layer-spec.md section 4, the contract in
// docs/vision-layer-b2b3.md sections 4, 6 and 9): a handle at the middle of every door, the
// right-click menus that work it, and the leader GM screen's checks and its one door write.
//
//   DOOR_REACH_FT, REPLY_WAIT_MS, PLAYER_OPS, GM_OPS, HANDLE_LAYER, MENU, menuIds(host) (the ids a copy uses)
//   handlePlan(snap)     one handle per door on an occupied map: [{key, line, position, size, open,
//                        locked, sig}] (key and line: the door line's id)
//   doorCheck(door, pcs, segments, grid)  can one of these PCs work this door: {ok, reason, pc}.
//                        A PC's middle must be within DOOR_REACH_FT of the door line and see the
//                        nearest point of it past `segments` (fog/los.js segments; the door's own
//                        are skipped). grid: {dpi, pxPerFt} (snap.grid)
//   checkRequest(req, snap, {fromGm})  the leader's answer to one request: {ok, why, change:
//                        {open?, locked?} | null (null: nothing to write), state: {open, locked}
//                        after it (null when it isn't a door)}
//   checkLive(req, snap, item, {fromGm})  the same against the door line as it stands NOW (item:
//                        the shared CURVE, or a draft of it; null: it's gone), the rest of the
//                        snapshot as it was: what the leader decides and writes from
//   opFor(state, {gm})   what a click on a door that stands so asks for: "open" | "close" | null
//   menuIcons(host, icon)  the menus' icons and filters, by MENU id
//   createDoors(api, ctx)  -> {start(), stop(), sync(snap), clear(), status(), ask(op, line, via)}
//
// Every screen, while 🌫 Our fog is on: a small LOCAL circle at each door's middle, on the PROP
// layer, under the fog (the fog hides the handles nobody sees, so door positions don't leak),
// tagged FOG_LOCAL_KEY {kind: "handle", key, sig, host, line, open, locked}. Its colour says how
// the door stands (shut, open, locked). A right-click on it (a long-press on a phone) shows our
// menu: 🚪 Open door / 🚪 Close door, or 🔒 Locked for a player; a GM also gets Lock / Unlock, and
// the same on the shared door lines themselves (either format). Owlbear shows one icon per menu,
// so a GM's Lock / Unlock is a second menu (MENU.handleLock, MENU.lineLock). After a menu click
// the handle is deselected. A plain click that selects a handle is left alone: a right-click
// selects it too, and taking the selection away then could close the very menu it opened (not
// tried live). With ctx.doorTap, a select asks for the opposite of how the door stands, and
// deselects. A handle isn't locked, so a player can drag it: it goes back to its door
// SNAP_BACK_MS after the drag.
//
// Every click is a request on FOG_DOOR_CH to every screen; only the leader (ctx.isLeader(), the
// lights writer's gate) acts on it, one request at a time: it reads the door line as it stands now
// (the snapshot is up to MAX_WAIT_MS old: a lock the DM just made, or an open a moment ago, isn't
// in it yet), runs checkLive, writes the change in one updateItems through fog/lines.js doorEdit
// (both formats in step, contract section 6) after checking once more against the draft it
// writes, and answers on FOG_DOOR_REPLY_CH from that last check. The sender shows the answer's
// `why`, or "No DM screen answered" after REPLY_WAIT_MS. A DM's request (dm: true) skips the checks only when its sender's
// connection is a GM's. Players never write scene items.
//
// The handles are reconciled like fx/lighting.js: what was drawn is remembered (key -> {id, sig}),
// nothing is asked of Owlbear while the plan's signature is unchanged, at most one local delete,
// one add and one update per sync, and our items are read back only after a clear or a failure.
// Syncs and clears run one at a time, so a clear can't slip in while a sync's add is on its way.

import { FOG_DOOR_CH, FOG_DOOR_REPLY_CH, FOG_LOCAL_KEY, WALL_KEY } from "../keys.js?v=3fa571c";
import { forMe, here, newId, on, send } from "../bus.js?v=3fa571c";
import { centreOf } from "../views.js?v=3fa571c";
import { canSee, sightBlockers } from "./los.js?v=3fa571c";
import { SMOKE_LINE, doorEdit, edgeWalls, midpointAlong, nearestOnLine, readLine, segmentsOf } from "./lines.js?v=3fa571c";

export const DOOR_REACH_FT = 5; // from the PC's middle to the nearest point of the door line
export const REPLY_WAIT_MS = 4000; // no answer by then: "No DM screen answered"
export const PLAYER_OPS = ["open", "close"];
export const GM_OPS = ["open", "close", "lock", "unlock"];
export const HANDLE_LAYER = "PROP"; // under the fog
export const HANDLE_SIZE = 0.4; // squares across
export const SNAP_BACK_MS = 300; // a dragged handle goes back to its door this long after the drag
// The right-click menus. Owlbear shows ONE icon per menu (the first whose filter matches), so
// open/close and lock/unlock are two menus each.
export const MENU = {
  handle: "dnd-npc/fog/handle", handleLock: "dnd-npc/fog/handle-lock",
  line: "dnd-npc/fog/line-door", lineLock: "dnd-npc/fog/line-door-lock",
};
// Owlbear's menu ids are room-wide, so the copy served by this PC ("local") uses its own, as
// background.js LOCAL_MENU_IDS does: when it steps aside for the Pages copy on the Dell's tab, its
// stop() can only ever remove its own menus, never the Pages copy's.
export const menuIds = (host) => (host === "local"
  ? Object.fromEntries(Object.entries(MENU).map(([k, id]) => [k, id.replace("dnd-npc/", "dnd-npc/local/")]))
  : MENU);
export const NO_ANSWER = "No DM screen answered";
const COLOUR = { shut: "#ff8c1a", open: "#3cb371", locked: "#d23c3c" };
const CHANGE = { open: { open: true }, close: { open: false }, lock: { locked: true }, unlock: { locked: false } };

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const tagOf = (i) => (isObj(i?.metadata?.[FOG_LOCAL_KEY]) ? i.metadata[FOG_LOCAL_KEY] : null);
const describe = (e) => e?.error?.message || e?.message || String(e);

// ---- the plan ----

// One handle per door line on a map a PC stands on, at the middle of its length.
export function handlePlan(snap) {
  const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
  const occ = snap?.occupied instanceof Set ? snap.occupied : new Set(snap?.occupied || []);
  const size = r2(dpi * HANDLE_SIZE);
  const out = [];
  for (const l of Array.isArray(snap?.lines) ? snap.lines : []) {
    if (l?.kind !== "door" || !occ.has(l.mapId)) continue;
    const at = midpointAlong(l.points);
    if (!at || !finite(at.x, at.y)) continue;
    const position = { x: r2(at.x), y: r2(at.y) };
    out.push({ key: l.id, line: l.id, position, size, open: !!l.open, locked: !!l.locked,
               sig: `${position.x},${position.y}|${size}|${l.open ? "o" : "c"}|${l.locked ? "l" : "u"}` });
  }
  return out;
}

// The part of a handle's sig that needs a new item when it changes (where it is and its size);
// the rest (open, locked) is an update.
const placeOf = (h) => `${h.position.x},${h.position.y}|${h.size}`;
const colourOf = (h) => (h.open ? COLOUR.open : h.locked ? COLOUR.locked : COLOUR.shut);

// ---- the checks (the leader's) ----

// Can one of `pcs` work `door`? The first PC near enough that sees it wins; otherwise the answer
// for the nearest miss ("You can't see that door" beats "Too far from the door").
export function doorCheck(door, pcs, segments, grid = {}) {
  const dpi = finite(grid?.dpi) && grid.dpi > 0 ? grid.dpi : 150;
  const pxPerFt = finite(grid?.pxPerFt) && grid.pxPerFt > 0 ? grid.pxPerFt : dpi / 5;
  const list = (Array.isArray(pcs) ? pcs : []).filter(Boolean);
  if (!list.length) return { ok: false, reason: "No PC is there to open it", pc: null };
  if (!Array.isArray(door?.points) || door.points.length < 2) return { ok: false, reason: "That isn't a door", pc: null };
  const blockers = sightBlockers((Array.isArray(segments) ? segments : []).filter((s) => s?.id !== door.id));
  let reason = "Too far from the door";
  for (const pc of list) {
    const from = centreOf(pc, dpi);
    const near = from && nearestOnLine(from, door.points);
    if (!near || near.dist / pxPerFt > DOOR_REACH_FT + 1e-6) continue;
    if (canSee(from, near, blockers)) return { ok: true, reason: null, pc: pc.id ?? null };
    reason = "You can't see that door";
  }
  return { ok: false, reason, pc: null };
}

// How a door stands after `change`: open unlocks, locked shuts (fog/lines.js doorEdit).
function after(state, change) {
  if (!change) return { ...state };
  let open = typeof change.open === "boolean" ? change.open : state.open;
  let locked = typeof change.locked === "boolean" ? change.locked : state.locked;
  if (change.locked === true) open = false;
  else if (open) locked = false;
  return { open, locked };
}

const already = (op, s) => (op === "open" && s.open) || (op === "close" && !s.open)
  || (op === "lock" && s.locked) || (op === "unlock" && !s.locked);

// The leader's answer to one request (contract section 4, doors.js).
export function checkRequest(req, snap, { fromGm = false } = {}) {
  const no = (why, state = null) => ({ ok: false, why, change: null, state });
  const line = (Array.isArray(snap?.lines) ? snap.lines : []).find((l) => l?.id === req?.line);
  if (!line || line.kind !== "door") return no("That isn't a door");
  const state = { open: !!line.open, locked: !!line.locked };
  const op = req?.op;
  if (!GM_OPS.includes(op)) return no("A door can't do that", state);
  if (!fromGm && !PLAYER_OPS.includes(op)) return no("Only the DM can lock doors", state);
  if (already(op, state)) return { ok: true, why: null, change: null, state };
  const change = { ...CHANGE[op] };
  const yes = () => ({ ok: true, why: null, change, state: after(state, change) });
  if (fromGm || op === "close") return yes();
  if (state.locked) return no("It's locked", state);
  // The PC that asks: the sender's own token when it is a PC, else any PC.
  const pcs = Array.isArray(snap?.pcs) ? snap.pcs : [];
  const own = req?.token != null ? pcs.find((p) => p?.id === req.token) : null;
  const dpi = snap?.grid?.dpi;
  const rect = (snap?.rects || []).find((r) => r.id === line.mapId);
  const mapItem = line.mapId != null ? snap?.byId?.get?.(line.mapId) || rect : null;
  const segs = [...segmentsOf(snap.lines, [line.mapId]), ...(mapItem ? edgeWalls(mapItem, dpi) : [])];
  const c = doorCheck(line, own ? [own] : pcs, segs, snap?.grid);
  return c.ok ? yes() : no(c.reason, state);
}

// checkRequest against the door line as it stands now: `item` (the shared CURVE, or the draft the
// leader is about to write) replaces the snapshot's line of that id; no item: the line is gone.
export function checkLive(req, snap, item, opts = {}) {
  const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter((l) => l?.id !== req?.line);
  const live = item && item.id === req?.line ? readLine(item, { rects: snap?.rects || [], byId: snap?.byId || null }) : null;
  if (live) lines.push(live);
  return checkRequest(req, { ...(snap || {}), lines }, opts);
}

// What a click on a door that stands so asks for: close an open one, open a shut one; a locked one
// opens only for a GM (open unlocks), and asks for nothing from a player.
export function opFor(state, { gm = false } = {}) {
  if (state?.open) return "close";
  if (state?.locked && !gm) return null;
  return "open";
}

// ---- the menus' filters ----

const tagKey = (k) => ["metadata", FOG_LOCAL_KEY, k];
const handleOf = (host) => [{ key: tagKey("kind"), value: "handle" }, { key: tagKey("host"), value: host }];

export function menuIcons(host, icon) {
  const h = handleOf(host);
  const ours = { key: ["metadata", WALL_KEY, "kind"], value: "door" };
  const smoke = { key: ["metadata", SMOKE_LINE.door], value: true };
  const curve = { key: "type", value: "CURVE" };
  const gm = (label, every) => ({ icon, label, filter: { roles: ["GM"], every } });
  return {
    [MENU.handle]: [
      { icon, label: "🚪 Close door", filter: { every: [...h, { key: tagKey("open"), value: true }] } },
      { icon, label: "🚪 Open door", filter: { every: [...h, { key: tagKey("locked"), value: false }] } },
      gm("🚪 Open door (unlock it)", [...h]),
      { icon, label: "🔒 Locked", filter: { roles: ["PLAYER"], every: [...h] } },
    ],
    [MENU.handleLock]: [
      gm("🔓 Unlock door", [...h, { key: tagKey("locked"), value: true }]),
      gm("🔒 Lock door", [...h]),
    ],
    // The shared lines, in either format (ours first: it wins on a line that has both).
    [MENU.line]: [
      gm("🚪 Close door", [curve, ours, { key: ["metadata", WALL_KEY, "open"], value: true }]),
      gm("🚪 Close door", [curve, smoke, { key: ["metadata", SMOKE_LINE.open], value: true }]),
      gm("🚪 Open door", [curve, ours]),
      gm("🚪 Open door", [curve, smoke]),
    ],
    [MENU.lineLock]: [
      gm("🔓 Unlock door", [curve, ours, { key: ["metadata", WALL_KEY, "locked"], value: true }]),
      gm("🔓 Unlock door", [curve, smoke, { key: ["metadata", SMOKE_LINE.locked], value: true }]),
      gm("🔒 Lock door", [curve, ours]),
      gm("🔒 Lock door", [curve, smoke]),
    ],
  };
}

// ---- drawing and talking ----

export function createDoors(api, ctx) {
  const host = ctx?.host || "pages";
  const T = ctx?.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const log = (t) => { try { ctx?.log?.(t); } catch { /* fine */ } };
  const icon = here("../icon.svg", import.meta.url);
  const menuId = menuIds(host);
  const OBR = () => api.OBR;

  const drawn = new Map(); // key -> {id, sig, place, position, line, open, locked}
  let lastSig = null; // the plan last applied in full
  let readBack = true; // read our handles back on the next sync (first, after a clear, after a failure)
  let error = null;
  let started = false;
  let menusOn = false;
  const offs = []; // listeners to remove on stop()
  const pending = new Map(); // req -> {timer, line, op}
  let leaderQueue = Promise.resolve();
  let lastSel = "";
  let snapTimer = null;

  // ---- the handles ----

  function tag(h) {
    return { kind: "handle", key: h.key, sig: h.sig, host, line: h.line, open: h.open, locked: h.locked };
  }

  function build(h) {
    return api.buildShape()
      .shapeType("CIRCLE")
      .width(h.size).height(h.size)
      .position({ x: h.position.x, y: h.position.y })
      .fillColor(colourOf(h)).fillOpacity(0.9)
      .strokeColor("#ffffff").strokeOpacity(1).strokeWidth(3)
      .layer(HANDLE_LAYER)
      .name("🚪 Door")
      .metadata({ [FOG_LOCAL_KEY]: tag(h) })
      .build();
  }

  async function doSync(snap) {
    const res = { added: 0, removed: 0, updated: 0, failed: false, error: null };
    const plan = snap ? handlePlan(snap) : [];
    const sig = plan.map((h) => `${h.key}:${h.sig}`).join(";");
    if (sig === lastSig && !readBack) return res;
    const O = OBR();
    const want = new Map(plan.map((h) => [h.key, h]));
    const del = [], add = [], upd = new Map(); // upd: item id -> handle spec
    try {
      if (readBack) {
        const mine = await O.scene.local.getItems((i) => tagOf(i)?.kind === "handle" && tagOf(i)?.host === host);
        const ids = new Set(mine.map((i) => i.id));
        for (const [k, d] of drawn) if (!ids.has(d.id)) drawn.delete(k);
        const known = new Set([...drawn.values()].map((d) => d.id));
        for (const i of mine) if (!known.has(i.id)) del.push(i.id); // strays
        readBack = false;
      }
    } catch (e) {
      error = `doors: reading the handles back failed: ${describe(e)}`;
      return { ...res, failed: true, error };
    }
    for (const [k, d] of drawn) {
      const h = want.get(k);
      if (h && placeOf(h) === d.place) {
        if (h.sig !== d.sig) upd.set(d.id, h);
        continue;
      }
      del.push(d.id);
      drawn.delete(k);
    }
    const added = [];
    for (const [k, h] of want) {
      if (drawn.has(k)) continue;
      try {
        const item = build(h);
        add.push(item);
        added.push([k, { id: item.id, sig: h.sig, place: placeOf(h), position: { ...h.position }, line: h.line, open: h.open, locked: h.locked }]);
      } catch (e) {
        error = `doors: a handle could not be built: ${describe(e)}`;
      }
    }
    let failed = null;
    if (del.length) {
      try {
        await O.scene.local.deleteItems(del);
        res.removed = del.length;
      } catch (e) {
        failed = e;
      }
    }
    if (add.length && !failed) {
      try {
        await O.scene.local.addItems(add);
        for (const [k, d] of added) drawn.set(k, d);
        res.added = add.length;
      } catch (e) {
        failed = e;
      }
    }
    if (upd.size && !failed) {
      const ids = [...upd.keys()];
      try {
        await O.scene.local.updateItems(ids, (ds) => {
          for (const d of ds) {
            const h = upd.get(d.id);
            if (!h) continue;
            d.metadata[FOG_LOCAL_KEY] = tag(h);
            if (d.style) d.style.fillColor = colourOf(h);
          }
        });
        for (const [id, h] of upd) {
          const d = drawn.get(h.key);
          if (d?.id === id) Object.assign(d, { sig: h.sig, open: h.open, locked: h.locked });
        }
        res.updated = ids.length;
      } catch (e) {
        for (const [, h] of upd) drawn.delete(h.key); // forget them: the next sync sweeps and re-adds
        failed = e;
      }
    }
    if (failed) {
      error = `doors: ${describe(failed)}`;
      lastSig = null;
      readBack = true;
      return { ...res, failed: true, error };
    }
    lastSig = sig;
    error = null;
    return res;
  }

  async function doClear() {
    const had = drawn.size;
    drawn.clear();
    lastSig = null;
    readBack = true;
    try {
      const mine = await OBR().scene.local.getItems((i) => tagOf(i)?.kind === "handle" && tagOf(i)?.host === host);
      if (mine.length) await OBR().scene.local.deleteItems(mine.map((i) => i.id));
      return { added: 0, removed: mine.length || had, updated: 0, failed: false, error: null };
    } catch (e) {
      return { added: 0, removed: 0, updated: 0, failed: true, error: describe(e) }; // the scene went: so did they
    }
  }

  // One at a time (as sight.js and walls.js): fog.js's stop() clearing while a sync's addItems is
  // on its way would otherwise leave that sync's handles behind.
  let chain = Promise.resolve();
  const serial = (job) => {
    const run = chain.then(job).catch((e) => {
      error = `doors: ${describe(e)}`;
      lastSig = null;
      readBack = true;
      return { added: 0, removed: 0, updated: 0, failed: true, error };
    });
    chain = run;
    return run;
  };
  const sync = (snap) => serial(() => doSync(snap));
  const clear = () => serial(doClear);

  const drawnById = (id) => [...drawn.values()].find((d) => d.id === id) || null;

  // A handle is a local item a player can drag: put it back on its door once the drag settles.
  function onLocal(items) {
    if (!started) return;
    const moved = [];
    const ids = new Set();
    for (const i of Array.isArray(items) ? items : []) {
      const t = tagOf(i);
      if (t?.kind !== "handle" || t.host !== host) continue;
      ids.add(i.id);
      const d = drawnById(i.id);
      const p = i.position;
      if (d && p && Math.hypot(p.x - d.position.x, p.y - d.position.y) > 0.5) moved.push(d);
    }
    for (const d of drawn.values()) if (!ids.has(d.id)) { lastSig = null; readBack = true; } // deleted here
    if (!moved.length) return;
    if (snapTimer) T.clearTimeout(snapTimer);
    snapTimer = T.setTimeout(() => {
      snapTimer = null;
      const back = new Map(moved.map((d) => [d.id, d.position]));
      Promise.resolve(OBR().scene.local.updateItems([...back.keys()], (ds) => {
        for (const d of ds) if (back.has(d.id)) d.position = { ...back.get(d.id) };
      })).catch(() => { lastSig = null; readBack = true; });
    }, SNAP_BACK_MS);
  }

  // ---- asking ----

  function notify(text, variant = "WARNING") {
    try {
      const p = OBR()?.notification?.show(text, variant);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* fine */ }
  }

  function deselect(ids) {
    if (!ids?.length) return;
    try {
      const p = OBR()?.player?.deselect(ids);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* fine */ }
  }

  // Ask the leader for `op` on the door `line`. Returns the request id.
  function ask(op, line, via) {
    const req = newId();
    let token = null;
    try { token = ctx?.ownToken?.() ?? null; } catch { token = null; }
    const timer = T.setTimeout(() => {
      if (!pending.delete(req)) return;
      notify(NO_ANSWER);
    }, REPLY_WAIT_MS);
    pending.set(req, { timer, line, op });
    send(api, FOG_DOOR_CH, { req, op, line, token, by: ctx?.playerId ?? null, dm: !!ctx?.isGm, via }, "ALL");
    return req;
  }

  function onReply(msg) {
    if (!forMe(msg, { role: ctx?.role, playerId: ctx?.playerId })) return;
    const p = pending.get(msg.req);
    if (!p) return;
    T.clearTimeout(p.timer);
    pending.delete(msg.req);
    if (!msg.ok && msg.why) notify(`🚪 ${msg.why}`);
  }

  // A click on our menu, on handles (local items) or on shared door lines.
  function onHandleMenu(context, { lock = false } = {}) {
    const items = (context?.items || []).filter((i) => tagOf(i)?.kind === "handle" && tagOf(i)?.host === host);
    for (const i of items) {
      const t = tagOf(i);
      const state = { open: !!t.open, locked: !!t.locked };
      const op = lock ? (state.locked ? "unlock" : "lock") : opFor(state, { gm: !!ctx?.isGm });
      if (!op) notify("🔒 It's locked");
      else if (!lock || ctx?.isGm) ask(op, t.line, "menu"); // lock and unlock: the GM's menu only
    }
    deselect(items.map((i) => i.id));
  }

  function onLineMenu(context, { lock = false } = {}) {
    if (!ctx?.isGm) return;
    for (const item of context?.items || []) {
      const l = readLine(item);
      if (l?.kind !== "door") continue;
      ask(lock ? (l.locked ? "unlock" : "lock") : l.open ? "close" : "open", l.id, "line-menu");
    }
  }

  // A plain click that selects a handle: nothing (a right-click selects it too, and taking the
  // selection away would close the menu it opened), unless ctx.doorTap.
  function onSelection(selection) {
    const ids = Array.isArray(selection) ? selection : [];
    const key = ids.join(",");
    if (key === lastSel) return;
    lastSel = key;
    if (!ctx?.doorTap || !ids.length) return;
    const picked = ids.map(drawnById).filter(Boolean);
    if (!picked.length) return;
    for (const d of picked) {
      const op = opFor(d, { gm: !!ctx?.isGm });
      if (op) ask(op, d.line, "select");
      else notify("🔒 It's locked");
    }
    deselect(picked.map((d) => d.id));
  }

  // ---- the leader ----

  async function fromGmOf(msg, event) {
    if (msg?.dm !== true || event?.viaScene) return false;
    if (event?.local || (event?.connectionId && event.connectionId === ctx?.conn)) return !!ctx?.isGm;
    try {
      const players = await OBR().party.getPlayers();
      return (players || []).some((p) => p?.connectionId === event?.connectionId && p?.role === "GM");
    } catch {
      return false;
    }
  }

  async function lead(msg, event) {
    let leader = false;
    try { leader = !!ctx?.isLeader?.(); } catch { leader = false; }
    if (!leader || !msg?.req || typeof msg.line !== "string") return;
    const fromGm = await fromGmOf(msg, event);
    const snap = ctx?.snapshot?.() ?? null;
    let r = { ok: false, why: "The DM's screen isn't ready", change: null, state: null };
    let item = null;
    if (snap) {
      // The door as it stands now, not as the snapshot (up to MAX_WAIT_MS old) has it.
      try {
        [item = null] = (await OBR().scene.items.getItems([msg.line])) || [];
        r = checkLive(msg, snap, item, { fromGm });
      } catch (e) {
        r = { ok: false, why: `The DM's screen can't read that door (${describe(e)})`, change: null, state: null };
      }
    }
    if (r.ok && r.change) {
      const l = readLine(item);
      const was = l ? { open: !!l.open, locked: !!l.locked } : null;
      let now = null;
      try {
        // ...and once more against the draft it writes: decided and written in one step.
        await OBR().scene.items.updateItems([msg.line], (ds) => {
          for (const d of ds) {
            now = checkLive(msg, snap, d, { fromGm });
            if (now.ok && now.change) doorEdit(d.metadata, now.change);
          }
        });
        r = now || { ok: false, why: "That isn't a door", change: null, state: null };
      } catch (e) {
        r = { ok: false, why: `The door didn't move (${describe(e)})`, change: null, state: was };
      }
    }
    const audience = fromGm ? "gm" : `player:${msg.by}`;
    send(api, FOG_DOOR_REPLY_CH, { audience, req: msg.req, line: msg.line, op: msg.op, ok: r.ok, state: r.state, why: r.why }, "ALL");
    log(`🚪 ${fromGm ? "DM" : `player ${msg.by}`} asked to ${msg.op} door ${String(msg.line).slice(0, 8)} (${msg.via || "?"}): `
      + `${r.ok ? (r.change ? "done" : "already so") : r.why}`);
  }

  function onRequest(msg, event) {
    leaderQueue = leaderQueue.then(() => lead(msg, event)).catch((e) => { error = `doors: ${describe(e)}`; });
    return leaderQueue;
  }

  // ---- start and stop ----

  async function start() {
    if (started) return;
    started = true;
    const O = OBR();
    offs.push(on(api, FOG_DOOR_CH, onRequest), on(api, FOG_DOOR_REPLY_CH, onReply));
    try { offs.push(O.player.onChange((p) => onSelection(p?.selection))); } catch { /* no selection here */ }
    try { offs.push(O.scene.local.onChange(onLocal)); } catch { /* no snap-back here */ }
    const icons = menuIcons(host, icon);
    const made = [O.contextMenu.create({ id: menuId.handle, icons: icons[MENU.handle], onClick: (c) => onHandleMenu(c) })];
    if (ctx?.isGm) {
      made.push(
        O.contextMenu.create({ id: menuId.handleLock, icons: icons[MENU.handleLock], onClick: (c) => onHandleMenu(c, { lock: true }) }),
        O.contextMenu.create({ id: menuId.line, icons: icons[MENU.line], onClick: (c) => onLineMenu(c) }),
        O.contextMenu.create({ id: menuId.lineLock, icons: icons[MENU.lineLock], onClick: (c) => onLineMenu(c, { lock: true }) }));
    }
    menusOn = true;
    try {
      await Promise.all(made);
    } catch (e) {
      error = `doors: a menu could not be made: ${describe(e)}`;
    }
  }

  async function stop() {
    if (!started) return;
    started = false;
    while (offs.length) {
      const off = offs.pop();
      try { if (typeof off === "function") off(); } catch { /* gone */ }
    }
    for (const p of pending.values()) T.clearTimeout(p.timer);
    pending.clear();
    if (snapTimer) { T.clearTimeout(snapTimer); snapTimer = null; }
    lastSel = "";
    if (menusOn) {
      menusOn = false;
      const gone = ctx?.isGm ? Object.values(menuId) : [menuId.handle];
      await Promise.all(gone.map((id) => Promise.resolve().then(() => OBR().contextMenu.remove(id)).catch(() => {})));
    }
  }

  function status() {
    return { handles: drawn.size, pending: pending.size, menus: menusOn, error };
  }

  return { start, stop, sync, clear, status, ask };
}
