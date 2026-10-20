// The aim tool's maths: where a spell's area lies on the map and which tokens it catches.
// Pure (no Owlbear SDK), so check_geometry.mjs tests it offline and the bridge can use it
// to work out who an aim caught, hidden monsters included.
//
// Units: positions are scene px, sizes are feet, angles are degrees (0 = +x, clockwise,
// because the screen's y points down). Each screen converts feet with its own grid.
//
// The 2024 rule the table plays by: a creature is caught when the area touches ANY part of
// its space. The space is shrunk by 0.05 of a cell on every side first, so an area drawn
// exactly along grid lines doesn't catch the square next to it, while touching any real
// part of a Large creature's 2x2 space does.
//
// A token record, as these functions take them: {id, fp, item?, secret?, label?}, where
// fp (the footprint) is an axis-aligned box {minX, minY, maxX, maxY, cx, cy, w, h}.

export const CONE_HALF = Math.atan(0.5); // 2024 cone: as wide at its end as it is long
export const EPS_CELLS = 0.05;
export const SHAPES = ["sphere", "cylinder", "emanation", "cube", "square", "cone", "line"];

const DEG = Math.PI / 180;
const TINY = 1e-7;

// Feet per grid unit. Owlbear's scale is free text ("5ft", "1.5m"); D&D on a metric grid
// counts 1.5 m as 5 ft, so a metre is 10/3 ft. Anything unknown is taken as a 5-ft square.
const FEET_PER_UNIT = {
  ft: 1, feet: 1, foot: 1, "'": 1, m: 10 / 3, meter: 10 / 3, meters: 10 / 3, metre: 10 / 3,
  metres: 10 / 3, yd: 3, yard: 3, yards: 3, mi: 5280, mile: 5280, miles: 5280, km: 10000 / 3,
};

const pos = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
const r2 = (v) => Math.round(v * 100) / 100;

export function normDeg(d) {
  const v = ((Number(d) || 0) % 360 + 360) % 360;
  return Math.abs(v - 360) < 1e-9 ? 0 : v;
}

// ---- grid ----

export function gridInfo(g) {
  // One shape for every grid we're handed: the map report's {dpi, multiplier, unit,
  // measurement, type}, a Template's {dpi, ft_per_cell}, or an earlier gridInfo().
  g = g || {};
  const dpi = pos(+g.dpi) || 150;
  let ftPerCell = pos(+g.ftPerCell) || pos(+g.ft_per_cell);
  if (!ftPerCell) {
    const parsed = g.scale?.parsed || {};
    const mult = pos(+(g.multiplier ?? parsed.multiplier));
    const unit = String(g.unit ?? parsed.unit ?? "ft").trim().toLowerCase();
    const per = FEET_PER_UNIT[unit];
    ftPerCell = mult && per ? mult * per : 5;
  }
  const type = String(g.type || "SQUARE").toUpperCase();
  const square = type === "SQUARE";
  // Hex grids: no snapping and plain straight-line distances (the HUD warns).
  const measurement = square ? String(g.measurement || "CHEBYSHEV").toUpperCase() : "EUCLIDEAN";
  const origin = { x: +g.origin?.x || 0, y: +g.origin?.y || 0 };
  return { dpi, cell: dpi, ftPerCell, pxPerFt: dpi / ftPerCell, measurement, type, square, origin };
}

// Distance in cells for a gap of dx by dy cells, by the grid's measurement rule (as
// Owlbear's ruler counts it).
export function metricCells(dx, dy, measurement = "CHEBYSHEV") {
  dx = Math.abs(dx);
  dy = Math.abs(dy);
  switch (measurement) {
    case "EUCLIDEAN":
      return Math.hypot(dx, dy);
    case "MANHATTAN":
      return dx + dy;
    case "ALTERNATING": {
      // 5-10-5: every second diagonal costs double.
      const lo = Math.min(dx, dy);
      return Math.max(dx, dy) + Math.floor(lo / 2 + 1e-9);
    }
    default:
      return Math.max(dx, dy); // CHEBYSHEV, D&D 5e's "every square is 5 feet"
  }
}

// ---- footprints ----

export function box(cx, cy, w, h) {
  return { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2, cx, cy, w, h };
}

// The space of a token turned to an angle that isn't a multiple of 90 degrees:
//   "upright"  its unturned box around the same centre: turning a token's art to show which
//              way it faces doesn't make the creature bigger (a Medium token at 45 degrees
//              would otherwise be 1.41 squares wide and caught from the next square)
//   "bbox"     the box around the turned rectangle (spec section 10.1 as written)
// A 90 or 270 degree turn swaps width and height either way. One word to change, if the
// table wants the spec's rule; the bridge and every screen use this same file.
export const TURNED_SPACE = "upright";

export function turnedSize(w, h, deg, rule = TURNED_SPACE) {
  const turn = normDeg(deg) % 180;
  if (Math.abs(turn - 90) < 1e-9) return [h, w];
  if (turn < 1e-9 || 180 - turn < 1e-9) return [w, h];
  if (rule === "bbox") {
    const a = turn * DEG, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return [w * c + h * s, w * s + h * c];
  }
  return turn >= 45 && turn < 135 ? [h, w] : [w, h];
}

export function footprint(item, dpi, bounds = null) {
  // A token's space on the map. For an image token it is its image box (the tokenBox maths
  // from background.js, width and height kept apart, Owlbear's own transform: position,
  // then rotation, then scale, then the grid offset), turned as turnedSize says. Non-image
  // tokens use their bounds (Owlbear's getItemBounds, fetched by the tool).
  if (!item) return null;
  dpi = pos(+dpi) || 150;
  const img = item.image, g = item.grid;
  if (img && pos(+img.width) && pos(+img.height) && pos(+g?.dpi)) {
    const k = dpi / g.dpi;
    const W = img.width, H = img.height;
    const ox = Number.isFinite(g.offset?.x) ? g.offset.x : W / 2;
    const oy = Number.isFinite(g.offset?.y) ? g.offset.y : H / 2;
    const sx = Number.isFinite(item.scale?.x) ? item.scale.x : 1;
    const sy = Number.isFinite(item.scale?.y) ? item.scale.y : 1;
    const lx = (W / 2 - ox) * k * sx, ly = (H / 2 - oy) * k * sy; // image centre from the position, unrotated
    const a = (item.rotation || 0) * DEG, c = Math.cos(a), s = Math.sin(a);
    const px = item.position?.x || 0, py = item.position?.y || 0;
    const [w, h] = turnedSize(W * k * Math.abs(sx), H * k * Math.abs(sy), item.rotation || 0);
    if (!(w > 0 && h > 0)) return null;
    return box(px + lx * c - ly * s, py + lx * s + ly * c, w, h);
  }
  const b = bounds;
  if (b && b.min && b.max && b.max.x > b.min.x && b.max.y > b.min.y) {
    return box((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.x - b.min.x, b.max.y - b.min.y);
  }
  return null;
}

export function shrink(rect, eps) {
  // The space shrunk by eps px on every side (never past its centre).
  const ex = Math.min(Math.max(eps, 0), rect.w / 2), ey = Math.min(Math.max(eps, 0), rect.h / 2);
  return box(rect.cx, rect.cy, rect.w - 2 * ex, rect.h - 2 * ey);
}

// Character tokens as records, with R1's secret flag: a token is secret when it is hidden
// and isn't a PC (a hidden PC token is public; the DM hides those so they don't draw under
// the minis). isPublic(id, item) and pcTokens come from the background's heartbeat.
export function tokensOf(items, grid, { bounds = null, isPublic = null, pcTokens = null } = {}) {
  const g = gridInfo(grid);
  const pcs = pcTokens instanceof Set ? pcTokens : new Set(pcTokens || []);
  const out = [];
  for (const item of items || []) {
    if (!item || item.layer !== "CHARACTER") continue;
    const fp = footprint(item, g.dpi, bounds instanceof Map ? bounds.get(item.id) : bounds?.[item.id]);
    if (!fp) continue;
    const pub = item.visible !== false || pcs.has(item.id) || !!safeCall(isPublic, item.id, item);
    out.push({ id: item.id, fp, item, secret: !pub, label: tokenLabel(item) });
  }
  return out;
}

function safeCall(fn, ...args) {
  try {
    return typeof fn === "function" ? fn(...args) : false;
  } catch {
    return false;
  }
}

export function logText(x) {
  // One log argument as text (an error by its message), for a log that takes one line.
  if (x instanceof Error) return x.message || String(x);
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

export function tokenLabel(item, { publicOnly = false } = {}) {
  // Stat Bubbles' name tag first, then Owlbear's own label, then the item name.
  // publicOnly (a creature on a player's screen): only a name the players see on the map. No
  // item name (it is the DM's image or asset name), and no name tag Stat Bubbles shows only to
  // the GM (its "hide").
  const meta = item?.metadata || {};
  const gmOnly = publicOnly && meta["com.owlbear-rodeo-bubbles-extension/metadata"]?.hide === true;
  const tag = gmOnly ? "" : meta["com.owlbear-rodeo-bubbles-extension/name"];
  return String(tag || "").trim() || String(item?.text?.plainText || "").trim() || (publicOnly ? "" : String(item?.name || ""));
}

// ---- the area ----

export function templateArea(t, grid, casterFp = null) {
  // The area a Template covers, in scene px:
  //   {kind: "circle", cx, cy, r}           sphere, cylinder
  //   {kind: "poly", pts}                   cube, square, cone, line (convex)
  //   {kind: "around", rect, r, metric}     emanation: within r of the caster's space
  // Each carries origin (what "nearest first" measures from), cell (px) and shape.
  if (!t || !t.origin) return null;
  const g = gridInfo(grid || t);
  const shape = String(t.shape || "").toLowerCase();
  const o = { x: +t.origin.x || 0, y: +t.origin.y || 0 };
  const size = Math.max(0, +t.size_ft || 0) * g.pxPerFt;
  const a = (+t.rot || 0) * DEG;
  const d = { x: Math.cos(a), y: Math.sin(a) }, n = { x: -Math.sin(a), y: Math.cos(a) };
  const at = (u, v) => ({ x: o.x + d.x * u + n.x * v, y: o.y + d.y * u + n.y * v });
  const base = { shape, origin: o, cell: g.cell };
  switch (shape) {
    case "sphere":
    case "cylinder":
      return { ...base, kind: "circle", cx: o.x, cy: o.y, r: size };
    case "cube":
    case "square": {
      const h = size / 2;
      return { ...base, kind: "poly", pts: [at(-h, -h), at(h, -h), at(h, h), at(-h, h)] };
    }
    case "cone": {
      const half = size * Math.tan(CONE_HALF);
      return { ...base, kind: "poly", pts: [at(0, 0), at(size, -half), at(size, half)] };
    }
    case "line": {
      const w = Math.max(0, +(t.width_ft ?? 5) || 5) * g.pxPerFt / 2;
      return { ...base, kind: "poly", pts: [at(0, -w), at(size, -w), at(size, w), at(0, w)] };
    }
    case "emanation": {
      // No caster on the map: a Medium creature standing on the origin.
      const rect = casterFp || box(o.x, o.y, g.cell, g.cell);
      return { ...base, kind: "around", rect, r: size, metric: g.measurement, origin: { x: rect.cx, y: rect.cy } };
    }
    default:
      return null;
  }
}

function project(pts, ax) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const v = p.x * ax.x + p.y * ax.y;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function rectPts(r) {
  return [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
}

function gapOf(a, b) {
  // How far apart two boxes are along x and along y (0 when they meet or overlap).
  return {
    x: Math.max(0, b.minX - a.maxX, a.minX - b.maxX),
    y: Math.max(0, b.minY - a.maxY, a.minY - b.maxY),
  };
}

function stepsOf(a, b, cell) {
  // Squares counted from one space to another along x and y, the way the ruler counts:
  // none along an axis where the two overlap, else the gap plus the target's own square.
  const g = gapOf(a, b);
  const inX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > TINY;
  const inY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > TINY;
  return { x: inX ? 0 : g.x / cell + 1, y: inY ? 0 : g.y / cell + 1, both: inX && inY };
}

// Measurement rules that count squares (Manhattan, 5-10-5) rather than measure distance.
const COUNTED = new Set(["MANHATTAN", "ALTERNATING"]);

export function overlaps(area, r, full = r) {
  // Does the area overlap the box r (a space already shrunk by epsilon) by more than a
  // hair? Touching doesn't count. `full` is the unshrunk space, for emanations that count squares.
  if (!area || !r) return false;
  if (area.kind === "circle") {
    const nx = Math.max(r.minX, Math.min(area.cx, r.maxX)), ny = Math.max(r.minY, Math.min(area.cy, r.maxY));
    const dx = area.cx - nx, dy = area.cy - ny;
    return dx * dx + dy * dy < area.r * area.r - TINY;
  }
  if (area.kind === "poly") {
    // Separating axes: the box's two axes and every edge normal of the polygon.
    const box4 = rectPts(r), pts = area.pts;
    const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len > TINY) axes.push({ x: -(q.y - p.y) / len, y: (q.x - p.x) / len });
    }
    for (const ax of axes) {
      const [a0, a1] = project(pts, ax), [b0, b1] = project(box4, ax);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= TINY) return false;
    }
    return true;
  }
  if (area.kind === "around") return aroundCatches(area, r, full);
  return false;
}

function aroundCatches(area, shrunk, full) {
  // An emanation reaches a space when the space lies within r of the caster's space. The
  // chessboard and Euclidean rules measure the gap itself (with the shrunk space); the rules
  // that count squares count them to the target's own square, like the ruler does.
  const cells = area.r / area.cell;
  if (COUNTED.has(area.metric)) {
    const s = stepsOf(area.rect, full, area.cell);
    return s.both || metricCells(s.x, s.y, area.metric) <= cells + 1e-6;
  }
  const gap = gapOf(area.rect, shrunk);
  return metricCells(gap.x / area.cell, gap.y / area.cell, area.metric) < cells - TINY / area.cell;
}

export function excludesCaster(t) {
  // The caster is never caught by its own emanation, cone, line or self-cube (Thunderwave);
  // a point sphere or cube can include the caster.
  const shape = String(t?.shape || "").toLowerCase();
  if (shape === "emanation" || shape === "cone" || shape === "line") return true;
  return (shape === "cube" || shape === "square") && t?.from === "self";
}

export function caught(area, tokens, { casterId = null, excludeCaster = false, eps } = {}) {
  // The token records the area catches (any part of their space, shrunk by eps px).
  if (!area) return [];
  const e = eps ?? (area.cell || 150) * EPS_CELLS;
  return (tokens || []).filter((t) => t?.fp && !(excludeCaster && t.id === casterId) && overlaps(area, shrink(t.fp, e), t.fp));
}

const dist = (fp, o) => Math.hypot(fp.cx - o.x, fp.cy - o.y);

export function caughtBy(template, tokens, grid, { includeSecret = false, casterId, casterFp } = {}) {
  // computeCaught for token records the caller already has (the aim tool's preview).
  // casterFp overrides the caster's space (a stand-in when the caster isn't on the map).
  if (!template?.origin) return [];
  const g = gridInfo(grid || template);
  const cid = casterId ?? template.caster_token ?? null;
  const cfp = casterFp ?? (cid ? (tokens || []).find((t) => t.id === cid)?.fp ?? null : null);
  const area = templateArea(template, g, cfp);
  if (!area) return [];
  const hit = caught(area, tokens, { casterId: cid, excludeCaster: excludesCaster(template), eps: g.cell * EPS_CELLS });
  return hit
    .filter((t) => includeSecret || !t.secret)
    .sort((a, b) => dist(a.fp, area.origin) - dist(b.fp, area.origin) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({ id: t.id, secret: !!t.secret }));
}

export function computeCaught(template, items, grid, { includeSecret = false, isPublic = null, casterId, pcTokens = null, bounds = null } = {}) {
  // Who a template catches, nearest its origin first: [{id, secret}]. A PLAYER screen asks
  // without includeSecret and never hears of a hidden monster; the bridge (and the DM's
  // own preview) asks with it, so the rolls stay fair.
  if (!template?.origin) return [];
  const g = gridInfo(grid || template);
  return caughtBy(template, tokensOf(items, g, { bounds, isPublic, pcTokens }), g, { includeSecret, casterId });
}

// ---- placing a template under the pointer ----

export function snapCorner(p, grid) {
  // The nearest grid intersection.
  const g = gridInfo(grid);
  return {
    x: Math.round((p.x - g.origin.x) / g.cell) * g.cell + g.origin.x,
    y: Math.round((p.y - g.origin.y) / g.cell) * g.cell + g.origin.y,
  };
}

const snapLine = (v, g, o) => Math.round((v - o) / g.cell) * g.cell + o;

export function snapCentre(p, sidePx, grid) {
  // A square's centre such that its edges sit on grid lines: an even number of cells puts
  // the centre on an intersection, an odd number in the middle of a cell.
  const g = gridInfo(grid);
  return {
    x: snapLine(p.x - sidePx / 2, g, g.origin.x) + sidePx / 2,
    y: snapLine(p.y - sidePx / 2, g, g.origin.y) + sidePx / 2,
  };
}

export function edgePoint(fp, angleDeg) {
  // Where a ray from the centre of a space leaves it: a cone's apex, a line's start.
  const a = angleDeg * DEG, dx = Math.cos(a), dy = Math.sin(a);
  let t = Infinity;
  if (Math.abs(dx) > 1e-12) t = Math.min(t, fp.w / 2 / Math.abs(dx));
  if (Math.abs(dy) > 1e-12) t = Math.min(t, fp.h / 2 / Math.abs(dy));
  if (!isFinite(t)) t = 0;
  return { x: fp.cx + dx * t, y: fp.cy + dy * t };
}

export function besideCube(fp, pointer, sidePx, grid, snap = true) {
  // A self-cube (Thunderwave) touching the caster on the side, or corner, facing the
  // pointer: 8 directions, kept on the grid.
  const g = gridInfo(grid);
  const oct = Math.round(Math.atan2(pointer.y - fp.cy, pointer.x - fp.cx) / (Math.PI / 4));
  const sx = Math.round(Math.cos(oct * Math.PI / 4)), sy = Math.round(Math.sin(oct * Math.PI / 4));
  let minX = sx > 0 ? fp.maxX : sx < 0 ? fp.minX - sidePx : fp.cx - sidePx / 2;
  let minY = sy > 0 ? fp.maxY : sy < 0 ? fp.minY - sidePx : fp.cy - sidePx / 2;
  if (snap && sx === 0) minX = snapLine(minX, g, g.origin.x);
  if (snap && sy === 0) minY = snapLine(minY, g, g.origin.y);
  return { x: minX + sidePx / 2, y: minY + sidePx / 2 };
}

export function isSelf(area) {
  const shape = String(area?.shape || "").toLowerCase();
  if (area?.from) return area.from === "self";
  return shape === "emanation" || shape === "cone" || shape === "line";
}

export function canRotate(spec) {
  // Only a point cube or square turns with [ ] and the HUD's buttons; cones and lines
  // point from the caster to the pointer instead.
  const area = spec?.area ?? spec;
  const shape = String(area?.shape || "").toLowerCase();
  return (shape === "cube" || shape === "square") && !isSelf(area);
}

export function rotateBy(rot, dir, { shift = false } = {}) {
  // One step of [ or ]: 15 degrees, 45 with Shift, landing on a whole step.
  const step = shift ? 45 : 15;
  return normDeg(Math.round(((+rot || 0) + Math.sign(dir || 1) * step) / step) * step);
}

export function snap(spec, pointer, casterFp, grid, { free = false, step45 = false, rot = 0 } = {}) {
  // The Template for an AimSpec (or a bare area) with the pointer at `pointer`.
  //   sphere, cylinder        origin on the nearest grid intersection (Alt: free)
  //   cube, square (point)    centred on the pointer, edges on grid lines; turned by rot
  //   cube (self)             beside the caster, on the side facing the pointer, 8 ways
  //   cone, line (self)       from the caster's edge toward the pointer (Shift: 45-degree steps)
  //   emanation               the caster's centre
  // A self shape with no caster on the map is placed like a point shape; the tool makes a
  // stand-in caster from the first click instead (spec section 10.2).
  const area = spec?.area ?? spec ?? {};
  const g = gridInfo(grid);
  const shape = String(area.shape || "").toLowerCase();
  const size = Math.max(0, +area.size || 0);
  const from = area.from || (shape === "emanation" || shape === "cone" || shape === "line" ? "self" : "point");
  const p = { x: +pointer?.x || 0, y: +pointer?.y || 0 };
  const grid0 = !free && g.square;
  const side = size * g.pxPerFt;
  let origin = p, r = 0;
  if (shape === "emanation") {
    origin = casterFp ? { x: casterFp.cx, y: casterFp.cy } : grid0 ? snapCentre(p, g.cell, g) : p;
  } else if ((shape === "cone" || shape === "line") && casterFp) {
    const dx = p.x - casterFp.cx, dy = p.y - casterFp.cy;
    let ang = dx * dx + dy * dy > TINY ? Math.atan2(dy, dx) / DEG : +rot || 0;
    if (step45) ang = Math.round(ang / 45) * 45;
    r = normDeg(ang);
    origin = edgePoint(casterFp, r);
  } else if ((shape === "cube" || shape === "square") && from === "self" && casterFp) {
    origin = besideCube(casterFp, p, side, g, g.square);
  } else if (shape === "cube" || shape === "square") {
    origin = grid0 ? snapCentre(p, side, g) : p;
    r = normDeg(rot);
  } else {
    origin = grid0 ? snapCorner(p, g) : p;
    if (shape === "cone" || shape === "line") r = normDeg(rot);
  }
  return {
    shape, origin: { x: r2(origin.x), y: r2(origin.y) }, rot: Math.round(r * 1000) / 1000,
    size_ft: size, width_ft: shape === "line" ? Math.max(1, +area.width || 5) : null, from,
    caster_token: spec?.caster_token ?? null, dpi: g.dpi, ft_per_cell: g.ftPerCell,
  };
}

// ---- range and picking ----

export function nearestFeet(fromFp, target, grid) {
  // Feet from a caster's space to a point (a template's origin: the gap to it) or to another
  // space (squares counted to the target's own square, so a creature next to you is 5 ft away,
  // as on the ruler), by the grid's measurement rule, rounded to 5 ft.
  if (!fromFp || !target) return null;
  const g = gridInfo(grid);
  let cells;
  if (Number.isFinite(target.minX)) {
    const s = stepsOf(fromFp, target, g.cell);
    cells = s.both ? 0 : metricCells(s.x, s.y, g.measurement);
  } else {
    const gap = gapOf(fromFp, { minX: target.x, maxX: target.x, minY: target.y, maxY: target.y });
    cells = metricCells(gap.x / g.cell, gap.y / g.cell, g.measurement);
  }
  return Math.round((cells * g.ftPerCell) / 5 + 1e-9) * 5;
}

export function inRange(feet, rangeFt, longFt = null) {
  // {ok, long, far}: long = past normal range but inside long range (disadvantage).
  // No range (self, or unknown) is always fine.
  if (feet == null || !(rangeFt > 0)) return { ok: true, long: false, far: false };
  if (feet <= rangeFt) return { ok: true, long: false, far: false };
  if (longFt > rangeFt && feet <= longFt) return { ok: true, long: true, far: false };
  return { ok: false, long: false, far: true };
}

export function pickAt(point, tokens, grid) {
  // The token under a tap: one whose space holds the point (the nearest centre if several
  // do), else the nearest within half a cell. Picks by geometry, never by Owlbear's own hit
  // target, so a player can pick a hidden PC (their screen doesn't draw it).
  const g = gridInfo(grid);
  let best = null, bestScore = Infinity;
  for (const t of tokens || []) {
    if (!t?.fp) continue;
    const gap = gapOf(t.fp, { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y });
    const out = Math.hypot(gap.x, gap.y);
    if (out > g.cell / 2 + TINY) continue;
    const score = out > TINY ? 1e9 + out : dist(t.fp, point);
    if (score < bestScore) {
      bestScore = score;
      best = t.id;
    }
  }
  return best;
}

export function chips(casterFp, tokens, grid, rangeFt, { longFt = null, casterId = null, includeSelf = false, max = 8 } = {}) {
  // The pick list: tokens in range (long range included), nearest first: [{id, feet, long, label}].
  // With no caster on the map there's no distance: everyone handed in, by name (a player's
  // screen hands in only what that player can see: aim/tool.js).
  const reach = longFt > rangeFt ? longFt : rangeFt;
  const list = [];
  for (const t of tokens || []) {
    if (!t?.fp) continue;
    const self = casterId != null && t.id === casterId;
    if (self && !includeSelf) continue;
    const feet = self ? 0 : casterFp ? nearestFeet(casterFp, t.fp, grid) : null;
    if (feet != null && reach > 0 && feet > reach) continue;
    list.push({ id: t.id, feet, long: feet != null && rangeFt > 0 && feet > rangeFt, label: t.label || "" });
  }
  list.sort((a, b) => (a.feet ?? 0) - (b.feet ?? 0) || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
  return list.slice(0, max);
}

// ---- words and outlines for the preview ----

export function areaText(area) {
  // "20-ft-radius sphere", "15-ft cone", "100-ft line, 5 ft wide" (as spell_library.area_text says it)
  if (!area) return "";
  const shape = String(area.shape || "").toLowerCase();
  const size = area.size ?? area.size_ft;
  if (shape === "sphere" || shape === "cylinder") return `${size}-ft-radius ${shape}`;
  if (shape === "line") return `${size}-ft line, ${area.width ?? area.width_ft ?? 5} ft wide`;
  return `${size}-ft ${shape}`;
}

export function outline(area, steps = 8) {
  // The area's outline as points (circles and rounded corners as short straight pieces):
  // the emanation's path, the label's place, and the checks.
  if (!area) return [];
  if (area.kind === "poly") return area.pts.map((p) => ({ ...p }));
  if (area.kind === "circle") {
    const n = steps * 4;
    return Array.from({ length: n }, (_, i) => ({
      x: area.cx + area.r * Math.cos((2 * Math.PI * i) / n),
      y: area.cy + area.r * Math.sin((2 * Math.PI * i) / n),
    }));
  }
  if (area.kind === "around") {
    // The caster's space grown by r, its corners shaped by the measurement rule: square
    // (chessboard), cut at 45 degrees (Manhattan), cut twice (5-10-5) or round (Euclidean).
    const { rect: q, r, metric } = area;
    const corner = (cx, cy, sx, sy) => {
      if (metric === "CHEBYSHEV") return [{ x: cx + sx * r, y: cy + sy * r }];
      if (metric === "MANHATTAN") return [{ x: cx + sx * r, y: cy }, { x: cx, y: cy + sy * r }];
      if (metric === "ALTERNATING") {
        const k = (2 * r) / 3;
        return [{ x: cx + sx * r, y: cy }, { x: cx + sx * k, y: cy + sy * k }, { x: cx, y: cy + sy * r }];
      }
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const a = (Math.PI / 2) * (i / steps);
        pts.push({ x: cx + sx * r * Math.cos(a), y: cy + sy * r * Math.sin(a) });
      }
      return pts;
    };
    // Clockwise from the top right corner; each corner's piece goes the right way round.
    const tr = corner(q.maxX, q.minY, 1, -1).reverse(), br = corner(q.maxX, q.maxY, 1, 1);
    const bl = corner(q.minX, q.maxY, -1, 1).reverse(), tl = corner(q.minX, q.minY, -1, -1);
    return [...tr, ...br, ...bl, ...tl];
  }
  return [];
}

export function bounds(area) {
  // The area's axis-aligned box.
  const pts = area?.kind === "circle"
    ? [{ x: area.cx - area.r, y: area.cy - area.r }, { x: area.cx + area.r, y: area.cy + area.r }]
    : outline(area);
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
