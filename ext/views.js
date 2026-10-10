// Where each screen looks (T4 of docs/planning/2026-10-09-decision-record.md, decided after game
// night 2, when Owlbear's Sync View moved the projector and players lost their PCs after portal trips).
//
//   📺 the projector holds its view   The table screen (the Cast receiver, bus.js kindOf "table")
//        keeps the view the DM aimed it at, kept in the scene's metadata (PROJECTOR_KEY), and goes
//        back to it whenever anything else moves it. Owlbear can't stop a Sync View, and the SDK has
//        no "view changed" event, so it looks 4 times a second and undoes the move.
//   📺 aiming it                       From a GM screen: "Show my view" (the DM's own view, zoom and
//        all), "Projector here" on a map, a room or a token (centred there with the projector's zoom
//        kept, so the squares stay the size of the minis), and "Unlock" (Sync View moves it again).
//   📍 find me                         On a player's screen: when their PC lands on another map and
//        someone else moved it (the DM's portal trip, 🧭 Bring PCs), their view follows it. Portals
//        already re-centres whoever moved it. "📍 Find my PC" in their box does it on a tap.
//
// No SDK import: every Owlbear call goes through `api`, so check_views.mjs runs it against a fake
// room and a fake clock. background.js starts the parts each screen needs; the GM box
// (popover.html), the right-click menu and the toolbar button aim.
import { PROJECTOR_KEY } from "./keys.js?v=da53a06";
import { footprint } from "./fx/place.js?v=da53a06";

export const POLL_MS = 250; // the table screen looks at its view this often
const SETTLE_MS = 200; // after setting the view: looked at again once it has settled
const GLIDE_MS = 1000; // ...after gliding there (animateTo)
const STUBBORN_TRIES = 20; // put back this often in a row (about 4 s): say so in the log, and carry on
const POS_TOL = 1.5; // screen pixels: the same view, give or take Owlbear's rounding
const SCALE_TOL = 0.002; // ...and 0.2% of zoom
const NOTE_EVERY_MS = 60000; // "📺 Something moved the projector": to the GM screens at most this often
const SNAP_WINDOW_MS = 10 * 60 * 1000; // the moves back the GM box counts
const STATUS_EVERY_MS = 15000; // the table screen tells the GM screens how it is this often
const STATUS_MIN_MS = 2000; // ...and on a change, but no more often than this
const FOLLOW_WAIT_MS = 300; // find me: a move that comes in steps (🧭 Bring PCs) settles first
const EDGE = 0.08; // find me: a PC this close to the screen's edge counts as off it
const SQUARES = 12; // 🎯 Go to PC and 📍 Find my PC: zoomed in so about this many squares fit across

const defaultTimers = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (t) => clearInterval(t),
  now: () => Date.now(),
};

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100;

// ---- views, in numbers ----
// A view is {position, scale, width, height}: Owlbear's viewport position is where the scene's
// origin is on the screen, its scale is screen pixels per scene pixel, and width and height are the
// screen's size.

// The scene rectangle a view shows: {x, y, w, h} in scene pixels, or null for a broken view.
export function viewRect(t) {
  if (!t || !finite(t.position?.x, t.position?.y, t.scale, t.width, t.height)) return null;
  if (!(t.scale > 0) || !(t.width > 0) || !(t.height > 0)) return null;
  return { x: -t.position.x / t.scale, y: -t.position.y / t.scale, w: t.width / t.scale, h: t.height / t.scale };
}

// The view that shows all of rectangle r on a width x height screen, centred and as large as it
// fits (a screen of another shape shows a little more on two sides): {position, scale}, or null.
export function fitRect(r, width, height) {
  if (!r || !finite(r.x, r.y, r.w, r.h, width, height) || !(r.w > 0) || !(r.h > 0) || !(width > 0) || !(height > 0)) return null;
  const scale = Math.min(width / r.w, height / r.h);
  return { position: { x: width / 2 - (r.x + r.w / 2) * scale, y: height / 2 - (r.y + r.h / 2) * scale }, scale };
}

// The view that puts scene point `point` in the middle of the screen: {position, scale}, zoomed in
// so about `squares` squares fit across (or kept as it is when already closer). The same as 🎯 Go to
// PC's in goto.js (check_views.mjs compares them): goto.js keeps its own, so the GM box and the menu
// never depend on this file loading.
export function viewOn(point, { dpi, width, height, scale, squares = SQUARES }) {
  const s = Math.max(scale || 0, width / (squares * dpi));
  return { position: { x: -point.x * s + width / 2, y: -point.y * s + height / 2 }, scale: s };
}

// ...the same with the zoom kept as it is (find me: the player chose their zoom).
export function centreOn(point, { width, height, scale }) {
  return { position: { x: width / 2 - point.x * scale, y: height / 2 - point.y * scale }, scale };
}

const samePosition = (a, b) => Math.abs(a.position.x - b.position.x) <= POS_TOL && Math.abs(a.position.y - b.position.y) <= POS_TOL;
const sameZoom = (a, b) => Math.abs(a.scale - b.scale) <= SCALE_TOL * Math.max(a.scale, b.scale);

// The same view, give or take Owlbear's rounding?
export function sameView(a, b) {
  if (!a || !b || !finite(a.scale, b.scale, a.position?.x, a.position?.y, b.position?.x, b.position?.y)) return false;
  return sameZoom(a, b) && samePosition(a, b);
}

// The scene point in the middle of a view.
export const middleOf = (t) => ({ x: (t.width / 2 - t.position.x) / t.scale, y: (t.height / 2 - t.position.y) / t.scale });

// Is scene point p on this view, clear of its edges (`edge`: the share of each side kept clear)?
export function inView(p, t, edge = EDGE) {
  if (!p || !viewRect(t) || !finite(p.x, p.y)) return false;
  const sx = p.x * t.scale + t.position.x, sy = p.y * t.scale + t.position.y;
  return sx >= t.width * edge && sx <= t.width * (1 - edge) && sy >= t.height * edge && sy <= t.height * (1 - edge);
}

// ---- the lock, as the scene keeps it ----

// The scene's lock (PROJECTOR_KEY's value), read safely: {on: true, x, y, w, h, at} (the rectangle
// the projector shows), {on: false, at} (unlocked), or null (never aimed, or one this build can't read).
export function lockOf(v) {
  if (!v || typeof v !== "object" || v.v !== 1) return null;
  const at = finite(v.at) ? v.at : 0;
  if (v.on === false) return { on: false, at };
  if (v.on !== true || !finite(v.x, v.y, v.w, v.h) || !(v.w > 0) || !(v.h > 0)) return null;
  return { on: true, x: v.x, y: v.y, w: v.w, h: v.h, at };
}

// What 📺 Show my view writes: the rectangle this view shows. `at`: when (a new aim at the same
// view still counts as one).
export function lockOfView(t, at) {
  const r = viewRect(t);
  return r && { v: 1, on: true, x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h), at };
}

// What 📺 Projector here writes: a rectangle of `size` ({w, h}: the projector's lock now, so its
// zoom stays, else the DM's own view) centred on scene point c.
export function lockAround(c, size, at) {
  if (!c || !size || !finite(c.x, c.y, size.w, size.h) || !(size.w > 0) || !(size.h > 0)) return null;
  return { v: 1, on: true, x: r2(c.x - size.w / 2), y: r2(c.y - size.h / 2), w: r2(size.w), h: r2(size.h), at };
}

export const unlocked = (at) => ({ v: 1, on: false, at });

// ---- maps and tokens ----

// The middle of an item on the scene: a token's from its image (its position is wherever its
// anchor is), anything else's position. null when it has neither.
export function centreOf(item, dpi) {
  const fp = footprint(item, dpi);
  if (fp) return { x: fp.x, y: fp.y };
  const p = item?.position;
  return p && finite(p.x, p.y) ? { x: p.x, y: p.y } : null;
}

// The scene's map images (MAP-layer images) as rectangles, the topmost first (as Owlbear stacks
// them: by zIndex, then the scene's order).
export function mapRects(items, dpi) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((i, n) => {
    if (i?.layer !== "MAP" || (i.type !== undefined && i.type !== "IMAGE")) return;
    const fp = footprint(i, dpi);
    if (!fp) return;
    out.push({ id: i.id, x0: fp.x - fp.w / 2, y0: fp.y - fp.h / 2, x1: fp.x + fp.w / 2, y1: fp.y + fp.h / 2,
               z: finite(i.zIndex) ? i.zIndex : 0, n });
  });
  return out.sort((a, b) => b.z - a.z || b.n - a.n);
}

// The map image under scene point p (its id), from mapRects(), or null (between the maps).
export function mapAt(p, rects) {
  if (!p || !finite(p.x, p.y)) return null;
  const hit = (rects || []).find((r) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1);
  return hit ? hit.id : null;
}

// ---- live: reading and setting this screen's view ----

async function readView(OBR) {
  const [position, scale, width, height] = await Promise.all([
    OBR.viewport.getPosition(), OBR.viewport.getScale(), OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  const t = { position: { x: position?.x, y: position?.y }, scale, width, height };
  return viewRect(t) ? t : null;
}

async function setView(OBR, t) {
  // The zoom first: a new zoom may move the view about its middle, and the position then puts it right.
  await OBR.viewport.setScale(t.scale);
  await OBR.viewport.setPosition(t.position);
}

// ---- 📺 the table screen: hold the view ----

// The projector's lock. ctx: {log(text)}; deps: {timers, note(text): a line for the GM screens,
// report(status): status() for the GM box}. start() once this is the table screen, stop() when it
// no longer is. tick() is the look, exported for the offline check.
//
// A look: nothing to do without a lock. A new lock: glide there (the lock's rectangle fitted to this
// screen). A new screen size: the same rectangle fitted again. After our own move has settled: did
// the screen get there? If not, set it again (Owlbear's own Sync View animation may still be running),
// and when Owlbear kept the position but not the zoom (past its limits), the same middle at the zoom
// it allows is held instead. Never anyone else's view. Otherwise, when the view isn't the held one,
// something else moved it (Sync View): set it back, and tell the GM screens (at most once a minute)
// and who has Sync View switched on, from the party list.
export function createProjectorLock(api, ctx = {}, deps = {}) {
  const OBR = api?.OBR ?? api;
  const T = deps.timers || defaultTimers;
  const log = (text) => {
    try { ctx.log?.(`projector: ${text}`); } catch { /* nowhere to say it */ }
  };
  let running = false, busy = false;
  let poll = null, beat = null, statusTimer = null;
  let lock = null, sig = ""; // the scene's lock (lockOf) and how it read last, to tell a new one
  let want = null; // where this screen should be: a view
  let held = false; // ...and it's there
  let pending = false; // a new lock: glide there on the next look
  let check = null; // our own move, looked at once it has settled: {target, until, tries}
  const snaps = []; // when something moved it and it went back (ms), the last 10 minutes
  let moved = 0; // ...and how often in all, since this screen started (the bridge's log counts on)
  let syncOn = []; // who has Sync View switched on, by name
  let lastNote = -Infinity, lastStatus = -Infinity, statusSig = "";
  const offs = [];

  function status() {
    const now = T.now();
    while (snaps.length && now - snaps[0] > SNAP_WINDOW_MS) snaps.shift();
    return { locked: !!lock?.on, held: !!lock?.on && held, at: lock?.at || 0, snaps: snaps.length, moved,
             last_snap_s: snaps.length ? Math.round((now - snaps[snaps.length - 1]) / 1000) : null, sync_on: [...syncOn] };
  }

  function changed(force = false) {
    // To the GM boxes: on a change (at most every 2 s; the rest follows when the wait is over),
    // and every 15 s anyway (force).
    const s = status();
    const key = JSON.stringify({ ...s, last_snap_s: null });
    if (!force && key === statusSig) return;
    const now = T.now();
    if (now - lastStatus < STATUS_MIN_MS) {
      if (!statusTimer) statusTimer = T.setTimeout(() => { statusTimer = null; changed(true); }, STATUS_MIN_MS - (now - lastStatus));
      return;
    }
    statusSig = key;
    lastStatus = now;
    try { deps.report?.(s); } catch (e) { log(`status not sent: ${e?.message || e}`); }
  }

  function snapped(now) {
    snaps.push(now);
    moved++;
    held = false;
    changed();
    if (now - lastNote < NOTE_EVERY_MS) return;
    lastNote = now;
    const who = syncOn.length ? ` Sync View is switched on for: ${syncOn.join(", ")}.` : "";
    log(`something moved it: back to the locked view.${who}`);
    try {
      deps.note?.(`📺 Something moved the projector (Sync View?), so it went back to the view you locked.${who}`);
    } catch { /* the GM box shows it too */ }
  }

  function settled(t) {
    want = { position: { ...t.position }, scale: t.scale, width: t.width, height: t.height };
    check = null;
    if (!held) {
      held = true;
      changed();
    }
  }

  async function go(target, glide) {
    want = target;
    held = false;
    check = { target, tries: 0, until: T.now() + (glide ? GLIDE_MS : SETTLE_MS) };
    if (glide) await OBR.viewport.animateTo({ position: target.position, scale: target.scale });
    else await setView(OBR, target);
    changed();
  }

  async function tick() {
    if (!running || busy || !lock?.on) return;
    busy = true;
    try {
      if (!(await OBR.scene.isReady())) return;
      const now = T.now();
      if (check && now < check.until) return;
      const t = await readView(OBR);
      if (!t || !running || !lock?.on) return;
      if (pending || !want || t.width !== want.width || t.height !== want.height) {
        // A new lock (glide there), or this screen changed size (the same rectangle, fitted again).
        const glide = pending;
        pending = false;
        const fit = fitRect(lock, t.width, t.height);
        if (fit) await go({ ...fit, width: t.width, height: t.height }, glide);
        return;
      }
      if (check) {
        if (sameView(t, check.target)) return settled(t);
        let target = check.target;
        if (samePosition(t, target) && !sameZoom(t, target)) {
          // Owlbear kept its own zoom (past its limits): the same middle, at the zoom it allows.
          log("Owlbear won't zoom that far: the same middle at the zoom it allows");
          target = { ...centreOn(middleOf(target), t), width: t.width, height: t.height };
          want = target;
        }
        const tries = check.tries + 1;
        if (tries === STUBBORN_TRIES) log("something keeps moving it (Sync View switched on somewhere?): still putting it back");
        check = { target, tries, until: now + SETTLE_MS };
        await setView(OBR, target);
        return;
      }
      if (sameView(t, want)) return;
      snapped(now);
      check = { target: want, tries: 0, until: now + SETTLE_MS };
      await setView(OBR, want);
    } catch (e) {
      log(`couldn't look at the view: ${e?.message || e}`);
    } finally {
      busy = false;
    }
  }

  function onMeta(meta) {
    const next = lockOf(meta?.[PROJECTOR_KEY]);
    const s = JSON.stringify(next);
    if (s === sig) return;
    sig = s;
    lock = next;
    check = null;
    held = false;
    pending = !!lock?.on;
    if (!lock?.on) want = null;
    log(lock?.on ? `aimed: ${Math.round(lock.w)} x ${Math.round(lock.h)} scene px` : lock ? "unlocked: Sync View moves it again" : "no lock in this scene");
    changed();
  }

  async function onReady(ready) {
    // Each scene has its own lock (or none): forget the last scene's.
    sig = "";
    lock = null;
    want = null;
    check = null;
    held = false;
    pending = false;
    if (!ready) return changed();
    try {
      onMeta(await OBR.scene.getMetadata());
    } catch (e) {
      log(`couldn't read the scene's lock: ${e?.message || e}`);
    }
  }

  function takeParty(players) {
    const next = (Array.isArray(players) ? players : []).filter((p) => p?.syncView).map((p) => String(p.name || "someone"));
    if (next.join("\n") === syncOn.join("\n")) return;
    syncOn = next;
    changed();
  }

  function sub(make) {
    try {
      const off = make();
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      log(`can't listen: ${e?.message || e}`);
    }
  }

  function start() {
    if (running) return;
    running = true;
    sub(() => OBR.scene.onMetadataChange((m) => { if (running) onMeta(m); }));
    sub(() => OBR.scene.onReadyChange((r) => { if (running) onReady(r); }));
    sub(() => OBR.party.onChange((p) => { if (running) takeParty(p); }));
    Promise.resolve().then(() => OBR.party.getPlayers()).then((p) => { if (running) takeParty(p); }, () => { /* next change */ });
    Promise.resolve().then(() => OBR.scene.isReady()).then((r) => (running && r ? onReady(true) : null), () => { /* not ready */ });
    poll = T.setInterval(tick, POLL_MS);
    beat = T.setInterval(() => changed(true), STATUS_EVERY_MS);
    log("this is the table screen: it holds the view the DM aims it at");
  }

  function stop() {
    running = false;
    for (const t of [poll, beat]) if (t) T.clearInterval(t);
    if (statusTimer) T.clearTimeout(statusTimer);
    poll = beat = statusTimer = null;
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* gone */ }
    }
    lock = null;
    sig = "";
    want = null;
    check = null;
    held = false;
    pending = false;
  }

  return { start, stop, tick, status, get running() { return running; } };
}

// ---- 📍 a player's screen: find me ----

// ctx: {playerId, isPc(item), log(text)}; deps: {timers, ownToken(): the token the DM linked this
// player to (their roster entry's), or null}. This player's PC is that token, or a root token on
// the CHARACTER layer they own (the Party spells link hands it over).
export function createFindMe(api, ctx = {}, deps = {}) {
  const OBR = api?.OBR ?? api;
  const T = deps.timers || defaultTimers;
  const log = (text) => {
    try { ctx.log?.(`find me: ${text}`); } catch { /* nowhere to say it */ }
  };
  const last = new Map(); // this player's token id -> the map image under it when last seen (null: none)
  let dpi = 150, running = false, wait = null, follow = null;
  const offs = [];
  const me = () => ctx.playerId ?? null;
  const own = () => {
    try { return deps.ownToken?.() || null; } catch { return null; }
  };
  const mine = (i) => !!i?.id && !i.attachedTo
    && (i.id === own() || (i.layer === "CHARACTER" && !!me() && i.createdUserId === me()));
  const pcFirst = (i) => {
    try { return !!ctx.isPc?.(i); } catch { return false; }
  };

  function look(items, moved) {
    const maps = mapRects(items, dpi);
    for (const i of Array.isArray(items) ? items : []) {
      if (!mine(i)) continue;
      const c = centreOf(i, dpi);
      if (!c) continue;
      const m = mapAt(c, maps);
      const had = last.get(i.id);
      last.set(i.id, m);
      // On another map, moved by someone else: a portal trip the DM made, or 🧭 Bring PCs. (A move
      // this player made: Portals re-centred them, or they dragged it where they were looking.)
      if (moved && had !== undefined && had !== m && i.lastModifiedUserId !== me()) follow = i.id;
    }
    if (follow && !wait) wait = T.setTimeout(go, FOLLOW_WAIT_MS);
  }

  async function go() {
    wait = null;
    const id = follow;
    follow = null;
    if (!running || !id) return;
    try {
      const [item] = await OBR.scene.items.getItems([id]); // where it is now, after every step of the move
      const c = item ? centreOf(item, dpi) : null;
      const t = c ? await readView(OBR) : null;
      if (!t || inView(c, t)) return; // already on this screen
      await OBR.viewport.animateTo(centreOn(c, t));
      log("followed this player's PC to another map");
    } catch (e) {
      log(`couldn't follow: ${e?.message || e}`);
    }
  }

  // 📍 Find my PC: the view on this player's PC (the linked one first, then one that counts as a
  // PC), zoomed in when far out, as 🎯 Go to PC does for the DM. False when there's none here.
  async function findNow() {
    if (!(await OBR.scene.isReady())) return false;
    const items = await OBR.scene.items.getItems();
    const id = own();
    const pick = items.find((i) => id && i.id === id && !i.attachedTo) || items.find((i) => mine(i) && pcFirst(i))
      || items.find(mine);
    const c = pick ? centreOf(pick, dpi) : null;
    const t = c ? await readView(OBR) : null;
    if (!t) return false;
    await OBR.viewport.animateTo(viewOn(c, { dpi, width: t.width, height: t.height, scale: t.scale }));
    return true;
  }

  async function seed() {
    last.clear();
    try {
      if (!(await OBR.scene.isReady())) return;
      dpi = (await OBR.scene.grid.getDpi()) || dpi;
      look(await OBR.scene.items.getItems(), false);
    } catch (e) {
      log(`couldn't read the map: ${e?.message || e}`);
    }
  }

  function sub(make) {
    try {
      const off = make();
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      log(`can't listen: ${e?.message || e}`);
    }
  }

  function start() {
    if (running) return;
    running = true;
    sub(() => OBR.scene.items.onChange((items) => { if (running) look(items, true); }));
    sub(() => OBR.scene.onReadyChange((r) => {
      if (!running) return;
      last.clear();
      if (r) seed();
    }));
    sub(() => OBR.scene.grid.onChange((g) => { if (g?.dpi > 0) dpi = g.dpi; }));
    seed();
  }

  function stop() {
    running = false;
    if (wait) T.clearTimeout(wait);
    wait = follow = null;
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* gone */ }
    }
    last.clear();
  }

  return { start, stop, findNow, get running() { return running; } };
}

// ---- 📺 from a GM screen: aim the projector ----

// how: {view: true} (this screen's view), {item: id, label?} (centred on that map, room or token,
// the projector's zoom kept) or {off: true} (unlock). The lock goes in the scene's metadata, and the
// table screen does the rest. -> {ok, text: for the DM's notification, lock}.
export async function aimProjector(api, how = {}, { now = Date.now() } = {}) {
  const OBR = api?.OBR ?? api;
  if (!(await OBR.scene.isReady())) return { ok: false, text: "📺 Open a scene first" };
  let lock, text;
  if (how.off) {
    lock = unlocked(now);
    text = "🔓 Projector unlocked: Sync View moves it again";
  } else {
    const t = await readView(OBR);
    if (!t) return { ok: false, text: "📺 Couldn't read this screen's view" };
    if (how.item) {
      let b = null;
      try { b = await OBR.scene.items.getItemBounds([how.item]); } catch { b = null; }
      const cur = lockOf((await OBR.scene.getMetadata())?.[PROJECTOR_KEY]);
      lock = lockAround(b?.center, cur?.on ? cur : viewRect(t), now);
      if (!lock) return { ok: false, text: "📺 Couldn't find that on the map" };
      text = `📺 Projector centred on ${how.label ? String(how.label) : "that"}${cur?.on ? ", same zoom" : ", at your zoom"}`;
    } else {
      lock = lockOfView(t, now);
      text = "📺 The projector shows your view and stays there";
    }
  }
  await OBR.scene.setMetadata({ [PROJECTOR_KEY]: lock });
  return { ok: true, text, lock };
}

// ---- the GM box's 📺 Projector lines ----

const ago = (s) => (!finite(s) || s < 0 ? "" : s < 10 ? "just now" : s < 90 ? `${Math.round(s)} s ago`
  : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

// What the GM box says about the projector: [{cls, text}]. lock: the scene's (lockOf); screens: the
// table screens heard ([{name, age_s, locked, held, at, snaps, last_snap_s, sync_on}]); ownSync:
// this tab has Sync View switched on; now: the clock, to say how long ago it was aimed.
export function projectorLines({ lock = null, screens = [], ownSync = false, now = Date.now() } = {}) {
  const out = [];
  const on = !!lock?.on;
  const aimed = on && lock.at ? ` (aimed ${ago((now - lock.at) / 1000)})` : "";
  if (!on) out.push({ cls: "dim", text: "🔓 Not locked: Sync View from any screen moves it. Tap 📺 Show my view, or right-click a map → 📺 Projector here." });
  const list = Array.isArray(screens) ? screens : [];
  if (on && !list.length) {
    out.push({ cls: "warn", text: `🔒 Locked${aimed}, but no projector has answered yet. Is the cast running? After a publish, restart the cast.` });
  }
  for (const s of list) {
    const who = list.length > 1 && s.name ? `${s.name}: ` : "";
    const taken = on && s.locked && s.at === lock.at; // the screen has this lock, not an older one
    if (taken && s.held) out.push({ cls: "ok", text: `${who}🔒 Holding the view you locked${aimed}.` });
    else if (taken) out.push({ cls: "dim", text: `${who}⏳ Going to the view you locked…` });
    else if (on) out.push({ cls: "warn", text: `${who}⏳ Hasn't taken the new lock yet. If this stays, restart the cast (it may have an older build).` });
    const last = finite(s.last_snap_s) ? s.last_snap_s + (finite(s.age_s) ? s.age_s : 0) : null; // as of now, not of its report
    if (s.snaps > 0) out.push({ cls: "warn", text: `${who}↩ Moved back ${s.snaps}× in the last 10 min (last ${ago(last)}).` });
  }
  const sync = [...new Set(list.flatMap((s) => (Array.isArray(s.sync_on) ? s.sync_on : [])))];
  if (sync.length) out.push({ cls: "warn", text: `⚠ Sync View is switched on for: ${sync.join(", ")}. Switch it off on that screen (bottom right).` });
  if (ownSync) out.push({ cls: "warn", text: "⚠ Sync View is switched on on this tab: switch it off (bottom right), or every move here pulls the other screens along." });
  return out;
}
