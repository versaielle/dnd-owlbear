// 🛖 Roofs (V5): painted roofs over the inside rooms of the building floors. A part of our fog
// (fog/fog.js makes it with the six vision parts and syncs it last in each pass), so it does
// nothing at all while 🌫 Our fog is off.
//
// THE PIECES. The DM uploads each roof piece named "<floor stem> roof <room slug> x<X> y<Y> w<W>"
// (the file's extension may stay on) and drags it into the scene, onto any layer but a token's. A
// name with "(DM)" in it is never a piece. The floor is the MAP-layer image whose name or label
// (text.plainText) matches the stem (normName, as 🏘 Set up interiors matches its maps). The room is that floor's hidden room
// line(s) (DRAWING-layer CURVEs that 🏘 Set up interiors attached to the floor, INTERIOR_KEY {map,
// kind: "room"}) whose name's slug is the piece's room slug: a room drawn as two or more lines is one
// room. X, Y and W are in the floor FILE's px, and the piece is 1:1 with them: an image uploaded at
// another size than the file (MAP_INFO_KEY.w) is scaled to match.
//
// TAKE-IN (the writer only, and only while 🌫 Our fog and 🛖 Roofs are both on). Each image that isn't
// one of ours yet, whose name parses and whose floor is in the scene, becomes ONE shared FOG-layer
// IMAGE: the same uploaded image, our own grid, locked, no hits, hidden, z ROOF_Z with auto z off,
// ROOF_KEY (with `at`, the take-in's time), parked. Never taken in: an item on a token layer
// (CHARACTER, MOUNT), one carrying any other "dnd-npc/" metadata key (the explored memory's, a map's,
// a room's...), or one something is attached to. One addItems for the new pieces (ROOF_BATCH a call),
// then one deleteItems for the originals: each its own job of ONE Owlbear call, after any write that is
// due. A new piece's id comes from its original's (roofId), so a take-in cut short (a failed delete,
// a reload, a second writer) never adds a piece twice: the next one only deletes the original. An add
// with no answer in time may still land: before that original is added again, its piece is asked of
// Owlbear (one getItems), and if it's there the original is only deleted. A
// failure backs off that original alone (ROOF_RETRY_MS doubling to ROOF_RETRY_MAX_MS; a batch that
// fails is tried one original at a time); after ROOF_GIVE_UP failures (Owlbear's rate limit not
// counted) that original is given up, said once in the live log, until 🛖 goes off and on again.
//
// THE RULE (roofPlan, pure). While 🌫 Our fog and 🛖 Roofs are both on, a floor's pieces show only
// while a PC is ON THAT FLOOR'S MAP (the DM, 2026-10-19: "a building's roofs show only while a PC is on
// its map", so a player who zooms out never sees every building's roofs): some PC's middle (hidden PCs
// too) has that floor image as the topmost map under it, the floor's rectangle at its current position
// and scale, yard and porch included (views.js mapAt over the snapshot's rects: the same test as
// fog/lines.js occupiedMaps, sight.js and shapes.js). Another floor of the same building (its upper
// floor, a separate map) doesn't count, nor the town. A 🧠 remembered building is no different. On a
// floor with a PC on it, a piece shows, placed over its room (placePiece), unless that room is LIFTED:
// some PC's middle is inside the room, or some PC is IN THE BUILDING (its middle inside one of this
// floor's roofed rooms: the rooms that have a piece) and most of the room (over ROOF_MAJORITY of it) is
// in the floor's explored memory. A PC in the yard or on a porch (no piece) keeps every roof of that
// floor on; once every PC has left the floor's map, its roofs are parked again. Each room shows its
// NEWEST piece (the greatest ROOF_KEY.at; none counts as 0; a tie, the lowest id, so the scene's order
// never matters): an older one (a re-upload's) stays parked and hidden, never deleted. Every other
// piece (either switch off, no PC on its floor's map, a lifted room, an older piece, a floor or room
// not in the scene, a hidden floor) is hidden AND parked: one stack spot left of every map image
// (parkSpot), the same for every piece. So a shown piece is always over its room, and a hidden one
// always parked.
//
// THE WRITER (createRoofs, on the one GM screen that writes the explored memory: ctx.isAnswerer()).
// Each pass: the plan, compared with the pieces as the snapshot has them; only the pieces that differ
// are written, visible + position + scale + rotation in one updateItems (at most ROOF_BATCH a call).
// Two items with one id (a late add, a handoff) are planned and compared by the first (firstPerId).
// One job (a write, or one take-in call) at a time, never awaited by the pass; writes go first, so a
// write waits for one take-in call at most (ROOF_TAKE_TIMEOUT_MS when Owlbear doesn't answer). A job is
// ONE Owlbear call raced against its timeout, so the job has settled (and `inflight` is cleared) when
// the call answers or the timeout comes, and nothing of it runs after. A failed write (a RateLimitHit,
// a dropped connection) backs the writes off, ROOF_RETRY_MS doubling to ROOF_RETRY_MAX_MS; the take-in's
// failures never hold up a write. A value just written isn't sent again for ROOF_ECHO_MS while its echo
// is on its way; a value Owlbear never reads back equal is sent ROOF_SAME_WRITES times at most, then
// left and said once. Every failure is said once per new error in the 🪵 Live log, and in status():
// it never fails fog.js's pass. A take-in round is said as it starts ("taking in N") and ends ("took in
// N; M placed, P parked (no PC on its map), K waiting: why").
//
// WHY NOTHING HAPPENED (every GM screen, the writer too, while 🌫 Our fog is on and 🛖 is on or a piece
// is in the scene; roofMisses, pure): said once per piece and reason in the 🪵 Live log (until 🌫 goes
// off; an older piece's until the scene closes): a picture with " roof " in its name that doesn't read
// as a piece's (never a token's); a piece or an original whose floor isn't in the scene (by name or label); no room line,
// an older piece, no size; an original on a token layer, carrying our keys, or with something attached.
// And once per new count, the originals nobody takes in from this screen: dropped while 🛖 is off, or
// (it isn't the writer) still there ROOF_WAIT_MS after it first saw them (at most one such line per
// ROOF_WAIT_MS), and why (ctx.writerWhy: its doors not started, or another GM screen's name; or, while
// originals are still going from the scene, that the writer is still taking them in: no reload advice
// then). The look-again timer does nothing once this screen has no pass (fog.js going down: its
// snapshot gone) or its waiting state was dropped (clear(), forget()). 🌫 off: lightpanel.js says "🌫 is off: roofs do nothing"
// (roofOriginals), as fog.js reads nothing then. A PC crossing a room's line: the item change
// gives fog.js a pass (SETTLE_MS, at most MAX_WAIT_MS in a long drag), this part's sync starts the
// write at once, and one round-trip later every screen has it.
//
// THE SWITCH. writeRoofs: the GM screen whose 🛖 chip was tapped (twice to go on, as 🌫) writes
// ROOFS_KEY whole and, on off, parks and hides every piece itself (parkAll), as the writer does on its
// next pass. 🌫 going off: the tapping screen parks them all (fog.js writeSwitch), and the writer does
// too as its part is cleared (after its job in flight has settled). A double write is harmless.
//
// Z ORDER on the FOG layer: the memory's local image -3, dim -2, cut -1; the roofs -0.5; our sight
// lights and local walls 0 (the SDK's default for lights and walls). So a PC's sight light sits
// above the roofs (does it cut them for the players? a live check), and the memory below them.
//
//   slug(s), normName(s), parseRoofName(name) -> {floor, room, x, y, w} | null
//   roofFields(item), roofAt(item), roofId(originalId), isRoof(item), firstPerId(items)
//   cleanRoofs(v), roofsOn(sceneMeta), roofsValue(on, now)
//   toScene(image, p, sceneDpi), ratioOf(floor), placePiece(floor, piece, sceneDpi) -> {position, scale, rotation} | null
//   roomPolygon(curve), exploredShare(floor, rect, polys, cache), parkSpot(items, dpi)
//   roofPlan(snap, {cache}) -> [{id, show, position, scale, rotation, why}]   (pure)
//   roofDiff(plan, byId), takeInList(snap, misses), originalsIn(snap, misses), buildRoof(api, original, fields, park, sceneDpi, at)
//   roofOriginals(items), unreadableNames(items), roofMisses(snap) -> [{id, name, why, fields}]   (pure)
//   parkAll(OBR, {dpi}), writeRoofs(OBR, on, now, {log}), roofsWords(on, fogNow)
//   createRoofs(api, ctx) -> {sync(snap), clear(), forget(), status()}
//
// No place names in this file: it is published, and the publish's leak guard holds them back.

import { EXPLORED_KEY, FOG_KEY, INTERIOR_KEY, MAP_INFO_KEY, ROOF_KEY, ROOFS_KEY } from "../keys.js?v=90a5d4e";
import { centreOf, mapAt, mapRects } from "../views.js?v=90a5d4e";
import { pointInPolygon } from "./los.js?v=90a5d4e";
import { readExplored } from "./shapes.js?v=90a5d4e";

export const ROOF_LAYER = "FOG";
export const ROOF_Z = -0.5; // between the memory's cut (-1) and our sight lights and walls (0)
export const ROOF_RE = /^(.*) roof ([a-z0-9-]+) x(\d+) y(\d+) w(\d+)(?:\.[a-z0-9]+)?$/i;
export const ROOF_BATCH = 80; // pieces per Owlbear call (interiors.js's BATCH)
export const ROOF_PAUSE_MS = 400; // between two take-in calls (a write may go in between)
export const ROOF_GIVE_UP = 6; // an original whose take-in failed this often (rate limits not counted) is given up
export const ROOF_WRITE_TIMEOUT_MS = 10000; // a write with no answer by then failed
export const ROOF_TAKE_TIMEOUT_MS = 10000; // a take-in call with no answer by then failed
export const ROOF_RETRY_MS = 1000; // a failed job's back-off (the writes', or one original's), doubling...
export const ROOF_RETRY_MAX_MS = 30000; // ...up to this
export const ROOF_ECHO_MS = 3000; // a value just written isn't sent again this long
export const ROOF_SAME_WRITES = 3; // a value that never reads back equal is sent this often, then left
export const ROOF_WAIT_MS = 10000; // a GM screen says originals wait once they've been there this long, at most once this often
export const ROOF_MAJORITY = 0.5; // a room more explored than this lifts while a PC is in the building
export const ROOF_SAMPLES = 20; // the explored share is sampled on this many x this many points (each part)
export const PARK_STEP = 1000; // the park spot moves in steps this big (scene px), so it rarely moves
export const TOKEN_LAYERS = ["CHARACTER", "MOUNT"]; // never taken in from these

const OURS = "dnd-npc/"; // an item carrying any key of ours (but ROOF_KEY) is never an original
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const describe = (e) => e?.error?.message || e?.message || String(e);
const r2 = (x) => Math.round(x * 100) / 100 + 0;
const r6 = (x) => Math.round(x * 1e6) / 1e6 + 0;
const DM_RE = /\(dm\)/i;
const RATE_RE = /RateLimit|Too many requests/i;
const NO_PC = "no PC on its map"; // roofPlan's why for a piece parked while no PC is on its floor's map

// ---- names ----

// Lowercase, every run of characters outside a-z0-9 one "-", none at either end.
export function slug(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// A map's name made comparable, exactly as interiors.js matches its maps (copied: that file loads the SDK).
export function normName(s) {
  return String(s || "").trim().replace(/\.(png|jpe?g|webp|gif|avif)$/i, "")
    .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

// "<floor stem> roof <room slug> x<X> y<Y> w<W>[.ext]" -> {floor: the stem, room: its slug, x, y, w}, or null.
export function parseRoofName(name) {
  if (typeof name !== "string") return null;
  const s = name.trim();
  if (!s || DM_RE.test(s)) return null;
  const m = ROOF_RE.exec(s);
  if (!m) return null;
  const floor = m[1].trim(), room = slug(m[2]);
  const x = Number(m[3]), y = Number(m[4]), w = Number(m[5]);
  if (!floor || !room || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(w) || w <= 0) return null;
  return { floor, room, x, y, w };
}

// A piece's fields: its ROOF_KEY, or (junk there) its name.
export function roofFields(item) {
  const m = item?.metadata?.[ROOF_KEY];
  if (isObj(m) && typeof m.floor === "string" && m.floor.trim() && typeof m.room === "string" && m.room && slug(m.room) === m.room
      && Number.isSafeInteger(m.x) && Number.isSafeInteger(m.y) && Number.isSafeInteger(m.w) && m.x >= 0 && m.y >= 0 && m.w > 0) {
    return { floor: m.floor.trim(), room: m.room, x: m.x, y: m.y, w: m.w };
  }
  return parseRoofName(item?.name);
}

// When a piece was taken in (ROOF_KEY.at, ms): the newest piece of a room shows. None (an older build's) is 0.
export function roofAt(item) {
  const at = item?.metadata?.[ROOF_KEY]?.at;
  return finite(at) && at > 0 ? at : 0;
}

export const roofId = (originalId) => `roof-${originalId}`;
// One of ours: an image carrying ROOF_KEY.
export const isRoof = (i) => !!i && (i.type === "IMAGE" || i.type === undefined) && isObj(i.metadata?.[ROOF_KEY]);
// The first item of each id: a scene holding two items with one id (an add's late answer after its
// retry, two writers in a handoff) is planned and compared by its first only, so the writes never take turns.
export function firstPerId(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((i) => !seen.has(i?.id) && !!seen.add(i?.id));
}
const isMapImage = (i) => !!i && i.layer === "MAP" && (i.type === undefined || i.type === "IMAGE");

// ---- the switch's value ----

export function cleanRoofs(v) {
  const o = isObj(v) ? v : {};
  return { v: 1, on: o.on === true, at: finite(o.at) ? o.at : 0 };
}
export const roofsOn = (sceneMeta) => cleanRoofs(isObj(sceneMeta) ? sceneMeta[ROOFS_KEY] : null).on;
export const roofsValue = (on, now) => ({ v: 1, on: !!on, at: finite(now) ? now : 0 });
const fogIsOn = (sceneMeta) => isObj(sceneMeta) && isObj(sceneMeta[FOG_KEY]) && sceneMeta[FOG_KEY].on === true;
const bothOn = (sceneMeta) => fogIsOn(sceneMeta) && roofsOn(sceneMeta);

// ---- placing ----

// A pixel of an image -> the scene (interiors.js toScene, copied).
export function toScene(image, p, sceneDpi) {
  const k = sceneDpi / image.grid.dpi;
  const off = image.grid.offset || { x: 0, y: 0 };
  const dx = (p.x - off.x) * k * (image.scale?.x ?? 1);
  const dy = (p.y - off.y) * k * (image.scale?.y ?? 1);
  const a = ((image.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return { x: image.position.x + dx * cos - dy * sin, y: image.position.y + dx * sin + dy * cos };
}

// The floor image's px per file px: an image uploaded at another size than the file (MAP_INFO_KEY.w).
export function ratioOf(floor) {
  const w = floor?.metadata?.[MAP_INFO_KEY]?.w, iw = floor?.image?.width;
  return finite(w, iw) && w > 0 && iw > 0 ? iw / w : 1;
}

const floorOk = (f) => !!f && finite(f.position?.x, f.position?.y) && finite(f.grid?.dpi) && f.grid.dpi > 0
  && finite(f.image?.width) && f.image.width > 0;

// Where a piece goes over its floor: its top-left at the floor's (X, Y), turned with the floor, and
// scaled so it spans W of the floor file's px. null when the floor or the piece can't be measured.
export function placePiece(floor, piece, sceneDpi) {
  const f = roofFields(piece);
  const pw = piece?.image?.width, pdpi = piece?.grid?.dpi;
  if (!f || !floorOk(floor) || !finite(sceneDpi, pw, pdpi) || sceneDpi <= 0 || pw <= 0 || pdpi <= 0) return null;
  const ratio = ratioOf(floor);
  const at = toScene(floor, { x: f.x * ratio, y: f.y * ratio }, sceneDpi);
  const k = (f.w * ratio * pdpi) / (floor.grid.dpi * pw);
  const sx = finite(floor.scale?.x) ? floor.scale.x : 1, sy = finite(floor.scale?.y) ? floor.scale.y : 1;
  const out = { position: { x: r2(at.x), y: r2(at.y) }, scale: { x: r6(k * sx), y: r6(k * sy) }, rotation: r6(finite(floor.rotation) ? floor.rotation : 0) };
  return finite(out.position.x, out.position.y, out.scale.x, out.scale.y, out.rotation) ? out : null;
}

// A room line's polygon in the scene: its position plus its points, scaled and turned with it.
export function roomPolygon(curve) {
  const pts = Array.isArray(curve?.points) ? curve.points : null;
  const pos = curve?.position;
  if (!pts || pts.length < 3 || !pos || !finite(pos.x, pos.y)) return null;
  const a = ((finite(curve.rotation) ? curve.rotation : 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const sx = finite(curve.scale?.x) ? curve.scale.x : 1, sy = finite(curve.scale?.y) ? curve.scale.y : 1;
  const out = [];
  for (const p of pts) {
    const x = Array.isArray(p) ? p[0] : p?.x, y = Array.isArray(p) ? p[1] : p?.y;
    if (!finite(x, y)) return null;
    const dx = x * sx, dy = y * sy;
    out.push({ x: pos.x + dx * cos - dy * sin, y: pos.y + dx * sin + dy * cos });
  }
  return out;
}

// The names a floor answers to: its name and its label (text.plainText), as interiors.js matchImages.
const floorNames = (i) => [...new Set([normName(i?.name), normName(i?.text?.plainText)].filter(Boolean))];

// The scene's floors (by normName of their name and of their label) and room lines (by the image they
// are attached to). An uploaded original (its name parses) is never a floor.
function indexScene(items) {
  const floors = new Map(), rooms = new Map();
  for (const i of items) {
    if (isMapImage(i)) {
      if (DM_RE.test(String(i.name ?? "")) || parseRoofName(i.name)) continue;
      for (const k of floorNames(i)) {
        if (!floors.has(k)) floors.set(k, []);
        floors.get(k).push(i);
      }
    } else if (i?.type === "CURVE" && i.layer === "DRAWING" && i.attachedTo != null && i.metadata?.[INTERIOR_KEY]?.kind === "room") {
      if (!rooms.has(i.attachedTo)) rooms.set(i.attachedTo, []);
      rooms.get(i.attachedTo).push(i);
    }
  }
  return { floors, rooms };
}

// A piece's floor and room lines: {floor, curves} (every line of that floor with the room's slug: a
// room drawn in two or more parts is one room; none when the floor has no such room), or null. Two
// images with the floor's name: the one holding the room wins, else the first. A line counts when its
// map (INTERIOR_KEY.map) is the stem or the floor's own name or label.
function findRoom(index, f) {
  const key = normName(f.floor);
  const cands = index.floors.get(key) || [];
  for (const floor of cands) {
    const names = new Set([key, ...floorNames(floor)]);
    const curves = (index.rooms.get(floor.id) || [])
      .filter((c) => names.has(normName(c.metadata[INTERIOR_KEY].map)) && slug(c.name) === f.room);
    if (curves.length) return { floor, curves };
  }
  return cands.length ? { floor: cands[0], curves: [] } : null;
}

const polyArea = (poly) => {
  let a = 0;
  for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) a += (poly[j].x + poly[k].x) * (poly[j].y - poly[k].y);
  return Math.abs(a / 2);
};
const asPolys = (p) => (Array.isArray(p) && p.length && Array.isArray(p[0]) ? p : [p]).filter((q) => Array.isArray(q) && q.length >= 3);

// How much of the room is in the floor's explored memory (0-1). polys: the room's polygon, or a list
// of them (its parts). Each part: the share of a lattice of points in it that lie inside the memory's
// rings (even-odd; the rings are in px from the floor rect's top-left); the parts weighed by their
// area. cache (a Map) keeps it until the memory, the rect or the room changes.
export function exploredShare(floor, rect, polys, cache = null) {
  const parts = asPolys(polys);
  if (!rect || !finite(rect.x0, rect.y0) || !parts.length) return 0;
  const key = cache ? `${floor?.id}|${rect.x0},${rect.y0},${rect.x1},${rect.y1}|${parts.map((poly) => poly.map((p) => `${r2(p.x)},${r2(p.y)}`).join(";")).join("/")}`
    + `|${JSON.stringify(floor?.metadata?.[EXPLORED_KEY] ?? null)}` : null;
  if (key && cache.has(key)) return cache.get(key);
  const ex = readExplored(floor, rect);
  let share = 0;
  if (ex.valid && ex.rings.length) {
    let area = 0, seenArea = 0;
    for (const poly of parts) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of poly) { bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y); }
      const n = ROOF_SAMPLES;
      let inRoom = 0, seen = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const pt = { x: bx0 + ((i + 0.5) * (bx1 - bx0)) / n, y: by0 + ((j + 0.5) * (by1 - by0)) / n };
          if (!pointInPolygon(pt, poly)) continue;
          inRoom++;
          const lp = { x: pt.x - rect.x0, y: pt.y - rect.y0 };
          let k = 0;
          for (const ring of ex.rings) if (pointInPolygon(lp, ring)) k++;
          if (k % 2 === 1) seen++;
        }
      }
      if (!inRoom) continue;
      const a = polyArea(poly);
      area += a;
      seenArea += (a * seen) / inRoom;
    }
    share = area > 0 ? seenArea / area : 0;
  }
  if (key) {
    if (cache.size > 256) cache.clear();
    cache.set(key, share);
  }
  return share;
}

// The park spot: left of every map image (the uploaded originals not counted), by a square and the
// widest piece, in PARK_STEP steps; {x, y} in scene px. Every hidden piece sits here, unturned, at scale 1.
export function parkSpot(items, dpi) {
  const list = Array.isArray(items) ? items : [];
  const d = finite(dpi) && dpi > 0 ? dpi : 150;
  const rects = mapRects(list.filter((i) => !parseRoofName(i?.name)), d);
  let x0 = 0, y0 = 0;
  if (rects.length) {
    x0 = Math.min(...rects.map((r) => r.x0));
    y0 = Math.min(...rects.map((r) => r.y0));
  }
  let w = 0;
  for (const p of list) if (isRoof(p)) w = Math.max(w, parkedWidth(p, d));
  const s = PARK_STEP;
  return { x: Math.floor((x0 - d - Math.ceil(w / s) * s) / s) * s + 0, y: Math.floor(y0 / s) * s + 0 };
}
const parkedWidth = (p, dpi) => (finite(p?.image?.width) && p.image.width > 0
  ? (p.image.width * dpi) / (finite(p.grid?.dpi) && p.grid.dpi > 0 ? p.grid.dpi : dpi) : 0);

// ---- the rule (pure) ----

const pcMiddles = (snap, dpi) => (Array.isArray(snap?.pcs) ? snap.pcs : [])
  .map((pc) => safe(() => centreOf(pc, dpi), null)).filter((c) => c && finite(c.x, c.y));

// Does the newer of two pieces for one room win: the greater `at`, a tie the lower id (any scene order).
const newer = (a, b) => a.at > b.at || (a.at === b.at && String(a.p.id) < String(b.p.id));

// What every piece should be now: shown over its room, or hidden at the park spot. Pure.
export function roofPlan(snap, { cache = null } = {}) {
  const items = Array.isArray(snap?.items) ? snap.items : [];
  const pieces = firstPerId(items.filter(isRoof)); // one entry per id
  if (!pieces.length) return [];
  const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
  const park = parkSpot(items, dpi);
  const parked = (p, why) => ({ id: p.id, show: false, position: { x: park.x, y: park.y }, scale: { x: 1, y: 1 }, rotation: 0, why });
  if (!fogIsOn(snap?.sceneMeta) || !roofsOn(snap?.sceneMeta)) return pieces.map((p) => parked(p, "off"));
  const index = indexScene(items);
  // The snapshot's map rectangles (fog.js buildSnapshot: an uploaded original is no map), else the same here.
  const rects = Array.isArray(snap?.rects) ? snap.rects : mapRects(items.filter((i) => !(i?.layer === "MAP" && parseRoofName(i?.name))), dpi);
  const middles = pcMiddles(snap, dpi);
  const inside = (polys) => middles.some((c) => polys.some((poly) => pointInPolygon(c, poly)));
  // The maps a PC is on: the topmost map under each PC's middle (fog/lines.js occupiedMaps' test).
  const onMaps = new Set(middles.map((c) => mapAt(c, rects)).filter((id) => id != null));
  // Each piece's room (its parts' polygons), and each room's newest piece.
  const info = pieces.map((p) => {
    const f = roofFields(p);
    if (!f) return { p, f: null };
    const hit = findRoom(index, f);
    const polys = hit ? hit.curves.map(roomPolygon).filter(Boolean) : [];
    return { p, f, key: `${normName(f.floor)}|${f.room}`, at: roofAt(p), hit, polys };
  });
  const newest = new Map();
  for (const x of info) if (x.f && (!newest.has(x.key) || newer(x, newest.get(x.key)))) newest.set(x.key, x);
  // The building: each floor's roofed rooms (the rooms with a piece). A PC in one of them is in it.
  const roofed = new Map(); // floor id -> Map(room slug -> its polygons)
  for (const x of info) {
    if (!x.f || !x.hit || !x.polys.length) continue;
    if (!roofed.has(x.hit.floor.id)) roofed.set(x.hit.floor.id, new Map());
    roofed.get(x.hit.floor.id).set(x.f.room, x.polys);
  }
  const inBuilding = new Set();
  for (const [fid, rooms] of roofed) if ([...rooms.values()].some(inside)) inBuilding.add(fid);
  // Lifted: a PC in the room, or a PC in the building and most of the room explored.
  const isLifted = (floor, polys) => inside(polys)
    || (inBuilding.has(floor.id) && exploredShare(floor, rects.find((r) => r.id === floor.id), polys, cache) > ROOF_MAJORITY);
  return info.map((x) => {
    const p = x.p;
    if (!x.f) return parked(p, "no name");
    if (newest.get(x.key) !== x) return parked(p, "older duplicate");
    if (!x.hit) return parked(p, "no floor");
    if (x.hit.floor.visible === false) return parked(p, "floor hidden");
    if (!x.polys.length) return parked(p, "no room");
    const place = placePiece(x.hit.floor, p, dpi);
    if (!place) return parked(p, "no size");
    if (!onMaps.has(x.hit.floor.id)) return parked(p, "no PC on its map");
    if (isLifted(x.hit.floor, x.polys)) return parked(p, "lifted");
    return { id: p.id, show: true, position: place.position, scale: place.scale, rotation: place.rotation, why: "roof" };
  });
}

const near = (a, b, tol) => finite(a, b) && Math.abs(a - b) <= tol;
// Does the item already stand as the plan says?
export function sameState(item, w) {
  return (item?.visible !== false) === w.show
    && near(item?.position?.x, w.position.x, 0.05) && near(item?.position?.y, w.position.y, 0.05)
    && near(item?.scale?.x ?? 1, w.scale.x, 1e-6) && near(item?.scale?.y ?? 1, w.scale.y, 1e-6)
    && near(finite(item?.rotation) ? item.rotation : 0, w.rotation, 1e-4);
}

// The plan's entries whose piece doesn't stand that way yet (byId: the snapshot's items by id).
export function roofDiff(plan, byId) {
  const get = (id) => (byId instanceof Map ? byId.get(id) : null);
  return (Array.isArray(plan) ? plan : []).filter((w) => {
    const it = get(w.id);
    return !!it && !sameState(it, w);
  });
}

// ---- the take-in ----

// The uploaded originals to take in, while 🌫 Our fog and 🛖 Roofs are both on: images that aren't ours
// yet, whose name parses and whose floor is in the scene. Never one on a token layer, one carrying any
// other key of ours ("dnd-npc/..."), or one something is attached to. misses (an array): each image
// whose name parses but isn't taken in, {item, why} ("token layer", "ours", "attached", "no floor").
export function takeInList(snap, misses = null) {
  return bothOn(snap?.sceneMeta) ? originalsIn(snap, misses) : [];
}

// The same list, whatever the switches say (the GM screens' "dropped while 🛖 is off" line).
export function originalsIn(snap, misses = null) {
  const items = Array.isArray(snap?.items) ? snap.items : [];
  const miss = (item, why) => { if (Array.isArray(misses)) misses.push({ item, why }); };
  let index = null, parents = null;
  const out = [];
  for (const i of items) {
    if (i?.type !== "IMAGE" || i.id == null || !i.image?.url) continue;
    if (isObj(i.metadata?.[ROOF_KEY])) continue; // one of ours already
    const f = parseRoofName(i.name);
    if (!f) continue;
    if (TOKEN_LAYERS.includes(i.layer)) { miss(i, "token layer"); continue; }
    if (isObj(i.metadata) && Object.keys(i.metadata).some((k) => k.startsWith(OURS))) { miss(i, "ours"); continue; }
    parents ||= new Set(items.map((x) => x?.attachedTo).filter((x) => x != null));
    if (parents.has(i.id)) { miss(i, "attached"); continue; }
    index ||= indexScene(items);
    if (!index.floors.has(normName(f.floor))) { miss(i, "no floor"); continue; }
    out.push({ item: i, fields: f });
  }
  return out;
}

// Every uploaded original in the scene, whatever its layer or floor (lightpanel.js: "🌫 is off: roofs do nothing").
export function roofOriginals(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i?.type === "IMAGE" && !isObj(i.metadata?.[ROOF_KEY]) && !!parseRoofName(i.name));
}

// Pictures that look meant as pieces (" roof " in the name) but whose name doesn't read as one (Owlbear
// may have changed or cut it). A "(DM)" name never counts, nor a token (CHARACTER, MOUNT: "Kobold on the roof edge").
export const unreadableNames = (items) => (Array.isArray(items) ? items : []).filter((i) => i?.type === "IMAGE"
  && !TOKEN_LAYERS.includes(i.layer)
  && !isObj(i.metadata?.[ROOF_KEY]) && typeof i.name === "string" && / roof /i.test(i.name) && !DM_RE.test(i.name) && !parseRoofName(i.name));

const STATIC_MISSES = ["no name", "older duplicate", "no floor", "no room", "no size"];
// Why the pieces and originals in the scene can't be placed or taken in, whatever the switches and the
// PCs (pure; no explored share is sampled): [{id, name, why, fields}]. why: "bad name" (unreadableNames),
// a piece's "no name", "older duplicate", "no floor", "no room", "no size"; an original's "take token
// layer", "take ours", "take attached", "take no floor".
export function roofMisses(snap) {
  const items = Array.isArray(snap?.items) ? snap.items : [];
  const out = unreadableNames(items).map((i) => ({ id: i.id, name: String(i.name), why: "bad name", fields: null }));
  if (!items.some((i) => isRoof(i) || (i?.type === "IMAGE" && parseRoofName(i.name)))) return out;
  const misses = [];
  originalsIn(snap, misses);
  for (const m of misses) out.push({ id: m.item.id, name: String(m.item.name ?? ""), why: `take ${m.why}`, fields: parseRoofName(m.item.name) });
  const lite = { ...snap, pcs: [], sceneMeta: { [FOG_KEY]: { on: true }, [ROOFS_KEY]: { on: true } } };
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const w of roofPlan(lite)) {
    if (!STATIC_MISSES.includes(w.why)) continue;
    const p = byId.get(w.id);
    out.push({ id: w.id, name: String(p?.name ?? ""), why: w.why, fields: roofFields(p) });
  }
  return out;
}

const opt = (b, method, v) => (typeof b?.[method] === "function" ? b[method](v) : b);

// One piece of ours, from its uploaded original: the same image, our own grid, parked and hidden.
// at: the take-in's time (ms), so a re-upload's piece is the newest of its room.
export function buildRoof(api, original, fields, park, sceneDpi, at = 0) {
  const im = original.image;
  const image = { url: im.url, width: im.width, height: im.height, mime: typeof im.mime === "string" && im.mime ? im.mime : "image/webp" };
  const id = roofId(original.id);
  let b = api.buildImage(image, { dpi: sceneDpi, offset: { x: 0, y: 0 } });
  b = opt(b, "id", id);
  b = b.name(String(original.name ?? "")).position({ x: park.x, y: park.y }).rotation(0).scale({ x: 1, y: 1 })
    .layer(ROOF_LAYER).locked(true).disableHit(true).visible(false).zIndex(ROOF_Z);
  b = opt(b, "disableAutoZIndex", true);
  const item = b.metadata({ [ROOF_KEY]: { v: 1, floor: fields.floor, room: fields.room, x: fields.x, y: fields.y, w: fields.w,
    at: finite(at) && at > 0 ? Math.round(at) : 0 } }).build();
  item.id = id;
  return item;
}

// ---- parking everything (the switch's off) ----

const isParked = (p, park) => p.visible === false && near(p.position?.x, park.x, 0.05) && near(p.position?.y, park.y, 0.05)
  && near(p.scale?.x ?? 1, 1, 1e-6) && near(p.scale?.y ?? 1, 1, 1e-6) && near(finite(p.rotation) ? p.rotation : 0, 0, 1e-4);

function parkDraft(d, park) {
  d.visible = false;
  d.position = { x: park.x, y: park.y };
  d.scale = { x: 1, y: 1 };
  d.rotation = 0;
}

// Every piece hidden and parked, read and written from here: the ones not parked yet, in one
// updateItems (ROOF_BATCH a call). No pieces, or all parked: no write. -> how many were written.
export async function parkAll(O, { dpi = null } = {}) {
  const list = await O.scene.items.getItems((i) => isRoof(i) || isMapImage(i));
  const items = Array.isArray(list) ? list : [];
  const pieces = items.filter(isRoof);
  if (!pieces.length) return 0;
  const d = finite(dpi) && dpi > 0 ? dpi : await O.scene.grid.getDpi();
  const park = parkSpot(items, d);
  const ids = pieces.filter((p) => !isParked(p, park)).map((p) => p.id);
  for (let k = 0; k < ids.length; k += ROOF_BATCH) {
    if (k) await new Promise((r) => setTimeout(r, ROOF_PAUSE_MS));
    await O.scene.items.updateItems(ids.slice(k, k + ROOF_BATCH), (drafts) => {
      for (const dr of drafts) if (isObj(dr?.metadata?.[ROOF_KEY])) parkDraft(dr, park);
    });
  }
  return ids.length;
}

// The DM's tap on 🛖 Roofs, from that GM screen: the switch written whole, and on off every piece
// parked and hidden from here too (the writer does it as well; a failed park is said, the switch stands).
export async function writeRoofs(O, on, now = Date.now(), { log = null } = {}) {
  const say = (t) => { try { log?.(t); } catch { /* the log is optional */ } };
  const next = roofsValue(on, now);
  await O.scene.setMetadata({ [ROOFS_KEY]: next });
  let parked = 0, parkError = null;
  if (!next.on) {
    try {
      parked = await parkAll(O);
    } catch (e) {
      parkError = describe(e);
    }
  }
  say(next.on ? "🛖 roofs switched on from this screen"
    : `🛖 roofs switched off from this screen${parked ? `: ${parked} roof piece(s) parked and hidden` : ""}`
      + `${parkError ? ` (parking them failed: ${parkError}; the writer parks them)` : ""}`);
  return { next, parked, parkError };
}

// What the DM's box says after a tap.
export function roofsWords(on, fogNow) {
  if (!on) return "🛖 Roofs are off: every roof piece is hidden";
  return fogNow ? "🛖 Roofs are on: a building's roofs show only while a PC is on its map, over each room no PC is in"
    + " (and, while a PC is inside, the rooms the party hasn't mostly explored)"
    : "🛖 Roofs are on: they show once 🌫 Our fog is on";
}

// ---- the writer ----

const sigOf = (w) => JSON.stringify([w.show, w.position.x, w.position.y, w.scale.x, w.scale.y, w.rotation]);
const quote = (s) => `"${String(s ?? "").slice(0, 120)}"`;

// A miss (roofMisses) in the live log's words.
function missLine(m) {
  const name = quote(m.name);
  if (m.why === "bad name" || m.why === "no name") return `🛖 can't read roof piece name: ${name}`;
  if (m.why === "no floor" || m.why === "take no floor") {
    return `🛖 roof piece ${name}: no MAP-layer floor named ${quote(m.fields?.floor)} (by name or label)`;
  }
  if (m.why === "no room") return `🛖 roof piece ${name}: its floor has no room line named like ${quote(m.fields?.room)} (🏘 Set up interiors draws them)`;
  if (m.why === "older duplicate") return `🛖 roof piece ${name}: a newer piece for the same room shows instead (this one stays hidden, never deleted)`;
  if (m.why === "no size") return `🛖 roof piece ${name}: its image has no size Owlbear gave`;
  if (m.why === "take token layer") return `🛖 roof piece ${name} isn't taken in: it's on a token layer (CHARACTER or MOUNT): drag it onto the map or prop layer`;
  if (m.why === "take ours") return `🛖 roof piece ${name} isn't taken in: it carries one of our own keys (a map's, a room's, the memory's)`;
  if (m.why === "take attached") return `🛖 roof piece ${name} isn't taken in: something is attached to it`;
  return `🛖 roof piece ${name}: ${m.why}`;
}

export function createRoofs(api = {}, ctx = {}) {
  const OBR = () => api.OBR;
  const T = ctx.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const now = () => safe(() => T.now(), Date.now());
  const log = (text) => { try { ctx.log?.(text, "roofs"); } catch { /* nowhere to say it */ } };
  const answerer = () => !!safe(() => ctx.isAnswerer?.(), false);
  const gmScreen = () => !!safe(() => ctx.isGm === true || ctx.role === "GM", false);

  let epoch = 0; // a clear()/forget() moves it on: a job in flight from before changes nothing when it ends
  let alive = false, writer = false, lastSnap = null;
  let sawPieces = false; // the last sync found pieces (or originals to take in)
  let inflight = null; // {kind, done}: the one job on its way (one Owlbear call); cleared only as it settles
  let wakeT = null, wakeAt = null;
  // the writes: their back-off and error
  let writeRetryAt = -Infinity, writeBackoff = 0, writeError = null, saidWrite = null;
  // the take-in: each original's own state, the next call's earliest time, the last error
  let takes = new Map(); // original id -> {name, fails, backoff, retryAt, solo, gaveUp, added, goneUntil, error}
  let takeNextAt = -Infinity, takeError = null, saidTake = null;
  let sent = new Map(); // piece id -> {sig, at}: written, its echo on its way
  let same = new Map(); // piece id -> {sig, n}: the same value written n times and not read back yet
  let said = new Set(); // the writer's lines said once: a piece that won't read back as written
  let syncError = null;
  let round = null; // the take-in on its way: {ids, done, given} (original ids), said as it starts and ends
  let saidWaiting = null; // the GM screen's last "waiting" / "dropped while 🛖 is off" line (its count and why)
  let waitSince = new Map(); // the GM screen's (not the writer's): original id -> when it first saw it waiting
  let waitSaidAt = -Infinity, waitT = null, waitSnap = null; // its last "waiting" line's time; its look-again timer
  let waitGoneAt = -Infinity; // ...when an original it saw waiting last went from the scene (the writer taking them in)
  let waitGen = 0; // forgetWaiting() moves it on: a look-again timer from before does nothing
  let diag = new Set(); // the GM screen's "why nothing happened" lines said ("id|why|name"): until 🌫 goes off or the scene closes
  let diagDup = new Set(); // ...its "older duplicate" ones (a re-upload's normal state): until the scene closes
  let cache = new Map(); // exploredShare's
  let writes = 0, takesDone = 0, lastWriteAt = null;
  let last = { pieces: 0, shown: 0, waiting: 0, why: {} };

  function unwake() {
    if (wakeT != null) safe(() => T.clearTimeout(wakeT));
    wakeT = null;
    wakeAt = null;
  }
  // One timer, at the earliest moment something is due (a retry, an echo window's end, the next job).
  function wake(at) {
    if (!finite(at)) return;
    if (wakeT != null && wakeAt <= at) return;
    unwake();
    wakeAt = at;
    const e = epoch;
    wakeT = T.setTimeout(() => {
      wakeT = null;
      wakeAt = null;
      if (!alive || e !== epoch) return;
      // Nothing once the screen has no pass (fog.js's snapshot gone: 🌫 going off, its doors still
      // stopping): run then on the last pass's snapshot as a non-writer, it would drop clear()'s park.
      // The last pass's snapshot only where the screen keeps none.
      const s = typeof ctx.snapshot === "function" ? safe(() => ctx.snapshot(), null) : lastSnap;
      if (s) sync(s);
    }, Math.max(0, at - now()));
  }

  // Everything dropped but the job in flight (it clears itself as it settles; its end changes nothing).
  function reset() {
    epoch++;
    alive = false;
    unwake();
    writeRetryAt = -Infinity;
    writeBackoff = 0;
    writeError = null;
    saidWrite = null;
    takes = new Map();
    takeNextAt = -Infinity;
    takeError = null;
    saidTake = null;
    syncError = null;
    round = null;
    lastSnap = null;
    sent = new Map();
    same = new Map();
    said = new Set();
    cache = new Map();
  }

  const once = (key, text) => {
    if (said.has(key)) return;
    if (said.size > 2000) said.clear();
    said.add(key);
    log(text);
  };

  // On a GM screen (the writer too): why each piece or original can't be placed or taken in, once each.
  // Only while 🛖 is on or a roof piece is in the scene (Thursday, 🛖 never tapped: nothing said).
  function diagnose(snap) {
    if (!gmScreen()) return;
    if (!roofsOn(snap?.sceneMeta) && !(Array.isArray(snap?.items) ? snap.items : []).some(isRoof)) return;
    for (const m of roofMisses(snap)) {
      const key = `${m.id}|${m.why}|${m.name}`;
      const set = m.why === "older duplicate" ? diagDup : diag;
      if (set.has(key)) continue;
      if (set.size > 2000) set.clear();
      set.add(key);
      log(missLine(m));
    }
  }

  function unwait() {
    if (waitT != null) safe(() => T.clearTimeout(waitT));
    waitT = null;
  }
  // The GM screen looks again at `at` (an original's ROOF_WAIT_MS up, or the line's own pause over).
  // Nothing once its waiting state is dropped, or once the screen has no pass (fog.js's snapshot gone: 🌫
  // going off, the doors still stopping); the last pass's snapshot only where the screen keeps none.
  function waitAgain(at) {
    unwait();
    if (!finite(at)) return;
    const g = waitGen;
    waitT = T.setTimeout(() => {
      waitT = null;
      if (g !== waitGen) return;
      const s = typeof ctx.snapshot === "function" ? safe(() => ctx.snapshot(), null) : waitSnap;
      if (s) sync(s);
    }, Math.max(0, at - now()));
  }

  // On a GM screen: the originals in the scene that nobody takes in here, said once per new count (and
  // reason): dropped while 🛖 is off (at once), or (this screen not the writer) waiting, and why
  // (ctx.writerWhy; or, while an original it saw waiting went from the scene under ROOF_WAIT_MS ago,
  // that the writer is still taking them in): only the originals still here ROOF_WAIT_MS after this
  // screen first saw them (a healthy take-in is over long before), and at most one such line per ROOF_WAIT_MS.
  function sayWaiting(snap, writing) {
    if (!gmScreen()) return;
    const meta = snap?.sceneMeta;
    const t = now();
    const looking = bothOn(meta) && !writing;
    const ids = new Set(looking ? takeInList(snap).map((x) => x.item.id) : []);
    const inScene = looking && [...waitSince.keys()].some((id) => !ids.has(id))
      ? new Set((Array.isArray(snap?.items) ? snap.items : []).map((i) => i?.id)) : null;
    for (const id of [...waitSince.keys()]) {
      if (ids.has(id)) continue;
      waitSince.delete(id);
      if (inScene && !inScene.has(id)) waitGoneAt = t; // gone from the scene: taken in (by the writer)
    }
    for (const id of ids) if (!waitSince.has(id)) waitSince.set(id, t);
    let key = null, text = null, next = Infinity;
    if (fogIsOn(meta) && !roofsOn(meta)) {
      const n = originalsIn(snap).length;
      if (n) {
        key = `off ${n}`;
        text = `🛖 ${n} roof piece${n === 1 ? "" : "s"} dropped while 🛖 is off: tap 🛖 to take ${n === 1 ? "it" : "them"} in`;
      }
    } else if (ids.size) {
      let n = 0;
      for (const at of waitSince.values()) {
        if (t - at >= ROOF_WAIT_MS) n++;
        else next = Math.min(next, at + ROOF_WAIT_MS);
      }
      if (n) {
        const why = safe(() => ctx.writerWhy?.(), null);
        // an original went from the scene within ROOF_WAIT_MS: a writer is taking them in (no reload advice)
        const taking = t - waitGoneAt < ROOF_WAIT_MS;
        if (taking) next = Math.min(next, waitGoneAt + ROOF_WAIT_MS); // looked at again then: still going, or stalled (the reload advice)
        const who = why?.kind === "other" && why?.who ? ` ("${String(why.who).slice(0, 40)}")` : "";
        key = `wait ${n} ${taking ? "taking" : why?.kind || "other"} ${why?.who || ""}`;
        text = `🛖 ${n} roof piece${n === 1 ? " is" : "s are"} still waiting after ${Math.round(ROOF_WAIT_MS / 1000)} s: `
          + (taking ? `another GM screen${who} is still taking them in`
            : why?.text || "another GM screen writes the roofs (reload every DM browser onto this copy)");
        if (key !== saidWaiting && t < waitSaidAt + ROOF_WAIT_MS) {
          // the last such line was under ROOF_WAIT_MS ago: said then, if still so
          waitSnap = snap;
          waitAgain(Math.min(next, waitSaidAt + ROOF_WAIT_MS));
          return;
        }
      }
    }
    waitSnap = snap;
    waitAgain(next);
    if (key === saidWaiting) return;
    saidWaiting = key;
    if (!text) return;
    log(text);
    if (key.startsWith("wait ")) waitSaidAt = t;
  }

  // The take-in round's end: every original of it taken in (its piece in the snapshot) or given up.
  // "took in N; M placed, P parked (no PC on its map), K waiting: <why>" (the plan's word for each other
  // piece not shown). A piece parked because no PC is on its floor's map is the rule's normal state, not a
  // miss: said as "parked". A zero count of either isn't said.
  function roundEnd(plan, items, cands) {
    if (!round) return;
    const here = new Set(items.map((i) => i.id));
    const pending = new Set(cands.map((x) => x.item.id));
    for (const id of round.ids) {
      if (round.done.has(id)) {
        if (!here.has(roofId(id))) return; // its piece's echo not here yet
      } else if (!round.given.has(id) && (pending.has(id) || here.has(id))) return; // still to go
    }
    const mine = new Set([...round.done].map(roofId));
    const ws = plan.filter((w) => mine.has(w.id));
    const placed = ws.filter((w) => w.show).length;
    const parked = ws.filter((w) => !w.show && w.why === NO_PC).length;
    const whys = {};
    for (const w of ws) if (!w.show && w.why !== NO_PC) whys[w.why] = (whys[w.why] || 0) + 1;
    const k = ws.length - placed - parked;
    log(`🛖 took in ${round.done.size}; ${placed} placed`
      + `${parked ? `, ${parked} parked (${NO_PC})` : ""}`
      + `${k ? `, ${k} waiting: ${Object.entries(whys).map(([y, c]) => `${c} ${y}`).join(", ")}` : ""}`
      + `${round.given.size ? ` (${round.given.size} given up)` : ""}`);
    round = null;
  }

  function doSync(snap) {
    const was = writer;
    writer = answerer();
    diagnose(snap);
    sayWaiting(snap, writer);
    if (!writer) {
      if (was && sawPieces) log("this screen no longer writes the roofs");
      if (was || alive) reset();
      sawPieces = false;
      return { skipped: true, writing: 0, failed: false, error: null };
    }
    alive = true;
    lastSnap = snap;
    const t = now();
    const items = Array.isArray(snap?.items) ? snap.items : [];
    const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
    const byId = new Map(firstPerId(items).map((i) => [i.id, i])); // the first of an id, as the plan has it
    const plan = roofPlan(snap, { cache });
    const cands = takeInList(snap);
    if (!bothOn(snap?.sceneMeta)) {
      // a switch off: the take-in starts afresh when both are on again (an original given up too)
      takes = new Map();
      takeError = null;
      saidTake = null;
      round = null;
    } else {
      const here = new Set(items.map((i) => i.id));
      for (const id of [...takes.keys()]) if (!here.has(id)) takes.delete(id);
      roundEnd(plan, items, cands);
    }
    const why = {};
    for (const w of plan) why[w.why] = (why[w.why] || 0) + 1;
    last = { pieces: plan.length, shown: plan.filter((w) => w.show).length,
      waiting: cands.filter((x) => !takes.get(x.item.id)?.gaveUp).length, why };
    if ((plan.length || cands.length) && !sawPieces) log("this screen writes the roofs (the lowest GM connection)");
    sawPieces = plan.length > 0 || cands.length > 0;
    const out = (writing) => ({ skipped: false, writing, failed: !!(writeError || takeError), error: writeError || takeError });
    if (inflight) return out(1);
    // The writes first: a lift never waits for more than the one take-in call on its way.
    const n = writeStep(plan, byId, t);
    if (n) return out(n);
    if (takeStep(cands, items, dpi, t)) return out(1);
    return out(0);
  }

  // ---- the writes ----

  // The pieces that differ, but those whose value is on its way and those Owlbear won't take: one write.
  function writeStep(plan, byId, t) {
    for (const [id, s] of sent) if (t - s.at >= ROOF_ECHO_MS) sent.delete(id);
    const diff = roofDiff(plan, byId);
    const differs = new Set(diff.map((w) => w.id));
    for (const id of [...same.keys()]) if (!differs.has(id)) same.delete(id); // read back as written
    const stuck = (w) => { const s = same.get(w.id); return !!s && s.sig === sigOf(w) && s.n >= ROOF_SAME_WRITES; };
    let held = Infinity;
    const due = [];
    for (const w of diff) {
      if (stuck(w)) {
        once(`${w.id}|stuck ${sigOf(w)}`, `✖ the roof piece ${quote(byId.get(w.id)?.name)} doesn't read back as written`
          + ` (sent ${ROOF_SAME_WRITES} times the same): left as it stands`);
        continue;
      }
      const s = sent.get(w.id);
      if (s && s.sig === sigOf(w)) { held = Math.min(held, s.at + ROOF_ECHO_MS); continue; } // its echo on its way
      due.push(w);
    }
    if (finite(held)) wake(held); // looked at again once the echo is late
    if (!due.length) return 0;
    if (t < writeRetryAt) {
      wake(writeRetryAt);
      return 0;
    }
    const batch = due.slice(0, ROOF_BATCH);
    startWrite(batch);
    return batch.length;
  }

  function startWrite(batch) {
    const t = now();
    for (const w of batch) sent.set(w.id, { sig: sigOf(w), at: t });
    const want = new Map(batch.map((w) => [w.id, w]));
    startJob("write", () => OBR().scene.items.updateItems([...want.keys()], (drafts) => {
      for (const d of drafts) {
        const w = want.get(d?.id);
        if (!w || !isObj(d.metadata?.[ROOF_KEY])) continue; // ours only
        d.visible = w.show;
        d.position = { x: w.position.x, y: w.position.y };
        d.scale = { x: w.scale.x, y: w.scale.y };
        d.rotation = w.rotation;
      }
    }), ROOF_WRITE_TIMEOUT_MS, {
      ok: () => {
        writes++;
        lastWriteAt = now();
        for (const w of batch) {
          const s = same.get(w.id), sig = sigOf(w);
          same.set(w.id, s && s.sig === sig ? { sig, n: s.n + 1 } : { sig, n: 1 });
        }
        if (writeError) log("the roofs write worked again");
        writeError = null;
        saidWrite = null;
        writeBackoff = 0;
        writeRetryAt = -Infinity;
      },
      fail: (err) => {
        for (const id of want.keys()) sent.delete(id);
        writeError = describe(err);
        writeBackoff = writeBackoff ? Math.min(ROOF_RETRY_MAX_MS, writeBackoff * 2) : ROOF_RETRY_MS;
        writeRetryAt = now() + writeBackoff;
        if (writeError !== saidWrite) {
          saidWrite = writeError;
          log(`✖ the roofs write failed (tried again in ${Math.round(writeBackoff / 1000)} s, then less often): ${writeError}`);
        }
      },
    });
  }

  // ---- the take-in: one call a job ----

  const stOf = (x) => {
    let st = takes.get(x.item.id);
    if (!st) {
      st = { name: String(x.item.name ?? ""), fails: 0, backoff: 0, retryAt: -Infinity, solo: false, gaveUp: false, added: false, unsure: false,
        goneUntil: -Infinity, error: null };
      takes.set(x.item.id, st);
    }
    return st;
  };

  // The next take-in call, if one is due: the adds first (a batch of the originals not tried alone,
  // else one; an original whose add timed out is first looked for, as that add may land late), then
  // the deletes of the originals whose piece is there. -> whether one started.
  function takeStep(cands, items, dpi, t) {
    if (!cands.length) return false;
    const have = new Set(items.filter(isRoof).map((i) => i.id));
    const ready = [];
    let soonest = Infinity;
    for (const x of cands) {
      const st = takes.get(x.item.id);
      if (st?.gaveUp || (st && t < st.goneUntil)) continue;
      if (st && t < st.retryAt) { soonest = Math.min(soonest, st.retryAt); continue; }
      ready.push(x);
    }
    if (finite(soonest)) wake(soonest);
    if (!ready.length) return false;
    if (t < takeNextAt) {
      wake(takeNextAt);
      return false;
    }
    const pick = (list) => {
      const batch = list.filter((x) => !takes.get(x.item.id)?.solo);
      return batch.length ? batch.slice(0, ROOF_BATCH) : list.slice(0, 1);
    };
    // A round starts with its first call: said once, with every original waiting then.
    const waiting = cands.filter((x) => !takes.get(x.item.id)?.gaveUp);
    if (!round) {
      round = { ids: new Set(), done: new Set(), given: new Set() };
      log(`🛖 taking in ${waiting.length} roof piece${waiting.length === 1 ? "" : "s"}`);
    }
    for (const x of waiting) round.ids.add(x.item.id);
    const toAdd = ready.filter((x) => !have.has(roofId(x.item.id)) && !takes.get(x.item.id)?.added);
    const unsure = toAdd.filter((x) => takes.get(x.item.id)?.unsure);
    if (unsure.length) startLook(unsure.slice(0, ROOF_BATCH));
    else if (toAdd.length) startAdd(pick(toAdd), items, dpi);
    else startDelete(pick(ready));
    return true;
  }

  function startAdd(list, items, dpi) {
    // the park spot with the new pieces counted, so they land where the plan keeps them
    const park = parkSpot([...items, ...list.map((x) => ({ type: "IMAGE", image: x.item.image, grid: { dpi }, metadata: { [ROOF_KEY]: {} } }))], dpi);
    const at = now();
    const add = list.map((x) => buildRoof(api, x.item, x.fields, park, dpi, at));
    startJob("take-in", () => OBR().scene.items.addItems(add), ROOF_TAKE_TIMEOUT_MS, {
      ok: () => { for (const x of list) Object.assign(stOf(x), { added: true, fails: 0, backoff: 0, retryAt: -Infinity, error: null }); },
      fail: (err) => {
        if (err?.timedOut) for (const x of list) stOf(x).unsure = true; // it may still land: looked for before adding again
        takeFailed(list, err, "adding the roof piece");
      },
      after: () => { takeNextAt = now() + ROOF_PAUSE_MS; },
    });
  }

  // The originals whose add timed out: their pieces asked of Owlbear (one getItems). One there (that add
  // landed, its answer late) isn't added again: its original is deleted next. The others are added again.
  function startLook(list) {
    const ids = list.map((x) => roofId(x.item.id));
    startJob("take-in", () => OBR().scene.items.getItems(ids), ROOF_TAKE_TIMEOUT_MS, {
      ok: (found) => {
        const there = new Set((Array.isArray(found) ? found : []).filter(isRoof).map((i) => i.id));
        for (const x of list) {
          const st = stOf(x);
          st.unsure = false;
          if (there.has(roofId(x.item.id))) st.added = true;
        }
      },
      fail: (err) => { for (const x of list) takeFailed([x], err, "looking for the roof piece"); }, // each backs off
      after: () => { takeNextAt = now() + ROOF_PAUSE_MS; },
    });
  }

  function startDelete(list) {
    const ids = list.map((x) => x.item.id);
    startJob("take-in", () => OBR().scene.items.deleteItems(ids), ROOF_TAKE_TIMEOUT_MS, {
      ok: () => {
        for (const x of list) {
          Object.assign(stOf(x), { goneUntil: now() + ROOF_ECHO_MS, fails: 0, backoff: 0, retryAt: -Infinity, error: null });
          round?.done.add(x.item.id);
        }
        takesDone += list.length;
        if (takeError) log("the roofs take-in worked again");
        takeError = null;
        saidTake = null;
      },
      fail: (err) => takeFailed(list, err, "removing the uploaded original"),
      after: () => { takeNextAt = now() + ROOF_PAUSE_MS; },
    });
  }

  // A take-in call failed: a batch is tried one original at a time next; one original backs off on its
  // own (never the writes), and after ROOF_GIVE_UP failures (Owlbear's rate limit not counted) it's given up.
  function takeFailed(list, err, what) {
    const why = describe(err);
    const rate = RATE_RE.test(why);
    takeError = `${what}: ${why}`;
    if (list.length > 1 && !rate) {
      for (const x of list) stOf(x).solo = true;
    } else {
      for (const x of list) {
        const st = stOf(x);
        st.backoff = st.backoff ? Math.min(ROOF_RETRY_MAX_MS, st.backoff * 2) : ROOF_RETRY_MS;
        st.retryAt = now() + st.backoff;
        st.error = takeError;
        if (rate) continue;
        st.fails++;
        if (st.fails >= ROOF_GIVE_UP && !st.gaveUp) {
          st.gaveUp = true;
          round?.given.add(x.item.id);
          log(`✖ gave up taking in the roof piece ${quote(st.name)} after ${st.fails} tries: ${takeError} (🛖 Roofs off and on again tries it again)`);
        }
      }
    }
    if (takeError !== saidTake) {
      saidTake = takeError;
      log(`✖ the roofs take-in failed (${list.length > 1 && !rate ? "tried one piece at a time next" : "that piece is tried again in a moment, then less often"}): ${takeError}`);
    }
  }

  // ---- one job ----

  // ONE Owlbear call raced against its timeout, never awaited by the pass: when the call answers or the
  // timeout comes, the job has settled, nothing of it runs after, and only then is `inflight` cleared.
  function startJob(kind, call, ms, { ok = null, fail = null, after = null } = {}) {
    const e = epoch;
    const me = { kind, done: null };
    inflight = me;
    me.done = (async () => {
      let timer = null;
      try {
        const answer = Promise.resolve().then(call);
        answer.catch(() => {}); // a call that answers after its timeout is no unhandled rejection
        return await Promise.race([answer, new Promise((_, reject) => {
          timer = T.setTimeout(() => {
            timer = null;
            const err = new Error(`no answer from Owlbear in ${Math.round(ms / 1000)} s`);
            err.timedOut = true; // the call may still land
            reject(err);
          }, ms);
        })]);
      } finally {
        if (timer != null) safe(() => T.clearTimeout(timer));
      }
    })().then((v) => { if (e === epoch) safe(() => ok?.(v)); }, (err) => { if (e === epoch) safe(() => fail?.(err)); })
      .finally(() => {
        if (e === epoch) safe(() => after?.());
        if (inflight !== me) return;
        inflight = null;
        if (alive) wake(now()); // what is still due goes next
      });
    return me.done;
  }

  // One at a time: a timer's run can't overlap fog.js's pass.
  let chain = Promise.resolve();
  function sync(snap) {
    const run = chain.then(() => doSync(snap)).then((r) => { syncError = null; return r; }, (err) => {
      const text = describe(err);
      if (text !== syncError) log(`✖ the roofs sync failed: ${text}`);
      syncError = text;
      return { skipped: false, writing: 0, failed: true, error: text };
    });
    chain = run.catch(() => {});
    return run;
  }

  // 🌫 went off (or fog.js stopped): everything dropped; the writer that had pieces parks them all, once
  // its job in flight has settled, unless both switches are still on (this screen only stopped).
  function clear() {
    const had = writer && sawPieces;
    const pending = inflight?.done || Promise.resolve();
    reset();
    writer = false;
    sawPieces = false;
    diag = new Set(); // said again on the next 🌫 on; an older duplicate's line isn't (diagDup)
    forgetWaiting();
    if (!had) return Promise.resolve({ cleared: true });
    const O = OBR();
    (async () => {
      await pending.catch(() => {});
      const meta = (await O.scene.getMetadata()) || {};
      if (bothOn(meta)) return 0;
      return parkAll(O);
    })().then((n) => { if (n) log(`🛖 parked and hid ${n} roof piece(s): our fog or the roofs went off`); },
      (err) => log(`✖ parking the roofs failed: ${describe(err)}`));
    return Promise.resolve({ cleared: true });
  }

  // The scene closed: everything dropped, nothing written.
  function forget() {
    reset();
    writer = false;
    sawPieces = false;
    diag = new Set();
    diagDup = new Set();
    forgetWaiting();
  }

  function forgetWaiting() {
    unwait();
    waitGen++;
    saidWaiting = null;
    waitSince = new Map();
    waitSaidAt = -Infinity;
    waitGoneAt = -Infinity;
    waitSnap = null;
  }

  function status() {
    const gaveUp = [...takes.values()].filter((s) => s.gaveUp).map((s) => s.name);
    return { writer: answerer(), pieces: last.pieces, shown: last.shown, waiting: last.waiting, why: { ...last.why },
      writes, takes: takesDone, lastWriteAt, writing: inflight?.kind ?? null, retryAt: finite(writeRetryAt) ? writeRetryAt : null,
      error: writeError || takeError || syncError, write_error: writeError, take_error: takeError, gave_up: gaveUp };
  }

  return { sync, clear, forget, status };
}
