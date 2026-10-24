// The DM's per-map fog controls in the 🔥 Lighting list's "Maps here" rows (lightpanel.js), for our
// own vision layer's explored memory (docs/vision-layer-b4.md section 6; spec section 6; from Phase 1
// docs/vision-layer-2024.md section 6), and the scene's memory shade. GM only, shown only while 🌫
// Our fog is on. Each tap writes from the GM screen that was tapped, at once (no leader, as the 🌫
// switch): it decides in the draft, assigns a WHOLE value, skips a draft already so, and never
// deletes a key (a JSON-patch "remove" of a key another screen lacks throws
// OPERATION_PATH_UNRESOLVABLE there: live, 2026-10-12). Every word says "explored memory", never
// "squares": the squares (SEEN_KEY) are still written but never drawn.
//
//   FORGET_ARM_MS        "Forget explored" takes two taps within this
//   MODE_WORDS, modeWord(mode)   the words a mode is said in (the stored "dim" is "remembered")
//   MODE_CHIPS           the mode chips' order and words: auto, fog, remembered (writes "dim"), clear.
//                        No "lit" chip: remembered ground is always dimmed (decision 69), so it would
//                        do the same as "remembered"; a stored "lit" lights the remembered chip
//   SHADES, DEFAULT_SHADE, shadeOf(sceneMeta)   the memory shade (fog/memory.js, its one reader)
//   SHADE_CHIPS          the "Memory shade" row's chips: lighter 0.55, medium 0.65, darker 0.75
//   shadeChips(sceneMeta)   [{shade, label, on, title}] (pure)
//   sharePct(a)          an explored share in thousandths as the chip says it: "40%", "<1%" (never
//                        "0%" while anything is explored), "" for nothing
//   kindOf(item)         {kind, kindFrom, painted}: the DM's MAP_FOG_KEY.kind ("dm"), else what 🏘 Set
//                        up interiors laid out ("painted": MAP_INFO_KEY with an entry or stairs is a
//                        building floor, both null is the town), else "outdoor" ("default")
//   buildingName(item)   the building's name ("The Inn - Ground floor" -> "The Inn"), or null
//   mapRects(items, dpi) views.js's map rectangles, handed on (lightpanel.js mapGroups measures how
//                        near a building is to each main map with them)
//   mapRows({items, rects, grid, sceneMeta})   (rects: views.js mapRects, worked out when left out)
//                        per map image (fog/maps.js mapStates, topmost first):
//                        {id, name, building, buildingKey, kind, kindFrom, painted, mode, auto, override,
//                        remembered, canRemember, seen, explored, grid, darkness, darkLocked, hidden,
//                        floors}. darkLocked: the map is 🌑, so fog only (fog/mode.js darkLocked). seen:
//                        the old squares' count (never drawn); explored: the smooth memory's share of
//                        the map in thousandths (EXPLORED_KEY's a, 0-1000; 0 when missing, junk or of
//                        another size). Pure
//   chipsFor(row)        what the row's chips say and do: {modes, kinds, forget, remember} (pure). On a
//                        🌑 map (row.darkLocked) the remembered and clear chips are disabled ("dark map:
//                        fog only"); a stored override stays stored, and the chip of it stays on
//   DARK_ONLY_TITLE      that tooltip
//   setMapFog(OBR, id, {mode, kind})        -> {wrote, value}: MAP_FOG_KEY whole (a "lit" asked for
//                        is written as "dim")
//   forgetExplored(OBR, id, dpi)            -> {wrote, cells, keys}: SEEN_KEY's empty set and
//                        EXPLORED_KEY's empty value, both of the map's size as the draft has it, in ONE
//                        draft; a key already empty is skipped
//   forgetAllExplored(OBR, dpi)             -> {wrote, maps, names}: the same on EVERY map image of the
//                        scene holding SEEN_KEY or EXPLORED_KEY, in ONE updateItems (the 🌫 row's "Forget
//                        explored on every map"); wrote and names: the maps changed; maps: the ones looked
//                        at. MAP-layer images only: never a roof piece (a FOG-layer image) or a token
//   setRemembered(OBR, buildingKey, on)     -> {wrote, maps}: MEMORY_KEY on every floor, one call
//   setShade(OBR, shade)                    -> {wrote, value}: FOG_LOOK_KEY {v: 1, shade} whole on the
//                        scene, skipped when it already holds exactly that
//
// The automatic threshold (2 visits plus 10 active minutes, spec section 7) comes after Thursday;
// it will write the same MEMORY_KEY setRemembered writes, so nothing here changes.

import { EXPLORED_KEY, FOG_LOOK_KEY, MAP_FOG_KEY, MEMORY_KEY, SEEN_KEY } from "../keys.js?v=79af80f";
import { mapRects } from "../views.js?v=79af80f";
import { count } from "./bitset.js?v=79af80f";
import { FOG_MODES, MAP_KINDS, buildingOf, emptySeen, exploredFor, mapFogOf, mapGrid, mapStates, paintedKind, seenOf } from "./maps.js?v=79af80f";
import { DEFAULT_SHADE, SHADES, shadeOf } from "./memory.js?v=79af80f";
import { drawnMode } from "./mode.js?v=79af80f";
import { emptyExplored } from "./shapes.js?v=79af80f";

export { DEFAULT_SHADE, SHADES, mapRects, shadeOf };
export const FORGET_ARM_MS = 5000;

export const MODE_WORDS = {
  auto: { label: "auto", about: "As the map's darkness and kind say: 🌑 fogs over; an interior fogs over until its building is remembered; everything else is remembered (dimmed, while a PC is on the map)" },
  fog: { label: "fog", about: "Fogs over: only what the party sees now shows (what they explored is still kept, just not drawn)" },
  dim: { label: "remembered", about: "Remembered: while a PC is on the map, where the party has looked stays visible, dimmed at the memory shade; creatures show only while in sight" },
  clear: { label: "clear", about: "The whole map shown, dimmed at the memory shade; creatures show only where a PC's sight reaches them" },
};
export const MODE_CHIPS = ["auto", "fog", "dim", "clear"].map((mode) => ({ mode, ...MODE_WORDS[mode] }));
// 🌑 locks a map to fog (decided 2026-10-14, "Never: lock 🌑 to fog"): these chips are greyed there.
export const DARK_ONLY_TITLE = "dark map: fog only";
const DARK_LOCKED_MODES = ["dim", "clear"];
export const modeWord = (mode) => MODE_WORDS[drawnMode(mode)]?.label ?? String(mode ?? "");

export const SHADE_CHIPS = [
  { shade: 0.55, label: "lighter" },
  { shade: 0.65, label: "medium" },
  { shade: 0.75, label: "darker" },
].filter((c) => SHADES.includes(c.shade));

export function shadeChips(sceneMeta) {
  const now = shadeOf(sceneMeta);
  return SHADE_CHIPS.map((c) => ({ ...c, on: c.shade === now,
    title: `Remembered ground and "clear" maps drawn ${c.label} (${c.shade}) on every screen in this scene`
      + `${c.shade === DEFAULT_SHADE ? " (where a scene starts)" : ""}; on a 🌒 map the darkness adds to it` }));
}

export function sharePct(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n < 5 ? "<1%" : `${Math.min(100, Math.round(n / 10))}%`;
}

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
      seen: bits ? count(bits) : 0, explored: exploredFor(m).a, grid: m.grid, darkness: m.darkness,
      darkLocked: m.darkLocked === true, hidden: m.hidden,
      floors: m.buildingKey ? floors.get(m.buildingKey) : 0,
    };
  });
}

// What the row's chips say. modes: [{mode, label, on, title, disabled}] (disabled: remembered and clear
// on a 🌑 map, row.darkLocked; the stored override's chip stays on there, its tooltip saying it's kept
// for when the map is 🌒 or ☀); kinds: [{kind (the value written:
// "interior" | "outdoor" | null), label, on, title}] (on every map; "as painted" only on a painted
// map the DM changed); forget: {label, a, pct, disabled, title} (a: the explored share in
// thousandths; greyed when nothing is explored); remember: null unless an interior with a building,
// else {on (what a tap writes), label, title}.
export function chipsFor(row) {
  const override = row.override == null ? null : drawnMode(row.override);
  const locked = row.darkLocked === true;
  const modes = MODE_CHIPS.map((c) => {
    const on = c.mode === "auto" ? !override : override === c.mode;
    const disabled = locked && DARK_LOCKED_MODES.includes(c.mode);
    return {
      mode: c.mode,
      label: c.mode === "auto" ? `auto (→ ${modeWord(row.auto)})` : c.label,
      on,
      title: disabled ? `${DARK_ONLY_TITLE}${on ? " (your pick is kept: it's back if the map is 🌒 or ☀)" : ""}` : c.about,
      disabled,
    };
  });
  // On EVERY map (review of B4: a painted map has to be changeable too: a building's outdoor grounds
  // painted with an entry and stairs count as a building floor). The outdoor chip writes
  // null (the default) on a map nobody painted, "outdoor" on a painted one; "as painted" only once
  // the DM changed a painted map.
  const kinds = [
    { kind: "interior", label: "🏠 Interior", on: row.kind === "interior", title: "A building floor: fogs over until its building is remembered" },
    { kind: row.painted ? "outdoor" : null, label: "🌳 Outdoor", on: row.kind === "outdoor",
      title: "Outdoors: remembered (dimmed) where the party has looked, while a PC is on the map, unless 🌑" },
  ];
  if (row.painted && row.kindFrom === "dm") {
    kinds.push({ kind: null, label: "as painted", on: false, title: `Back to what 🏘 Set up interiors made it (${row.painted})` });
  }
  const a = Number(row.explored) > 0 ? Math.round(Number(row.explored)) : 0;
  const pct = sharePct(a);
  const forget = { a, pct, disabled: a === 0, label: a ? `Forget explored (${pct})` : "Forget explored",
    title: a ? `The party's explored memory on this map (${pct} of it) goes back under the fog (two taps)` : "Nothing explored here yet" };
  const remember = row.canRemember ? {
    on: !row.remembered,
    label: row.remembered ? "Forget building" : "Remember building",
    title: row.remembered
      ? `${row.building}: its ${row.floors} map(s) fog over again when out of sight (the explored memory is kept)`
      : `${row.building}: the party knows it now; its ${row.floors} map(s) stay dimmed where they've looked, while a PC is on them`,
  } : null;
  return { modes, kinds, forget, remember };
}

// MAP_FOG_KEY {mode, kind} whole on one map image: mode undefined keeps the current one (a stored
// "lit" kept as "dim"), kind undefined keeps it (null = as painted). Decided in the draft. A "lit"
// asked for is written as "dim" (it draws the same).
export async function setMapFog(OBR, id, { mode, kind } = {}) {
  if (mode !== undefined && !FOG_MODES.includes(mode)) throw new Error(`not a fog mode: ${mode}`);
  if (kind !== undefined && kind !== null && !MAP_KINDS.includes(kind)) throw new Error(`not a map kind: ${kind}`);
  if (mode !== undefined) mode = drawnMode(mode);
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

// Nothing explored: SEEN_KEY's empty set and EXPLORED_KEY's empty value, at the size of the map as
// the draft has it (its position and scale now), both in this ONE draft (the seen writer reads the
// shrink as a Forget: "forgotten, starting again"). A key already holding exactly its empty value is
// left alone; a map with neither to change writes nothing. One draft's Forget, for forgetExplored and
// forgetAllExplored alike: -> {keys (the ones written), cells (the map's squares, 0 off the grid)}.
function forgetDraft(d, dpi) {
  const rect = mapRects([d], dpi)[0];
  const grid = mapGrid(rect, dpi);
  const put = [[SEEN_KEY, emptySeen(grid)], [EXPLORED_KEY, emptyExplored(rect)]]
    .filter(([k, v]) => v && !same(d.metadata?.[k], v));
  if (put.length) {
    if (!d.metadata) d.metadata = {};
    for (const [k, v] of put) d.metadata[k] = v;
  }
  return { keys: put.map(([k]) => k), cells: grid ? grid.cols * grid.rows : 0 };
}

export async function forgetExplored(OBR, id, dpi) {
  let wrote = 0, cells = 0, keys = [];
  await OBR.scene.items.updateItems([id], (drafts) => {
    for (const d of drafts) {
      if (d.id !== id) continue;
      const f = forgetDraft(d, dpi);
      cells = f.cells;
      if (!f.keys.length) continue;
      keys = f.keys;
      wrote++;
    }
  });
  return { wrote, cells, keys };
}

// "Forget explored on every map" (DM, 2026-10-20: "a reset all for persistence on remembering vision"):
// every MAP-layer image holding SEEN_KEY or EXPLORED_KEY (a null reads as missing), all in ONE
// updateItems, each map's draft forgotten as forgetExplored's is (forgetDraft, both keys in the same
// draft). Decided in the draft again; a map already empty writes nothing and isn't counted, and a map
// with neither key, a roof piece (a FOG-layer image, fog/roofs.js's own) or a token is never asked for.
const holdsMemory = (i) => i?.metadata?.[SEEN_KEY] != null || i?.metadata?.[EXPLORED_KEY] != null;
export async function forgetAllExplored(OBR, dpi) {
  const items = (await OBR.scene.items.getItems()) || [];
  const ids = items.filter((i) => isMapImage(i) && holdsMemory(i)).map((i) => i.id);
  if (!ids.length) return { wrote: 0, maps: 0, names: [] };
  let wrote = 0;
  const names = [];
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const d of drafts) {
      if (!isMapImage(d) || !holdsMemory(d)) continue;
      if (!forgetDraft(d, dpi).keys.length) continue;
      wrote++;
      names.push(d.name ?? "");
    }
  });
  return { wrote, maps: ids.length, names };
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

// The scene's memory shade, FOG_LOOK_KEY {v: 1, shade}, written whole from the GM screen tapped
// (scene metadata has no draft: one key, whole, so a second screen's tap is simply the last word);
// nothing is written when the scene already holds exactly that value.
export async function setShade(OBR, shade) {
  if (!SHADES.includes(shade)) throw new Error(`not a memory shade: ${shade}`);
  const value = { v: 1, shade };
  const meta = (await OBR.scene.getMetadata()) || {};
  if (same(meta[FOG_LOOK_KEY], value)) return { wrote: 0, value };
  await OBR.scene.setMetadata({ [FOG_LOOK_KEY]: { ...value } });
  return { wrote: 1, value };
}
