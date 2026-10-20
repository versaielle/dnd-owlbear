// Wall lines for the vision layer (docs/vision-layer-spec.md section 4, the contract in
// docs/vision-layer-b2b3.md): the shared CURVE items that say where walls, doors and windows are,
// read into one shape every part uses (the local walls, the door handles, line of sight). Pure: no
// Owlbear import and no DOM, so the offline checks load it.
//
// A line is read from OUR key (WALL_KEY: {kind, open?, locked?}) or from Smoke & Spectre's
// (isVisionLine, isDoor, isWindow, doorOpen, disabled, isDoorLocked, blocking, doubleSided), so the
// lines 🏘 Set up interiors drew and the ones the DM drew with Smoke both work. When a line has
// both, ours wins.
//
//   toWorld(item, p) / worldPoints(item)   a CURVE's points on the scene (its position, turn and
//                        scale; a closed one ends where it starts), as the SDK's MathM gives them
//                        (from fog/lineread.js, the map-free leaf gather.js and fx/lighting.js use)
//   readLine(item, {rects, byId})   one line: {id, mapId, kind, open, locked, disabled, blocking,
//                        doubleSided, src: "ours" | "smoke", points}, or null when it isn't one
//   readLines(items, {dpi, rects?})  every line in the scene, in the scene's order
//   segmentsOf(lines, maps?)  the lines as fog/los.js segments {a, b, kind, open, id, mapId}: a
//                        line the DM switched off in Smoke gives none (maps: only these map ids)
//   mapCorners(item, dpi)  a map image's four corners on the scene (turned with it)
//   edgeLine(map, dpi)   the wall round a map's edge (a map image, turned with it, or a {x0, y0,
//                        x1, y1} rectangle) as a line: sight stops there, drags don't
//   edgeWalls(map, dpi)  the same as segments
//   occupiedMaps(items, {isPc, rects, dpi})  the maps a PC stands on (the topmost under its middle)
//   lineMap(line, rects, byId)  the map a line belongs to: the one it hangs on, else the one under
//                        its middle
//   midpointAlong(points) / nearestOnLine(p, points)
//   ourState(v) / smokeState(meta) / knownOf(meta) / drift(meta)   a door's state in each format,
//                        whether the party knows its lock, and Smoke's state when it differs from
//                        ours on a line that has both
//   doorAfter(now, change)  how a door stands after {open?, locked?, knownLocked?}
//   doorEdit(meta, {open?, locked?, knownLocked?})  open, close, lock or unlock a door (or mark its
//                        lock found) on a metadata draft, in every format the line has: explicit
//                        values only, never a key deleted, nothing touched that already holds them
//
// Doors: open clears locked and locked means shut, as in Smoke (an open door is never locked). A
// Smoke door stands open with doorOpen (and disabled, which Smoke sets with it); a Smoke line that
// isn't a door and is disabled is switched off: it makes no wall, and stops nothing. The party's
// knowledge of a lock (knownLocked) lives with the lock: a new lock starts unknown, and a door that
// isn't locked knows none.

import { WALL_KEY } from "../keys.js?v=b88563f";
import { centreOf, mapAt, mapRects } from "../views.js?v=b88563f";
import { KINDS, SMOKE_LINE, knownOf, ourState, readLine as readBare, smokeState, toWorld, worldPoints } from "./lineread.js?v=b88563f";

// The map-free part lives in fog/lineread.js (a leaf: gather.js and fx/lighting.js import it
// without views.js); every part of the vision layer reads it from here.
export { KINDS, SMOKE_LINE, knownOf, ourState, smokeState, toWorld, worldPoints };

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const isPt = (p) => !!p && finite(p.x, p.y);
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0

// ---- where a line is ----

// The point half way along a polyline (by its length, not its points); null for none.
export function midpointAlong(pts) {
  if (!Array.isArray(pts) || !pts.length) return null;
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
  let left = total / 2;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 0 && left <= d) return { x: a.x + ((b.x - a.x) * left) / d, y: a.y + ((b.y - a.y) * left) / d };
    left -= d;
  }
  return { x: pts[0].x, y: pts[0].y };
}

// The point of a polyline nearest to p, and how far it is: {x, y, dist}, or null.
export function nearestOnLine(p, pts) {
  if (!isPt(p) || !Array.isArray(pts) || !pts.length || !pts.every(isPt)) return null;
  let best = { x: pts[0].x, y: pts[0].y, dist: Math.hypot(p.x - pts[0].x, p.y - pts[0].y) };
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { ...q, dist: d };
  }
  return best;
}

// ---- what a line is ----

// On a door line that has both formats: Smoke's {open, locked} when they differ from ours (the GM
// screen that switches 🌫 Our fog on adopts it: Smoke was in charge until then), else null.
export function drift(meta) {
  const ours = ourState(meta?.[WALL_KEY]);
  const smoke = smokeState(meta);
  if (!ours || !smoke || ours.kind !== "door" || smoke.kind !== "door") return null;
  return ours.open === smoke.open && ours.locked === smoke.locked ? null : { open: smoke.open, locked: smoke.locked };
}

// The map a line belongs to: the map image it hangs on (🏘 Set up interiors attaches each line to
// its map; a chain through other items counts), else the topmost map under its middle; null when
// it's on none. rects: views.js mapRects(); byId: the scene's items by id.
export function lineMap(line, rects, byId) {
  const ids = new Set((rects || []).map((r) => r.id));
  let cur = line?.attachedTo;
  for (let n = 0; cur && n < 10; n++) {
    if (ids.has(cur)) return cur;
    cur = byId?.get?.(cur)?.attachedTo;
  }
  return mapAt(midpointAlong(line?.points), rects);
}

// One wall line (fog/lineread.js readLine) and the map it belongs to, or null when the item isn't
// one (not a CURVE, no key we know, under two points).
export function readLine(item, { rects = [], byId = null } = {}) {
  const line = readBare(item);
  if (!line) return null;
  line.mapId = lineMap({ attachedTo: item.attachedTo, points: line.points }, rects, byId);
  return line;
}

// Every wall line in the scene. opts: {dpi, rects (views.js mapRects; worked out when missing)}.
export function readLines(items, { dpi = 150, rects = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const r = rects || mapRects(list, dpi);
  const byId = new Map(list.filter((i) => i?.id != null).map((i) => [i.id, i]));
  const out = [];
  for (const i of list) {
    const l = readLine(i, { rects: r, byId });
    if (l) out.push(l);
  }
  return out;
}

// The lines as fog/los.js segments, one per stretch: {a, b, kind, open, id, mapId}. A switched-off
// line gives none. maps (a Set or an array of map ids, optional): only lines on those maps.
export function segmentsOf(lines, maps = null) {
  const keep = maps == null ? null : maps instanceof Set ? maps : new Set(maps);
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || l.disabled || (keep && !keep.has(l.mapId)) || !Array.isArray(l.points)) continue;
    for (let k = 1; k < l.points.length; k++) {
      const a = l.points[k - 1], b = l.points[k];
      if (!isPt(a) || !isPt(b) || (a.x === b.x && a.y === b.y)) continue;
      out.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, kind: l.kind, open: l.open, id: l.id, mapId: l.mapId });
    }
  }
  return out;
}

// ---- maps ----

// A map image's four corners on the scene (top-left, top-right, bottom-right, bottom-left in its
// own frame), from its pixel size, its grid dpi and offset (the point at `position`), its scale and
// turn, at the scene's `dpi`. null when it isn't an image with grid settings.
export function mapCorners(item, dpi) {
  const iw = item?.image?.width, ih = item?.image?.height, gd = item?.grid?.dpi;
  if (!finite(iw, ih, gd, dpi) || iw <= 0 || ih <= 0 || gd <= 0 || dpi <= 0 || !isPt(item.position)) return null;
  const k = dpi / gd;
  const off = isPt(item.grid.offset) ? item.grid.offset : { x: iw / 2, y: ih / 2 };
  const at = (u, v) => {
    const p = toWorld(item, { x: (u - off.x) * k, y: (v - off.y) * k });
    return { x: r2(p.x), y: r2(p.y) };
  };
  return [at(0, 0), at(iw, 0), at(iw, ih), at(0, ih)];
}

// The wall round a map's edge, as a line (a closed ring of 5 points), so a PC's sight never spills
// onto the maps laid out beside it. `map`: a map image (its real corners, turned with it) or a
// {id?, x0, y0, x1, y1} rectangle. It stops sight only (blocking false): a drag, a portal or
// 🧭 Bring PCs never gets stuck at a map's edge. null for a broken map.
export function edgeLine(map, dpi = 150) {
  let c = null;
  if (map && finite(map.x0, map.y0, map.x1, map.y1)) {
    if (!(map.x1 > map.x0) || !(map.y1 > map.y0)) return null;
    c = [{ x: map.x0, y: map.y0 }, { x: map.x1, y: map.y0 }, { x: map.x1, y: map.y1 }, { x: map.x0, y: map.y1 }];
  } else {
    c = mapCorners(map, dpi);
  }
  if (!c) return null;
  const id = map?.id ?? null;
  return { id: `edge:${id}`, mapId: id, kind: "wall", open: false, locked: false, disabled: false, blocking: false,
           doubleSided: true, src: "edge", points: [...c, { ...c[0] }] };
}

export const edgeWalls = (map, dpi = 150) => segmentsOf([edgeLine(map, dpi)].filter(Boolean));

// The maps a PC stands on: the topmost map under each PC's middle. isPc(item): the one PC rule
// (fx/pcs.js isPcToken, as background.js ctx.isPc gives it); rects: views.js mapRects().
export function occupiedMaps(items, { isPc = () => false, rects = null, dpi = 150 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const r = rects || mapRects(list, dpi);
  const out = new Set();
  for (const i of list) {
    let pc = false;
    try { pc = !!isPc(i); } catch { pc = false; }
    if (!pc) continue;
    const id = mapAt(centreOf(i, dpi), r);
    if (id) out.add(id);
  }
  return out;
}

// ---- doors: the one door writer ----

// How a door that stands `now` ({open, locked, knownLocked}) stands after `change` ({open?, locked?,
// knownLocked?}; what's left out stays): open unlocks, locked shuts; a new lock starts unknown to
// the party, and a door that isn't locked has no known lock.
export function doorAfter(now, change = {}) {
  const c = isObj(change) ? change : {};
  let open = typeof c.open === "boolean" ? c.open : !!now?.open;
  let locked = typeof c.locked === "boolean" ? c.locked : !!now?.locked;
  if (c.locked === true) open = false;
  else if (open) locked = false;
  const fresh = c.locked === true && !now?.locked; // the DM's new lock: nobody has tried it yet
  const knownLocked = locked && (typeof c.knownLocked === "boolean" ? c.knownLocked : !fresh && !!now?.knownLocked);
  return { open, locked, knownLocked };
}

// Open, close, lock or unlock a door on `meta` (a metadata draft in an updateItems), or mark its
// lock found (knownLocked), in every format the line has: our key when it has ours (and Smoke's keys
// too when it also has them, so Smoke reads the same door if the DM switches back to it), else
// Smoke's keys alone (our key then holds only {knownLocked}, and only once a lock is found).
//
// Patch-safe (the live bug of 2026-10-12: a removed key that another screen's copy already lacked
// broke Owlbear's patch there, and that screen stopped seeing doors): it NEVER deletes a key. Our key
// is written in full, {..., kind: "door", open, locked, knownLocked} as explicit booleans; Smoke's
// doorOpen, disabled and isDoorLocked as true or false (Smoke reads them by truthiness or `=== true`:
// false is a shut, unlocked door to it). Idempotent: a format that already holds the target state is
// not touched, so a draft that holds it all asks Owlbear for nothing. Returns true when anything
// changed; a line that isn't a door (or isn't a line) is left alone.
export function doorEdit(meta, change = {}) {
  if (!isObj(meta)) return false;
  const wall = meta[WALL_KEY];
  const ours = ourState(wall);
  const smoke = smokeState(meta);
  const now = ours || smoke;
  if (!now || now.kind !== "door") return false;
  const known = now.locked && knownOf(meta);
  const t = doorAfter({ open: now.open, locked: now.locked, knownLocked: known }, change);
  let changed = false;
  if (ours) {
    if (ours.open !== t.open || ours.locked !== t.locked || known !== t.knownLocked) {
      meta[WALL_KEY] = { ...wall, kind: "door", open: t.open, locked: t.locked, knownLocked: t.knownLocked };
      changed = true;
    }
  } else if (known !== t.knownLocked) {
    // a Smoke-only door: our key carries only what the party knows (no kind: the state stays Smoke's)
    meta[WALL_KEY] = { ...(isObj(wall) ? wall : {}), knownLocked: t.knownLocked };
    changed = true;
  }
  if (smoke && smoke.kind === "door") {
    const want = [[SMOKE_LINE.open, t.open], [SMOKE_LINE.disabled, t.open], [SMOKE_LINE.locked, t.locked]];
    for (const [k, v] of want) {
      if (!!meta[k] === v) continue; // already reads so (a missing key is false): left as it is
      meta[k] = v;
      changed = true;
    }
  }
  return changed;
}
