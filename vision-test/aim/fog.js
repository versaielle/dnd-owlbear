// What the fog hides on this screen: is a point on the map under the scene's fog? Pure maths
// over the FOG layer's drawings (no Owlbear SDK), so check_aim.mjs tests it offline. The aim
// tool asks it on a PLAYER's screen, so its HUD never names, lists or counts a creature the
// player can't see: R1 keeps hidden tokens out, this keeps out visible ones under the fog.
//
//   fogShapes(items)        -> the drawings that make fog: visible SHAPE, CURVE and PATH items on
//                              the FOG layer (a hidden one, the GM's H, reveals what it covered;
//                              walls and lights live on that layer too but cover nothing)
//   underFog(point, shapes) -> true when any of them covers the point
//
// Owlbear's static fog: each fog drawing covers the map under it; a hole cut out of one (the
// inner loop of a Path, by its fill rule) shows the map again. With the fog's "fill" on, the
// whole map is fog and what shows through is Owlbear's dynamic fog (lights and walls) or an
// extension's (Smoke & Spectre): this file can't tell what a player sees then, and the caller
// treats every creature as unseen-or-not-sure (see tool.js).
//
// Every doubt leans to "covered": a shape whose outline isn't known (a triangle, say) covers
// its whole box, a curved Path edge is flattened, a scale of 0 covers nothing.

const MOVE = 0, LINE = 1, QUAD = 2, CONIC = 3, CUBIC = 4, CLOSE = 5; // Path commands
const AREA_TYPES = new Set(["SHAPE", "CURVE", "PATH"]);
const STEPS = 8; // pieces per curved Path segment
const DEG = Math.PI / 180;

const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function fogShapes(items) {
  return (items || []).filter((i) => i && i.layer === "FOG" && i.visible !== false && AREA_TYPES.has(i.type));
}

export function underFog(point, shapes) {
  if (!point) return false;
  for (const item of shapes || []) {
    try {
      if (covers(item, point)) return true;
    } catch {
      // a drawing we can't read covers nothing
    }
  }
  return false;
}

export function toLocal(item, p) {
  // A point on the map in the drawing's own coordinates: Owlbear places a drawing by its
  // position, then its rotation, then its scale.
  const sx = num(item.scale?.x, 1), sy = num(item.scale?.y, 1);
  if (!sx || !sy) return null;
  const dx = p.x - num(item.position?.x), dy = p.y - num(item.position?.y);
  const a = -num(item.rotation) * DEG, c = Math.cos(a), s = Math.sin(a);
  return { x: (dx * c - dy * s) / sx, y: (dx * s + dy * c) / sy };
}

export function covers(item, point) {
  const p = toLocal(item, point);
  if (!p) return false;
  if (item.type === "SHAPE") return shapeCovers(item, p);
  if (item.type === "CURVE") return winding([item.points || []], p, "evenodd");
  if (item.type === "PATH") return winding(loops(item.commands || []), p, item.fillRule === "evenodd" ? "evenodd" : "nonzero");
  return false;
}

function shapeCovers(item, p) {
  const w = Math.abs(num(item.width)), h = Math.abs(num(item.height));
  if (!(w > 0 && h > 0)) return false;
  switch (item.shapeType) {
    case "RECTANGLE": // position = the top-left corner
      return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
    case "CIRCLE": { // position = the centre, width = the diameter
      const rx = w / 2, ry = h / 2;
      return (p.x * p.x) / (rx * rx) + (p.y * p.y) / (ry * ry) <= 1;
    }
    case "HEXAGON": { // centred on the position (as areas.js, confirmed live 2026-10-02)
      const pts = [];
      for (let k = 0; k < 6; k++) pts.push({ x: (w / 2) * Math.cos((Math.PI / 3) * k), y: (h / 2) * Math.sin((Math.PI / 3) * k) });
      return winding([pts], p, "evenodd");
    }
    default:
      // A triangle (its outline failed the live test) or a shape we don't know: the box
      // around every way it could be anchored (top-left corner, apex or centre).
      return p.x >= -w / 2 && p.x <= w && p.y >= -h / 2 && p.y <= h;
  }
}

function loops(commands) {
  // A Path's closed loops as point lists (curves flattened). Every MOVE starts a new loop; an
  // open loop is closed back to its start, as a fill is.
  const out = [];
  let cur = null, at = { x: 0, y: 0 };
  const add = (x, y) => {
    if (!cur) {
      cur = [{ x: at.x, y: at.y }];
      out.push(cur);
    }
    cur.push({ x, y });
    at = { x, y };
  };
  for (const c of commands) {
    if (!Array.isArray(c)) continue;
    const k = c[0];
    if (k === MOVE) {
      cur = [{ x: num(c[1]), y: num(c[2]) }];
      out.push(cur);
      at = { x: num(c[1]), y: num(c[2]) };
    } else if (k === LINE) add(num(c[1]), num(c[2]));
    else if (k === QUAD || k === CONIC) {
      const p0 = at, c1 = { x: num(c[1]), y: num(c[2]) }, p1 = { x: num(c[3]), y: num(c[4]) };
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        add(u * u * p0.x + 2 * u * t * c1.x + t * t * p1.x, u * u * p0.y + 2 * u * t * c1.y + t * t * p1.y);
      }
    } else if (k === CUBIC) {
      const p0 = at, c1 = { x: num(c[1]), y: num(c[2]) }, c2 = { x: num(c[3]), y: num(c[4]) }, p1 = { x: num(c[5]), y: num(c[6]) };
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        add(u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
          u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y);
      }
    } else if (k === CLOSE) {
      if (cur?.length) at = { ...cur[0] };
      cur = null;
    }
  }
  return out.filter((l) => l.length >= 3);
}

function winding(polys, p, rule) {
  // Inside by the fill rule over every loop: "nonzero" (the winding numbers add up to anything
  // but 0) or "evenodd" (an odd number of crossings). A point on an edge counts as inside.
  let wn = 0, crossings = 0;
  for (const pts of polys) {
    const n = pts.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = pts[j], b = pts[i];
      if (onSegment(a, b, p)) return true;
      if ((a.y > p.y) !== (b.y > p.y)) {
        const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x > p.x) {
          crossings++;
          wn += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return rule === "evenodd" ? crossings % 2 === 1 : wn !== 0;
}

function onSegment(a, b, p) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  if (Math.abs(cross) / len > 1e-6) return false;
  return p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6
    && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
}
