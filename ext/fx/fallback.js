// The generic shape fallback: plain Owlbear shapes instead of shaders, for style "shape" (the
// panel's switch when shaders misbehave on some screen) and for any part whose shader item
// couldn't be built. One small set for every archetype (spec 11.7):
//   travel (bolt, ray, arrow)       a small dot flying from caster to target, fading after the hit
//   area (burst, cone, line, cube)  the area's own outline, flashing at 0.35 and fading
//   on a token (impact, glow, ...)  a ring pulsing out from 0.8 to 1.3 of the token and fading
//   death                           the same ring, in red
//   number                          unchanged (numbers.js); flash and shake are skipped
// Every shape is a local item on the ATTACHMENT layer, locked and click-through.
import { placeRect, rotate } from "./place.js?v=843a06c";

const TRAVEL = ["bolt", "ray", "arrow"];
const AREA = ["burst", "cone", "line", "cube"];
// 0 before a, 1 after b, a straight line between (a step at b when there's no room between:
// a bolt whose hit is 1.0 must not divide 0 by 0, or NaN would go into the batched update).
const ramp = (x, a, b) => (b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : x >= b ? 1 : 0);

// The point of a host rectangle that sits at `anchor` (its own pixels), on the map.
function pointOf(host, ax, ay) {
  const v = rotate({ x: ax, y: ay }, host.rot || 0);
  return { x: host.position.x + v.x, y: host.position.y + v.y };
}

function shape(api, type, w, h, pos, rot, col, extra) {
  return api.buildShape()
    .shapeType(type)
    .width(w)
    .height(h)
    .position(pos)
    .rotation(rot || 0)
    .fillColor(col)
    .fillOpacity(extra.fill ?? 0.35)
    .strokeColor(col)
    .strokeOpacity(extra.stroke ?? 0.9)
    .strokeWidth(extra.width ?? 4)
    .layer("POINTER")
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .zIndex(extra.z ?? 0)
    .name("dnd-npc fx shape")
    .metadata(extra.metadata || {})
    .build();
}

// {item, frame(draft, p)} for one part, or null (flash, shake, or no geometry).
// `host` is the archetype's rectangle from archetypes.hostFor(); `a` the resolved anchors.
export function fallbackItem(api, arch, part, a, host, G, hex, extra = {}) {
  if (arch === "flash" || arch === "shake" || arch === "number") return null;
  const hit = typeof part.hit === "number" && Number.isFinite(part.hit) ? Math.min(1, Math.max(0, part.hit)) : 0.6;
  if (TRAVEL.includes(arch)) {
    if (!host || !a.from || !a.to) return null;
    const H = host.h;
    const from = pointOf(host, H / 2, H / 2);
    const to = pointOf(host, host.w - H / 2, H / 2);
    const d = G.dpi * 0.35;
    const item = shape(api, "CIRCLE", d, d, from, 0, hex, { ...extra, fill: 0.9 });
    return {
      item,
      frame(draft, p) {
        const k = ramp(p, 0, Math.max(hit, 0.05));
        draft.position = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
        const o = 1 - ramp(p, hit, 1);
        draft.style.fillOpacity = 0.9 * o;
        draft.style.strokeOpacity = 0.9 * o;
      },
    };
  }
  if (AREA.includes(arch)) {
    if (!host) return null;
    let item;
    if (arch === "burst") {
      const R = host.w / 2.4;
      item = shape(api, "CIRCLE", 2 * R, 2 * R, pointOf(host, host.w / 2, host.h / 2), 0, hex, extra);
    } else if (arch === "cube") {
      const side = host.w / 1.15;
      const c = pointOf(host, host.w / 2, host.h / 2);
      item = shape(api, "RECTANGLE", side, side, placeRect(side, side, c, host.rot), host.rot, hex, extra);
    } else if (arch === "line") {
      const W = host.h / 2.2;
      const start = pointOf(host, 0, host.h / 2);
      item = shape(api, "RECTANGLE", host.w, W, placeRect(host.w, W, start, host.rot, { x: 0, y: W / 2 }), host.rot, hex, extra);
    } else {
      // a cone: Owlbear's TRIANGLE has its apex at its position, pointing +y
      const L = host.w / 1.05;
      const apex = pointOf(host, 0, host.h / 2);
      item = shape(api, "TRIANGLE", L, L, apex, (host.rot || 0) - 90, hex, extra);
    }
    return {
      item,
      frame(draft, p) {
        const o = (0.6 + 0.4 * Math.cos(p * Math.PI * 4)) * (1 - ramp(p, 0.6, 1));
        draft.style.fillOpacity = 0.35 * o;
        draft.style.strokeOpacity = 0.9 * o;
      },
    };
  }
  // a ring round a token
  const c = a.at;
  if (!c) return null;
  const size = Math.max(c.w || 0, c.h || 0, G.dpi * 0.8);
  const ring = shape(api, "CIRCLE", size, size, { x: c.x, y: c.y }, 0, arch === "death" ? "#ff4d4d" : hex,
                     { ...extra, fill: 0.08, width: Math.max(3, G.dpi / 25) });
  return {
    item: ring,
    frame(draft, p) {
      const s = 0.8 + 0.5 * p;
      draft.scale = { x: s, y: s };
      const o = 1 - ramp(p, 0.4, 1);
      draft.style.fillOpacity = 0.08 * o;
      draft.style.strokeOpacity = 0.95 * o;
    },
  };
}
