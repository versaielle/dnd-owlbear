// Our own vision layer's lifecycle (docs/vision-layer-spec.md sections 9-11; the builders' contract
// is docs/vision-layer-b2b3.md, this file is its section 4 "fog.js", and docs/vision-layer-b4.md
// section 7 for the explored memory): the scene switch "🌫 Our fog", one snapshot per pass for the
// six parts (fog/cover.js: the dark covers, fog/walls.js: the local walls, fog/sight.js: a light per
// PC, fog/doors.js: the door icons, their menus, the door writes and the players' requests,
// fog/seen.js: the explored squares, written by the one GM screen that answers the doors,
// fog/memory.js: the explored memory drawn on every screen), the scene's fog colour (snap.fogColor),
// the throttle, and the 🪵 Live log (fog/livelog.js). The dark covers (docs/vision-layer-2024.md
// section 12, fix C) black out, on players' screens and the projector only, every creature that
// stands unseen on 🌑 ground with a PC on it (where a PC's sight light lifts the fog, and under the
// fog too, so it is on before the fog lifts), its HP bar and badges too, only where our overlay
// paints black.
//
//   SETTLE_MS, MAX_WAIT_MS, RETRY_MS, RETRY_MAX_MS
//   SMOKE_VISION_OFF        Smoke & Spectre's own scene switch "Disable Vision" (its 5.0.4 MetadataKeys
//                           FOG_DISABLE_VISION): true = Smoke draws no vision lights in this scene
//   cleanFog(v)             FOG_KEY's value made safe: {v: 1, on, at, prev: {filled} | null} (an older
//                           build's prev also held the fog's colour: read fine, and dropped)
//   fogOn(sceneMeta)        is 🌫 Our fog on in this scene
//   switchValue(raw, on, now)   the switch's own value at a click: {v: 1, on, at: now, prev?} (prev kept)
//   writeSwitch(OBR, on, now, {log})   the whole switch, from the GM screen whose chip was tapped: on
//                           keeps the fog's fill in prev, turns the fill on and adopts Smoke's door state
//                           (drift); off puts prev's fill back and clears prev. -> {next, filled, adopted}
//   offWords(filled)        what the scene shows once 🌫 is off, by the fill writeSwitch put back (its
//                           `filled`: true, false, null = none kept); never "Smoke & Spectre works": on a
//                           game night it is switched off in the room, and then nothing draws sight at all
//   SMOKE_CHECK_MS          a GM screen looks for Smoke's running local items at most this often
//   isSmokeLocal(item)      a local LIGHT or WALL that Smoke & Spectre draws while it runs (its keys, none of ours)
//   smokeVision(sceneMeta, localItems)   {here, on}: Smoke runs on this screen now (its local lights
//                           or walls are here), and its vision isn't switched off in the scene. Its
//                           sceneId and a token's hasVision never count: they outlive the extension,
//                           and our own lights writer writes hasVision on the PCs
//   inputSig(sceneMeta) / roomSig(roomMeta)   the metadata a pass depends on
//   buildSnapshot(items, sceneMeta, roomMeta, grid, ctx)   the one snapshot every part plans from (pure)
//   createFog(api, ctx, opts) -> {start(), stop(), status(), setOn(on), setRoofs(on), kick(), snapshot(), log(kind, text), logLines(max)}
//
// INERT WHEN OFF. While the scene's FOG_KEY.on isn't true, this file only watches the scene's
// metadata (and whether a scene is open): no local item, no write, no menu, no item listener. The
// three parts are made the first time the switch is seen on. Smoke & Spectre works as today.
//
// SAME PICTURE EVERYWHERE. Every screen that draws (GM tabs, the projector's Cast receiver, phones;
// never a copy that only relays) builds its lights, walls and handles from the same snapshot. The
// screen-dependent choices: the GM pass-through, ctx.gmPass (contract section 8): "B" (the default)
// puts each PC's light standalone on a GM screen, so no wall stops the DM's moves there; and the door
// icons (a player's screen shows a lock only once the party has found it, fog/doors.js).
//
// NO LEADER. Each shared write comes from the screen where it is asked for, at once:
//   - the 🌫 switch, from the GM screen whose chip was tapped (writeSwitch): on keeps the fog fill it
//     finds in FOG_KEY.prev (an existing prev is the scene's own from before), turns the fill on in
//     the scene's own fog colour (never changed, as Smoke leaves it), and gives every door line that
//     has both formats Smoke's state (fog/lines.js drift: Smoke was in charge until now); off puts
//     prev's fill back (the colour is left alone) and writes prev: null (never a deleted key);
//   - a GM's own door click, from that GM screen; a player's door request, from the GM screen that
//     answers it (fog/doors.js). The lights writer's leader gate (fx/lightwriter.js) is the lights'
//     alone.
//
// PASSES. One at a time (a request during one gives one more after it); stop() waits for the one
// in flight, which checks after every await that it still should draw, so a copy stepping aside
// mid-pass never adds items after its own clean-up. Item changes settle for SETTLE_MS, but a long
// drag still gets a pass every MAX_WAIT_MS. Scene and room metadata trigger a pass only when an
// input changed (FOG_KEY, SCENE_LIGHTING_KEY, Smoke's Disable Vision, RULES_KEY, WEATHER_KEY,
// FOG_LOOK_KEY, ROOFS_KEY; PARTY_SENSES_KEY, PARTY_KEY). A grid change re-reads the grid. A scene closing forgets every
// record (Owlbear drops local items with it); a scene opening gets a pass that sweeps. A part whose
// sync fails is synced again after RETRY_MS, doubling to RETRY_MAX_MS. Each part skips a sync whose
// plan is unchanged, so a pass with nothing new asks nothing of Owlbear. The order in each pass is
// cover, walls, sight, doors, seen, memory: the dark covers first, so neither a door that opens (its
// wall goes) nor a sight light that grows lifts the fog off an unseen creature before its cover is on
// (and every unseen creature on a 🌑 map with a PC on it has one, under the fog too: fog/cover.js);
// the walls before the lights, so a switch-on never shows a light before the walls that stop it; seen
// works only on the answerer (fog/doors.js isAnswerer); memory goes last of the six, and a seen write
// echoes back as an item change, so the next pass draws it. After them (ALL_PARTS) 🛖 Roofs
// (fog/roofs.js): the roof pieces, taken in and written by the answerer only, never awaited by the
// pass; 🌫 off parks them all from the tapping screen (writeSwitch) and from the writer. Roofs keeps
// its own back-off and says its own errors (OWN_RETRY): its failure never fails the pass (no ⚠, no
// retry of the pass). An uploaded roof original (its name parses as a piece's) is no map rectangle,
// so the memory never writes on it before it's taken in. A GM screen that isn't the writer tells
// roofs.js why (partCtx.writerWhy: its doors not started or settling, or another screen's name). The map images'
// own metadata (SEEN_KEY, MAP_FOG_KEY, MEMORY_KEY, MAP_DARKNESS_KEY) arrive as item changes; the
// scene's fog colour (OBR.scene.fog getColor/onChange, guarded) gives a pass when it changes. A GM
// screen also looks every ANSWER_WATCH_MS whether it became (or stopped being) the answerer, and
// passes when it did, so the explored squares start without anyone moving.
//
// 🪵 LIVE LOG. Every screen keeps its own fog and door lines and broadcasts the new ones (fog/livelog.js);
// a GM screen collects them all for the GM box. A pass logs only when it fails (once per new error).
//
// While on, a GM screen where Smoke & Spectre is RUNNING with its vision on (its own local lights or
// walls are on that screen, and its "Disable Vision" isn't set) gets one notification per switch-on,
// and status().smoke says so for the 🔥 Lighting list: both would draw fog. It looks on a pass and on
// the answerer watch, at most every SMOKE_CHECK_MS (one OBR.scene.local.getItems), never on a
// player's screen. Smoke's leftover shared data (its sceneId, a token's hasVision) never counts.

import { FOG_KEY, FOG_LOCAL_KEY, FOG_LOOK_KEY, PARTY_KEY, PARTY_SENSES_KEY, ROOFS_KEY, RULES_KEY, SCENE_LIGHTING_KEY, SMOKE, WEATHER_KEY } from "../keys.js?v=90a5d4e";
import { planCtx } from "../fx/lightwriter.js?v=90a5d4e";
import { readGrid } from "../fx/darkness.js?v=90a5d4e";
import { mapRects } from "../views.js?v=90a5d4e";
import { doorEdit, drift, occupiedMaps, readLines } from "./lines.js?v=90a5d4e";
import { mapStates } from "./maps.js?v=90a5d4e";
import { createSight } from "./sight.js?v=90a5d4e";
import { createWalls } from "./walls.js?v=90a5d4e";
import { ANSWERER_SETTLE_MS, createDoors } from "./doors.js?v=90a5d4e";
import { createSeen } from "./seen.js?v=90a5d4e";
import { createMemory } from "./memory.js?v=90a5d4e";
import { createCover } from "./cover.js?v=90a5d4e";
import { createRoofs, parkAll, parseRoofName, roofsOn, roofsWords, writeRoofs } from "./roofs.js?v=90a5d4e";
import { createLiveLog, lineText } from "./livelog.js?v=90a5d4e";

export { lineText }; // a live-log line as text (background.js sends them to the GM box)
export { cleanRoofs, roofOriginals, roofsOn, roofsWords, writeRoofs } from "./roofs.js?v=90a5d4e"; // 🛖 Roofs' switch (lightpanel.js: its chip, its fallback, its "🌫 is off" line)

export const SETTLE_MS = 150; // item changes settle this long before a pass
export const MAX_WAIT_MS = 750; // ...but a long drag still gets a pass this often
export const RETRY_MS = 2000; // a failed sync is tried again after this, doubling...
export const RETRY_MAX_MS = 30000; // ...up to this
export const ANSWER_WATCH_MS = 5000; // a GM screen checks this often whether it became (or stopped being) the answerer
export const PARTS = ["cover", "walls", "sight", "doors", "seen", "memory"]; // the sync order of each pass
// ...and after them 🛖 Roofs (fog/roofs.js: the roof pieces, written by the explored memory's writer)
export const ALL_PARTS = [...PARTS, "roofs"];
// The parts that keep their own back-off and say their own errors: a failure of theirs never fails the pass.
export const OWN_RETRY = ["roofs"];
export const SMOKE_VISION_OFF = `${SMOKE}/disableVision`;
export const SMOKE_CHECK_MS = 5000; // a GM screen looks for Smoke's running local items at most this often
// The Smoke warning's last words: Smoke's local lights and walls may outlive its switch-off on a tab
// that had the scene open (not checked live), and they still draw there until they go. Short: the Live
// log line that ends with it must fit in fog/livelog.js LOG_TEXT_MAX.
export const SMOKE_LEFTOVERS = "Already off? Its leftovers stay on this screen till the tab reloads or the scene reopens";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const describe = (e) => e?.error?.message || e?.message || String(e);

// ---- the switch ----

// prev is the fill only: the fog's colour is the scene's own and never ours to write (an older
// build's prev.color is read without a fuss and left out, so it's never written back).
export function cleanFog(v) {
  const o = isObj(v) ? v : {};
  const p = isObj(o.prev) ? o.prev : null;
  const prev = p ? { filled: p.filled === true } : null;
  return { v: 1, on: o.on === true, at: finite(o.at) ? o.at : 0, prev };
}

export const fogOn = (sceneMeta) => cleanFog(sceneMeta?.[FOG_KEY]).on;

// The switch's own value at a click: on or off, now, the prev already kept (writeSwitch adds or
// clears prev itself).
export function switchValue(raw, on, now) {
  const cur = cleanFog(raw);
  const out = { v: 1, on: !!on, at: finite(now) ? now : 0 };
  if (cur.prev) out.prev = cur.prev;
  return out;
}

// Every door line with both formats gets Smoke's state (Smoke was in charge until our fog went on),
// in one updateItems, through doorEdit (explicit values, never a deleted key). -> how many changed.
async function adoptDrift(OBR) {
  const list = await OBR.scene.items.getItems((i) => i?.type === "CURVE" && !!drift(i.metadata));
  const ids = (Array.isArray(list) ? list : []).filter((i) => i?.type === "CURVE" && drift(i.metadata)).map((i) => i.id);
  if (!ids.length) return 0;
  let n = 0;
  await OBR.scene.items.updateItems(ids, (ds) => {
    for (const d of ds) {
      const c = drift(d.metadata);
      if (c && doorEdit(d.metadata, c)) n++;
    }
  });
  return n;
}

// The DM's tap on 🌫 Our fog, written whole from that GM screen, at once. log(text): the 🪵 Live log.
export async function writeSwitch(OBR, on, now = Date.now(), { log = null } = {}) {
  const say = (t) => { try { log?.(t); } catch { /* the log is optional */ } };
  const meta = (await OBR.scene.getMetadata()) || {};
  const cur = cleanFog(meta[FOG_KEY]);
  const fill = OBR.scene.fog;
  const at = finite(now) ? now : 0;
  if (on) {
    const was = (await fill.getFilled()) === true;
    // An existing prev is the scene's own fill from before (a switch-on whose off never ran): kept.
    const prev = cur.prev || { filled: was };
    const next = { v: 1, on: true, at, prev };
    await OBR.scene.setMetadata({ [FOG_KEY]: next });
    // The fill only: the fog keeps the scene's own colour, as Smoke leaves it.
    if (!was) await fill.setFilled(true);
    const adopted = await adoptDrift(OBR);
    say(`🌫 switched on from this screen: the fog's fill ${was ? "was on already" : "is on"} (its own, ${prev.filled ? "on" : "off"},`
      + ` kept to put back)${adopted ? `; Smoke's door state adopted on ${adopted} line${adopted === 1 ? "" : "s"}` : ""}`);
    return { next, filled: true, adopted };
  }
  // off: the scene's own fill back first (prev stays until it is), then the switch with prev cleared
  let back = null;
  if (cur.prev) {
    back = cur.prev.filled;
    if ((await fill.getFilled()) !== back) await fill.setFilled(back);
  }
  const next = { v: 1, on: false, at, prev: null };
  await OBR.scene.setMetadata({ [FOG_KEY]: next });
  say(`🌫 switched off from this screen: ${offWords(back)}`);
  // 🛖 Roofs: every roof piece hidden and parked from here too (no pieces: nothing written)
  let parked = 0;
  try {
    parked = await parkAll(OBR);
    if (parked) say(`🛖 ${parked} roof piece(s) parked and hidden`);
  } catch (e) {
    say(`🛖 parking the roofs failed (the writer parks them): ${describe(e)}`);
  }
  return { next, filled: back, adopted: 0, parked };
}

// The off line (the 🪵 Live log, the DM's box, the panel's): what shows now, by the fill put back.
// With the fill on, nothing of ours draws sight any more: the map is fogged whole unless something
// else draws vision (Smoke & Spectre, where it still runs). It never says Smoke works: on Thursday
// Smoke is switched off in the room (review of the merge round, 2026-10-13).
export function offWords(filled) {
  if (filled === true) {
    return "the fog's own fill (on) is back and our fog draws no sight now: without Smoke & Spectre the map is fogged whole"
      + " (turn the fill off in Owlbear's fog tool for an open map)";
  }
  if (filled === false) return "the fog's own fill (off) is back: the map shows (any fog drawn by hand stays)";
  return "no fill of the scene's own was kept, so the fog's fill is left as it is (if it's on, the map is fogged whole:"
    + " turn the fill off in Owlbear's fog tool for an open map)";
}

// Is a local item one Smoke & Spectre draws while it RUNS on this screen? Smoke 5.0.4 makes its vision
// lights and walls as local items, tagged with its own keys (a LIGHT: <SMOKE>/isVisionLight,
// visionRange...; a WALL: <SMOKE>/isVisionWall, isWindow). Their names are the SDK builders' defaults
// ("Light", "Wall"), which any extension's lights and walls get too, so only the keys count. Never
// one of ours: an item with any "dnd-npc/" key is ours (our sight lights and walls, the memory's).
export function isSmokeLocal(item) {
  if (item?.type !== "LIGHT" && item?.type !== "WALL") return false;
  const keys = isObj(item.metadata) ? Object.keys(item.metadata) : [];
  return !keys.some((k) => k.startsWith("dnd-npc/")) && keys.some((k) => k.startsWith(`${SMOKE}/`));
}

// Is Smoke & Spectre drawing vision on this screen? `here`: it runs here now (its local lights or
// walls are on this screen: localItems are this screen's OBR.scene.local items); `on`: here, and its
// "Disable Vision" isn't set in the scene (Smoke then makes no vision lights at all; its local walls
// may stay). Never the shared data: Smoke's sceneId and a token's hasVision / visionRange outlive the
// extension (switched off, they stay), and our own lights writer (fx/lightmeta.js smokeFor) writes
// hasVision and visionRange on the PCs itself.
const smokeState = (sceneMeta, here) => ({ here: !!here, on: !!here && (isObj(sceneMeta) ? sceneMeta : {})[SMOKE_VISION_OFF] !== true });
export function smokeVision(sceneMeta, localItems) {
  return smokeState(sceneMeta, (Array.isArray(localItems) ? localItems : []).some(isSmokeLocal));
}

// The colour in OBR.scene.fog.onChange's value: the SDK's Fog is {filled, style: {color, strokeWidth}}
// (its scene builder writes fog.style.color); a flat {color} is read too. null when there is none.
export function fogColorOf(f) {
  const c = f?.style?.color;
  if (typeof c === "string" && c) return c;
  return typeof f?.color === "string" && f.color ? f.color : null;
}

const stable = (x) => JSON.stringify(x ?? null);
// The 2024 switches (RULES_KEY), the weather (WEATHER_KEY) and the memory shade (FOG_LOOK_KEY) count
// too (docs/vision-layer-2024.md): a tap on any of them is a pass on every screen. Raw values, like the
// rest: an identical rewrite changes nothing, so it's no pass.
export const inputSig = (m) => stable([m?.[FOG_KEY], m?.[SCENE_LIGHTING_KEY], m?.[SMOKE_VISION_OFF] === true,
  m?.[RULES_KEY] ?? null, m?.[WEATHER_KEY] ?? null, m?.[FOG_LOOK_KEY] ?? null, m?.[ROOFS_KEY] ?? null]);
export const roomSig = (m) => stable([m?.[PARTY_SENSES_KEY], m?.[PARTY_KEY]]);

// ---- the snapshot (pure) ----

// grid: {dpi, ftPerCell, pxPerFt} (fx/darkness.js readGrid). ctx: {isPc(item), pcTokens, party}.
export function buildSnapshot(items, sceneMeta, roomMeta, grid, ctx = {}, at = 0) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i?.id != null);
  const sm = isObj(sceneMeta) ? sceneMeta : {};
  const rm = isObj(roomMeta) ? roomMeta : {};
  const g = grid && finite(grid.dpi) && grid.dpi > 0 ? grid : { dpi: 150, ftPerCell: 5, pxPerFt: 30 };
  const isPc = (i) => { try { return !!ctx.isPc?.(i); } catch { return false; } };
  // An uploaded 🛖 roof original isn't a map (until the take-in removes it): no rect, no map state.
  const rects = mapRects(list.filter((i) => !(i?.layer === "MAP" && parseRoofName(i.name))), g.dpi);
  const party = Array.isArray(ctx.party) && ctx.party.length ? ctx.party : undefined;
  return {
    items: list, byId: new Map(list.map((i) => [i.id, i])), sceneMeta: sm, roomMeta: rm, grid: g,
    fog: cleanFog(sm[FOG_KEY]), rects, maps: mapStates({ items: list, rects, grid: g, sceneMeta: sm }),
    lines: readLines(list, { dpi: g.dpi, rects }),
    pcs: list.filter(isPc), occupied: occupiedMaps(list, { isPc, rects, dpi: g.dpi }),
    vctx: planCtx(list, sm, rm, { pcTokens: ctx.pcTokens ?? null, party, grid: g }), at,
  };
}

// ---- the lifecycle on one screen ----

// api: background.js's sdk ({OBR, buildLight, buildWall, buildShape, buildImage, ...}). ctx:
// background.js's (role, kind, host, conn, playerId, name, build, isPc, pcTokens, party, log; read
// live, through getters). opts: {ownToken(), gmPass "A" | "B", doorTap, lockHandles (door icons
// locked: a live-check flag), memoryOnGm (false: this GM screen draws no memory items, the live-check
// flag "dnd-npc/fog-memory-gm"), dimOpacity (a number, or a function giving one: the dim layer's
// opacity, a live-tuning knob), timers, random() (the checks'), liveLog: false (none), makers
// ({sight, walls, doors, seen, memory, cover}: the offline check's fakes)}.
export function createFog(api = {}, ctx = {}, opts = {}) {
  const O = api.OBR;
  const T = opts.timers || ctx.timers || {
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now(),
  };
  const host = ctx.host ?? "";
  const isGm = () => ctx.role === "GM";
  const makers = { sight: createSight, walls: createWalls, doors: createDoors, seen: createSeen, memory: createMemory,
    cover: createCover, roofs: createRoofs, ...(opts.makers || {}) };
  // The 🪵 Live log: this screen's lines (and on a GM screen every screen's). Its echo is the console.
  const live = opts.liveLog === false ? null : createLiveLog(api, {
    timers: T,
    me: () => ({ conn: ctx.conn ?? null, host, name: ctx.name, kind: ctx.kind, role: ctx.role }),
    echo: (t) => { try { ctx.log?.(t); } catch { /* quiet */ } },
  });
  const say = (kind, text) => {
    if (live) live.add(kind, text);
    else { try { ctx.log?.(`fog ${kind}: ${text}`); } catch { /* nowhere to say it */ } }
  };
  const log = (t) => say("fog", t);

  let running = false, sceneReady = false, drawing = false;
  let items = null, sceneMeta = {}, roomMeta = {}, grid = null, gridStale = true;
  let metaSig = null, rSig = null;
  let snap = null;
  let parts = null; // {walls, cover, sight, doors, seen, memory}, made the first time the switch is seen on
  let fogColor = null; // the scene's own fog colour (snap.fogColor), null until read
  let watchT = null, wasAnswerer = false; // the GM screen's answerer watch (ANSWER_WATCH_MS)
  let doorsAt = null; // when this screen's doors started (T.now()): the writer is known ANSWERER_SETTLE_MS later
  const partErrors = {};
  let unsubs = [], drawUnsubs = [];
  let busy = false, again = false, passes = 0, current = null; // current: the run in flight
  let settleT = null, firstAt = null, retryT = null, retryMs = RETRY_MS;
  let warnedAt = null; // the FOG_KEY.at the Smoke note was given for
  let lastError = null, saidError = null, smoke = { here: false, on: false };
  let smokeHere = false, smokeAt = null, smokeFor = null, smokeBusy = false; // the last look at Smoke's local items

  // The ctx the three parts get (contract section 2), read live from background.js's.
  const partCtx = {
    get role() { return ctx.role; }, get isGm() { return isGm(); }, get kind() { return ctx.kind; },
    get host() { return host; }, get conn() { return ctx.conn; }, get playerId() { return ctx.playerId; },
    get name() { return ctx.name; }, get build() { return ctx.build ?? ""; },
    isPc: (i) => { try { return !!ctx.isPc?.(i); } catch { return false; } },
    ownToken: () => { try { return opts.ownToken?.() ?? null; } catch { return null; } },
    get gmPass() { return opts.gmPass === "A" ? "A" : "B"; },
    get doorTap() { return !!opts.doorTap; },
    get lockHandles() { return !!opts.lockHandles; },
    random: opts.random,
    // The one GM screen that answers the players' doors (fog/doors.js isAnswerer): from B4 it also
    // writes the seen squares (docs/vision-layer-b4.md). False until the doors have started and settled.
    // Review of B4: among the GM screens whose hello says they write the explored squares (doors.js
    // isSeenWriter), so an older build's tab that wins the doors can't leave them unwritten.
    isAnswerer: () => {
      try {
        const d = parts?.doors;
        return !!(typeof d?.isSeenWriter === "function" ? d.isSeenWriter() : d?.isAnswerer?.());
      } catch { return false; }
    },
    // Why this GM screen isn't that writer (fog/roofs.js says it while roof pieces wait): {kind, text},
    // or null when it is. kind: "start" (its doors haven't started), "settle" (ANSWERER_SETTLE_MS not
    // over yet: the seconds left), "none" (no GM screen says it can write), "other" (another one does: its name).
    writerWhy: () => {
      try { return writerWhy(); } catch (e) { return { kind: "start", text: `this screen can't tell who writes (${describe(e)})` }; }
    },
    get memoryOnGm() { return opts.memoryOnGm !== false; },
    get dimOpacity() { return opts.dimOpacity; },
    snapshot: () => snap,
    kick: () => kick(), // a pass soon (fog/cover.js: its polygon library has loaded)
    timers: T,
    log: (t, kind = "fog") => say(kind, t),
  };

  function writerWhy() {
    if (partCtx.isAnswerer()) return null;
    const d = parts?.doors;
    if (!d || doorsAt == null) {
      return { kind: "start", text: partErrors.doors ? `this screen's door menus didn't start (${partErrors.doors})` : "this screen's door menus haven't started yet" };
    }
    const left = ANSWERER_SETTLE_MS - (T.now() - doorsAt);
    if (left > 0) return { kind: "settle", text: `this screen is still listening for the other GM screens (${Math.ceil(left / 1000)} s left)` };
    const w = typeof d.status === "function" ? d.status()?.seen_writer : null;
    if (!w) return { kind: "none", text: "no GM screen here can write them (reload every DM browser onto this copy)" };
    if (!w.here) {
      return { kind: "other", who: String(w.name || w.conn || "?"),
               text: `another GM screen ("${String(w.name || w.conn || "?").slice(0, 40)}") writes the roofs (reload every DM browser onto this copy)` };
    }
    return { kind: "start", text: "this screen is picked to write but hasn't started" };
  }

  function makeParts() {
    if (parts) return parts;
    parts = {};
    for (const name of ALL_PARTS) {
      try {
        parts[name] = makers[name](api, partCtx);
      } catch (e) {
        parts[name] = null;
        partErrors[name] = describe(e);
        say("error", `${name} didn't start: ${partErrors[name]}`);
      }
    }
    return parts;
  }

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
        sayError(`a pass failed: ${lastError}`);
        retry();
      } finally {
        busy = false;
        current = null;
      }
    })();
    return current;
  }

  // A failed pass, in the live log once per new error (a retry that fails the same way says nothing,
  // even though its "tried again in N s" has grown: `key` is the failure itself).
  function sayError(text, key = text) {
    if (key === saidError) return;
    saidError = key;
    say("error", text);
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

  async function pass() {
    if (!running || !sceneReady) return;
    passes++;
    const fog = cleanFog(sceneMeta[FOG_KEY]);
    if (!fog.on) {
      if (drawing) await bringDown();
      lastError = null;
      retryMs = RETRY_MS;
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
    snap.fogColor = fogColor;
    wasAnswerer = partCtx.isAnswerer();
    await lookForSmoke(fog);
    if (!running || !drawing) return;
    // The dark covers first (before a door's wall goes or a light grows), then the walls: a light
    // never shows before the walls that stop it. Then the explored squares (the answerer only) and,
    // last, the memory drawn from them.
    let failed = null;
    for (const name of ALL_PARTS) {
      if (!running || !drawing) return;
      const p = parts[name];
      if (!p) continue;
      let r = null;
      try {
        r = await p.sync(snap);
      } catch (e) {
        r = { failed: true, error: describe(e) };
      }
      if (r?.failed && !OWN_RETRY.includes(name)) failed = `${name}: ${r.error || "failed"}`;
    }
    lastError = failed;
    if (failed) {
      sayError(`a pass failed (tried again in ${Math.round(retryMs / 1000)} s): ${failed}`, failed);
      retry();
    } else {
      if (saidError) say("fog", "a pass worked again");
      saidError = null;
      retryMs = RETRY_MS;
    }
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
    // The scene's own fog colour, for the memory's cut (guarded: an older SDK, or the checks' fake,
    // may lack either call). A new colour gives a pass.
    sub(() => O.scene.fog?.onChange?.((f) => {
      const c = fogColorOf(f);
      if (!c || c === fogColor) return;
      fogColor = c;
      soon();
    }));
    await readFogColor();
    try {
      doorsAt = T.now();
      await parts.doors?.start?.();
    } catch (e) {
      partErrors.doors = describe(e);
      say("error", `the door menus didn't start: ${partErrors.doors}`);
    }
    if (isGm()) watchAnswerer(ANSWERER_SETTLE_MS + 100); // the first look once the doors have settled
    log("on: drawing our sight, walls, doors and explored memory here");
  }

  // The scene's own fog colour, read now (guarded: an older SDK, or the checks' fake, may lack the
  // call). A scene switch while 🌫 stays on reads it again (onReady), so the cut never keeps the
  // previous scene's colour.
  async function readFogColor() {
    try {
      const c = await O.scene.fog?.getColor?.();
      if (typeof c === "string" && c) fogColor = c;
    } catch { /* memory.js uses its default until the colour is read */ }
  }

  // A GM screen: did it become (or stop being) the one that answers the doors and writes the seen
  // squares? Then a pass, so the seen writer starts (or stops) without waiting for a move. Cheap: one
  // timer per ANSWER_WATCH_MS on GM screens only, never on a player's or the projector's.
  function watchAnswerer(ms = ANSWER_WATCH_MS) {
    if (watchT) T.clearTimeout(watchT);
    watchT = T.setTimeout(() => {
      watchT = null;
      if (!running || !drawing) return;
      if (partCtx.isAnswerer() !== wasAnswerer) soon();
      lookForSmoke(cleanFog(sceneMeta[FOG_KEY])).catch(() => {}); // Smoke started or stopped without a pass
      watchAnswerer();
    }, ms);
  }

  // A GM screen: is Smoke & Spectre RUNNING here with its vision on (smokeVision)? One look at this
  // screen's local items at most every SMOKE_CHECK_MS, and at once after a switch-on (a new
  // FOG_KEY.at); Smoke's "Disable Vision" is read from the scene each time. Told once per switch-on
  // (a notification and a Live log line). A player's screen never looks.
  async function lookForSmoke(fog) {
    if (!isGm()) {
      smoke = { here: false, on: false };
      return;
    }
    const now = T.now();
    if (!smokeBusy && (smokeFor !== fog.at || smokeAt == null || now - smokeAt >= SMOKE_CHECK_MS)) {
      smokeBusy = true;
      smokeAt = now;
      smokeFor = fog.at;
      try {
        const list = await O.scene.local.getItems(isSmokeLocal);
        smokeHere = (Array.isArray(list) ? list : []).some(isSmokeLocal);
      } catch { /* no scene, or an older SDK: the last look stands */ } finally {
        smokeBusy = false;
      }
    }
    smoke = smokeState(sceneMeta, smokeHere);
    if (smoke.on && drawing && warnedAt !== fog.at) {
      warnedAt = fog.at;
      note(`🌫 Our fog is on, and Smoke & Spectre is running here with its vision on: switch on “Disable Vision” in Smoke's settings, or switch Smoke off. ${SMOKE_LEFTOVERS}`, "WARNING");
      say("fog", `Smoke & Spectre is running on this screen with its vision on: both draw fog (set Smoke's “Disable Vision”, or switch Smoke off). ${SMOKE_LEFTOVERS}`);
    }
  }

  // ...and off: menus, listeners, every local item of ours on this screen.
  async function bringDown() {
    drawing = false;
    for (const u of drawUnsubs.splice(0)) { try { u(); } catch { /* gone */ } }
    if (settleT) T.clearTimeout(settleT);
    if (retryT) T.clearTimeout(retryT);
    if (watchT) T.clearTimeout(watchT);
    settleT = retryT = watchT = null;
    wasAnswerer = false;
    doorsAt = null;
    fogColor = null;
    firstAt = null;
    retryMs = RETRY_MS;
    snap = null;
    items = null;
    try { await parts?.doors?.stop?.(); } catch (e) { log(`doors stop: ${describe(e)}`); }
    for (const name of ALL_PARTS) {
      try { await parts?.[name]?.clear?.(); } catch (e) { log(`${name} clear: ${describe(e)}`); }
    }
    await sweep();
    lastError = null;
    saidError = null;
    log("off: our items are gone from this screen (the scene's own fog fill shows as it is)");
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
        for (const name of ["sight", "seen", "memory", "cover", "roofs"]) {
          try { parts[name]?.forget?.(); } catch { /* fine */ }
        }
        for (const name of ["walls", "doors"]) {
          try { await parts[name]?.clear?.(); } catch { /* the scene is gone */ }
        }
      }
      return;
    }
    // A new scene while 🌫 stays on: bringUp won't run again, so the new scene's fog colour is read
    // here (onSceneMeta's pass then draws with it).
    if (drawing) await readFogColor();
    try { onSceneMeta(await O.scene.getMetadata()); } catch (e) { log(`can't read the scene: ${describe(e)}`); }
  }

  async function start() {
    if (running) return;
    running = true;
    try { live?.start(); } catch (e) { log(`the live log didn't start: ${describe(e)}`); }
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
    for (const t of [settleT, retryT, watchT]) if (t) T.clearTimeout(t);
    settleT = retryT = watchT = null;
    // The pass in flight first (it stops at its next await): then nothing of it lands after this.
    if (current) { try { await current; } catch { /* run() keeps its own errors */ } }
    if (drawing) await bringDown();
    else await sweep();
    try { live?.stop(); } catch { /* gone */ }
  }

  // kick(): an input background.js holds changed (the heartbeat's PC ids, the party): a pass while drawing.
  function kick() {
    if (drawing) soon();
  }

  // The DM's tap on 🌫 Our fog (any GM screen): the whole switch from here, at once.
  async function setOn(on) {
    if (!isGm()) return { ok: false, text: "Only the DM switches 🌫 Our fog" };
    if (!(await O.scene.isReady())) return { ok: false, text: "Open a scene first" };
    let res = null;
    try {
      res = await writeSwitch(O, on, T.now(), { log: (t) => say("switch", t) });
    } catch (e) {
      say("error", `the 🌫 switch failed: ${describe(e)}`);
      return { ok: false, text: `🌫 The switch failed: ${describe(e)}` };
    }
    return { ok: true, text: on ? "🌫 Our fog is on: the fog's fill is on, every screen draws the party's sight, walls and doors"
      : `🌫 Our fog is off: ${offWords(res?.filled ?? null)}` };
  }

  // The DM's tap on 🛖 Roofs (any GM screen): ROOFS_KEY whole from here, and on off every piece parked.
  async function setRoofs(on) {
    if (!isGm()) return { ok: false, text: "Only the DM switches 🛖 Roofs" };
    if (!(await O.scene.isReady())) return { ok: false, text: "Open a scene first" };
    let res = null;
    try {
      res = await writeRoofs(O, on, T.now(), { log: (t) => say("switch", t) });
    } catch (e) {
      say("error", `the 🛖 switch failed: ${describe(e)}`);
      return { ok: false, text: `🛖 The switch failed: ${describe(e)}` };
    }
    let fogNow = false;
    try { fogNow = cleanFog((await O.scene.getMetadata())?.[FOG_KEY]).on; } catch { /* said as off */ }
    return { ok: true, text: roofsWords(on, fogNow) + (res?.parkError ? ` (parking them from here failed: ${res.parkError})` : "") };
  }

  function status() {
    const st = (name) => { try { return parts?.[name]?.status?.() ?? null; } catch (e) { return { error: describe(e) }; } };
    const fog = cleanFog(sceneMeta[FOG_KEY]);
    const doors = st("doors");
    return {
      running, ready: sceneReady, on: fog.on, drawing, gm_pass: partCtx.gmPass, passes,
      answerer: drawing ? doors?.answerer ?? null : null, seen_writer: drawing ? doors?.seen_writer ?? null : null,
      smoke: fog.on ? smoke : null, sight: st("sight"), walls: st("walls"), doors, seen: st("seen"), memory: st("memory"),
      cover: st("cover"), roofs: st("roofs"), roofs_on: roofsOn(sceneMeta),
      fog_color: drawing ? fogColor : null,
      errors: { ...partErrors }, error: lastError, log: live ? live.status() : null,
    };
  }

  return {
    start, stop, status, setOn, setRoofs, kick, snapshot: () => snap,
    log: (kind, text) => say(kind, text),
    logLines: (max) => (live ? live.lines(max) : []),
  };
}
