// The smooth explored memory's shapes (docs/vision-layer-2024.md, the builders' contract; Area 5 of
// the plan): what the party has seen on a map, kept as the exact sight shapes, cut by walls, in the map
// image's shared metadata (EXPLORED_KEY). Pure: no Owlbear import and no DOM, so the offline checks load
// it too. The polygon library (fog/clipper.js) is never imported here: a function that needs it takes
// it as an argument (`clip`), so this file stays loadable everywhere.
//
// Step C (the contract) wrote the stored format; M (the memory writer) owns the file and added what the
// party sees as shapes and the union with what's stored (docs/vision-layer-2024.md section 4):
//   seenShapes(snap, clip)    -> Map(mapId -> rings): what the party sees NOW, per map, in whole scene px
//                       from each map's top-left: the union of every PC's wall-cut sight on it, cut to
//                       the map's rectangle. The shapes AS SEEN, never a viewpoint: the walls and doors
//                       are those of this moment, so a door opened later reveals nothing behind it
//   mergeExplored(value, add, rect, clip, {dpi})  -> {value, grew, capped, simplified, bytes}: the draft's
//                       value united with `add`, tidied and capped; value null when it grew by MIN_GROW
//                       of a square or less (nothing to write), or when it stays over EXPLORED_MAX_BYTES
//                       even simplified at 12 px (capped: that map stops growing)
//   uniteRings(a, b, clip)    two sets of rings (each as drawn, even-odd) united: one set, as Clipper gives
//                       it (outer rings one way round, holes the other), whole px
//   areaOf(rings)       the area of a set of rings as a union gives them, px²
//   clipOk(clip)        is this the polygon library (fog/clipper.js's default export)
//   pcViews(snap)       one record per PC that sees anything: {id, mapId, map, c, ft, reachPx, dark}
//                       (what cellsSeen and seenShapes both start from, so the squares and the shapes
//                       always agree about where a PC stands and how far it sees)
//   darkReachFt(item, vctx), sightBlockersOf(snap, mapId), litLights(vctx)   STAND-INS for Phase 2's
//                       fog/sight.js darkReachFt and fog/walls.js sightBlockersOf (F1): today's rules,
//                       moved here from fog/seen.js (which re-exports darkReachFt). The integrator (I2)
//                       swaps in F1's functions here, and nowhere else
//
//   VERSION, ARC_ERROR_PX, MAX_ARC_STEPS, CLEAN_PX, MIN_RING, MIN_GROW, EXPLORED_MAX_BYTES,
//   EXPLORED_CALL_MAX_BYTES, MAX_POINTS, SIZE_SLACK_PX, RANGE_SLACK_PX   (see each below)
//   arcSteps(radiusPx, errPx)  points round a circle of that radius so every chord stays within errPx
//                       (ARC_ERROR_PX) of it: ceil(pi / acos(1 - err / r)), 8 to MAX_ARC_STEPS. The
//                       `arcSteps` option of fog/los.js visibilityPolygon, and a zone circle's ring
//   rectSize(rect)      {w, h}: a map rectangle's size (views.js mapRects {x0, y0, x1, y1}) in whole
//                       scene px; null for a broken one
//   toLocal(points, rect)   scene-px points [{x, y}] as a ring in whole scene px from rect's top-left
//   encodeRings(rings)  rings -> the stored text: base64 of, per ring, its point count then each point
//                       as a step (dx, dy) from the one before (the pen starts at 0, 0 and carries on
//                       from ring to ring), every number a varint (counts as is, steps zigzagged).
//                       "" for no rings. Points are rounded to whole px; repeats in a row and a closing
//                       repeat are dropped, and a ring left with under 3 points goes
//   decodeRings(text)   the rings back ([] for ""), or null for anything that isn't exactly one encoding
//   shareOf(rings, w, h)   the explored share of a w x h rectangle in thousandths, 0-1000 (at least 1
//                       when anything is explored): the rings' signed areas summed, as a union's rings
//                       come (outer rings one way round, holes the other: fog/clipper.js always gives so)
//   exploredValue(rings, rect)  the whole EXPLORED_KEY value for these rings: {v: 1, w, h, n, a, rings}
//                       (n and a counted after encodeRings' tidying); null for a broken rect. The cap is
//                       the writer's: it checks value.rings.length against EXPLORED_MAX_BYTES
//   emptyExplored(rect) the value of nothing explored: {v: 1, w, h, n: 0, a: 0, rings: ""}; null for a
//                       broken rect ("Forget explored" writes it, beside SEEN_KEY's empty)
//   readValue(value, rect)     {valid, rings, n, a}: an EXPLORED_KEY value (a draft's, say) read for this
//                       rectangle. valid false (and rings [], n 0, a 0) when it's missing, junk, or of
//                       another size (w or h off by more than SIZE_SLACK_PX: the map was resized or
//                       turned, so its memory starts again), or when a point lies more than
//                       RANGE_SLACK_PX outside w x h
//   readExplored(item, rect)   readValue of the map image's EXPLORED_KEY
//   exploredOf(item, rect)   readExplored's rings
//   holeRings(rings, rect)   the rings in scene px, each point held inside rect: the holes of the cut
//                       (fog/memory.js cutPath; fill rule even-odd, so a hole in a hole fills again)
//
// A ring is an array of {x, y} (whole scene px from the map rectangle's top-left; Clipper's {X, Y} is
// read too), at least 3 points, not closed (the last point doesn't repeat the first). Rings never
// overlap (they come from one union) and are drawn even-odd: the outer rings are what was seen, a ring
// inside one is a hole (a pillar's shadow), a ring inside that is seen again, and so on.
//
// WHAT A PC SEES, as a shape (seenShapes; the rule cellsSeen used for squares, without the rounding):
// from its centre, on the topmost map under its centre, its line-of-sight polygon (fog/los.js
// visibilityPolygon, arcs within ARC_ERROR_PX) among that map's sight blockers (its walls, closed and
// secret doors, and lines on no map, plus the map's edge ring), out to its sight reach (fog/sight.js
// sightReachFt). Standing in 🌑, that polygon is cut down to what is lit for it: its own circle
// (darkReachFt: darkvision, its own light, at least SELF_SIGHT) and each public light's circle (its
// reach), a light with a `cone` only inside the cone. A torch seen far off doesn't reveal the dark
// between. Several PCs on one map are united; nothing reaches past the map's rectangle.
//
// THE UNION (mergeExplored, on the one GM screen that writes): the stored rings and the new ones, each
// read even-odd as they're drawn, united by Clipper on whole px; then Clipper's clean at CLEAN_PX, rings
// under MIN_RING of a square dropped, and one more pass to keep the rings from touching or crossing
// after the clean. Written only when the area grew by more than MIN_GROW of a square. Over
// EXPLORED_MAX_BYTES: cleaned harder (3, 6, then 12 px); still over, nothing is written (capped).

import { EXPLORED_KEY } from "../keys.js?v=222aeb9";
import { SELF_SIGHT, effectiveLight, visionOf } from "../fx/lightmeta.js?v=222aeb9";
import { inCone } from "../rules2024.js?v=222aeb9";
import { centreOf, mapAt } from "../views.js?v=222aeb9";
import { edgeWalls, segmentsOf } from "./lines.js?v=222aeb9";
import { sightBlockers, visibilityPolygon } from "./los.js?v=222aeb9";
import { sightReachFt } from "./sight.js?v=222aeb9";

export const VERSION = 1;
// Arcs: every chord within this many px of the true circle (about 28 points round a 5 ft circle at 150
// px a square, 95 for 60 ft), and never more than MAX_ARC_STEPS points (enough up to about 250 ft).
export const ARC_ERROR_PX = 1;
export const MAX_ARC_STEPS = 192;
const MIN_ARC_STEPS = 8;
// The writer's tidying after each union (M): Clipper's clean at CLEAN_PX, then rings smaller than
// MIN_RING of a square dropped. A map is written only when its explored area grew by more than
// MIN_GROW of a square. Both are fractions of ONE SQUARE's area: in px², times the grid's dpi squared.
export const CLEAN_PX = 1.5;
export const MIN_RING = 1 / 50;
export const MIN_GROW = 1 / 20;
// Sizes, in characters of the `rings` text (base64, so characters are bytes): one map's value at most
// EXPLORED_MAX_BYTES; the EXPLORED values of one updateItems call at most EXPLORED_CALL_MAX_BYTES
// together (maps over it wait for the next write; at least one map always goes).
export const EXPLORED_MAX_BYTES = 8192;
export const EXPLORED_CALL_MAX_BYTES = 12288;
export const MAX_POINTS = 65536; // a value with more points than this is junk
export const SIZE_SLACK_PX = 1; // a stored w or h this close to the map's is the same size
export const RANGE_SLACK_PX = 2; // a stored point this far outside w x h is junk
// Over EXPLORED_MAX_BYTES, the clean distance is raised to these in turn (px).
export const HARDER_PX = [3, 6, 12];

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const int = (x) => Number.isInteger(x);
const rectOk = (r) => !!r && finite(r.x0, r.y0, r.x1, r.y1) && r.x1 > r.x0 && r.y1 > r.y0;

export function arcSteps(radiusPx, errPx = ARC_ERROR_PX) {
  if (!finite(radiusPx, errPx) || !(radiusPx > 0) || !(errPx > 0)) return MIN_ARC_STEPS;
  if (errPx >= radiusPx) return MIN_ARC_STEPS;
  const n = Math.ceil(Math.PI / Math.acos(1 - errPx / radiusPx) - 1e-9);
  return Math.max(MIN_ARC_STEPS, Math.min(MAX_ARC_STEPS, n));
}

export function rectSize(rect) {
  if (!rectOk(rect)) return null;
  const w = Math.round(rect.x1 - rect.x0), h = Math.round(rect.y1 - rect.y0);
  return w >= 1 && h >= 1 ? { w, h } : null;
}

export function toLocal(points, rect) {
  if (!rectOk(rect) || !Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    const x = p?.x ?? p?.X, y = p?.y ?? p?.Y;
    if (finite(x, y)) out.push({ x: Math.round(x - rect.x0) + 0, y: Math.round(y - rect.y0) + 0 });
  }
  return out;
}

// ---- the text ----

// A ring's points rounded to whole px, repeats in a row (and the closing repeat) dropped; [] when
// fewer than 3 points are left.
function tidyRing(ring) {
  if (!Array.isArray(ring)) return [];
  const out = [];
  for (const p of ring) {
    const x = p?.x ?? p?.X, y = p?.y ?? p?.Y;
    if (!finite(x, y)) return []; // a broken point spoils the ring
    const q = { x: Math.round(x) + 0, y: Math.round(y) + 0 };
    const last = out[out.length - 1];
    if (last && last.x === q.x && last.y === q.y) continue;
    out.push(q);
  }
  while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out.length >= 3 ? out : [];
}

const tidyRings = (rings) => (Array.isArray(rings) ? rings : []).map(tidyRing).filter((r) => r.length);

const LIMIT = 2 ** 32; // a count or a zigzagged step at most this (5 varint bytes)

function putVarint(out, v) { // v: a whole number 0 <= v < LIMIT, 7 bits a byte, low first, top bit = more
  let x = v;
  while (x >= 0x80) { out.push((x % 0x80) | 0x80); x = Math.floor(x / 0x80); }
  out.push(x);
}
const zig = (v) => (v >= 0 ? 2 * v : -2 * v - 1);
const unzig = (u) => (u % 2 === 0 ? u / 2 : -(u + 1) / 2);

function toBase64(bytes) {
  let s = "";
  for (let k = 0; k < bytes.length; k += 0x2000) s += String.fromCharCode(...bytes.slice(k, k + 0x2000));
  return btoa(s);
}

function fromBase64(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k);
    return out;
  } catch { return null; }
}

export function encodeRings(rings) {
  const list = tidyRings(rings);
  if (!list.length) return "";
  const out = [];
  let px = 0, py = 0;
  for (const ring of list) {
    putVarint(out, ring.length);
    for (const p of ring) {
      const dx = zig(p.x - px), dy = zig(p.y - py);
      if (!(dx < LIMIT && dy < LIMIT)) return ""; // a coordinate past 2 billion px: nothing sane to keep
      putVarint(out, dx);
      putVarint(out, dy);
      px = p.x;
      py = p.y;
    }
  }
  return toBase64(out);
}

export function decodeRings(text) {
  if (typeof text !== "string") return null;
  if (text === "") return [];
  const data = fromBase64(text);
  if (!data || !data.length) return null;
  let pos = 0;
  const get = () => { // one varint, or -1 when it runs off the end or is longer than 5 bytes
    let v = 0, mul = 1;
    for (let k = 0; k < 5; k++) {
      if (pos >= data.length) return -1;
      const b = data[pos++];
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 0x80;
    }
    return -1;
  };
  const rings = [];
  let total = 0, px = 0, py = 0;
  while (pos < data.length) {
    const n = get();
    if (n < 3 || total + n > MAX_POINTS) return null;
    total += n;
    const ring = [];
    for (let k = 0; k < n; k++) {
      const dx = get(), dy = get();
      if (dx < 0 || dy < 0) return null;
      px += unzig(dx);
      py += unzig(dy);
      ring.push({ x: px + 0, y: py + 0 });
    }
    rings.push(ring);
  }
  return rings;
}

// ---- the value ----

export function shareOf(rings, w, h) {
  if (!finite(w, h) || !(w > 0) || !(h > 0)) return 0;
  let twice = 0;
  for (const ring of Array.isArray(rings) ? rings : []) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
      const p = ring[j], q = ring[k];
      const px = p?.x ?? p?.X, py = p?.y ?? p?.Y, qx = q?.x ?? q?.X, qy = q?.y ?? q?.Y;
      if (finite(px, py, qx, qy)) twice += px * qy - qx * py;
    }
  }
  const area = Math.abs(twice) / 2;
  if (!(area > 0)) return 0;
  return Math.max(1, Math.min(1000, Math.round((1000 * area) / (w * h))));
}

export function exploredValue(rings, rect) {
  const size = rectSize(rect);
  if (!size) return null;
  const list = tidyRings(rings);
  const text = encodeRings(list);
  const kept = text ? list : [];
  return { v: VERSION, w: size.w, h: size.h, n: kept.reduce((s, r) => s + r.length, 0), a: shareOf(kept, size.w, size.h), rings: text };
}

export function emptyExplored(rect) {
  const size = rectSize(rect);
  return size ? { v: VERSION, w: size.w, h: size.h, n: 0, a: 0, rings: "" } : null;
}

const NONE = () => ({ valid: false, rings: [], n: 0, a: 0 });

export function readValue(value, rect) {
  const size = rectSize(rect);
  const v = value;
  if (!size || !isObj(v) || v.v !== VERSION) return NONE();
  if (!int(v.w) || !int(v.h) || v.w < 1 || v.h < 1) return NONE();
  if (Math.abs(v.w - size.w) > SIZE_SLACK_PX || Math.abs(v.h - size.h) > SIZE_SLACK_PX) return NONE();
  if (!int(v.n) || v.n < 0 || !int(v.a) || v.a < 0 || v.a > 1000 || typeof v.rings !== "string") return NONE();
  const rings = decodeRings(v.rings);
  if (!rings || rings.reduce((s, r) => s + r.length, 0) !== v.n) return NONE();
  const lo = -RANGE_SLACK_PX, hx = v.w + RANGE_SLACK_PX, hy = v.h + RANGE_SLACK_PX;
  for (const ring of rings) for (const p of ring) if (p.x < lo || p.y < lo || p.x > hx || p.y > hy) return NONE();
  return { valid: true, rings, n: v.n, a: v.a };
}

export const readExplored = (item, rect) => readValue(item?.metadata?.[EXPLORED_KEY], rect);

export const exploredOf = (item, rect) => readExplored(item, rect).rings;

export function holeRings(rings, rect) {
  if (!rectOk(rect)) return [];
  const W = rect.x1 - rect.x0, H = rect.y1 - rect.y0;
  const out = [];
  for (const ring of Array.isArray(rings) ? rings : []) {
    if (!Array.isArray(ring)) continue;
    const pts = [];
    for (const p of ring) {
      const x = p?.x ?? p?.X, y = p?.y ?? p?.Y;
      if (!finite(x, y)) continue;
      pts.push({ x: rect.x0 + Math.max(0, Math.min(W, x)), y: rect.y0 + Math.max(0, Math.min(H, y)) });
    }
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

// ---- where each PC stands (shared with fog/seen.js cellsSeen) ----

const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };

// STAND-IN (F1 moves it to fog/sight.js in Phase 2): 🌑, how far a PC sees by itself, feet:
// max(SELF_SIGHT, its darkvision, its own light's reach). fog/seen.js re-exports it.
export function darkReachFt(item, vctx = {}) {
  const v = safe(() => visionOf(item, vctx || {}), null);
  const light = safe(() => effectiveLight(item, vctx?.lighting));
  const own = light && finite(light.reach) && light.reach > 0 ? light.reach : 0;
  const dark = v && finite(v.dark) && v.dark > 0 ? v.dark : 0;
  return Math.max(SELF_SIGHT, dark, own);
}

const mapsById = (snap) => new Map((Array.isArray(snap?.maps) ? snap.maps : []).filter((m) => m?.id != null).map((m) => [m.id, m]));

// STAND-IN (F1's fog/walls.js sightBlockersOf in Phase 2): the segments the live light meets on map
// `mapId`: its lines and lines on no map that stop sight (walls, closed and secret doors), and the
// map's edge ring. [] for a map the snapshot doesn't hold.
export function sightBlockersOf(snap, mapId) {
  const map = mapsById(snap).get(mapId);
  if (!map) return [];
  const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter((l) => l && (l.mapId === mapId || l.mapId == null));
  return sightBlockers([...segmentsOf(lines), ...edgeWalls(map.item, snap?.grid?.dpi)]);
}

// The public lights (fx/darkness.js darknessCtx: [{x, y, reach, cone?}], scene px and feet) that light
// anything.
export const litLights = (vctx) => (Array.isArray(vctx?.lights) ? vctx.lights : [])
  .filter((l) => l && finite(l.x, l.y, l.reach) && l.reach > 0);

// One record per PC (snap.pcs, each once) that sees anything: {id, mapId, map (snap.maps' entry), c
// (its centre, scene px), ft and reachPx (sightReachFt), dark: {ft: darkReachFt} | null (null unless it
// stands in 🌑)}. A PC whose centre is on no map (or on a map without a grid) sees nothing here.
export function pcViews(snap) {
  const out = [];
  const pcs = Array.isArray(snap?.pcs) ? snap.pcs : [];
  if (!pcs.length) return out;
  const dpi = snap?.grid?.dpi, pxPerFt = snap?.grid?.pxPerFt;
  if (!finite(dpi, pxPerFt) || !(pxPerFt > 0)) return out;
  const byMap = mapsById(snap);
  const done = new Set();
  for (const pc of pcs) {
    if (pc?.id == null || done.has(pc.id)) continue;
    done.add(pc.id);
    const c = centreOf(pc, dpi);
    if (!c || !finite(c.x, c.y)) continue;
    const mapId = mapAt(c, snap.rects);
    const map = mapId != null ? byMap.get(mapId) : null;
    if (!map || !map.grid) continue;
    const ft = safe(() => sightReachFt(pc, snap.vctx || {}), 0);
    const reachPx = finite(ft) && ft > 0 ? ft * pxPerFt : 0;
    if (!(reachPx > 0)) continue;
    const where = safe(() => visionOf(pc, snap.vctx || {}).where, null);
    const dark = where === "dark" ? { ft: darkReachFt(pc, snap.vctx || {}) } : null;
    out.push({ id: pc.id, mapId, map, c, ft, reachPx, dark });
  }
  return out;
}

// ---- the polygon library (fog/clipper.js, passed in as `clip`) ----

export const clipOk = (clip) => !!clip && typeof clip.Clipper === "function" && !!clip.ClipType && !!clip.PolyType
  && !!clip.PolyFillType && typeof clip.Clipper.CleanPolygons === "function" && typeof clip.Clipper.SimplifyPolygons === "function";

const toPath = (ring) => {
  const out = [];
  for (const p of Array.isArray(ring) ? ring : []) {
    const x = p?.x ?? p?.X, y = p?.y ?? p?.Y;
    if (finite(x, y)) out.push({ X: Math.round(x) + 0, Y: Math.round(y) + 0 });
  }
  return out;
};
const toPaths = (rings) => (Array.isArray(rings) ? rings : []).map(toPath).filter((p) => p.length >= 3);
const toRings = (paths) => (Array.isArray(paths) ? paths : []).filter((p) => Array.isArray(p) && p.length >= 3)
  .map((p) => p.map((q) => ({ x: q.X + 0, y: q.Y + 0 })));

// A path turned so its signed area is positive (Clipper's outer rings): for a NonZero union of shapes
// that are each one simple polygon.
function positive(clip, path) {
  if (path.length >= 3 && !clip.Clipper.Orientation(path)) path.reverse();
  return path;
}

function run(clip, type, subject, subjectFill, other = [], otherFill = subjectFill) {
  const c = new clip.Clipper();
  if (subject.length) c.AddPaths(subject, clip.PolyType.ptSubject, true);
  if (other.length) c.AddPaths(other, clip.PolyType.ptClip, true);
  const out = [];
  if (!c.Execute(clip.ClipType[type], out, clip.PolyFillType[subjectFill], clip.PolyFillType[otherFill])) {
    throw new Error(`the polygon library refused a ${type === "ctUnion" ? "union" : "cut"}`);
  }
  return out.filter((p) => Array.isArray(p) && p.length >= 3);
}

const signedArea = (path) => {
  let twice = 0;
  for (let k = 0, j = path.length - 1; k < path.length; j = k++) {
    const p = path[j], q = path[k];
    const px = p?.x ?? p?.X, py = p?.y ?? p?.Y, qx = q?.x ?? q?.X, qy = q?.y ?? q?.Y;
    if (finite(px, py, qx, qy)) twice += px * qy - qx * py;
  }
  return twice / 2;
};

// The area a set of rings covers, as a union gives them (outer rings one way round, holes the other).
export const areaOf = (rings) => Math.abs((Array.isArray(rings) ? rings : [])
  .reduce((s, r) => s + (Array.isArray(r) && r.length >= 3 ? signedArea(r) : 0), 0));

// A circle of radius r round (cx, cy), every chord within ARC_ERROR_PX of it.
function circlePath(cx, cy, r, arcPx = ARC_ERROR_PX) {
  if (!finite(cx, cy, r) || !(r > 0)) return [];
  const n = arcSteps(r, arcPx);
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    out.push({ X: Math.round(cx + r * Math.cos(t)) + 0, Y: Math.round(cy + r * Math.sin(t)) + 0 });
  }
  return out;
}

// A public light's shape, in px from the map's top-left: its circle, or with a cone (rules2024.js
// coneOf: facing 0 = up the screen, clockwise) the apex and the arc between the cone's edges.
function lightPath(light, rect, pxPerFt, arcPx = ARC_ERROR_PX) {
  const r = light.reach * pxPerFt;
  const cx = light.x - rect.x0, cy = light.y - rect.y0;
  const cone = light.cone;
  if (cone == null) return circlePath(cx, cy, r, arcPx);
  if (!finite(cone?.facing, cone?.half) || !(cone.half > 0) || !(r > 0)) return [];
  if (cone.half >= 180) return circlePath(cx, cy, r, arcPx);
  const span = 2 * cone.half;
  const n = Math.max(2, Math.ceil((arcSteps(r, arcPx) * span) / 360));
  const out = [{ X: Math.round(cx) + 0, Y: Math.round(cy) + 0 }];
  for (let k = 0; k <= n; k++) {
    const a = ((cone.facing - cone.half + (span * k) / n) * Math.PI) / 180;
    out.push({ X: Math.round(cx + r * Math.sin(a)) + 0, Y: Math.round(cy - r * Math.cos(a)) + 0 });
  }
  return out;
}

// ---- what the party sees now ----

export function seenShapes(snap, clip, { arcPx = ARC_ERROR_PX } = {}) {
  const out = new Map();
  if (!clipOk(clip)) return out;
  const pxPerFt = snap?.grid?.pxPerFt;
  const lights = litLights(snap?.vctx);
  const blockers = new Map(); // mapId -> its sight blockers (worked out once per map)
  const per = new Map(); // mapId -> {rect, size, paths}
  for (const v of pcViews(snap)) {
    const rect = v.map.rect;
    const size = rectSize(rect);
    if (!size) continue;
    if (!blockers.has(v.mapId)) blockers.set(v.mapId, sightBlockersOf(snap, v.mapId));
    const poly = visibilityPolygon(v.c, blockers.get(v.mapId), v.reachPx, { arcSteps: arcSteps(v.reachPx, arcPx) });
    if (poly.length < 3) continue;
    let paths = [positive(clip, toPath(toLocal(poly, rect)))].filter((p) => p.length >= 3);
    // 🌑: cut down to what's lit for it. When its own circle reaches as far as its sight does (no public
    // light farther off), the polygon is inside that circle already: no cut (the cut of two 1 px
    // circles of one radius would only add points where they cross).
    if (v.dark && paths.length && v.dark.ft * pxPerFt < v.reachPx - 0.5) {
      const lit = [circlePath(v.c.x - rect.x0, v.c.y - rect.y0, v.dark.ft * pxPerFt, arcPx),
        ...lights.map((l) => lightPath(l, rect, pxPerFt, arcPx))].filter((p) => p.length >= 3).map((p) => positive(clip, p));
      paths = run(clip, "ctIntersection", paths, "pftNonZero", lit, "pftNonZero");
    }
    if (!paths.length) continue;
    if (!per.has(v.mapId)) per.set(v.mapId, { size, paths: [] });
    per.get(v.mapId).paths.push(...paths); // each a union's own: outer rings positive, holes negative
  }
  for (const [id, { size, paths }] of per) {
    const box = [{ X: 0, Y: 0 }, { X: size.w, Y: 0 }, { X: size.w, Y: size.h }, { X: 0, Y: size.h }];
    const rings = toRings(run(clip, "ctIntersection", paths, "pftNonZero", [positive(clip, box)], "pftNonZero"));
    if (rings.length) out.set(id, rings);
  }
  return out;
}

export function uniteRings(a, b, clip) {
  if (!clipOk(clip)) throw new Error("the polygon library isn't loaded");
  return toRings(run(clip, "ctUnion", toPaths(a), "pftEvenOdd", toPaths(b), "pftEvenOdd"));
}

// The union's rings tidied: Clipper's clean at `px`, rings under minArea px² dropped, then one more
// pass (NonZero, which the union's orientation makes exact) so no two rings cross after the clean.
function tidyPaths(clip, paths, px, minArea) {
  const big = (list) => list.filter((p) => p.length >= 3 && Math.abs(signedArea(p)) >= minArea);
  let out = big(clip.Clipper.CleanPolygons(paths, px));
  out = big(clip.Clipper.SimplifyPolygons(out, clip.PolyFillType.pftNonZero));
  return out;
}

export function mergeExplored(value, add, rect, clip, { dpi = 150 } = {}) {
  const none = (grew = 0, capped = false) => ({ value: null, grew, capped, simplified: 0, bytes: 0 });
  const size = rectSize(rect);
  if (!size || !clipOk(clip)) return none();
  const d = finite(dpi) && dpi > 0 ? dpi : 150;
  const old = readValue(value, rect);
  const before = areaOf(old.rings);
  const united = run(clip, "ctUnion", toPaths(old.rings), "pftEvenOdd", toPaths(add), "pftEvenOdd");
  const minArea = MIN_RING * d * d;
  let paths = tidyPaths(clip, united, CLEAN_PX, minArea);
  const grew = areaOf(paths) - before;
  if (!(grew > MIN_GROW * d * d)) return none(grew);
  let next = exploredValue(toRings(paths), rect);
  let simplified = 0;
  for (const px of HARDER_PX) {
    if (next && next.rings.length <= EXPLORED_MAX_BYTES) break;
    paths = tidyPaths(clip, united, px, minArea);
    next = exploredValue(toRings(paths), rect);
    simplified = px;
  }
  if (!next || next.rings.length > EXPLORED_MAX_BYTES) return none(grew, true);
  return { value: next, grew, capped: false, simplified, bytes: next.rings.length };
}
