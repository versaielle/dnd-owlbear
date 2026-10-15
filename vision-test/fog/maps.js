// Each map image's explored-memory facts for the vision layer (docs/vision-layer-spec.md section 6;
// the builders' contracts are docs/vision-layer-b4.md and, from Phase 1, docs/vision-layer-2024.md):
// its square grid, its building, interior or outdoor, whether its building is remembered, the DM's
// choices (MAP_FOG_KEY), the mode that follows (fog/mode.js fogMode), and its smooth explored memory
// (EXPLORED_KEY). The one place fog/seen.js (the writer), fog/memory.js (the drawing) and the 🔥
// Lighting list's map rows read them from, so all three agree. Pure: no Owlbear import.
//
//   FOG_MODES            "auto" and fog/mode.js MODES: what MAP_FOG_KEY.mode may say (a stored "lit"
//                        still validates; it reads as "dim")
//   MAP_KINDS            "interior" | "outdoor": what MAP_FOG_KEY.kind may say (or null: as painted)
//   normName(s)          a map's name made comparable: no file extension, one kind of dash, one space
//   buildingOf(item)     {name, key} of the map image's building: its name before " - " (all of it
//                        when there's none), key lowercased; null for an unnamed image
//   paintedKind(item)    "interior" when 🏘 Set up interiors laid it out as a building floor (its
//                        MAP_INFO_KEY has an entry or stairs), "outdoor" when it laid it out as the
//                        town (both null), null when it never touched this image
//   mapFogOf(meta)       MAP_FOG_KEY made safe: {mode: FOG_MODES, kind: MAP_KINDS | null}; a stored
//                        "lit" (B4's) reads as "dim" (remembered ground is always dimmed from Phase 1),
//                        nothing rewritten
//   memoryOf(meta)       MEMORY_KEY made safe: {remembered: true | false}
//   mapGrid(rect, dpi)   the squares over a map's rectangle (views.js mapRects): {x0, y0, cell, cols,
//                        rows}, fog/los.js seenCells's grid. cell = the scene grid's dpi (scene px per
//                        square); x0, y0 = the scene grid line at or before the rectangle's top-left,
//                        so the squares are the scene's own (a map snapped to the grid: its painted
//                        squares); cols, rows reach the rectangle's far sides. Moving a map by whole
//                        squares keeps the same cols and rows, so its memory moves with it
//   seenOf(item, grid)   the map's seen squares (fog/bitset.js load: empty when missing or not this size)
//   emptySeen(grid)      the SEEN_KEY value of nothing seen ("Forget explored")
//   exploredFor(state)   a mapStates entry's smooth explored memory: fog/shapes.js readExplored of its
//                        image for its rectangle, {valid, rings, n, a} (empty when missing, junk or of
//                        another size). Read only when needed (the drawing's input changed, the
//                        Lighting list's rows): never in every pass's snapshot
//   mapStates({items, rects, grid, sceneMeta})   one entry per map image in rects (topmost first):
//                        {id, item, rect, grid, name, building, buildingKey, kind, painted, remembered,
//                        darkness, darkLocked, override, mode, auto, hidden}. kind: the DM's
//                        MAP_FOG_KEY.kind, else paintedKind, else "outdoor". remembered: any map of the
//                        same building (by key) says MEMORY_KEY.remembered true. darkness: fog/mode.js
//                        resolveDarkness of the map's own MAP_DARKNESS_KEY and the scene's. darkLocked:
//                        that darkness is 🌑, so the map is fog only (fog/mode.js darkLocked). override:
//                        MAP_FOG_KEY.mode unless "auto" (else null; never "lit"), as stored even on a 🌑
//                        map (it applies again once the map is 🌒 or ☀). auto: the mode without the
//                        override. mode: the one drawn (fog/mode.js fogMode: "fog" on 🌑 whatever the
//                        override). hidden: the DM hid the map image (visible false): nothing drawn for it

import { MAP_DARKNESS_KEY, MAP_FOG_KEY, MAP_INFO_KEY, MEMORY_KEY, SCENE_LIGHTING_KEY, SEEN_KEY } from "../keys.js?v=af4de9c";
import { MODES, darkLocked, drawnMode, fogMode, resolveDarkness } from "./mode.js?v=af4de9c";
import { createBits, encode, load } from "./bitset.js?v=af4de9c";
import { readExplored } from "./shapes.js?v=af4de9c";

export const FOG_MODES = ["auto", ...MODES];
export const MAP_KINDS = ["interior", "outdoor"];

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const EPS = 1e-6;

// "The Inn – Ground floor.png" -> "The Inn - Ground floor" (case kept: buildingOf's key
// lowercases), as interiors.js normName does for its own matching.
export function normName(s) {
  return String(s ?? "").trim().replace(/\.(png|jpe?g|webp|gif|avif)$/i, "")
    .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

export function buildingOf(item) {
  const n = normName(item?.name);
  if (!n) return null;
  const k = n.indexOf(" - ");
  const name = (k > 0 ? n.slice(0, k) : n).trim();
  return name ? { name, key: name.toLowerCase() } : null;
}

export function paintedKind(item) {
  const info = item?.metadata?.[MAP_INFO_KEY];
  if (!isObj(info)) return null;
  return info.entry != null || info.stairs != null ? "interior" : "outdoor";
}

export function mapFogOf(meta) {
  const v = isObj(meta) ? meta[MAP_FOG_KEY] : null;
  const o = isObj(v) ? v : {};
  return { mode: FOG_MODES.includes(o.mode) ? drawnMode(o.mode) : "auto", kind: MAP_KINDS.includes(o.kind) ? o.kind : null };
}

export function memoryOf(meta) {
  const v = isObj(meta) ? meta[MEMORY_KEY] : null;
  return { remembered: isObj(v) && v.remembered === true };
}

export function mapGrid(rect, dpi) {
  if (!rect || !finite(rect.x0, rect.y0, rect.x1, rect.y1, dpi) || !(dpi > 0) || !(rect.x1 > rect.x0) || !(rect.y1 > rect.y0)) return null;
  const cell = dpi;
  const x0 = Math.floor(rect.x0 / cell + EPS) * cell;
  const y0 = Math.floor(rect.y0 / cell + EPS) * cell;
  const cols = Math.max(1, Math.ceil((rect.x1 - x0) / cell - EPS));
  const rows = Math.max(1, Math.ceil((rect.y1 - y0) / cell - EPS));
  return { x0, y0, cell, cols, rows };
}

export const seenOf = (item, grid) => (grid ? load(item?.metadata?.[SEEN_KEY], grid.cols, grid.rows) : null);

export const emptySeen = (grid) => (grid ? encode(createBits(grid.cols, grid.rows)) : null);

export const exploredFor = (state) => readExplored(state?.item, state?.rect);

const mapDarknessOf = (item) => item?.metadata?.[MAP_DARKNESS_KEY] ?? null;
const sceneDarknessOf = (sceneMeta) => (isObj(sceneMeta) && isObj(sceneMeta[SCENE_LIGHTING_KEY]) ? sceneMeta[SCENE_LIGHTING_KEY].darkness : null);

export function mapStates({ items = [], rects = [], grid = null, sceneMeta = {} } = {}) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.filter((i) => i?.id != null).map((i) => [i.id, i]));
  const dpi = finite(grid?.dpi) && grid.dpi > 0 ? grid.dpi : 150;
  const scene = sceneDarknessOf(sceneMeta);
  const base = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    const item = byId.get(r?.id);
    if (!item) continue;
    const fogMeta = mapFogOf(item.metadata);
    const painted = paintedKind(item);
    const b = buildingOf(item);
    base.push({
      id: item.id, item, rect: r, grid: mapGrid(r, dpi), name: String(item.name ?? ""),
      building: b?.name ?? null, buildingKey: b?.key ?? null,
      kind: fogMeta.kind ?? painted ?? "outdoor", painted,
      own: memoryOf(item.metadata).remembered,
      darkness: resolveDarkness({ dm: mapDarknessOf(item), scene }),
      override: fogMeta.mode === "auto" ? null : fogMeta.mode,
      hidden: item.visible === false,
    });
  }
  const remembered = new Set(base.filter((m) => m.own && m.buildingKey).map((m) => m.buildingKey));
  return base.map(({ own, ...m }) => {
    const rem = own || (m.buildingKey != null && remembered.has(m.buildingKey));
    const auto = fogMode({ darkness: m.darkness, kind: m.kind, remembered: rem, override: null });
    const mode = fogMode({ darkness: m.darkness, kind: m.kind, remembered: rem, override: m.override });
    return { ...m, darkLocked: darkLocked(m.darkness), remembered: rem, auto, mode };
  });
}
