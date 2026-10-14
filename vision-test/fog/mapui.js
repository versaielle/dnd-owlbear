// The DM's per-map fog controls in the 🔥 Lighting list's "Maps here" rows (lightpanel.js), for our
// own vision layer's explored memory (docs/vision-layer-b4.md section 6; spec section 6). GM only,
// shown only while 🌫 Our fog is on. Each tap writes from the GM screen that was tapped, at once (no
// leader, as the 🌫 switch): it decides in the draft, assigns a WHOLE value, skips a draft already
// so, and never deletes a key (a JSON-patch "remove" of a key another screen lacks throws
// OPERATION_PATH_UNRESOLVABLE there: live, 2026-10-12).
//
//   FORGET_ARM_MS        "Forget explored" takes two taps within this
//   MODE_CHIPS           the mode chips' order and words (auto, fog, dim, lit, clear)
//   kindOf(item)         {kind, kindFrom, painted}: the DM's MAP_FOG_KEY.kind ("dm"), else what 🏘 Set
//                        up interiors laid out ("painted": MAP_INFO_KEY with an entry or stairs is a
//                        building floor, both null is the town), else "outdoor" ("default")
//   buildingName(item)   the building's name ("The Inn - Ground floor" -> "The Inn"), or null
//   mapRows({items, rects, grid, sceneMeta})   (rects: views.js mapRects, worked out when left out)
//                        per map image (fog/maps.js mapStates, topmost first):
//                        {id, name, building, buildingKey, kind, kindFrom, painted, mode, auto, override,
//                        remembered, canRemember, seen, grid, darkness, hidden, floors}. Pure
//   chipsFor(row)        what the row's chips say and do: {modes, kinds, forget, remember} (pure)
//   setMapFog(OBR, id, {mode, kind})        -> {wrote}: MAP_FOG_KEY whole
//   forgetExplored(OBR, id, dpi)            -> {wrote}: SEEN_KEY = the empty set of the map's size
//   setRemembered(OBR, buildingKey, on)     -> {wrote, maps}: MEMORY_KEY on every floor, one call
//
// The automatic threshold (2 visits plus 10 active minutes, spec section 7) comes after Thursday;
// it will write the same MEMORY_KEY setRemembered writes, so nothing here changes.

import { MAP_FOG_KEY, MEMORY_KEY, SEEN_KEY } from "../keys.js?v=7f44662";
import { mapRects } from "../views.js?v=7f44662";
import { count } from "./bitset.js?v=7f44662";
import { FOG_MODES, MAP_KINDS, buildingOf, emptySeen, mapFogOf, mapGrid, mapStates, paintedKind, seenOf } from "./maps.js?v=7f44662";

export const FORGET_ARM_MS = 5000;

const MODE_WORDS = {
  auto: { label: "auto", about: "As the map's darkness and kind say (🌑 fogs over; an interior fogs over until remembered, then stays dimmed; outdoors 🌒 dims, ☀ stays lit)" },
  fog: { label: "fog", about: "Fogs over: what the party looked at goes back under the fog" },
  dim: { label: "dim", about: "Stays dimmed: what the party saw stays visible, darker; creatures show only while in sight" },
  lit: { label: "lit", about: "Stays lit: what the party saw stays at full brightness; creatures show only while in sight" },
  clear: { label: "clear", about: "No fog on this map at all: everyone sees all of it, creatures too" },
};
export const MODE_CHIPS = FOG_MODES.map((mode) => ({ mode, ...MODE_WORDS[mode] }));

const isMapImage = (i) => i?.layer === "MAP" && (i.type === undefined || i.type === "IMAGE");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function kindOf(item) {
  const painted = paintedKind(item);
  const dm = mapFogOf(item?.metadata).kind;
  if (dm) return { kind: dm, kindFrom: "dm", painted };
  if (painted) return { kind: painted, kindFrom: "painted", painted };
  return { kind: "outdoor", kindFrom: "default", painted };
}

export const buildingName = (item) => buildingOf(item)?.name ?? null;

export function mapRows({ items = [], rects, grid = null, sceneMeta = {} } = {}) {
  const dpi = Number(grid?.dpi) > 0 ? grid.dpi : 150;
  const states = mapStates({ items, rects: rects ?? mapRects(items, dpi), grid, sceneMeta });
  const floors = new Map();
  for (const m of states) if (m.buildingKey) floors.set(m.buildingKey, (floors.get(m.buildingKey) || 0) + 1);
  return states.map((m) => {
    const k = kindOf(m.item);
    const bits = seenOf(m.item, m.grid);
    return {
      id: m.id, name: m.name, building: m.building, buildingKey: m.buildingKey,
      kind: m.kind, kindFrom: k.kindFrom, painted: m.painted,
      mode: m.mode, auto: m.auto, override: m.override, remembered: m.remembered,
      canRemember: m.kind === "interior" && !!m.buildingKey,
      seen: bits ? count(bits) : 0, grid: m.grid, darkness: m.darkness, hidden: m.hidden,
      floors: m.buildingKey ? floors.get(m.buildingKey) : 0,
    };
  });
}

// What the row's chips say. modes: [{mode, label, on, title}]; kinds: [{kind (the value written:
// "interior" | "outdoor" | null), label, on, title}] (on every map; "as painted" only on a painted
// map the DM changed); forget: {label, n, disabled, title}; remember: null unless an
// interior with a building, else {on (what a tap writes), label, title}.
export function chipsFor(row) {
  const modes = MODE_CHIPS.map((c) => ({
    mode: c.mode,
    label: c.mode === "auto" ? `auto (→ ${row.auto})` : c.label,
    on: c.mode === "auto" ? !row.override : row.override === c.mode,
    title: c.about,
  }));
  // On EVERY map (review of B4: a painted map has to be changeable too: a building's outdoor grounds
  // painted with an entry and stairs count as a building floor). The outdoor chip writes
  // null (the default) on a map nobody painted, "outdoor" on a painted one; "as painted" only once
  // the DM changed a painted map.
  const kinds = [
    { kind: "interior", label: "🏠 Interior", on: row.kind === "interior", title: "A building floor: fogs over until its building is remembered" },
    { kind: row.painted ? "outdoor" : null, label: "🌳 Outdoor", on: row.kind === "outdoor",
      title: "Outdoors: 🌒 stays dimmed, ☀ stays lit" },
  ];
  if (row.painted && row.kindFrom === "dm") {
    kinds.push({ kind: null, label: "as painted", on: false, title: `Back to what 🏘 Set up interiors made it (${row.painted})` });
  }
  const n = Number(row.seen) || 0;
  const forget = { n, disabled: n === 0, label: `Forget explored (${n})`,
    title: n ? "The party's explored squares on this map go back under the fog (two taps)" : "Nothing explored here yet" };
  const remember = row.canRemember ? {
    on: !row.remembered,
    label: row.remembered ? "Forget building" : "Remember building",
    title: row.remembered
      ? `${row.building}: its ${row.floors} map(s) fog over again when out of sight (the explored squares are kept)`
      : `${row.building}: the party knows it now; its ${row.floors} map(s) stay dimmed where they've seen`,
  } : null;
  return { modes, kinds, forget, remember };
}

// MAP_FOG_KEY {mode, kind} whole on one map image: mode undefined keeps the current one, kind
// undefined keeps it (null = as painted). Decided in the draft.
export async function setMapFog(OBR, id, { mode, kind } = {}) {
  if (mode !== undefined && !FOG_MODES.includes(mode)) throw new Error(`not a fog mode: ${mode}`);
  if (kind !== undefined && kind !== null && !MAP_KINDS.includes(kind)) throw new Error(`not a map kind: ${kind}`);
  let wrote = 0, next = null;
  await OBR.scene.items.updateItems([id], (drafts) => {
    for (const d of drafts) {
      if (d.id !== id) continue;
      const cur = mapFogOf(d.metadata);
      next = { mode: mode === undefined ? cur.mode : mode, kind: kind === undefined ? cur.kind : kind };
      if (same(d.metadata?.[MAP_FOG_KEY], next)) continue;
      if (!d.metadata) d.metadata = {};
      d.metadata[MAP_FOG_KEY] = next;
      wrote++;
    }
  });
  return { wrote, value: next };
}

// SEEN_KEY = nothing seen, at the size of the map as the draft has it (its position and scale now).
export async function forgetExplored(OBR, id, dpi) {
  let wrote = 0, cells = 0;
  await OBR.scene.items.updateItems([id], (drafts) => {
    for (const d of drafts) {
      if (d.id !== id) continue;
      const grid = mapGrid(mapRects([d], dpi)[0], dpi);
      const value = emptySeen(grid);
      if (!value) continue;
      cells = grid.cols * grid.rows;
      if (same(d.metadata?.[SEEN_KEY], value)) continue;
      if (!d.metadata) d.metadata = {};
      d.metadata[SEEN_KEY] = value;
      wrote++;
    }
  });
  return { wrote, cells };
}

// MEMORY_KEY {remembered} on EVERY map image of one building (its buildingOf key), in ONE updateItems,
// and on no other. Forget writes false on all of them (mapStates remembers a building when ANY floor
// says true).
export async function setRemembered(OBR, buildingKey, remembered) {
  const key = String(buildingKey ?? "").toLowerCase();
  if (!key) return { wrote: 0, maps: 0 };
  const items = (await OBR.scene.items.getItems()) || [];
  const ids = items.filter((i) => isMapImage(i) && buildingOf(i)?.key === key).map((i) => i.id);
  if (!ids.length) return { wrote: 0, maps: 0 };
  const value = { remembered: remembered === true };
  let wrote = 0;
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const d of drafts) {
      if (!isMapImage(d) || buildingOf(d)?.key !== key) continue; // renamed meanwhile
      if (same(d.metadata?.[MEMORY_KEY], value)) continue;
      if (!d.metadata) d.metadata = {};
      d.metadata[MEMORY_KEY] = { ...value };
      wrote++;
    }
  });
  return { wrote, maps: ids.length };
}
