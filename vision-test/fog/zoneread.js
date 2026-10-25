// The obscured zones for the vision layer (docs/vision-layer-2024.md section 7, "The zones"; Area 3a
// of the plan): every item that makes an area lightly or heavily obscured, read into one list of
// closed rings on the scene. Pure: no Owlbear import and no DOM (rules2024.js, shapes.js, views.js and
// lineread.js only), so the offline checks load it too. fog.js builds snap.zones from it on every pass,
// whatever the ☁ switch says: the drawing obeys the switch, the 👁 badge doesn't.
//
// Three kinds of item make a zone:
//   - a shape the DM drew and marked from its right-click menu (OBSCURE_KEY, src "drawn");
//   - an outline 🏘 Set up interiors placed from interiors.json (OBSCURE_KEY, src "map");
//   - a spell's living-zone outline (ZONE_KEY, fx/zones.js) whose spell is in rules2024.js
//     SPELL_OBSCURE (src "spell"): hidden outlines count (a secret caster's Fog Cloud still blocks
//     sight), outlines stamped `ending` (fading out) don't.
// A mark at level "none" ("Clear obscured") makes no zone. OBSCURE_KEY wins on an item that has both.
//
//   MAX_ZONE_POINTS          a ring never has more points than this (192, the same as a circle's)
//   ringOf(item)             the item's outline on the scene: [{x, y}, ...] closed but not repeating its
//                            first point, to 0.01 px; null when it has no area we can read:
//                              SHAPE RECTANGLE  position = its top-left corner, width x height
//                              SHAPE CIRCLE     position = its centre, width and height = the diameters:
//                                               shapes.js arcSteps(r) points (within 1 px of round up
//                                               to about 250 ft, at most 192)
//                              SHAPE HEXAGON    centred on its position (as areas.js reads one)
//                              SHAPE TRIANGLE   none: its outline is unknown (it failed the live test
//                                               for places, areas.js)
//                              CURVE            its points (the polygon tool, the brush): a ring even
//                                               when the drawing isn't closed
//                              PATH             its first loop, its curves flattened
//                            each turned, scaled and moved with the item (lineread.js toWorld); a ring
//                            over MAX_ZONE_POINTS is simplified (its corners kept), so a long brush
//                            stroke costs a fog wall of at most that many pieces
//   zoneOf(item, {rects, byId})  one item's zone {id, level, magic, src, points, mapId}, or null
//   zonesOf(items, {rects, dpi})  every zone in the scene, in the scene's order: [{id, level ("light" |
//                            "heavy"), magic, src ("drawn" | "map" | "spell"), points, mapId}]. mapId: the
//                            map image the item hangs on (a chain through other items counts), else the
//                            topmost map under the middle of the ring's box (views.js mapAt), else null.
//                            rects: views.js mapRects (worked out from `items` and `dpi` when missing)
//   insideZone(point, zone)  is the point inside the zone's ring (fog/los.js pointInPolygon: a PC is
//                            inside a zone when its centre is)
//   heavyAt(point, zones)    the first heavy zone whose ring holds the point, or null
//
// A heavy zone stops sight like a wall (fog/walls.js makes it the local wall "zone:<item id>", visible,
// never blocking, double-sided) but never a drag; a light zone changes nothing on screen.

import { obscureOf, spellObscureOf } from "../rules2024.js?v=9a30147";
import { mapAt, mapRects } from "../views.js?v=9a30147";
import { toWorld } from "./lineread.js?v=9a30147";
import { pointInPolygon } from "./los.js?v=9a30147";
import { arcSteps } from "./shapes.js?v=9a30147";

export const MAX_ZONE_POINTS = 192;

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const isPt = (p) => !!p && finite(p.x, p.y);
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const LEVELS = new Set(["light", "heavy"]);
const PATH = { MOVE: 0, LINE: 1, QUAD: 2, CONIC: 3, CUBIC: 4, CLOSE: 5 }; // Owlbear's path commands
const CURVE_STEPS = 16; // a path's curve is flattened into this many straight pieces

// ---- one outline ----

// Twice the ring's signed area (scene px²).
function area2(ring) {
  let s = 0;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) s += ring[j].x * ring[k].y - ring[k].x * ring[j].y;
  return s;
}

// Repeats in a row and the closing repeat dropped (the points already rounded).
function tidy(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p);
  }
  while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
}

// The distance from p to the segment a-b.
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Douglas-Peucker on an open run of points: the indices to keep, within tol px of the run.
function keepIdx(pts, lo, hi, tol, keep) {
  let far = -1, best = tol;
  for (let k = lo + 1; k < hi; k++) {
    const d = distToSeg(pts[k], pts[lo], pts[hi]);
    if (d > best) { best = d; far = k; }
  }
  if (far < 0) return;
  keep[far] = 1;
  keepIdx(pts, lo, far, tol, keep);
  keepIdx(pts, far, hi, tol, keep);
}

// A closed ring with at most `max` points: simplified at 1 px, then 2, 4... (the two points farthest
// apart always stay), and as a last resort every n-th point.
function capRing(ring, max = MAX_ZONE_POINTS) {
  if (ring.length <= max) return ring;
  // split the ring at the point farthest from the first, so both halves are open runs
  let far = 0, fd = -1;
  for (let k = 1; k < ring.length; k++) {
    const d = Math.hypot(ring[k].x - ring[0].x, ring[k].y - ring[0].y);
    if (d > fd) { fd = d; far = k; }
  }
  const pts = [...ring, ring[0]];
  for (let tol = 1; tol <= 64; tol *= 2) {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[far] = keep[pts.length - 1] = 1;
    keepIdx(pts, 0, far, tol, keep);
    keepIdx(pts, far, pts.length - 1, tol, keep);
    const out = [];
    for (let k = 0; k < pts.length - 1; k++) if (keep[k]) out.push(pts[k]);
    if (out.length <= max) return out;
  }
  const step = Math.ceil(ring.length / max);
  return ring.filter((_, k) => k % step === 0);
}

// A path's first loop as points in its own frame, curves flattened.
function pathPoints(commands) {
  if (!Array.isArray(commands)) return [];
  const pts = [];
  let cur = null;
  const num = (c, n) => c.length > n && c.slice(1, n + 1).every((x) => finite(x));
  for (const c of commands) {
    if (!Array.isArray(c)) continue;
    const op = c[0];
    if (op === PATH.MOVE) {
      if (pts.length) break; // only the first loop counts
      if (!num(c, 2)) return [];
      cur = { x: c[1], y: c[2] };
      pts.push(cur);
    } else if (op === PATH.CLOSE) {
      break;
    } else if (!cur) {
      return [];
    } else if (op === PATH.LINE) {
      if (!num(c, 2)) return [];
      cur = { x: c[1], y: c[2] };
      pts.push(cur);
    } else if (op === PATH.QUAD || op === PATH.CONIC) {
      if (!num(c, 4)) return [];
      const p0 = cur, p1 = { x: c[1], y: c[2] }, p2 = { x: c[3], y: c[4] };
      const w = op === PATH.CONIC && finite(c[5]) && c[5] > 0 ? c[5] : 1; // a conic's weight (1: a quadratic)
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS, a = (1 - t) * (1 - t), b = 2 * t * (1 - t) * w, d = t * t, s = a + b + d;
        pts.push({ x: (a * p0.x + b * p1.x + d * p2.x) / s, y: (a * p0.y + b * p1.y + d * p2.y) / s });
      }
      cur = p2;
    } else if (op === PATH.CUBIC) {
      if (!num(c, 6)) return [];
      const p0 = cur, p1 = { x: c[1], y: c[2] }, p2 = { x: c[3], y: c[4] }, p3 = { x: c[5], y: c[6] };
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
        pts.push({ x: a * p0.x + b * p1.x + d * p2.x + e * p3.x, y: a * p0.y + b * p1.y + d * p2.y + e * p3.y });
      }
      cur = p3;
    } else {
      return []; // a command we don't know: no outline rather than a wrong one
    }
  }
  return pts;
}

// The outline in the item's own frame, and the radius (scene px) its arcs are judged by.
function localOutline(item) {
  if (item.type === "CURVE") return Array.isArray(item.points) && item.points.every(isPt) ? item.points : null;
  if (item.type === "PATH") return pathPoints(item.commands);
  if (item.type !== "SHAPE") return null;
  const w = item.width, h = item.height;
  if (!finite(w, h) || !(w > 0) || !(h > 0)) return null;
  switch (item.shapeType) {
    case "RECTANGLE":
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    case "HEXAGON": {
      const pts = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        pts.push({ x: (w / 2) * Math.cos(a), y: (h / 2) * Math.sin(a) });
      }
      return pts;
    }
    case "CIRCLE": {
      const sx = Math.abs(finite(item.scale?.x) ? item.scale.x : 1), sy = Math.abs(finite(item.scale?.y) ? item.scale.y : 1);
      const n = arcSteps(Math.max((w / 2) * sx, (h / 2) * sy));
      const pts = [];
      for (let k = 0; k < n; k++) {
        const t = (2 * Math.PI * k) / n;
        pts.push({ x: (w / 2) * Math.cos(t), y: (h / 2) * Math.sin(t) });
      }
      return pts;
    }
    default:
      return null; // a triangle: its outline is unknown
  }
}

export function ringOf(item) {
  if (!isObj(item)) return null;
  let local = null;
  try { local = localOutline(item); } catch { local = null; }
  if (!Array.isArray(local) || local.length < 3) return null;
  let ring = tidy(local.map((p) => toWorld(item, p)).map((p) => ({ x: r2(p.x), y: r2(p.y) })));
  if (ring.length < 3 || !ring.every(isPt)) return null;
  ring = capRing(ring);
  return ring.length >= 3 && Math.abs(area2(ring)) > 0 ? ring : null;
}

// ---- the list ----

// The map an item hangs on (through a chain of attachments), else the map under the middle of its box.
function mapOf(item, ring, rects, byId) {
  const ids = new Set((rects || []).map((r) => r.id));
  let cur = item?.attachedTo;
  for (let n = 0; cur != null && n < 10; n++) {
    if (ids.has(cur)) return cur;
    cur = byId?.get?.(cur)?.attachedTo;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return mapAt({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, rects);
}

// What the item says it is: {level, magic, src}, or null.
function markOf(item) {
  const m = obscureOf(item);
  if (m) return LEVELS.has(m.level) ? { level: m.level, magic: m.magic, src: m.src } : null; // "none": cleared
  const s = spellObscureOf(item);
  return s && LEVELS.has(s.level) ? { level: s.level, magic: s.magic === true, src: "spell" } : null;
}

export function zoneOf(item, { rects = [], byId = null } = {}) {
  if (!isObj(item) || item.id == null) return null;
  let mark = null;
  try { mark = markOf(item); } catch { mark = null; }
  if (!mark) return null;
  const points = ringOf(item);
  if (!points) return null;
  let mapId = null;
  try { mapId = mapOf(item, points, rects, byId) ?? null; } catch { mapId = null; }
  return { id: String(item.id), level: mark.level, magic: mark.magic, src: mark.src, points, mapId };
}

export function zonesOf(items, { rects = null, dpi = 150 } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((i) => isObj(i) && i.id != null);
  const r = Array.isArray(rects) ? rects : mapRects(list, dpi);
  const byId = new Map(list.map((i) => [i.id, i]));
  const out = [];
  const seen = new Set();
  for (const i of list) {
    const z = zoneOf(i, { rects: r, byId });
    if (!z || seen.has(z.id)) continue; // one zone per item (an id twice in the scene: the first)
    seen.add(z.id);
    out.push(z);
  }
  return out;
}

export const insideZone = (point, zone) => isPt(point) && Array.isArray(zone?.points) && pointInPolygon(point, zone.points);

export function heavyAt(point, zones) {
  for (const z of Array.isArray(zones) ? zones : []) if (z?.level === "heavy" && insideZone(point, z)) return z;
  return null;
}
