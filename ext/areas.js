// Which drawn rooms contain a point on the map. Used by the extension's
// background script, and checked offline by check_areas.mjs.
//
// Every drawing has its own position/rotation/scale, so the point is first
// moved into the drawing's own coordinates, then tested against its outline:
//   SHAPE RECTANGLE  position = top-left corner, width x height
//   SHAPE CIRCLE     position = centre, width/height = diameter
//   SHAPE HEXAGON    centred on position (confirmed live 2026-10-02)
//   SHAPE TRIANGLE   not a room: its outline is unknown (failed the live test)
//   CURVE            the polygon tool and the brush: a list of points
//   PATH             a drawing converted to a path: commands, flattened to points
import { Math2, MathM } from "./obr-sdk.js?v=23059e2";

const MOVE = 0, LINE = 1, QUAD = 2, CONIC = 3, CUBIC = 4, CLOSE = 5;

export function toLocal(item, point) {
  const inv = MathM.inverse(MathM.fromItem(item));
  return MathM.decompose(MathM.multiply(inv, MathM.fromPosition(point))).position;
}

// The outline in the drawing's own coordinates, or null when there's no area.
export function outline(item) {
  if (item.type === "CURVE") return item.points;
  if (item.type === "PATH") return pathPoints(item.commands);
  if (item.type !== "SHAPE") return null;
  const w = item.width, h = item.height;
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
    default:
      return null; // CIRCLE is tested directly
  }
}

function pathPoints(commands) {
  // Keep the end point of every segment (and curve control points, which is
  // close enough for a room outline). Only the first closed loop counts.
  const pts = [];
  for (const c of commands) {
    if (c[0] === MOVE && pts.length) break;
    if (c[0] === MOVE || c[0] === LINE) pts.push({ x: c[1], y: c[2] });
    else if (c[0] === QUAD || c[0] === CONIC) pts.push({ x: c[1], y: c[2] }, { x: c[3], y: c[4] });
    else if (c[0] === CUBIC) pts.push({ x: c[1], y: c[2] }, { x: c[3], y: c[4] }, { x: c[5], y: c[6] });
    else if (c[0] === CLOSE) break;
  }
  return pts;
}

export function contains(item, point) {
  const p = toLocal(item, point);
  if (item.type === "SHAPE" && item.shapeType === "CIRCLE") {
    const rx = item.width / 2, ry = item.height / 2;
    return (p.x * p.x) / (rx * rx) + (p.y * p.y) / (ry * ry) <= 1;
  }
  const pts = outline(item);
  return pts && pts.length >= 3 ? Math2.pointInPolygon(p, pts) : false;
}

// A drawing that can be marked as a room: not a line, text or triangle.
export function isRoom(item) {
  if (item.layer !== "DRAWING") return false;
  if (item.type === "SHAPE") return item.shapeType !== "TRIANGLE";
  return item.type === "CURVE" || item.type === "PATH";
}

// Rough size on the map, so the smallest room wins when one is inside another.
export function size(item) {
  const sx = Math.abs(item.scale?.x ?? 1), sy = Math.abs(item.scale?.y ?? 1);
  if (item.type === "SHAPE" && item.shapeType === "CIRCLE") {
    return Math.PI * (item.width / 2) * (item.height / 2) * sx * sy;
  }
  const pts = outline(item) || [];
  let twice = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    twice += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return (Math.abs(twice) / 2) * sx * sy;
}
