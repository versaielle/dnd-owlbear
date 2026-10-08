// Darkness comes from light (docs/lights-darkness-spec.md): where on the map it's ☀ lit, 🌒 dim or
// 🌑 dark, and the lights that anyone could see by. Pure: no Owlbear import, so the offline
// checks and the bench load it too.
//
// A POINT's darkness: the topmost MAP-layer image that carries MAP_DARKNESS_KEY and contains it,
// else the scene's SCENE_LIGHTING_KEY.darkness, else "lit" (unmarked = lit; the DM marks caves
// and cellars 🌑). Interiors often share one scene with a town map, so a map can differ.
//
//   mapRect(item, grid)              a map image's rectangle in scene pixels {x0, y0, x1, y1}
//   darkRegions(items, scene, grid)  {scene: code, rects: [{id, x0, y0, x1, y1, code, z}]} (bottom first)
//   regionAt(point, regions)         the code at a point, from darkRegions()
//   darknessAt(point, items, scene, grid)  the same in one call
//   farLight(token, lights, pxPerFt) the farthest a token could see a light: max(distance + reach), feet
//   darknessCtx(items, scene, {isPc, grid})  what fx/lightmeta.js visionOf/smokeFor read from a
//                                    ctx: {regions, lights (the public ones: [{id, x, y, reach}],
//                                    scene px and feet), pxPerFt}
// `grid`: {dpi, ftPerCell} (or a dpi number); missing = Owlbear's default 150 dpi, 5 ft.

import { CARRIER_KEY, MAP_DARKNESS_KEY, SCENE_LIGHTING_KEY, SMOKE } from "../keys.js?v=585985a-dc1dbb6";
import * as LM from "./lightmeta.js?v=585985a-dc1dbb6";
import { finite, footprint, gridOf } from "./place.js?v=585985a-dc1dbb6";

export const CODES = ["lit", "dim", "dark"];
export const codeOf = (v) => (CODES.includes(v) ? v : null);
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const metaOf = (x) => (isObj(x?.metadata) ? x.metadata : isObj(x) ? x : {});

// {dpi, ftPerCell, pxPerFt} from a grid object, a dpi number, or nothing (150 dpi, 5 ft).
export function gridFrom(grid) {
  if (typeof grid === "number") return gridOf(grid, 5);
  return gridOf(grid?.dpi, grid?.ftPerCell ?? grid?.multiplier);
}

// The scene's own darkness (SCENE_LIGHTING_KEY.darkness), "lit" when unmarked. `scene`: its
// metadata, or an object holding it.
export function sceneDarkness(scene) {
  return codeOf(metaOf(scene)[SCENE_LIGHTING_KEY]?.darkness) ?? "lit";
}

// A map's own darkness (MAP_DARKNESS_KEY), or null (as the scene).
export const mapDarkness = (item) => codeOf(item?.metadata?.[MAP_DARKNESS_KEY]);

export const isMap = (item) => item?.layer === "MAP" && (item.type === undefined || item.type === "IMAGE");

// A MAP-layer image's rectangle in scene pixels: its image's size over its own grid dpi, times
// the scene's dpi and its scale, placed by its grid offset (the point at `position`) and turned
// (a turn that isn't a multiple of 90 degrees: the turned rectangle's bounding box). null when
// it isn't an image with grid settings.
export function mapRect(item, grid) {
  const fp = footprint(item, gridFrom(grid).dpi);
  if (!fp) return null;
  return { x0: fp.x - fp.w / 2, y0: fp.y - fp.h / 2, x1: fp.x + fp.w / 2, y1: fp.y + fp.h / 2 };
}

const inRect = (p, r) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;

// Every marked map (bottom first: by zIndex, then by the scene's order) and the scene's default.
export function darkRegions(items, scene, grid) {
  const rects = [];
  (Array.isArray(items) ? items : []).forEach((i, n) => {
    if (!isMap(i)) return;
    const code = mapDarkness(i);
    if (!code) return;
    const r = mapRect(i, grid);
    if (!r) return;
    rects.push({ id: i.id, ...r, code, z: finite(i.zIndex) ? i.zIndex : 0, n });
  });
  rects.sort((a, b) => a.z - b.z || a.n - b.n);
  return { scene: sceneDarkness(scene), rects: rects.map(({ n, ...r }) => r) };
}

// The darkness at a scene point, from darkRegions(): the topmost marked map there, else the scene's.
export function regionAt(point, regions) {
  const rects = regions?.rects || [];
  if (point && finite(point.x, point.y)) {
    for (let k = rects.length - 1; k >= 0; k--) if (inRect(point, rects[k])) return rects[k].code;
  }
  return codeOf(regions?.scene) ?? "lit";
}

export const darknessAt = (point, items, scene, grid) => regionAt(point, darkRegions(items, scene, grid));

// Every map's rectangle (the box a dark scene's overlay covers), or null when there's none.
export function mapsExtent(items, grid) {
  let e = null;
  for (const i of Array.isArray(items) ? items : []) {
    if (!isMap(i)) continue;
    const r = mapRect(i, grid);
    if (!r) continue;
    e = e ? { x0: Math.min(e.x0, r.x0), y0: Math.min(e.y0, r.y0), x1: Math.max(e.x1, r.x1), y1: Math.max(e.y1, r.y1) } : { ...r };
  }
  return e;
}

// How far (feet) a token could see a light from where it stands: the farthest light's far edge,
// max over lights of (distance + reach). 0 with no light. lights: [{x, y, reach}] (px, feet).
export function farLight(token, lights, pxPerFt = gridFrom().pxPerFt) {
  const p = token?.position;
  if (!p || !finite(p.x, p.y) || !(pxPerFt > 0)) return 0;
  let far = 0;
  for (const l of Array.isArray(lights) ? lights : []) {
    if (!l || !finite(l.x, l.y) || !(l.reach > 0)) continue;
    far = Math.max(far, Math.hypot(l.x - p.x, l.y - p.y) / pxPerFt + l.reach);
  }
  return Math.ceil(far);
}

// ---- the DM's ambient light ----

// A hidden non-CHARACTER item that is a Smoke torch we never wrote: the DM's own invisible light
// (fx/lightmeta.js isAmbientLight; ctx {lighting, byId, isPc, isSecret}). Its Smoke keys are the
// DM's; it lights the darkness within its Smoke range on every screen, no flame on a player's.
export const isAmbientLight = (item, ctx = {}) => {
  try { return !!LM.isAmbientLight(item, ctx); } catch { return false; }
};
// Its reach (feet): its light as fx/lightmeta.js effectiveLight gives it (its Smoke range).
export function ambientReach(item, lighting) {
  const l = LM.effectiveLight(item, lighting);
  if (l && l.reach > 0) return l.reach;
  const n = parseInt(String(item?.metadata?.[`${SMOKE}/visionRange`] ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---- the ctx planCtx gives visionOf / smokeFor ----

// The PUBLIC lights (R1: not secret; a carrier child never: its NPC's own light counts) and the
// DM's ambient lights, in scene px with reach in feet; the darkness regions; the grid.
// opts: {isPc(item), grid, lighting (SCENE_LIGHTING_KEY's value; else read off the scene)}.
export function darknessCtx(items, scene, opts = {}) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i?.id != null);
  const G = gridFrom(opts.grid);
  const byId = new Map(list.map((i) => [i.id, i]));
  const isPc = (i) => { try { return !!opts.isPc?.(i); } catch { return false; } };
  const lighting = opts.lighting ?? metaOf(scene)[SCENE_LIGHTING_KEY];
  const lights = [];
  const secret = (i) => LM.isSecret(i, { parentOf: (id) => byId.get(id), isPc: (id) => { const x = byId.get(id); return x ? isPc(x) : false; } });
  // Each light as it is once the DM's Smoke edits are adopted (what any writer's planItem makes of
  // it first), so a writer's pass never changes the lights a seer's range was planned from: one
  // pass, and the next plans nothing.
  const actx = { isPc, lighting, rangeDefault: LM.rangeDefaultOf(metaOf(scene)) };
  const adopted = (i) => {
    try {
      const m = LM.adoptEdits(i, actx);
      return m ? { ...i, metadata: m } : i;
    } catch { return i; }
  };
  for (const i0 of list) {
    const i = adopted(i0);
    if (i.metadata?.[CARRIER_KEY] || !finite(i.position?.x, i.position?.y)) continue;
    if (isAmbientLight(i, { lighting, byId, isPc, isSecret: secret })) {
      const reach = ambientReach(i, lighting);
      if (reach) lights.push({ id: i.id, x: i.position.x, y: i.position.y, reach });
      continue;
    }
    const l = LM.effectiveLight(i, lighting);
    if (!l || !(l.reach > 0)) continue;
    if (secret(i)) continue;
    lights.push({ id: i.id, x: i.position.x, y: i.position.y, reach: l.reach });
  }
  return { regions: darkRegions(list, scene, G), lights, pxPerFt: G.pxPerFt };
}

// The grid as darknessCtx wants it, read from Owlbear: {dpi, ftPerCell}.
export async function readGrid(OBR) {
  let dpi = 150, ft = 5;
  try { dpi = await OBR.scene.grid.getDpi(); } catch { /* default */ }
  try { ft = (await OBR.scene.grid.getScale())?.parsed?.multiplier ?? 5; } catch { /* default */ }
  return gridOf(dpi, ft);
}
