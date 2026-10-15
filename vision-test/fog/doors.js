// Doors for the vision layer (docs/vision-layer-spec.md section 4, the contract in
// docs/vision-layer-b2b3.md sections 4, 6 and 9): a door icon at the middle of every door, the
// right-click menus that work it, the GM screens' door writes, and the players' requests.
//
//   DOOR_REACH_FT, REPLY_WAIT_MS, RETRY_AFTER_MS, HELLO_EVERY_MS, HELLO_STALE_MS, HOLD_MS, ANSWERER_SETTLE_MS, SEEN_CAP,
//   SHAPES_CAP, PLAYER_OPS,
//   GM_OPS, HANDLE_LAYER, HANDLE_SIZE, ICON_PX, ICON_URL, MENU, menuIds(host) (the ids a copy uses)
//   iconOf(door, {gm})   the icon a screen shows for a door: "open" | "closed" | "locked" (a player's
//                        screen shows a lock only once the party has found it)
//   handlePlan(snap, {gm})  one handle per door on an occupied map: [{key, line, position, size, open,
//                        locked (as this screen shows it), secret (GM: the party hasn't found the lock),
//                        icon, sig}] (key and line: the door line's id)
//   doorCheck(door, pcs, segments, grid)  can one of these PCs work this door: {ok, reason, pc}.
//                        A PC's middle must be within DOOR_REACH_FT of the door line and see the
//                        nearest point of it past `segments` (fog/los.js segments; the door's own
//                        are skipped). grid: {dpi, pxPerFt} (snap.grid)
//   checkRequest(req, snap, {fromGm})  the answer to one request: {ok, why, change: {open?, locked?,
//                        knownLocked?} | null (null: nothing to write), state: {open, locked,
//                        knownLocked} after it (null when it isn't a door), found (a player found the lock)}
//   checkLive(req, snap, item, {fromGm})  the same against the door line as it stands NOW (item:
//                        the shared CURVE, or a draft of it; null: it's gone), the rest of the
//                        snapshot as it was (snap may be null for a GM's own click)
//   shownState(state, {gm})  a door's state as a reply may tell it: a player hears of a known lock only
//   opFor(state, {gm})   what a click on a door that stands so asks for: "open" | "close" | null
//   gmPool(heard, {now, self})  the GM screens a screen knows (announced in the last HELLO_STALE_MS,
//                        itself too), lowest connection first: the first answers players' requests
//   answerHow(msg, {pool, me, heard, answered})  should this GM screen answer: "now" | "hold" | "again" | "no"
//   menuIcons(host, icon)  the menus' icons and filters, by MENU id
//   createDoors(api, ctx)  -> {start(), stop(), sync(snap), clear(), status(), ask(op, line, via), act(op, line, via),
//                        isAnswerer(), isSeenWriter()}: isAnswerer is true on the one GM screen that answers
//                        the players' doors (the lowest connection it knows), once its doors have run
//                        ANSWERER_SETTLE_MS; isSeenWriter the same among the GM screens whose hello says
//                        seen: SEEN_CAP and shapes: SHAPES_CAP (a build that writes the smooth explored
//                        memory, docs/vision-layer-2024.md), so an older build's tab that wins the doors
//                        never leaves the explored memory unwritten (review of B4). fog.js hands
//                        isSeenWriter to the other parts as ctx.isAnswerer() (fog/seen.js writes only there).
//                        With the two DM browsers of game night either can be the writer (the lower
//                        connection); the other only draws, and takes over once the writer's hello has gone
//                        unheard for HELLO_STALE_MS. An older tab's own pick (seen only) still counts this
//                        screen, so both may write the squares for a moment: idempotent unions. Only a
//                        screen whose hello says shapes writes the shapes
//
// Every screen, while 🌫 Our fog is on: a small LOCAL door icon (an image: owlbear/icons/door-*.svg,
// 0.6 squares) at each door's middle, on the PROP layer, under the fog (the fog hides the icons nobody
// sees, so door positions don't leak), tagged FOG_LOCAL_KEY {kind: "handle", key, sig, host, line, open,
// locked, secret, icon}. The icon says how the door stands on THIS screen: the DM's shows the truth (a
// lock is a lock, with a menu hint while the party hasn't found it); a player's (and the projector's)
// shows a lock only once a PC has tried that door and the answer was "It's locked" (WALL_KEY
// knownLocked, written by the answering GM screen). Until then a locked door is a plain closed door,
// and the player's menu offers "🚪 Open door" for it. A right-click on an icon (a long-press on a
// phone) shows our menu: 🚪 Open door / 🚪 Close door, or 🔒 Locked for a player; a GM also gets Lock /
// Unlock, and the same on the shared door lines themselves (either format). Owlbear shows one icon per
// menu, so a GM's Lock / Unlock is a second menu (MENU.handleLock, MENU.lineLock). After a menu click
// the icon is deselected. THE DM'S CTRL+CLICK: a GM screen draws its icons as LOCKED items, which
// Owlbear selects only on a Ctrl+click (Cmd+click) or a double-click, so a GM screen's selection of one
// icon works that door at once (open ⇄ closed; a locked door opens, unlocked) and deselects it
// (fog/doorclick.js). A player's icon is not locked (unless ctx.lockHandles: whether a player's menu
// works on a locked local item is untested live), and a plain click that selects one is left alone: a
// right-click selects it too, and taking the selection away then could close the very menu it opened.
// With ctx.doorTap, a select of an icon works the door on any screen. A player could drag, scale or
// turn an unlocked icon: it goes back (position, scale and turn) SNAP_BACK_MS after any change.
//
// NO LEADER. A GM's own click writes the door from that GM screen at once (act): it reads the door as
// it stands now and decides and writes in one updateItems, on the draft. A player's click is a request
// on FOG_DOOR_CH, addressed (`to`) to the answerer the player's screen knows: the lowest connection
// among the GM screens that announced our fog (FOG_HELLO_CH: on start, when asked, and every
// HELLO_EVERY_MS; forgotten after HELLO_STALE_MS). A GM screen answers when it is `to`, or when `to` is
// missing or unknown to it and it is the lowest it knows (after a random hold under HOLD_MS, unless an
// answer is heard meanwhile). No answer in RETRY_AFTER_MS: the player asks once more with any: true,
// answered by the lowest GM screen the receiver knows that hasn't answered and wasn't the one asked
// (it, when it's the only one), after the same hold; a screen that answered already sends its answer
// again. No answer in REPLY_WAIT_MS: "No DM screen answered". Door writes are idempotent (fog/lines.js
// doorEdit), so two screens that both answer write the same thing once. The answer goes back on
// FOG_DOOR_REPLY_CH; a player's tells only a lock the party knows. Players never write scene items.
//
// The handles are reconciled like fx/lighting.js: what was drawn is remembered (key -> {id, sig}),
// nothing is asked of Owlbear while the plan's signature is unchanged, at most one local delete,
// one add and one update per sync, and our items are read back only after a clear or a failure.
// Syncs and clears run one at a time, so a clear can't slip in while a sync's add is on its way.
// Every request, answer, write and error is a line in the 🪵 Live log (ctx.log(text, kind)).

import { FOG_DOOR_CH, FOG_DOOR_REPLY_CH, FOG_HELLO_CH, FOG_LOCAL_KEY, WALL_KEY } from "../keys.js?v=bb4ddf1";
import { forMe, here, newId, on, send } from "../bus.js?v=bb4ddf1";
import { centreOf } from "../views.js?v=bb4ddf1";
import { canSee, sightBlockers } from "./los.js?v=bb4ddf1";
import { SMOKE_LINE, doorAfter, doorEdit, edgeWalls, midpointAlong, nearestOnLine, readLine, segmentsOf } from "./lines.js?v=bb4ddf1";
import { LINE_PICKED, clickedHandle, clickedLine } from "./doorclick.js?v=bb4ddf1";

export const DOOR_REACH_FT = 5; // from the PC's middle to the nearest point of the door line
export const REPLY_WAIT_MS = 4000; // no answer by then: "No DM screen answered"
export const RETRY_AFTER_MS = 1500; // no answer by then: asked once more, of any GM screen
export const HELLO_EVERY_MS = 10000; // a GM screen drawing our fog says so this often...
export const HELLO_STALE_MS = 25000; // ...and is forgotten when unheard this long
export const HOLD_MS = 300; // a GM screen not asked by name waits up to this (at random) before it answers
export const ANSWERER_SETTLE_MS = 2000; // isAnswerer() stays false this long after start: the others' hellos come in
export const SEEN_CAP = 1; // a GM hello's `seen`: this build writes the explored memory (fog/seen.js, B4)
export const SHAPES_CAP = 1; // ...and `shapes`: it writes the smooth memory's shapes too (EXPLORED_KEY)
export const PLAYER_OPS = ["open", "close"];
export const GM_OPS = ["open", "close", "lock", "unlock"];
export const HANDLE_LAYER = "PROP"; // under the fog
export const HANDLE_SIZE = 0.6; // squares across
export const ICON_PX = 128; // the icons' own size (owlbear/icons/door-*.svg)
// The door icons, from this copy's own site (Pages ext/ or vision-test/, or this PC's panel).
export const ICON_URL = {
  closed: here("../icons/door-closed.svg", import.meta.url),
  open: here("../icons/door-open.svg", import.meta.url),
  locked: here("../icons/door-locked.svg", import.meta.url),
};
export const SNAP_BACK_MS = 300; // a moved, scaled or turned handle goes back this long after the change
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
export const LOCKED = "It's locked";
const CHANGE = { open: { open: true }, close: { open: false }, lock: { locked: true }, unlock: { locked: false } };
const KEEP_REQS = 100; // requests remembered (answers given, answers heard)

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const tagOf = (i) => (isObj(i?.metadata?.[FOG_LOCAL_KEY]) ? i.metadata[FOG_LOCAL_KEY] : null);
const describe = (e) => e?.error?.message || e?.message || String(e);
const short = (id) => String(id ?? "?").slice(0, 8);

// ---- the plan ----

// The icon a screen shows for a door: the DM's the truth, a player's (the projector's too) a lock
// only once the party has found it.
export function iconOf(door, { gm = false } = {}) {
  if (door?.open) return "open";
  if (door?.locked && (gm || door?.knownLocked)) return "locked";
  return "closed";
}

// One handle per door line on a map a PC stands on, at the middle of its length.
export function handlePlan(snap, { gm = false } = {}) {
  const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
  const occ = snap?.occupied instanceof Set ? snap.occupied : new Set(snap?.occupied || []);
  const size = r2(dpi * HANDLE_SIZE);
  const out = [];
  for (const l of Array.isArray(snap?.lines) ? snap.lines : []) {
    if (l?.kind !== "door" || !occ.has(l.mapId)) continue;
    const at = midpointAlong(l.points);
    if (!at || !finite(at.x, at.y)) continue;
    const position = { x: r2(at.x), y: r2(at.y) };
    const icon = iconOf(l, { gm });
    const secret = !!gm && !!l.locked && !l.knownLocked; // the DM's hint: the party hasn't found this lock
    out.push({ key: l.id, line: l.id, position, size, open: !!l.open, locked: icon === "locked", secret, icon,
               sig: `${position.x},${position.y}|${size}|${icon}${secret ? "|s" : ""}` });
  }
  return out;
}

// The part of a handle's sig that needs a new item when it changes (where it is and its size);
// the rest (the icon, the tag) is an update.
const placeOf = (h) => `${h.position.x},${h.position.y}|${h.size}`;

// ---- the checks (an answering GM screen's, and a GM's own click) ----

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

const already = (op, s) => (op === "open" && s.open) || (op === "close" && !s.open)
  || (op === "lock" && s.locked) || (op === "unlock" && !s.locked);

// The answer to one request (contract section 4, doors.js).
export function checkRequest(req, snap, { fromGm = false } = {}) {
  const no = (why, state = null) => ({ ok: false, why, change: null, state, found: false });
  const line = (Array.isArray(snap?.lines) ? snap.lines : []).find((l) => l?.id === req?.line);
  if (!line || line.kind !== "door") return no("That isn't a door");
  const state = { open: !!line.open, locked: !!line.locked, knownLocked: !!line.locked && !!line.knownLocked };
  const op = req?.op;
  if (!GM_OPS.includes(op)) return no("A door can't do that", state);
  if (!fromGm && !PLAYER_OPS.includes(op)) return no("Only the DM can lock doors", state);
  if (already(op, state)) return { ok: true, why: null, change: null, state, found: false };
  const change = { ...CHANGE[op] };
  const yes = () => ({ ok: true, why: null, change, state: doorAfter(state, change), found: false });
  if (fromGm || op === "close") return yes();
  // A player's open: their PC must be at the door and see it before anything about the door is told.
  // The PC that asks: the sender's own token when it is a PC, else any PC.
  const pcs = Array.isArray(snap?.pcs) ? snap.pcs : [];
  const own = req?.token != null ? pcs.find((p) => p?.id === req.token) : null;
  const dpi = snap?.grid?.dpi;
  const rect = (snap?.rects || []).find((r) => r.id === line.mapId);
  const mapItem = line.mapId != null ? snap?.byId?.get?.(line.mapId) || rect : null;
  const segs = [...segmentsOf(snap.lines, [line.mapId]), ...(mapItem ? edgeWalls(mapItem, dpi) : [])];
  const c = doorCheck(line, own ? [own] : pcs, segs, snap?.grid);
  if (!c.ok) return no(c.reason, state);
  if (state.locked) {
    // Tried, and it's locked: the party knows now (written once: an already known lock writes nothing).
    const found = state.knownLocked ? null : { knownLocked: true };
    return { ok: false, why: LOCKED, change: found, state: doorAfter(state, found || {}), found: !!found };
  }
  return yes();
}

// checkRequest against the door line as it stands now: `item` (the shared CURVE, or the draft about
// to be written) replaces the snapshot's line of that id; no item: the line is gone.
export function checkLive(req, snap, item, opts = {}) {
  const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter((l) => l?.id !== req?.line);
  const live = item && item.id === req?.line ? readLine(item, { rects: snap?.rects || [], byId: snap?.byId || null }) : null;
  if (live) lines.push(live);
  return checkRequest(req, { ...(snap || {}), lines }, opts);
}

// A door's state as an answer may tell it: a GM the truth, a player a lock only once the party knows it.
export function shownState(state, { gm = false } = {}) {
  if (!state) return null;
  return { open: !!state.open, locked: !!state.locked && (gm || !!state.knownLocked) };
}

// What a click on a door that stands so asks for: close an open one, open a shut one; a locked one
// opens only for a GM (open unlocks), and asks for nothing from a player (a lock the party knows).
export function opFor(state, { gm = false } = {}) {
  if (state?.open) return "close";
  if (state?.locked && !gm) return null;
  return "open";
}

// ---- who answers the players ----

// The GM screens a screen knows: heard announcing our fog in the last HELLO_STALE_MS (heard: a Map
// conn -> {at}), itself too when it is one (self), sorted: the first is the answerer.
export function gmPool(heard, { now = 0, self = null } = {}) {
  const out = new Set();
  for (const [conn, g] of heard instanceof Map ? heard : []) {
    if (conn && finite(g?.at) && now - g.at <= HELLO_STALE_MS) out.add(conn);
  }
  if (self) out.add(self);
  return [...out].sort();
}

// Should this GM screen (me) answer a request? "now": it was asked by name; "hold": it is the one by
// the rules but wasn't named (wait up to HOLD_MS at random, then answer unless someone did); "again":
// a retry of one it answered (send the same answer again); "no". pool: gmPool(); heard: the
// connections heard answering this request; answered: this screen answered it already.
export function answerHow(msg, { pool = [], me = null, heard = new Set(), answered = false } = {}) {
  if (!me || !msg) return "no";
  if (msg.any === true) {
    if (answered) return "again";
    const fresh = pool.filter((c) => !heard.has(c));
    const others = fresh.filter((c) => c !== msg.to); // the one asked first didn't answer: another, if any
    return (others.length ? others : fresh)[0] === me ? "hold" : "no";
  }
  if (answered) return "no";
  if (msg.to != null && msg.to === me) return "now";
  if ((msg.to == null || !pool.includes(msg.to)) && pool[0] === me) return "hold";
  return "no";
}

// ---- the menus' filters ----

const tagKey = (k) => ["metadata", FOG_LOCAL_KEY, k];
const handleOf = (host) => [{ key: tagKey("kind"), value: "handle" }, { key: tagKey("host"), value: host }];

export function menuIcons(host, icon) {
  const h = handleOf(host);
  const ours = { key: ["metadata", WALL_KEY, "kind"], value: "door" };
  // Smoke's keys count only on a line without our kind: ours wins on a line that has both.
  const smoke = [{ key: ["metadata", SMOKE_LINE.door], value: true }, { key: ["metadata", WALL_KEY, "kind"], value: undefined }];
  const curve = { key: "type", value: "CURVE" };
  const gm = (label, every) => ({ icon, label, filter: { roles: ["GM"], every } });
  const secret = { key: tagKey("secret"), value: true };
  return {
    // A player's handle says `locked` only for a lock the party found: an unknown lock offers Open.
    [MENU.handle]: [
      { icon, label: "🚪 Close door", filter: { every: [...h, { key: tagKey("open"), value: true }] } },
      { icon, label: "🚪 Open door", filter: { every: [...h, { key: tagKey("locked"), value: false }] } },
      gm("🚪 Open door (unlock it) · the party doesn't know it's locked", [...h, secret]),
      gm("🚪 Open door (unlock it)", [...h]),
      { icon, label: "🔒 Locked", filter: { roles: ["PLAYER"], every: [...h] } },
    ],
    [MENU.handleLock]: [
      gm("🔓 Unlock door · the party doesn't know it's locked", [...h, { key: tagKey("locked"), value: true }, secret]),
      gm("🔓 Unlock door", [...h, { key: tagKey("locked"), value: true }]),
      gm("🔒 Lock door", [...h]),
    ],
    // The shared lines, in either format (ours first: it wins on a line that has both).
    [MENU.line]: [
      gm("🚪 Close door", [curve, ours, { key: ["metadata", WALL_KEY, "open"], value: true }]),
      gm("🚪 Close door", [curve, ...smoke, { key: ["metadata", SMOKE_LINE.open], value: true }]),
      gm("🚪 Open door", [curve, ours]),
      gm("🚪 Open door", [curve, ...smoke]),
    ],
    [MENU.lineLock]: [
      gm("🔓 Unlock door", [curve, ours, { key: ["metadata", WALL_KEY, "locked"], value: true }]),
      gm("🔓 Unlock door", [curve, ...smoke, { key: ["metadata", SMOKE_LINE.locked], value: true }]),
      gm("🔒 Lock door", [curve, ours]),
      gm("🔒 Lock door", [curve, ...smoke]),
    ],
  };
}

// ---- drawing and talking ----

export function createDoors(api, ctx) {
  const host = ctx?.host || "pages";
  const T = ctx?.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const log = (text, kind = "door") => { try { ctx?.log?.(text, kind); } catch { /* fine */ } };
  const random = () => {
    try { const r = ctx?.random?.(); if (finite(r)) return Math.min(1, Math.max(0, r)); } catch { /* the real one */ }
    return Math.random();
  };
  const icon = here("../icon.svg", import.meta.url);
  const menuId = menuIds(host);
  const OBR = () => api.OBR;
  const isGm = () => !!ctx?.isGm;
  const me = () => ctx?.conn ?? null;
  const lockHandles = () => { try { return !!ctx?.lockHandles; } catch { return false; } };
  // A GM screen's icons are locked items: only a Ctrl+click or a double-click selects one (the DM's door
  // click). A player's only with ctx.lockHandles.
  const held = () => isGm() || lockHandles();

  const drawn = new Map(); // key -> {id, sig, place, position, line, open, locked, icon, held (a locked item)}
  let lastSig = null; // the plan last applied in full
  let readBack = true; // read our handles back on the next sync (first, after a clear, after a failure)
  let error = null;
  let started = false;
  let startedAt = null; // when start() ran (T.now()): isAnswerer waits ANSWERER_SETTLE_MS from it
  let menusOn = false;
  const offs = []; // listeners to remove on stop()
  const pending = new Map(); // req -> {msg, to, retryT, failT}: this player's requests waiting for an answer
  const answered = new Map(); // req -> the answer this GM screen gave
  const heardBy = new Map(); // req -> Set of connections heard answering it
  const gms = new Map(); // conn -> {at, name, build}: other GM screens heard announcing our fog
  let helloT = null, lastAnswerer, lastSeenWriter;
  let queue = Promise.resolve(); // a GM screen's door writes, one at a time
  let lastSel = "", lastIds = [];
  let snapTimer = null;

  const remember = (map, k, v) => {
    map.set(k, v);
    while (map.size > KEEP_REQS) map.delete(map.keys().next().value);
  };

  // ---- the handles ----

  function tag(h) {
    return { kind: "handle", key: h.key, sig: h.sig, host, line: h.line, open: h.open, locked: h.locked,
             secret: !!h.secret, icon: h.icon };
  }

  function build(h, locked) {
    return api.buildImage(
      { width: ICON_PX, height: ICON_PX, url: ICON_URL[h.icon] || ICON_URL.closed, mime: "image/svg+xml" },
      { dpi: ICON_PX / HANDLE_SIZE, offset: { x: ICON_PX / 2, y: ICON_PX / 2 } },
    )
      .position({ x: h.position.x, y: h.position.y })
      .layer(HANDLE_LAYER)
      .locked(locked)
      .name("🚪 Door")
      .metadata({ [FOG_LOCAL_KEY]: tag(h) })
      .build();
  }

  async function doSync(snap) {
    const res = { added: 0, removed: 0, updated: 0, failed: false, error: null };
    const plan = snap ? handlePlan(snap, { gm: isGm() }) : [];
    const H = held(); // a change of it (the role) makes every icon again: an item is locked when it's made
    const sig = `${H ? "L" : "U"}|${plan.map((h) => `${h.key}:${h.sig}`).join(";")}`;
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
      if (h && placeOf(h) === d.place && d.held === H) {
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
        const item = build(h, H);
        add.push(item);
        added.push([k, { id: item.id, sig: h.sig, place: placeOf(h), position: { ...h.position }, line: h.line, open: h.open,
                         locked: h.locked, icon: h.icon, held: H }]);
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
            if (d.image) d.image.url = ICON_URL[h.icon] || ICON_URL.closed;
          }
        });
        for (const [id, h] of upd) {
          const d = drawn.get(h.key);
          if (d?.id === id) Object.assign(d, { sig: h.sig, open: h.open, locked: h.locked, icon: h.icon });
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

  // Moved, scaled or turned since it was drawn (a handle is drawn at scale 1, unturned).
  const displaced = (i, d) => {
    const p = i?.position, s = i?.scale, r = i?.rotation;
    return (!!p && finite(p.x, p.y) && Math.hypot(p.x - d.position.x, p.y - d.position.y) > 0.5)
      || (!!s && (Math.abs((finite(s.x) ? s.x : 1) - 1) > 1e-3 || Math.abs((finite(s.y) ? s.y : 1) - 1) > 1e-3))
      || (finite(r) && Math.abs(r) > 1e-3);
  };

  // A handle is a local item a player can drag, scale or turn (unless ctx.lockHandles): put it back
  // on its door, at its size, unturned, once the change settles.
  function onLocal(items) {
    if (!started) return;
    const moved = [];
    const ids = new Set();
    for (const i of Array.isArray(items) ? items : []) {
      const t = tagOf(i);
      if (t?.kind !== "handle" || t.host !== host) continue;
      ids.add(i.id);
      const d = drawnById(i.id);
      if (d && displaced(i, d)) moved.push(d);
    }
    for (const d of drawn.values()) if (!ids.has(d.id)) { lastSig = null; readBack = true; } // deleted here
    if (!moved.length) return;
    if (snapTimer) T.clearTimeout(snapTimer);
    snapTimer = T.setTimeout(() => {
      snapTimer = null;
      const back = new Map(moved.map((d) => [d.id, d.position]));
      Promise.resolve(OBR().scene.local.updateItems([...back.keys()], (ds) => {
        for (const x of ds) {
          if (!back.has(x.id)) continue;
          x.position = { ...back.get(x.id) };
          x.scale = { x: 1, y: 1 };
          x.rotation = 0;
        }
      })).catch(() => { lastSig = null; readBack = true; });
    }, SNAP_BACK_MS);
  }

  // ---- who answers ----

  const pool = () => gmPool(gms, { now: T.now(), self: isGm() && started ? me() : null });
  const answerer = () => pool()[0] ?? null;
  // The seen writer: the lowest GM screen whose hello says it writes the explored memory, shapes and all
  // (this one does).
  const seenPool = () => gmPool(new Map([...gms].filter(([, g]) => g?.seen === SEEN_CAP && g?.shapes === SHAPES_CAP)),
    { now: T.now(), self: isGm() && started ? me() : null });
  const seenWriter = () => seenPool()[0] ?? null;
  // F8 (the plan's decision 78): both DM browsers are named "GM", so on a GM screen another GM screen is
  // "the other GM screen (GM, ab12)" ("another" with three or more); a player's screen names it as before.
  const nameOf = (conn) => {
    if (conn == null) return "nobody";
    if (conn === me()) return `${ctx?.name || "this screen"} (this screen)`;
    const name = gms.get(conn)?.name;
    if (!isGm()) return name ? `${name} (${short(conn)})` : `GM screen ${short(conn)}`;
    const others = pool().filter((c) => c !== me()).length;
    return `${others > 1 ? "another" : "the other"} GM screen (${name ? `${name}, ` : ""}${short(conn)})`;
  };
  const selfName = () => `${ctx?.name || "GM"}, ${short(me())}`;

  function noteAnswerer() {
    const a = answerer();
    const w = seenWriter();
    if (a === lastAnswerer && w === lastSeenWriter) return;
    const aChanged = a !== lastAnswerer;
    lastAnswerer = a;
    lastSeenWriter = w;
    const n = pool().length;
    if (aChanged) {
      // On a GM screen that isn't the answerer the line names this screen too (its short id), so the two
      // DM browsers' logs can be told apart (F8).
      log(a ? `answerer: ${nameOf(a)}, the lowest of ${n} GM screen${n === 1 ? "" : "s"} with our fog`
        + (isGm() && a !== me() ? ` (this screen: ${selfName()})` : "")
        : "answerer: no GM screen with our fog heard yet", "answerer");
    }
    // An older build's GM tab answers the doors but can't write the smooth explored memory: say so (on GM
    // screens: the DM reloads that tab), and who writes it instead.
    if (isGm() && a && a !== me() && (gms.get(a)?.seen !== SEEN_CAP || gms.get(a)?.shapes !== SHAPES_CAP)) {
      const b = gms.get(a)?.build || "an older build";
      log(`✖ ${nameOf(a)} answers the doors but runs ${b} (this screen: ${ctx?.build || "?"}), without the smooth explored`
        + ` memory: reload that tab. ${w ? `${nameOf(w)} writes it meanwhile` : "Nobody writes it"}`, "answerer");
    }
  }

  function hello({ bye = false, ask = false } = {}) {
    send(api, FOG_HELLO_CH, { conn: me(), role: "GM", build: String(ctx?.build ?? ""), name: String(ctx?.name || ""),
                              seen: SEEN_CAP, shapes: SHAPES_CAP, ...(bye ? { bye: true } : {}), ...(ask ? { ask: true } : {}) },
         "ALL");
  }

  function helloLoop() {
    if (helloT) T.clearTimeout(helloT);
    helloT = T.setTimeout(() => {
      helloT = null;
      if (!started) return;
      hello();
      noteAnswerer(); // a GM screen gone quiet drops out of the pool
      helloLoop();
    }, HELLO_EVERY_MS);
  }

  function onHello(msg, ev) {
    if (!started || !msg || ev?.viaScene) return;
    // Owlbear stamps the sender's connection on the event; our own frame's copy carries msg.conn.
    const conn = ev?.local || !ev?.connectionId ? msg.conn : ev.connectionId;
    if (msg.role === "GM" && conn && conn !== me()) {
      if (msg.bye) gms.delete(conn);
      else {
        gms.set(conn, { at: T.now(), name: String(msg.name || ""), build: String(msg.build || ""),
                        seen: msg.seen === SEEN_CAP ? SEEN_CAP : 0, shapes: msg.shapes === SHAPES_CAP ? SHAPES_CAP : 0 });
      }
      noteAnswerer();
    }
    // Someone just started and asks who's there: a GM screen says so at once (a screen asks only when
    // its doors start, so this is a handful of messages at a switch-on).
    if (msg.ask && isGm() && conn !== me()) hello();
  }

  // ---- a player asks ----

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

  // Work the door `line`: a GM writes it here and now (act); a player asks the answering GM screen.
  // Returns the request id (a player's), or the promise of the GM's write.
  function ask(op, line, via) {
    if (isGm()) return act(op, line, via);
    const req = newId();
    let token = null;
    try { token = ctx?.ownToken?.() ?? null; } catch { token = null; }
    noteAnswerer();
    const to = answerer();
    const msg = { req, op, line, token, by: ctx?.playerId ?? null, name: String(ctx?.name || ""), dm: false, via, to };
    const p = { msg, to, retryT: null, failT: null };
    p.retryT = T.setTimeout(() => {
      p.retryT = null;
      if (!pending.has(req)) return;
      send(api, FOG_DOOR_CH, { ...msg, any: true }, "ALL");
      log(`↻ no answer in ${RETRY_AFTER_MS / 1000} s: asked again (any GM screen) to ${op} door ${short(line)}`);
    }, RETRY_AFTER_MS);
    p.failT = T.setTimeout(() => {
      p.failT = null;
      if (!pending.delete(req)) return;
      if (p.retryT) { T.clearTimeout(p.retryT); p.retryT = null; }
      notify(NO_ANSWER);
      log(`✖ ${NO_ANSWER} in ${REPLY_WAIT_MS / 1000} s (${op} door ${short(line)})`);
    }, REPLY_WAIT_MS);
    pending.set(req, p);
    send(api, FOG_DOOR_CH, msg, "ALL");
    log(`→ ${ctx?.name || "a player"} asked to ${op} door ${short(line)} (${via || "?"}), to ${to ? nameOf(to) : "any GM screen (none heard yet)"}`);
    return req;
  }

  function onReply(msg, ev) {
    if (!msg?.req) return;
    const from = msg.from ?? (ev?.local ? me() : ev?.connectionId) ?? null;
    if (from) {
      const s = heardBy.get(msg.req) || new Set();
      s.add(from);
      remember(heardBy, msg.req, s);
    }
    const p = pending.get(msg.req);
    if (!p || !forMe(msg, { role: ctx?.role, playerId: ctx?.playerId })) return;
    pending.delete(msg.req);
    if (p.retryT) T.clearTimeout(p.retryT);
    if (p.failT) T.clearTimeout(p.failT);
    if (!msg.ok && msg.why) notify(`🚪 ${msg.why}`);
    log(`← ${msg.name || nameOf(from)} answered: ${msg.ok ? msg.did || "done" : msg.why || "no"} (${msg.op} door ${short(msg.line)})`);
  }

  // A click on our menu, on handles (local items) or on shared door lines.
  function onHandleMenu(context, { lock = false } = {}) {
    const items = (context?.items || []).filter((i) => tagOf(i)?.kind === "handle" && tagOf(i)?.host === host);
    for (const i of items) {
      const t = tagOf(i);
      const state = { open: !!t.open, locked: !!t.locked }; // as this screen shows it
      const op = lock ? (state.locked ? "unlock" : "lock") : opFor(state, { gm: isGm() });
      if (!op) notify(`🔒 ${LOCKED}`);
      else if (!lock || isGm()) ask(op, t.line, "menu"); // lock and unlock: the GM's menu only
    }
    deselect(items.map((i) => i.id));
  }

  function onLineMenu(context, { lock = false } = {}) {
    if (!isGm()) return;
    for (const item of context?.items || []) {
      const l = readLine(item);
      if (l?.kind !== "door") continue;
      act(lock ? (l.locked ? "unlock" : "lock") : l.open ? "close" : "open", l.id, "line-menu");
    }
  }

  // A selection that newly takes one handle (fog/doorclick.js). On a GM screen, whose handles are
  // locked, that is the DM's Ctrl+click (or a double-click): the door opens or closes, written here at
  // once (act, logged), and the handle is deselected. A player's plain select is left alone (a
  // right-click selects it too, and taking the selection away would close the menu it opened), unless
  // ctx.doorTap. On a GM screen, a selection that newly takes one door LINE with an icon drawn here (the
  // hidden line runs through the icon's middle, above it: a Ctrl+click on the icon's centre may take it)
  // works nothing, and the DM is told so (LINE_PICKED), once per such selection, with a Live log line.
  function onSelection(selection) {
    const ids = Array.isArray(selection) ? [...selection] : [];
    const key = ids.join(",");
    if (key === lastSel) return;
    const prev = lastIds;
    lastSel = key;
    lastIds = ids;
    const hit = clickedHandle(prev, ids, drawnById, { gm: isGm(), doorTap: !!ctx?.doorTap });
    const d = hit && drawnById(hit.id);
    if (!d) {
      const line = clickedLine(prev, ids, (id) => drawn.has(id), { gm: isGm() });
      if (line) {
        notify(LINE_PICKED, "INFO");
        log(`🚪 door ${short(line)}: its line was selected, not its icon, so nothing was worked`);
      }
      return;
    }
    const op = opFor(d, { gm: isGm() });
    if (op) ask(op, d.line, hit.via);
    else notify(`🔒 ${LOCKED}`);
    deselect([d.id]);
  }

  // ---- the door writes (a GM screen's) ----

  // Decide from the door as it stands now and write it, in one updateItems: the draft is checked and
  // edited in place (fog/lines.js doorEdit: explicit values, never a deleted key, nothing touched that
  // already holds them, so a draft already in that state asks Owlbear for nothing).
  async function writeDoor(req, snap, fromGm) {
    let r = null;
    let wrote = false;
    await OBR().scene.items.updateItems([req.line], (ds) => {
      for (const d of ds) {
        r = checkLive(req, snap, d, { fromGm });
        if (r.change && doorEdit(d.metadata, r.change)) wrote = true;
      }
    });
    if (!r) return { ok: false, why: "That isn't a door", change: null, state: null, found: false, wrote: false };
    return { ...r, wrote };
  }

  const didOf = (r) => (r.ok ? (r.wrote ? "done" : "already so") : r.found ? "lock found" : null);

  // A GM's own click: written from this screen, at once.
  async function act(op, line, via) {
    const req = { req: newId(), op, line, token: null, by: ctx?.playerId ?? null, dm: true, via };
    const who = ctx?.name || "the DM";
    let r;
    try {
      r = await writeDoor(req, ctx?.snapshot?.() ?? null, true);
    } catch (e) {
      log(`✖ the door write failed (${who}: ${op} door ${short(line)}): ${describe(e)}`, "error");
      notify(`🚪 The door didn't move (${describe(e)})`);
      return { ok: false, why: describe(e) };
    }
    log(`✎ ${who} (this screen) ${op} door ${short(line)} (${via || "?"}): ${r.ok ? didOf(r) : `refused: ${r.why}`}`);
    if (!r.ok && r.why) notify(`🚪 ${r.why}`);
    return r;
  }

  async function fromGmOf(msg, event) {
    if (msg?.dm !== true || event?.viaScene) return false;
    if (event?.local || (event?.connectionId && event.connectionId === ctx?.conn)) return isGm();
    try {
      const players = await OBR().party.getPlayers();
      return (players || []).some((p) => p?.connectionId === event?.connectionId && p?.role === "GM");
    } catch {
      return false;
    }
  }

  // Answer one player's request (this GM screen is the one to, by the rules).
  async function answer(msg, event) {
    const fromGm = await fromGmOf(msg, event);
    const who = msg.name || `player ${short(msg.by)}`;
    const snap = ctx?.snapshot?.() ?? null;
    let r = { ok: false, why: "The DM's screen isn't ready", change: null, state: null, found: false, wrote: false };
    if (snap) {
      try {
        r = await writeDoor(msg, snap, fromGm);
      } catch (e) {
        r = { ok: false, why: `The door didn't move (${describe(e)})`, change: null, state: null, found: false, wrote: false };
        log(`✖ the door write failed (${who}: ${msg.op} door ${short(msg.line)}): ${describe(e)}`, "error");
      }
    }
    const reply = { audience: fromGm ? "gm" : `player:${msg.by}`, req: msg.req, line: msg.line, op: msg.op, ok: r.ok,
                    state: shownState(r.state, { gm: fromGm }), why: r.why, did: didOf(r), from: me(), name: String(ctx?.name || "") };
    remember(answered, msg.req, reply);
    send(api, FOG_DOOR_REPLY_CH, reply, "ALL");
    log(`✔ answered ${who}: ${msg.op} door ${short(msg.line)}: ${r.ok ? didOf(r) : `refused: ${r.why}`}`);
    if (r.found && r.wrote) log(`🔒 ${who} tried door ${short(msg.line)}: it's locked, and the party knows it now`);
  }

  function onRequest(msg, ev) {
    if (!started || !isGm() || !msg?.req || typeof msg.line !== "string") return undefined;
    const who = msg.name || `player ${short(msg.by)}`;
    const p = pool();
    const how = answerHow(msg, { pool: p, me: me(), heard: heardBy.get(msg.req) || new Set(), answered: answered.has(msg.req) });
    const to = msg.to ? (msg.to === me() ? "to this screen" : `to ${nameOf(msg.to)}`) : "to any GM screen";
    log(`⇐ ${who} asks to ${msg.op} door ${short(msg.line)} (${to}${msg.any ? ", asked again" : ""}): `
      + (how === "no" ? `not this screen's (the answerer is ${nameOf(p[0] ?? null)})` : how === "again" ? "answered already: sent again" : "answering"));
    if (how === "no") return undefined;
    if (how === "again") {
      send(api, FOG_DOOR_REPLY_CH, answered.get(msg.req), "ALL");
      return undefined;
    }
    const go = () => {
      queue = queue.then(() => answer(msg, ev)).catch((e) => {
        error = `doors: ${describe(e)}`;
        log(`✖ answering failed: ${describe(e)}`, "error");
      });
      return queue;
    };
    if (how === "now") return go();
    // Not asked by name: wait a moment, and leave it to whoever answered meanwhile.
    return new Promise((resolve) => {
      T.setTimeout(() => {
        const by = heardBy.get(msg.req);
        if (answered.has(msg.req) || by?.size) {
          log(`stood down: ${nameOf([...(by || [])][0] ?? me())} answered ${who} first`);
          resolve();
          return;
        }
        resolve(go());
      }, Math.round(random() * HOLD_MS));
    });
  }

  // ---- start and stop ----

  async function start() {
    if (started) return;
    started = true;
    startedAt = T.now();
    const O = OBR();
    offs.push(on(api, FOG_DOOR_REPLY_CH, onReply), on(api, FOG_HELLO_CH, onHello));
    if (isGm()) offs.push(on(api, FOG_DOOR_CH, onRequest));
    try { offs.push(O.player.onChange((p) => onSelection(p?.selection))); } catch { /* no selection here */ }
    try { offs.push(O.scene.local.onChange(onLocal)); } catch { /* no snap-back here */ }
    const icons = menuIcons(host, icon);
    const made = [O.contextMenu.create({ id: menuId.handle, icons: icons[MENU.handle], onClick: (c) => onHandleMenu(c) })];
    if (isGm()) {
      made.push(
        O.contextMenu.create({ id: menuId.handleLock, icons: icons[MENU.handleLock], onClick: (c) => onHandleMenu(c, { lock: true }) }),
        O.contextMenu.create({ id: menuId.line, icons: icons[MENU.line], onClick: (c) => onLineMenu(c) }),
        O.contextMenu.create({ id: menuId.lineLock, icons: icons[MENU.lineLock], onClick: (c) => onLineMenu(c, { lock: true }) }));
    }
    menusOn = true;
    // Who's there: a GM screen announces itself (and asks the others to), a player only asks.
    if (isGm()) {
      hello({ ask: true });
      helloLoop();
    } else {
      send(api, FOG_HELLO_CH, { conn: me(), role: String(ctx?.role || "PLAYER"), ask: true }, "ALL");
    }
    noteAnswerer();
    try {
      await Promise.all(made);
    } catch (e) {
      error = `doors: a menu could not be made: ${describe(e)}`;
      log(`✖ ${error}`, "error");
    }
  }

  async function stop() {
    if (!started) return;
    started = false;
    startedAt = null;
    while (offs.length) {
      const off = offs.pop();
      try { if (typeof off === "function") off(); } catch { /* gone */ }
    }
    if (isGm()) hello({ bye: true }); // the other screens pick their answerer again at once
    if (helloT) { T.clearTimeout(helloT); helloT = null; }
    for (const p of pending.values()) {
      if (p.retryT) T.clearTimeout(p.retryT);
      if (p.failT) T.clearTimeout(p.failT);
    }
    pending.clear();
    gms.clear();
    answered.clear();
    heardBy.clear();
    lastAnswerer = undefined;
    lastSeenWriter = undefined;
    if (snapTimer) { T.clearTimeout(snapTimer); snapTimer = null; }
    lastSel = "";
    lastIds = [];
    if (menusOn) {
      menusOn = false;
      const gone = isGm() ? Object.values(menuId) : [menuId.handle];
      await Promise.all(gone.map((id) => Promise.resolve().then(() => OBR().contextMenu.remove(id)).catch(() => {})));
    }
  }

  function status() {
    const a = started ? answerer() : null;
    const w = started ? seenWriter() : null;
    return { handles: drawn.size, pending: pending.size, menus: menusOn, error, gms: started ? pool().length : 0,
             answerer: a ? { conn: a, name: nameOf(a), here: a === me(), seen: a === me() || gms.get(a)?.seen === SEEN_CAP,
                             shapes: a === me() || gms.get(a)?.shapes === SHAPES_CAP } : null,
             seen_writer: w ? { conn: w, name: nameOf(w), here: w === me() } : null };
  }

  // Is this screen the one GM screen that answers the players' doors? A GM screen whose doors have
  // run ANSWERER_SETTLE_MS (the other GM screens' hellos are in by then) and that is the lowest
  // connection it knows. False on a player's screen, before start, after stop.
  function isAnswerer() {
    if (!started || !isGm() || startedAt == null || T.now() - startedAt < ANSWERER_SETTLE_MS) return false;
    const a = answerer();
    return a != null && a === me();
  }

  // ...and the one that writes the explored memory: the same, among the GM screens that can write its
  // shapes (their hello says seen: SEEN_CAP and shapes: SHAPES_CAP). Usually the same screen; an older
  // build's tab answers doors only.
  function isSeenWriter() {
    if (!started || !isGm() || startedAt == null || T.now() - startedAt < ANSWERER_SETTLE_MS) return false;
    const w = seenWriter();
    return w != null && w === me();
  }

  return { start, stop, sync, clear, status, ask, act, isAnswerer, isSeenWriter };
}
