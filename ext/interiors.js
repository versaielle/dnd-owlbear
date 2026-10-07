// "🏘 Set up interiors", run on the town map: the painted building maps (one image per
// floor, already uploaded to the scene) are laid out beside it and marked up from
// interiors.json, which owlbear/maps/interiors.py writes:
//   rooms    hidden curves on the DRAWING layer, so the room tracking sees them (areas.js);
//            the town map gets one too, covering all of it (the smallest area wins, so it only
//            counts for a token that isn't in anything smaller)
//   walls    Smoke & Spectre vision lines, doors and windows (POINTER layer), and one closed
//            line round the town map's edge, so nothing walks off it
//   portals  the "Portals" extension: town spot <-> building entry, stairs <-> stairs
// Everything it makes is attached to its map image (so it moves with it) and tagged with
// INTERIOR_KEY, so a re-run deletes it all and starts over.
//
// Coordinates in interiors.json are pixels of that map's image, origin top-left.
// check_interiors.mjs tests the pure parts offline.
//
// interiors.json names the adventure's places, and at ~95 KB it is far too big for the bridge's
// broadcasts (bus.js MAX_BYTES), so it only comes straight from the panel on this PC
// (GET /api/map/interiors). That is why background.js offers 🏘 and 🧭 only on the copy the panel
// serves ("DND NPC (this PC)"); this file itself is published to Pages with the rest (menu.html
// imports gather.js, which imports this) but never fetches anything there.
import OBR, { buildCurve, buildShape } from "./obr-sdk.js?v=23059e2";
import { directBase } from "./bus.js?v=23059e2";
import { INTERIOR_KEY, PLACE_KEY } from "./keys.js?v=23059e2";

const GAP_FLOORS = 2, GAP_ROWS = 3, GAP_TOWN = 6, GAP_COLUMNS = 6; // in squares
// Owlbear rate-limits requests ("RateLimitHit: Too many requests" with 20-item batches, live
// 2026-10-07): fewer, bigger calls, a pause between them, and a wait-and-retry when it says so.
const BATCH = 80; // items per addItems call
const PAUSE_MS = 400;
const RETRIES = 6;
const SMOKE = "com.battle-system.smoke";
const PORTAL_KEY = "de.resident-uhlig.portals/destination-id";
const ROOM_COLOR = "#d9a441";
const PORTAL_COLOR = "#9b6bff";
const WALL_NAMES = { wall: "Vision Line (Line)", door: "Vision Line (Door)", window: "Vision Line (Window)" };
// All of it stays hidden and locked even when the DM shows, hides or unlocks the map image.
const KEEP_OWN = ["VISIBLE", "LOCKED"];

const pt = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);

// "Stonehill Inn - Ground floor.png" and "stonehill inn – ground floor" are the same map.
export function normName(s) {
  return String(s || "").trim().replace(/\.(png|jpe?g|webp|gif|avif)$/i, "")
    .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

// The maps to lay out: every map in the file but the DM's own copies.
export function listed(json) {
  return (json.maps || []).filter((m) => !/\(DM\)/i.test(m.name));
}

// A pixel of an image -> the scene, through the image's own transform.
export function toScene(image, p, sceneDpi) {
  p = pt(p);
  const k = sceneDpi / image.grid.dpi;
  const off = image.grid.offset || { x: 0, y: 0 };
  const dx = (p.x - off.x) * k * (image.scale?.x ?? 1);
  const dy = (p.y - off.y) * k * (image.scale?.y ?? 1);
  const a = ((image.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return { x: image.position.x + dx * cos - dy * sin, y: image.position.y + dx * sin + dy * cos };
}

// A pixel of a map in interiors.json -> the scene, through its image: an image uploaded at
// another size than the file says is scaled to match (plan() lays it out that way too).
export function mapToScene(map, image, sceneDpi) {
  const ratio = map?.width && image.image?.width ? image.image.width / map.width : 1;
  return (p) => toScene(image, { x: pt(p).x * ratio, y: pt(p).y * ratio }, sceneDpi);
}

// Where an image covers the scene: {min, max}.
export function bounds(image, sceneDpi) {
  const w = image.image.width, h = image.image.height;
  const c = [[0, 0], [w, 0], [w, h], [0, h]].map((p) => toScene(image, p, sceneDpi));
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}

// Top-left corner on the scene of every map: one row per building (its floors left to
// right), rows downward, a new column when one would get taller than the town map.
// Only the file decides it (not which maps are uploaded yet), so a re-run gives the same.
export function layout(maps, pps, town, dpi) {
  const cells = (px) => Math.ceil(px / pps - 1e-9);
  const rows = [];
  for (const m of maps) {
    const key = m.building || m.name;
    let row = rows.find((r) => r.key === key);
    if (!row) rows.push((row = { key, maps: [] }));
    row.maps.push(m);
  }
  const top = Math.round(town.min.y / dpi), bottom = town.max.y / dpi;
  let x = Math.ceil(town.max.x / dpi - 1e-9) + GAP_TOWN, y = top, colWidth = 0;
  const at = {};
  for (const row of rows) {
    const h = Math.max(...row.maps.map((m) => cells(m.height)));
    const w = row.maps.reduce((s, m) => s + cells(m.width), 0) + GAP_FLOORS * (row.maps.length - 1);
    if (y > top && y + h > bottom) {
      x += colWidth + GAP_COLUMNS;
      y = top;
      colWidth = 0;
    }
    let fx = x;
    for (const m of row.maps) {
      at[m.name] = { x: fx * dpi, y: y * dpi };
      fx += cells(m.width) + GAP_FLOORS;
    }
    y += h + GAP_ROWS;
    colWidth = Math.max(colWidth, w);
  }
  return at;
}

// Map name -> its image in the scene (by the image's name, or failing that its label).
export function matchImages(maps, images, skipId) {
  const byName = new Map();
  for (const i of images) {
    if (i.id === skipId) continue;
    for (const n of [i.name, i.text?.plainText]) {
      const k = normName(n);
      if (k && !byName.has(k)) byName.set(k, i);
    }
  }
  const found = new Map();
  for (const m of maps) {
    const i = byName.get(normName(m.name));
    if (i) found.set(m.name, i);
  }
  return found;
}

function curve(id, pts, rest) {
  // Position = the first point, the points relative to it, no rotation.
  const first = pts[0];
  return {
    type: "CURVE", id, position: first, rotation: 0, scale: { x: 1, y: 1 },
    points: pts.map((p) => ({ x: p.x - first.x, y: p.y - first.y })),
    visible: false, locked: true, ...rest,
  };
}

function roomItem(id, room, pts, map, image, sceneDpi, rest = {}) {
  return curve(id, pts, {
    name: room.name,
    layer: "DRAWING",
    attachedTo: image.id,
    metadata: { [INTERIOR_KEY]: { map: map.name, kind: "room" }, ...(map.place ? { [PLACE_KEY]: map.place } : {}) },
    style: { fillColor: ROOM_COLOR, fillOpacity: 0, strokeColor: ROOM_COLOR, strokeOpacity: 1,
             strokeWidth: Math.max(2, sceneDpi / 50), strokeDash: [], tension: 0, closed: true },
    ...rest,
  });
}

function wallItem(id, kind, pts, map, image) {
  // Built like Smoke & Spectre's own lines (from its v5.0.4 bundle). Smoke makes them with
  // position {0,0} + absolute points in one code path, position + rotation in another:
  // position = first point with relative points needs checking live.
  return curve(id, pts, {
    name: WALL_NAMES[kind],
    layer: "POINTER",
    attachedTo: image.id,
    metadata: {
      [`${SMOKE}/isVisionLine`]: true, [`${SMOKE}/blocking`]: true, [`${SMOKE}/doubleSided`]: true,
      ...(kind === "door" ? { [`${SMOKE}/isDoor`]: true } : {}),
      ...(kind === "window" ? { [`${SMOKE}/isWindow`]: true } : {}),
      [INTERIOR_KEY]: { map: map.name, kind },
    },
    style: { fillColor: "#000000", fillOpacity: 0, strokeColor: "#000000", strokeOpacity: 1,
             strokeWidth: 4, strokeDash: [], tension: 0, closed: false },
  });
}

function circle(id, centre, diameter, attachedTo, mapName, to) {
  // A portal end: PROP layer, so it's never taken for a room.
  return {
    type: "SHAPE", shapeType: "CIRCLE", id, name: `Portal → ${to}`, layer: "PROP",
    position: centre, rotation: 0, scale: { x: 1, y: 1 }, width: diameter, height: diameter,
    visible: false, locked: true, attachedTo,
    metadata: { [INTERIOR_KEY]: { map: mapName, kind: "portal" } },
    style: { fillColor: PORTAL_COLOR, fillOpacity: 0.15, strokeColor: PORTAL_COLOR, strokeOpacity: 1,
             strokeWidth: 3, strokeDash: [] },
  };
}

function link(a, b) {
  // Two-way: each end is an origin whose destination is the other end.
  a.metadata[PORTAL_KEY] = b.id;
  b.metadata[PORTAL_KEY] = a.id;
  return [a, b];
}

// Everything the action does, worked out without touching Owlbear: the image moves
// (updates) and the items to add, in groups that must go in the same addItems call
// (the two ends of a portal: Portals strips an origin whose destination isn't there).
export function plan(json, town, images, sceneDpi, newId) {
  const pps = json.px_per_square;
  const maps = listed(json);
  const found = matchImages(maps, images, town.id);
  const at = layout(maps, pps, bounds(town, sceneDpi), sceneDpi);
  const placed = new Map();
  const updates = [];
  for (const m of maps) {
    const img = found.get(m.name);
    if (!img) continue;
    // An image uploaded at another size than the file says still gets 1 square = pps file px.
    const ratio = m.width ? img.image.width / m.width : 1;
    const grid = { ...img.grid, dpi: pps * ratio, offset: { x: 0, y: 0 } };
    updates.push({ id: img.id, position: at[m.name], dpi: grid.dpi });
    const image = { ...img, position: at[m.name], rotation: 0, scale: { x: 1, y: 1 }, grid };
    placed.set(m.name, { map: m, image, here: mapToScene(m, image, sceneDpi) });
  }
  const counts = { maps: placed.size, town: 0, townWall: 0, rooms: 0, walls: 0, doors: 0, windows: 0, portals: 0 };
  const groups = [], notes = [];
  // The town map is an area too: one room over the whole image. Not clickable (disableHit), so
  // a right-click on the town still finds the map image under it.
  const townName = json.town?.name || town.name;
  if (town.image?.width && town.image?.height) {
    const w = town.image.width, h = town.image.height;
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map((c) => toScene(town, c, sceneDpi));
    groups.push([roomItem(newId(), { name: townName }, corners, { name: townName, place: json.town?.place }, town,
      sceneDpi, { disableHit: true })]);
    counts.town = 1;
    // ...and a wall all the way round its edge: an open line back to its first corner (closed
    // the way Smoke draws a line, rather than with style.closed).
    groups.push([wallItem(newId(), "wall", [...corners, corners[0]], { name: townName }, town)]);
    counts.townWall = 1;
  }
  for (const { map, image, here } of placed.values()) {
    for (const room of map.rooms || []) {
      if ((room.points || []).length < 3) continue;
      groups.push([roomItem(newId(), room, room.points.map(here), map, image, sceneDpi)]);
      counts.rooms++;
    }
    for (const [kind, lines, n] of [["wall", map.walls, "walls"], ["door", map.doors, "doors"], ["window", map.windows, "windows"]]) {
      for (const line of lines || []) {
        if (line.length < 2) continue;
        groups.push([wallItem(newId(), kind, line.map(here), map, image)]);
        counts[n]++;
      }
    }
  }
  // Town spot <-> the building's entry.
  const townRatio = json.town?.width ? town.image.width / json.town.width : 1;
  const townPx = (sceneDpi / town.grid.dpi) * Math.abs(town.scale?.x ?? 1);
  for (const { map, image, here } of placed.values()) {
    if (!map.entry) continue;
    const spot = json.town?.spots?.[map.building];
    if (!spot) {
      notes.push(`no town spot for ${map.building}`);
      continue;
    }
    const centre = toScene(town, { x: spot.x * townRatio, y: spot.y * townRatio }, sceneDpi);
    groups.push(link(
      circle(newId(), centre, 2 * spot.r * townRatio * townPx, town.id, townName, map.name),
      circle(newId(), here(map.entry), sceneDpi, image.id, map.name, townName),
    ));
    counts.portals++;
  }
  // Stairs: each link is listed on both floors, so each pair is made once.
  const seen = new Set();
  for (const { map, image, here } of placed.values()) {
    for (const l of map.links || []) {
      const other = placed.get(l.to);
      if (!other) continue;
      const key = [`${map.name}@${l.at}`, `${l.to}@${l.to_at}`].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(link(
        circle(newId(), here(l.at), sceneDpi, image.id, map.name, l.to),
        circle(newId(), other.here(l.to_at), sceneDpi, other.image.id, l.to, map.name),
      ));
      counts.portals++;
    }
  }
  const missing = maps.filter((m) => !found.has(m.name)).map((m) => m.name);
  return { updates, groups, counts, missing, notes };
}

// Groups packed into addItems calls of at most n items, a group never split.
export function batches(groups, n) {
  const out = [];
  let cur = [];
  for (const g of groups) {
    if (cur.length && cur.length + g.length > n) {
      out.push(cur);
      cur = [];
    }
    cur.push(...g);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function summaryText({ counts: c, missing, notes }) {
  const town = c.town ? `the town area${c.townWall ? " and its wall" : ""} + ` : c.townWall ? "the town wall + " : "";
  let s = `🏘 ${c.maps} maps laid out, ${town}${c.rooms} rooms, ${c.walls} walls, ${c.doors} doors`
    + `${c.windows ? `, ${c.windows} windows` : ""}, ${c.portals} portals`;
  if (missing.length) s += `. Not in the scene yet: ${missing.join(", ")}`;
  if (notes.length) s += `. Also: ${notes.join("; ")}`;
  return s;
}

function toItem(p) {
  const b = p.type === "CURVE"
    ? buildCurve().points(p.points)
    : buildShape().shapeType(p.shapeType).width(p.width).height(p.height);
  return b.id(p.id).name(p.name).layer(p.layer).position(p.position).rotation(p.rotation)
    .style(p.style).attachedTo(p.attachedTo).visible(p.visible).locked(p.locked)
    .disableHit(!!p.disableHit).disableAttachmentBehavior(KEEP_OWN).metadata(p.metadata).build();
}

// Owlbear's errors arrive as {error: Error-like}, whose fields JSON.stringify doesn't show.
export function describe(e) {
  const inner = e?.error ?? e;
  if (inner && typeof inner === "object") {
    const own = Object.getOwnPropertyNames(inner);
    const msg = inner.message || inner.name;
    return msg ? `${inner.name && inner.name !== msg ? inner.name + ": " : ""}${msg}`
      : JSON.stringify(inner, own.length ? own : undefined);
  }
  return String(inner);
}

// interiors.json from the panel on this PC, or null (no panel reachable from this copy, or no
// file yet: owlbear/maps/interiors.py makes it).
export async function loadInteriors() {
  const base = directBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/api/map/interiors`, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Details for the panel's window (the agent's console, or tools/owlbear_only.py's), when this
// copy can reach the panel; the browser console otherwise. Never throws.
export async function panelLog(body) {
  const base = directBase();
  if (!base) {
    console.warn("dnd-npc", body);
    return false;
  }
  try {
    const r = await fetch(`${base}/api/map/log`, { method: "POST", headers: { "Content-Type": "application/json" },
                                                   body: JSON.stringify(body) });
    return r.ok;
  } catch {
    console.warn("dnd-npc", body);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const why = describe(e);
      if (/RateLimit|Too many requests/i.test(why) && attempt < RETRIES) {
        await sleep(1000 * 2 ** attempt);   // 1, 2, 4, 8, 16, 32 s
        continue;
      }
      throw new Error(`${name}: ${why}`);
    }
  }
}

// "🏘 Check portals": what the Portals extension will see, printed in the PC's window.
export async function checkPortals(townId) {
  const sceneDpi = await OBR.scene.grid.getDpi();
  const all = await OBR.scene.items.getItems();
  const byId = new Map(all.map((i) => [i.id, i]));
  const town = byId.get(townId);
  const r = (v) => Math.round(v);
  const lines = [];
  if (town?.image) {
    const b = bounds(town, sceneDpi);
    lines.push(`town "${town.name}": pos ${r(town.position.x)},${r(town.position.y)} image ${town.image.width}x${town.image.height}`
      + ` dpi ${town.grid.dpi} offset ${r(town.grid.offset.x)},${r(town.grid.offset.y)} scale ${town.scale.x} rot ${town.rotation}`
      + ` -> scene box ${JSON.stringify(b)} (scene dpi ${sceneDpi})`);
  }
  const portals = all.filter((i) => i.metadata?.[INTERIOR_KEY]?.kind === "portal");
  const linked = all.filter((i) => i.metadata?.[PORTAL_KEY] !== undefined);
  lines.push(`${portals.length} portal circles of ours, ${linked.length} items with a Portals destination`);
  for (const p of portals) {
    const dest = p.metadata?.[PORTAL_KEY];
    const parent = byId.get(p.attachedTo);
    lines.push(`  ${p.name} | on "${parent?.name ?? "?"}" | ${p.layer} ${p.type}/${p.shapeType} at ${r(p.position.x)},${r(p.position.y)}`
      + ` d=${r(p.width * p.scale.x)} visible=${p.visible} | dest ${dest ? (byId.has(dest) ? "ok" : "MISSING " + dest) : "NONE"}`);
  }
  const tokens = all.filter((i) => i.layer === "CHARACTER").slice(0, 12)
    .map((t) => `${t.text?.plainText || t.name} @ ${r(t.position.x)},${r(t.position.y)}`);
  lines.push(`tokens: ${tokens.join("; ")}`);
  const logged = await panelLog({ what: "portals", error: "check", stack: lines.join("\n"), detail: "" });
  OBR.notification.show(`🏘 ${portals.length} portal circles, ${linked.length} linked — details in the `
    + `${logged ? "panel's window" : "browser console"}`, "INFO");
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : `dnd-npc-interior-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function setUpInteriors(townId) {
  const json = await loadInteriors();
  if (!json) {
    OBR.notification.show(directBase() ? "🏘 No interiors.json on the panel yet (owlbear/maps/interiors.py makes it)"
      : "🏘 Can't reach the DND panel from here: use the “DND NPC (this PC)” copy's menu on the Dell", "ERROR");
    return;
  }
  const [town] = await OBR.scene.items.getItems([townId]);
  if (!town?.image) return;
  if (listed(json).some((m) => normName(m.name) === normName(town.name))) {
    OBR.notification.show("🏘 That's a building map. Run this on the town map.", "WARNING");
    return;
  }
  OBR.notification.show("🏘 Setting up interiors… (about half a minute)", "INFO");
  const sceneDpi = await OBR.scene.grid.getDpi();
  const images = await OBR.scene.items.getItems((i) => i.layer === "MAP" && i.type === "IMAGE");
  const p = plan(json, town, images, sceneDpi, newId);
  const old = await OBR.scene.items.getItems((i) => i.metadata?.[INTERIOR_KEY]);
  if (old.length) await step("removing the old marks", () => OBR.scene.items.deleteItems(old.map((i) => i.id)));
  // Every map goes (back) to its spot: one the DM has moved by hand since is moved back too.
  const to = new Map(p.updates.map((u) => [u.id, u]));
  if (to.size) {
    await step(`moving ${to.size} maps`, () => OBR.scene.items.updateItems([...to.keys()], (items) => {
      for (const i of items) {
        const u = to.get(i.id);
        i.position = u.position;
        i.rotation = 0;
        i.scale = { x: 1, y: 1 };
        i.grid.dpi = u.dpi;
        i.grid.offset = { x: 0, y: 0 };
      }
    }));
  }
  for (const batch of batches(p.groups, BATCH)) {
    const maps = [...new Set(batch.map((x) => x.metadata?.[INTERIOR_KEY]?.map))];
    const what = maps.length > 3 ? `${maps.slice(0, 3).join(", ")} and ${maps.length - 3} more` : maps.join(", ");
    const items = await step(`building the marks for ${what}`, async () => batch.map(toItem));
    await step(`adding the marks for ${what}`, () => OBR.scene.items.addItems(items));
    await sleep(PAUSE_MS);
  }
  OBR.notification.show(summaryText(p), p.missing.length || p.notes.length ? "WARNING" : "SUCCESS");
}
