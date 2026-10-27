// What a light really lights once walls stop it, for the darkness overlay (fx/lights.js darknessPlan,
// docs/lights-darkness-spec.md "Walls"): the part of its reach it can see, as a fan of triangles
// around it.
//
// lightFan() works out, from the wall segments (fx/lighting.js lightWalls), the polygon of every
// point within the light's reach that a straight line from the light reaches without crossing a
// wall (its visibility polygon), and gives it as a closed list of corners, anticlockwise round the
// light (by angle), measured from the light. The shader tests a pixel against each pair of
// neighbouring corners a, b: the triangle (light, a, b). The pixel is lit when it's inside one of
// them (fx/lights.js fanLit is the same test in JS). Where the view runs on past the reach, corners
// are put far enough out that the triangles' far sides never cut into it.
//
// The shader has room for FAN_VERTS corners a light (the last one repeats the first), so a light
// that needs more is simplified: corners are dropped (or a neighbour pulled in along its own line
// from the light) the cheapest first, by how much lit floor they cost, and never so that the light
// gets past a wall (more than LEAK_FT). A cave light loses a few nooks; a room keeps every corner.
//
// Pure functions, no Owlbear: the checks (owlbear/check_occlude.mjs) run them in node.

export const FAN_VERTS = 16; // corners in a big fan (fx/lights.js DK_BIG_V), the closing repeat included
export const LEAK_FT = 0.1; // how far a simplified fan may reach past a wall's line, at most
const TAU = 2 * Math.PI;
const MAX_WEDGE = (170 / 180) * Math.PI; // a triangle's corner at the light stays well under 180 deg
const ARC_STEP = Math.PI / 2; // far corners at most a quarter turn apart where the view is open

const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const norm = (a) => ((a % TAU) + TAU) % TAU;

// A segment cut to the disc of radius R round (0, 0), or null when it misses it.
function clipDisc(x1, y1, x2, y2, R) {
  const dx = x2 - x1, dy = y2 - y1;
  const a = dx * dx + dy * dy;
  if (!(a > 0)) return null;
  const b = 2 * (x1 * dx + y1 * dy), c = x1 * x1 + y1 * y1 - R * R;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - sq) / (2 * a)), t1 = Math.min(1, (-b + sq) / (2 * a));
  if (t1 <= t0) return null;
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

// How far along the ray from (0, 0) at angle th it meets segment s (Infinity: it doesn't).
function along(th, s) {
  const dx = Math.cos(th), dy = Math.sin(th);
  const ex = s[2] - s[0], ey = s[3] - s[1];
  const den = cross(dx, dy, ex, ey);
  if (Math.abs(den) < 1e-12) return Infinity;
  const t = cross(s[0], s[1], ex, ey) / den;
  const u = cross(s[0], s[1], dx, dy) / den;
  return t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : Infinity;
}

// The same along a line through two corners (no ends): the fan's own edges.
function alongLine(th, a, b) {
  const den = cross(Math.cos(th), Math.sin(th), b.x - a.x, b.y - a.y);
  const k = cross(a.x, a.y, b.x, b.y);
  if (Math.abs(den) < 1e-12) return Infinity;
  const t = k / den;
  return t > 0 ? t : Infinity;
}

// The walls within the reach R of a light at (x, y), each cut to it and moved to the light's
// own coordinates, and a key that names them (to tell when the fan must be worked out again). A
// wall right through the light has no far side and blocks nothing (as fx/lights.js wallSlots).
export function wallsNear(x, y, R, segs) {
  const near = [];
  let h = 2166136261;
  for (const s of segs || []) {
    if (!s || s.length < 4) continue;
    const x1 = s[0] - x, y1 = s[1] - y, x2 = s[2] - x, y2 = s[3] - y;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const c = clipDisc(x1, y1, x2, y2, R);
    if (!c) continue;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!(len > 0) || Math.abs(cross(x1, y1, x2 - x1, y2 - y1)) / len < 1e-6) continue;
    near.push(c);
    for (const v of [s[0], s[1], s[2], s[3]]) {
      h ^= Math.round(v * 4) | 0;
      h = Math.imul(h, 16777619);
    }
  }
  return { near, key: `${near.length}:${h >>> 0}` };
}

// How near the light at (0, 0) any of `near` comes (Infinity: none): all within it is lit.
export function clearOf(near) {
  let m = Infinity;
  for (const s of near || []) {
    const dx = s[2] - s[0], dy = s[3] - s[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(s[0] * dx + s[1] * dy) / len)) : 0;
    m = Math.min(m, Math.hypot(s[0] + t * dx, s[1] + t * dy));
  }
  return m;
}

// The visibility polygon of a light at (0, 0) among `near` (cut to the reach R), as corners
// anticlockwise by angle: {x, y, a (angle), far (true: a stand-in past the reach)}. Null when no
// wall comes within the reach (the light is a plain circle).
export function visibility(near, R) {
  if (!near.length) return null;
  const angs = [];
  for (const s of near) angs.push(norm(Math.atan2(s[1], s[0])), norm(Math.atan2(s[3], s[2])));
  // where two walls cross, the nearer one can change mid-way
  for (let i = 0; i < near.length; i++) {
    const p = near[i];
    for (let j = i + 1; j < near.length; j++) {
      const q = near[j];
      const ex = p[2] - p[0], ey = p[3] - p[1], fx = q[2] - q[0], fy = q[3] - q[1];
      const den = cross(ex, ey, fx, fy);
      if (Math.abs(den) < 1e-12) continue;
      const t = cross(q[0] - p[0], q[1] - p[1], fx, fy) / den, u = cross(q[0] - p[0], q[1] - p[1], ex, ey) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) angs.push(norm(Math.atan2(p[1] + t * ey, p[0] + t * ex)));
    }
  }
  angs.sort((a, b) => a - b);
  const A = [];
  for (const a of angs) if (!A.length || a - A[A.length - 1] > 1e-9) A.push(a);
  if (A.length > 1 && A[0] + TAU - A[A.length - 1] <= 1e-9) A.pop();
  // the nearest wall in each gap between those angles (or none: open to the reach)
  const runs = [];
  for (let i = 0; i < A.length; i++) {
    const a0 = A[i], a1 = i + 1 < A.length ? A[i + 1] : A[0] + TAU;
    const m = (a0 + a1) / 2;
    let best = Infinity, k = -1;
    for (let j = 0; j < near.length; j++) {
      const t = along(m, near[j]);
      if (t < best) { best = t; k = j; }
    }
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.a1 = a1;
    else runs.push({ a0, a1, k });
  }
  if (runs.length > 1 && runs[0].k === runs[runs.length - 1].k) {
    const last = runs.pop();
    runs[0].a0 = last.a0 - TAU;
  }
  if (runs.length === 1 && runs[0].k < 0) return null;
  const pts = [];
  const push = (x, y, a, far) => {
    const l = pts[pts.length - 1];
    if (l && Math.abs(l.x - x) < 1e-6 * R && Math.abs(l.y - y) < 1e-6 * R) return;
    pts.push({ x, y, a, far });
  };
  for (const r of runs) {
    if (r.k >= 0) {
      const s = near[r.k];
      for (const a of [r.a0, r.a1]) {
        let t = along(a, s);
        // (at its very end the ray can just miss it by rounding: the line through it then)
        if (!Number.isFinite(t)) t = alongLine(a, { x: s[0], y: s[1] }, { x: s[2], y: s[3] });
        if (!Number.isFinite(t)) t = 0;
        push(t * Math.cos(a), t * Math.sin(a), a, false);
      }
    } else {
      // open: corners past the reach, close enough together that no side cuts into it
      const span = r.a1 - r.a0;
      const n = Math.max(1, Math.ceil(span / ARC_STEP - 1e-9));
      const D = (R * 1.01) / Math.cos(span / n / 2);
      for (let i = 0; i <= n; i++) {
        const a = r.a0 + (span * i) / n;
        push(D * Math.cos(a), D * Math.sin(a), a, true);
      }
    }
  }
  // closing: the last corner may be the first one again
  if (pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.abs(l.x - f.x) < 1e-6 * R && Math.abs(l.y - f.y) < 1e-6 * R) pts.pop();
  }
  // angles increasing from the first corner (one full turn)
  for (let i = 1; i < pts.length; i++) {
    while (pts[i].a < pts[i - 1].a - 1e-9) pts[i].a += TAU;
  }
  return pts.length >= 3 ? pts : null;
}

// ---- simplifying a fan to the shader's corners ----

// How far the fan reaches along angle th through the run of corners `list` (angles increasing),
// cut to R; R where no edge of the run covers th.
function rhoOf(list, th, R) {
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1];
    if (b.a - a.a < 1e-12) continue;
    if (th >= a.a - 1e-12 && th <= b.a + 1e-12) return Math.min(alongLine(th, a, b), R);
  }
  return R;
}

// What replacing the run of corners `olds` by `news` (from the same first corner's angle to the
// same last one's) costs: the lit floor lost (area within R), and the furthest the new edges
// reach past the old ones anywhere in between (a leak past a wall).
function costOver(olds, news, R) {
  const a0 = olds[0].a, span = olds[olds.length - 1].a - a0;
  if (!(span > 1e-12)) return { lost: 0, leak: 0 };
  const N = 16;
  let lost = 0, leak = 0;
  for (let i = 0; i < N; i++) {
    const th = a0 + ((i + 0.5) / N) * span;
    const ro = rhoOf(olds, th, R), rn = rhoOf(news, th, R);
    lost += (ro * ro - rn * rn) / 2;
    leak = Math.max(leak, rn - ro);
  }
  // an edge is straight between corners, so the worst leak is at an old corner the new run
  // passes outside of (one that's gone, or moved in)
  for (let i = 1; i + 1 < olds.length; i++) {
    const o = olds[i];
    leak = Math.max(leak, rhoOf(news, o.a, R) - Math.min(Math.hypot(o.x, o.y), R));
  }
  return { lost: (lost * span) / N, leak };
}

// Corner c moved in along its own line from the light to where the line through p and q meets
// that line, or null when that isn't nearer the light than c.
function pullTo(c, p, q) {
  const t = alongLine(c.a, p, q);
  if (!(t > 0) || t >= Math.hypot(c.x, c.y)) return null;
  return { x: t * Math.cos(c.a), y: t * Math.sin(c.a), a: c.a, far: false };
}

// The cheapest way to lose corner j of the closed fan `pts`: drop it, or drop it and pull a
// neighbour in onto the line through it (a corner that juts towards the light can't simply go:
// the light would get past it). {cost, news, from, to}: corners from..to (indices round the fan,
// both ends kept or moved) become `news`; or null.
function bestDrop(pts, j, R, leakMax) {
  const n = pts.length;
  if (n <= 3) return null;
  const at = (k) => {
    const i = ((k % n) + n) % n;
    const turns = Math.round((k - i) / n);
    return turns ? { ...pts[i], a: pts[i].a + turns * TAU } : pts[i];
  };
  const p0 = at(j - 1), p1 = at(j), p2 = at(j + 1);
  if (!(p2.a - p0.a < MAX_WEDGE)) return null;
  let best = null;
  const offer = (olds, news, from, to) => {
    const c = costOver(olds, news, R);
    if (c.leak <= leakMax && (!best || c.lost < best.cost)) best = { cost: c.lost, news, from, to };
  };
  offer([p0, p1, p2], [p0, p2], j - 1, j + 1);
  const pn = pullTo(p2, p0, p1);
  if (pn) {
    const p3 = at(j + 2);
    offer([p0, p1, p2, p3], [p0, pn, p3], j - 1, j + 2);
  }
  const pp = pullTo(p0, p1, p2);
  if (pp) {
    const pm = at(j - 2);
    offer([pm, p0, p1, p2], [pm, pp, p2], j - 2, j + 1);
  }
  return best;
}

// The fan with corners from..to (indices round it) replaced by d.news, angles increasing again.
function applyDrop(pts, d) {
  const n = pts.length;
  const res = d.news.map((p) => ({ ...p }));
  for (let k = d.to + 1; k < d.from + n; k++) res.push({ ...pts[((k % n) + n) % n] });
  for (let i = 1; i < res.length; i++) {
    while (res[i].a < res[i - 1].a - 1e-9) res[i].a += TAU;
    while (res[i].a > res[i - 1].a + Math.PI) res[i].a -= TAU;
  }
  return res;
}

// The lit area of a closed fan within R.
function fanArea(pts, R) {
  const n = pts.length, N = 16;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = i + 1 < n ? pts[i + 1] : { ...pts[0], a: pts[0].a + TAU };
    const span = b.a - a.a;
    if (!(span > 1e-12)) continue;
    for (let k = 0; k < N; k++) {
      const r = Math.min(alongLine(a.a + ((k + 0.5) / N) * span, a, b), R);
      s += ((r * r) / 2) * (span / N);
    }
  }
  return s;
}

// A light's fan, at (x, y) with reach R among the walls `segs` (all scene px): null when no wall
// comes within its reach (a plain circle), else {pts: [[dx, dy] ...] (at most `verts`, from the
// light, closed: the last is the first again), reach (how far from the light anything it lights
// is, at most R), raw (corners before simplifying), lost (the lit floor that cost, a fraction)}.
// leak: how far past a wall's line a simplified fan may reach (px).
export function lightFan(x, y, R, segs, { verts = FAN_VERTS, leak = 0 } = {}) {
  if (![x, y, R].every(Number.isFinite) || !(R > 0)) return null;
  return fanOf(wallsNear(x, y, R, segs).near, R, { verts, leak });
}

// The same from wallsNear()'s walls (fx/lights.js darknessPlan keeps fans by wallsNear's key).
export function fanOf(near, R, { verts = FAN_VERTS, leak = 0 } = {}) {
  let pts = visibility(near, R);
  if (!pts) return null;
  const raw = pts.length;
  const room = Math.max(3, verts - 1);
  const area = raw > room ? fanArea(pts, R) : 0;
  while (pts.length > room) {
    let best = null;
    for (let j = 0; j < pts.length; j++) {
      const d = bestDrop(pts, j, R, leak);
      if (d && (!best || d.cost < best.cost)) best = d;
    }
    if (!best) break;
    pts = applyDrop(pts, best);
  }
  if (pts.length > room) return null;
  let reach = 0;
  for (const p of pts) reach = Math.max(reach, Math.hypot(p.x, p.y));
  const out = pts.map((p) => [p.x, p.y]);
  out.push([pts[0].x, pts[0].y]);
  return { pts: out, reach: Math.min(reach, R), raw, lost: area > 0 ? Math.max(0, 1 - fanArea(pts, R) / area) : 0 };
}
