// "🧭 Bring PCs here" (GM only): the player characters' tokens move to a building map, the
// town map, a room drawing or next to a token, each on its own square, packed around one spot.
// The menu (menu.html, kind=bring) offers "All PCs" and each PC on their own.
//
// Where they go:
//   a building map in interiors.json  its entry (ground floors), else its first stairs, else its middle
//   any other map image (the town)    the middle of the image
//   a room drawing                    its middle, or a point inside it when that's outside (an L)
//   a token                           the squares around it (not its own)
// Squares are kept off portal circles (the Portals extension would teleport a token dropped
// there) and off furniture (interiors.json's props that block, on the maps in the scene).
//
// Also "👥 Place townsfolk" (GM only, on the town map): each NPC listed in interiors.json's
// town.townsfolk goes to its own square in its room, next to its piece of furniture.
// check_interiors.mjs tests the pure parts offline.
import OBR, { MathM } from "./obr-sdk.js?v=843a06c";
import { contains, isRoom, outline } from "./areas.js?v=843a06c";
import { ask, directBase } from "./bus.js?v=843a06c";
import { bounds, listed, loadInteriors, mapToScene, matchImages, normName, toScene } from "./interiors.js?v=843a06c";
import { BUBBLES_NAME_KEY, INTERIOR_KEY, WHO_KEY } from "./keys.js?v=843a06c";

const RADIUS = 12; // squares around the spot that are tried

const firstWord = (s) => String(s || "").trim().split(/\s+/)[0].replace(/[^\p{L}\p{N}'-]/gu, "").toLowerCase();

// The name a token shows: Stat Bubbles' name tag, then Owlbear's label, then the item's name.
export function tokenLabel(i) {
  return String(i.metadata?.[BUBBLES_NAME_KEY] || "").trim() || String(i.text?.plainText || "").trim() || i.name || "";
}

// The PC a token is, or null: "This is…" (pc:<name>) first, else its label's first word against
// the party ("Ana Ring" is Ana). A token marked as an NPC is never a PC.
export function pcName(i, party = []) {
  if (i.layer !== "CHARACTER") return null;
  const who = String(i.metadata?.[WHO_KEY] || "");
  if (who.startsWith("pc:")) return who.slice(3);
  if (who) return null;
  const w = firstWord(tokenLabel(i));
  return (w && party.find((n) => firstWord(n) === w)) || null;
}

// Every PC token that can be moved: only roots (an attached one follows its parent), by name.
export function findPcs(items, party = []) {
  return items
    .filter((i) => !i.attachedTo)
    .map((item) => ({ item, name: pcName(item, party) }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A token's centre and size on the scene (tokens are images; the offset is the anchor).
export function tokenBox(t, dpi) {
  if (!t.image || !t.grid?.dpi) return { x: t.position.x, y: t.position.y, size: dpi };
  const k = dpi / t.grid.dpi;
  const sx = Math.abs(t.scale?.x ?? 1), sy = Math.abs(t.scale?.y ?? 1);
  return {
    x: t.position.x + (t.image.width / 2 - (t.grid.offset?.x ?? t.image.width / 2)) * k * sx,
    y: t.position.y + (t.image.height / 2 - (t.grid.offset?.y ?? t.image.height / 2)) * k * sy,
    size: Math.min(t.image.width * sx, t.image.height * sy) * k,
  };
}

// The squares a token touches: a box holding the centre of every square that overlaps it (a
// token off the grid blocks the 2 or 4 squares it straddles; one on it, just its own).
function tokenArea(t, dpi) {
  const b = tokenBox(t, dpi);
  return areaAt(b, b.size, dpi);
}

// ...the same for a token of that size with its centre at c.
function areaAt(c, size, dpi) {
  const h = size / 2 + dpi / 2 - dpi / 100;
  return { min: { x: c.x - h, y: c.y - h }, max: { x: c.x + h, y: c.y + h } };
}

// Each portal circle's box on the scene, and the circle itself: a square is blocked when its
// centre is inside the box or on the circle's edge (a box corner, outside the circle, is free).
export function portalBoxes(items) {
  return items.filter((i) => i.metadata?.[INTERIOR_KEY]?.kind === "portal").map((i) => {
    const rx = ((i.width || 0) * Math.abs(i.scale?.x ?? 1)) / 2, ry = ((i.height || 0) * Math.abs(i.scale?.y ?? 1)) / 2;
    return { min: { x: i.position.x - rx, y: i.position.y - ry }, max: { x: i.position.x + rx, y: i.position.y + ry },
             circle: { x: i.position.x, y: i.position.y, r: Math.max(rx, ry) } };
  });
}

const inBox = (b, p) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;
const blocks = (b, p) => (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y)
  || (b.circle && Math.hypot(p.x - b.circle.x, p.y - b.circle.y) <= b.circle.r + 1e-6);
const centreOf = (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 });

// A box [x0, y0, x1, y1] in a map's pixels -> its box on the scene (`here`: mapToScene).
function sceneBox(box, here) {
  const c = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(here);
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}

// The furniture nobody can stand on, as scene boxes: every prop of interiors.json that blocks
// (not rugs, stairs, garden beds…), on each map whose image is in the scene. A square whose
// centre is inside one is avoided, like a token's.
export function propBoxes(json, items, sceneDpi) {
  if (!json) return [];
  const maps = listed(json);
  const images = items.filter((i) => i.layer === "MAP" && i.type === "IMAGE");
  const out = [];
  for (const [name, image] of matchImages(maps, images)) {
    const map = maps.find((m) => m.name === name);
    const here = mapToScene(map, image, sceneDpi);
    for (const pr of map.props || []) if (pr.blocks !== false && pr.box?.length === 4) out.push(sceneBox(pr.box, here));
  }
  return out;
}

// A drawing's box on the scene, from its outline (getItemBounds does this live).
export function drawingBox(item) {
  const m = MathM.fromItem(item);
  let pts = outline(item);
  if (!pts && item.type === "SHAPE") {
    const rx = item.width / 2, ry = item.height / 2;
    pts = [{ x: -rx, y: -ry }, { x: rx, y: -ry }, { x: rx, y: ry }, { x: -rx, y: ry }];
  }
  const sc = (pts || [{ x: 0, y: 0 }]).map((p) => MathM.decompose(MathM.multiply(m, MathM.fromPosition(p))).position);
  const xs = sc.map((p) => p.x), ys = sc.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}

// A point inside the room: the middle of its box if that's in it, else the inside point
// (on a half-square grid over the box) nearest the middle, else its first corner.
export function insidePoint(room, box, dpi) {
  const c = centreOf(box);
  if (contains(room, c)) return c;
  let best = null, bestD = Infinity;
  const step = dpi / 2;
  for (let y = box.min.y + step / 2; y < box.max.y; y += step) {
    for (let x = box.min.x + step / 2; x < box.max.x; x += step) {
      const d = (x - c.x) ** 2 + (y - c.y) ** 2;
      if (d < bestD && contains(room, { x, y })) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  if (best) return best;
  const first = outline(room)?.[0];
  return first ? MathM.decompose(MathM.multiply(MathM.fromItem(room), MathM.fromPosition(first))).position : c;
}

// Where "Bring PCs here" on this item sends them: {kind, name, point, allowed(p), avoid[]},
// or null for something it can't (a line, text, a prop). `box` is the item's scene bounds when known.
export function targetFor(json, target, sceneDpi, { box } = {}) {
  if (target.layer === "MAP" && target.type === "IMAGE") {
    const area = bounds(target, sceneDpi);
    const allowed = (p) => inBox(area, p);
    const names = [target.name, target.text?.plainText].map(normName).filter(Boolean);
    const map = listed(json || {}).find((m) => names.includes(normName(m.name)));
    if (map) {
      const px = map.entry || map.links?.[0]?.at;
      const ratio = map.width ? target.image.width / map.width : 1;
      const point = px ? toScene(target, { x: px[0] * ratio, y: px[1] * ratio }, sceneDpi) : centreOf(area);
      return { kind: "map", name: map.name, point, allowed, avoid: [] };
    }
    const town = json?.town?.name && names.includes(normName(json.town.name));
    return { kind: "map", name: town ? json.town.name : tokenLabel(target) || "the map", point: centreOf(box || area),
             allowed, avoid: [] };
  }
  if (isRoom(target)) {
    const b = box || drawingBox(target);
    return { kind: "room", name: target.name || "the room", point: insidePoint(target, b, sceneDpi),
             allowed: (p) => contains(target, p), avoid: [] };
  }
  if (target.layer === "CHARACTER") {
    const t = tokenBox(target, sceneDpi);
    return { kind: "token", name: tokenLabel(target) || "the token", point: { x: t.x, y: t.y }, allowed: () => true,
             avoid: [tokenArea(target, sceneDpi)] };
  }
  return null;
}

// The centre of the grid square a point is in (square grid from the scene's origin). Live, the
// spot is snapped by Owlbear instead (OBR.scene.grid.snapPosition), which knows the grid.
export function cellCentre(p, dpi) {
  return { x: Math.floor(p.x / dpi) * dpi + dpi / 2, y: Math.floor(p.y / dpi) * dpi + dpi / 2 };
}

const SMOKE = "com.battle-system.smoke";
const CLEAR = 0.45; // squares between a token's centre and any Smoke line (a token on a line gets stuck)

// Every Smoke & Spectre line that blocks right now, as scene segments [[a, b], ...]: walls and
// windows, and doors unless they're open. Ours and the DM's own alike.
export function wallSegments(items) {
  const out = [];
  for (const i of items) {
    const m = i.metadata || {};
    if (!m[`${SMOKE}/isVisionLine`] || m[`${SMOKE}/disabled`] || (m[`${SMOKE}/isDoor`] && m[`${SMOKE}/doorOpen`])) continue;
    if (i.type !== "CURVE" || !i.points?.length) continue;
    const mx = MathM.fromItem(i);
    const pts = i.points.map((p) => MathM.decompose(MathM.multiply(mx, MathM.fromPosition(p))).position);
    if (i.style?.closed && pts.length > 2) pts.push(pts[0]);
    for (let k = 1; k < pts.length; k++) out.push([pts[k - 1], pts[k]]);
  }
  return out;
}

function distToSegment(p, [a, b]) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function crosses(p, q, [a, b]) {
  const side = (u, v, w) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = side(a, b, p), d2 = side(a, b, q), d3 = side(p, q, a), d4 = side(p, q, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// n square centres around the spot, nearest first: never on a portal or an `avoid` box (the
// target token, other tokens), never within CLEAR of a Smoke line, and only squares reachable
// from the spot without crossing one (so nobody lands on the wrong side of a wall). Inside
// `allowed` (the room, the map) while there's room enough there, then wherever is nearest.
export function arrange(n, { point, anchor, dpi, allowed = () => true, avoid = [], walls = [], radius = RADIUS }) {
  anchor ||= cellCentre(point, dpi);
  const r = Math.max(radius, Math.ceil(Math.sqrt(n)) + 2);
  const reach = (r + 1) * dpi;
  const near = walls.filter(([a, b]) => Math.min(a.x, b.x) < anchor.x + reach && Math.max(a.x, b.x) > anchor.x - reach
    && Math.min(a.y, b.y) < anchor.y + reach && Math.max(a.y, b.y) > anchor.y - reach);
  const at = (i, j) => ({ x: anchor.x + i * dpi, y: anchor.y + j * dpi });
  // squares reachable from the spot without crossing a line
  const seen = new Set(["0,0"]), queue = [[0, 0]], reached = [];
  while (queue.length) {
    const [i, j] = queue.shift();
    reached.push([i, j]);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj, key = `${ni},${nj}`;
      if (Math.abs(ni) > r || Math.abs(nj) > r || seen.has(key)) continue;
      if (near.some((s) => crosses(at(i, j), at(ni, nj), s))) continue;
      seen.add(key);
      queue.push([ni, nj]);
    }
  }
  const pick = (cells) => {
    const inside = [], outside = [];
    for (const [i, j] of cells) {
      const c = at(i, j);
      if (avoid.some((b) => blocks(b, c))) continue;
      if (near.some((s) => distToSegment(c, s) < CLEAR * dpi)) continue;
      const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
      (allowed(c) ? inside : outside).push({ c, d, i, j });
    }
    const order = (a, b) => a.d - b.d || a.j - b.j || a.i - b.i;
    return [...inside.sort(order), ...outside.sort(order)];
  };
  let out = pick(reached);
  if (out.length < n) {   // a tiny walled-in spot: any clear square nearby rather than none
    const all = [];
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (!seen.has(`${i},${j}`)) all.push([i, j]);
    out = [...out, ...pick(all)];
  }
  return out.slice(0, n).map((s) => s.c);
}

// The whole move, without touching Owlbear: [{id, position}] for each chosen PC (all of them
// when `chosen` is null), plus the place's name. A PC that is the target stays put.
export function gather(json, target, items, party, sceneDpi, { chosen = null, box, anchor } = {}) {
  const t = targetFor(json, target, sceneDpi, { box });
  if (!t) return { error: "not a place PCs can be brought to" };
  let pcs = findPcs(items, party).filter((p) => p.item.id !== target.id);
  if (chosen) pcs = pcs.filter((p) => chosen.includes(p.item.id));
  if (!pcs.length) return { name: t.name, moves: [], pcs: [] };
  const moving = new Set(pcs.map((p) => p.item.id));
  const others = items.filter((i) => i.layer === "CHARACTER" && !i.attachedTo && !moving.has(i.id) && i.id !== target.id);
  const avoid = [...t.avoid, ...portalBoxes(items), ...others.map((i) => tokenArea(i, sceneDpi)),
                 ...propBoxes(json, items, sceneDpi)];
  const cells = arrange(pcs.length, { point: t.point, anchor, dpi: sceneDpi, allowed: t.allowed, avoid,
                                      walls: wallSegments(items) });
  const moves = pcs.map((p, k) => {
    // The token's centre goes on the square's centre (its position is wherever its anchor is).
    const b = tokenBox(p.item, sceneDpi);
    return { id: p.item.id, position: { x: cells[k].x + p.item.position.x - b.x, y: cells[k].y + p.item.position.y - b.y } };
  });
  return { name: t.name, kind: t.kind, point: t.point, moves, pcs: pcs.map((p) => p.name) };
}

// ---- 👥 Place townsfolk ----

// The token of each town.townsfolk entry: [{entry, item}] (item null when it isn't in the scene).
// A token's names (Stat Bubbles' name tag, Owlbear's label, the item's name; case, spacing and a
// file extension don't matter) the same as the entry's first, then the same first word; each
// token goes to one entry only. Only root tokens, and never one marked as a PC.
export function findTownsfolk(entries, items) {
  const tokens = items.filter((i) => i.layer === "CHARACTER" && !i.attachedTo
    && !String(i.metadata?.[WHO_KEY] || "").startsWith("pc:"));
  const names = new Map(tokens.map((i) => [i.id,
    [i.metadata?.[BUBBLES_NAME_KEY], i.text?.plainText, i.name].map(normName).filter(Boolean)]));
  const out = entries.map((entry) => ({ entry, item: null }));
  const used = new Set();
  const pass = (same) => {
    for (const o of out) {
      if (o.item) continue;
      const want = normName(o.entry.token);
      const t = want && tokens.find((i) => !used.has(i.id) && names.get(i.id).some((n) => same(n, want)));
      if (t) {
        o.item = t;
        used.add(t.id);
      }
    }
  };
  pass((n, want) => n === want);
  pass((n, want) => !!firstWord(n) && firstWord(n) === firstWord(want));
  return out;
}

// Where an entry's NPC goes on its map's image: the room (the map's room named "… · <room>"), as
// a drawing on the scene, and the spot: the middle of the first prop of kind `near` whose middle is
// in the room, else a point inside the room. Null when the map has no such room.
export function townsfolkSpot(map, image, entry, sceneDpi) {
  const want = `· ${String(entry.room || "").trim().toLowerCase()}`;
  const room = (map.rooms || []).find((r) => String(r.name || "").trim().toLowerCase().endsWith(want)
    && (r.points || []).length >= 3);
  if (!room) return null;
  const here = mapToScene(map, image, sceneDpi);
  const area = { type: "CURVE", layer: "DRAWING", name: room.name, position: { x: 0, y: 0 }, rotation: 0,
                 scale: { x: 1, y: 1 }, points: room.points.map(here) };
  const inside = (p) => contains(area, p);
  const prop = (map.props || []).filter((pr) => pr.kind === entry.near && pr.box?.length === 4)
    .map((pr) => centreOf(sceneBox(pr.box, here))).find(inside);
  return { room: room.name, area, inside, point: prop || insidePoint(area, drawingBox(area), sceneDpi) };
}

// The whole placing, without touching Owlbear: {moves: [{id, token, room, cell, position}],
// notFound: [token names], noMap: [map names], noRoom: ["map · room"]}. Each NPC gets one square
// in its room, reachable from its spot without crossing a Smoke line and clear of them, off
// portals, furniture, every other token and the squares given to the NPCs before it.
export function townsfolkPlan(json, items, sceneDpi) {
  const entries = json?.town?.townsfolk || [];
  const maps = listed(json || {});
  const images = items.filter((i) => i.layer === "MAP" && i.type === "IMAGE");
  const found = findTownsfolk(entries, items);
  const moving = new Set(found.filter((f) => f.item).map((f) => f.item.id));
  const others = items.filter((i) => i.layer === "CHARACTER" && !i.attachedTo && !moving.has(i.id));
  const fixed = [...portalBoxes(items), ...others.map((i) => tokenArea(i, sceneDpi)), ...propBoxes(json, items, sceneDpi)];
  const walls = wallSegments(items);
  const out = { moves: [], notFound: [], noMap: [], noRoom: [] };
  const given = [];
  for (const { entry, item } of found) {
    if (!item) {
      out.notFound.push(entry.token);
      continue;
    }
    const map = maps.find((m) => normName(m.name) === normName(entry.map));
    const image = map && matchImages([map], images).get(map.name);
    if (!image) {
      if (!out.noMap.includes(entry.map)) out.noMap.push(entry.map);
      continue;
    }
    const spot = townsfolkSpot(map, image, entry, sceneDpi);
    const [cell] = spot ? arrange(1, { point: spot.point, dpi: sceneDpi, allowed: spot.inside,
                                        avoid: [...fixed, ...given], walls }) : [];
    if (!cell) {
      out.noRoom.push(`${entry.map} · ${entry.room}`);
      continue;
    }
    // The token's centre goes on the square's centre (its position is wherever its anchor is).
    const b = tokenBox(item, sceneDpi);
    out.moves.push({ id: item.id, token: entry.token, room: spot.room, cell,
                     position: { x: cell.x + item.position.x - b.x, y: cell.y + item.position.y - b.y } });
    given.push(areaAt(cell, b.size, sceneDpi));
  }
  return out;
}

export function townsfolkText({ moves, notFound, noMap, noRoom }) {
  let s = `👥 ${moves.length} townsfolk placed`;
  if (notFound.length) s += `. Not in the scene: ${notFound.join(", ")}`;
  if (noMap.length) s += `. Map not laid out: ${noMap.join(", ")}`;
  if (noRoom.length) s += `. No room for: ${noRoom.join(", ")}`;
  return s;
}

// ---- live ----

// The party's names (only to match tokens by name: "This is…" (pc:<name>) works without them),
// from the panel: straight from it when this copy can, else through the bridge (bus.js ask()).
export async function partyNames() {
  try {
    const c = await ask(OBR, "/api/map/catalog");
    return Array.isArray(c?.party) ? c.party : [];
  } catch {
    return [];
  }
}

// From the menu: bring the chosen PC tokens (ids; null = all of them) to the target item.
export async function bringPcs(targetId, chosen, party) {
  const [target] = await OBR.scene.items.getItems([targetId]);
  if (!target) return;
  const sceneDpi = await OBR.scene.grid.getDpi();
  const items = await OBR.scene.items.getItems();
  const json = await loadInteriors();
  let box;
  try {
    box = await OBR.scene.items.getItemBounds([targetId]);
  } catch {
    box = undefined;
  }
  const t = targetFor(json, target, sceneDpi, { box });
  if (!t) {
    OBR.notification.show("🧭 PCs can be brought to a map, a room or a token", "WARNING");
    return;
  }
  let anchor;
  try {
    anchor = await OBR.scene.grid.snapPosition(t.point, 1, false, true);
  } catch {
    anchor = undefined;
  }
  const g = gather(json, target, items, party, sceneDpi, { chosen, box, anchor });
  if (!g.moves.length) {
    OBR.notification.show("🧭 No PC tokens found (mark one with 🗺 This is…, or name it after the PC)", "WARNING");
    return;
  }
  await moveTokens(new Map(g.moves.map((m) => [m.id, m.position])));
  OBR.notification.show(`🧭 ${g.moves.length} PC${g.moves.length === 1 ? "" : "s"} brought to ${g.name}`, "SUCCESS");
}

// Tokens (id -> position) moved in one updateItems call. Smoke & Spectre stops a token at the
// first wall it crosses, which would leave it stuck on another map. Like the Portals extension's
// teleport: hide what's attached to the tokens (that's how Smoke tracks them), move, then show it
// again in a separate step. Only the position changes: a hidden token stays hidden.
async function moveTokens(to) {
  const ids = [...to.keys()];
  const shown = (list) => list.filter((i) => i.visible).map((i) => i.id);
  const scene = shown(await OBR.scene.items.getItemAttachments(ids));
  const local = shown(await OBR.scene.local.getItemAttachments(ids));
  const setVisible = async (on) => {
    if (scene.length) await OBR.scene.items.updateItems(scene, (ds) => { for (const d of ds) d.visible = on; });
    if (local.length) await OBR.scene.local.updateItems(local, (ds) => { for (const d of ds) d.visible = on; });
  };
  await setVisible(false);
  try {
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const d of drafts) d.position = to.get(d.id);
    });
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await setVisible(true);
  }
}

// From the town map's menu: every NPC of town.townsfolk that's in the scene to its room.
export async function placeTownsfolk() {
  const json = await loadInteriors();
  if (!json) {
    OBR.notification.show(directBase() ? "👥 No interiors.json on the panel yet (owlbear/maps/interiors.py makes it)"
      : "👥 Can't reach the DND panel from here: use the “DND NPC (this PC)” copy's menu on the Dell", "ERROR");
    return;
  }
  if (!json.town?.townsfolk?.length) {
    OBR.notification.show("👥 No townsfolk listed in interiors.json", "WARNING");
    return;
  }
  const sceneDpi = await OBR.scene.grid.getDpi();
  const items = await OBR.scene.items.getItems();
  const r = townsfolkPlan(json, items, sceneDpi);
  if (r.moves.length) await moveTokens(new Map(r.moves.map((m) => [m.id, m.position])));
  OBR.notification.show(townsfolkText(r), r.notFound.length || r.noMap.length || r.noRoom.length ? "WARNING" : "SUCCESS");
}
