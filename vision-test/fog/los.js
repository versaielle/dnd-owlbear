// Party line of sight on the CPU (docs/vision-layer-spec.md section 5): what a PC standing at a
// point sees past the walls, as a polygon, the way Owlbear's shadow-casting point lights cut the
// fog. The writer (the leader GM screen) unions the party's polygons for the explored memory, the
// door checks and aim/fog.js. Pure: no Owlbear import and no DOM, so the offline checks load it.
//
// A segment is {a: {x, y}, b: {x, y}, kind, open} in scene units. kind: "wall", "door" (open:
// true while it stands open), "window", "secret" (a secret door nobody has found: a wall to
// everything; once found it becomes a "door"), or "zone" (the ring of a heavily obscured zone,
// docs/vision-layer-2024.md section 7: it stops sight, never a drag). A missing or unknown kind is
// a wall.
//
//   sightBlockers(segments)   what sight stops at: walls, closed doors, secret doors, zone rings
//                             (an open door or a window lets it through)
//   moveBlockers(segments)    what a drag stops at: walls, closed doors, secret doors and windows
//                             (never a zone ring: tokens walk through fog)
//   rectWalls(rect)           four walls round {x0, y0, x1, y1}: a map's edge, so a PC's sight
//                             never spills onto the maps laid out beside it
//   visibilityPolygon(origin, blockers, reach, {arcSteps})   what a point sees within `reach` scene
//                             units: [{x, y}...] in order of angle, [] when it sees nothing. arcSteps:
//                             the reach circle's points per whole turn (default ARC_STEPS; the explored
//                             memory passes fog/shapes.js arcSteps(reach) for arcs within 1 px), rounded
//                             up and held to ARC_STEPS_MIN..ARC_STEPS_MAX; anything else is the default
//   canSee(from, to, blockers, {ignore, reach})  one sight line, true when nothing is in the way
//                             (ignore: segments to skip, such as the door being checked)
//   pointInPolygon(point, polygon)
//   seenCells(polygons, grid) the squares whose CENTRE lies in any of the polygons, as sorted
//                             indices (row * cols + col); grid = {x0, y0, cell, cols, rows}
//
// It behaves like a point light: a segment seen edge-on (its line runs through the point, as when
// the point stands on its end) casts no shadow, and sight never slips between two segments that
// meet at a corner, even when rounding in the line data leaves their ends a hair apart.

const TAU = 2 * Math.PI;
export const ARC_STEPS = 48; // the reach circle as a 48-gon: its edges stay within 0.22% of reach of the circle
export const ARC_STEPS_MIN = 8; // visibilityPolygon's arcSteps option is held to these
export const ARC_STEPS_MAX = 1024;
const ANG_EPS = 1e-8; // radians: segment ends this close in angle are one corner (rounding in the line data)
const EPS = 1e-9; // relative: ties, segments seen edge-on, straight runs
const MAX_SPLITS = 8; // a gap between two corners is split at most this deep where segments cross inside it

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const isPt = (p) => !!p && finite(p.x, p.y);
const isSeg = (s) => !!s && isPt(s.a) && isPt(s.b);

export const KINDS = ["wall", "door", "window", "secret", "zone"];
export const kindOf = (s) => (KINDS.includes(s?.kind) ? s.kind : "wall");
// Walls, secret doors and closed doors stop sight and moves alike; a zone ring stops sight only,
// a window moves only.
const blocksBoth = (s) => { const k = kindOf(s); return k === "wall" || k === "secret" || (k === "door" && !s.open); };
const blocksSight = (s) => blocksBoth(s) || kindOf(s) === "zone";

export const sightBlockers = (segments) => (Array.isArray(segments) ? segments : []).filter((s) => isSeg(s) && blocksSight(s));
export const moveBlockers = (segments) =>
  (Array.isArray(segments) ? segments : []).filter((s) => isSeg(s) && (blocksBoth(s) || kindOf(s) === "window"));

// The four walls round a rectangle (darkness.js mapRect's {x0, y0, x1, y1}); [] for a broken one.
export function rectWalls(r, kind = "wall") {
  if (!r || !finite(r.x0, r.y0, r.x1, r.y1) || !(r.x1 > r.x0) || !(r.y1 > r.y0)) return [];
  const c = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  return c.map((a, k) => ({ a, b: c[(k + 1) % 4], kind }));
}

// ---- the polygon ----
// Each blocker is clipped to the reach circle and turned to run counter-clockwise (y up) round the
// origin; its ends' angles are the events. Between two neighbouring events the same segments
// stand in front of the origin, so the boundary there is the nearest of them (looked up at both
// ends of the gap; where two crossing segments swap places inside it, the gap is split where they
// cross), or the reach circle when there's none. Cost: a sort of the ends, then the segments in
// front of each gap: about 4 ms for 6 PCs among 670 walls, all within reach (Node, a desktop).

// The part of segment a-b (relative to the origin) within distance R of it: [ax, ay, bx, by] or null.
// Ends inside the circle are kept exactly, so two segments that share a corner still share it.
function clip(ax, ay, bx, by, R) {
  const dx = bx - ax, dy = by - ay;
  const A = dx * dx + dy * dy;
  if (!(A > 0)) return null;
  const B = 2 * (ax * dx + ay * dy), C = ax * ax + ay * ay - R * R;
  const disc = B * B - 4 * A * C;
  if (!(disc > 0)) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-B - sq) / (2 * A), t1 = (-B + sq) / (2 * A);
  if (t1 <= 0 || t0 >= 1) return null;
  return [t0 > 0 ? ax + t0 * dx : ax, t0 > 0 ? ay + t0 * dy : ay, t1 < 1 ? ax + t1 * dx : bx, t1 < 1 ? ay + t1 * dy : by];
}

// The blockers as the sweep wants them: relative to the origin, clipped, counter-clockwise, with
// their distance range (along any ray through a segment the distance lies within it).
function prepare(o, blockers, reach) {
  const out = [];
  for (const s of Array.isArray(blockers) ? blockers : []) {
    if (!isSeg(s)) continue;
    const c = clip(s.a.x - o.x, s.a.y - o.y, s.b.x - o.x, s.b.y - o.y, reach);
    if (!c) continue;
    let [ax, ay, bx, by] = c;
    const cr = ax * by - ay * bx;
    let la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (!(Math.abs(cr) > EPS * la * lb)) continue; // seen edge-on (the origin on its line, or on an end)
    if (cr < 0) [ax, ay, bx, by, la, lb] = [bx, by, ax, ay, lb, la];
    const ex = bx - ax, ey = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * ex + ay * ey) / (ex * ex + ey * ey)));
    out.push({ ax, ay, bx, by, ex, ey, num: ax * ey - ay * ex, rmin: Math.hypot(ax + t * ex, ay + t * ey), rmax: Math.max(la, lb) });
  }
  return out;
}

const angleOf = (x, y) => { const t = Math.atan2(y, x); return t < 0 ? t + TAU : t; };

// The distance from the origin to segment s along the ray at angle (c = cos, sn = sin) inside its span.
function dist(s, c, sn) {
  const den = c * s.ey - sn * s.ex;
  const r = den > 0 ? s.num / den : s.rmax;
  return r < s.rmin ? s.rmin : r > s.rmax ? s.rmax : r;
}

// Where the lines of segments s and t cross (relative to the origin), or null when they're parallel.
function crossing(s, t) {
  const den = s.ex * t.ey - s.ey * t.ex;
  if (!(Math.abs(den) > EPS * Math.hypot(s.ex, s.ey) * Math.hypot(t.ex, t.ey))) return null;
  const u = ((t.ax - s.ax) * t.ey - (t.ay - s.ay) * t.ex) / den;
  return { x: s.ax + u * s.ex, y: s.ay + u * s.ey };
}

// The arcSteps option made safe: a finite number, rounded up and held to ARC_STEPS_MIN..ARC_STEPS_MAX;
// anything else (missing, junk) is ARC_STEPS.
const stepsOf = (x) => (finite(x) ? Math.min(ARC_STEPS_MAX, Math.max(ARC_STEPS_MIN, Math.ceil(x - EPS))) : ARC_STEPS);

export function visibilityPolygon(origin, blockers, reach, opts = {}) {
  if (!isPt(origin) || !finite(reach) || !(reach > 0)) return [];
  const steps = stepsOf(opts?.arcSteps); // opts may be null or junk: the default
  const segs = prepare(origin, blockers, reach);
  const tol = reach * EPS;
  const pts = [];
  const emit = (x, y) => pts.push({ x: origin.x + x, y: origin.y + y });
  const arc = (t0, t1) => { // the reach circle from angle t0 to t1, at least one vertex per `steps`-th of a turn
    const n = Math.max(1, Math.ceil((t1 - t0) / (TAU / steps) - EPS));
    for (let j = 0; j <= n; j++) { const t = t0 + ((t1 - t0) * j) / n; emit(Math.cos(t) * reach, Math.sin(t) * reach); }
  };

  // The events: every end's angle; ends within ANG_EPS of each other are one corner.
  const ev = [];
  segs.forEach((s, i) => { ev.push([angleOf(s.ax, s.ay), i, 0], [angleOf(s.bx, s.by), i, 1]); });
  ev.sort((p, q) => p[0] - q[0]);
  const ang = [];
  const first = new Int32Array(segs.length), last = new Int32Array(segs.length);
  let prev = -Infinity;
  for (const [t, i, end] of ev) {
    if (t - prev > ANG_EPS) ang.push(t);
    prev = t;
    (end ? last : first)[i] = ang.length - 1;
  }
  if (ang.length > 1 && ang[0] + TAU - ang[ang.length - 1] <= ANG_EPS) { // a hair either side of angle 0: one corner
    const L = ang.length - 1;
    for (let i = 0; i < segs.length; i++) { if (first[i] === L) first[i] = 0; if (last[i] === L) last[i] = 0; }
    ang.pop();
  }
  const M = ang.length;
  const starts = Array.from({ length: M }, () => []), ends = Array.from({ length: M }, () => []);
  const active = new Set(); // the segments in front of the current gap
  for (let i = 0; i < segs.length; i++) {
    if (first[i] === last[i]) continue; // narrower than ANG_EPS
    starts[first[i]].push(i);
    ends[last[i]].push(i);
    if (first[i] > last[i] && last[i] > 0) active.add(i); // runs across angle 0: in front of the first gap
  }
  if (!M || !starts.some((x) => x.length)) {
    arc(0, TAU);
    return tidy(pts, tol);
  }
  const cos = ang.map(Math.cos), sin = ang.map(Math.sin);

  // One gap, from angle t0 to t1: the nearest segment at each end (a tie at one end goes to the
  // nearer at the other); the same one = its straight piece, none = the circle, two = they cross.
  const gap = (t0, t1, c0, s0, c1, s1, depth) => {
    let f = -1, f0 = 0, f1 = 0, l = -1, l0 = 0, l1 = 0;
    for (const i of active) {
      const p = dist(segs[i], c0, s0), q = dist(segs[i], c1, s1);
      if (f < 0 || p < f0 - tol || (p <= f0 + tol && q < f1)) { f = i; f0 = p; f1 = q; }
      if (l < 0 || q < l1 - tol || (q <= l1 + tol && p < l0)) { l = i; l0 = p; l1 = q; }
    }
    if (f < 0) return arc(t0, t1);
    if (f !== l && depth < MAX_SPLITS) {
      const x = crossing(segs[f], segs[l]);
      if (x && c0 * x.y - s0 * x.x > 0 && x.x * s1 - x.y * c1 > 0) {
        const h = Math.hypot(x.x, x.y);
        let tx = Math.atan2(x.y, x.x);
        while (tx < t0) tx += TAU;
        gap(t0, tx, c0, s0, x.x / h, x.y / h, depth + 1);
        gap(tx, t1, x.x / h, x.y / h, c1, s1, depth + 1);
        return;
      }
    }
    emit(c0 * f0, s0 * f0);
    emit(c1 * l1, s1 * l1);
  };
  for (let k = 0; k < M; k++) {
    for (const i of ends[k]) active.delete(i);
    for (const i of starts[k]) active.add(i);
    const k1 = (k + 1) % M;
    gap(ang[k], ang[k1] + (k1 ? 0 : TAU), cos[k], sin[k], cos[k1], sin[k1], 0);
  }
  return tidy(pts, tol);
}

// Repeats and the points along a straight run (a wall the sweep met at several corners) dropped.
function tidy(pts, tol) {
  const same = (p, q) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
  const straight = (a, b, c) => {
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    return Math.abs(ux * vy - uy * vx) <= EPS * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0;
  };
  const out = [];
  for (const p of pts) {
    if (out.length && same(out[out.length - 1], p)) continue;
    while (out.length >= 2 && straight(out[out.length - 2], out[out.length - 1], p)) out.pop();
    out.push(p);
  }
  while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  while (out.length >= 3 && straight(out[out.length - 2], out[out.length - 1], out[0])) out.pop();
  while (out.length >= 3 && straight(out[out.length - 1], out[0], out[1])) out.shift();
  return out.length >= 3 ? out : [];
}

// ---- one sight line ----

// Whether segment s stands in the way from p to q: it crosses or touches the line strictly between
// them (a point on a wall's face can be seen; a corner where two walls meet blocks). A segment
// along the line (seen edge-on) doesn't, as with the polygon.
function inTheWay(p, q, s) {
  const dx = q.x - p.x, dy = q.y - p.y, ex = s.b.x - s.a.x, ey = s.b.y - s.a.y;
  const den = dx * ey - dy * ex;
  if (!(Math.abs(den) > EPS * Math.hypot(dx, dy) * Math.hypot(ex, ey))) return false;
  const wx = s.a.x - p.x, wy = s.a.y - p.y;
  const t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
  return t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS;
}

// Can a PC at `from` see `to`? opts: ignore (a segment, an array or a Set of them: skipped, such
// as the door being checked), reach (scene units; farther = no).
export function canSee(from, to, blockers, { ignore = null, reach = null } = {}) {
  if (!isPt(from) || !isPt(to)) return false;
  if (finite(reach) && Math.hypot(to.x - from.x, to.y - from.y) > reach) return false;
  const skip = ignore instanceof Set ? ignore : new Set(Array.isArray(ignore) ? ignore : ignore ? [ignore] : []);
  for (const s of Array.isArray(blockers) ? blockers : []) {
    if (isSeg(s) && !skip.has(s) && inTheWay(from, to, s)) return false;
  }
  return true;
}

// ---- points and squares ----

// Even-odd: a point on the left or top edge counts as inside, on the right or bottom edge outside.
export function pointInPolygon(point, polygon) {
  if (!isPt(point) || !Array.isArray(polygon) || polygon.length < 3) return false;
  const { x, y } = point;
  let inside = false;
  for (let k = 0, j = polygon.length - 1; k < polygon.length; j = k++) {
    const p = polygon[k], q = polygon[j];
    if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
  }
  return inside;
}

const gridOk = (g) => !!g && finite(g.x0, g.y0, g.cell) && g.cell > 0
  && Number.isInteger(g.cols) && Number.isInteger(g.rows) && g.cols > 0 && g.rows > 0;

// The squares whose centre lies in any of the polygons (the same test as pointInPolygon), as
// sorted indices row * cols + col. Each row of centres is scanned once per polygon, so a big map
// costs its rows times the polygons' edges, not its squares times them.
export function seenCells(polygons, grid) {
  if (!gridOk(grid) || !Array.isArray(polygons)) return [];
  const { x0, y0, cell, cols, rows } = grid;
  const list = polygons.length && !Array.isArray(polygons[0]) ? [polygons] : polygons; // one polygon on its own
  const mark = new Uint8Array(cols * rows);
  for (const poly of list) {
    if (!Array.isArray(poly) || poly.length < 3 || !poly.every(isPt)) continue;
    const xs = new Map(); // row -> the x where an edge crosses its line of centres
    for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
      const p = poly[k], q = poly[j];
      if (p.y === q.y) continue;
      const lo = Math.max(0, Math.floor((Math.min(p.y, q.y) - y0) / cell - 0.5));
      const hi = Math.min(rows - 1, Math.ceil((Math.max(p.y, q.y) - y0) / cell - 0.5));
      for (let r = lo; r <= hi; r++) {
        const y = y0 + (r + 0.5) * cell;
        if ((p.y > y) === (q.y > y)) continue;
        if (!xs.has(r)) xs.set(r, []);
        xs.get(r).push(((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x);
      }
    }
    for (const [r, row] of xs) {
      row.sort((a, b) => a - b);
      for (let n = 0; n + 1 < row.length; n += 2) { // inside from row[n] (included) to row[n + 1] (not)
        for (let c = Math.max(0, Math.floor((row[n] - x0) / cell - 0.5)); c < cols; c++) {
          const x = x0 + (c + 0.5) * cell;
          if (x >= row[n + 1]) break;
          if (x >= row[n]) mark[r * cols + c] = 1;
        }
      }
    }
  }
  const out = [];
  for (let i = 0; i < mark.length; i++) if (mark[i]) out.push(i);
  return out;
}
