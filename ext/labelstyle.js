// 🎨 Copy label style and ↩ Undo label style: two of 🏘 Map setup's jobs (dndmenu.js MAP_SETUP_JOBS), on
// ONE text label the GM right-clicked (an Owlbear TEXT item, as the Text tool makes, plain or rich; or a
// LABEL). The DM, 2026-10-20: the town map's labels should all look like the one he restyled there, and
// every building map's like the one he restyled on a building's map; "between the city map and building
// maps they are too different text sizes", so a label's size is never copied.
//
// Copied: the clicked label's text.style fillColor and fillOpacity (the font colour), strokeColor and
// strokeOpacity (the outline colour), strokeWidth (the outline's thickness) and fontFamily (the font).
// Never anything else: not the size, weight, alignment, line height or padding, not the words, the
// box, the position, or who can see or move it.
//
// Copied to "the rest", by which map the clicked label is on (mapOf):
//   a main map (a map image interiors.json doesn't list: the town): every other label on that map;
//   a building's map (one interiors.json lists, matched by name as 🏘 Set up interiors matches them):
//     every other label on every listed map in this scene, every building and every floor.
// A label is on the map image it is attached to (straight or through what it hangs from); otherwise
// on the topmost map image under its position. Left alone: labels on no map, labels hanging from
// anything that isn't a map (a token), and the extension's own (a monster's hidden note, MARK_PREFIX;
// anything carrying one of our keys).
//
// Undo: before a label changes, its old six values go on a short stack in its own metadata
// (LABEL_STYLE_KEY, at most UNDO_DEPTH copies deep). ↩ on any label of the same group (the same main
// map; or the building maps) puts back every label the group's latest copy changed, and drops that
// copy from their stacks: a second ↩ undoes the copy before it.
//
// Which maps are listed comes from interiors.json, which only the panel on this PC serves, so these
// run on the "DND NPC (this PC)" copy only (background.js mapSetup), like the rest of 🏘 Map setup.
// The pure parts (copyPlan, undoPlan, applyCopy, applyUndo, the texts) are checked offline by
// check_labelstyle.mjs.
import OBR from "./obr-sdk.js?v=5bd9e047-d6bebbb";
import { directBase } from "./bus.js?v=5bd9e047-d6bebbb";
import { bounds, describe, listed, loadInteriors, normName } from "./interiors.js?v=5bd9e047-d6bebbb";
import { LABEL_STYLE_KEY, MARK_PREFIX } from "./keys.js?v=5bd9e047-d6bebbb";

export const STYLE_FIELDS = ["fillColor", "fillOpacity", "strokeColor", "strokeOpacity", "strokeWidth", "fontFamily"];
export const UNDO_DEPTH = 5;
export const BUILDINGS = "buildings"; // the group of every listed map in the scene
const LABEL_TYPES = ["TEXT", "LABEL"];
const DEEPEST = 8; // attachedTo links climbed before giving up (a loop, or something odd)
const BATCH = 80; // labels per updateItems call (interiors.js's batch size)
const RETRIES = 6;

// A text label: a TEXT or LABEL item with a text style to copy.
export const isLabel = (i) => !!i && LABEL_TYPES.includes(i.type) && !!i.text?.style && typeof i.text.style === "object";
const isMapImage = (i) => i?.layer === "MAP" && i?.type === "IMAGE";
const placeable = (i) => isMapImage(i) && i.image?.width > 0 && i.image?.height > 0 && i.grid?.dpi > 0 && !!i.position;

// The extension's own text: a monster's hidden note (background.js setMark), or anything carrying one of
// our metadata keys (but the undo stack this file keeps on the DM's labels).
export function isOurs(i) {
  if (String(i?.id ?? "").startsWith(MARK_PREFIX)) return true;
  return Object.keys(i?.metadata || {}).some((k) => k.startsWith("dnd-npc/") && k !== LABEL_STYLE_KEY);
}

// The ids of this scene's map images that interiors.json lists (a building's map), by name or label.
export function listedIds(json, images) {
  const names = new Set(listed(json || {}).map((m) => normName(m.name)).filter(Boolean));
  return new Set(images.filter((i) => [i.name, i.text?.plainText].some((n) => {
    const k = normName(n);
    return !!k && names.has(k);
  })).map((i) => i.id));
}

const inside = (b, p) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;

// The map image a label is on: {map}, or {why: "attached"} (it hangs from something that isn't on a map:
// a token) or {why: "nomap"} (no map under it). `byId`: every item in the scene; `maps`: its map images.
export function mapOf(label, byId, maps, sceneDpi) {
  let i = label;
  for (let n = 0; i?.attachedTo != null; n++) {
    if (n >= DEEPEST) return { why: "attached" };
    const up = byId.get(i.attachedTo);
    if (!up) break; // its parent is gone: placed by its own position, as an unattached label
    if (isMapImage(up)) return { map: up };
    i = up;
  }
  if (i !== label && i?.attachedTo == null) return { why: "attached" }; // a chain that ends on no map
  const p = label.position;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { why: "nomap" };
  let best = null;
  maps.forEach((m, at) => {
    if (!placeable(m)) return;
    let b;
    try {
      b = bounds(m, sceneDpi);
    } catch {
      return;
    }
    if (!inside(b, p)) return;
    const z = Number.isFinite(m.zIndex) ? m.zIndex : 0;
    if (!best || z >= best.z) best = { map: m, z, at };
  });
  return best ? { map: best.map } : { why: "nomap" };
}

// The group a map is in: every listed map together (BUILDINGS), a main map on its own.
const groupKey = (map, ids) => (ids.has(map.id) ? BUILDINGS : `main:${map.id}`);
const whereOf = (group) => (group === BUILDINGS ? "buildings" : "main");

// The clicked label, the map it's on and its group, or {error}.
function clickedLabel(json, items, clickedId, sceneDpi) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const src = byId.get(clickedId);
  if (!isLabel(src)) return { error: "notlabel" };
  if (isOurs(src)) return { error: "ours" };
  const maps = items.filter(isMapImage);
  const ids = listedIds(json, maps);
  const on = mapOf(src, byId, maps, sceneDpi);
  if (on.why) return { error: on.why };
  const group = groupKey(on.map, ids);
  return { src, byId, maps, ids, map: on.map, group, where: whereOf(group) };
}

// The six values of a style that are set.
export function pickStyle(style) {
  const out = {};
  for (const f of STYLE_FIELDS) if (style && style[f] !== undefined && style[f] !== null) out[f] = style[f];
  return out;
}

// 🎨: what a copy from the clicked label changes, worked out without touching Owlbear. {where: "main" |
// "buildings", group, style (the six values to copy), targets (the other labels' ids), run} or {error}.
export function copyPlan(json, items, clickedId, sceneDpi, run) {
  const c = clickedLabel(json, items, clickedId, sceneDpi);
  if (c.error) return { error: c.error };
  const targets = [];
  for (const i of items) {
    if (i.id === c.src.id || !isLabel(i) || isOurs(i)) continue;
    const m = mapOf(i, c.byId, c.maps, sceneDpi);
    if (!m.map) continue;
    if (groupKey(m.map, c.ids) !== c.group) continue;
    targets.push(i.id);
  }
  return { where: c.where, group: c.group, style: pickStyle(c.src.text.style), targets, run };
}

// A label's undo stack (oldest first), as plain data.
export function stackOf(i) {
  const v = i?.metadata?.[LABEL_STYLE_KEY];
  const runs = v && typeof v === "object" && Array.isArray(v.runs) ? v.runs : [];
  return runs.filter((e) => e && typeof e === "object" && Number.isFinite(e.run) && e.before && typeof e.before === "object")
    .map((e) => ({ run: e.run, group: String(e.group ?? ""), before: pickStyle(e.before) }));
}

// The stack as it is written: always UNDO_DEPTH slots (the empty ones null) and every entry with all six
// values (null where a label had none), so no write ever removes a key or an array slot, only replaces one
// (the never-remove-a-key rule; keys.js).
function writeStack(i, list) {
  const full = (e) => ({ run: e.run, group: e.group, before: Object.fromEntries(STYLE_FIELDS.map((f) => [f, e.before[f] ?? null])) });
  const kept = list.slice(-UNDO_DEPTH).map(full);
  if (!i.metadata || typeof i.metadata !== "object") i.metadata = {};
  i.metadata[LABEL_STYLE_KEY] = { v: 1, runs: Array.from({ length: UNDO_DEPTH }, (_, k) => kept[k] ?? null) };
}

// One label (an updateItems draft): keep its old six values on its stack, then copy the six over.
export function applyCopy(i, style, group, run) {
  if (!isLabel(i)) return false;
  const s = i.text.style;
  writeStack(i, [...stackOf(i), { run, group, before: pickStyle(s) }]);
  for (const f of STYLE_FIELDS) if (style[f] !== undefined) s[f] = style[f];
  return true;
}

// ↩: the labels the clicked label's group's latest copy changed. {where, group, run, targets} or {error}.
export function undoPlan(json, items, clickedId, sceneDpi) {
  const c = clickedLabel(json, items, clickedId, sceneDpi);
  if (c.error) return { error: c.error };
  const tops = [];
  for (const i of items) {
    if (!isLabel(i)) continue;
    const top = stackOf(i).at(-1);
    if (top && top.group === c.group) tops.push([i.id, top.run]);
  }
  const runs = tops.map(([, r]) => r).filter(Number.isFinite);
  if (!runs.length) return { where: c.where, group: c.group, run: null, targets: [] };
  const run = Math.max(...runs);
  return { where: c.where, group: c.group, run, targets: tops.filter(([, r]) => r === run).map(([id]) => id) };
}

// One label (a draft): put back the values its latest copy kept, if that copy is `run` of `group`, and drop
// it from the stack (its slot back to null; the key stays).
export function applyUndo(i, group, run) {
  if (!isLabel(i)) return false;
  const runs = stackOf(i);
  const top = runs.at(-1);
  if (!top || top.group !== group || top.run !== run) return false;
  for (const [f, v] of Object.entries(top.before)) i.text.style[f] = v;
  runs.pop();
  writeStack(i, runs);
  return true;
}

// ---- what the DM is told ----

const onWhat = (where) => (where === "buildings" ? "the building maps" : "the main map");
const labels = (n) => `${n} label${n === 1 ? "" : "s"}`;
const WHY = {
  notlabel: "Right-click one text label",
  ours: "That label is one of the extension's own: nothing changed",
  attached: "That label hangs on a token, not a map: nothing changed",
  nomap: "That label isn't on a map: nothing changed",
};
export function copyText(p) {
  if (p.error) return `🎨 ${WHY[p.error] || WHY.notlabel}`;
  if (!p.targets.length) return `🎨 No other labels on ${onWhat(p.where)}: nothing changed`;
  return `🎨 Label style copied to ${labels(p.targets.length)} on ${onWhat(p.where)}`;
}
export function undoText(p, n = p.targets?.length ?? 0) {
  if (p.error) return `↩ ${WHY[p.error] || WHY.notlabel}`;
  if (!n) return `↩ No label style to undo on ${onWhat(p.where)}`;
  return `↩ Label style undone on ${labels(n)} on ${onWhat(p.where)}`;
}
export function noInteriorsText(mark) {
  return directBase() ? `${mark} No interiors.json on the panel yet (owlbear/maps/interiors.py makes it)`
    : `${mark} Can't reach the DND panel from here: use the “DND NPC (this PC)” copy's menu on the Dell`;
}

// ---- the jobs ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (/RateLimit|Too many requests/i.test(describe(e)) && attempt < RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
}

// Each batch of ids through updateItems with `edit` on each draft; how many it changed.
async function update(ids, edit) {
  let n = 0;
  for (let k = 0; k < ids.length; k += BATCH) {
    const batch = ids.slice(k, k + BATCH);
    await retry(() => OBR.scene.items.updateItems(batch, (drafts) => {
      for (const d of drafts) if (edit(d)) n++;
    }));
  }
  return n;
}

async function scene() {
  const json = await loadInteriors();
  if (!json) return null;
  const sceneDpi = await OBR.scene.grid.getDpi();
  const items = await OBR.scene.items.getItems();
  return { json, sceneDpi, items };
}

// 🎨 Copy label style, from the label `id`.
export async function copyLabelStyle(id, now = Date.now()) {
  const s = await scene();
  if (!s) return void OBR.notification.show(noInteriorsText("🎨"), "ERROR");
  const p = copyPlan(s.json, s.items, id, s.sceneDpi, now);
  if (p.error || !p.targets.length) return void OBR.notification.show(copyText(p), p.error ? "WARNING" : "INFO");
  await update(p.targets, (d) => applyCopy(d, p.style, p.group, p.run));
  OBR.notification.show(copyText(p), "SUCCESS");
}

// ↩ Undo label style, on the label `id`'s group.
export async function undoLabelStyle(id) {
  const s = await scene();
  if (!s) return void OBR.notification.show(noInteriorsText("↩"), "ERROR");
  const p = undoPlan(s.json, s.items, id, s.sceneDpi);
  if (p.error || !p.targets.length) return void OBR.notification.show(undoText(p), p.error ? "WARNING" : "INFO");
  const n = await update(p.targets, (d) => applyUndo(d, p.group, p.run));
  OBR.notification.show(undoText(p, n), "SUCCESS");
}
