// 🛖 Roofs (V5): painted roofs over the inside rooms of the building floors. A part of our fog
// (fog/fog.js makes it with the six vision parts and syncs it last in each pass), so it does
// nothing at all while 🌫 Our fog is off.
//
// THE PIECES. The DM uploads each roof piece named "<floor stem> roof <room slug> x<X> y<Y> w<W>"
// (the file's extension may stay on) and drags it into the scene, onto any layer. A name with "(DM)"
// in it is never a piece. The floor is the MAP-layer image whose name matches the stem (normName,
// as 🏘 Set up interiors matches its maps). The room is that floor's hidden room line (a DRAWING-layer
// CURVE that 🏘 Set up interiors attached to the floor, INTERIOR_KEY {map, kind: "room"}) whose name's
// slug is the piece's room slug. X, Y and W are in the floor FILE's px, and the piece is 1:1 with
// them: an image uploaded at another size than the file (MAP_INFO_KEY.w) is scaled to match.
//
// TAKE-IN (the writer only). Each image that isn't one of ours yet, whose name parses and whose floor
// is in the scene, becomes ONE shared FOG-layer IMAGE: the same uploaded image, our own grid, locked,
// no hits, hidden, z ROOF_Z with auto z off, ROOF_KEY, parked. One addItems for the new pieces (in
// batches of ROOF_BATCH, with a pause between them and a wait-and-retry on Owlbear's rate limit, as
// interiors.js does), then one deleteItems for the originals. A new piece's id comes from its
// original's (roofId), so a take-in cut short (a failed delete, a reload, a second writer) never adds a
// piece twice: the next one only deletes the original. A second piece for the same floor and room is
// taken in like any other, then parked and hidden for good (never deleted).
//
// THE RULE (roofPlan, pure). While 🌫 Our fog and 🛖 Roofs are both on, a piece shows, placed over its
// room (placePiece), unless that room is LIFTED: some PC's middle (hidden PCs too) is inside the
// room's polygon, or a PC stands on that floor's image and most of the room (over ROOF_MAJORITY of
// it) is in the floor's explored memory. Every other piece (either switch off, a lifted room, a
// duplicate, a floor or room not in the scene, a hidden floor) is hidden AND parked: one stack spot
// left of every map image (parkSpot), the same for every piece. So a shown piece is always over its
// room, and a hidden one always parked.
//
// THE WRITER (createRoofs, on the one GM screen that writes the explored memory: ctx.isAnswerer()).
// Each pass: the plan, compared with the pieces as the snapshot has them; only the pieces that differ
// are written, visible + position + scale + rotation in one updateItems (at most ROOF_BATCH a call).
// One job (a take-in or a write) at a time, never awaited by the pass; ROOF_WRITE_TIMEOUT_MS without
// an answer is a failure; a failure (a RateLimitHit, a dropped connection) backs off, ROOF_RETRY_MS
// doubling to ROOF_RETRY_MAX_MS. A value just written isn't sent again for ROOF_ECHO_MS while its echo
// is on its way. A PC crossing a room's line: the item change gives fog.js a pass (SETTLE_MS, at most
// MAX_WAIT_MS in a long drag), this part's sync starts the write at once, and one round-trip later
// every screen has it.
//
// THE SWITCH. writeRoofs: the GM screen whose 🛖 chip was tapped writes ROOFS_KEY whole and, on off,
// parks and hides every piece itself (parkAll), as the writer does on its next pass. 🌫 going off:
// the tapping screen parks them all (fog.js writeSwitch), and the writer does too as its part is
// cleared. A double write is harmless.
//
// Z ORDER on the FOG layer: the memory's local image -3, dim -2, cut -1; the roofs -0.5; our sight
// lights and local walls 0 (the SDK's default for lights and walls). So a PC's sight light sits
// above the roofs (does it cut them for the players? a live check), and the memory below them.
//
//   slug(s), normName(s), parseRoofName(name) -> {floor, room, x, y, w} | null
//   roofFields(item), roofId(originalId), isRoof(item)
//   cleanRoofs(v), roofsOn(sceneMeta), roofsValue(on, now)
//   toScene(image, p, sceneDpi), ratioOf(floor), placePiece(floor, piece, sceneDpi) -> {position, scale, rotation} | null
//   roomPolygon(curve), exploredShare(floor, rect, poly, cache), parkSpot(items, dpi)
//   roofPlan(snap, {cache}) -> [{id, show, position, scale, rotation, why}]   (pure)
//   roofDiff(plan, byId), takeInList(snap), buildRoof(api, original, fields, park, sceneDpi)
//   parkAll(OBR, {dpi}), writeRoofs(OBR, on, now, {log})
//   createRoofs(api, ctx) -> {sync(snap), clear(), forget(), status()}
//
// No place names in this file: it is published, and the publish's leak guard holds them back.

import { EXPLORED_KEY, FOG_KEY, INTERIOR_KEY, MAP_INFO_KEY, ROOF_KEY, ROOFS_KEY } from "../keys.js?v=e1dd89c";
import { centreOf, mapAt, mapRects } from "../views.js?v=e1dd89c";
import { pointInPolygon } from "./los.js?v=e1dd89c";
import { readExplored } from "./shapes.js?v=e1dd89c";

export const ROOF_LAYER = "FOG";
export const ROOF_Z = -0.5; // between the memory's cut (-1) and our sight lights and walls (0)
export const ROOF_RE = /^(.*) roof ([a-z0-9-]+) x(\d+) y(\d+) w(\d+)(?:\.[a-z0-9]+)?$/i;
export const ROOF_BATCH = 80; // pieces per Owlbear call (interiors.js's BATCH)
export const ROOF_PAUSE_MS = 400; // between two calls of one take-in
export const ROOF_RETRIES = 6; // a take-in call Owlbear rate-limits is tried again after 1, 2, 4... s
export const ROOF_WRITE_TIMEOUT_MS = 10000; // a write with no answer by then failed
export const ROOF_TAKE_TIMEOUT_MS = 90000; // a take-in (its retries included) with no end by then failed
export const ROOF_RETRY_MS = 1000; // a failed job's back-off, doubling...
export const ROOF_RETRY_MAX_MS = 30000; // ...up to this
export const ROOF_ECHO_MS = 3000; // a value just written isn't sent again this long
export const ROOF_MAJORITY = 0.5; // a room more explored than this lifts while a PC is on its floor
export const ROOF_SAMPLES = 20; // the explored share is sampled on this many x this many points
export const PARK_STEP = 1000; // the park spot moves in steps this big (scene px), so it rarely moves

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const describe = (e) => e?.error?.message || e?.message || String(e);
const r2 = (x) => Math.round(x * 100) / 100 + 0;
const r6 = (x) => Math.round(x * 1e6) / 1e6 + 0;
const DM_RE = /\(dm\)/i;

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

export const roofId = (originalId) => `roof-${originalId}`;
// One of ours: an image carrying ROOF_KEY.
export const isRoof = (i) => !!i && (i.type === "IMAGE" || i.type === undefined) && isObj(i.metadata?.[ROOF_KEY]);
const isMapImage = (i) => !!i && i.layer === "MAP" && (i.type === undefined || i.type === "IMAGE");

// ---- the switch's value ----

export function cleanRoofs(v) {
  const o = isObj(v) ? v : {};
  return { v: 1, on: o.on === true, at: finite(o.at) ? o.at : 0 };
}
export const roofsOn = (sceneMeta) => cleanRoofs(isObj(sceneMeta) ? sceneMeta[ROOFS_KEY] : null).on;
export const roofsValue = (on, now) => ({ v: 1, on: !!on, at: finite(now) ? now : 0 });
const fogIsOn = (sceneMeta) => isObj(sceneMeta) && isObj(sceneMeta[FOG_KEY]) && sceneMeta[FOG_KEY].on === true;

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

// The scene's floors (by normName) and room lines (by the image they are attached to).
function indexScene(items) {
  const floors = new Map(), rooms = new Map();
  for (const i of items) {
    if (isMapImage(i)) {
      if (DM_RE.test(String(i.name ?? "")) || parseRoofName(i.name)) continue;
      const k = normName(i.name);
      if (!k) continue;
      if (!floors.has(k)) floors.set(k, []);
      floors.get(k).push(i);
    } else if (i?.type === "CURVE" && i.layer === "DRAWING" && i.attachedTo != null && i.metadata?.[INTERIOR_KEY]?.kind === "room") {
      if (!rooms.has(i.attachedTo)) rooms.set(i.attachedTo, []);
      rooms.get(i.attachedTo).push(i);
    }
  }
  return { floors, rooms };
}

// A piece's floor and room line: {floor, curve} (curve null when the floor has no such room), or null.
// Two images with the floor's name: the one holding the room wins, else the first.
function findRoom(index, f) {
  const key = normName(f.floor);
  const cands = index.floors.get(key) || [];
  for (const floor of cands) {
    const curve = (index.rooms.get(floor.id) || [])
      .find((c) => normName(c.metadata[INTERIOR_KEY].map) === key && slug(c.name) === f.room);
    if (curve) return { floor, curve };
  }
  return cands.length ? { floor: cands[0], curve: null } : null;
}

// How much of the room is in the floor's explored memory (0-1): the share of a lattice of points in
// the room's polygon that lie inside the memory's rings (even-odd; the rings are in px from the
// floor rect's top-left). cache (a Map) keeps it until the memory, the rect or the room changes.
export function exploredShare(floor, rect, poly, cache = null) {
  if (!rect || !finite(rect.x0, rect.y0) || !Array.isArray(poly) || poly.length < 3) return 0;
  const key = cache ? `${floor?.id}|${rect.x0},${rect.y0},${rect.x1},${rect.y1}|${poly.map((p) => `${r2(p.x)},${r2(p.y)}`).join(";")}`
    + `|${JSON.stringify(floor?.metadata?.[EXPLORED_KEY] ?? null)}` : null;
  if (key && cache.has(key)) return cache.get(key);
  const ex = readExplored(floor, rect);
  let share = 0;
  if (ex.valid && ex.rings.length) {
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
    share = inRoom ? seen / inRoom : 0;
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

// Is the room lifted: a PC's middle in it, or a PC on its floor and most of it explored.
function isLifted(floor, poly, middles, rects, cache) {
  if (middles.some((c) => pointInPolygon(c, poly))) return true;
  const onFloor = middles.some((c) => mapAt(c, rects) === floor.id);
  return onFloor && exploredShare(floor, rects.find((r) => r.id === floor.id), poly, cache) > ROOF_MAJORITY;
}

// What every piece should be now: shown over its room, or hidden at the park spot. Pure.
export function roofPlan(snap, { cache = null } = {}) {
  const items = Array.isArray(snap?.items) ? snap.items : [];
  const pieces = items.filter(isRoof);
  if (!pieces.length) return [];
  const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
  const park = parkSpot(items, dpi);
  const parked = (p, why) => ({ id: p.id, show: false, position: { x: park.x, y: park.y }, scale: { x: 1, y: 1 }, rotation: 0, why });
  if (!fogIsOn(snap?.sceneMeta) || !roofsOn(snap?.sceneMeta)) return pieces.map((p) => parked(p, "off"));
  const index = indexScene(items);
  const rects = Array.isArray(snap?.rects) ? snap.rects : mapRects(items, dpi);
  const middles = pcMiddles(snap, dpi);
  const first = new Map(); // floor|room -> the first piece for it, in the scene's order
  return pieces.map((p) => {
    const f = roofFields(p);
    if (!f) return parked(p, "no name");
    const key = `${normName(f.floor)}|${f.room}`;
    if (!first.has(key)) first.set(key, p.id);
    if (first.get(key) !== p.id) return parked(p, "duplicate");
    const hit = findRoom(index, f);
    if (!hit) return parked(p, "no floor");
    if (hit.floor.visible === false) return parked(p, "floor hidden");
    const poly = hit.curve ? roomPolygon(hit.curve) : null;
    if (!poly) return parked(p, "no room");
    const place = placePiece(hit.floor, p, dpi);
    if (!place) return parked(p, "no size");
    if (isLifted(hit.floor, poly, middles, rects, cache)) return parked(p, "lifted");
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

// The uploaded originals to take in: images that aren't ours yet, whose name parses and whose floor
// is in the scene. Never one carrying INTERIOR_KEY.
export function takeInList(snap) {
  const items = Array.isArray(snap?.items) ? snap.items : [];
  let index = null;
  const out = [];
  for (const i of items) {
    if (i?.type !== "IMAGE" || i.id == null || !i.image?.url) continue;
    if (isObj(i.metadata?.[ROOF_KEY]) || isObj(i.metadata?.[INTERIOR_KEY])) continue;
    const f = parseRoofName(i.name);
    if (!f) continue;
    index ||= indexScene(items);
    if (!index.floors.has(normName(f.floor))) continue;
    out.push({ item: i, fields: f });
  }
  return out;
}

const opt = (b, method, v) => (typeof b?.[method] === "function" ? b[method](v) : b);

// One piece of ours, from its uploaded original: the same image, our own grid, parked and hidden.
export function buildRoof(api, original, fields, park, sceneDpi) {
  const im = original.image;
  const image = { url: im.url, width: im.width, height: im.height, mime: typeof im.mime === "string" && im.mime ? im.mime : "image/webp" };
  const id = roofId(original.id);
  let b = api.buildImage(image, { dpi: sceneDpi, offset: { x: 0, y: 0 } });
  b = opt(b, "id", id);
  b = b.name(String(original.name ?? "")).position({ x: park.x, y: park.y }).rotation(0).scale({ x: 1, y: 1 })
    .layer(ROOF_LAYER).locked(true).disableHit(true).visible(false).zIndex(ROOF_Z);
  b = opt(b, "disableAutoZIndex", true);
  const item = b.metadata({ [ROOF_KEY]: { v: 1, floor: fields.floor, room: fields.room, x: fields.x, y: fields.y, w: fields.w } }).build();
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
  return fogNow ? "🛖 Roofs are on: a roof covers each room no PC is in (and that the party hasn't mostly explored)"
    : "🛖 Roofs are on: they show once 🌫 Our fog is on";
}

// ---- the writer ----

const sigOf = (w) => JSON.stringify([w.show, w.position.x, w.position.y, w.scale.x, w.scale.y, w.rotation]);

export function createRoofs(api = {}, ctx = {}) {
  const OBR = () => api.OBR;
  const T = ctx.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };
  const now = () => safe(() => T.now(), Date.now());
  const log = (text) => { try { ctx.log?.(text, "roofs"); } catch { /* nowhere to say it */ } };
  const answerer = () => !!safe(() => ctx.isAnswerer?.(), false);
  const sleep = (ms) => new Promise((r) => T.setTimeout(r, ms));

  let epoch = 0; // a clear()/forget() moves it on: a job in flight from before is dropped
  let alive = false, writer = false, lastSnap = null;
  let sawPieces = false; // the last sync found pieces (or originals to take in)
  let inflight = null; // {kind, timer}: the job on its way (one at a time)
  let retryAt = -Infinity, backoff = 0, lastError = null, saidError = null;
  let wakeT = null, wakeAt = null;
  let taken = new Map(); // original id -> {at} (a take-in on its way: at null) or the end of its echo window
  let sent = new Map(); // piece id -> {sig, at}: written, its echo on its way
  let cache = new Map(); // exploredShare's
  let writes = 0, takes = 0, lastWriteAt = null;
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
      const s = safe(() => ctx.snapshot?.(), null) || lastSnap;
      if (s) sync(s);
    }, Math.max(0, at - now()));
  }

  function reset() {
    epoch++;
    alive = false;
    unwake();
    if (inflight?.timer != null) safe(() => T.clearTimeout(inflight.timer));
    inflight = null;
    retryAt = -Infinity;
    backoff = 0;
    lastError = null;
    saidError = null;
    lastSnap = null;
    taken = new Map();
    sent = new Map();
    cache = new Map();
  }

  function doSync(snap) {
    const was = writer;
    writer = answerer();
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
    for (const [id, s] of taken) if (s.at != null && t >= s.at) taken.delete(id);
    const takeIns = takeInList(snap).filter((x) => !taken.has(x.item.id));
    const plan = roofPlan(snap, { cache });
    const why = {};
    for (const w of plan) why[w.why] = (why[w.why] || 0) + 1;
    last = { pieces: plan.length, shown: plan.filter((w) => w.show).length, waiting: takeIns.length, why };
    if ((plan.length || takeIns.length) && !sawPieces) log("this screen writes the roofs (the lowest GM connection)");
    sawPieces = plan.length > 0 || takeIns.length > 0;
    if (inflight) return { skipped: false, writing: 1, failed: !!lastError, error: lastError };
    if (t < retryAt) {
      wake(retryAt);
      return { skipped: false, writing: 0, failed: !!lastError, error: lastError };
    }
    if (takeIns.length) {
      startTake(takeIns, items, dpi);
      return { skipped: false, writing: takeIns.length, failed: false, error: null };
    }
    for (const [id, s] of sent) if (t - s.at >= ROOF_ECHO_MS) sent.delete(id);
    const byId = snap?.byId instanceof Map ? snap.byId : new Map(items.map((i) => [i.id, i]));
    const diff = roofDiff(plan, byId);
    const due = diff.filter((w) => sent.get(w.id)?.sig !== sigOf(w));
    if (due.length < diff.length) {
      // some just written, their echo on its way: looked at again once the echo is late
      let at = Infinity;
      for (const w of diff) { const s = sent.get(w.id); if (s && s.sig === sigOf(w)) at = Math.min(at, s.at + ROOF_ECHO_MS); }
      wake(at);
    }
    if (due.length) startWrite(due.slice(0, ROOF_BATCH));
    return { skipped: false, writing: Math.min(due.length, ROOF_BATCH), failed: false, error: null };
  }

  // A job on its own (never awaited by the pass): a timeout, the back-off on a failure, and a wake
  // when it settles so what is still due goes next.
  function startJob(kind, run, ms, { ok = null, fail = null } = {}) {
    const e = epoch;
    const me = { kind, timer: null };
    inflight = me;
    const timeout = new Promise((_, reject) => {
      me.timer = T.setTimeout(() => {
        me.timer = null;
        reject(new Error(`no answer from Owlbear in ${Math.round(ms / 1000)} s`));
      }, ms);
    });
    const job = Promise.resolve().then(() => run(e));
    job.catch(() => {}); // a job that times out and fails later is no unhandled rejection
    Promise.race([job, timeout]).then(() => {
      if (e !== epoch || inflight !== me) return;
      if (lastError) log("the roofs write worked again");
      lastError = null;
      saidError = null;
      backoff = 0;
      retryAt = -Infinity;
      safe(() => ok?.());
    }, (err) => {
      if (e !== epoch || inflight !== me) return;
      lastError = describe(err);
      backoff = backoff ? Math.min(ROOF_RETRY_MAX_MS, backoff * 2) : ROOF_RETRY_MS;
      retryAt = now() + backoff;
      safe(() => fail?.());
      if (lastError !== saidError) {
        saidError = lastError;
        log(`✖ the roofs ${kind} failed (tried again in ${Math.round(backoff / 1000)} s, then less often): ${lastError}`);
      }
    }).finally(() => {
      if (me.timer != null) safe(() => T.clearTimeout(me.timer));
      me.timer = null;
      if (e !== epoch || inflight !== me) return;
      inflight = null;
      wake(Math.max(now(), retryAt));
    });
    return job; // the job's own end (a job past its timeout may still be running)
  }

  function startWrite(batch) {
    const t = now();
    for (const w of batch) sent.set(w.id, { sig: sigOf(w), at: t });
    const want = new Map(batch.map((w) => [w.id, w]));
    startJob("write", async () => {
      await OBR().scene.items.updateItems([...want.keys()], (drafts) => {
        for (const d of drafts) {
          const w = want.get(d?.id);
          if (!w || !isObj(d.metadata?.[ROOF_KEY])) continue; // ours only
          d.visible = w.show;
          d.position = { x: w.position.x, y: w.position.y };
          d.scale = { x: w.scale.x, y: w.scale.y };
          d.rotation = w.rotation;
        }
      });
    }, ROOF_WRITE_TIMEOUT_MS, {
      ok: () => { writes++; lastWriteAt = now(); },
      fail: () => { for (const id of want.keys()) sent.delete(id); },
    });
  }

  // Owlbear's rate limit: wait and try again (1, 2, 4... s), as interiors.js does.
  async function step(name, fn, e) {
    for (let attempt = 0; ; attempt++) {
      if (e !== epoch) throw new Error("stopped");
      try {
        return await fn();
      } catch (err) {
        const why = describe(err);
        if (/RateLimit|Too many requests/i.test(why) && attempt < ROOF_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`${name}: ${why}`);
      }
    }
  }

  function startTake(list, items, dpi) {
    for (const x of list) taken.set(x.item.id, { at: null });
    const ids = list.map((x) => x.item.id);
    // the park spot with the new pieces counted, so they land where the plan keeps them
    const park = parkSpot([...items, ...list.map((x) => ({ type: "IMAGE", image: x.item.image, grid: { dpi }, metadata: { [ROOF_KEY]: {} } }))], dpi);
    const have = new Set(items.filter(isRoof).map((i) => i.id));
    const e0 = epoch;
    const job = startJob("take-in", async (e) => {
      const add = list.filter((x) => !have.has(roofId(x.item.id))).map((x) => buildRoof(api, x.item, x.fields, park, dpi));
      for (let k = 0; k < add.length; k += ROOF_BATCH) {
        if (k) await sleep(ROOF_PAUSE_MS);
        await step("adding the roof pieces", () => OBR().scene.items.addItems(add.slice(k, k + ROOF_BATCH)), e);
      }
      for (let k = 0; k < ids.length; k += ROOF_BATCH) {
        if (k || add.length) await sleep(ROOF_PAUSE_MS);
        await step("removing the uploaded originals", () => OBR().scene.items.deleteItems(ids.slice(k, k + ROOF_BATCH)), e);
      }
      return add.length;
    }, ROOF_TAKE_TIMEOUT_MS, {
      ok: () => {
        takes += list.length;
        log(`🛖 took in ${list.length} roof piece(s) (hidden until 🛖 Roofs and 🌫 Our fog are both on)`);
      },
    });
    // Each original stays marked until its own job ends (a job past its timeout may still be adding):
    // done, it waits out the echo; failed, it's free to go again after the back-off (and its piece,
    // if the add went through, isn't added twice: roofId).
    const settle = (done) => {
      if (epoch !== e0) return;
      for (const id of ids) {
        if (done) taken.set(id, { at: now() + ROOF_ECHO_MS });
        else taken.delete(id);
      }
    };
    job.then(() => settle(true), () => settle(false));
  }

  // One at a time: a timer's run can't overlap fog.js's pass.
  let chain = Promise.resolve();
  function sync(snap) {
    const run = chain.then(() => doSync(snap)).catch((err) => {
      lastError = describe(err);
      log(`✖ the roofs sync failed: ${lastError}`);
      return { skipped: false, writing: 0, failed: true, error: lastError };
    });
    chain = run.catch(() => {});
    return run;
  }

  // 🌫 went off (or fog.js stopped): everything dropped; the writer that had pieces parks them all,
  // unless both switches are still on (this screen only stopped). Not awaited for long: on its own.
  function clear() {
    const had = writer && sawPieces;
    reset();
    writer = false;
    sawPieces = false;
    if (!had) return Promise.resolve({ cleared: true });
    const O = OBR();
    (async () => {
      const meta = (await O.scene.getMetadata()) || {};
      if (fogIsOn(meta) && roofsOn(meta)) return 0;
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
  }

  function status() {
    return { writer: answerer(), pieces: last.pieces, shown: last.shown, waiting: last.waiting, why: { ...last.why },
      writes, takes, lastWriteAt, writing: inflight?.kind ?? null, retryAt: finite(retryAt) ? retryAt : null, error: lastError };
  }

  return { sync, clear, forget, status };
}
